import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { analyticsQuery } from './analytics-db.js';

export interface ReconciliationRow {
  day: string;
  gateway: string;
  dbGross: number;
  gatewayGross: number | null;
  dbCount: number;
  gatewayCount: number | null;
  gatewayFeeCents: number | null;
  delta: number | null;
  status: 'ok' | 'mismatch' | 'unchecked';
  note: string;
  checkedAt: string | null;
}

interface GatewayDay {
  gross: number;
  count: number;
  fee: number;
}
/** Per-charge fee keyed by the gateway's reference, to write back into fact_payments. */
type GatewayReport = { days: Map<string, GatewayDay>; fees: Map<string, number>; note: string };

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const toRow = (r: Row): ReconciliationRow => ({
  day: String(r.day).slice(0, 10),
  gateway: String(r.gateway),
  dbGross: Number(r.db_gross ?? 0),
  gatewayGross: num(r.gateway_gross),
  dbCount: Number(r.db_count ?? 0),
  gatewayCount: num(r.gateway_count),
  gatewayFeeCents: num(r.gateway_fee_cents),
  delta: num(r.delta),
  status: r.status as ReconciliationRow['status'],
  note: String(r.note ?? ''),
  checkedAt: r.checked_at ? String(r.checked_at) : null,
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const utcDay = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

/**
 * Revenue reconciliation (PRD DATA-3, GATE-1/5): compares what the warehouse
 * holds per day and gateway with what the gateway itself reports for the same
 * days. Stripe through the SDK (balance transactions), Mercado Pago through
 * its payments search when MERCADOPAGO_ACCESS_TOKEN is set. A gateway without
 * credentials is marked `unchecked`, never assumed to match.
 */
@Injectable()
export class AnalyticsReconcileService {
  private readonly logger = new Logger(AnalyticsReconcileService.name);
  private readonly stripe: Stripe | null;
  private readonly mercadoPagoToken: string;

  constructor() {
    const key = process.env.STRIPE_SECRET_KEY;
    this.stripe = key ? new Stripe(key) : null;
    this.mercadoPagoToken = process.env.MERCADOPAGO_ACCESS_TOKEN ?? '';
  }

  config() {
    return { stripe: Boolean(this.stripe), mercadopago: Boolean(this.mercadoPagoToken) };
  }

  async list(from?: string, to?: string): Promise<ReconciliationRow[]> {
    const rows = await analyticsQuery<Row>(
      `select * from analytics.revenue_reconciliation
        where ($1::date is null or day >= $1::date) and ($2::date is null or day <= $2::date)
        order by day desc, gateway`,
      [from && DAY.test(from) ? from : null, to && DAY.test(to) ? to : null],
    );
    return rows.map(toRow);
  }

  /** Reconciles every gateway that has rows in [from, to] (inclusive days). */
  async reconcile(from: string, to: string): Promise<{ rows: ReconciliationRow[]; gateways: Record<string, string> }> {
    if (!DAY.test(from) || !DAY.test(to)) throw new BadRequestException('from and to must be YYYY-MM-DD.');
    if (from > to) throw new BadRequestException('from must not be after to.');
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    if (days > 92) throw new BadRequestException('Reconcile at most 92 days per run.');

    // Make sure every day with a payment has a row, then find which gateways to check.
    await analyticsQuery(
      `insert into analytics.revenue_reconciliation (day, gateway, db_gross, db_count)
         select p.day, p.gateway,
                coalesce(sum(p.amount_cents) filter (where p.status in ('succeeded','partially_refunded','refunded')), 0),
                count(*) filter (where p.status in ('succeeded','partially_refunded','refunded'))
           from analytics.fact_payments p where p.day between $1::date and $2::date
          group by 1, 2
         on conflict (day, gateway) do update set db_gross = excluded.db_gross, db_count = excluded.db_count`,
      [from, to],
    );
    const gatewayRows = await analyticsQuery<Row>(
      'select distinct gateway from analytics.revenue_reconciliation where day between $1::date and $2::date',
      [from, to],
    );
    const gateways = gatewayRows.map((r) => String(r.gateway));
    if (!gateways.includes('stripe') && this.stripe) gateways.push('stripe');
    if (!gateways.includes('mercadopago') && this.mercadoPagoToken) gateways.push('mercadopago');

    const outcome: Record<string, string> = {};
    for (const gateway of gateways) {
      const report = await this.fetchGateway(gateway, from, to);
      if (!report) {
        outcome[gateway] = 'unchecked';
        await analyticsQuery(
          `update analytics.revenue_reconciliation
              set status = 'unchecked', checked_at = now(), note = $3
            where gateway = $1 and day between $2::date and $4::date`,
          [gateway, from, this.uncheckedReason(gateway), to],
        );
        continue;
      }
      outcome[gateway] = 'checked';
      // Days the gateway reports but we have no attempts for still need a row.
      for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
        const day = new Date(t).toISOString().slice(0, 10);
        const g = report.days.get(day) ?? { gross: 0, count: 0, fee: 0 };
        await analyticsQuery(
          `insert into analytics.revenue_reconciliation as rr (day, gateway, db_gross, db_count, gateway_gross, gateway_count, gateway_fee_cents, delta, status, note, checked_at)
             values ($1::date, $2, 0, 0, $3, $4, $5, $3 - 0, case when $3 = 0 then 'ok' else 'mismatch' end, $6, now())
           on conflict (day, gateway) do update set
             gateway_gross = excluded.gateway_gross, gateway_count = excluded.gateway_count,
             gateway_fee_cents = excluded.gateway_fee_cents,
             delta = excluded.gateway_gross - rr.db_gross,
             status = case when excluded.gateway_gross = rr.db_gross and excluded.gateway_count = rr.db_count
                           then 'ok' else 'mismatch' end,
             note = excluded.note, checked_at = now()`,
          [day, gateway, g.gross, g.count, g.fee, report.note],
        );
      }
      // Per-charge fees, when the gateway gave us a reference we can match.
      for (const [ref, fee] of report.fees) {
        await analyticsQuery('update analytics.fact_payments set fee_cents = $2 where gateway = $3 and gateway_reference = $1', [
          ref,
          fee,
          gateway,
        ]);
      }
    }
    return { rows: await this.list(from, to), gateways: outcome };
  }

  private uncheckedReason(gateway: string): string {
    if (gateway === 'stripe') return 'STRIPE_SECRET_KEY is not set.';
    if (gateway === 'mercadopago') return 'MERCADOPAGO_ACCESS_TOKEN is not set.';
    return `No reconciliation source for gateway "${gateway}".`;
  }

  private async fetchGateway(gateway: string, from: string, to: string): Promise<GatewayReport | null> {
    if (gateway === 'stripe') return this.stripe ? this.fetchStripe(from, to) : null;
    if (gateway === 'mercadopago') return this.mercadoPagoToken ? this.fetchMercadoPago(from, to) : null;
    return null;
  }

  /** Gross charges per UTC day from Stripe's balance transactions (charge + payment types). */
  private async fetchStripe(from: string, to: string): Promise<GatewayReport> {
    const stripe = this.stripe!;
    const gte = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
    const lt = Math.floor(Date.parse(`${to}T00:00:00Z`) / 1000) + 86_400;
    const days = new Map<string, GatewayDay>();
    const fees = new Map<string, number>();
    for (const type of ['charge', 'payment'] as const) {
      const list = stripe.balanceTransactions.list({ created: { gte, lt }, type, limit: 100, expand: ['data.source'] });
      for await (const tx of list) {
        const day = utcDay(tx.created);
        const d = days.get(day) ?? { gross: 0, count: 0, fee: 0 };
        d.gross += tx.amount;
        d.count += 1;
        d.fee += tx.fee;
        days.set(day, d);
        const source = tx.source as Stripe.Charge | string | null;
        const pi = source && typeof source === 'object' && 'payment_intent' in source ? source.payment_intent : null;
        const piId = typeof pi === 'string' ? pi : pi?.id;
        if (piId) fees.set(piId, (fees.get(piId) ?? 0) + tx.fee);
      }
    }
    return { days, fees, note: 'Stripe balance transactions (charge, payment), UTC days.' };
  }

  /** Approved payments per day from Mercado Pago's payments search. */
  private async fetchMercadoPago(from: string, to: string): Promise<GatewayReport> {
    const days = new Map<string, GatewayDay>();
    const fees = new Map<string, number>();
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const url = new URL('https://api.mercadopago.com/v1/payments/search');
      url.searchParams.set('range', 'date_approved');
      url.searchParams.set('begin_date', `${from}T00:00:00.000Z`);
      url.searchParams.set('end_date', `${to}T23:59:59.999Z`);
      url.searchParams.set('status', 'approved');
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('offset', String(offset));
      const res = await fetch(url, { headers: { Authorization: `Bearer ${this.mercadoPagoToken}` } });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.error(`Mercado Pago search failed: ${res.status} ${text.slice(0, 200)}`);
        throw new BadRequestException(`Mercado Pago rejected the search (${res.status}).`);
      }
      const json = (await res.json()) as {
        results?: Array<{
          id: number | string;
          date_approved?: string;
          transaction_amount?: number;
          fee_details?: Array<{ amount?: number }>;
        }>;
        paging?: { total?: number };
      };
      const results = json.results ?? [];
      for (const p of results) {
        if (!p.date_approved) continue;
        const day = p.date_approved.slice(0, 10);
        const cents = Math.round((p.transaction_amount ?? 0) * 100);
        const fee = Math.round((p.fee_details ?? []).reduce((a, f) => a + (f.amount ?? 0), 0) * 100);
        const d = days.get(day) ?? { gross: 0, count: 0, fee: 0 };
        d.gross += cents;
        d.count += 1;
        d.fee += fee;
        days.set(day, d);
        fees.set(String(p.id), fee);
      }
      const total = json.paging?.total ?? 0;
      if (results.length < limit || offset + limit >= total) break;
    }
    return { days, fees, note: 'Mercado Pago /v1/payments/search, status=approved, by date_approved.' };
  }
}
