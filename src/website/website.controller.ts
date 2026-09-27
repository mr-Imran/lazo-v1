import { Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { EventsService } from '../events/events.service.js';
import { WebsiteService } from './website.service.js';
import type { CustomThemeRequest, Service, Theme } from './website.service.js';

@Controller('api')
export class WebsiteController {
  constructor(
    private readonly website: WebsiteService,
    private readonly events: EventsService,
  ) {}

  /** The theme catalog. Public: it is what the product offers, not user data. */
  @Public()
  @PlainPayload()
  @Get('themes')
  async themes(@Query('mode') mode?: string): Promise<{ themes: Theme[] }> {
    return { themes: await this.website.listThemes(mode) };
  }

  /** A priced service, e.g. custom_theme. Public for the same reason. */
  @Public()
  @PlainPayload()
  @Get('services/:key')
  service(@Param('key') key: string): Promise<Service> {
    return this.website.getService(key);
  }

  @Get('events/:id/custom-request')
  async openRequest(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<CustomThemeRequest> {
    const event = await this.events.findOneFor(userId, id);
    const request = await this.website.findOpenRequest(event.id);

    if (!request) throw new NotFoundException('No open custom-theme request for this event');

    return request;
  }

  @Post('events/:id/custom-request')
  @HttpCode(200)
  async requestCustom(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<CustomThemeRequest> {
    // Scoped by owner first, so nobody can open a request on another's event.
    const event = await this.events.findOneFor(userId, id);

    return this.website.requestCustomTheme(userId, event.id);
  }
}
