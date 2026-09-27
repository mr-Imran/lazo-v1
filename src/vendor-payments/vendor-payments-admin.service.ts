import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { COMMISSION_KEY, dbError, ORDER_STATUSES, requireDb, requireStripe, s, sn, stripeClient, toOrder, UUID } from './vendor-payments.common.js';
import type { Order, Row } from './vendor-payments.common.js';

type AdminOrder = Order & { vendor: { name: string } };

interface Filters {
  status?: string;
  vendorId?: string;
  from?: string;
  to?: string;
}

/**
 * Admin reconciliation: every vendor order with money totals, each vendor's
 * settlement state, the commission, and a Stripe-vs-database comparison for
 * a date range.
 */
@Injectable()
export class VendorPaymentsAdminService {
  private readonly logger = new Logger(VendorPaymentsAdminService.name);
  private readonly stripe = stripeClient();

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  async list(filters: Filters) {
    let q = this.db
      .from('vendor_orders')
      .select('*, vendors(business_name, stripe_account_id, stripe_onboarding_status, charges_enabled, payouts_enabled), events(name), vendor_quotes(title), vendor_refunds(*), vendor_disputes(*)')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (filters.status) {
      if (!(ORDER_STATUSES as readonly string[]).includes(filters.status)) throw new BadRequestException('Unknown status');
      q = q.eq('status', filters.status);
    }
    if (filters.vendorId) {
      if (!UUID.test(filters.vendorId)) throw new BadRequestException('vendorId must be a UUID');
      q = q.eq('vendor_id', filters.vendorId);
    }
    const range = parseRange(filters.from, filters.to);
    if (range.from) q = q.gte('created_at', range.from.toISOString());
    if (range.to) q = q.lte('created_at', range.to.toISOString());
    const { data, error } = await q;
    if (error) throw dbError('Could not load vendor orders', error);

    const rows = data as Row[];
    const orders = rows.map((r) => ({
      ...toOrder(r),
      title: s((r.vendor_quotes as Row | null)?.title),
      eventName: s((r.events as Row | null)?.name),
      vendor: { name: s((r.vendors as Row | null)?.business_name) },
    }));

    // Totals only count money that moved: paid orders and what came back.
    const moved = orders.filter((o) => !['pending_payment', 'cancelled'].includes(o.status));
    const gross = sum(moved.map((o) => o.amountCentavos));
    const refunds = sum(moved.map((o) => o.refundedCentavos));
    const disputed = sum(orders.flatMap((o) => o.disputes.filter((d) => !['won'].includes(d.outcome)).map((d) => d.amountCentavos)));
    // Fees come back proportionally on refunds (refund_application_fee: true).
    const fees = sum(moved.map((o) => o.platformFeeCentavos - Math.round((o.platformFeeCentavos * o.refundedCentavos) / o.amountCentavos)));
    const totals = { gross, platformFees: fees, refunds, disputed, netToVendors: gross - refunds - fees, currency: 'MXN' };

    const [commission, vendors] = await Promise.all([this.commission(), this.vendorSettlement(orders)]);
    return { orders, totals, vendors, commission };
  }

  /** Every vendor that has orders or a Stripe account, with their state and money. */
  private async vendorSettlement(orders: AdminOrder[]) {
    const { data, error } = await this.db
      .from('vendors')
      .select('id, business_name, status, stripe_account_id, stripe_onboarding_status, charges_enabled, payouts_enabled, stripe_synced_at')
      .not('stripe_account_id', 'is', null)
      .order('business_name');
    if (error) throw dbError('Could not load vendors', error);
    const byVendor = new Map<string, { orders: number; paid: number; refunded: number; fees: number }>();
    for (const o of orders) {
      const v = byVendor.get(o.vendorId) ?? { orders: 0, paid: 0, refunded: 0, fees: 0 };
      v.orders += 1;
      if (!['pending_payment', 'cancelled'].includes(o.status)) {
        v.paid += o.amountCentavos;
        v.refunded += o.refundedCentavos;
        v.fees += o.platformFeeCentavos;
      }
      byVendor.set(o.vendorId, v);
    }
    const known = new Set((data as Row[]).map((r) => s(r.id)));
    const extra = orders.filter((o) => !known.has(o.vendorId)).map((o) => ({ id: o.vendorId, business_name: o.vendor.name }));
    const unique = new Map<string, Row>();
    for (const r of [...(data as Row[]), ...extra]) unique.set(s(r.id), r);
    return [...unique.values()].map((r) => ({
      id: s(r.id),
      name: s(r.business_name),
      status: s(r.status),
      stripeAccountId: sn(r.stripe_account_id),
      onboardingStatus: s(r.stripe_onboarding_status) || 'pending',
      chargesEnabled: r.charges_enabled === true,
      payoutsEnabled: r.payouts_enabled === true,
      syncedAt: sn(r.stripe_synced_at),
      ...(byVendor.get(s(r.id)) ?? { orders: 0, paid: 0, refunded: 0, fees: 0 }),
    }));
  }

  async commission() {
    const { data, error } = await this.db.from('services').select('price_centavos, active').eq('key', COMMISSION_KEY).maybeSingle();
    if (error) throw dbError('Could not load the commission', error);
    const row = data as Row | null;
    return { key: COMMISSION_KEY, present: Boolean(row), pct: row ? Number(row.price_centavos ?? 0) / 100 : null, active: row?.active !== false };
  }

  /** { pct } — 0–100, two decimals. Stored as price_centavos = pct × 100 on the services row. */
  async setCommission(input: Row) {
    const pct = Number(input.pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new BadRequestException('pct must be between 0 and 100');
    const { data, error } = await this.db
      .from('services')
      .update({ price_centavos: Math.round(pct * 100), updated_at: new Date().toISOString() })
      .eq('key', COMMISSION_KEY)
      .select('key');
    if (error) throw dbError('Could not save the commission', error);
    if (!data?.length) throw new BadRequestException(`The ${COMMISSION_KEY} service row is missing; apply the vendor_orders migration`);
    return this.commission();
  }

  /**
   * Pulls Stripe balance transactions (charges, refunds, disputes) for a
   * date range and compares them to vendor_orders. Lists what does not match.
   */
  async reconcile(filters: Filters) {
    const stripe = requireStripe(this.stripe);
    const range = parseRange(filters.from, filters.to);
    const to = range.to ?? new Date();
    const from = range.from ?? new Date(to.getTime() - 30 * 86_400_000);
    if (to.getTime() - from.getTime() > 92 * 86_400_000) throw new BadRequestException('Reconcile at most 92 days at a time');

    const txs: Stripe.BalanceTransaction[] = [];
    for await (const tx of stripe.balanceTransactions.list({
      created: { gte: Math.floor(from.getTime() / 1000), lte: Math.floor(to.getTime() / 1000) },
      limit: 100,
      expand: ['data.source'],
    })) {
      if (['charge', 'payment', 'refund', 'payment_refund', 'dispute', 'application_fee', 'transfer', 'payment_failure_refund'].includes(tx.type)) txs.push(tx);
      if (txs.length >= 5000) break;
    }

    const { data, error } = await this.db
      .from('vendor_orders')
      .select('*, vendors(business_name), vendor_refunds(*), vendor_disputes(*)')
      .gte('created_at', new Date(from.getTime() - 7 * 86_400_000).toISOString());
    if (error) throw dbError('Could not load vendor orders', error);
    const orders = (data as Row[]).map((r) => ({ ...toOrder(r), vendor: { name: s((r.vendors as Row | null)?.business_name) } }));
    const byCharge = new Map(orders.filter((o) => o.stripeCharge).map((o) => [o.stripeCharge as string, o]));
    const byIntent = new Map(orders.filter((o) => o.stripePaymentIntent).map((o) => [o.stripePaymentIntent as string, o]));
    const refundIds = new Map(orders.flatMap((o) => o.refunds.filter((r) => r.stripeRefundId).map((r) => [r.stripeRefundId as string, { order: o, refund: r }] as const)));
    const disputeIds = new Map(orders.flatMap((o) => o.disputes.map((d) => [d.stripeDisputeId, { order: o, dispute: d }] as const)));

    const mismatches: Array<{ kind: string; stripeId: string; orderId: string | null; detail: string; stripeCentavos: number | null; dbCentavos: number | null }> = [];
    const seenCharges = new Set<string>();
    let stripeGross = 0;
    let stripeRefunds = 0;
    let stripeFees = 0;

    for (const tx of txs) {
      const src = typeof tx.source === 'object' && tx.source ? (tx.source as unknown as Row) : null;
      const srcId = typeof tx.source === 'string' ? tx.source : s(src?.id);
      if (tx.type === 'charge' || tx.type === 'payment') {
        stripeGross += tx.amount;
        const intent = src ? (typeof src.payment_intent === 'string' ? src.payment_intent : s((src.payment_intent as Row | null)?.id)) : '';
        const order = byCharge.get(srcId) ?? (intent ? byIntent.get(intent) : undefined);
        // Plan purchases (payment_attempts) are the other charges on this account: skip anything not a vendor order.
        const meta = (src?.metadata ?? {}) as Row;
        if (!order) {
          if (s(meta.orderId)) mismatches.push({ kind: 'charge_missing_in_db', stripeId: srcId, orderId: s(meta.orderId), detail: 'Stripe charge for a vendor order that is not marked paid', stripeCentavos: tx.amount, dbCentavos: null });
          continue;
        }
        seenCharges.add(order.id);
        if (tx.amount !== order.amountCentavos) {
          mismatches.push({ kind: 'amount_differs', stripeId: srcId, orderId: order.id, detail: 'Charged amount differs from the order', stripeCentavos: tx.amount, dbCentavos: order.amountCentavos });
        }
        if (order.status === 'pending_payment' || order.status === 'cancelled') {
          mismatches.push({ kind: 'paid_but_not_in_db', stripeId: srcId, orderId: order.id, detail: `Stripe charged it but the order is ${order.status}`, stripeCentavos: tx.amount, dbCentavos: null });
        }
      } else if (tx.type === 'refund' || tx.type === 'payment_refund' || tx.type === 'payment_failure_refund') {
        stripeRefunds += -tx.amount;
        const meta = (src?.metadata ?? {}) as Row;
        const chargeId = src ? (typeof src.charge === 'string' ? src.charge : s((src.charge as Row | null)?.id)) : '';
        const known = refundIds.get(srcId);
        const order = known?.order ?? byCharge.get(chargeId);
        if (!order) {
          if (s(meta.orderId)) mismatches.push({ kind: 'refund_missing_in_db', stripeId: srcId, orderId: s(meta.orderId), detail: 'Stripe refund not recorded', stripeCentavos: -tx.amount, dbCentavos: null });
          continue;
        }
        if (!known) mismatches.push({ kind: 'refund_missing_in_db', stripeId: srcId, orderId: order.id, detail: 'Stripe refund not recorded on this order', stripeCentavos: -tx.amount, dbCentavos: order.refundedCentavos });
        else if (known.refund.amountCentavos !== -tx.amount) mismatches.push({ kind: 'refund_amount_differs', stripeId: srcId, orderId: order.id, detail: 'Refund amount differs', stripeCentavos: -tx.amount, dbCentavos: known.refund.amountCentavos });
      } else if (tx.type === 'dispute') {
        const known = disputeIds.get(srcId);
        if (!known) mismatches.push({ kind: 'dispute_missing_in_db', stripeId: srcId, orderId: null, detail: 'Stripe dispute not recorded', stripeCentavos: -tx.amount, dbCentavos: null });
      } else if (tx.type === 'application_fee') {
        stripeFees += tx.amount;
      }
    }

    // Orders we say are paid inside the window but Stripe shows no charge for.
    for (const o of orders) {
      const paidAt = o.paidAt ? Date.parse(o.paidAt) : NaN;
      if (!Number.isFinite(paidAt) || paidAt < from.getTime() || paidAt > to.getTime()) continue;
      if (!['pending_payment', 'cancelled'].includes(o.status) && !seenCharges.has(o.id)) {
        mismatches.push({ kind: 'charge_missing_in_stripe', stripeId: o.stripeCharge ?? o.stripePaymentIntent ?? '', orderId: o.id, detail: 'Order is paid in the database but no Stripe charge was found in this range', stripeCentavos: null, dbCentavos: o.amountCentavos });
      }
    }

    const inWindow = orders.filter((o) => o.paidAt && Date.parse(o.paidAt) >= from.getTime() && Date.parse(o.paidAt) <= to.getTime() && !['pending_payment', 'cancelled'].includes(o.status));
    this.logger.log(`Reconciled ${txs.length} Stripe transactions against ${inWindow.length} orders: ${mismatches.length} mismatches`);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      stripe: { transactions: txs.length, gross: stripeGross, refunds: stripeRefunds, applicationFees: stripeFees },
      db: { orders: inWindow.length, gross: sum(inWindow.map((o) => o.amountCentavos)), refunds: sum(inWindow.map((o) => o.refundedCentavos)), platformFees: sum(inWindow.map((o) => o.platformFeeCentavos)) },
      mismatches,
    };
  }

  private get db() {
    return requireDb(this.supabase);
  }
}

function sum(list: number[]): number {
  return list.reduce((a, b) => a + b, 0);
}

function parseRange(from?: string, to?: string): { from: Date | null; to: Date | null } {
  const parse = (v: string | undefined, end: boolean) => {
    if (!v) return null;
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${end ? '23:59:59.999' : '00:00:00'}` : v);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('from/to must be dates (YYYY-MM-DD)');
    return d;
  };
  const f = parse(from, false);
  const t = parse(to, true);
  if (f && t && f > t) throw new BadRequestException('from must be before to');
  return { from: f, to: t };
}
