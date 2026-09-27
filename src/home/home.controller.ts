import {
  Body,
  Controller,
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
import { Public } from '../auth/public.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { HomeService, MAX_IMAGE_BYTES } from './home.service.js';
import type { UploadedImage } from './home.service.js';

/** Public data for the marketing homepage. */
@Controller('api')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  /** A few approved vendors (name, category, city, logo). */
  @Public()
  @PlainPayload()
  @Get('home/vendors')
  async vendors() {
    return { vendors: await this.home.featuredVendors() };
  }

  /** The vendor directory page. */
  @Public()
  @PlainPayload()
  @Get('vendors/directory')
  directory(@Query('department') department?: string, @Query('city') city?: string, @Query('q') q?: string) {
    return this.home.directory({ department, city, q });
  }

  /** Footer newsletter sign-up: { email }. 204 whether or not it was already on the list. */
  @Public()
  @PlainPayload()
  @Post('newsletter')
  @HttpCode(204)
  subscribe(@Body() body: Record<string, unknown>): Promise<void> {
    return this.home.subscribe(body ?? {});
  }
}

/** The homepage's admin side: occasion cards and newsletter sign-ups. */
@Roles('admin')
@Controller('api/admin')
export class HomeAdminController {
  constructor(private readonly home: HomeService) {}

  @Get('newsletter')
  async subscribers() {
    return { subscribers: await this.home.subscribers() };
  }

  @Get('event-modes')
  async eventModes() {
    return { modes: await this.home.eventModes() };
  }

  /** { label?, description?, position?, active? } */
  @Patch('event-modes/:value')
  updateEventMode(@Param('value') value: string, @Body() body: Record<string, unknown>) {
    return this.home.updateEventMode(value, body ?? {});
  }

  /** multipart/form-data, file in field "image" (JPEG, PNG or WebP, up to 5 MB). */
  @Post('event-modes/:value/image')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  uploadEventModeImage(@Param('value') value: string, @UploadedFile() file: UploadedImage | undefined) {
    return this.home.uploadEventModeImage(value, file);
  }
}
