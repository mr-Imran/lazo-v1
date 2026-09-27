import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import {
  DEPARTMENTS,
  LAZO_PRODUCTS_MIGRATION,
  SALE_TYPES,
  bool,
  cents,
  dbError,
  int,
  oneOf,
  text,
  toLazoProduct,
  uploadImage,
  url,
} from './vendor-common.js';
import type { LazoProduct, RawClient, Row, UploadedImage } from './vendor-common.js';
import { scrapeProduct } from './product-scraper.js';

const fail = (action: string, error: { code?: string; message: string }) => dbError(action, error, LAZO_PRODUCTS_MIGRATION);

/** An http(s) link, as affiliate networks still hand out some http ones. */
function link(value: unknown, field: string): string {
  const raw = text(value, 2000, field);
  if (!raw) return '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BadRequestException(`${field} must be a full https:// address`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException(`${field} must start with https://`);
  }
  return parsed.toString();
}

function currency(value: unknown): string {
  const code = text(value, 3, 'currency').toUpperCase() || 'MXN';
  if (!/^[A-Z]{3}$/.test(code)) throw new BadRequestException('currency must be a three-letter code like MXN');
  return code;
}

/**
 * Products the Lazo team lists itself, from the admin dashboard: affiliate
 * links to other stores (details read from the linked page) or products Lazo
 * sells at its own price. Admin-only; hosts read them through the marketplace.
 */
@Injectable()
export class LazoProductsService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
  ) {}

  /** Every product, with how many events picked it and affiliate clicks. */
  async list() {
    const [products, picks, clicks] = await Promise.all([
      this.db.from('lazo_products').select('*').order('position').order('created_at', { ascending: false }),
      this.db.from('lazo_product_picks').select('product_id'),
      this.db.from('lazo_product_clicks').select('product_id'),
    ]);
    for (const r of [products, picks, clicks]) {
      if (r.error) throw fail('Could not load Lazo products', r.error);
    }
    const count = (rows: Row[] | null, id: string) => (rows ?? []).filter((r) => r.product_id === id).length;
    return (products.data ?? []).map((row) => {
      const p = toLazoProduct(row);
      return { ...p, picks: count(picks.data, p.id), clicks: count(clicks.data, p.id) };
    });
  }

  /** Reads a product link without saving anything; the admin reviews it first. */
  scrape(input: Row) {
    return scrapeProduct(input.url);
  }

  async create(adminId: string, input: Row): Promise<LazoProduct> {
    const row = this.parse(input, null);
    const { data, error } = await this.db
      .from('lazo_products')
      .insert({ ...row, created_by: adminId })
      .select('*')
      .single();
    if (error) throw fail('Could not add the product', error);
    return toLazoProduct(data);
  }

  async update(id: string, input: Row): Promise<LazoProduct> {
    const current = await this.find(id);
    const patch = this.parse(input, current);
    const { data, error } = await this.db
      .from('lazo_products')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw fail('Could not save the product', error);
    return toLazoProduct(data);
  }

  async remove(id: string): Promise<void> {
    const { data, error } = await this.db.from('lazo_products').delete().eq('id', id).select('id');
    if (error) throw fail('Could not delete the product', error);
    if (!data?.length) throw new NotFoundException('No such product');
  }

  async uploadImage(id: string, file: UploadedImage | undefined): Promise<LazoProduct> {
    await this.find(id);
    const imageUrl = await uploadImage(this.db, 'lazo-products', file);
    return this.update(id, { imageUrl });
  }

  /**
   * Re-reads an affiliate product's page and updates its price (and its image
   * if it has none). The name and description stay as the admin left them.
   */
  async refresh(id: string): Promise<{ product: LazoProduct; found: string[] }> {
    const current = await this.find(id);
    if (current.saleType !== 'affiliate') throw new BadRequestException('Only affiliate products are read from a link');

    const scraped = await scrapeProduct(current.affiliateUrl);
    const patch: Row = {
      source_url: scraped.finalUrl.slice(0, 2000),
      source_site: scraped.site.slice(0, 120),
      scraped_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (scraped.priceCentavos !== null) {
      patch.price_cents = scraped.priceCentavos;
      patch.currency = scraped.currency ?? current.currency;
    }
    if (!current.imageUrl && scraped.imageUrl) patch.image_url = scraped.imageUrl;

    const { data, error } = await this.db.from('lazo_products').update(patch).eq('id', id).select('*').single();
    if (error) throw fail('Could not save the product', error);
    return { product: toLazoProduct(data), found: scraped.found };
  }

  /** Validates input against the product it will become (current + changes). */
  private parse(input: Row, current: LazoProduct | null): Row {
    const has = (key: string) => input[key] !== undefined;
    const row: Row = {};

    if (!current || has('saleType')) row.sale_type = oneOf(input.saleType, SALE_TYPES, 'saleType');
    if (!current || has('name')) row.name = text(input.name, 200, 'name', true);
    if (has('description')) row.description = text(input.description, 4000, 'description');
    if (has('department')) row.department = oneOf(input.department, DEPARTMENTS, 'department');
    if (has('price')) row.price_cents = cents(input.price, 'price');
    if (has('priceCentavos')) row.price_cents = int(input.priceCentavos, 'priceCentavos', 0, 10_000_000_000);
    if (has('currency')) row.currency = currency(input.currency);
    if (has('imageUrl')) row.image_url = url(input.imageUrl, 'imageUrl');
    if (has('affiliateUrl')) row.affiliate_url = link(input.affiliateUrl, 'affiliateUrl');
    if (has('sourceUrl')) row.source_url = link(input.sourceUrl, 'sourceUrl');
    if (has('sourceSite')) row.source_site = text(input.sourceSite, 120, 'sourceSite');
    if (has('scraped')) row.scraped_at = input.scraped ? new Date().toISOString() : null;
    for (const key of ['featured', 'active'] as const) {
      if (has(key)) {
        const value = bool(input[key], key);
        if (value !== null) row[key] = value;
      }
    }
    if (has('position')) row.position = int(input.position, 'position', 0, 100_000) ?? 0;

    const saleType = (row.sale_type ?? current?.saleType) as string;
    const affiliateUrl = (row.affiliate_url ?? current?.affiliateUrl ?? '') as string;
    const price = 'price_cents' in row ? row.price_cents : (current?.priceCentavos ?? null);
    if (saleType === 'affiliate' && !affiliateUrl) throw new BadRequestException('An affiliate product needs its link');
    if (saleType === 'direct' && price === null) throw new BadRequestException('A direct product needs a price');
    // A store name without a link means nothing on a direct product.
    if (saleType === 'direct' && row.sale_type) Object.assign(row, { affiliate_url: '', source_url: '', source_site: '' });

    return row;
  }

  private async find(id: string): Promise<LazoProduct> {
    const { data, error } = await this.db.from('lazo_products').select('*').eq('id', id).maybeSingle();
    if (error) throw fail('Could not load the product', error);
    if (!data) throw new NotFoundException('No such product');
    return toLazoProduct(data);
  }

  private get db(): RawClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as RawClient;
  }
}
