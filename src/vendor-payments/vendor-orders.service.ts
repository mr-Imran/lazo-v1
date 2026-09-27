import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type Stripe from 'stripe';
import { ChatEventsService } from '../chat/chat.events.js';
import { conversationForQuote, postSystemLine } from '../chat/chat-system.js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { parseIdempotencyKey, reserveRefund, settleRefund } from '../payments/refund-guard.js';
import { VendorConnectService } from './vendor-connect.service.js';
import {
  appUrl,
  centavos,
  dbError,
  requireDb,
  requireStripe,
  s,
  sn,
  stripeClient,
  text,
  toOrder,
  UNIQUE_VIOLATION,
  UUID,
  vendorFor,
} from './vendor-payments.common.js';
import type { Row } from './vendor-payments.common.js';

interface EventCtx {
  id: string;
  ownerId: string;
}

const ORDER_SELECT = '*, vendor_refunds(*), vendor_disputes(*)';

/**
 * Orders: Checkout for an accepted quote (destination charge to the vendor's
 * Connect account, Lazo's commission as the application fee), confirmation
 * after the redirect, the vendor's fulfilment steps, refunds, and the Stripe
 * Connect webhook that keeps payment, refund and dispute state in sync.
 */
@Injectable()
export class VendorOrdersService {
  private readonly logger = new Logger(VendorOrdersService.name);
  private readonly stripe = stripeClient();

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
    private readonly connect: VendorConnectService,
    private readonly chatEvents: ChatEventsService,
  ) {}

  config() {
    return {
      configured: Boolean(this.stripe),
      webhook: Boolean(process.env.STRIPE_CONNECT_WEBHOOK_SECRET),
      methods: ['card', 'oxxo', 'spei'],
    };
  }

  // ================================================================ host

  /** Starts (or re-uses) a Checkout session for a pending order. Returns the URL. */
  async checkout(event: EventCtx, orderId: string, email: string | null) {
    const stripe = requireStripe(this.stripe);
    const order = await this.forHost(event, orderId);
    if (order.status !== 'pending_payment') throw new ConflictException(`This order is ${order.status.replace('_', ' ')}`);

    // Payments land in Lazo's own Stripe account (no per-vendor Connect account).
    // Lazo keeps the commission (order.platformFeeCentavos) and settles the rest
    // with the vendor separately; the vendor dashboard shows what they are owed.
    const { data: vendor, error: vErr } = await this.db
      .from('vendors')
      .select('business_name')
      .eq('id', order.vendorId)
      .maybeSingle();
    if (vErr) throw dbError('Could not load the vendor', vErr);
    const v = vendor as Row | null;

    // An open session from a previous click is still valid: send the host back to it.
    if (order.stripeCheckoutSession) {
      const existing = await stripe.checkout.sessions.retrieve(order.stripeCheckoutSession).catch(() => null);
      if (existing?.status === 'open' && existing.url) return { url: existing.url, orderId: order.id };
    }

    const { data: quote } = await this.db.from('vendor_quotes').select('title').eq('id', order.quoteId).maybeSingle();
    const title = s((quote as Row | null)?.title) || 'Vendor order';
    const isDeposit = order.amountCentavos < order.quoteAmountCentavos;
    const base = `${appUrl()}/dashboard/events/${event.id}/orders`;
    const currency = order.currency.toLowerCase();

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        currency,
        customer_email: email ?? undefined,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency,
              unit_amount: order.amountCentavos,
              product_data: {
                name: `${s(v?.business_name)} · ${title}`,
                description: isDeposit ? `Deposit (${money(order.quoteAmountCentavos)} total)` : undefined,
              },
            },
          },
        ],
        // The PaymentIntent lives on Lazo's account and the full amount stays
        // there; Lazo pays the vendor their net (amount − commission) out of band.
        payment_intent_data: {
          metadata: { orderId: order.id, eventId: event.id, vendorId: order.vendorId, ownerId: event.ownerId },
        },
        // OXXO vouchers settle later; the webhook's payment_intent.succeeded handles that.
        payment_method_options: { oxxo: { expires_after_days: 3 } },
        metadata: { orderId: order.id, eventId: event.id, ownerId: event.ownerId, flow: 'vendor_order' },
        success_url: `${base}?order_checkout={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}?cancelled=1`,
        locale: 'es',
      },
      // A retry after a network blip must not open two sessions for one order.
      { idempotencyKey: `vendor-order-${order.id}-${order.updatedAt}` },
    );

    const { error } = await this.db
      .from('vendor_orders')
      .update({
        stripe_checkout_session: session.id,
        stripe_payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', order.id);
    if (error) throw dbError('Could not record the checkout', error);
    return { url: session.url, orderId: order.id };
  }

  /** After the redirect back with ?order_checkout=cs_…: read the session and apply it. Idempotent with the webhook. */
  async confirm(ownerId: string, sessionId: unknown) {
    const stripe = requireStripe(this.stripe);
    const id = s(sessionId);
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) throw new BadRequestException('Unknown checkout session');
    const session = await stripe.checkout.sessions.retrieve(id, { expand: ['payment_intent.latest_charge'] });
    if (session.metadata?.ownerId !== ownerId || session.metadata?.flow !== 'vendor_order') throw new NotFoundException('Unknown checkout session');
    const orderId = s(session.metadata?.orderId);
    const intent = typeof session.payment_intent === 'object' ? session.payment_intent : null;
    if (session.payment_status === 'paid' && intent) await this.markPaid(orderId, intent);
    else if (session.status === 'expired') await this.clearSession(orderId, session.id);
    return { order: await this.one(orderId) };
  }

  /** Cancels an order the host has not paid yet. */
  async cancel(event: EventCtx, orderId: string) {
    const order = await this.forHost(event, orderId);
    if (order.status !== 'pending_payment') throw new ConflictException('Only an unpaid order can be cancelled here');
    if (order.stripeCheckoutSession && this.stripe) {
      await this.stripe.checkout.sessions.expire(order.stripeCheckoutSession).catch(() => undefined);
    }
    const now = new Date().toISOString();
    const { error } = await this.db
      .from('vendor_orders')
      .update({ status: 'cancelled', cancelled_at: now, updated_at: now })
      .eq('id', order.id)
      .eq('status', 'pending_payment');
    if (error) throw dbError('Could not cancel the order', error);
    await this.milestone(order.id, 'The host cancelled the unpaid order.', event.ownerId);
    return { order: await this.one(order.id) };
  }

  // ================================================================ vendor

  /**
   * What the vendor sees on the Payments tab: money received through Lazo,
   * Lazo's commission, the net Lazo owes them, and a receipt per paid order.
   * Vendors are paid by Lazo, not by Stripe directly, so there is nothing to
   * set up here.
   */
  async vendorSummary(ownerId: string) {
    const vendor = await vendorFor(this.db, ownerId);
    const { data, error } = await this.db
      .from('vendor_orders')
      .select(`${ORDER_SELECT}, events(name, event_date), vendor_quotes(title)`)
      .eq('vendor_id', s(vendor.id))
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw dbError('Could not load your payments', error);

    const PAID = new Set(['paid', 'in_progress', 'fulfilled', 'refunded', 'disputed']);
    const rows = (data as Row[]).map((r) => {
      const o = toOrder(r);
      const received = PAID.has(o.status) ? o.amountCentavos - o.refundedCentavos : 0;
      return {
        ...o,
        title: s((r.vendor_quotes as Row | null)?.title),
        event: { name: s((r.events as Row | null)?.name), date: sn((r.events as Row | null)?.event_date) },
        receivedCentavos: received,
        // Lazo keeps the commission; the vendor is owed the rest of what was received.
        netCentavos: Math.max(0, received - (received > 0 ? o.platformFeeCentavos : 0)),
      };
    });

    const paid = rows.filter((o) => o.receivedCentavos > 0);
    const totals = paid.reduce(
      (t, o) => ({
        received: t.received + o.receivedCentavos,
        commission: t.commission + o.platformFeeCentavos,
        net: t.net + o.netCentavos,
        refunded: t.refunded + o.refundedCentavos,
      }),
      { received: 0, commission: 0, net: 0, refunded: 0 },
    );

    return {
      currency: 'MXN',
      // Vendors are paid by Lazo out of band; surface the net owed, not a payout status.
      payoutModel: 'lazo_settles',
      totals,
      orders: rows,
    };
  }

  async vendorOrders(ownerId: string) {
    const vendor = await vendorFor(this.db, ownerId);
    const { data, error } = await this.db
      .from('vendor_orders')
      .select(`${ORDER_SELECT}, events(name, event_date), vendor_quotes(title)`)
      .eq('vendor_id', s(vendor.id))
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw dbError('Could not load your orders', error);
    return {
      orders: (data as Row[]).map((r) => ({
        ...toOrder(r),
        title: s((r.vendor_quotes as Row | null)?.title),
        event: { name: s((r.events as Row | null)?.name), date: sn((r.events as Row | null)?.event_date) },
      })),
    };
  }

  /** { status: in_progress | fulfilled } — only forward, only on a paid order. */
  async setFulfilment(ownerId: string, orderId: string, input: Row) {
    const vendor = await vendorFor(this.db, ownerId);
    const order = await this.forVendor(s(vendor.id), orderId);
    const status = s(input.status);
    const allowed: Record<string, string[]> = { in_progress: ['paid'], fulfilled: ['paid', 'in_progress'] };
    if (!allowed[status]) throw new BadRequestException('status must be in_progress or fulfilled');
    if (!allowed[status].includes(order.status)) throw new ConflictException(`A ${order.status.replace('_', ' ')} order cannot be marked ${status.replace('_', ' ')}`);
    const now = new Date().toISOString();
    const { error } = await this.db
      .from('vendor_orders')
      .update({ status, fulfilled_at: status === 'fulfilled' ? now : null, updated_at: now })
      .eq('id', order.id)
      .eq('status', order.status);
    if (error) throw dbError('Could not update the order', error);
    await this.milestone(order.id, status === 'fulfilled' ? 'The vendor marked the order as fulfilled.' : 'The vendor started working on the order.', ownerId);
    return { order: await this.one(order.id) };
  }

  /**
   * { amountCentavos?, reason } → a real Stripe refund on the PaymentIntent.
   * The charge sat in Lazo's account, so this is a plain refund; Lazo adjusts
   * what it owes the vendor for that order when settling.
   */
  async refund(ownerId: string, orderId: string, input: Row, requestedBy: 'vendor' | 'admin' = 'vendor') {
    const stripe = requireStripe(this.stripe);
    const order = requestedBy === 'admin' ? await this.one(orderId) : await this.forVendor(s((await vendorFor(this.db, ownerId)).id), orderId);
    if (!['paid', 'in_progress', 'fulfilled'].includes(order.status)) throw new ConflictException(`A ${order.status.replace('_', ' ')} order cannot be refunded`);
    if (!order.stripePaymentIntent) throw new ConflictException('This order has no Stripe payment to refund');
    const remaining = order.amountCentavos - order.refundedCentavos;
    const amount = centavos(input.amountCentavos, 'Amount') ?? remaining;
    if (amount > remaining) throw new BadRequestException(`At most ${money(remaining)} can still be refunded`);
    const reason = text(input.reason, 1000, 'Reason', true);
    const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);

    // The same client request again (retry, double click) returns what it already did.
    const repeated = idempotencyKey ? await this.priorRefund(order.id, idempotencyKey) : null;
    if (repeated) return { order: await this.one(order.id), refund: repeated };

    // Reserve the amount atomically before touching Stripe (M3): two refunds
    // racing each other cannot together exceed the charge.
    await reserveRefund(this.db, 'vendor', order.id, amount);

    const { data: row, error } = await this.db
      .from('vendor_refunds')
      .insert({ order_id: order.id, amount_centavos: amount, reason, requested_by: requestedBy, status: 'pending', idempotency_key: idempotencyKey })
      .select('*')
      .single();
    if (error) {
      await settleRefund(this.db, 'vendor', order.id, amount, false);
      if (error.code === UNIQUE_VIOLATION && idempotencyKey) {
        const prior = await this.priorRefund(order.id, idempotencyKey);
        if (prior) return { order: await this.one(order.id), refund: prior };
      }
      throw dbError('Could not record the refund', error);
    }
    const refundId = s((row as Row).id);

    let refund: Stripe.Refund;
    try {
      refund = await stripe.refunds.create(
        {
          payment_intent: order.stripePaymentIntent,
          amount,
          reason: 'requested_by_customer',
          metadata: { orderId: order.id, refundId, requestedBy },
        },
        { idempotencyKey: `vendor-refund-${refundId}` },
      );
    } catch (err) {
      await this.db.from('vendor_refunds').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', refundId);
      await settleRefund(this.db, 'vendor', order.id, amount, false);
      throw new BadRequestException(`Stripe declined the refund: ${(err as Error).message}`);
    }

    await this.db
      .from('vendor_refunds')
      .update({ stripe_refund_id: refund.id, status: refundStatus(refund.status), updated_at: new Date().toISOString() })
      .eq('id', refundId);
    // pending → refunded (and status 'refunded' once the whole charge is back).
    const accepted = refund.status === 'succeeded' || refund.status === 'pending';
    await settleRefund(this.db, 'vendor', order.id, amount, accepted);
    await this.milestone(order.id, `Refund of ${money(amount)} issued${reason ? `: ${reason}` : '.'}`, requestedBy === 'admin' ? 'admin' : ownerId);
    return { order: await this.one(order.id), refund: { id: refundId, status: refundStatus(refund.status), repeated: false } };
  }

  /** A refund this order already recorded under the client's idempotency key, if any. */
  private async priorRefund(orderId: string, idempotencyKey: string): Promise<{ id: string; status: string; repeated: true } | null> {
    const { data } = await this.db.from('vendor_refunds').select('id, status').eq('order_id', orderId).eq('idempotency_key', idempotencyKey).maybeSingle();
    const row = data as Row | null;
    return row ? { id: s(row.id), status: s(row.status), repeated: true } : null;
  }

  // ================================================================ webhook

  /** Stripe → here. Signature checked on the raw body; every event id is processed once. */
  async webhook(rawBody: Buffer | undefined, signature: string | undefined) {
    const stripe = requireStripe(this.stripe);
    const secrets = (process.env.STRIPE_CONNECT_WEBHOOK_SECRET ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    if (!secrets.length) throw new ServiceUnavailableException('STRIPE_CONNECT_WEBHOOK_SECRET is not set');
    if (!rawBody || !signature) throw new BadRequestException('Missing signature');

    // One endpoint may receive both platform events (payments) and Connect
    // events (account.updated); those are two Stripe endpoints with two
    // secrets, so the variable accepts a comma-separated list.
    let event: Stripe.Event | null = null;
    for (const secret of secrets) {
      try {
        event = stripe.webhooks.constructEvent(rawBody, signature, secret);
        break;
      } catch {
        /* try the next secret */
      }
    }
    if (!event) throw new BadRequestException('Webhook signature verification failed');

    const seen = await this.db.from('vendor_stripe_events').insert({ id: event.id, type: event.type });
    if (seen.error?.code === UNIQUE_VIOLATION) return { received: true, duplicate: true };
    if (seen.error) throw dbError('Could not record the webhook', seen.error);

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const intent = event.data.object;
        const orderId = s(intent.metadata?.orderId);
        if (orderId) await this.markPaid(orderId, await stripe.paymentIntents.retrieve(intent.id, { expand: ['latest_charge'] }));
        break;
      }
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        if (session.metadata?.flow === 'vendor_order' && session.payment_status === 'paid' && session.payment_intent) {
          const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id;
          await this.markPaid(s(session.metadata.orderId), await stripe.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] }));
        }
        break;
      }
      case 'checkout.session.expired': {
        const session = event.data.object;
        if (session.metadata?.flow === 'vendor_order') await this.clearSession(s(session.metadata.orderId), session.id);
        break;
      }
      case 'charge.refunded':
        await this.syncRefunds(event.data.object);
        break;
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed':
        await this.syncDispute(event.data.object);
        break;
      case 'account.updated':
        await this.connect.syncAccount(event.data.object);
        break;
      default:
        break;
    }
    return { received: true };
  }

  // ================================================================ internals

  /** pending_payment → paid, with Stripe's charge, transfer and receipt. A late duplicate is a no-op. */
  private async markPaid(orderId: string, intent: Stripe.PaymentIntent) {
    if (!UUID.test(orderId)) return;
    const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
    const now = new Date().toISOString();
    const { error } = await this.db
      .from('vendor_orders')
      .update({
        status: 'paid',
        paid_at: now,
        stripe_payment_intent: intent.id,
        stripe_charge: charge?.id ?? null,
        stripe_transfer: typeof charge?.transfer === 'string' ? charge.transfer : (charge?.transfer?.id ?? null),
        receipt_url: charge?.receipt_url ?? '',
        payment_method: paymentMethod(charge),
        updated_at: now,
      })
      .eq('id', orderId)
      .eq('status', 'pending_payment');
    if (error) throw dbError('Could not mark the order paid', error);
    this.logger.log(`Order ${orderId} paid (${intent.id})`);
    await this.milestone(orderId, `Payment received: ${money(intent.amount_received ?? intent.amount)}. The order is confirmed.`, '');
  }

  /** An expired session just frees the order to start Checkout again. */
  private async clearSession(orderId: string, sessionId: string) {
    if (!UUID.test(orderId)) return;
    await this.db
      .from('vendor_orders')
      .update({ stripe_checkout_session: null, updated_at: new Date().toISOString() })
      .eq('id', orderId)
      .eq('stripe_checkout_session', sessionId)
      .eq('status', 'pending_payment');
  }

  /** charge.refunded: mirror every Stripe refund on this charge and the running total. */
  private async syncRefunds(charge: Stripe.Charge) {
    const stripe = requireStripe(this.stripe);
    const order = await this.byCharge(charge);
    if (!order) return;
    const refunds = await stripe.refunds.list({ charge: charge.id, limit: 100 });
    for (const r of refunds.data) {
      const known = await this.db.from('vendor_refunds').select('id').eq('stripe_refund_id', r.id).maybeSingle();
      if (known.data) {
        await this.db.from('vendor_refunds').update({ status: refundStatus(r.status), updated_at: new Date().toISOString() }).eq('id', (known.data as Row).id);
        continue;
      }
      // Made from the Stripe dashboard (or by a refund whose id we could not save): record it as Stripe's.
      const ours = s(r.metadata?.refundId);
      if (ours && UUID.test(ours)) {
        await this.db.from('vendor_refunds').update({ stripe_refund_id: r.id, status: refundStatus(r.status), updated_at: new Date().toISOString() }).eq('id', ours);
      } else {
        await this.db.from('vendor_refunds').insert({
          order_id: order.id,
          amount_centavos: r.amount,
          reason: r.reason ?? '',
          requested_by: 'stripe',
          stripe_refund_id: r.id,
          status: refundStatus(r.status),
        });
      }
    }
    await this.applyRefundTotal(order.id, charge.amount_refunded, order.amountCentavos);
  }

  private async applyRefundTotal(orderId: string, refunded: number, amount: number) {
    const patch: Row = { refunded_centavos: refunded, updated_at: new Date().toISOString() };
    if (refunded >= amount) patch.status = 'refunded';
    const { error } = await this.db.from('vendor_orders').update(patch).eq('id', orderId);
    if (error) throw dbError('Could not update the order', error);
  }

  private async syncDispute(dispute: Stripe.Dispute) {
    const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id;
    const intentId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : (dispute.payment_intent?.id ?? null);
    const order = await this.byCharge({ id: chargeId, payment_intent: intentId });
    if (!order) return;
    const closed = dispute.status === 'won' || dispute.status === 'lost';
    const now = new Date().toISOString();
    const { error } = await this.db.from('vendor_disputes').upsert(
      {
        order_id: order.id,
        stripe_dispute_id: dispute.id,
        amount_centavos: dispute.amount,
        currency: dispute.currency.toUpperCase(),
        reason: dispute.reason ?? '',
        status: dispute.status,
        evidence_due_by: dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000).toISOString() : null,
        outcome: closed ? dispute.status : '',
        updated_at: now,
      },
      { onConflict: 'stripe_dispute_id' },
    );
    if (error) throw dbError('Could not record the dispute', error);

    if (!closed) {
      if (order.status !== 'disputed') {
        await this.db.from('vendor_orders').update({ status: 'disputed', pre_dispute_status: order.status, updated_at: now }).eq('id', order.id);
      }
      return;
    }
    // Won: back to where it was. Lost: Stripe took the money back, so it reads as refunded.
    const { data: row } = await this.db.from('vendor_orders').select('pre_dispute_status').eq('id', order.id).maybeSingle();
    const restore = dispute.status === 'won' ? s((row as Row | null)?.pre_dispute_status) || 'paid' : 'refunded';
    await this.db.from('vendor_orders').update({ status: restore, updated_at: now }).eq('id', order.id).eq('status', 'disputed');
  }

  private async byCharge(charge: { id: string; payment_intent: string | Stripe.PaymentIntent | null }) {
    const intentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : (charge.payment_intent?.id ?? null);
    let q = this.db.from('vendor_orders').select(ORDER_SELECT);
    q = intentId ? q.or(`stripe_charge.eq.${charge.id},stripe_payment_intent.eq.${intentId}`) : q.eq('stripe_charge', charge.id);
    const { data, error } = await q.limit(1).maybeSingle();
    if (error) throw dbError('Could not find the order', error);
    return data ? toOrder(data as Row) : null;
  }

  /** Mirrors an order event into the host<->vendor thread of its quote, if there is one. Never fails the action. */
  private async milestone(orderId: string, body: string, actorId: string) {
    try {
      const { data } = await this.db.from('vendor_orders').select('quote_id, event_id, vendor_id, owner_id, vendor_quotes(conversation_id)').eq('id', orderId).maybeSingle();
      const o = data as Row | null;
      if (!o) return;
      const conv = await conversationForQuote(this.db, {
        conversationId: sn((o.vendor_quotes as Row | null)?.conversation_id),
        ownerId: s(o.owner_id),
        eventId: s(o.event_id),
        vendorId: s(o.vendor_id),
      });
      if (!conv) return;
      await postSystemLine(this.db, this.chatEvents, conv, { body, quoteId: s(o.quote_id), orderId, actorId });
    } catch {
      // The thread mirrors the order; the order itself is already saved.
    }
  }

  private async one(orderId: string) {
    const { data, error } = await this.db.from('vendor_orders').select(ORDER_SELECT).eq('id', orderId).maybeSingle();
    if (error) throw dbError('Could not load the order', error);
    if (!data) throw new NotFoundException('No such order');
    return { ...toOrder(data as Row), stripeCheckoutSession: sn((data as Row).stripe_checkout_session) };
  }

  private async forHost(event: EventCtx, orderId: string) {
    if (!UUID.test(orderId)) throw new NotFoundException('No such order');
    const order = await this.one(orderId);
    if (order.eventId !== event.id) throw new NotFoundException('No such order');
    return order;
  }

  private async forVendor(vendorId: string, orderId: string) {
    if (!UUID.test(orderId)) throw new NotFoundException('No such order');
    const order = await this.one(orderId);
    if (order.vendorId !== vendorId) throw new NotFoundException('No such order');
    return order;
  }

  private get db() {
    return requireDb(this.supabase);
  }
}

function refundStatus(status: string | null): 'pending' | 'succeeded' | 'failed' | 'cancelled' {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'canceled') return 'cancelled';
  return 'pending';
}

function paymentMethod(charge: Stripe.Charge | null): string {
  const type = charge?.payment_method_details?.type ?? '';
  if (type === 'customer_balance') return 'spei';
  return type;
}

function money(centavos: number): string {
  return `$${(centavos / 100).toLocaleString('es-MX', { minimumFractionDigits: 2 })} MXN`;
}
