import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { FETCH_TIMEOUT_MS, toCentavos } from './retailer-adapter.js';
import type { RetailerAdapter, RetailerProduct, SearchOptions } from './retailer-adapter.js';

/**
 * Mercado Libre México (site MLM) through the public API. Since 2024 the
 * search and items endpoints need an access token, so every call carries an
 * app token from the client_credentials grant, cached until it expires.
 *
 * Docs: https://developers.mercadolibre.com.mx/es_ar/api-docs-es
 * Env: MELI_APP_ID, MELI_CLIENT_SECRET. The affiliate id (Mercado Libre
 * "matt_tool") comes from retailers.affiliate_tag once the program approves it.
 */
const API = 'https://api.mercadolibre.com';
const SITE = 'MLM';
const ENV = ['MELI_APP_ID', 'MELI_CLIENT_SECRET'] as const;
const ATTRIBUTION = 'Precio y disponibilidad según Mercado Libre México en el momento de la consulta.';
const ITEM_ATTRS = 'id,title,price,currency_id,thumbnail,secure_thumbnail,permalink,available_quantity,status';

type Json = Record<string, unknown>;

export class MercadoLibreAdapter implements RetailerAdapter {
  readonly key: string;
  readonly envNames = ENV;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    key = 'mercadolibre',
    private readonly affiliateTag = '',
  ) {
    this.key = key;
  }

  configured() {
    return this.missingEnv().length === 0;
  }

  missingEnv() {
    return ENV.filter((n) => !process.env[n]);
  }

  async search(query: string, opts: SearchOptions = {}): Promise<RetailerProduct[]> {
    const limit = Math.min(20, Math.max(1, opts.limit ?? 10));
    const data = await this.get(`/sites/${SITE}/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    const results = ((data as Json).results as Json[] | undefined) ?? [];
    return results.map((r) => this.normalise(r));
  }

  async getItems(ids: string[]): Promise<RetailerProduct[]> {
    const out: RetailerProduct[] = [];
    // Multiget takes up to 20 ids and answers [{ code, body }].
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20).map((id) => id.replace(/[^A-Z0-9]/gi, ''));
      const data = (await this.get(`/items?ids=${chunk.join(',')}&attributes=${ITEM_ATTRS}`)) as Json[];
      for (const entry of Array.isArray(data) ? data : []) {
        if (entry.code === 200 && entry.body) out.push(this.normalise(entry.body as Json));
      }
    }
    return out;
  }

  availability(ids: string[]) {
    return this.getItems(ids);
  }

  // ------------------------------------------------------------- internals

  private normalise(r: Json): RetailerProduct {
    const qty = typeof r.available_quantity === 'number' ? r.available_quantity : null;
    const status = r.status as string | undefined;
    let url = String(r.permalink ?? '');
    if (url && this.affiliateTag) {
      const u = new URL(url);
      u.searchParams.set('matt_tool', this.affiliateTag);
      url = u.toString();
    }
    return {
      retailer: this.key,
      externalId: String(r.id ?? ''),
      title: String(r.title ?? ''),
      imageUrl: String(r.secure_thumbnail ?? r.thumbnail ?? ''),
      priceCentavos: toCentavos(r.price),
      currency: String(r.currency_id ?? 'MXN'),
      // Search results omit status; items include it. Active + stock = buyable.
      available: qty === null ? null : qty > 0 && (status === undefined || status === 'active'),
      url,
      attribution: ATTRIBUTION,
    };
  }

  private async accessToken(): Promise<string> {
    const missing = this.missingEnv();
    if (missing.length) throw new ServiceUnavailableException(`Mercado Libre is not configured (${missing.join(', ')}).`);
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    let res: Response;
    try {
      res = await fetch(`${API}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: process.env.MELI_APP_ID as string,
          client_secret: process.env.MELI_CLIENT_SECRET as string,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new BadGatewayException(`Mercado Libre did not answer: ${err instanceof Error ? err.message : 'network error'}`);
    }
    const data = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok || typeof data.access_token !== 'string') {
      throw new BadGatewayException(`Mercado Libre rejected the app credentials: ${String(data.message ?? data.error ?? res.status)}`);
    }
    const ttl = typeof data.expires_in === 'number' ? data.expires_in : 21600;
    this.token = { value: data.access_token, expiresAt: Date.now() + ttl * 1000 };
    return this.token.value;
  }

  private async get(path: string): Promise<unknown> {
    const token = await this.accessToken();
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new BadGatewayException(`Mercado Libre did not answer: ${err instanceof Error ? err.message : 'network error'}`);
    }
    if (res.status === 401) this.token = null; // expired early: next call fetches a new one
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new BadGatewayException(`Mercado Libre ${path.split('?')[0]} failed: ${String((data as Json | null)?.message ?? res.status)}`);
    return data;
  }
}
