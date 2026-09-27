import { createHmac, timingSafeEqual } from 'node:crypto';
import { Resend } from 'resend';
import { assertPublicHost } from '../vendors/product-scraper.js';

/**
 * How Lazo tells a fulfilment partner about an order: an email (Resend, the
 * same provider as guest messaging) or a signed webhook POST. The result is
 * stored on the order so ops can see a notification that never arrived
 * (FUL-4: operations owns exceptions).
 */
export interface Partner {
  id: string;
  name: string;
  contactEmail: string;
  notifyVia: 'email' | 'webhook';
  webhookUrl: string;
  webhookSecret: string;
}

export interface NotificationResult {
  via: 'email' | 'webhook';
  ok: boolean;
  reference?: string;
  error?: string;
  at: string;
}

export interface OrderNotice {
  kind: 'order.created' | 'order.cancelled';
  orderId: string;
  eventName: string;
  category: string;
  productKey: string;
  productName: string;
  quantity: number;
  city: string;
  deliveryAddress: string;
  neededBy: string | null;
  notes: string;
  amountCentavos: number;
  currency: string;
  cancellationReason?: string;
  /** Where the partner posts status updates. */
  statusUrl: string;
}

const TIMEOUT_MS = 12_000;

export function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Constant-time check of an X-Lazo-Signature header against the raw body. */
export function verify(secret: string, body: string | Buffer, header: string | undefined): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(sign(secret, typeof body === 'string' ? body : body.toString('utf8')));
  const given = Buffer.from(header.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function notifyPartner(partner: Partner, notice: OrderNotice): Promise<NotificationResult> {
  const at = new Date().toISOString();
  try {
    if (partner.notifyVia === 'webhook') {
      if (!/^https:\/\//.test(partner.webhookUrl)) throw new Error('The partner has no https webhook URL');
      if (!partner.webhookSecret) throw new Error('The partner has no webhook secret');
      // The URL was checked when saved, but DNS can change: never POST to a private address.
      await assertPublicHost(new URL(partner.webhookUrl));
      const body = JSON.stringify({ ...notice, sentAt: at });
      const res = await fetch(partner.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lazo-signature': sign(partner.webhookSecret, body), 'x-lazo-event': notice.kind },
        body,
        // Do not follow redirects: a 302 to a private address would defeat the
        // assertPublicHost check above and reach internal/metadata endpoints.
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400) throw new Error('Webhook must not redirect');
      if (!res.ok) throw new Error(`Webhook answered HTTP ${res.status}`);
      return { via: 'webhook', ok: true, reference: `HTTP ${res.status}`, at };
    }

    const key = process.env.RESEND_API_KEY;
    const from = process.env.MESSAGE_FROM_EMAIL;
    if (!key || !from) throw new Error('Email is not set up (RESEND_API_KEY, MESSAGE_FROM_EMAIL)');
    if (!partner.contactEmail) throw new Error('The partner has no contact email');
    const { data, error } = await new Resend(key).emails.send({
      from,
      to: partner.contactEmail,
      subject: notice.kind === 'order.created' ? `Lazo order ${notice.orderId.slice(0, 8)}: ${notice.productName} × ${notice.quantity}` : `Lazo order ${notice.orderId.slice(0, 8)} cancelled`,
      text: emailText(partner, notice),
    });
    if (error) throw new Error(error.message);
    return { via: 'email', ok: true, reference: data?.id, at };
  } catch (err) {
    return { via: partner.notifyVia, ok: false, error: err instanceof Error ? err.message.slice(0, 300) : 'Failed', at };
  }
}

function emailText(partner: Partner, n: OrderNotice): string {
  const money = `$${(n.amountCentavos / 100).toLocaleString('es-MX')} ${n.currency}`;
  const lines: (string | null)[] =
    n.kind === 'order.cancelled'
      ? [`Hola ${partner.name},`, '', `El pedido ${n.orderId} fue cancelado por el anfitrión.`, n.cancellationReason ? `Motivo: ${n.cancellationReason}` : null, '']
      : [
          `Hola ${partner.name},`,
          '',
          `Nuevo pedido de Lazo (${n.orderId}) para el evento "${n.eventName}".`,
          '',
          `Producto: ${n.productName} (${n.productKey}) × ${n.quantity}`,
          `Ciudad: ${n.city}`,
          n.deliveryAddress ? `Entrega: ${n.deliveryAddress}` : null,
          n.neededBy ? `Se necesita para: ${n.neededBy}` : null,
          `Importe: ${money}`,
          n.notes ? `Notas: ${n.notes}` : null,
          '',
          'Para confirmar, rechazar o actualizar el estado, haz un POST firmado a:',
          n.statusUrl,
          'Cuerpo JSON: { "status": "confirmed" | "rejected" | "in_production" | "shipped" | "delivered", "reference": "...", "note": "..." }',
          'Cabecera X-Lazo-Signature: sha256=HMAC_SHA256(secreto compartido, cuerpo).',
          'O responde a este correo y el equipo de Lazo lo registra por ti.',
          '',
        ];
  return lines.filter((l) => l !== '').join('\n');
}
