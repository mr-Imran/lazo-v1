import { Controller, Get } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator.js';
import { MediaService } from './media.service.js';
import type { MediaInventory } from './media.service.js';

/** Storage inventory for the admin dashboard's Images section. */
@Roles('admin')
@Controller('api/admin')
export class MediaAdminController {
  constructor(private readonly media: MediaService) {}

  /** Every image in every Storage bucket, with size, type, date and public URL, plus per-bucket totals. */
  @Get('media')
  inventory(): Promise<MediaInventory> {
    return this.media.inventory();
  }
}
