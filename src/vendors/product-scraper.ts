import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Reads a product page (usually behind an affiliate link) and pulls out what
 * a listing needs: name, description, image and price. Sources, best first:
 * schema.org Product JSON-LD, Open Graph / product meta tags, microdata,
 * then Amazon's own markup (Amazon ships little structured data).
 *
 * The admin reviews everything before it is saved; nothing here is trusted
 * to be complete.
 */
export interface ScrapedProduct {
  /** The link as pasted (the affiliate link). */
  url: string;
  /** Where redirects ended: the store's product page. */
  finalUrl: string;
  /** The store's host without "www.", e.g. "amazon.com.mx". */
  site: string;
  name: string;
  description: string;
  imageUrl: string;
  priceCentavos: number | null;
  currency: string | null;
  /** Which of name, description, image, price were found. */
  found: string[];
  /** Things the admin should check before saving. */
  warnings: string[];
}

const MAX_REDIRECTS = 8;
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const ACCEPT = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
};
/**
 * Tried in order. Many stores (Amazon among them) answer a browser-looking
 * request from a server with a robot check but serve the real page to link
 * preview crawlers, the ones that draw a link's card in a chat app.
 */
const IDENTITIES: Record<string, string>[] = [
  { ...ACCEPT, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' },
  { ...ACCEPT, 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
];

/** The store showed a robot check, sign-in or verification page instead. */
class Blocked extends Error {}

const WALL_PATH = /\/(account-verification|captcha|challenge|errors\/validatecaptcha|ap\/signin|login|signin)\b/i;
const WALL_BODY = /validateCaptcha|api-services-support@amazon\.com|cf-challenge|challenge-platform|px-captcha|g-recaptcha[\s\S]{0,200}robot/i;

export async function scrapeProduct(raw: unknown): Promise<ScrapedProduct> {
  const start = parseLink(raw);

  let page: { html: string; finalUrl: URL } | null = null;
  for (const headers of IDENTITIES) {
    try {
      page = await fetchPage(start, headers);
      if (WALL_PATH.test(page.finalUrl.pathname) || WALL_BODY.test(page.html.slice(0, 200_000))) {
        throw new Blocked(page.finalUrl.hostname);
      }
      break;
    } catch (error) {
      if (!(error instanceof Blocked)) throw error;
      page = null;
    }
  }
  if (!page) {
    throw new BadGatewayException(
      `${start.hostname.replace(/^www\./, '')} blocked the automated read (it showed a robot check or sign-in page). Fill in the details by hand; the link is still saved as the affiliate link.`,
    );
  }

  const { html, finalUrl } = page;
  const site = finalUrl.hostname.replace(/^www\./, '');

  const meta = metaTags(html);
  const product = jsonLdProduct(html);
  const amazon = isAmazon(site) ? amazonFields(html) : null;
  const pick = (...values: (string | null | undefined)[]) => values.map((v) => clean(v ?? '')).find(Boolean) ?? '';

  // Amazon's JSON-LD is thin (its "description" repeats the page title), so
  // its own markup goes first there.
  const name = withoutStoreSuffix(
    pick(
      amazon?.name,
      product?.name,
      meta['og:title'],
      meta['twitter:title'],
      itemprop(html, 'name'),
      tagText(html, 'title'),
    ),
  ).slice(0, 200);

  const description = pick(
    amazon?.description,
    ...[product?.description, meta['og:description'], meta['description'], meta['twitter:description']].filter(
      // A description that only repeats the title says nothing.
      (d) => d && withoutStoreSuffix(clean(d)) !== name,
    ),
  ).slice(0, 4000);

  const image = pick(
    amazon?.image,
    product?.image,
    meta['og:image:secure_url'],
    meta['og:image'],
    meta['twitter:image'],
    meta['twitter:image:src'],
  );

  const priceSources: [unknown, string | null | undefined][] = [
    [product?.price, product?.currency],
    [amazon?.price, amazon?.currency],
    [meta['product:price:amount'], meta['product:price:currency']],
    [meta['og:price:amount'], meta['og:price:currency']],
    [itemprop(html, 'price'), itemprop(html, 'priceCurrency')],
  ];
  let priceCentavos: number | null = null;
  let currency: string | null = null;
  for (const [value, cur] of priceSources) {
    const parsed = parsePrice(value);
    if (parsed === null) continue;
    priceCentavos = parsed;
    currency = currencyOf(cur, value, site);
    break;
  }

  const imageUrl = absolute(image, finalUrl);
  const found = [
    name && 'name',
    description && 'description',
    imageUrl && 'image',
    priceCentavos !== null && 'price',
  ].filter((f): f is string => Boolean(f));

  if (!name) {
    throw new BadGatewayException(
      `Could not find product details on ${site}. The store may block automated reads; fill in the details by hand.`,
    );
  }

  const warnings: string[] = [];
  const productPage = Boolean(product || amazon?.name || /product/i.test(meta['og:type'] ?? '') || priceCentavos !== null);
  if (!productPage) {
    warnings.push(
      `The link opened ${finalUrl.hostname}${finalUrl.pathname}, which doesn't look like a single product page (it may have moved or sold out). Check the details.`,
    );
  }
  if (priceCentavos === null) warnings.push('No price on the page (it may be out of stock or hidden in your region).');

  return {
    url: start.toString(),
    finalUrl: finalUrl.toString(),
    site,
    name,
    description,
    imageUrl,
    priceCentavos,
    currency,
    found,
    warnings,
  };
}

// ------------------------------------------------------------------ fetching

function parseLink(raw: unknown): URL {
  if (typeof raw !== 'string' || !raw.trim()) throw new BadRequestException('Paste the product link');
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new BadRequestException('The link must be a full https:// address');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException('The link must start with https://');
  }
  if (parsed.toString().length > 2000) throw new BadRequestException('The link is too long');
  return parsed;
}

/** Follows redirects by hand so every hop is checked against private networks. */
async function fetchPage(start: URL, headers: Record<string, string>): Promise<{ html: string; finalUrl: URL }> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(current);

    let res: Response;
    try {
      res = await fetch(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'took too long to answer' : 'could not be reached';
      throw new BadGatewayException(`${current.hostname} ${reason}`);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw new BadGatewayException(`${current.hostname} redirected without a destination`);
      current = new URL(location, current);
      if (current.protocol !== 'https:' && current.protocol !== 'http:') {
        throw new BadGatewayException('The link redirects somewhere that is not a web page');
      }
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel();
      if ([403, 429, 503].includes(res.status)) throw new Blocked(current.hostname);
      throw new BadGatewayException(
        `${current.hostname} answered ${res.status}${res.status === 404 ? ' (page not found; check the link)' : ''}`,
      );
    }

    const type = res.headers.get('content-type') ?? '';
    if (type && !/html|xml/i.test(type)) {
      await res.body?.cancel();
      throw new BadGatewayException('That link is not a web page');
    }

    return { html: await readText(res, type), finalUrl: current };
  }
  throw new BadGatewayException('The link redirects too many times');
}

async function readText(res: Response, contentType: string): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Product data sits in the head and top of the page; stop at the cap.
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});

  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(Buffer.concat(chunks));
}

/** Rejects loopback, link-local and RFC-1918 targets (SSRF guard); resolves DNS. */
export async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) {
    throw new BadRequestException('That link points at a private address');
  }
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new BadGatewayException(`${host} could not be found`);
    }
  }
  if (addresses.some(isPrivateAddress)) throw new BadRequestException('That link points at a private address');
}

function isPrivateAddress(address: string): boolean {
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

// ------------------------------------------------------------------- parsing

interface Fields {
  name?: string;
  description?: string;
  image?: string;
  price?: unknown;
  currency?: string;
}

/** property/name/itemprop → content, first one wins. */
function metaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(tag);
    const key = (attrs.property ?? attrs.name ?? attrs.itemprop ?? '').toLowerCase();
    if (key && attrs.content !== undefined && !(key in out)) out[key] = decode(attrs.content);
  }
  return out;
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/** The first schema.org Product (or ProductGroup) in any JSON-LD block. */
function jsonLdProduct(html: string): Fields | null {
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      try {
        // Raw newlines inside strings are a common authoring slip.
        data = JSON.parse(m[1].trim().replace(/[\r\n\t]+/g, ' '));
      } catch {
        continue;
      }
    }
    const product = findProduct(data, 0);
    if (!product) continue;

    const offer = firstOffer(product.offers ?? (product.hasVariant as Record<string, unknown>[] | undefined)?.[0]?.offers);
    return {
      name: str(product.name),
      description: str(product.description),
      image: imageOf(product.image),
      price: offer?.price ?? offer?.lowPrice ?? (offer?.priceSpecification as Record<string, unknown> | undefined)?.price,
      currency:
        str(offer?.priceCurrency) ?? str((offer?.priceSpecification as Record<string, unknown> | undefined)?.priceCurrency),
    };
  }
  return null;
}

function findProduct(node: unknown, depth: number): Record<string, unknown> | null {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProduct(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const types = ([] as unknown[]).concat(obj['@type'] ?? []).map(String);
  if (types.some((t) => /^(Product|ProductGroup|IndividualProduct|ProductModel)$/i.test(t))) return obj;
  for (const key of ['@graph', 'mainEntity', 'itemListElement', 'item']) {
    const found = findProduct(obj[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function firstOffer(offers: unknown): Record<string, unknown> | null {
  if (!offers || typeof offers !== 'object') return null;
  if (Array.isArray(offers)) return firstOffer(offers[0]);
  const obj = offers as Record<string, unknown>;
  // AggregateOffer may nest the real offers.
  if (obj.price === undefined && obj.lowPrice === undefined && obj.offers) return firstOffer(obj.offers);
  return obj;
}

function imageOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return imageOf(value[0]);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return str(obj.url) ?? str(obj.contentUrl);
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** A microdata value: <… itemprop="price" content="…"> or its text. */
function itemprop(html: string, prop: string): string | undefined {
  const re = new RegExp(`<(\\w+)\\b[^>]*itemprop\\s*=\\s*["']${prop}["'][^>]*>`, 'i');
  const m = re.exec(html);
  if (!m) return undefined;
  const attrs = attributes(m[0]);
  if (attrs.content !== undefined) return decode(attrs.content);
  const after = html.slice(m.index + m[0].length, m.index + m[0].length + 400);
  return stripTags(after.split(new RegExp(`</${m[1]}>`, 'i'))[0]);
}

function tagText(html: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html);
  return m ? stripTags(m[1]) : undefined;
}

// --------------------------------------------------------------------- amazon

const isAmazon = (site: string) => /(^|\.)amazon\.[a-z.]+$/i.test(site) || /(^|\.)amzn\./i.test(site);

function amazonFields(html: string): Fields {
  const name = /<span[^>]*id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1];

  const landing = /<img\b[^>]*id=["']landingImage["'][^>]*>/i.exec(html)?.[0];
  let image: string | undefined;
  if (landing) {
    const attrs = attributes(landing);
    image = attrs['data-old-hires'] || undefined;
    if (!image && attrs['data-a-dynamic-image']) {
      image = /"(https:[^"]+)"/.exec(decode(attrs['data-a-dynamic-image']))?.[1];
    }
    image ??= attrs.src;
    // "…/I/411aTMUWgPL._AC_SX342_.jpg" → the full-size "…/I/411aTMUWgPL.jpg".
    image = image?.replace(/\._[^/]+_\.(jpe?g|png|webp)$/i, '.$1');
  }

  // The price block for the offer on screen, then the page's price JSON.
  const block =
    /id=["'](?:corePriceDisplay_desktop_feature_div|corePrice_feature_div|corePrice_desktop|apex_desktop)["']([\s\S]{0,6000})/i.exec(html)?.[1] ?? '';
  const price =
    /class=["']a-offscreen["'][^>]*>([^<]+)</i.exec(block)?.[1] ??
    /"priceAmount"\s*:\s*([\d.]+)/.exec(html)?.[1] ??
    /id=["']priceblock_(?:ourprice|dealprice|saleprice)["'][^>]*>([^<]+)</i.exec(html)?.[1];

  const bullets = /<div[^>]*id=["']feature-bullets["'][^>]*>([\s\S]*?)<\/ul>/i.exec(html)?.[1];
  const description = bullets
    ? [...bullets.matchAll(/<span[^>]*class=["'][^"']*a-list-item[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)]
        .map((b) => stripTags(b[1]))
        .filter(Boolean)
        .join('\n')
    : undefined;

  return { name: name && stripTags(name), image, price: price && decode(price), description };
}

// -------------------------------------------------------------------- values

/**
 * "$1,299.00", "1.299,00 €", "MX$ 849", 1299 → centavos. Null when there is
 * no usable amount.
 */
export function parsePrice(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
  if (typeof value !== 'string') return null;
  let s = value.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: the later one is the decimal mark.
    s = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (lastComma !== -1) {
    // "12,50" is a decimal; "1,299" is thousands.
    s = /,\d{1,2}$/.test(s) && s.split(',').length === 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (s.split('.').length > 2) {
    s = s.replace(/\./g, '');
  }

  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 100_000_000) return null;
  return Math.round(n * 100);
}

const SITE_CURRENCY: [RegExp, string][] = [
  [/\.mx$/, 'MXN'],
  [/\.com\.br$/, 'BRL'],
  [/\.co\.uk$/, 'GBP'],
  [/\.ca$/, 'CAD'],
  [/\.(es|de|fr|it|nl)$/, 'EUR'],
  [/\.com\.co$/, 'COP'],
  [/\.com\.ar$/, 'ARS'],
  [/\.cl$/, 'CLP'],
];

function currencyOf(stated: string | null | undefined, price: unknown, site: string): string {
  const code = (stated ?? '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) return code;

  const shown = typeof price === 'string' ? price : '';
  if (/US\$|USD/i.test(shown)) return 'USD';
  if (/MX\$|MXN/i.test(shown)) return 'MXN';
  if (/R\$/.test(shown)) return 'BRL';
  if (/€/.test(shown)) return 'EUR';
  if (/£/.test(shown)) return 'GBP';

  for (const [re, cur] of SITE_CURRENCY) if (re.test(site)) return cur;
  // A bare "$" on a .com store: Amazon.com and most US shops are dollars.
  if (/\.com$/.test(site) && /\$/.test(shown)) return 'USD';
  return 'MXN';
}

/** "Funda … : Amazon.com.mx: Electrónicos" → "Funda …". */
function withoutStoreSuffix(title: string): string {
  return title.replace(/\s+[:|–-]\s+Amazon\.[a-z.]+(\s*:.*)?$/i, '').trim();
}

/** Relative and protocol-less image paths become https URLs. */
function absolute(src: string, base: URL): string {
  if (!src) return '';
  try {
    const u = new URL(src, base);
    if (u.protocol === 'http:') u.protocol = 'https:';
    // Shopify image URLs carry a thumbnail size; without it the CDN serves the original.
    if (/cdn\.shopify\.com$/.test(u.hostname) || u.pathname.includes('/cdn/shop/')) {
      u.searchParams.delete('width');
      u.searchParams.delete('height');
    }
    return u.protocol === 'https:' ? u.toString() : '';
  } catch {
    return '';
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
  iquest: '¿', iexcl: '¡', deg: '°', euro: '€', pound: '£', cent: '¢',
};

function decode(s: string): string {
  return s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code] ?? whole;
  });
}

function stripTags(s: string): string {
  return decode(
    s
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>|<\/(p|li|div|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

/** Decodes leftovers, drops tags, and tidies whitespace while keeping line breaks. */
function clean(s: string): string {
  return stripTags(s)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
