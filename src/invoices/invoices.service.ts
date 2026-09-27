import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';

export const CORE_GAPS_MIGRATION = 'supabase/migrations/20261008000000_core_gaps.sql';
const UNDEFINED_COLUMN = '42703';
const UNDEFINED_TABLE = 'PGRST205';
const UNIQUE_VIOLATION = '23505';
const UUID = /^[0-9a-f-]{36}$/i;

/** IVA in Mexico. Plan prices are shown IVA-included, so the tax is carved out of the total. */
export const IVA_RATE = 0.16;

// SAT "uso de CFDI" codes a host is likely to pick. A PAC would validate the
// full catalogue; here it only keeps typos out of the field.
const CFDI_USOS = ['G01', 'G02', 'G03', 'I01', 'I04', 'I08', 'D01', 'D10', 'S01', 'CP01', 'CN01'];
const RFC = /^([A-ZÑ&]{3,4})\d{6}[A-Z0-9]{3}$/;

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitCentavos: number;
  totalCentavos: number;
}

export interface Invoice {
  id: string;
  number: string;
  status: string;
  eventId: string | null;
  eventName?: string;
  ownerId: string;
  paymentAttemptId: string | null;
  lineItems: InvoiceLine[];
  subtotalCentavos: number;
  taxCentavos: number;
  taxRate: number;
  totalCentavos: number;
  currency: string;
  gateway: string;
  gatewayReference: string;
  rfc: string;
  razonSocial: string;
  cfdiUso: string;
  uuidFiscal: string | null;
  issuedAt: string | null;
  createdAt: string;
}

/**
 * Lazo's own receipts for paid plans (one per succeeded event_fee payment).
 * Numbered LAZO-YYYY-000001 by a Postgres sequence (default on the column),
 * with IVA 16 % shown as included. The host can add RFC / razón social /
 * uso de CFDI for a factura, but NO CFDI is stamped here: a PAC integration
 * (Facturama, SW Sapien…) is not built. uuid_fiscal stays null until it is.
 */
@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  /**
   * Creates the invoice for a succeeded payment attempt, once. Called from
   * both the confirm and the webhook path; the unique index on
   * payment_attempt_id makes a race harmless. Never throws into the payment
   * flow: a missing migration is logged, the plan still gets applied.
   */
  async ensureForAttempt(attemptId: string): Promise<Invoice | null> {
    try {
      const existing = await this.db.from('invoices').select('*').eq('payment_attempt_id', attemptId).maybeSingle();
      if (existing.error) throw this.fail('Could not check the invoice', existing.error);
      if (existing.data) return toInvoice(existing.data as Row);

      const { data: attempt, error } = await this.db
        .from('payment_attempts')
        .select('*, events(name)')
        .eq('id', attemptId)
        .maybeSingle();
      if (error) throw this.fail('Could not load the payment', error);
      const a = attempt as Row | null;
      if (!a || a.status !== 'succeeded' || a.flow !== 'event_fee') return null;
      // No FK from product to services.key, so the plan's name is a second read.
      const plan = s(a.product) ? await this.db.from('services').select('name').eq('key', s(a.product)).maybeSingle() : null;

      // What Stripe actually charged, when recorded; else our price.
      const total = Number(a.stripe_amount_cents ?? a.amount_cents ?? 0);
      const currency = s(a.stripe_currency) || s(a.currency) || 'MXN';
      const planName = s((plan?.data as Row | null)?.name) || s(a.product).replace('tier_', '') || 'Plan';
      const eventName = s((a.events as Row | null)?.name);
      const tax = includedTax(total);
      const line: InvoiceLine = {
        description: `Lazo ${planName}${eventName ? ` — ${eventName}` : ''}`,
        quantity: 1,
        unitCentavos: total,
        totalCentavos: total,
      };

      const insert = await this.db
        .from('invoices')
        .insert({
          payment_attempt_id: attemptId,
          event_id: s(a.event_id) || null,
          owner_id: s(a.owner_id),
          status: 'issued',
          provider: 'lazo',
          line_items: [line],
          subtotal_centavos: total - tax,
          tax_centavos: tax,
          tax_rate: IVA_RATE,
          total_cents: total,
          currency,
          gateway: s(a.gateway) || 'stripe',
          gateway_reference: s(a.stripe_payment_intent) || s(a.provider_reference),
          issued_at: s(a.succeeded_at) || new Date().toISOString(),
        })
        .select('*')
        .single();

      if (insert.error?.code === UNIQUE_VIOLATION) {
        // The other path (webhook vs confirm) won the race; return its row.
        const again = await this.db.from('invoices').select('*').eq('payment_attempt_id', attemptId).maybeSingle();
        return again.data ? toInvoice(again.data as Row) : null;
      }
      if (insert.error) throw this.fail('Could not create the invoice', insert.error);
      this.logger.log(`Invoice ${s((insert.data as Row).number)} issued for attempt ${attemptId}`);
      return toInvoice(insert.data as Row);
    } catch (err) {
      this.logger.warn(`Invoice for attempt ${attemptId} not created: ${(err as Error).message}`);
      return null;
    }
  }

  async listForEvent(ownerId: string, eventId: string): Promise<{ invoices: Invoice[] }> {
    const { data, error } = await this.db
      .from('invoices')
      .select('*')
      .eq('owner_id', ownerId)
      .eq('event_id', eventId)
      .order('issued_at', { ascending: false });
    if (error) throw this.fail('Could not load invoices', error);
    return { invoices: (data as Row[]).map(toInvoice) };
  }

  async findOne(ownerId: string, id: string): Promise<Invoice> {
    if (!UUID.test(id)) throw new NotFoundException('No such invoice');
    const { data, error } = await this.db.from('invoices').select('*, events(name)').eq('id', id).eq('owner_id', ownerId).maybeSingle();
    if (error) throw this.fail('Could not load the invoice', error);
    if (!data) throw new NotFoundException('No such invoice');
    return toInvoice(data as Row);
  }

  /** { rfc?, razonSocial?, cfdiUso? } — the host's fiscal data for a factura. */
  async updateBilling(ownerId: string, id: string, input: Row): Promise<Invoice> {
    await this.findOne(ownerId, id);
    const patch: Row = { updated_at: new Date().toISOString() };
    if (input.rfc !== undefined) {
      const rfc = s(input.rfc).trim().toUpperCase();
      if (rfc && !RFC.test(rfc)) throw new BadRequestException('That RFC does not look right (12 or 13 characters, e.g. XAXX010101000)');
      patch.rfc = rfc;
    }
    if (input.razonSocial !== undefined) {
      const name = s(input.razonSocial).trim();
      if (name.length > 200) throw new BadRequestException('Razón social must be at most 200 characters');
      patch.razon_social = name;
    }
    if (input.cfdiUso !== undefined) {
      const uso = s(input.cfdiUso).trim().toUpperCase();
      if (uso && !CFDI_USOS.includes(uso)) throw new BadRequestException(`Uso de CFDI must be one of ${CFDI_USOS.join(', ')}`);
      patch.cfdi_uso = uso;
    }
    if (Object.keys(patch).length === 1) throw new BadRequestException('Send rfc, razonSocial and/or cfdiUso');
    const { error } = await this.db.from('invoices').update(patch).eq('id', id).eq('owner_id', ownerId);
    if (error) throw this.fail('Could not save billing details', error);
    return this.findOne(ownerId, id);
  }

  // ---------------------------------------------------------------- admin

  async adminList(): Promise<{ invoices: Invoice[]; totals: { currency: string; cents: number; tax: number }[] }> {
    const { data, error } = await this.db.from('invoices').select('*, events(name)').order('issued_at', { ascending: false }).limit(500);
    if (error) throw this.fail('Could not load invoices', error);
    const invoices = (data as Row[]).map(toInvoice);
    const byCurrency = new Map<string, { cents: number; tax: number }>();
    for (const inv of invoices) {
      if (inv.status !== 'issued') continue;
      const t = byCurrency.get(inv.currency) ?? { cents: 0, tax: 0 };
      t.cents += inv.totalCentavos;
      t.tax += inv.taxCentavos;
      byCurrency.set(inv.currency, t);
    }
    return { invoices, totals: [...byCurrency].map(([currency, t]) => ({ currency, ...t })) };
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_COLUMN || error.code === UNDEFINED_TABLE) {
      return new ServiceUnavailableException(`Invoices are not set up. Apply ${CORE_GAPS_MIGRATION}.`);
    }
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

/** The IVA share of an IVA-included amount: total − total / 1.16, rounded to the centavo. */
export function includedTax(totalCentavos: number): number {
  return Math.round(totalCentavos - totalCentavos / (1 + IVA_RATE));
}

function toInvoice(r: Row): Invoice {
  const lines = Array.isArray(r.line_items) ? (r.line_items as Row[]) : [];
  return {
    id: s(r.id),
    number: s(r.number),
    status: s(r.status),
    eventId: s(r.event_id) || null,
    eventName: s((r.events as Row | null)?.name) || undefined,
    ownerId: s(r.owner_id),
    paymentAttemptId: s(r.payment_attempt_id) || null,
    lineItems: lines.map((l) => ({
      description: s(l.description),
      quantity: Number(l.quantity ?? 1),
      unitCentavos: Number(l.unitCentavos ?? 0),
      totalCentavos: Number(l.totalCentavos ?? 0),
    })),
    subtotalCentavos: Number(r.subtotal_centavos ?? 0),
    taxCentavos: Number(r.tax_centavos ?? 0),
    taxRate: Number(r.tax_rate ?? IVA_RATE),
    totalCentavos: Number(r.total_cents ?? 0),
    currency: s(r.currency) || 'MXN',
    gateway: s(r.gateway),
    gatewayReference: s(r.gateway_reference),
    rfc: s(r.rfc),
    razonSocial: s(r.razon_social),
    cfdiUso: s(r.cfdi_uso),
    uuidFiscal: s(r.uuid_fiscal) || null,
    issuedAt: s(r.issued_at) || null,
    createdAt: s(r.created_at),
  };
}
