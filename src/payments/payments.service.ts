import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { MercadoPagoService, mpOutcome, toCentavos } from './mercadopago.service.js';
import type { MpPayment } from './mercadopago.service.js';
import { reserveRefund, settleRefund } from './refund-guard.js';

export const TIERS_MIGRATION = 'supabase/migrations/20261003000000_tiers_messaging_photos.sql';
export const STRIPE_AMOUNTS_MIGRATION = 'supabase/migrations/20261007000000_payment_stripe_amounts.sql';
export const GATEWAYS_MIGRATION = 'supabase/migrations/20261012000000_modes_mercadopago.sql';
const UNDEFINED_COLUMN = '42703';
const UNDEFINED_TABLE = 'PGRST205';

/** services.key → events.tier. Anything not here is not a plan. */
export const PLAN_TIERS: Record<string, 'premium' | 'signature'> = {
  tier_premium: 'premium',
  tier_signature: 'signature',
};
const TIER_RANK: Record<string, number> = { premium: 1, signature: 2 };

export type Gateway = 'stripe' | 'mercadopago';
export const GATEWAYS: Gateway[] = ['stripe', 'mercadopago'];

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const UUID = /^[0-9a-f-]{36}$/i;

interface StripeCharge {
  amountCents: number;
  currency: string;
  paymentIntent: string | null;
  receiptUrl: string;
}

/** One gateway's verdict on an attempt, in LAZO's vocabulary (PAY-5: one internal contract). */
interface Outcome {
  status: 'succeeded' | 'pending' | 'failed' | 'expired';
  method: 'card' | 'oxxo' | 'spei' | 'other';
  failureReason: string;
  /** What the gateway says it charged, once settled. */
  charged: { amountCents: number; currency: string; reference: string | null; receiptUrl: string } | null;
}

export interface Plan {
  key: string;
  tier: 'premium' | 'signature';
  name: string;
  priceCentavos: number;
  currency: string;
}

export interface GatewayInfo {
  key: Gateway;
  label: string;
  methods: string[];
  active: boolean;
  configured: boolean;
  default: boolean;
}

/** Whether an event's tier includes a feature. `need` is the lowest tier that has it. */
export function tierAllows(tier: string | null | undefined, need: 'premium' | 'signature'): boolean {
  return (TIER_RANK[tier ?? ''] ?? 0) >= TIER_RANK[need];
}

/**
 * Paid plans through Stripe Checkout or Mercado Pago Checkout Pro. Lazo
 * sells only its own plans here; guest gifts never pass through Lazo (see
 * RegistryService), so there is no money held on behalf of hosts (business
 * plan §2, risk of acting as a payment institution).
 *
 * Needs STRIPE_SECRET_KEY / MERCADOPAGO_ACCESS_TOKEN for each gateway,
 * STRIPE_WEBHOOK_SECRET / MERCADOPAGO_WEBHOOK_SECRET for their webhooks, and
 * APP_URL for the return pages (defaults to the first CORS origin).
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly stripe: Stripe | null;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
    private readonly mp: MercadoPagoService,
  ) {
    const key = process.env.STRIPE_SECRET_KEY;
    this.stripe = key ? new Stripe(key) : null;
  }

  /** Which gateways exist and which are usable now. `configured`/`provider`/`methods` describe the default one. */
  async config() {
    const gateways = await this.gateways();
    const def = gateways.find((g) => g.default) ?? gateways[0];
    return {
      configured: gateways.some((g) => g.configured && g.active),
      provider: def?.key ?? 'stripe',
      methods: def?.methods ?? ['card', 'oxxo', 'spei'],
      webhook: def?.key === 'mercadopago' ? this.mp.webhookConfigured : Boolean(process.env.STRIPE_WEBHOOK_SECRET),
      gateways,
    };
  }

  /**
   * The gateways on offer (payment_gateways, GATEWAYS_MIGRATION), with whether
   * each one's env is present. PAYMENTS_DEFAULT_GATEWAY overrides the table's
   * default. Before the migration, both rows come from code with their usual methods.
   */
  async gateways(): Promise<GatewayInfo[]> {
    const { data, error } = await this.db.from('payment_gateways').select('*').order('position');
    let rows: Row[];
    if (error?.code === UNDEFINED_TABLE) {
      rows = [
        { key: 'stripe', label: 'Stripe', methods: ['card', 'oxxo', 'spei'], active: true, is_default: true },
        { key: 'mercadopago', label: 'Mercado Pago', methods: ['card', 'oxxo', 'spei', 'mercadopago_balance'], active: true, is_default: false },
      ];
    } else if (error) {
      throw this.fail('Could not load payment gateways', error);
    } else {
      rows = data as Row[];
    }
    const envDefault = (process.env.PAYMENTS_DEFAULT_GATEWAY || '').trim().toLowerCase();
    const list = rows
      .filter((r): r is Row & { key: Gateway } => GATEWAYS.includes(s(r.key) as Gateway))
      .map((r) => ({
        key: r.key,
        label: s(r.label) || r.key,
        methods: Array.isArray(r.methods) ? (r.methods as unknown[]).map(String) : [],
        active: r.active !== false,
        configured: r.key === 'stripe' ? Boolean(this.stripe) : this.mp.configured,
        default: envDefault ? r.key === envDefault : r.is_default === true,
      }));
    // A default that isn't usable falls back to the first usable gateway.
    if (!list.some((g) => g.default && g.configured && g.active)) {
      const first = list.find((g) => g.configured && g.active);
      for (const g of list) g.default = first ? g.key === first.key : false;
    }
    return list;
  }

  /** The plans on sale, from the services table. */
  async plans(): Promise<Plan[]> {
    const { data, error } = await this.db
      .from('services')
      .select('*')
      .in('key', Object.keys(PLAN_TIERS))
      .eq('active', true);
    if (error) throw this.fail('Could not load plans', error);
    return (data as Row[])
      .map((r) => ({
        key: s(r.key),
        tier: PLAN_TIERS[s(r.key)],
        name: s(r.name),
        priceCentavos: Number(r.price_centavos ?? 0),
        currency: s(r.currency) || 'MXN',
      }))
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
  }

  /**
   * Starts a checkout for an event and plan on the chosen gateway (or the
   * default). Returns the URL to send the host to. Each call is a fresh
   * attempt; nothing is ever retried on another gateway automatically (PAY-5).
   */
  async checkout(event: { id: string; name: string; tier: string | null; ownerId: string }, input: Row, email: string | null) {
    const gateways = await this.gateways();
    const wanted = input.gateway === undefined || input.gateway === null ? null : s(input.gateway).toLowerCase();
    if (wanted !== null && !GATEWAYS.includes(wanted as Gateway)) throw new BadRequestException("gateway must be 'stripe' or 'mercadopago'");
    const gateway = gateways.find((g) => (wanted ? g.key === wanted : g.default));
    if (!gateway || !gateway.active) throw new BadRequestException('That payment gateway is not on offer');
    if (!gateway.configured) {
      throw new ServiceUnavailableException(
        gateway.key === 'stripe' ? 'Payments are not set up yet (STRIPE_SECRET_KEY).' : 'Mercado Pago is not set up yet (MERCADOPAGO_ACCESS_TOKEN).',
      );
    }

    const plan = (await this.plans()).find((p) => p.key === s(input.product));
    if (!plan) throw new BadRequestException('Choose a plan');
    if (tierAllows(event.tier, plan.tier)) throw new BadRequestException(`This event already has the ${plan.name}`);
    if (plan.priceCentavos < 1000) throw new BadRequestException('This plan has no price yet');

    const attemptId = randomUUID();
    const appUrl = this.appUrl();
    let reference: string;
    let url: string;

    if (gateway.key === 'stripe') {
      const session = await this.stripe!.checkout.sessions.create(
        {
          mode: 'payment',
          currency: plan.currency.toLowerCase(),
          customer_email: email ?? undefined,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: plan.currency.toLowerCase(),
                unit_amount: plan.priceCentavos,
                product_data: { name: `Lazo ${plan.name}`, description: event.name },
              },
            },
          ],
          // OXXO vouchers settle later; the webhook's async_payment_succeeded handles that.
          payment_method_options: { oxxo: { expires_after_days: 3 } },
          metadata: { attemptId, eventId: event.id, product: plan.key, ownerId: event.ownerId },
          success_url: `${appUrl}/dashboard/events/${event.id}?checkout={CHECKOUT_SESSION_ID}`,
          cancel_url: `${appUrl}/dashboard/events/${event.id}/upgrade?cancelled=1`,
          locale: 'es',
        },
        { idempotencyKey: attemptId },
      );
      reference = session.id;
      url = session.url ?? '';
    } else {
      const back = `${appUrl}/dashboard/events/${event.id}`;
      const pref = await this.mp.createPreference({
        attemptId,
        title: `Lazo ${plan.name}`,
        description: event.name,
        amountCentavos: plan.priceCentavos,
        currency: plan.currency,
        email,
        // MP appends payment_id, status and external_reference to these.
        successUrl: `${back}?gateway=mercadopago`,
        pendingUrl: `${back}?gateway=mercadopago`,
        failureUrl: `${back}/upgrade?cancelled=1&gateway=mercadopago`,
        notificationUrl: this.apiUrl() ? `${this.apiUrl()}/api/webhooks/mercadopago` : null,
      });
      reference = pref.id;
      url = pref.url;
    }

    const { error } = await this.db.from('payment_attempts').insert({
      id: attemptId,
      flow: 'event_fee',
      event_id: event.id,
      owner_id: event.ownerId,
      product: plan.key,
      gateway: gateway.key,
      method: 'other',
      status: 'created',
      amount_cents: plan.priceCentavos,
      currency: plan.currency,
      idempotency_key: attemptId,
      provider_reference: reference,
      checkout_url: url,
    });
    if (error) throw this.fail('Could not record the payment', error);

    return { url, attemptId, gateway: gateway.key };
  }

  /**
   * After Stripe sends the host back with ?checkout=cs_…: read the session and
   * apply it. Idempotent with the webhook, and the only path that works on a
   * laptop with no public webhook URL.
   */
  async confirm(ownerId: string, sessionId: unknown) {
    if (!this.stripe) throw new ServiceUnavailableException('Payments are not set up yet');
    const id = s(sessionId);
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) throw new BadRequestException('Unknown checkout session');
    const session = await this.stripe.checkout.sessions.retrieve(id, { expand: ['payment_intent'] });
    if (session.metadata?.ownerId !== ownerId) throw new NotFoundException('Unknown checkout session');
    return this.applyStripe(session);
  }

  /** After Checkout Pro sends the host back with ?gateway=mercadopago&payment_id=…: read the payment and apply it. */
  async confirmMercadoPago(ownerId: string, paymentId: unknown) {
    const payment = await this.mp.getPayment(s(paymentId));
    const attempt = await this.attemptFor(payment);
    if (!attempt || s(attempt.owner_id) !== ownerId) throw new NotFoundException('Unknown Mercado Pago payment');
    return this.applyMercadoPago(payment, attempt);
  }

  /** Stripe → here. The signature is checked against the raw body. */
  async webhook(rawBody: Buffer | undefined, signature: string | undefined) {
    if (!this.stripe) throw new ServiceUnavailableException('Payments are not set up yet');
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new ServiceUnavailableException('STRIPE_WEBHOOK_SECRET is not set');
    if (!rawBody || !signature) throw new BadRequestException('Missing signature');
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      throw new BadRequestException('Webhook signature verification failed');
    }
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired':
        await this.applyStripe(event.data.object);
        break;
      default:
        break;
    }
    return { received: true };
  }

  /**
   * Mercado Pago → here (IPN / webhooks). The x-signature HMAC is the
   * authentication; the payment itself is always re-read from the API rather
   * than trusted from the notification body (PAY-6: verified callbacks,
   * duplicate/out-of-order tolerant).
   */
  async mercadoPagoWebhook(body: Row, query: Record<string, unknown>, headers: { signature?: string; requestId?: string }) {
    if (!this.mp.configured) throw new ServiceUnavailableException('Mercado Pago is not set up yet (MERCADOPAGO_ACCESS_TOKEN).');
    const data = (body?.data ?? {}) as Row;
    const dataId = s(data.id) || (typeof data.id === 'number' ? String(data.id) : '') || s(query['data.id']) || s(query.id);
    if (!this.mp.verifySignature(headers.signature, headers.requestId, dataId || undefined)) {
      throw new BadRequestException('Webhook signature verification failed');
    }
    const type = s(body?.type) || s(query.type) || s(query.topic);
    if (type !== 'payment' || !dataId) return { received: true, ignored: true };
    const payment = await this.mp.getPayment(dataId);
    const attempt = await this.attemptFor(payment);
    if (!attempt) return { received: true, ignored: true };
    await this.applyMercadoPago(payment, attempt);
    return { received: true };
  }

  /** What a host has bought or started, for the billing page. */
  async history(ownerId: string, eventId?: string) {
    let q = this.db.from('payment_attempts').select('*').eq('owner_id', ownerId).order('created_at', { ascending: false });
    if (eventId) q = q.eq('event_id', eventId);
    const { data, error } = await q.limit(100);
    if (error) throw this.fail('Could not load payments', error);
    return { payments: (data as Row[]).map(toPayment) };
  }

  // ---------------------------------------------------------------- admin

  /** Every plan purchase, what the gateway says it charged, paid totals, and the live Stripe balance. */
  async adminList() {
    const { data, error } = await this.db
      .from('payment_attempts')
      .select('*, events(name)')
      .eq('flow', 'event_fee')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw this.fail('Could not load payments', error);
    const payments = (data as Row[]).map((r) => ({ ...toPayment(r), eventName: s((r.events as Row | null)?.name) }));

    // Paid totals per currency: the gateway's figure where we have it, ours otherwise.
    const paid = payments.filter((p) => p.status === 'succeeded' || p.status === 'partially_refunded' || p.status === 'refunded');
    const totals: Record<string, number> = {};
    const refunded: Record<string, number> = {};
    for (const p of paid) {
      const cur = p.stripeCurrency || p.currency;
      totals[cur] = (totals[cur] ?? 0) + (p.stripeAmountCents ?? p.amountCents);
      if (p.refundedCents) refunded[p.currency] = (refunded[p.currency] ?? 0) + p.refundedCents;
    }

    return {
      payments,
      summary: {
        started: payments.length,
        paid: paid.length,
        totals: Object.entries(totals).map(([currency, cents]) => ({ currency, cents })),
        refunded: Object.entries(refunded).map(([currency, cents]) => ({ currency, cents })),
      },
      stripe: await this.stripeBalance(),
      gateways: await this.gateways(),
    };
  }

  /** Re-reads one attempt from its gateway and applies it: fills older rows, or a missed webhook. */
  async adminSync(attemptId: string) {
    if (!UUID.test(attemptId)) throw new NotFoundException('No such payment');
    const { data, error } = await this.db.from('payment_attempts').select('*').eq('id', attemptId).maybeSingle();
    if (error) throw this.fail('Could not load the payment', error);
    const attempt = data as Row | null;
    const ref = s(attempt?.provider_reference);
    if (!attempt || !ref) throw new NotFoundException('No such payment');

    if (s(attempt.gateway) === 'mercadopago') {
      // A preference has no payment until the payer acts; the settled one is what we re-read.
      const paymentId = s(attempt.gateway_payment_id);
      if (!paymentId) return { applied: false, status: s(attempt.status) };
      const payment = await this.mp.getPayment(paymentId);
      return this.applyMercadoPago(payment, attempt, true);
    }

    if (!this.stripe) throw new ServiceUnavailableException('Payments are not set up yet');
    const session = await this.stripe.checkout.sessions.retrieve(ref, { expand: ['payment_intent'] });
    return this.applyStripe(session, true);
  }

  /**
   * Refunds an event-fee payment on whichever gateway took it. { amountCentavos?, reason }.
   * A full refund of a plan takes the tier back off the event (the highest
   * other paid plan, or Free). Partial refunds leave the tier alone.
   */
  async adminRefund(attemptId: string, input: Row) {
    if (!UUID.test(attemptId)) throw new NotFoundException('No such payment');
    const { data, error } = await this.db.from('payment_attempts').select('*').eq('id', attemptId).maybeSingle();
    if (error) throw this.fail('Could not load the payment', error);
    const attempt = data as Row | null;
    if (!attempt) throw new NotFoundException('No such payment');
    if (!['succeeded', 'partially_refunded'].includes(s(attempt.status))) throw new BadRequestException('Only a settled payment can be refunded');

    const reason = s(input.reason).trim().slice(0, 300);
    if (!reason) throw new BadRequestException('Give a reason for the refund');
    const charged = Number(attempt.stripe_amount_cents ?? attempt.amount_cents ?? 0);
    const already = Number(attempt.refunded_centavos ?? 0);
    const remaining = charged - already;
    if (remaining <= 0) throw new BadRequestException('This payment is already fully refunded');
    let amount = remaining;
    if (input.amountCentavos !== undefined && input.amountCentavos !== null) {
      amount = Number(input.amountCentavos);
      if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException('amountCentavos must be a whole number of centavos');
      if (amount > remaining) throw new BadRequestException(`At most ${remaining} centavos can still be refunded`);
    }
    const full = amount === remaining;
    const key = `${attemptId}:${already + amount}`;

    // Reserve the amount atomically before the gateway call (M11): a second
    // admin clicking Refund at the same time gets a 409 instead of a double refund.
    await reserveRefund(this.db, 'payment', attemptId, amount);

    let reference: string;
    try {
      if (s(attempt.gateway) === 'mercadopago') {
        const paymentId = s(attempt.gateway_payment_id);
        if (!paymentId) throw new BadRequestException('This payment has no Mercado Pago payment id yet; sync it first');
        reference = (await this.mp.refund(paymentId, full && already === 0 ? null : amount, key)).id;
      } else {
        if (!this.stripe) throw new ServiceUnavailableException('Payments are not set up yet');
        const intent = s(attempt.stripe_payment_intent);
        if (!intent) throw new BadRequestException('This payment has no Stripe PaymentIntent; sync it first');
        const refund = await this.stripe.refunds.create(
          { payment_intent: intent, amount, reason: 'requested_by_customer', metadata: { attemptId, reason } },
          { idempotencyKey: key },
        );
        reference = refund.id;
      }
    } catch (err) {
      await settleRefund(this.db, 'payment', attemptId, amount, false);
      throw err;
    }
    // pending → refunded_centavos, in the database function.
    await settleRefund(this.db, 'payment', attemptId, amount, true);

    const upd = await this.db
      .from('payment_attempts')
      .update({
        status: full ? 'refunded' : 'partially_refunded',
        refund_reference: reference,
        refunded_at: new Date().toISOString(),
        failure_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .eq('id', attemptId);
    if (upd.error) throw this.fail('Could not record the refund', upd.error);

    if (full && s(attempt.event_id) && PLAN_TIERS[s(attempt.product)]) await this.recomputeTier(s(attempt.event_id));
    this.logger.log(`Refunded ${amount} on attempt ${attemptId} (${s(attempt.gateway)} ${reference})`);
    return { refunded: true, amountCentavos: amount, reference, status: full ? 'refunded' : 'partially_refunded' };
  }

  /**
   * DB vs gateway for a date range (PAY-5/6 reconciliation). Lists our settled
   * attempts, the gateway's settled payments, and flags what only one side has
   * or where amounts differ.
   */
  async adminReconcile(from: unknown, to: unknown, gatewayInput: unknown) {
    const gateway = s(gatewayInput).toLowerCase() || 'stripe';
    if (!GATEWAYS.includes(gateway as Gateway)) throw new BadRequestException("gateway must be 'stripe' or 'mercadopago'");
    const fromDay = s(from) || new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const toDay = s(to) || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay)) throw new BadRequestException('from and to must be YYYY-MM-DD');
    const begin = new Date(`${fromDay}T00:00:00.000Z`);
    const end = new Date(`${toDay}T23:59:59.999Z`);
    if (begin > end) throw new BadRequestException('from must be before to');

    const { data, error } = await this.db
      .from('payment_attempts')
      .select('*')
      .eq('flow', 'event_fee')
      .eq('gateway', gateway)
      .in('status', ['succeeded', 'partially_refunded', 'refunded'])
      .gte('succeeded_at', begin.toISOString())
      .lte('succeeded_at', end.toISOString())
      .order('succeeded_at');
    if (error) throw this.fail('Could not load payments', error);
    const ours = (data as Row[]).map(toPayment);

    // The gateway's view, keyed by the payment reference we store.
    let theirs: { reference: string; amountCents: number; currency: string; status: string; createdAt: string; attemptId: string | null }[];
    if (gateway === 'stripe') {
      if (!this.stripe) throw new ServiceUnavailableException('Payments are not set up yet (STRIPE_SECRET_KEY).');
      theirs = [];
      // Created a day early, since a session's PaymentIntent predates the OXXO settlement.
      const created = { gte: Math.floor(begin.getTime() / 1000) - 7 * 86_400, lte: Math.floor(end.getTime() / 1000) };
      for await (const pi of this.stripe.paymentIntents.list({ created, limit: 100 })) {
        if (pi.status !== 'succeeded') continue;
        theirs.push({
          reference: pi.id,
          amountCents: pi.amount_received,
          currency: pi.currency.toUpperCase(),
          status: pi.status,
          createdAt: new Date(pi.created * 1000).toISOString(),
          attemptId: pi.metadata?.attemptId ?? null,
        });
      }
    } else {
      if (!this.mp.configured) throw new ServiceUnavailableException('Mercado Pago is not set up yet (MERCADOPAGO_ACCESS_TOKEN).');
      theirs = (await this.mp.searchPayments(begin.toISOString(), end.toISOString()))
        .filter((p) => p.status === 'approved')
        .map((p) => ({
          reference: String(p.id),
          amountCents: toCentavos(p.transaction_amount),
          currency: (p.currency_id || 'MXN').toUpperCase(),
          status: p.status,
          createdAt: p.date_created,
          attemptId: p.external_reference,
        }));
    }

    const refOf = (p: ReturnType<typeof toPayment>) => (gateway === 'stripe' ? p.stripePaymentIntent : p.gatewayPaymentId);
    const byRef = new Map(theirs.map((t) => [t.reference, t]));
    const byAttempt = new Map(theirs.filter((t) => t.attemptId).map((t) => [t.attemptId!, t]));
    const matched: { attempt: ReturnType<typeof toPayment>; gateway: (typeof theirs)[number] }[] = [];
    const mismatched: { attempt: ReturnType<typeof toPayment>; gateway: (typeof theirs)[number]; problem: string }[] = [];
    const missingInGateway: ReturnType<typeof toPayment>[] = [];
    const seen = new Set<string>();
    for (const p of ours) {
      const t = (refOf(p) && byRef.get(refOf(p)!)) || byAttempt.get(p.id) || null;
      if (!t) {
        missingInGateway.push(p);
        continue;
      }
      seen.add(t.reference);
      const problem =
        t.amountCents !== p.amountCents ? `amount: ours ${p.amountCents}, gateway ${t.amountCents}` : t.currency !== p.currency ? `currency: ours ${p.currency}, gateway ${t.currency}` : '';
      if (problem) mismatched.push({ attempt: p, gateway: t, problem });
      else matched.push({ attempt: p, gateway: t });
    }
    // Gateway payments that never reached our table (or belong to other flows). Only
    // those that reference one of our attempt ids are certainly ours.
    const missingInDb = theirs.filter((t) => !seen.has(t.reference) && t.attemptId && UUID.test(t.attemptId));
    const sum = (list: { amountCents: number }[]) => list.reduce((n, x) => n + x.amountCents, 0);
    return {
      gateway,
      from: fromDay,
      to: toDay,
      totals: { oursCents: sum(ours), gatewayCents: sum(theirs), gatewayCount: theirs.length, oursCount: ours.length },
      matched,
      mismatched,
      missingInGateway,
      missingInDb,
      ok: mismatched.length === 0 && missingInGateway.length === 0 && missingInDb.length === 0,
    };
  }

  async services() {
    const { data, error } = await this.db.from('services').select('*').order('key');
    if (error) throw this.fail('Could not load services', error);
    return {
      services: (data as Row[]).map((r) => ({
        key: s(r.key),
        name: s(r.name),
        priceCentavos: Number(r.price_centavos ?? 0),
        currency: s(r.currency),
        active: r.active !== false,
      })),
    };
  }

  /** { name?, priceCentavos?, active? } on one service (a plan, the custom domain, the custom theme). */
  async updateService(key: string, input: Row) {
    if (!/^[a-z0-9_]{1,40}$/.test(key)) throw new NotFoundException('No such service');
    const patch: Row = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) {
      const name = s(input.name).trim();
      if (!name || name.length > 120) throw new BadRequestException('Name must be 1–120 characters');
      patch.name = name;
    }
    if (input.priceCentavos !== undefined) {
      const n = Number(input.priceCentavos);
      if (!Number.isInteger(n) || n < 0 || n > 100_000_000_00) throw new BadRequestException('Price must be a whole number of centavos');
      patch.price_centavos = n;
    }
    if (input.active !== undefined) {
      if (typeof input.active !== 'boolean') throw new BadRequestException('active must be true or false');
      patch.active = input.active;
    }
    const { data, error } = await this.db.from('services').update(patch).eq('key', key).select('key');
    if (error) throw this.fail('Could not save the service', error);
    if (!data?.length) throw new NotFoundException('No such service');
    return this.services();
  }

  // ------------------------------------------------------------- internals

  /** Stripe's Checkout session → the shared outcome. `refresh` re-records the charged figures on an already-paid row. */
  private async applyStripe(session: Stripe.Checkout.Session, refresh = false) {
    const attemptId = session.metadata?.attemptId;
    if (!attemptId) return { applied: false, status: 'unknown' };
    const paid = session.payment_status === 'paid';
    const charged = paid ? await this.chargedBy(session) : null;
    return this.settle(
      attemptId,
      {
        status: paid ? 'succeeded' : session.status === 'expired' ? 'expired' : 'pending',
        method: methodOf(session),
        failureReason: session.status === 'expired' ? 'Checkout expired' : '',
        charged: charged ? { amountCents: charged.amountCents, currency: charged.currency, reference: charged.paymentIntent, receiptUrl: charged.receiptUrl } : null,
      },
      refresh,
    );
  }

  /** A Mercado Pago payment → the shared outcome. */
  private async applyMercadoPago(payment: MpPayment, attempt: Row, refresh = false) {
    const { status, method } = mpOutcome(payment);
    const paid = status === 'succeeded';
    return this.settle(
      s(attempt.id),
      {
        status,
        method,
        failureReason: status === 'failed' || status === 'expired' ? payment.status_detail || payment.status : '',
        charged: paid
          ? {
              amountCents: toCentavos(payment.transaction_amount),
              currency: (payment.currency_id || 'MXN').toUpperCase(),
              reference: String(payment.id),
              receiptUrl: payment.transaction_details?.external_resource_url ?? '',
            }
          : null,
      },
      refresh,
      String(payment.id),
    );
  }

  /**
   * The one place a gateway's verdict changes our records (PAY-5). Never
   * moves a succeeded attempt backwards (late or duplicate deliveries), and
   * applies the plan to the event exactly once.
   */
  private async settle(attemptId: string, outcome: Outcome, refresh: boolean, gatewayPaymentId: string | null = null) {
    const { data, error } = await this.db.from('payment_attempts').select('*').eq('id', attemptId).maybeSingle();
    if (error) throw this.fail('Could not load the payment', error);
    const attempt = data as Row | null;
    if (!attempt) return { applied: false, status: 'unknown' };
    const eventId = s(attempt.event_id);
    const product = s(attempt.product);
    const tier = PLAN_TIERS[product];
    if (!eventId || !tier) return { applied: false, status: 'unknown' };

    const paid = outcome.status === 'succeeded';
    const chargedCols = outcome.charged
      ? {
          stripe_amount_cents: outcome.charged.amountCents,
          stripe_currency: outcome.charged.currency,
          // For MP this column stays the preference; the payment id has its own column.
          ...(s(attempt.gateway) === 'stripe' ? { stripe_payment_intent: outcome.charged.reference } : {}),
          receipt_url: outcome.charged.receiptUrl,
        }
      : {};
    const idCols = gatewayPaymentId ? { gateway_payment_id: gatewayPaymentId } : {};

    const done = ['succeeded', 'partially_refunded', 'refunded'].includes(s(attempt.status));
    if (done) {
      // Already paid: only refresh the gateway's figures when asked (admin sync).
      if (refresh && outcome.charged) {
        const upd = await this.db
          .from('payment_attempts')
          .update({ ...chargedCols, ...idCols, updated_at: new Date().toISOString() })
          .eq('id', attemptId);
        if (upd.error) throw this.fail('Could not update the payment', upd.error);
      }
      return { applied: true, status: s(attempt.status), tier };
    }

    const upd = await this.db
      .from('payment_attempts')
      .update({
        status: outcome.status,
        method: outcome.method,
        succeeded_at: paid ? new Date().toISOString() : null,
        failure_reason: outcome.failureReason,
        updated_at: new Date().toISOString(),
        ...chargedCols,
        ...idCols,
      })
      .eq('id', attemptId);
    if (upd.error) throw this.fail('Could not update the payment', upd.error);

    if (paid) {
      const { data: ev } = await this.db.from('events').select('tier').eq('id', eventId).maybeSingle();
      // A Signature purchase never gets downgraded by a later Premium receipt.
      if (!tierAllows((ev as Row | null)?.tier as string | null, tier)) {
        const evUpd = await this.db.from('events').update({ tier, paid_at: new Date().toISOString() }).eq('id', eventId);
        if (evUpd.error) throw this.fail('Could not apply the plan', evUpd.error);
      }
      this.logger.log(`Event ${eventId} upgraded to ${tier} (attempt ${attemptId}, ${s(attempt.gateway)})`);
      return { applied: true, status: 'succeeded', tier };
    }
    return { applied: true, status: outcome.status };
  }

  /** After a full refund: the event keeps the best plan it still has a settled payment for. */
  private async recomputeTier(eventId: string) {
    const { data, error } = await this.db
      .from('payment_attempts')
      .select('product')
      .eq('event_id', eventId)
      .eq('flow', 'event_fee')
      .in('status', ['succeeded', 'partially_refunded']);
    if (error) throw this.fail('Could not load payments', error);
    let best: 'premium' | 'signature' | null = null;
    for (const r of data as Row[]) {
      const t = PLAN_TIERS[s(r.product)];
      if (t && (TIER_RANK[t] ?? 0) > (TIER_RANK[best ?? ''] ?? 0)) best = t;
    }
    const upd = await this.db.from('events').update({ tier: best, updated_at: new Date().toISOString() }).eq('id', eventId);
    if (upd.error) throw this.fail('Could not update the plan', upd.error);
    this.logger.log(`Event ${eventId} tier is now ${best ?? 'free'} after refund`);
  }

  /** The attempt an MP payment belongs to: external_reference is the attempt id we set on the preference. */
  private async attemptFor(payment: MpPayment): Promise<Row | null> {
    const ref = s(payment.external_reference);
    if (!UUID.test(ref)) return null;
    const { data, error } = await this.db.from('payment_attempts').select('*').eq('id', ref).eq('gateway', 'mercadopago').maybeSingle();
    if (error) throw this.fail('Could not load the payment', error);
    return (data as Row | null) ?? null;
  }

  /** Stripe's own figure for a paid session: amount, currency, PaymentIntent and receipt. */
  private async chargedBy(session: Stripe.Checkout.Session): Promise<StripeCharge | null> {
    const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id ?? null);
    let receiptUrl = '';
    if (intentId && this.stripe) {
      try {
        const intent = await this.stripe.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
        const charge = intent.latest_charge;
        if (charge && typeof charge === 'object') receiptUrl = charge.receipt_url ?? '';
      } catch (err) {
        this.logger.warn(`Could not read PaymentIntent ${intentId}: ${(err as Error).message}`);
      }
    }
    return {
      amountCents: Number(session.amount_total ?? 0),
      currency: (session.currency ?? '').toUpperCase(),
      paymentIntent: intentId,
      receiptUrl,
    };
  }

  /** Stripe's account balance, or null when Stripe is not configured or unreachable. */
  private async stripeBalance() {
    if (!this.stripe) return null;
    try {
      const balance = await this.stripe.balance.retrieve();
      const rows = (list: Array<{ currency: string; amount: number }>) =>
        list.map((r) => ({ currency: r.currency.toUpperCase(), cents: r.amount }));
      return { livemode: balance.livemode, available: rows(balance.available), pending: rows(balance.pending) };
    } catch (err) {
      this.logger.warn(`Could not read the Stripe balance: ${(err as Error).message}`);
      return null;
    }
  }

  private appUrl(): string {
    return (process.env.APP_URL || (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',')[0]).trim().replace(/\/+$/, '');
  }

  /** Where Mercado Pago can reach this server (API_URL); none on a laptop, so no notification_url. */
  private apiUrl(): string | null {
    const url = (process.env.API_URL || '').trim().replace(/\/+$/, '');
    return url.startsWith('https://') ? url : null;
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_COLUMN && /refund|gateway_payment_id/.test(error.message)) {
      return new ServiceUnavailableException(`Payment tables are out of date. Apply ${GATEWAYS_MIGRATION}.`);
    }
    if (error.code === UNDEFINED_TABLE && /payment_gateways/.test(error.message)) {
      return new ServiceUnavailableException(`Payment tables are out of date. Apply ${GATEWAYS_MIGRATION}.`);
    }
    if (error.code === UNDEFINED_COLUMN && /stripe_|receipt_url/.test(error.message)) {
      return new ServiceUnavailableException(`Payment tables are out of date. Apply ${STRIPE_AMOUNTS_MIGRATION}.`);
    }
    if (error.code === UNDEFINED_COLUMN || error.code === UNDEFINED_TABLE) {
      return new ServiceUnavailableException(`Payment tables are out of date. Apply ${TIERS_MIGRATION}.`);
    }
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

function methodOf(session: Stripe.Checkout.Session): 'card' | 'oxxo' | 'spei' | 'other' {
  const types = session.payment_method_types ?? [];
  const intent = session.payment_intent;
  const used = typeof intent === 'object' && intent ? intent.payment_method_types?.[0] : types[0];
  if (used === 'card') return 'card';
  if (used === 'oxxo') return 'oxxo';
  if (used === 'customer_balance') return 'spei';
  return 'other';
}

function toPayment(r: Row) {
  return {
    id: s(r.id),
    eventId: s(r.event_id),
    product: s(r.product),
    gateway: s(r.gateway) || 'stripe',
    status: s(r.status),
    method: s(r.method),
    amountCents: Number(r.amount_cents ?? 0),
    currency: s(r.currency) || 'MXN',
    checkoutUrl: s(r.checkout_url),
    // What the gateway reports it charged; null until the payment settles or is synced.
    stripeAmountCents: r.stripe_amount_cents === null || r.stripe_amount_cents === undefined ? null : Number(r.stripe_amount_cents),
    stripeCurrency: s(r.stripe_currency) || null,
    stripePaymentIntent: s(r.stripe_payment_intent) || null,
    gatewayPaymentId: s(r.gateway_payment_id) || null,
    receiptUrl: s(r.receipt_url),
    refundedCents: Number(r.refunded_centavos ?? 0),
    refundReference: s(r.refund_reference) || null,
    refundedAt: typeof r.refunded_at === 'string' ? r.refunded_at : null,
    succeededAt: typeof r.succeeded_at === 'string' ? r.succeeded_at : null,
    createdAt: s(r.created_at),
  };
}
