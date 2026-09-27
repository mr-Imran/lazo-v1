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
import type { SupabaseClient } from '@supabase/supabase-js';
import { sniffImageType } from '../common/image-type.js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';

export const MIGRATION = 'supabase/migrations/20260928000000_homepage.sql';
/** Public bucket for homepage imagery (occasion cards); created on first upload. */
export const SITE_MEDIA_BUCKET = 'site-media';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const UNDEFINED_TABLE = 'PGRST205';
const UNDEFINED_COLUMN = '42703';
const UNIQUE_VIOLATION = '23505';
const FEATURED_VENDORS = 4;
// Deliberately simple: one @, something on each side, a dot in the domain.
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

export interface FeaturedVendor {
  id: string;
  businessName: string;
  department: string;
  city: string;
  logoUrl: string;
}

export interface AdminEventMode {
  value: string;
  label: string;
  description: string;
  imageUrl: string;
  position: number;
  active: boolean;
}

export interface Subscriber {
  id: string;
  email: string;
  source: string;
  createdAt: string;
  unsubscribedAt: string | null;
}

export interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/** Data behind the public homepage, plus the admin side of it. */
@Injectable()
export class HomeService {
  private bucketReady: Promise<void> | null = null;

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  // ------------------------------------------------------------ public

  /**
   * A few approved vendors for "Find and book the best vendors". Only public
   * profile fields; contact details stay behind the signed-in marketplace.
   */
  async featuredVendors(): Promise<FeaturedVendor[]> {
    const { data, error } = await this.db
      .from('vendors')
      .select('id, business_name, department, city, logo_url, reviewed_at')
      .eq('status', 'active')
      .order('reviewed_at', { ascending: false, nullsFirst: false })
      .limit(FEATURED_VENDORS);

    // Before the vendor migration there simply are no public vendors yet.
    if (error?.code === UNDEFINED_TABLE || error?.code === UNDEFINED_COLUMN) return [];
    if (error) throw new InternalServerErrorException(`Could not load vendors: ${error.message}`);

    return (data as Row[]).map((row) => ({
      id: s(row.id),
      businessName: s(row.business_name),
      department: s(row.department),
      city: s(row.city),
      logoUrl: s(row.logo_url),
    }));
  }

  /** The public vendor directory: active vendors with their approved listings, no contact details. */
  async directory(filters: { department?: string; city?: string; q?: string }) {
    let query = this.db.from('vendors').select('*').eq('status', 'active').order('business_name');
    if (filters.department && /^[a-z_]{1,30}$/.test(filters.department)) query = query.eq('department', filters.department);
    const { data, error } = await query.limit(500);
    if (error?.code === UNDEFINED_TABLE || error?.code === UNDEFINED_COLUMN) return { vendors: [] };
    if (error) throw new InternalServerErrorException(`Could not load vendors: ${error.message}`);
    const vendors = (data as Row[]).filter((v) => {
      const city = s(v.city).toLowerCase();
      const q = (filters.q ?? '').trim().toLowerCase();
      if (filters.city && !city.includes(filters.city.trim().toLowerCase())) return false;
      if (q && !`${s(v.business_name)} ${s(v.description)} ${city}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const ids = vendors.map((v) => s(v.id));
    const counts = new Map<string, { locations: number; products: number }>();
    if (ids.length) {
      const [locations, products] = await Promise.all([
        this.db.from('vendor_locations').select('vendor_id').in('vendor_id', ids).eq('review_status', 'approved').eq('active', true),
        this.db.from('vendor_packages').select('vendor_id').in('vendor_id', ids).eq('review_status', 'approved').eq('active', true),
      ]);
      for (const r of (locations.data as Row[] | null) ?? []) counts.set(s(r.vendor_id), { ...(counts.get(s(r.vendor_id)) ?? { locations: 0, products: 0 }), locations: (counts.get(s(r.vendor_id))?.locations ?? 0) + 1 });
      for (const r of (products.data as Row[] | null) ?? []) counts.set(s(r.vendor_id), { ...(counts.get(s(r.vendor_id)) ?? { locations: 0, products: 0 }), products: (counts.get(s(r.vendor_id))?.products ?? 0) + 1 });
    }
    return {
      vendors: vendors.map((v) => ({
        id: s(v.id),
        businessName: s(v.business_name),
        department: s(v.department),
        city: s(v.city),
        serviceArea: Array.isArray(v.service_area) ? (v.service_area as string[]) : [],
        description: s(v.description).slice(0, 400),
        logoUrl: s(v.logo_url),
        website: s(v.website),
        instagram: s(v.instagram),
        locations: counts.get(s(v.id))?.locations ?? 0,
        products: counts.get(s(v.id))?.products ?? 0,
      })),
    };
  }

  /** Footer sign-up. Signing up twice is not an error, and doesn't say whether the address was known. */
  async subscribe(body: Row): Promise<void> {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email.length > 254 || !EMAIL.test(email)) throw new BadRequestException('Enter a valid email address');

    const { error } = await this.db.from('newsletter_subscribers').insert({ email, source: 'homepage' });

    if (!error || error.code === UNIQUE_VIOLATION) return;
    throw this.dbError('Could not save the sign-up', error);
  }

  // ------------------------------------------------------------ admin

  async subscribers(): Promise<Subscriber[]> {
    const { data, error } = await this.db
      .from('newsletter_subscribers')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) throw this.dbError('Could not load subscribers', error);

    return (data as Row[]).map((row) => ({
      id: s(row.id),
      email: s(row.email),
      source: s(row.source),
      createdAt: s(row.created_at),
      unsubscribedAt: (row.unsubscribed_at as string | null) ?? null,
    }));
  }

  /** Every occasion, inactive ones included, in display order. */
  async eventModes(): Promise<AdminEventMode[]> {
    const { data, error } = await this.db
      .from('event_modes')
      .select('*')
      .order('position', { ascending: true })
      .order('value', { ascending: true });

    if (error) throw this.dbError('Could not load occasions', error);
    return (data as Row[]).map(toAdminMode);
  }

  /** label, description, position, active. Values and form fields are not editable here. */
  async updateEventMode(value: string, body: Row): Promise<AdminEventMode> {
    await this.findMode(value);
    const patch: Row = {};

    if (body.label !== undefined) {
      const label = String(body.label).trim();
      if (label.length < 1 || label.length > 60) throw new BadRequestException('Label must be 1–60 characters');
      patch.label = label;
    }
    if (body.description !== undefined) {
      const description = String(body.description).trim();
      if (description.length > 200) throw new BadRequestException('Description must be 200 characters or fewer');
      patch.description = description;
    }
    if (body.position !== undefined) {
      const position = Number(body.position);
      if (!Number.isInteger(position) || Math.abs(position) > 100000) throw new BadRequestException('Position must be a whole number');
      patch.position = position;
    }
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new BadRequestException('active must be true or false');
      patch.active = body.active;
    }
    if (Object.keys(patch).length === 0) throw new BadRequestException('Nothing to update');

    return this.writeMode(value, patch);
  }

  async uploadEventModeImage(value: string, file: UploadedImage | undefined): Promise<AdminEventMode> {
    if (!file) throw new BadRequestException('Send the image as multipart field "image"');

    const actualType = sniffImageType(file.buffer);
    const extension = actualType ? IMAGE_TYPES[actualType] : undefined;
    if (!extension) throw new UnsupportedMediaTypeException('Use a JPEG, PNG or WebP image');
    if (file.size > MAX_IMAGE_BYTES) throw new PayloadTooLargeException('Images must be 5 MB or smaller');

    const mode = await this.findMode(value);
    await this.ensureBucket();

    const path = `occasions/${mode.value}/${randomUUID()}.${extension}`;
    const storage = this.db.storage.from(SITE_MEDIA_BUCKET);
    const uploaded = await storage.upload(path, file.buffer, { contentType: actualType!, cacheControl: '31536000' });
    if (uploaded.error) throw new InternalServerErrorException(`Could not store the image: ${uploaded.error.message}`);

    const saved = await this.writeMode(mode.value, { image_url: storage.getPublicUrl(path).data.publicUrl });
    await this.removeStoredImage(mode.imageUrl);
    return saved;
  }

  // ------------------------------------------------------------ internals

  private async findMode(value: string): Promise<AdminEventMode> {
    if (!/^[a-z0-9_]{1,40}$/.test(value)) throw new NotFoundException(`No occasion ${value}`);

    const { data, error } = await this.db.from('event_modes').select('*').eq('value', value).maybeSingle();
    if (error) throw this.dbError('Could not load the occasion', error);
    if (!data) throw new NotFoundException(`No occasion ${value}`);
    return toAdminMode(data as Row);
  }

  private async writeMode(value: string, patch: Row): Promise<AdminEventMode> {
    const { data, error } = await this.db.from('event_modes').update(patch).eq('value', value).select('*').single();
    if (error) throw this.dbError('Could not save the occasion', error);
    return toAdminMode(data as Row);
  }

  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      const found = await this.db.storage.getBucket(SITE_MEDIA_BUCKET);
      if (!found.error) return;

      const created = await this.db.storage.createBucket(SITE_MEDIA_BUCKET, {
        public: true,
        fileSizeLimit: MAX_IMAGE_BYTES,
        allowedMimeTypes: Object.keys(IMAGE_TYPES),
      });
      if (created.error && !/already exists/i.test(created.error.message)) {
        throw new InternalServerErrorException(`Could not create the ${SITE_MEDIA_BUCKET} bucket: ${created.error.message}`);
      }
    })().catch((error: unknown) => {
      this.bucketReady = null;
      throw error;
    });
    return this.bucketReady;
  }

  private async removeStoredImage(url: string): Promise<void> {
    const marker = `/storage/v1/object/public/${SITE_MEDIA_BUCKET}/`;
    const at = url.indexOf(marker);
    if (at === -1) return;
    await this.db.storage.from(SITE_MEDIA_BUCKET).remove([decodeURIComponent(url.slice(at + marker.length))]);
  }

  private dbError(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_TABLE || error.code === UNDEFINED_COLUMN) {
      return new ServiceUnavailableException(`Homepage tables are missing or out of date. Apply ${MIGRATION}.`);
    }
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  // event_modes is typed, but its homepage columns and the other tables here
  // are not in the generated types; this service reads them as plain rows.
  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

function toAdminMode(row: Row): AdminEventMode {
  return {
    value: s(row.value),
    label: s(row.label),
    description: s(row.description),
    imageUrl: s(row.image_url),
    position: Number(row.position ?? 0),
    active: row.active !== false,
  };
}
