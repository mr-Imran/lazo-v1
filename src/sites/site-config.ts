import { BadRequestException } from '@nestjs/common';

/**
 * Where hosted event sites live: <slug>.<SITE_DOMAIN>.
 *
 * For local testing set SITE_DOMAIN=localhost:3000. Browsers resolve every
 * *.localhost name to this machine (RFC 6761), so rajib-jerin.localhost:3000
 * reaches this server with no DNS or hosts-file changes, and the Host header
 * tells it which site to render.
 */
export interface SiteConfig {
  /** As configured, port included: "localhost:3000" or "lazo.com". */
  domain: string;
  /** Hostname part only, compared against req.hostname: "localhost". */
  host: string;
  scheme: 'http' | 'https';
}

const LOCAL = /(^|\.)(localhost|lvh\.me)$/i;

export function siteConfig(): SiteConfig | null {
  const domain = (process.env.SITE_DOMAIN ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();

  if (!domain) return null;

  const host = domain.split(':')[0]!;
  const configured = process.env.SITE_SCHEME?.trim().toLowerCase();
  const scheme =
    configured === 'http' || configured === 'https' ? configured : LOCAL.test(host) ? 'http' : 'https';

  return { domain, host, scheme };
}

export function siteUrlFor(slug: string | null): string | null {
  const config = siteConfig();

  return slug && config ? `${config.scheme}://${slug}.${config.domain}` : null;
}

/** Labels that would collide with the platform's own hosts. */
const RESERVED = new Set([
  'www', 'api', 'app', 'admin', 'dashboard', 'mail', 'email', 'smtp', 'static',
  'assets', 'cdn', 'help', 'support', 'status', 'docs', 'blog', 'lazo', 'login',
  'signup', 'auth', 'account', 'billing', 'test', 'dev', 'staging',
]);

/**
 * A subdomain is one DNS label: 3–63 characters, lowercase letters, digits
 * and inner hyphens. Returns null for "clear the subdomain".
 */
export function parseSlug(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new BadRequestException('slug must be a string');

  const slug = value.trim().toLowerCase();
  if (!slug) return null;

  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(slug) || slug.includes('--')) {
    throw new BadRequestException(
      'The subdomain must be 3–63 characters: letters, numbers and single hyphens, not starting or ending with a hyphen',
    );
  }

  if (RESERVED.has(slug)) throw new BadRequestException(`“${slug}” is reserved; pick another subdomain`);

  return slug;
}

/** The subdomain in a request's hostname, or null if it isn't a site address. */
export function slugFromHost(hostname: string | undefined): string | null {
  const config = siteConfig();
  if (!config || !hostname) return null;

  const host = hostname.toLowerCase();
  const suffix = `.${config.host}`;
  if (!host.endsWith(suffix)) return null;

  const label = host.slice(0, -suffix.length);

  // Exactly one label: a.b.localhost is not a site.
  return /^[a-z0-9-]+$/.test(label) ? label : null;
}
