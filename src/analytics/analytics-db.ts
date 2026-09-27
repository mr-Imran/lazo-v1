import { ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import pg from 'pg';

/**
 * Direct Postgres access for the `analytics` schema.
 *
 * supabase-js only sees the schemas exposed through PostgREST (`public`), and
 * the warehouse schema is deliberately not exposed, so the backend reads it
 * over the same DATABASE_URL that scripts/migrate.mjs uses. The pool is
 * created lazily: a server without DATABASE_URL boots fine and every analytics
 * route answers 503 naming the variable instead.
 */
export const ANALYTICS_MIGRATION = 'supabase/migrations/20261013000000_analytics_warehouse.sql';

let pool: pg.Pool | null = null;

export function analyticsConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);
}

export function analyticsPool(): pg.Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!url) {
    throw new ServiceUnavailableException(
      'Analytics needs a direct database connection: set DATABASE_URL in lazobackend/.env ' +
        '(Supabase → Project Settings → Database → Connection string → Session pooler).',
    );
  }
  pool = new pg.Pool({
    connectionString: url,
    max: 3,
    // Supabase requires TLS; PGSSLROOTCERT pins the CA, as in scripts/migrate.mjs.
    ssl: process.env.PGSSLROOTCERT
      ? { ca: readFileSync(process.env.PGSSLROOTCERT, 'utf8') }
      : { rejectUnauthorized: false },
    application_name: 'lazo-analytics',
    statement_timeout: 120_000,
  });
  pool.on('error', () => {
    /* an idle client dropped; the next query gets a fresh one */
  });
  return pool;
}

export async function closeAnalyticsPool(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.end();
}

/** Postgres error codes that mean the migration has not been applied. */
const MISSING_SCHEMA_CODES = new Set(['3F000', '42P01', '42883']);

/** Runs a query, turning "schema not there yet" into a 503 that names the migration. */
export async function analyticsQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  try {
    const res = await analyticsPool().query<T>(text, params);
    return res.rows;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code && MISSING_SCHEMA_CODES.has(code)) {
      throw new ServiceUnavailableException(`The analytics schema is missing. Apply ${ANALYTICS_MIGRATION}.`);
    }
    throw err;
  }
}
