import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { EventsService } from '../events/events.service.js';
import { AnalyticsService } from './analytics.service.js';
import { AnalyticsIngestService } from './analytics-ingest.service.js';
import { AnalyticsReconcileService } from './analytics-reconcile.service.js';
import { analyticsConfigured } from './analytics-db.js';

/**
 * Operational dashboards over the analytics warehouse (/dashboard#analytics).
 * Every route answers 503 naming DATABASE_URL when the direct connection is
 * missing, and naming the migration when the schema is not applied yet.
 */
@Roles('admin')
@Controller('api/admin/analytics')
export class AnalyticsAdminController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly ingest: AnalyticsIngestService,
    private readonly reconcile: AnalyticsReconcileService,
  ) {}

  @Get('config')
  config() {
    return {
      configured: analyticsConfigured(),
      intervalMinutes: this.ingest.intervalMinutes,
      gateways: this.reconcile.config(),
      metrics: this.analytics.metrics(),
    };
  }

  @Get('overview')
  overview(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.overview(from, to);
  }

  @Get('series')
  series(@Query('metric') metric: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.series(metric ?? '', from, to);
  }

  @Get('ingest')
  ingestStatus() {
    return this.ingest.status();
  }

  /** Runs one incremental ingest now. 409 while another run is in progress. */
  @Post('ingest')
  @HttpCode(200)
  runIngest() {
    return this.ingest.runNow('manual');
  }

  @Get('reconciliation')
  reconciliation(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reconcile.list(from, to);
  }

  /** { from, to } as YYYY-MM-DD, at most 92 days. */
  @Post('reconcile')
  @HttpCode(200)
  runReconcile(@Body() body: { from?: string; to?: string }) {
    return this.reconcile.reconcile(body?.from ?? '', body?.to ?? '');
  }
}

/** Host-facing: an event's daily numbers from the warehouse, when fresh. Owner-only. */
@Controller('api/events/:id/analytics')
export class EventAnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly events: EventsService,
  ) {}

  @Get('daily')
  async daily(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const event = await this.events.findOneFor(userId, id);
    return this.analytics.eventDaily(event.id, from, to);
  }
}
