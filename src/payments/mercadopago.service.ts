import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.mercadopago.com';

/** A Checkout Pro payment as GET /v1/payments/:id returns it (the fields we read). */
export interface MpPayment {
  id: number;
  status: string;
  status_detail: string;
  external_reference: string | null;
  transaction_amount: number;
  currency_id: string;
  payment_type_id: string;
  payment_method_id: string;
  date_created: string;
  date_approved: string | null;
  transaction_details?: { total_paid_amount?: number; external_resource_url?: string };
  transaction_amount_refunded?: number;
  refunds?: { id: number; amount: number; status: string }[];
}

export interface MpPreferenceInput {
  attemptId: string;
  title: string;
  description: string;
  amountCentavos: number;
  currency: string;
  email: string | null;
  successUrl: string;
  failureUrl: string;
  pendingUrl: string;
  notificationUrl: string | null;
}

/** LAZO's status for an MP payment, and the method the payer used. */
export function mpOutcome(p: MpPayment): { status: 'succeeded' | 'pending' | 'failed' | 'expired'; method: 'card' | 'oxxo' | 'spei' | 'other' } {
  const status =
    p.status === 'approved'
      ? 'succeeded'
      : p.status === 'rejected'
        ? 'failed'
        : p.status === 'cancelled' || p.status === 'expired'
          ? 'expired'
          : 'pending';
  const method =
    p.payment_type_id === 'credit_card' || p.payment_type_id === 'debit_card' || p.payment_type_id === 'prepaid_card'
      ? 'card'
      : p.payment_method_id === 'oxxo' || p.payment_type_id === 'ticket'
        ? 'oxxo'
        : p.payment_type_id === 'bank_transfer' || p.payment_method_id === 'clabe'
          ? 'spei'
          : 'other';
  return { status, method };
}

/** MP amounts are decimal MXN; we store integer centavos (PAY-6). */
export const toCentavos = (amount: number | undefined | null) => Math.round(Number(amount ?? 0) * 100);

/**
 * Mercado Pago, the second event-fee gateway (PAY-4), through its REST API
 * directly — no SDK. Checkout Pro preferences, payment lookup, refunds,
 * search for reconciliation, and webhook signature verification.
 *
 * Needs MERCADOPAGO_ACCESS_TOKEN (Your integrations → credentials) and
 * MERCADOPAGO_WEBHOOK_SECRET (the "secret signature" shown when the webhook
 * URL is registered) for POST /api/webhooks/mercadopago.
 */
@Injectable()
export class MercadoPagoService {
  private readonly logger = new Logger(MercadoPagoService.name);
  private readonly token = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim() || null;

  get configured(): boolean {
    return Boolean(this.token);
  }

  get webhookConfigured(): boolean {
    return Boolean(process.env.MERCADOPAGO_WEBHOOK_SECRET);
  }

  /** Checkout Pro: one preference per attempt, priced in MXN. Returns the redirect URL. */
  async createPreference(input: MpPreferenceInput): Promise<{ id: string; url: string }> {
    const body = {
      items: [
        {
          id: input.attemptId,
          title: input.title,
          description: input.description,
          quantity: 1,
          currency_id: input.currency.toUpperCase(),
          unit_price: input.amountCentavos / 100,
        },
      ],
      ...(input.email ? { payer: { email: input.email } } : {}),
      external_reference: input.attemptId,
      back_urls: { success: input.successUrl, failure: input.failureUrl, pending: input.pendingUrl },
      // MP only accepts auto_return with https back URLs; on http (local dev) the
      // payer clicks "Volver al sitio" instead, which reaches the same confirm path.
      ...(input.successUrl.startsWith('https://') ? { auto_return: 'approved' } : {}),
      ...(input.notificationUrl ? { notification_url: input.notificationUrl } : {}),
      statement_descriptor: 'LAZO',
      metadata: { attempt_id: input.attemptId },
      // OXXO vouchers: three days, like the Stripe path.
      expires: false,
      payment_methods: { installments: 1 },
      binary_mode: false,
    };
    const pref = await this.call<{ id: string; init_point: string; sandbox_init_point?: string }>('POST', '/checkout/preferences', body, input.attemptId);
    return { id: pref.id, url: pref.init_point };
  }

  async getPayment(id: string | number): Promise<MpPayment> {
    const clean = String(id).trim();
    if (!/^\d{1,20}$/.test(clean)) throw new BadRequestException('Unknown Mercado Pago payment');
    return this.call<MpPayment>('GET', `/v1/payments/${clean}`);
  }

  /** Full refund when amount is omitted. Idempotent on the key. */
  async refund(paymentId: string, amountCentavos: number | null, idempotencyKey: string): Promise<{ id: string; status: string }> {
    const body = amountCentavos === null ? {} : { amount: amountCentavos / 100 };
    const r = await this.call<{ id: number; status: string }>('POST', `/v1/payments/${paymentId}/refunds`, body, idempotencyKey);
    return { id: String(r.id), status: r.status };
  }

  /** Every payment created between two instants, for reconciliation. */
  async searchPayments(beginIso: string, endIso: string): Promise<MpPayment[]> {
    const out: MpPayment[] = [];
    const limit = 100;
    for (let offset = 0; offset < 5000; offset += limit) {
      const q = new URLSearchParams({
        range: 'date_created',
        begin_date: beginIso,
        end_date: endIso,
        sort: 'date_created',
        criteria: 'asc',
        limit: String(limit),
        offset: String(offset),
      });
      const page = await this.call<{ results: MpPayment[]; paging: { total: number } }>('GET', `/v1/payments/search?${q}`);
      out.push(...(page.results ?? []));
      if (out.length >= (page.paging?.total ?? 0) || (page.results ?? []).length < limit) break;
    }
    return out;
  }

  /**
   * x-signature: "ts=<unix>,v1=<hmac>". The signed manifest is
   * "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" (parts whose value is
   * missing are left out), HMAC-SHA256 hex with the webhook secret.
   */
  verifySignature(xSignature: string | undefined, xRequestId: string | undefined, dataId: string | undefined): boolean {
    const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
    if (!secret) throw new ServiceUnavailableException('MERCADOPAGO_WEBHOOK_SECRET is not set');
    if (!xSignature) return false;
    const parts = Object.fromEntries(
      xSignature.split(',').map((kv) => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
      }),
    );
    const ts = parts.ts;
    const v1 = parts.v1;
    if (!ts || !v1) return false;
    // Stale notifications (> 10 minutes) are refused; replay protection.
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 600) return false;
    let manifest = '';
    // MP lowercases an alphanumeric data.id; numeric payment ids are unchanged.
    if (dataId) manifest += `id:${/^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId};`;
    if (xRequestId) manifest += `request-id:${xRequestId};`;
    manifest += `ts:${ts};`;
    const expected = Buffer.from(createHmac('sha256', secret).update(manifest).digest('hex'));
    const actual = Buffer.from(v1);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    if (!this.token) throw new ServiceUnavailableException('Mercado Pago is not set up yet (MERCADOPAGO_ACCESS_TOKEN).');
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg = (data as { message?: string; error?: string } | null)?.message || (data as { error?: string } | null)?.error || text.slice(0, 200);
      this.logger.warn(`Mercado Pago ${method} ${path} → ${res.status}: ${msg}`);
      if (res.status === 401 || res.status === 403) throw new ServiceUnavailableException('Mercado Pago rejected the access token (MERCADOPAGO_ACCESS_TOKEN).');
      if (res.status === 404) throw new BadRequestException('Mercado Pago has no such payment');
      throw new BadRequestException(`Mercado Pago: ${msg}`);
    }
    return data as T;
  }
}
