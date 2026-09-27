import { ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { analyticsConfigured, analyticsQuery, closeAnalyticsPool } from './analytics-db.js';

export interface IngestRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'ok' | 'error';
  rows: number;
  error: string;
  windowFrom: string;
  windowTo: string;
  trigger: string;
}

export interface IngestStatus {
  configured: boolean;
  running: boolean;
  intervalMinutes: number;
  nextRunAt: string | null;
  /** Minutes since the last successful window end; null when nothing has run. */
  freshnessMinutes: number | null;
  lastOk: IngestRun | null;
  recent: IngestRun[];
}

const DEFAULT_INTERVAL_MINUTES = 6 * 60;

type Row = Record<string, unknown>;
const toRun = (r: Row): IngestRun => ({
  id: Number(r.id),
  startedAt: String(r.started_at),
  finishedAt: r.finished_at ? String(r.finished_at) : null,
  status: r.status as IngestRun['status'],
  rows: Number(r.rows ?? 0),
  error: String(r.error ?? ''),
  windowFrom: String(r.window_from),
  windowTo: String(r.window_to),
  trigger: String(r.trigger ?? ''),
});

/**
 * Scheduled ingestion into the analytics schema (PRD DATA-1: at least daily,
 * restartable, deduplicated). The heavy lifting is `analytics.ingest_incremental()`
 * in the migration, so pg_cron and this scheduler are interchangeable; this
 * service adds the timer, an in-process lock and the "run now" button.
 *
 * ANALYTICS_INGEST_INTERVAL_MINUTES: default 360, `0` disables the timer.
 */
@Injectable()
export class AnalyticsIngestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsIngestService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private nextRunAt: Date | null = null;
  readonly intervalMinutes: number;

  constructor() {
    const raw = process.env.ANALYTICS_INGEST_INTERVAL_MINUTES;
    const n = raw === undefined || raw === '' ? DEFAULT_INTERVAL_MINUTES : Number(raw);
    this.intervalMinutes = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_INTERVAL_MINUTES;
  }

  onModuleInit() {
    if (!analyticsConfigured()) {
      this.logger.warn('DATABASE_URL is not set: analytics ingest scheduler disabled, analytics routes answer 503.');
      return;
    }
    if (this.intervalMinutes === 0) {
      this.logger.log('ANALYTICS_INGEST_INTERVAL_MINUTES=0: scheduler disabled (run it with POST /api/admin/analytics/ingest or pg_cron).');
      return;
    }
    const ms = this.intervalMinutes * 60_000;
    // First run shortly after boot so a fresh deploy has data without waiting a full interval.
    const first = Math.min(ms, 60_000);
    this.nextRunAt = new Date(Date.now() + first);
    this.timer = setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), ms);
      this.timer.unref();
    }, first);
    this.timer.unref();
    this.logger.log(`Analytics ingest every ${this.intervalMinutes} min; first run in ${Math.round(first / 1000)} s.`);
  }

  async onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await closeAnalyticsPool();
  }

  private async tick() {
    this.nextRunAt = new Date(Date.now() + this.intervalMinutes * 60_000);
    try {
      const run = await this.runNow('scheduler');
      if (run.status === 'error') this.logger.error(`Scheduled ingest failed: ${run.error}`);
    } catch (err) {
      // Never let the timer die; the next tick retries.
      this.logger.error(`Scheduled ingest could not start: ${(err as Error).message}`);
    }
  }

  get isRunning() {
    return this.running;
  }

  /**
   * Runs one incremental ingest (last successful window end − 1 day → now).
   * Only one run per process at a time; a second caller gets 409.
   */
  async runNow(trigger: 'manual' | 'scheduler' = 'manual'): Promise<IngestRun> {
    if (this.running) throw new ConflictException('An analytics ingest is already running.');
    this.running = true;
    try {
      const rows = await analyticsQuery<Row>('select (analytics.ingest_incremental($1)).*', [trigger]);
      return toRun(rows[0]);
    } finally {
      this.running = false;
    }
  }

  async status(): Promise<IngestStatus> {
    const base: IngestStatus = {
      configured: analyticsConfigured(),
      running: this.running,
      intervalMinutes: this.intervalMinutes,
      nextRunAt: this.nextRunAt?.toISOString() ?? null,
      freshnessMinutes: null,
      lastOk: null,
      recent: [],
    };
    const recent = await analyticsQuery<Row>('select * from analytics.ingest_runs order by started_at desc limit 20');
    base.recent = recent.map(toRun);
    const ok = await analyticsQuery<Row>(
      "select *, extract(epoch from (now() - window_to)) / 60 as age_min from analytics.ingest_runs where status = 'ok' order by window_to desc limit 1",
    );
    if (ok[0]) {
      base.lastOk = toRun(ok[0]);
      base.freshnessMinutes = Math.round(Number(ok[0].age_min));
    }
    return base;
  }
}
