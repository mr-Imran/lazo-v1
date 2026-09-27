import './load-env.js'; // Must come first — see the note in that file.
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { clerkMiddleware } from '@clerk/express';
import { AppModule, ObserveInstrument } from './app.module.js';
import { isObserveConfigured } from './observe.config.js';
import { siteConfig, slugFromHost } from './sites/site-config.js';
import { HideInternalErrors, rateLimit, securityHeaders } from './common/http-hardening.js';

const crashLog = new Logger('Process');

// A stray rejected promise (a background insert, a Clerk call) must not take
// the whole API down: log it and keep serving.
process.on('unhandledRejection', (reason) => {
  crashLog.error(`Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

// A synchronous crash leaves the process in an unknown state. Exit non-zero so
// the process manager (PM2, see ecosystem.config.cjs) starts a clean one.
process.on('uncaughtException', (error) => {
  crashLog.error(`Uncaught exception, restarting: ${error.stack ?? error.message}`);
  process.exit(1);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Keeps the unparsed body on req.rawBody; the Clerk webhook signature is
    // checked against those exact bytes.
    rawBody: true,
    ...(isObserveConfigured() ? { instrument: ObserveInstrument } : {}),
  });

  const port = Number(process.env.PORT ?? 3000);

  // Behind a proxy/load balancer, req.ip must be the client, not the proxy,
  // or every rate limit collapses onto one address. TRUST_PROXY_HOPS is the
  // number of proxies in front of this server (0 on a laptop).
  app.getHttpAdapter().getInstance().set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));

  // Headers run before everything else. The rate limiter is mounted after
  // Clerk (below) so per-user rules can see the session; Clerk's middleware
  // only verifies a JWT locally, so an unauthenticated flood still costs little.
  app.use(securityHeaders);
  // 5xx responses no longer echo database or provider messages to the client.
  app.useGlobalFilters(new HideInternalErrors());

  // A production frontend build calls the API directly rather than through
  // the Vite dev proxy, so its origin has to be allowed explicitly.
  // `||`, not `??`: an empty CORS_ORIGINS= line in .env must fall back to the
  // defaults, or the app is locked out (and Clerk would reject its tokens).
  const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:4173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  // Event sites are rendered by the frontend at <slug>.<SITE_DOMAIN>; a built
  // site calls the public site endpoints cross-origin, so those subdomains are
  // allowed too — but without credentials, since sites never sign anyone in.
  const isSiteOrigin = (origin: string): boolean => {
    try {
      const url = new URL(origin);
      const sites = siteConfig();
      if (!sites) return false;
      const sitePort = sites.domain.split(':')[1] ?? '';
      return url.protocol === `${sites.scheme}:` && url.port === sitePort && Boolean(slugFromHost(url.hostname));
    } catch {
      return false;
    }
  };
  app.enableCors((req: { headers: { origin?: string } }, done: (error: Error | null, options: object) => void) => {
    const origin = req.headers.origin;
    if (!origin) return done(null, { origin: false });
    if (corsOrigins.includes(origin)) return done(null, { origin: true, credentials: true });
    return done(null, { origin: isSiteOrigin(origin), credentials: false });
  });

  const sites = siteConfig();
  new Logger('Bootstrap').log(
    sites
      ? `Event sites (frontend): ${sites.scheme}://<subdomain>.${sites.domain}`
      : 'SITE_DOMAIN is not set — events have no site address.',
  );

  // Clerk throws on every request when the keys are absent, which would take
  // the login page down with it. Mount it only once it is configured; the
  // guard reports the missing configuration on protected routes instead.
  if (process.env.CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY) {
    // Only accept session tokens minted for our own front ends (the app and
    // this server's dashboard). A token obtained on another site, even one
    // using the same Clerk instance, is rejected.
    const ownOrigins = (process.env.DASHBOARD_ORIGINS || `http://localhost:${port}`)
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    app.use(clerkMiddleware({ authorizedParties: [...new Set([...corsOrigins, ...ownOrigins])] }));
  } else {
    new Logger('Bootstrap').warn(
      'CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY are not set — sign-in is disabled. See .env.example.',
    );
  }
  app.use(rateLimit);

  // SIGINT/SIGTERM (PM2 restart, Ctrl+C) close connections before exiting.
  app.enableShutdownHooks();

  await app.listen(port);
  new Logger('Bootstrap').log(`API listening on :${port} (health: /api/health)`);
}
await bootstrap().catch((error: unknown) => {
  // e.g. the port is taken. Exit so the process manager retries with backoff.
  crashLog.error(`Could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
