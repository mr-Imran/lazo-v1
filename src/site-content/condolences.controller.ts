import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { EventsService } from '../events/events.service.js';
import { SitesService } from '../sites/sites.service.js';
import { CondolencesService } from './condolences.service.js';

type Body = Record<string, unknown>;

/** Host moderation of remembrance messages (memorial mode). Owner-only. */
@Controller('api/events/:id/condolences')
export class CondolencesController {
  constructor(
    private readonly condolences: CondolencesService,
    private readonly events: EventsService,
  ) {}

  private async own(userId: string, id: string) {
    return (await this.events.findOneFor(userId, id)).id;
  }

  @Get()
  async list(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.condolences.overview(await this.own(userId, id));
  }

  /** { approved: true | false } */
  @Patch(':condolenceId')
  async moderate(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Param('condolenceId') condolenceId: string,
    @Body() body: Body,
  ) {
    return this.condolences.moderate(await this.own(userId, id), condolenceId, body ?? {});
  }

  @Delete(':condolenceId')
  async remove(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('condolenceId') condolenceId: string) {
    return this.condolences.remove(await this.own(userId, id), condolenceId);
  }
}

/** Guest side, on the public site. Behind the site's password gate like everything else. */
@Controller('api/sites/:slug/condolences')
export class PublicCondolencesController {
  constructor(
    private readonly sites: SitesService,
    private readonly condolences: CondolencesService,
  ) {}

  @Public()
  @PlainPayload()
  @Get()
  async list(@Param('slug') slug: string, @Headers('x-site-token') token: string | undefined) {
    const gate = await this.sites.openGate(slug, token);
    return { condolences: await this.condolences.publicList(gate.eventId) };
  }

  /** { name?, message } → pending until the family approves it. */
  @Public()
  @PlainPayload()
  @Post()
  @HttpCode(200)
  async submit(@Param('slug') slug: string, @Headers('x-site-token') token: string | undefined, @Body() body: Body) {
    const gate = await this.sites.openGate(slug, token);
    return this.condolences.submit(gate.eventId, body ?? {});
  }
}
