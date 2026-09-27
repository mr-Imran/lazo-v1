import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { EventsService } from '../events/events.service.js';
import { SitesService } from '../sites/sites.service.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { MAX_PHOTO_BYTES, PhotosService } from '../photos/photos.service.js';
import type { UploadedImage } from '../photos/photos.service.js';
import { SeatingService } from '../seating/seating.service.js';
import { ConciergeService, FLOWER_PRODUCTS, PRINT_PRODUCTS, TRAVEL_PRODUCTS } from '../concierge/concierge.service.js';

type Body = Record<string, unknown>;

/** Messaging, photos, seating and concierge for one event. Owner-only. */
@Controller('api/events/:id')
export class EventFeaturesController {
  constructor(
    private readonly events: EventsService,
    private readonly messaging: MessagingService,
    private readonly photos: PhotosService,
    private readonly seating: SeatingService,
    private readonly concierge: ConciergeService,
  ) {}

  private own(userId: string, id: string) {
    return this.events.findOneFor(userId, id);
  }

  // ---- messages

  @Get('messages')
  async messages(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.messaging.list(await this.own(userId, id));
  }

  @Get('messages/preview')
  async preview(@CurrentUser('userId') userId: string, @Param('id') id: string, @Query('channel') channel: string, @Query('audience') audience: string) {
    return this.messaging.preview(await this.own(userId, id), channel, audience);
  }

  /** { channel, audience, subject?, body } */
  @Post('messages')
  async send(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.messaging.send(await this.own(userId, id), body ?? {});
  }

  // ---- photos

  @Get('photos')
  async photoList(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.photos.overview((await this.own(userId, id)).id);
  }

  /** multipart "photo" (+ caption). Host uploads are approved at once. */
  @Post('photos')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } }))
  async photoUpload(@CurrentUser('userId') userId: string, @Param('id') id: string, @UploadedFile() file: UploadedImage | undefined, @Body() body: Body) {
    const event = await this.own(userId, id);
    await this.photos.upload(event.id, file, body ?? {}, 'host', userId);
    return this.photos.overview(event.id);
  }

  @Patch('photos/:photoId')
  async photoModerate(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('photoId') photoId: string, @Body() body: Body) {
    return this.photos.moderate((await this.own(userId, id)).id, photoId, body ?? {}, userId);
  }

  @Patch('gallery')
  async gallery(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.photos.setOpen((await this.own(userId, id)).id, body ?? {});
  }

  // ---- seating

  @Get('sub-events/:subId/seating')
  async seatingView(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('subId') subId: string) {
    return this.seating.overview((await this.own(userId, id)).id, subId);
  }

  @Post('sub-events/:subId/seating/tables')
  async tableCreate(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('subId') subId: string, @Body() body: Body) {
    return this.seating.createTable((await this.own(userId, id)).id, subId, body ?? {});
  }

  @Patch('sub-events/:subId/seating/tables/:tableId')
  async tableUpdate(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('subId') subId: string, @Param('tableId') tableId: string, @Body() body: Body) {
    return this.seating.updateTable((await this.own(userId, id)).id, subId, tableId, body ?? {});
  }

  @Delete('sub-events/:subId/seating/tables/:tableId')
  async tableRemove(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('subId') subId: string, @Param('tableId') tableId: string) {
    return this.seating.removeTable((await this.own(userId, id)).id, subId, tableId);
  }

  /** { guestId, tableId | null } */
  @Put('sub-events/:subId/seating')
  async seat(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('subId') subId: string, @Body() body: Body) {
    return this.seating.seat((await this.own(userId, id)).id, subId, body ?? {});
  }

  @Post('sub-events/:subId/seating/auto')
  @HttpCode(200)
  async autoSeat(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('subId') subId: string) {
    return this.seating.autoSeat((await this.own(userId, id)).id, subId);
  }

  // ---- concierge (print, travel, custom domain)

  @Get('concierge')
  async conciergeList(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return { ...(await this.concierge.list(await this.own(userId, id))), printProducts: PRINT_PRODUCTS, flowerProducts: FLOWER_PRODUCTS, travelProducts: TRAVEL_PRODUCTS };
  }

  @Post('concierge')
  async conciergeCreate(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.concierge.create(await this.own(userId, id), body ?? {});
  }

  @Post('concierge/:requestId/cancel')
  @HttpCode(200)
  async conciergeCancel(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('requestId') requestId: string) {
    return this.concierge.cancel(await this.own(userId, id), requestId);
  }
}

/** Guest-facing gallery on a public site. */
@Controller('api/sites/:slug/photos')
export class PublicPhotosController {
  constructor(
    private readonly sites: SitesService,
    private readonly photos: PhotosService,
  ) {}

  @Public()
  @PlainPayload()
  @Get()
  async list(@Param('slug') slug: string, @Headers('x-site-token') token: string | undefined) {
    const gate = await this.sites.openGate(slug, token);
    return { photos: await this.photos.publicList(gate.eventId) };
  }

  /** multipart "photo" (+ uploader, caption). Pending until the host approves. */
  @Public()
  @PlainPayload()
  @Post()
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } }))
  async upload(@Param('slug') slug: string, @Headers('x-site-token') token: string | undefined, @UploadedFile() file: UploadedImage | undefined, @Body() body: Body) {
    const gate = await this.sites.openGate(slug, token);
    return this.photos.upload(gate.eventId, file, body ?? {}, 'guest', null);
  }
}

@Roles('admin')
@Controller('api/admin/concierge')
export class ConciergeAdminController {
  constructor(private readonly concierge: ConciergeService) {}

  @Get()
  list() {
    return this.concierge.adminList();
  }

  @Patch(':requestId')
  update(@Param('requestId') requestId: string, @Body() body: Body) {
    return this.concierge.adminUpdate(requestId, body ?? {});
  }
}

/** Which providers are set up, so the UI can say what works. Public: booleans only. */
@Controller('api/messaging')
export class MessagingConfigController {
  constructor(private readonly messaging: MessagingService) {}

  @Public()
  @PlainPayload()
  @Get('config')
  config() {
    return this.messaging.config();
  }
}
