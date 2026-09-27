import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { RegistryService } from '../site-content/registry.service.js';
import { AmazonPaapiAdapter } from './amazon-paapi.adapter.js';
import { MercadoLibreAdapter } from './mercadolibre.adapter.js';
import type { RetailerAdapter, RetailerProduct } from './retailer-adapter.js';

export const RETAILERS_MIGRATION = 'supabase/migrations/20261011000000_retailers_fulfilment.sql';
const SEARCH_CACHE_MS = 60_000;
const SEARCH_CACHE_MAX = 500;
const REFRESH_MIN_MS = 60 * 60_000;
const UNDEFINED_TABLE = 'PGRST205';
const UNDEFINED_COLUMN = '42703';
const UUID = /^[0-9a-f-]{36}$/i;
const MAX_ITEMS = 200;

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

export interface RetailerInfo {
  key: string;
  name: string;
  adapter: string;
  country: string;
  enabled: boolean;
  /** Env vars present, so search will work. */
  configured: boolean;
  /** Env vars still missing. */
  missingEnv: string[];
  supports: Record<string, boolean>;
  syncedAt: string | null;
}

/**
 * Store catalogs for the registry (PRD MODE-2): search a retailer, add a
 * result as a registry item that remembers its store id, re-check price and
 * stock later, and send guests through an affiliate link that is counted.
 * Adapters are built from the `retailers` table; credentials are env only.
 */
@Injectable()
export class RetailersService {
  private readonly logger = new Logger(RetailersService.name);
  private readonly searchCache = new Map<string, { results: RetailerProduct[]; expiresAt: number }>();
  /** One adapter per retailer key, kept so Mercado Libre's token cache survives between calls. */
  private readonly adapters = new Map<string, { adapter: RetailerAdapter; tag: string }>();

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
    private readonly registry: RegistryService,
  ) {}

  async list(): Promise<RetailerInfo[]> {
    const rows = await this.rows();
    return rows.map((r) => {
      const adapter = this.adapterFor(r);
      return {
        key: s(r.key),
        name: s(r.name),
        adapter: s(r.adapter),
        country: s(r.country),
        enabled: r.enabled === true,
        configured: adapter?.configured() ?? false,
        missingEnv: adapter?.missingEnv() ?? [],
        supports: (r.supports as Record<string, boolean>) ?? {},
        syncedAt: typeof r.synced_at === 'string' ? r.synced_at : null,
      };
    });
  }

  async search(key: string, query: unknown) {
    const q = s(query).trim();
    if (q.length < 2) throw new BadRequestException('Type at least 2 characters');
    if (q.length > 120) throw new BadRequestException('Search must be 120 characters or fewer');
    const { row, adapter } = await this.enabled(key);
    // Every retailer call costs quota (PA-API is metered); the same query
    // typed twice in a minute is answered from memory.
    const cacheKey = `${s(row.key)}\u0000${q.toLowerCase()}`;
    const hit = this.searchCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return { retailer: s(row.key), query: q, results: hit.results, cached: true };
    const results = await adapter.search(q, { limit: 10 });
    this.searchCache.set(cacheKey, { results, expiresAt: Date.now() + SEARCH_CACHE_MS });
    if (this.searchCache.size > SEARCH_CACHE_MAX) {
      for (const [k, v] of this.searchCache) if (v.expiresAt <= Date.now()) this.searchCache.delete(k);
      if (this.searchCache.size > SEARCH_CACHE_MAX) this.searchCache.delete(this.searchCache.keys().next().value!);
    }
    await this.db.from('retailers').update({ synced_at: new Date().toISOString() }).eq('key', s(row.key));
    return { retailer: s(row.key), query: q, results, cached: false };
  }

  /** Adds a normalised result as a registry item (kind retailer_api). */
  async addToRegistry(eventId: string, input: Row) {
    const key = s(input.retailer);
    const externalId = s(input.externalId).trim();
    if (!externalId || externalId.length > 60) throw new BadRequestException('Pick a product from the search results');
    const { row, adapter } = await this.enabled(key);

    // Re-read the item from the store rather than trusting the client (INT-3).
    const [fresh] = await adapter.getItems([externalId]);
    if (!fresh) throw new NotFoundException('The store no longer lists that product');
    if (!/^https:\/\//.test(fresh.url)) throw new BadRequestException('The store returned no product link');

    const { count, error: countErr } = await this.db.from('registry_items').select('id', { count: 'exact', head: true }).eq('event_id', eventId);
    if (countErr) throw this.fail('Could not count registry items', countErr);
    if ((count ?? 0) >= MAX_ITEMS) throw new BadRequestException(`Up to ${MAX_ITEMS} registry items`);
    const { data: last } = await this.db.from('registry_items').select('position').eq('event_id', eventId).order('position', { ascending: false }).limit(1);
    const position = ((last as Row[] | null)?.[0]?.position as number | undefined) ?? -1;

    const { error } = await this.db.from('registry_items').insert({
      event_id: eventId,
      kind: 'retailer_api',
      title: (fresh.title || s(input.title) || 'Gift').slice(0, 200),
      description: fresh.attribution,
      image_url: /^https:\/\//.test(fresh.imageUrl) ? fresh.imageUrl : '',
      external_url: fresh.url,
      external_id: fresh.externalId,
      retailer_key: s(row.key),
      price_cents: fresh.priceCentavos,
      currency: fresh.currency,
      available: fresh.available,
      price_checked_at: new Date().toISOString(),
      position: Math.min(999, position + 1),
    });
    if (error) throw this.fail('Could not add the gift', error);
    return this.registry.overview(eventId);
  }

  /** Re-checks price and stock for every retailer-backed item of an event. */
  async refreshAvailability(eventId: string) {
    const { data, error } = await this.db.from('registry_items').select('id, retailer_key, external_id, price_checked_at').eq('event_id', eventId).not('retailer_key', 'is', null);
    if (error) throw this.fail('Could not load the registry', error);
    // One refresh per hour per event: each item is a metered store lookup.
    const freshest = Math.max(0, ...(data as Row[]).map((r) => (s(r.price_checked_at) ? Date.parse(s(r.price_checked_at)) : 0)));
    if (freshest && Date.now() - freshest < REFRESH_MIN_MS) {
      const minutes = Math.ceil((REFRESH_MIN_MS - (Date.now() - freshest)) / 60_000);
      throw new HttpException(
        { statusCode: 429, error: 'Too Many Requests', message: `Prices were checked less than an hour ago. Try again in ${minutes} min.` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const byRetailer = new Map<string, Row[]>();
    for (const r of data as Row[]) {
      if (!s(r.external_id)) continue;
      const list = byRetailer.get(s(r.retailer_key)) ?? [];
      list.push(r);
      byRetailer.set(s(r.retailer_key), list);
    }
    const checked = new Date().toISOString();
    const problems: string[] = [];
    let updated = 0;
    for (const [key, items] of byRetailer) {
      let fresh: RetailerProduct[];
      try {
        fresh = await (await this.enabled(key)).adapter.availability(items.map((i) => s(i.external_id)));
      } catch (err) {
        problems.push(err instanceof Error ? err.message : `${key} failed`);
        continue;
      }
      for (const item of items) {
        const f = fresh.find((p) => p.externalId === s(item.external_id));
        const patch: Row = f
          ? { price_cents: f.priceCentavos, currency: f.currency, available: f.available, price_checked_at: checked, ...(f.imageUrl ? { image_url: f.imageUrl } : {}) }
          : { available: false, price_checked_at: checked }; // no longer listed
        const upd = await this.db.from('registry_items').update(patch).eq('id', s(item.id));
        if (upd.error) problems.push(upd.error.message);
        else updated++;
      }
    }
    return { ...(await this.registry.overview(eventId)), refreshed: { updated, problems, at: checked } };
  }

  /**
   * Guest click on a store link (REG-3: recorded, never treated as a purchase).
   * Returns the URL to redirect to.
   */
  async click(eventId: string, itemId: string, referrer: string | undefined): Promise<string> {
    if (!UUID.test(itemId)) throw new NotFoundException('No such gift');
    const { data, error } = await this.db.from('registry_items').select('id, external_url, status').eq('id', itemId).eq('event_id', eventId).maybeSingle();
    if (error) throw this.fail('Could not load the gift', error);
    const url = s((data as Row | null)?.external_url);
    if (!data || !/^https:\/\//.test(url)) throw new NotFoundException('No such gift');
    let host = '';
    try {
      host = referrer ? new URL(referrer).host : '';
    } catch {
      host = '';
    }
    const ins = await this.db.from('registry_clicks').insert({
      event_id: eventId,
      registry_item_id: itemId,
      referrer_hash: host ? createHash('sha256').update(host).digest('hex').slice(0, 32) : '',
    });
    // A missing clicks table must not break the guest's link.
    if (ins.error) this.logger.warn(`Click not recorded: ${ins.error.message}`);
    return url;
  }

  /** Clicks per registry item, for the host's list. */
  async clickCounts(eventId: string): Promise<Record<string, number>> {
    const { data, error } = await this.db.from('registry_clicks').select('registry_item_id').eq('event_id', eventId);
    if (error) return {};
    const out: Record<string, number> = {};
    for (const r of data as Row[]) out[s(r.registry_item_id)] = (out[s(r.registry_item_id)] ?? 0) + 1;
    return out;
  }

  // ------------------------------------------------------------- internals

  private async rows(): Promise<Row[]> {
    const { data, error } = await this.db.from('retailers').select('*').order('key');
    if (error) throw this.fail('Could not load retailers', error);
    return data as Row[];
  }

  private async enabled(key: string) {
    if (!/^[a-z0-9_]{2,40}$/.test(key)) throw new NotFoundException('No such retailer');
    const row = (await this.rows()).find((r) => s(r.key) === key);
    if (!row) throw new NotFoundException('No such retailer');
    if (row.enabled !== true) throw new ServiceUnavailableException(`${s(row.name)} is switched off`);
    const adapter = this.adapterFor(row);
    if (!adapter) throw new ServiceUnavailableException(`No adapter for ${s(row.adapter)}`);
    const missing = adapter.missingEnv();
    if (missing.length) throw new ServiceUnavailableException(`${s(row.name)} is not configured (${missing.join(', ')}).`);
    return { row, adapter };
  }

  private adapterFor(row: Row): RetailerAdapter | null {
    const key = s(row.key);
    const tag = s(row.affiliate_tag);
    const cached = this.adapters.get(key);
    if (cached && cached.tag === tag) return cached.adapter;
    let adapter: RetailerAdapter | null = null;
    if (row.adapter === 'amazon_paapi') adapter = new AmazonPaapiAdapter(key);
    else if (row.adapter === 'mercadolibre') adapter = new MercadoLibreAdapter(key, tag);
    if (adapter) this.adapters.set(key, { adapter, tag });
    return adapter;
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_TABLE || error.code === UNDEFINED_COLUMN) {
      return new ServiceUnavailableException(`Retailer tables are missing. Apply ${RETAILERS_MIGRATION}.`);
    }
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}
