import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { analyticsQuery } from './analytics-db.js';

type Row = Record<string, unknown>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const n = (v: unknown) => Number(v ?? 0);
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export interface SeriesPoint {
  day: string;
  value: number;
}

/**
 * Chart metrics: each is one SQL over the analytics schema returning
 * (day, value) for the range. Whitelisted so the query string never reaches
 * SQL.
 */
const SERIES: Record<string, { label: string; unit: 'count' | 'cents' | 'seconds'; sql: string }> = {
  site_views: {
    label: 'Site views',
    unit: 'count',
    sql: 'select day, sum(views) as value from analytics.fact_site_views_daily where day between $1 and $2 group by 1',
  },
  events_created: {
    label: 'Events created',
    unit: 'count',
    sql: "select day, sum(value) as value from analytics.fact_daily where metric_key = 'events_created' and day between $1 and $2 group by 1",
  },
  events_published: {
    label: 'Events published',
    unit: 'count',
    sql: "select day, sum(value) as value from analytics.fact_daily where metric_key = 'events_published' and day between $1 and $2 group by 1",
  },
  events_paid: {
    label: 'Events paid',
    unit: 'count',
    sql: "select day, sum(value) as value from analytics.fact_daily where metric_key = 'events_paid' and day between $1 and $2 group by 1",
  },
  rsvps: {
    label: 'RSVP answers',
    unit: 'count',
    sql: "select day, sum(count) as value from analytics.fact_rsvps_daily where status <> 'pending' and day between $1 and $2 group by 1",
  },
  gifts: {
    label: 'Gifts reported',
    unit: 'count',
    sql: 'select day, sum(count) as value from analytics.fact_gifts_daily where day between $1 and $2 group by 1',
  },
  gift_amount: {
    label: 'Gift amount (paid)',
    unit: 'cents',
    sql: "select day, sum(amount_cents) as value from analytics.fact_gifts_daily where status = 'paid' and day between $1 and $2 group by 1",
  },
  revenue: {
    label: 'Revenue (succeeded payments)',
    unit: 'cents',
    sql: "select day, sum(amount_cents - refunded_cents) as value from analytics.fact_payments where status in ('succeeded','partially_refunded','refunded') and day between $1 and $2 group by 1",
  },
  refunds: {
    label: 'Refunds',
    unit: 'cents',
    sql: "select day, sum(value) as value from analytics.fact_daily where metric_key = 'refunds_cents' and dims->>'status' = 'succeeded' and day between $1 and $2 group by 1",
  },
  gateway_fees: {
    label: 'Gateway fees',
    unit: 'cents',
    sql: 'select day, sum(fee_cents) as value from analytics.fact_payments where day between $1 and $2 group by 1',
  },
  vendor_leads: {
    label: 'Vendor leads (selections + quotes + chats)',
    unit: 'count',
    sql: 'select day, sum(selections + quotes_requested + conversations) as value from analytics.fact_vendor_leads_daily where day between $1 and $2 group by 1',
  },
  vendor_views: {
    label: 'Vendor listing views',
    unit: 'count',
    sql: 'select day, sum(listing_views) as value from analytics.fact_vendor_leads_daily where day between $1 and $2 group by 1',
  },
  messages_sent: {
    label: 'Messages sent',
    unit: 'count',
    sql: 'select day, sum(sent) as value from analytics.fact_messages_daily where day between $1 and $2 group by 1',
  },
  messages_failed: {
    label: 'Messages failed',
    unit: 'count',
    sql: 'select day, sum(failed) as value from analytics.fact_messages_daily where day between $1 and $2 group by 1',
  },
  chat_messages: {
    label: 'Chat messages',
    unit: 'count',
    sql: 'select day, sum(messages) as value from analytics.fact_chat_daily where day between $1 and $2 group by 1',
  },
  chat_first_response: {
    label: 'Chat first response (avg seconds)',
    unit: 'seconds',
    sql: 'select day, avg(avg_first_response_seconds) as value from analytics.fact_chat_daily where avg_first_response_seconds is not null and day between $1 and $2 group by 1',
  },
  photos: {
    label: 'Photos uploaded',
    unit: 'count',
    sql: "select day, sum(value) as value from analytics.fact_daily where metric_key = 'photos_uploaded' and day between $1 and $2 group by 1",
  },
  orders_gmv: {
    label: 'Vendor order GMV',
    unit: 'cents',
    sql: "select day, sum(value) as value from analytics.fact_daily where metric_key = 'orders_gmv_cents' and day between $1 and $2 group by 1",
  },
};

/** Considered fresh when the last successful ingest window ended within this many hours. */
const HOST_FRESH_HOURS = 30;

/**
 * Operational dashboards (PRD DATA-2/3) read only from the analytics schema,
 * never from `public`, so the numbers here are exactly what was ingested.
 */
@Injectable()
export class AnalyticsService {
  metrics() {
    return Object.entries(SERIES).map(([key, m]) => ({ key, label: m.label, unit: m.unit }));
  }

  range(from?: string, to?: string): { from: string; to: string } {
    const today = new Date().toISOString().slice(0, 10);
    const t = to && DAY.test(to) ? to : today;
    const f = from && DAY.test(from) ? from : new Date(Date.parse(t) - 29 * 86_400_000).toISOString().slice(0, 10);
    if (f > t) throw new BadRequestException('from must not be after to.');
    if ((Date.parse(t) - Date.parse(f)) / 86_400_000 > 400) throw new BadRequestException('Range is limited to 400 days.');
    return { from: f, to: t };
  }

  async series(metric: string, from?: string, to?: string): Promise<{ metric: string; label: string; unit: string; from: string; to: string; points: SeriesPoint[] }> {
    const def = SERIES[metric];
    if (!def) throw new BadRequestException(`Unknown metric. One of: ${Object.keys(SERIES).join(', ')}.`);
    const r = this.range(from, to);
    const rows = await analyticsQuery<Row>(def.sql, [r.from, r.to]);
    const byDay = new Map(rows.map((x) => [String(x.day).slice(0, 10), n(x.value)]));
    // Every day in range, zero-filled from dim_date, so charts have a continuous axis.
    const days = await analyticsQuery<Row>('select day from analytics.dim_date where day between $1 and $2 order by day', [r.from, r.to]);
    const points = days.map((d) => {
      const day = String(d.day).slice(0, 10);
      return { day, value: byDay.get(day) ?? 0 };
    });
    return { metric, label: def.label, unit: def.unit, ...r, points };
  }

  async overview(from?: string, to?: string) {
    const r = this.range(from, to);
    const p = [r.from, r.to];
    const [freshness, funnel, views, rsvps, gifts, payments, vendors, messages, chat, recon, orders, photos] = await Promise.all([
      analyticsQuery<Row>(
        `select id, finished_at, window_to, extract(epoch from (now() - window_to)) / 60 as age_min,
                (select count(*) from analytics.ingest_runs) as runs
           from analytics.ingest_runs where status = 'ok' order by window_to desc limit 1`,
      ),
      analyticsQuery<Row>(
        `select count(*) filter (where created_at::date between $1 and $2) as created,
                count(*) filter (where claimed_at::date between $1 and $2) as claimed,
                count(*) filter (where paid_at::date between $1 and $2) as paid,
                count(*) filter (where published_at::date between $1 and $2) as published,
                count(*) filter (where state = 'live') as live_total,
                count(*) as events_total
           from analytics.dim_event`,
        p,
      ),
      analyticsQuery<Row>('select coalesce(sum(views), 0) as views, count(distinct event_id) as events from analytics.fact_site_views_daily where day between $1 and $2', p),
      analyticsQuery<Row>(
        `select coalesce(sum(count), 0) as total,
                coalesce(sum(count) filter (where status <> 'pending'), 0) as answered,
                coalesce(sum(count) filter (where status = 'attending'), 0) as attending,
                coalesce(sum(count) filter (where status = 'declined'), 0) as declined
           from analytics.fact_rsvps_daily where day between $1 and $2`,
        p,
      ),
      analyticsQuery<Row>(
        `select coalesce(sum(count), 0) as reports,
                coalesce(sum(amount_cents) filter (where status = 'paid'), 0) as paid_cents,
                coalesce(sum(platform_fee_cents) filter (where status = 'paid'), 0) as platform_fee_cents
           from analytics.fact_gifts_daily where day between $1 and $2`,
        p,
      ),
      analyticsQuery<Row>(
        `select gateway, flow,
                count(*) as attempts,
                count(*) filter (where status in ('succeeded','partially_refunded','refunded')) as succeeded,
                count(*) filter (where status = 'failed') as failed,
                coalesce(sum(amount_cents) filter (where status in ('succeeded','partially_refunded','refunded')), 0) as gross_cents,
                coalesce(sum(refunded_cents), 0) as refunded_cents,
                coalesce(sum(fee_cents), 0) as fee_cents
           from analytics.fact_payments where day between $1 and $2
          group by 1, 2 order by 1, 2`,
        p,
      ),
      analyticsQuery<Row>(
        `select coalesce(sum(listing_views), 0) as listing_views, coalesce(sum(selections), 0) as selections,
                coalesce(sum(quotes_requested), 0) as quotes, coalesce(sum(conversations), 0) as conversations,
                (select count(*) from analytics.dim_vendor where status = 'active') as active_vendors
           from analytics.fact_vendor_leads_daily where day between $1 and $2`,
        p,
      ),
      analyticsQuery<Row>(
        `select channel, coalesce(sum(recipients), 0) as recipients, coalesce(sum(sent), 0) as sent,
                coalesce(sum(delivered), 0) as delivered, coalesce(sum(failed), 0) as failed
           from analytics.fact_messages_daily where day between $1 and $2 group by 1 order by 1`,
        p,
      ),
      analyticsQuery<Row>(
        `select kind, coalesce(sum(conversations_started), 0) as started, coalesce(sum(messages), 0) as messages,
                coalesce(sum(responded_conversations), 0) as responded,
                sum(avg_first_response_seconds * responded_conversations) / nullif(sum(responded_conversations), 0) as avg_first_response_seconds
           from analytics.fact_chat_daily where day between $1 and $2 group by 1 order by 1`,
        p,
      ),
      analyticsQuery<Row>(
        `select count(*) filter (where status = 'ok') as ok, count(*) filter (where status = 'mismatch') as mismatch,
                count(*) filter (where status = 'unchecked') as unchecked, max(checked_at) as last_checked_at
           from analytics.revenue_reconciliation where day between $1 and $2`,
        p,
      ),
      analyticsQuery<Row>(
        `select coalesce(sum(value) filter (where metric_key = 'orders_created'), 0) as created,
                coalesce(sum(value) filter (where metric_key = 'orders_fulfilled'), 0) as fulfilled,
                coalesce(sum(value) filter (where metric_key = 'orders_gmv_cents'), 0) as gmv_cents,
                coalesce(sum(value) filter (where metric_key = 'refunds_cents' and dims->>'status' = 'succeeded'), 0) as refunds_cents
           from analytics.fact_daily where day between $1 and $2`,
        p,
      ),
      analyticsQuery<Row>(
        `select coalesce(sum(value), 0) as uploaded, coalesce(sum(value) filter (where dims->>'status' = 'approved'), 0) as approved
           from analytics.fact_daily where metric_key = 'photos_uploaded' and day between $1 and $2`,
        p,
      ),
    ]);

    const fr = freshness[0];
    const f = funnel[0] ?? {};
    const v = views[0] ?? {};
    const rs = rsvps[0] ?? {};
    const g = gifts[0] ?? {};
    const vd = vendors[0] ?? {};
    const rc = recon[0] ?? {};
    const od = orders[0] ?? {};
    const ph = photos[0] ?? {};
    const answered = n(rs.answered);
    const totalRsvps = n(rs.total);
    const msgSent = messages.reduce((a, m) => a + n(m.sent), 0);
    const msgFailed = messages.reduce((a, m) => a + n(m.failed), 0);

    return {
      ...r,
      ingest: {
        hasRun: Boolean(fr),
        lastWindowTo: fr ? String(fr.window_to) : null,
        lastFinishedAt: fr ? String(fr.finished_at) : null,
        freshnessMinutes: fr ? Math.round(n(fr.age_min)) : null,
      },
      events: {
        created: n(f.created),
        claimed: n(f.claimed),
        paid: n(f.paid),
        published: n(f.published),
        liveTotal: n(f.live_total),
        total: n(f.events_total),
        publishRate: n(f.created) ? n(f.published) / n(f.created) : null,
      },
      siteViews: { views: n(v.views), events: n(v.events) },
      rsvps: {
        total: totalRsvps,
        answered,
        attending: n(rs.attending),
        declined: n(rs.declined),
        rate: totalRsvps ? answered / totalRsvps : null,
      },
      gifts: { reports: n(g.reports), paidCents: n(g.paid_cents), platformFeeCents: n(g.platform_fee_cents) },
      revenue: {
        byGateway: payments.map((x) => ({
          gateway: String(x.gateway),
          flow: String(x.flow),
          attempts: n(x.attempts),
          succeeded: n(x.succeeded),
          failed: n(x.failed),
          grossCents: n(x.gross_cents),
          refundedCents: n(x.refunded_cents),
          feeCents: n(x.fee_cents),
        })),
        // LAZO revenue = event fees collected + platform fees on gifts/orders (PAY-2 keeps guest money apart).
        lazoRevenueCents:
          payments.filter((x) => x.flow === 'event_fee').reduce((a, x) => a + n(x.gross_cents) - n(x.refunded_cents), 0) +
          n(g.platform_fee_cents),
        gmvCents: n(g.paid_cents) + n(od.gmv_cents),
        refundsCents: n(od.refunds_cents),
        providerCostCents: payments.reduce((a, x) => a + n(x.fee_cents), 0),
      },
      orders: { created: n(od.created), fulfilled: n(od.fulfilled), gmvCents: n(od.gmv_cents) },
      vendors: {
        activeVendors: n(vd.active_vendors),
        listingViews: n(vd.listing_views),
        selections: n(vd.selections),
        quotes: n(vd.quotes),
        conversations: n(vd.conversations),
        leads: n(vd.selections) + n(vd.quotes) + n(vd.conversations),
      },
      messages: {
        byChannel: messages.map((m) => ({
          channel: String(m.channel),
          recipients: n(m.recipients),
          sent: n(m.sent),
          delivered: n(m.delivered),
          failed: n(m.failed),
        })),
        sent: msgSent,
        failed: msgFailed,
        deliveryRate: msgSent + msgFailed ? msgSent / (msgSent + msgFailed) : null,
      },
      chat: chat.map((c) => ({
        kind: String(c.kind),
        started: n(c.started),
        messages: n(c.messages),
        responded: n(c.responded),
        avgFirstResponseSeconds: nn(c.avg_first_response_seconds),
      })),
      photos: { uploaded: n(ph.uploaded), approved: n(ph.approved) },
      reconciliation: {
        ok: n(rc.ok),
        mismatch: n(rc.mismatch),
        unchecked: n(rc.unchecked),
        lastCheckedAt: rc.last_checked_at ? String(rc.last_checked_at) : null,
      },
    };
  }

  /**
   * Host view of one event's daily numbers, from the warehouse. Only served
   * while the warehouse is fresh; otherwise the host's live per-event stats
   * (GET /api/events/:id/stats) remain the source.
   */
  async eventDaily(eventId: string, from?: string, to?: string) {
    const r = this.range(from, to);
    const fresh = await analyticsQuery<Row>(
      `select window_to, extract(epoch from (now() - window_to)) / 3600 as age_h
         from analytics.ingest_runs where status = 'ok' order by window_to desc limit 1`,
    );
    if (!fresh[0]) throw new ServiceUnavailableException('Analytics have not been ingested yet; use the live event stats.');
    if (n(fresh[0].age_h) > HOST_FRESH_HOURS) {
      throw new ServiceUnavailableException(
        `Analytics are stale (last ingested ${Math.round(n(fresh[0].age_h))} h ago); use the live event stats.`,
      );
    }
    const p = [eventId, r.from, r.to];
    const [views, rsvps, gifts] = await Promise.all([
      analyticsQuery<Row>('select day, views from analytics.fact_site_views_daily where event_id = $1 and day between $2 and $3 order by day', p),
      analyticsQuery<Row>('select day, status, count from analytics.fact_rsvps_daily where event_id = $1 and day between $2 and $3 order by day', p),
      analyticsQuery<Row>(
        'select day, status, count, amount_cents from analytics.fact_gifts_daily where event_id = $1 and day between $2 and $3 order by day',
        p,
      ),
    ]);
    const d = (x: unknown) => String(x).slice(0, 10);
    return {
      ...r,
      asOf: String(fresh[0].window_to),
      siteViews: views.map((x) => ({ day: d(x.day), views: n(x.views) })),
      rsvps: rsvps.map((x) => ({ day: d(x.day), status: String(x.status), count: n(x.count) })),
      gifts: gifts.map((x) => ({ day: d(x.day), status: String(x.status), count: n(x.count), amountCents: n(x.amount_cents) })),
    };
  }
}
