import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sniffImageType } from '../common/image-type.js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import type { ThemeInsert, ThemeRow } from '../supabase/database.types.js';

/** Public Supabase Storage bucket for theme card images; created on first upload. */
export const THEME_BUCKET = 'theme-previews';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const UNDEFINED_TABLE = 'PGRST205';
const UNIQUE_VIOLATION = '23505';
const MIGRATION = 'supabase/migrations/20260925000000_website_builder.sql';
const SLUG = /^[a-z0-9-]+$/;

/** A theme as the admin sees it: every column, inactive rows included. */
export interface AdminTheme {
  id: string;
  slug: string;
  name: string;
  description: string;
  previewUrl: string;
  modes: string[];
  position: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ThemeInput {
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  previewUrl?: unknown;
  modes?: unknown;
  position?: unknown;
  active?: unknown;
}

/** The parts of a multer file this service reads. */
export interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/**
 * Admin CRUD for the theme catalog, plus preview-image upload to Supabase
 * Storage. Reachable only through @Roles('admin') routes.
 */
@Injectable()
export class ThemeAdminService {
  private bucketReady: Promise<void> | null = null;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
  ) {}

  async list(): Promise<AdminTheme[]> {
    const { data, error } = await this.db
      .from('themes')
      .select('*')
      .order('position', { ascending: true })
      .order('name', { ascending: true });

    if (error) throw this.dbError('Could not load themes', error);

    return data.map(toAdminTheme);
  }

  /**
   * A theme needs a name and an image. The image can come later through the
   * upload route, so a missing previewUrl is allowed here and the theme is
   * kept inactive (hidden from hosts) until it has one.
   */
  async create(input: ThemeInput): Promise<AdminTheme> {
    const name = this.text(input.name, 80, 'name', true);
    const previewUrl = this.url(input.previewUrl);
    const row: ThemeInsert = {
      name,
      slug: this.slug(input.slug) ?? slugify(name),
      description: this.text(input.description, 200, 'description'),
      preview_url: previewUrl ?? '',
      modes: await this.modes(input.modes),
      position: this.int(input.position, 'position') ?? 0,
      active: previewUrl ? (this.bool(input.active, 'active') ?? true) : false,
    };

    const { data, error } = await this.db.from('themes').insert(row).select('*').single();

    if (error) throw this.dbError('Could not create the theme', error);

    return toAdminTheme(data);
  }

  async update(id: string, input: ThemeInput): Promise<AdminTheme> {
    const current = await this.find(id);
    const patch: Partial<ThemeInsert> = {};

    if (input.name !== undefined) patch.name = this.text(input.name, 80, 'name', true);
    if (input.slug !== undefined) {
      patch.slug = this.slug(input.slug) ?? slugify(patch.name ?? current.name);
    }
    if (input.description !== undefined) {
      patch.description = this.text(input.description, 200, 'description');
    }
    if (input.previewUrl !== undefined) patch.preview_url = this.url(input.previewUrl) ?? '';
    if (input.modes !== undefined) patch.modes = await this.modes(input.modes);
    if (input.position !== undefined) patch.position = this.int(input.position, 'position') ?? 0;
    if (input.active !== undefined) patch.active = this.bool(input.active, 'active') ?? true;

    if (Object.keys(patch).length === 0) throw new BadRequestException('Nothing to update');

    const image = patch.preview_url ?? current.previewUrl;
    if ((patch.active ?? current.active) && !image) {
      throw new BadRequestException('Add a preview image before making the theme active');
    }

    return this.write(id, patch);
  }

  /** Stores the image in Storage and points the theme at it. */
  async uploadImage(id: string, file: UploadedImage | undefined): Promise<AdminTheme> {
    if (!file) throw new BadRequestException('Send the image as multipart field "image"');

    // The declared type is the client's word; the file's own bytes decide.
    const actualType = sniffImageType(file.buffer);
    const extension = actualType ? IMAGE_TYPES[actualType] : undefined;
    if (!extension) throw new UnsupportedMediaTypeException('Use a JPEG, PNG or WebP image');
    if (file.size > MAX_IMAGE_BYTES) throw new PayloadTooLargeException('Images must be 5 MB or smaller');

    const theme = await this.find(id);
    await this.ensureBucket();

    // A fresh name per upload, so browsers and CDNs never show a stale image.
    const path = `${theme.id}/${randomUUID()}.${extension}`;
    const storage = this.db.storage.from(THEME_BUCKET);
    const uploaded = await storage.upload(path, file.buffer, {
      contentType: actualType!,
      cacheControl: '31536000',
    });

    if (uploaded.error) {
      throw new InternalServerErrorException(`Could not store the image: ${uploaded.error.message}`);
    }

    const previewUrl = storage.getPublicUrl(path).data.publicUrl;
    const saved = await this.write(id, { preview_url: previewUrl });
    await this.removeStoredImage(theme.previewUrl);

    return saved;
  }

  async remove(id: string): Promise<void> {
    const theme = await this.find(id);
    // Events that picked this theme keep their row; theme_id becomes null.
    const { error } = await this.db.from('themes').delete().eq('id', theme.id);

    if (error) throw this.dbError('Could not delete the theme', error);

    await this.removeStoredImage(theme.previewUrl);
  }

  // ------------------------------------------------------------ internals

  private async find(id: string): Promise<AdminTheme> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException(`No theme ${id}`);

    const { data, error } = await this.db.from('themes').select('*').eq('id', id).maybeSingle();

    if (error) throw this.dbError('Could not load the theme', error);
    if (!data) throw new NotFoundException(`No theme ${id}`);

    return toAdminTheme(data);
  }

  private async write(id: string, patch: Partial<ThemeInsert>): Promise<AdminTheme> {
    const { data, error } = await this.db
      .from('themes')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw this.dbError('Could not save the theme', error);

    return toAdminTheme(data);
  }

  /** Creates the public bucket once per process if it isn't there yet. */
  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      const found = await this.db.storage.getBucket(THEME_BUCKET);
      if (!found.error) return;

      const created = await this.db.storage.createBucket(THEME_BUCKET, {
        public: true,
        fileSizeLimit: MAX_IMAGE_BYTES,
        allowedMimeTypes: Object.keys(IMAGE_TYPES),
      });

      if (created.error && !/already exists/i.test(created.error.message)) {
        throw new InternalServerErrorException(
          `Could not create the ${THEME_BUCKET} bucket: ${created.error.message}`,
        );
      }
    })().catch((error: unknown) => {
      this.bucketReady = null;
      throw error;
    });

    return this.bucketReady;
  }

  /** Best effort: deletes an image this service stored earlier; ignores other URLs. */
  private async removeStoredImage(url: string): Promise<void> {
    const marker = `/storage/v1/object/public/${THEME_BUCKET}/`;
    const at = url.indexOf(marker);
    if (at === -1) return;

    await this.db.storage.from(THEME_BUCKET).remove([decodeURIComponent(url.slice(at + marker.length))]);
  }

  /** Each value must be an event_modes.value; [] means every occasion. */
  private async modes(value: unknown): Promise<string[]> {
    if (value === undefined || value === null || value === '') return [];

    const list = Array.isArray(value) ? value : String(value).split(',');
    const modes = [...new Set(list.map((m) => String(m).trim()).filter(Boolean))];
    if (modes.length === 0) return [];

    const { data, error } = await this.db.from('event_modes').select('value').in('value', modes);
    if (error) throw this.dbError('Could not check the occasions', error);

    const known = new Set(data.map((row) => row.value));
    const unknown = modes.filter((m) => !known.has(m));
    if (unknown.length) throw new BadRequestException(`Unknown occasion: ${unknown.join(', ')}`);

    return modes;
  }

  private text(value: unknown, max: number, field: string, required = false): string {
    if (value === undefined || value === null) {
      if (required) throw new BadRequestException(`${field} is required`);
      return '';
    }
    if (typeof value !== 'string') throw new BadRequestException(`${field} must be a string`);

    const text = value.trim();
    if (required && !text) throw new BadRequestException(`${field} is required`);
    if (text.length > max) throw new BadRequestException(`${field} must be at most ${max} characters`);

    return text;
  }

  private slug(value: unknown): string | null {
    const slug = this.text(value, 80, 'slug').toLowerCase();
    if (!slug) return null;
    if (!SLUG.test(slug)) {
      throw new BadRequestException('slug may use only lowercase letters, numbers and hyphens');
    }
    return slug;
  }

  private url(value: unknown): string | null {
    const url = this.text(value, 1000, 'previewUrl');
    if (!url) return null;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('previewUrl must be a full https URL');
    }
    if (parsed.protocol !== 'https:') throw new BadRequestException('previewUrl must use https');

    return parsed.toString();
  }

  private int(value: unknown, field: string): number | null {
    if (value === undefined || value === null || value === '') return null;

    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 100_000) {
      throw new BadRequestException(`${field} must be a whole number between 0 and 100000`);
    }
    return n;
  }

  private bool(value: unknown, field: string): boolean | null {
    if (value === undefined || value === null || value === '') return null;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    throw new BadRequestException(`${field} must be true or false`);
  }

  private dbError(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_TABLE) {
      return new ServiceUnavailableException(`The themes table is missing. Apply ${MIGRATION}.`);
    }
    if (error.code === UNIQUE_VIOLATION) {
      return new BadRequestException('Another theme already uses that slug');
    }
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): LazoSupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase;
  }
}

function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  if (!slug) throw new BadRequestException('Give the theme a slug (letters, numbers, hyphens)');
  return slug;
}

function toAdminTheme(row: ThemeRow): AdminTheme {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    previewUrl: row.preview_url,
    modes: row.modes,
    position: row.position,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
