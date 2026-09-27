import {
  BadRequestException,
  InternalServerErrorException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sniffImageType } from '../common/image-type.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The vendor tables aren't in the hand-written Database type, so these
 * services use an untyped client and map every row explicitly.
 */
export type RawClient = SupabaseClient;
export type Row = Record<string, unknown>;

/** vendors.department, as the backbone migration's check constraint allows. */
export const DEPARTMENTS = [
  'venues', 'planning', 'catering', 'snacks', 'beverages', 'desserts', 'live_music',
  'dj', 'shows', 'print', 'flowers', 'travel', 'retail', 'apparel', 'other',
] as const;
export const PURCHASE_MODES = ['quote', 'catalog', 'fitting', 'fixed_package'] as const;
export const AVAILABILITY = ['unknown', 'on_request', 'confirmed', 'unavailable'] as const;
export const PROMOTION_DAYS = [7, 14, 30] as const;

export const UNDEFINED_TABLE = 'PGRST205';
export const UNDEFINED_COLUMN = '42703';
export const UNIQUE_VIOLATION = '23505';
export const MIGRATION = 'supabase/migrations/20260926000000_vendor_marketplace.sql';
export const LAZO_PRODUCTS_MIGRATION = 'supabase/migrations/20260927000000_lazo_products.sql';
export const SALE_TYPES = ['affiliate', 'direct'] as const;

export function dbError(action: string, error: { code?: string; message: string }, migration = MIGRATION): Error {
  if (error.code === UNDEFINED_TABLE || error.code === UNDEFINED_COLUMN) {
    const what = migration === MIGRATION ? 'Vendor tables are' : 'Lazo product tables are';
    return new ServiceUnavailableException(`${what} missing or out of date. Apply ${migration}.`);
  }
  return new InternalServerErrorException(`${action}: ${error.message}`);
}

// ---------------------------------------------------------------- parsing

export function text(value: unknown, max: number, field: string, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new BadRequestException(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new BadRequestException(`${field} must be text`);
  const out = value.trim();
  if (required && !out) throw new BadRequestException(`${field} is required`);
  if (out.length > max) throw new BadRequestException(`${field} must be at most ${max} characters`);
  return out;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) throw new BadRequestException(`${field} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

export function int(value: unknown, field: string, min = 0, max = 1_000_000): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new BadRequestException(`${field} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

/** Pesos (as entered) to integer centavos (PAY-6). */
export function cents(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100_000_000) {
    throw new BadRequestException(`${field} must be an amount between 0 and 100,000,000`);
  }
  return Math.round(n * 100);
}

export function bool(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null || value === '') return null;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new BadRequestException(`${field} must be true or false`);
}

/** An https URL, or '' to clear. */
export function url(value: unknown, field: string): string {
  const raw = text(value, 500, field);
  if (!raw) return '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BadRequestException(`${field} must be a full https:// address`);
  }
  if (parsed.protocol !== 'https:') throw new BadRequestException(`${field} must use https`);
  return parsed.toString();
}

export function list(value: unknown, field: string, maxItems = 20): string[] {
  if (value === undefined || value === null || value === '') return [];
  const items = Array.isArray(value) ? value : String(value).split(',');
  const out = [...new Set(items.map((v) => String(v).trim()).filter(Boolean))];
  if (out.length > maxItems) throw new BadRequestException(`${field} can list at most ${maxItems} entries`);
  if (out.some((v) => v.length > 80)) throw new BadRequestException(`${field} entries must be at most 80 characters`);
  return out;
}

// ------------------------------------------------------------------ media

export const MEDIA_BUCKET = 'vendor-media';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

let bucketReady: Promise<void> | null = null;

/** Stores an image in the public vendor-media bucket and returns its URL. */
export async function uploadImage(db: RawClient, folder: string, file: UploadedImage | undefined): Promise<string> {
  if (!file) throw new BadRequestException('Send the image as multipart field "image"');
  // The declared type is the client's word; the file's own bytes decide.
  const actualType = sniffImageType(file.buffer);
  const extension = actualType ? IMAGE_TYPES[actualType] : undefined;
  if (!extension) throw new UnsupportedMediaTypeException('Use a JPEG, PNG or WebP image');
  if (file.size > MAX_IMAGE_BYTES) throw new PayloadTooLargeException('Images must be 5 MB or smaller');

  bucketReady ??= (async () => {
    const found = await db.storage.getBucket(MEDIA_BUCKET);
    if (!found.error) return;
    const created = await db.storage.createBucket(MEDIA_BUCKET, {
      public: true,
      fileSizeLimit: MAX_IMAGE_BYTES,
      allowedMimeTypes: Object.keys(IMAGE_TYPES),
    });
    if (created.error && !/already exists/i.test(created.error.message)) {
      throw new InternalServerErrorException(`Could not create the ${MEDIA_BUCKET} bucket: ${created.error.message}`);
    }
  })().catch((error: unknown) => {
    bucketReady = null;
    throw error;
  });
  await bucketReady;

  const path = `${folder}/${randomUUID()}.${extension}`;
  const storage = db.storage.from(MEDIA_BUCKET);
  const uploaded = await storage.upload(path, file.buffer, { contentType: actualType!, cacheControl: '31536000' });
  if (uploaded.error) throw new InternalServerErrorException(`Could not store the image: ${uploaded.error.message}`);

  return storage.getPublicUrl(path).data.publicUrl;
}

// ---------------------------------------------------------------- mapping

const s = (v: unknown) => (typeof v === 'string' ? v : '');
const sn = (v: unknown) => (typeof v === 'string' ? v : null);
const n = (v: unknown) => (typeof v === 'number' ? v : null);

export function toVendor(row: Row) {
  return {
    id: s(row.id),
    ownerId: sn(row.owner_id),
    businessName: s(row.business_name),
    department: s(row.department),
    city: s(row.city),
    serviceArea: Array.isArray(row.service_area) ? (row.service_area as string[]) : [],
    description: s(row.description),
    phone: s(row.phone),
    email: s(row.email),
    website: s(row.website),
    instagram: s(row.instagram),
    logoUrl: s(row.logo_url),
    purchaseMode: s(row.purchase_mode),
    status: s(row.status),
    reviewNote: s(row.review_note),
    submittedAt: sn(row.submitted_at),
    reviewedAt: sn(row.reviewed_at),
    verifiedAt: sn(row.verified_at),
    // Stripe Connect (vendor_orders migration); absent columns read as not set up.
    stripeOnboardingStatus: s(row.stripe_onboarding_status) || 'pending',
    chargesEnabled: row.charges_enabled === true,
    payoutsEnabled: row.payouts_enabled === true,
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at),
  };
}

export function toProduct(row: Row) {
  return {
    id: s(row.id),
    vendorId: s(row.vendor_id),
    name: s(row.name),
    description: s(row.description),
    priceCentavos: n(row.price_cents),
    currency: s(row.currency) || 'MXN',
    capacityMin: n(row.capacity_min),
    capacityMax: n(row.capacity_max),
    availability: s(row.availability),
    imageUrl: s(row.image_url),
    active: row.active !== false,
    reviewStatus: s(row.review_status),
    reviewNote: s(row.review_note),
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at),
  };
}

export function toLocation(row: Row) {
  return {
    id: s(row.id),
    vendorId: s(row.vendor_id),
    name: s(row.name),
    description: s(row.description),
    address: s(row.address),
    city: s(row.city),
    region: s(row.region),
    capacityMin: n(row.capacity_min),
    capacityMax: n(row.capacity_max),
    imageUrl: s(row.image_url),
    active: row.active !== false,
    reviewStatus: s(row.review_status),
    reviewNote: s(row.review_note),
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at),
  };
}

export function toPromotion(row: Row) {
  const status = s(row.status);
  const now = Date.now();
  const ends = sn(row.ends_at);
  const starts = sn(row.starts_at);
  // "live" is derived: approved and inside its window.
  const live = status === 'approved' && !!starts && !!ends && Date.parse(starts) <= now && Date.parse(ends) > now;
  return {
    id: s(row.id),
    vendorId: s(row.vendor_id),
    packageId: sn(row.package_id),
    locationId: sn(row.location_id),
    days: n(row.days) ?? 0,
    message: s(row.message),
    status: status === 'approved' && ends && Date.parse(ends) <= now ? 'ended' : status,
    live,
    startsAt: starts,
    endsAt: ends,
    reviewNote: s(row.review_note),
    createdAt: s(row.created_at),
  };
}

export function toLazoProduct(row: Row) {
  return {
    id: s(row.id),
    saleType: s(row.sale_type) as 'affiliate' | 'direct',
    name: s(row.name),
    description: s(row.description),
    department: s(row.department),
    priceCentavos: n(row.price_cents),
    currency: s(row.currency) || 'MXN',
    imageUrl: s(row.image_url),
    affiliateUrl: s(row.affiliate_url),
    sourceUrl: s(row.source_url),
    sourceSite: s(row.source_site),
    scrapedAt: sn(row.scraped_at),
    featured: row.featured === true,
    active: row.active !== false,
    position: n(row.position) ?? 0,
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at),
  };
}

export type Vendor = ReturnType<typeof toVendor>;
export type Product = ReturnType<typeof toProduct>;
export type VendorLocation = ReturnType<typeof toLocation>;
export type Promotion = ReturnType<typeof toPromotion>;
export type LazoProduct = ReturnType<typeof toLazoProduct>;
