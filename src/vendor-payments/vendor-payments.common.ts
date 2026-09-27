import { BadRequestException, ForbiddenException, InternalServerErrorException, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';

/**
 * Shared bits for vendor payments (quotes, orders, Connect onboarding,
 * refunds, disputes, reconciliation). Money is integer centavos everywhere.
 */
export const MIGRATION = 'supabase/migrations/20261009000000_vendor_orders.sql';
export const COMMISSION_KEY = 'vendor_commission_pct';
export const UNDEFINED_TABLE = 'PGRST205';
export const UNDEFINED_COLUMN = '42703';
export const UNIQUE_VIOLATION = '23505';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired', 'withdrawn'] as const;
export const ORDER_STATUSES = ['pending_payment', 'paid', 'in_progress', 'fulfilled', 'cancelled', 'refunded', 'disputed'] as const;

export type Row = Record<string, unknown>;
export const s = (v: unknown) => (typeof v === 'string' ? v : '');
export const sn = (v: unknown) => (typeof v === 'string' ? v : null);
export const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** PostgREST errors → a 503 that names this stream's migration, anything else → 500. */
export function dbError(action: string, error: { code?: string; message: string }): Error {
  if (error.code === UNDEFINED_TABLE || error.code === UNDEFINED_COLUMN) {
    return new ServiceUnavailableException(`Vendor payment tables are missing or out of date. Apply ${MIGRATION}.`);
  }
  return new InternalServerErrorException(`${action}: ${error.message}`);
}

/** The Stripe client, or null when STRIPE_SECRET_KEY is unset. Callers 503 with the variable name. */
export function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key) : null;
}

export function requireStripe(stripe: Stripe | null): Stripe {
  if (!stripe) throw new ServiceUnavailableException('Vendor payments are not set up yet (STRIPE_SECRET_KEY).');
  return stripe;
}

export function requireDb(supabase: LazoSupabaseClient | null): SupabaseClient {
  if (!supabase) throw new ServiceUnavailableException('The database is not configured');
  return supabase as unknown as SupabaseClient;
}

export function appUrl(): string {
  return (process.env.APP_URL || (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',')[0]).trim().replace(/\/+$/, '');
}

/** Lazo's commission in basis points (services.vendor_commission_pct.price_centavos; 1000 = 10 %). */
export async function commissionBps(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.from('services').select('price_centavos, active').eq('key', COMMISSION_KEY).maybeSingle();
  if (error) throw dbError('Could not load the commission', error);
  if (!data) throw new ServiceUnavailableException(`The ${COMMISSION_KEY} service row is missing. Apply ${MIGRATION}.`);
  const row = data as Row;
  if (row.active === false) return 0;
  const bps = Number(row.price_centavos ?? 0);
  return Number.isFinite(bps) && bps >= 0 && bps <= 10_000 ? bps : 0;
}

export function feeFor(amountCentavos: number, bps: number): number {
  return Math.round((amountCentavos * bps) / 10_000);
}

/** The caller's vendor profile (id, status, Stripe fields). 403 when they have none. */
export async function vendorFor(db: SupabaseClient, ownerId: string): Promise<Row> {
  const { data, error } = await db
    .from('vendors')
    .select('id, status, business_name, email, stripe_account_id, stripe_onboarding_status, charges_enabled, payouts_enabled, stripe_synced_at')
    .eq('owner_id', ownerId)
    .maybeSingle();
  if (error) throw dbError('Could not load your vendor profile', error);
  if (!data) throw new ForbiddenException('Create your vendor profile first');
  return data as Row;
}

// ---------------------------------------------------------------- parsing

export function centavos(value: unknown, field: string, { required = false, min = 1 } = {}): number | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BadRequestException(`${field} is required`);
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > 100_000_000_00) {
    throw new BadRequestException(`${field} must be a whole number of centavos between ${min} and 10,000,000,000`);
  }
  return n;
}

export function text(value: unknown, max: number, field: string, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new BadRequestException(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new BadRequestException(`${field} must be text`);
  const out = value.trim();
  if (required && !out) throw new BadRequestException(`${field} is required`);
  if (out.length > max) throw new BadRequestException(`${field} must be at most ${max} characters`);
  return out;
}

export interface LineItem {
  description: string;
  quantity: number;
  unitCentavos: number;
}

/** [{ description, quantity, unitCentavos }] — at most 50 lines. */
export function lineItems(value: unknown): LineItem[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestException('lineItems must be a list');
  if (value.length > 50) throw new BadRequestException('A quote can have at most 50 lines');
  return value.map((raw, i) => {
    const r = (raw ?? {}) as Row;
    const quantity = Number(r.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) throw new BadRequestException(`Line ${i + 1}: quantity must be a whole number`);
    return {
      description: text(r.description, 300, `Line ${i + 1} description`, true),
      quantity,
      unitCentavos: centavos(r.unitCentavos, `Line ${i + 1} price`, { required: true, min: 0 }) as number,
    };
  });
}

// ---------------------------------------------------------------- mapping

export function toQuote(r: Row) {
  const items = Array.isArray(r.line_items) ? (r.line_items as Row[]) : [];
  const validUntil = sn(r.valid_until);
  const status = s(r.status);
  return {
    id: s(r.id),
    inquiryId: sn(r.inquiry_id),
    conversationId: sn(r.conversation_id),
    ownerId: s(r.owner_id),
    listingType: sn(r.listing_type),
    listingId: sn(r.listing_id),
    vendorId: s(r.vendor_id),
    eventId: s(r.event_id),
    title: s(r.title),
    lineItems: items.map((li) => ({ description: s(li.description), quantity: Number(li.quantity ?? 1), unitCentavos: Number(li.unit_centavos ?? li.unitCentavos ?? 0) })),
    amountCentavos: Number(r.amount_centavos ?? 0),
    depositCentavos: num(r.deposit_centavos),
    currency: s(r.currency) || 'MXN',
    validUntil,
    // A sent quote past its date reads as expired without a job to flip it.
    status: status === 'sent' && validUntil && Date.parse(validUntil) < Date.now() ? 'expired' : status,
    note: s(r.note),
    sentAt: sn(r.sent_at),
    acceptedAt: sn(r.accepted_at),
    declinedAt: sn(r.declined_at),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

export function toOrder(r: Row) {
  return {
    id: s(r.id),
    quoteId: s(r.quote_id),
    eventId: s(r.event_id),
    vendorId: s(r.vendor_id),
    amountCentavos: Number(r.amount_centavos ?? 0),
    quoteAmountCentavos: Number(r.quote_amount_centavos ?? 0),
    platformFeeCentavos: Number(r.platform_fee_centavos ?? 0),
    refundedCentavos: Number(r.refunded_centavos ?? 0),
    currency: s(r.currency) || 'MXN',
    status: s(r.status),
    paymentMethod: s(r.payment_method),
    receiptUrl: s(r.receipt_url),
    stripePaymentIntent: sn(r.stripe_payment_intent),
    stripeCharge: sn(r.stripe_charge),
    stripeTransfer: sn(r.stripe_transfer),
    paidAt: sn(r.paid_at),
    fulfilledAt: sn(r.fulfilled_at),
    cancelledAt: sn(r.cancelled_at),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
    refunds: Array.isArray(r.vendor_refunds) ? (r.vendor_refunds as Row[]).map(toRefund) : [],
    disputes: Array.isArray(r.vendor_disputes) ? (r.vendor_disputes as Row[]).map(toDispute) : [],
  };
}

export function toRefund(r: Row) {
  return {
    id: s(r.id),
    orderId: s(r.order_id),
    amountCentavos: Number(r.amount_centavos ?? 0),
    reason: s(r.reason),
    requestedBy: s(r.requested_by),
    stripeRefundId: sn(r.stripe_refund_id),
    status: s(r.status),
    createdAt: s(r.created_at),
  };
}

export function toDispute(r: Row) {
  return {
    id: s(r.id),
    orderId: s(r.order_id),
    stripeDisputeId: s(r.stripe_dispute_id),
    amountCentavos: Number(r.amount_centavos ?? 0),
    currency: s(r.currency) || 'MXN',
    reason: s(r.reason),
    status: s(r.status),
    evidenceDueBy: sn(r.evidence_due_by),
    outcome: s(r.outcome),
    createdAt: s(r.created_at),
  };
}

export type Quote = ReturnType<typeof toQuote>;
export type Order = ReturnType<typeof toOrder>;
