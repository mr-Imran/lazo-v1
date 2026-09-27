import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { EventsService } from '../events/events.service.js';
import { SitesService } from '../sites/sites.service.js';
import { RegistryService } from './registry.service.js';
import { MAX_IMAGE_BYTES, SiteContentService } from './site-content.service.js';
import type { UploadedImage } from './site-content.service.js';

type Body = Record<string, unknown>;

/** Builder steps Story, Gift, Invitation and Go Live. Owner-only. */
@Controller('api/events/:id')
export class SiteContentController {
  constructor(
    private readonly content: SiteContentService,
    private readonly registry: RegistryService,
    private readonly events: EventsService,
  ) {}

  private async own(userId: string, id: string) {
    return (await this.events.findOneFor(userId, id)).id;
  }

  @Get('site-content')
  async get(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.content.get(await this.own(userId, id));
  }

  /** Any of { story, faq, stay, invitation, gifts, cover, travel, agenda, speakers, materials, life, condolences, donations }; each replaces that section. */
  @Patch('site-content')
  async update(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.content.update(await this.own(userId, id), body ?? {});
  }

  /** multipart/form-data, field "image" (JPEG, PNG or WebP, up to 8 MB) → { url }. */
  @Post('media')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  async upload(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @UploadedFile() file: UploadedImage | undefined,
  ) {
    return this.content.upload(await this.own(userId, id), file);
  }

  @Post('publish')
  @HttpCode(200)
  async publish(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.content.publish(await this.own(userId, id));
  }

  @Post('unpublish')
  @HttpCode(200)
  async unpublish(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.content.unpublish(await this.own(userId, id));
  }

  /** { password } to protect the site, { password: null } to open it. */
  @Put('site-password')
  async password(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.content.setPassword(await this.own(userId, id), body ?? {});
  }

  // ---- registry

  @Get('registry')
  async registryList(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.registry.overview(await this.own(userId, id));
  }

  @Post('registry')
  async registryCreate(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.registry.create(await this.own(userId, id), body ?? {});
  }

  @Patch('registry/:itemId')
  async registryUpdate(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: Body,
  ) {
    return this.registry.update(await this.own(userId, id), itemId, body ?? {});
  }

  @Delete('registry/:itemId')
  async registryRemove(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('itemId') itemId: string) {
    return this.registry.remove(await this.own(userId, id), itemId);
  }

  @Patch('gifts/:giftId')
  async thank(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Param('giftId') giftId: string,
    @Body() body: Body,
  ) {
    return this.registry.markThanked(await this.own(userId, id), giftId, body ?? {});
  }
}

/** Public site actions that aren't RSVP: the password gate and gift messages. */
@Controller('api/sites/:slug')
export class PublicSiteActionsController {
  constructor(
    private readonly sites: SitesService,
    private readonly content: SiteContentService,
    private readonly registry: RegistryService,
  ) {}

  /** { password } → { token }, sent back as the X-Site-Token header. */
  @Public()
  @PlainPayload()
  @Post('unlock')
  @HttpCode(200)
  async unlock(@Param('slug') slug: string, @Body() body: Body) {
    const gate = await this.sites.gate(slug);
    if (!gate) throw new NotFoundException({ message: 'No site at this address', reason: 'missing' });
    return this.content.unlock(gate.slug, gate.passwordHash, body?.password);
  }

  /** A guest tells the hosts about a gift they sent or bought. */
  @Public()
  @PlainPayload()
  @Post('gifts')
  @HttpCode(200)
  async gift(@Param('slug') slug: string, @Headers('x-site-token') token: string | undefined, @Body() body: Body) {
    const gate = await this.sites.openGate(slug, token);
    return this.registry.report(gate.eventId, body ?? {});
  }
}
