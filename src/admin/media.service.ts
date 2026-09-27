import { Inject, Injectable, InternalServerErrorException, ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { SITE_MEDIA_BUCKET } from '../home/home.service.js';
import { PHOTO_BUCKET } from '../photos/photos.service.js';
import { EVENT_MEDIA_BUCKET } from '../site-content/site-content.service.js';
import { MEDIA_BUCKET } from '../vendors/vendor-common.js';
import { THEME_BUCKET } from '../website/theme-admin.service.js';

/** Every Storage bucket the API writes images to, with what each one holds. */
export const IMAGE_BUCKETS: ReadonlyArray<{ bucket: string; purpose: string }> = [
  { bucket: THEME_BUCKET, purpose: 'Theme preview cards' },
  { bucket: SITE_MEDIA_BUCKET, purpose: 'Homepage occasion cards' },
  { bucket: MEDIA_BUCKET, purpose: 'Vendor logos and listing photos' },
  { bucket: EVENT_MEDIA_BUCKET, purpose: 'Photos hosts put on their event sites' },
  { bucket: PHOTO_BUCKET, purpose: 'Guest photo uploads' },
];

const PAGE = 1000;

export interface StoredImage {
  bucket: string;
  path: string;
  name: string;
  size: number;
  mimetype: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string;
}

export interface BucketSummary {
  bucket: string;
  purpose: string;
  exists: boolean;
  count: number;
  bytes: number;
}

export interface MediaInventory {
  images: StoredImage[];
  buckets: BucketSummary[];
  totalCount: number;
  totalBytes: number;
}

interface StorageEntry {
  id: string | null;
  name: string;
  created_at?: string | null;
  updated_at?: string | null;
  metadata?: { size?: number; mimetype?: string } | null;
}

/** Admin inventory of everything in Storage: each file, its size, and per-bucket totals. */
@Injectable()
export class MediaService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  async inventory(): Promise<MediaInventory> {
    const { data: existing, error } = await this.db.storage.listBuckets();
    if (error) throw new InternalServerErrorException(`Could not list storage buckets: ${error.message}`);
    const present = new Set((existing ?? []).map((b) => b.name));

    const buckets: BucketSummary[] = [];
    const images: StoredImage[] = [];

    for (const { bucket, purpose } of IMAGE_BUCKETS) {
      const exists = present.has(bucket);
      const files = exists ? await this.walk(bucket, '') : [];
      images.push(...files);
      buckets.push({
        bucket,
        purpose,
        exists,
        count: files.length,
        bytes: files.reduce((sum, f) => sum + f.size, 0),
      });
    }

    images.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

    return {
      images,
      buckets,
      totalCount: images.length,
      totalBytes: images.reduce((sum, f) => sum + f.size, 0),
    };
  }

  /** Lists a folder page by page and descends into subfolders (Storage's list is one level deep). */
  private async walk(bucket: string, prefix: string): Promise<StoredImage[]> {
    const storage = this.db.storage.from(bucket);
    const out: StoredImage[] = [];

    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await storage.list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new InternalServerErrorException(`Could not list ${bucket}/${prefix}: ${error.message}`);
      const entries = (data ?? []) as StorageEntry[];

      for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        // Folders come back without an id or metadata.
        if (entry.id === null || entry.id === undefined) {
          out.push(...(await this.walk(bucket, path)));
          continue;
        }
        if (entry.name === '.emptyFolderPlaceholder') continue;
        out.push({
          bucket,
          path,
          name: entry.name,
          size: Number(entry.metadata?.size ?? 0),
          mimetype: entry.metadata?.mimetype ?? null,
          createdAt: entry.created_at ?? null,
          updatedAt: entry.updated_at ?? null,
          url: storage.getPublicUrl(path).data.publicUrl,
        });
      }

      if (entries.length < PAGE) break;
    }

    return out;
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}
