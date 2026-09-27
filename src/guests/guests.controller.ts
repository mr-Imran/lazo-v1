import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { EventsService } from '../events/events.service.js';
import { GuestsService } from './guests.service.js';

type Body = Record<string, unknown>;

/** The host's guest list. Every route checks the event belongs to the caller. */
@Controller('api/events/:id')
export class GuestsController {
  constructor(
    private readonly guests: GuestsService,
    private readonly events: EventsService,
  ) {}

  @Get('guests')
  async overview(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.guests.overview(await this.events.findOneFor(userId, id));
  }

  @Get('guests/export')
  async export(@CurrentUser('userId') userId: string, @Param('id') id: string, @Res() res: Response) {
    const event = await this.events.findOneFor(userId, id);
    const csv = await this.guests.exportCsv(event);
    res
      .status(200)
      .type('text/csv; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="guests-${event.id}.csv"`)
      .send(csv);
  }

  @Post('households')
  async create(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.guests.createHousehold(await this.events.findOneFor(userId, id), body ?? {});
  }

  /** { csv } — see GuestsService.importCsv for the columns. */
  @Post('households/import')
  @HttpCode(200)
  async import(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.guests.importCsv(await this.events.findOneFor(userId, id), body?.csv);
  }

  @Patch('households/:hid')
  async update(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Param('hid') hid: string,
    @Body() body: Body,
  ) {
    return this.guests.updateHousehold(await this.events.findOneFor(userId, id), hid, body ?? {});
  }

  @Delete('households/:hid')
  async remove(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('hid') hid: string) {
    return this.guests.removeHousehold(await this.events.findOneFor(userId, id), hid);
  }

  /** { deadline?, open? } */
  @Patch('rsvp-settings')
  async settings(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.guests.updateSettings(await this.events.findOneFor(userId, id), body ?? {});
  }

  /** Host-entered answer: { guestId, subEventId, status }. */
  @Put('rsvps')
  async answer(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.guests.setAnswer(await this.events.findOneFor(userId, id), body ?? {});
  }
}

/**
 * RSVP on a public site. No session: the invitation code is the key, and a
 * guest only ever sees their own household. Rate-limited in http-hardening.
 */
@Controller('api/sites/:slug/rsvp')
export class RsvpController {
  constructor(private readonly guests: GuestsService) {}

  /** { code } or { name } → the household's guests, celebrations and answers. */
  @Public()
  @PlainPayload()
  @Post('find')
  @HttpCode(200)
  find(@Param('slug') slug: string, @Headers('x-site-token') token: string | undefined, @Body() body: Body) {
    return this.guests.find(slug, body ?? {}, token);
  }

  @Public()
  @PlainPayload()
  @Post()
  @HttpCode(200)
  submit(@Param('slug') slug: string, @Headers('x-site-token') token: string | undefined, @Body() body: Body) {
    return this.guests.submit(slug, body ?? {}, token);
  }
}
