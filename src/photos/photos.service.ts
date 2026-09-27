import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sniffImageType } from '../common/image-type.js';
import { stripMetadata } from '../common/strip-metadata.js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { TIERS_MIGRATION } from '../payments/payments.service.js';

export const PHOTO_BUCKET = 'event-photos';
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_PHOTOS = 2000;
const MAX_PENDING_PHOTOS = 200;
const UNDEFINED_COLUMN = '42703';
const UUID = /^[0-9a-f-]{36}$/i;

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

export interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

export interface Photo {
  id: string;
  url: string;
  caption: string;
  uploader: string;
  source: string;
  status: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

/**
 * The event gallery. Hosts upload (approved at once) and moderate; guests
 * upload from the site or the QR code (pending until the host approves,
 * PHOTO-2). Location metadata is stripped before storage (PHOTO-1).
 */
@Injectable()
export class PhotosService {
  private bucketReady: Promise<void> | null = null;

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  /** Host view: every photo that isn't deleted, plus the gallery setting. */
  async overview(eventId: string) {
    const [photos, event] = await Promise.all([
      this.db.from('photos').select('*').eq('event_id', eventId).neq('status', 'deleted').order('created_at', { ascending: false }),
      this.db.from('events').select('gallery_open').eq('id', eventId).single(),
    ]);
    if (photos.error) throw this.fail('Could not load photos', photos.error);
    if (event.error) throw this.fail('Could not load the gallery', event.error);
    const list = (photos.data as Row[]).map(toPhoto);
    return {
      open: (event.data as Row).gallery_open !== false,
      photos: list,
      pending: list.filter((p) => p.status === 'pending').length,
    };
  }

  /** Approved photos for the public site, newest first. */
  async publicList(eventId: string): Promise<Photo[]> {
    const { data, error } = await this.db
      .from('photos')
      .select('*')
      .eq('event_id', eventId)
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) throw this.fail('Could not load the gallery', error);
    return (data as Row[]).map(toPhoto);
  }

  async upload(eventId: string, file: UploadedImage | undefined, input: Row, who: 'host' | 'guest', moderatedBy: string | null) {
    if (!file) throw new BadRequestException('Send the photo as multipart field "photo"');
    const type = sniffImageType(file.buffer);
    const ext = type ? IMAGE_TYPES[type] : undefined;
    if (!ext) throw new UnsupportedMediaTypeException('Use a JPEG, PNG or WebP photo');
    if (file.size > MAX_PHOTO_BYTES) throw new PayloadTooLargeException('Photos must be 12 MB or smaller');

    const { count, error: countError } = await this.db.from('photos').select('id', { count: 'exact', head: true }).eq('event_id', eventId).neq('status', 'deleted');
    if (countError) throw this.fail('Could not count photos', countError);
    if ((count ?? 0) >= MAX_PHOTOS) throw new BadRequestException('This gallery is full');

    if (who === 'guest') {
      // Unmoderated uploads are storage nobody asked for: the host approves or
      // rejects the queue before guests can add more.
      const { count: pending } = await this.db.from('photos').select('id', { count: 'exact', head: true }).eq('event_id', eventId).eq('status', 'pending');
      if ((pending ?? 0) >= MAX_PENDING_PHOTOS) {
        throw new HttpException(
          { statusCode: 429, error: 'Too Many Requests', message: 'The hosts have many photos waiting for review. Please try again later.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const { data: ev } = await this.db.from('events').select('gallery_open').eq('id', eventId).single();
      if ((ev as Row | null)?.gallery_open === false) throw new ForbiddenException('The hosts have closed photo uploads.');
    }

    const cleaned = stripMetadata(file.buffer, type!);
    await this.ensureBucket();
    const path = `${eventId}/${randomUUID()}.${ext}`;
    const storage = this.db.storage.from(PHOTO_BUCKET);
    const up = await storage.upload(path, cleaned.buffer, { contentType: type!, cacheControl: '31536000' });
    if (up.error) throw new InternalServerErrorException(`Could not store the photo: ${up.error.message}`);

    const { error } = await this.db.from('photos').insert({
      event_id: eventId,
      storage_path: path,
      public_url: storage.getPublicUrl(path).data.publicUrl,
      content_type: type,
      bytes: cleaned.buffer.length,
      status: who === 'host' ? 'approved' : 'pending',
      moderated_by: who === 'host' ? moderatedBy : null,
      moderated_at: who === 'host' ? new Date().toISOString() : null,
      exif_stripped: cleaned.stripped,
      caption: s(input.caption).trim().slice(0, 200),
      uploader: s(input.uploader).trim().slice(0, 120),
      source: who,
      width: cleaned.width,
      height: cleaned.height,
    });
    if (error) throw this.fail('Could not save the photo', error);
    return { ok: true };
  }

  /** { status: approved | rejected | deleted, caption? } */
  async moderate(eventId: string, photoId: string, input: Row, by: string) {
    if (!UUID.test(photoId)) throw new NotFoundException('No such photo');
    const patch: Row = {};
    if (input.status !== undefined) {
      if (!['approved', 'rejected', 'deleted'].includes(s(input.status))) throw new BadRequestException('status must be approved, rejected or deleted');
      Object.assign(patch, { status: input.status, moderated_by: by, moderated_at: new Date().toISOString() });
    }
    if (input.caption !== undefined) patch.caption = s(input.caption).trim().slice(0, 200);
    if (!Object.keys(patch).length) throw new BadRequestException('Nothing to update');

    const { data, error } = await this.db.from('photos').update(patch).eq('id', photoId).eq('event_id', eventId).select('storage_path');
    if (error) throw this.fail('Could not update the photo', error);
    if (!data?.length) throw new NotFoundException('No such photo');
    if (patch.status === 'deleted') {
      await this.db.storage.from(PHOTO_BUCKET).remove([s((data[0] as Row).storage_path)]);
    }
    return this.overview(eventId);
  }

  /** { open: boolean } — whether guests can upload. */
  async setOpen(eventId: string, input: Row) {
    if (typeof input.open !== 'boolean') throw new BadRequestException('open must be true or false');
    const { error } = await this.db.from('events').update({ gallery_open: input.open }).eq('id', eventId);
    if (error) throw this.fail('Could not save', error);
    return this.overview(eventId);
  }

  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      const found = await this.db.storage.getBucket(PHOTO_BUCKET);
      if (!found.error) return;
      const created = await this.db.storage.createBucket(PHOTO_BUCKET, {
        public: true,
        fileSizeLimit: MAX_PHOTO_BYTES,
        allowedMimeTypes: Object.keys(IMAGE_TYPES),
      });
      if (created.error && !/already exists/i.test(created.error.message)) {
        throw new InternalServerErrorException(`Could not create the ${PHOTO_BUCKET} bucket: ${created.error.message}`);
      }
    })().catch((error: unknown) => {
      this.bucketReady = null;
      throw error;
    });
    return this.bucketReady;
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_COLUMN) return new ServiceUnavailableException(`Photo tables are out of date. Apply ${TIERS_MIGRATION}.`);
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

function toPhoto(r: Row): Photo {
  return {
    id: s(r.id),
    url: s(r.public_url),
    caption: s(r.caption),
    uploader: s(r.uploader),
    source: s(r.source) || 'guest',
    status: s(r.status),
    width: typeof r.width === 'number' ? r.width : null,
    height: typeof r.height === 'number' ? r.height : null,
    createdAt: s(r.created_at),
  };
}
