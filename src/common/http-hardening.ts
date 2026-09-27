import { HttpException, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getAuthContext } from '../auth/auth-context.js';

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Baseline response headers. No CSP here: the admin dashboard is one inline
 * page that loads Clerk from a CDN, and a wrong policy would lock admins out.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  if (isProduction() && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // API answers are per-user; never let a shared cache keep them.
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  res.removeHeader('X-Powered-By');
  next();
}

interface Rule {
  name: string;
  windowMs: number;
  max: number;
  applies: (req: Request) => boolean;
  /** Count per signed-in user when there is one (falls back to IP). */
  perUser?: boolean;
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Fixed-window limits kept in memory, per client IP or (for `perUser` rules)
 * per signed-in user. Enough for one server; with several instances behind a
 * load balancer, move this to Redis. `trust proxy` is set in main.ts from
 * TRUST_PROXY_HOPS so req.ip is the real client behind a proxy.
 */
const RULES: Rule[] = [
  // Image uploads are the costliest thing to abuse (storage + bandwidth).
  {
    name: 'uploads',
    windowMs: 10 * 60_000,
    max: 30,
    perUser: true,
    applies: (r) => r.method === 'POST' && (/\/(media|logo|image|photos|attachments)$/.test(r.path)),
  },
  // Outbound email / WhatsApp: each call fans out to every household (provider cost).
  { name: 'messages-send', windowMs: 60 * 60_000, max: 10, perUser: true, applies: (r) => r.method === 'POST' && (/^\/api\/events\/[^/]+\/messages$/.test(r.path) || /\/whatsapp\/send$/.test(r.path)) },
  // Fulfilment orders notify contracted partners (print, flowers, travel).
  { name: 'fulfilment-orders', windowMs: 60 * 60_000, max: 10, perUser: true, applies: (r) => r.method === 'POST' && /\/fulfilment\/orders$/.test(r.path) },
  // Retailer searches hit paid APIs (Amazon PA-API, Mercado Libre).
  { name: 'retailer-search', windowMs: 60 * 60_000, max: 60, perUser: true, applies: (r) => r.method === 'GET' && /\/retailers\/[^/]+\/search$/.test(r.path) },
  // Chat transcripts are outbound emails.
  { name: 'chat-transcript', windowMs: 60 * 60_000, max: 2, perUser: true, applies: (r) => r.method === 'POST' && /\/chats\/[^/]+\/transcript$/.test(r.path) },
  // Public RSVP: invitation lookups and answers, per IP (name lookup must not become a directory).
  { name: 'rsvp', windowMs: 10 * 60_000, max: 40, applies: (r) => r.method === 'POST' && /^\/api\/sites\/[^/]+\/rsvp/.test(r.path) },
  // Password guesses on private sites, and guest gift messages.
  { name: 'site-public', windowMs: 10 * 60_000, max: 20, applies: (r) => r.method === 'POST' && /^\/api\/sites\/[^/]+\/(unlock|gifts|condolences)$/.test(r.path) },
  // Typing indicators: many small posts per minute are normal.
  { name: 'typing', windowMs: 60_000, max: 120, applies: (r) => r.method === 'POST' && /\/chats\/[^/]+\/typing$/.test(r.path) },
  // Chat without an account: a visitor writes a few messages, a bot writes hundreds.
  { name: 'public-chat', windowMs: 10 * 60_000, max: 60, applies: (r) => r.method === 'POST' && r.path.startsWith('/api/public/chats') },
  // Anonymous drafts (details step before sign-up): a visitor saves a few, a script would fill the table.
  { name: 'drafts', windowMs: 60 * 60_000, max: 20, applies: (r) => (r.method === 'POST' && r.path === '/api/drafts') || (r.method === 'PATCH' && r.path.startsWith('/api/drafts/')) },
  // Claim-token guesses: 404s only, but keep them slow.
  { name: 'draft-reads', windowMs: 10 * 60_000, max: 60, applies: (r) => r.method === 'GET' && r.path.startsWith('/api/drafts/') },
  // Anonymous sign-ups: a person signs up once, a script signs up thousands.
  { name: 'newsletter', windowMs: 60 * 60_000, max: 10, applies: (r) => r.method === 'POST' && r.path === '/api/newsletter' },
  // Anything that creates rows: events, vendors, listings, picks, keys…
  { name: 'writes', windowMs: 60_000, max: 60, perUser: true, applies: (r) => WRITE.has(r.method) && r.path.startsWith('/api/') && !/\/typing$/.test(r.path) },
  // Everything else, generously.
  { name: 'all', windowMs: 60_000, max: 600, applies: (r) => r.path.startsWith('/api/') },
];

const hits = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  // Signed webhooks come from Clerk's servers in bursts; their signature is the gate.
  if (req.path.startsWith('/api/webhooks/')) return next();

  const now = Date.now();
  const client = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  // Runs before the guards, so only a Clerk session is visible here; API-key
  // callers count by IP.
  const userId = getAuthContext(req)?.userId ?? null;

  // Express routes case-insensitively and tolerates a trailing slash, but the
  // rule regexes are anchored and case-sensitive. Match them against a
  // normalized path so `/…/SEARCH` or `/…/search/` cannot skip a rule and fall
  // through to the loose `all` limit. Query string is already excluded by req.path.
  const path = req.path.replace(/\/+$/, '').toLowerCase() || '/';
  const view = { method: req.method, path } as Request;

  for (const rule of RULES) {
    if (!rule.applies(view)) continue;

    const key = `${rule.name}:${rule.perUser ? (userId ?? client) : client}`;
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + rule.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > rule.max) {
      const retry = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      res.status(429).json({
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Too many requests. Try again in ${retry} seconds.`,
      });
      return;
    }
  }

  next();
}

// Drop expired windows so the map can't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
}, 60_000).unref();

/**
 * Keeps server internals out of responses. 4xx errors pass through as Nest
 * would send them (they describe the caller's mistake). 5xx errors — which
 * often carry a Postgres or Supabase message — are logged with a reference
 * and answered generically. 503 "apply this migration" hints stay visible
 * outside production, where they are what a developer needs.
 */
export class HideInternalErrors implements ExceptionFilter {
  private readonly logger = new Logger('Error');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();

    if (exception instanceof HttpException && exception.getStatus() < 500) {
      const body = exception.getResponse();
      res.status(exception.getStatus()).json(typeof body === 'string' ? { statusCode: exception.getStatus(), message: body } : body);
      return;
    }

    const status = exception instanceof HttpException ? exception.getStatus() : 500;

    if (status === 503 && !isProduction() && exception instanceof HttpException) {
      res.status(503).json(exception.getResponse());
      return;
    }

    const reference = randomUUID().slice(0, 8);
    const detail = exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);
    this.logger.error(`[${reference}] ${req.method} ${req.path} → ${status}: ${detail}`);

    res.status(status).json({
      statusCode: status,
      error: status === 503 ? 'Service Unavailable' : 'Internal Server Error',
      message: `Something went wrong on our side. Please try again. (ref ${reference})`,
    });
  }
}
