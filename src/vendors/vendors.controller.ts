import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { EventsService } from '../events/events.service.js';
import { AVAILABILITY, DEPARTMENTS, MAX_IMAGE_BYTES, PROMOTION_DAYS, PURCHASE_MODES, SALE_TYPES } from './vendor-common.js';
import type { Row, UploadedImage } from './vendor-common.js';
import { VendorsService } from './vendors.service.js';
import { VendorAdminService } from './vendor-admin.service.js';
import { MarketplaceService } from './marketplace.service.js';
import { LazoProductsService } from './lazo-products.service.js';

const imageUpload = FileInterceptor('image', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });

/** A vendor's own workspace. Signed in; everything is scoped to the caller's profile. */
@Controller('api/vendor')
export class VendorController {
  constructor(private readonly vendors: VendorsService) {}

  @Get('me')
  async me(@CurrentUser('userId') userId: string) {
    return { vendor: await this.vendors.mine(userId) };
  }

  @Post('me')
  create(@CurrentUser('userId') userId: string, @Body() body: Row) {
    return this.vendors.createProfile(userId, body ?? {});
  }

  @Patch('me')
  update(@CurrentUser('userId') userId: string, @Body() body: Row) {
    return this.vendors.updateProfile(userId, body ?? {});
  }

  @Post('me/submit')
  @HttpCode(200)
  submit(@CurrentUser('userId') userId: string) {
    return this.vendors.submit(userId);
  }

  @Post('me/logo')
  @HttpCode(200)
  @UseInterceptors(imageUpload)
  logo(@CurrentUser('userId') userId: string, @UploadedFile() file: UploadedImage | undefined) {
    return this.vendors.uploadLogo(userId, file);
  }

  @Post('media')
  @HttpCode(200)
  @UseInterceptors(imageUpload)
  media(@CurrentUser('userId') userId: string, @UploadedFile() file: UploadedImage | undefined) {
    return this.vendors.uploadMedia(userId, file);
  }

  @Get('products')
  async products(@CurrentUser('userId') userId: string) {
    return { products: await this.vendors.products(userId) };
  }

  @Post('products')
  createProduct(@CurrentUser('userId') userId: string, @Body() body: Row) {
    return this.vendors.saveProduct(userId, null, body ?? {});
  }

  @Patch('products/:id')
  updateProduct(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Row) {
    return this.vendors.saveProduct(userId, id, body ?? {});
  }

  @Delete('products/:id')
  @HttpCode(204)
  removeProduct(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.vendors.removeProduct(userId, id);
  }

  @Get('locations')
  async locations(@CurrentUser('userId') userId: string) {
    return { locations: await this.vendors.locations(userId) };
  }

  @Post('locations')
  createLocation(@CurrentUser('userId') userId: string, @Body() body: Row) {
    return this.vendors.saveLocation(userId, null, body ?? {});
  }

  @Patch('locations/:id')
  updateLocation(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Row) {
    return this.vendors.saveLocation(userId, id, body ?? {});
  }

  @Delete('locations/:id')
  @HttpCode(204)
  removeLocation(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.vendors.removeLocation(userId, id);
  }

  @Get('promotions')
  async promotions(@CurrentUser('userId') userId: string) {
    return { promotions: await this.vendors.promotions(userId) };
  }

  @Post('promotions')
  requestPromotion(@CurrentUser('userId') userId: string, @Body() body: Row) {
    return this.vendors.requestPromotion(userId, body ?? {});
  }

  @Post('promotions/:id/cancel')
  @HttpCode(200)
  cancelPromotion(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.vendors.cancelPromotion(userId, id);
  }

  @Get('stats')
  stats(@CurrentUser('userId') userId: string) {
    return this.vendors.stats(userId);
  }
}

/** The review queue: vendor applications, listings and promotions. */
@Roles('admin')
@Controller('api/admin')
export class VendorAdminController {
  constructor(private readonly admin: VendorAdminService) {}

  @Get('vendors')
  async vendors(@Query('status') status?: string) {
    return { vendors: await this.admin.vendors(status) };
  }

  /** { action: approve | reject | pause | activate, note } — reject needs a note. */
  @Patch('vendors/:id')
  review(@CurrentUser('userId') adminId: string, @Param('id') id: string, @Body() body: Row) {
    return this.admin.reviewVendor(adminId, id, body ?? {});
  }

  @Get('vendor-listings')
  listings(@Query('status') status?: string) {
    return this.admin.listings(status);
  }

  /** { decision: approve | reject, note } */
  @Patch('vendor-listings/:type/:id')
  reviewListing(@Param('type') type: string, @Param('id') id: string, @Body() body: Row) {
    return this.admin.reviewListing(type, id, body ?? {});
  }

  @Get('vendor-promotions')
  async promotions(@Query('status') status?: string) {
    return { promotions: await this.admin.promotions(status) };
  }

  /** { decision: approve | reject | end, note } — approve starts it now. */
  @Patch('vendor-promotions/:id')
  reviewPromotion(@Param('id') id: string, @Body() body: Row) {
    return this.admin.reviewPromotion(id, body ?? {});
  }
}

/** Lazo's own products: affiliate links (details read from the page) or sold at Lazo's price. */
@Roles('admin')
@Controller('api/admin/lazo-products')
export class LazoProductsAdminController {
  constructor(private readonly products: LazoProductsService) {}

  @Get()
  async list() {
    return { products: await this.products.list() };
  }

  /** { url } → name, description, image and price read from that page. Saves nothing. */
  @Post('scrape')
  @HttpCode(200)
  scrape(@Body() body: Row) {
    return this.products.scrape(body ?? {});
  }

  @Post()
  create(@CurrentUser('userId') adminId: string, @Body() body: Row) {
    return this.products.create(adminId, body ?? {});
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Row) {
    return this.products.update(id, body ?? {});
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.products.remove(id);
  }

  @Post(':id/image')
  @HttpCode(200)
  @UseInterceptors(imageUpload)
  image(@Param('id') id: string, @UploadedFile() file: UploadedImage | undefined) {
    return this.products.uploadImage(id, file);
  }

  /** Re-reads an affiliate product's link and updates its price. */
  @Post(':id/refresh')
  @HttpCode(200)
  refresh(@Param('id') id: string) {
    return this.products.refresh(id);
  }
}

/** Hosts browsing vendors and picking them for an event. */
@Controller('api')
export class MarketplaceController {
  constructor(
    private readonly marketplace: MarketplaceService,
    private readonly events: EventsService,
  ) {}

  /** The fixed choice lists behind vendor forms and filters. Public. */
  @Public()
  @PlainPayload()
  @Get('marketplace/options')
  options() {
    return {
      departments: DEPARTMENTS,
      purchaseModes: PURCHASE_MODES,
      availability: AVAILABILITY,
      promotionDays: PROMOTION_DAYS,
      saleTypes: SALE_TYPES,
    };
  }

  @Get('marketplace')
  async search(
    @Query('department') department?: string,
    @Query('city') city?: string,
    @Query('q') q?: string,
    @Query('type') type?: string,
  ) {
    return { listings: await this.marketplace.search({ department, city, q, type }) };
  }

  @Post('marketplace/views')
  @HttpCode(204)
  view(@CurrentUser('userId') userId: string, @Body() body: Row) {
    return this.marketplace.recordView(userId, body ?? {});
  }

  /** A host opened an affiliate product's Buy link. */
  @Post('marketplace/lazo-products/:id/click')
  @HttpCode(204)
  click(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.marketplace.recordClick(userId, id);
  }

  @Get('events/:id/vendor-picks')
  async picks(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    const event = await this.events.findOneFor(userId, id);
    return { picks: await this.marketplace.selections(event.id) };
  }

  @Post('events/:id/vendor-picks')
  @HttpCode(200)
  async pick(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Row) {
    const event = await this.events.findOneFor(userId, id);
    return { picks: await this.marketplace.select(event.id, userId, body ?? {}) };
  }

  @Delete('events/:id/vendor-picks/:pickId')
  async unpick(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('pickId') pickId: string) {
    const event = await this.events.findOneFor(userId, id);
    return { picks: await this.marketplace.unselect(event.id, pickId) };
  }
}
