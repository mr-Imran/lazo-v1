import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { FETCH_TIMEOUT_MS, toCentavos } from './retailer-adapter.js';
import type { RetailerAdapter, RetailerProduct, SearchOptions } from './retailer-adapter.js';

/**
 * Amazon Product Advertising API 5.0 for amazon.com.mx. Requests are signed
 * with AWS Signature V4 by hand (node:crypto) — the official SDK is a large
 * generated bundle for two JSON POSTs.
 *
 * Docs: https://webservices.amazon.com/paapi5/documentation/
 * Marketplace www.amazon.com.mx → host webservices.amazon.com.mx, region us-east-1.
 *
 * Env: AMAZON_PAAPI_ACCESS_KEY, AMAZON_PAAPI_SECRET_KEY, AMAZON_PAAPI_PARTNER_TAG
 * (the Associates tag; Amazon puts it in every DetailPageURL it returns).
 */
const HOST = 'webservices.amazon.com.mx';
const REGION = 'us-east-1';
const SERVICE = 'ProductAdvertisingAPI';
const MARKETPLACE = 'www.amazon.com.mx';
const ENV = ['AMAZON_PAAPI_ACCESS_KEY', 'AMAZON_PAAPI_SECRET_KEY', 'AMAZON_PAAPI_PARTNER_TAG'] as const;
/** Amazon's operating agreement requires this next to prices. */
const ATTRIBUTION = 'Precio y disponibilidad según Amazon.com.mx en el momento de la consulta.';
const RESOURCES = [
  'ItemInfo.Title',
  'Images.Primary.Medium',
  'Offers.Listings.Price',
  'Offers.Listings.Availability.Type',
  'Offers.Listings.Availability.Message',
];

type Json = Record<string, unknown>;
const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const hmac = (key: string | Buffer, v: string) => createHmac('sha256', key).update(v).digest();

export class AmazonPaapiAdapter implements RetailerAdapter {
  readonly key: string;
  readonly envNames = ENV;

  constructor(key = 'amazon_mx') {
    this.key = key;
  }

  configured() {
    return this.missingEnv().length === 0;
  }

  missingEnv() {
    return ENV.filter((n) => !process.env[n]);
  }

  async search(query: string, opts: SearchOptions = {}): Promise<RetailerProduct[]> {
    const data = await this.call('SearchItems', {
      Keywords: query,
      ItemCount: Math.min(10, Math.max(1, opts.limit ?? 10)),
      Resources: RESOURCES,
    });
    const items = ((data.SearchResult as Json | undefined)?.Items as Json[] | undefined) ?? [];
    return items.map((i) => this.normalise(i));
  }

  async getItems(ids: string[]): Promise<RetailerProduct[]> {
    const out: RetailerProduct[] = [];
    // GetItems takes up to 10 ASINs per call.
    for (let i = 0; i < ids.length; i += 10) {
      const data = await this.call('GetItems', { ItemIds: ids.slice(i, i + 10), Resources: RESOURCES });
      const items = ((data.ItemsResult as Json | undefined)?.Items as Json[] | undefined) ?? [];
      out.push(...items.map((it) => this.normalise(it)));
    }
    return out;
  }

  availability(ids: string[]) {
    return this.getItems(ids);
  }

  // ------------------------------------------------------------- internals

  private normalise(item: Json): RetailerProduct {
    const info = item.ItemInfo as Json | undefined;
    const title = ((info?.Title as Json | undefined)?.DisplayValue as string | undefined) ?? '';
    const image = (((item.Images as Json | undefined)?.Primary as Json | undefined)?.Medium as Json | undefined)?.URL as string | undefined;
    const listing = (((item.Offers as Json | undefined)?.Listings as Json[] | undefined) ?? [])[0];
    const price = listing?.Price as Json | undefined;
    const availability = listing?.Availability as Json | undefined;
    const type = availability?.Type as string | undefined;
    return {
      retailer: this.key,
      externalId: String(item.ASIN ?? ''),
      title,
      imageUrl: image ?? '',
      priceCentavos: toCentavos(price?.Amount),
      currency: (price?.Currency as string | undefined) ?? 'MXN',
      // "Now" is in stock; anything else (Backorder, Preorder, absent) is not buyable today.
      available: listing ? type === 'Now' : null,
      url: String(item.DetailPageURL ?? ''),
      attribution: ATTRIBUTION,
    };
  }

  private async call(operation: 'SearchItems' | 'GetItems', params: Json): Promise<Json> {
    const missing = this.missingEnv();
    if (missing.length) throw new ServiceUnavailableException(`Amazon is not configured (${missing.join(', ')}).`);
    const accessKey = process.env.AMAZON_PAAPI_ACCESS_KEY as string;
    const secretKey = process.env.AMAZON_PAAPI_SECRET_KEY as string;
    const partnerTag = process.env.AMAZON_PAAPI_PARTNER_TAG as string;

    const path = `/paapi5/${operation.toLowerCase()}`;
    const body = JSON.stringify({ ...params, PartnerTag: partnerTag, PartnerType: 'Associates', Marketplace: MARKETPLACE });
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260926T120000Z
    const dateStamp = amzDate.slice(0, 8);
    const target = `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${operation}`;

    // SigV4: canonical request → string to sign → signing key → signature.
    const headers: Record<string, string> = {
      'content-encoding': 'amz-1.0',
      'content-type': 'application/json; charset=utf-8',
      host: HOST,
      'x-amz-date': amzDate,
      'x-amz-target': target,
    };
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((h) => `${h}:${headers[h].trim()}\n`)
      .join('');
    const canonicalRequest = ['POST', path, '', canonicalHeaders, signedHeaders, sha256(body)].join('\n');
    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
    const kDate = hmac(`AWS4${secretKey}`, dateStamp);
    const kRegion = hmac(kDate, REGION);
    const kService = hmac(kRegion, SERVICE);
    const kSigning = hmac(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    let res: Response;
    try {
      res = await fetch(`https://${HOST}${path}`, {
        method: 'POST',
        headers: { ...headers, Authorization: authorization },
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new BadGatewayException(`Amazon did not answer: ${err instanceof Error ? err.message : 'network error'}`);
    }
    const data = (await res.json().catch(() => ({}))) as Json;
    const errors = data.Errors as Json[] | undefined;
    if (!res.ok || errors?.length) {
      const first = errors?.[0];
      // "NoResults" is an empty answer, not a failure.
      if (first?.Code === 'NoResults') return {};
      throw new BadGatewayException(`Amazon ${operation} failed: ${first ? `${first.Code}: ${first.Message}` : `HTTP ${res.status}`}`);
    }
    return data;
  }
}
