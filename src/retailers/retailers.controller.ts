import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { EventsService } from '../events/events.service.js';
import { SitesService } from '../sites/sites.service.js';
import { RetailersService } from './retailers.service.js';

type Body = Record<string, unknown>;

/** Which stores can be searched, and searching them. Any signed-in user. */
@Controller('api/retailers')
export class RetailersController {
  constructor(private readonly retailers: RetailersService) {}

  @Get()
  async list() {
    return { retailers: await this.retailers.list() };
  }

  @Get(':key/search')
  search(@Param('key') key: string, @Query('q') q: string | undefined) {
    return this.retailers.search(key, q);
  }
}

/** Retailer-backed registry items for one event. Owner-only. */
@Controller('api/events/:id/registry')
export class EventRegistryRetailerController {
  constructor(
    private readonly events: EventsService,
    private readonly retailers: RetailersService,
  ) {}

  private async own(userId: string, id: string) {
    return (await this.events.findOneFor(userId, id)).id;
  }

  /** { retailer, externalId } from a search result → the registry overview. */
  @Post('from-retailer')
  async fromRetailer(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.retailers.addToRegistry(await this.own(userId, id), body ?? {});
  }

  @Post('refresh-availability')
  @HttpCode(200)
  async refresh(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.retailers.refreshAvailability(await this.own(userId, id));
  }

  @Get('clicks')
  async clicks(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return { clicks: await this.retailers.clickCounts(await this.own(userId, id)) };
  }
}

/**
 * The guest purchase flow (purchase_redirect): the public site links here,
 * the click is counted, and the guest is sent to the store's affiliate URL.
 * A private site's token may come as a query param since this is a plain link.
 */
@Controller('api/sites/:slug/registry')
export class PublicRegistryClickController {
  constructor(
    private readonly sites: SitesService,
    private readonly retailers: RetailersService,
  ) {}

  @Public()
  @PlainPayload()
  @Get(':itemId/go')
  async go(
    @Param('slug') slug: string,
    @Param('itemId') itemId: string,
    @Headers('x-site-token') headerToken: string | undefined,
    @Headers('referer') referer: string | undefined,
    @Query('t') queryToken: string | undefined,
    @Res() res: Response,
  ) {
    const gate = await this.sites.openGate(slug, headerToken || queryToken);
    const url = await this.retailers.click(gate.eventId, itemId, referer);
    res.redirect(302, url);
  }
}
