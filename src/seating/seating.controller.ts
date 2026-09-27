import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { EventsService } from '../events/events.service.js';
import { SeatingService } from './seating.service.js';

/**
 * Seating exports. The per-celebration editing routes live in
 * src/features/features.controller.ts; this one only adds the CSV.
 */
@Controller('api/events/:id/seating')
export class SeatingExportController {
  constructor(
    private readonly events: EventsService,
    private readonly seating: SeatingService,
  ) {}

  /** ?event=<subEventId> for one celebration; otherwise every celebration, one block each. */
  @Get('export.csv')
  async exportCsv(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Query('event') subEventId: string | undefined,
    @Res() res: Response,
  ) {
    const event = await this.events.findOneFor(userId, id);
    const csv = await this.seating.exportCsv(event.id, subEventId || null);
    res
      .status(200)
      .type('text/csv; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="seating-${event.id}.csv"`)
      .send(csv);
  }
}
