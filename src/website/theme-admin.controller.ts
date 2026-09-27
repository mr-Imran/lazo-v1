import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '../auth/roles.decorator.js';
import { MAX_IMAGE_BYTES, ThemeAdminService } from './theme-admin.service.js';
import type { AdminTheme, ThemeInput, UploadedImage } from './theme-admin.service.js';

/**
 * Theme catalog management. Admin-only, like the rest of /api/admin: the
 * global ClerkAuthGuard identifies the caller and RolesGuard checks the role.
 */
@Roles('admin')
@Controller('api/admin/themes')
export class ThemeAdminController {
  constructor(private readonly themes: ThemeAdminService) {}

  /** Every theme, inactive ones included, in display order. */
  @Get()
  async list(): Promise<{ themes: AdminTheme[] }> {
    return { themes: await this.themes.list() };
  }

  /** JSON body. Without a previewUrl the theme starts inactive until an image is uploaded. */
  @Post()
  create(@Body() body: ThemeInput): Promise<AdminTheme> {
    return this.themes.create(body ?? {});
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: ThemeInput): Promise<AdminTheme> {
    return this.themes.update(id, body ?? {});
  }

  /**
   * multipart/form-data with the file in field "image" (JPEG, PNG or WebP,
   * up to 5 MB). Stored in the public theme-previews bucket.
   */
  @Post(':id/image')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  uploadImage(
    @Param('id') id: string,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<AdminTheme> {
    return this.themes.uploadImage(id, file);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): Promise<void> {
    return this.themes.remove(id);
  }
}
