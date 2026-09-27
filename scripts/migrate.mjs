// Applies supabase/migrations/*.sql to the database, in file-name order,
// each exactly once. Applied files are recorded in public.schema_migrations.
//
//   npm run db:migrate            apply everything pending
//   npm run db:status             list applied / pending, change nothing
//   node scripts/migrate.mjs --optional
//                                 (used by `npm run serve`) skip quietly when
//                                 DATABASE_URL isn't set, instead of failing
//
// Needs DATABASE_URL in .env: Supabase → Project Settings → Database →
// Connection string → "Session pooler" (URI), with your database password.
// It is a server secret, like SUPABASE_SECRET_KEY; never put it in a VITE_ var.
//
// Existing databases: the first run finds no schema_migrations table, so it
// records every file up to MIGRATE_BASELINE (default below: the last file
// applied by hand in the SQL editor, 20260929000000_event_info.sql) as already applied, then applies the rest.
// A brand-new, empty database has no public.events table and gets every file.
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';

const root = new URL('../', import.meta.url);
const envFile = new URL('.env', root);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const DIR = new URL('supabase/migrations/', root);
const BASELINE = process.env.MIGRATE_BASELINE || '20260929000000_event_info.sql';
const args = new Set(process.argv.slice(2));
const statusOnly = args.has('--status');
const optional = args.has('--optional');

const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
if (!url) {
  const msg =
    'DATABASE_URL is not set, so migrations were not applied automatically.\n' +
    '  Add it to lazobackend/.env (Supabase → Project Settings → Database → Connection string → Session pooler),\n' +
    '  or keep applying files in the Supabase SQL editor.';
  if (optional) {
    console.warn(`[migrate] ${msg}`);
    process.exit(0);
  }
  console.error(`[migrate] ${msg}`);
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  // Supabase requires TLS. Set PGSSLROOTCERT to Supabase's CA file to verify the chain.
  ssl: process.env.PGSSLROOTCERT
    ? { ca: await readFile(process.env.PGSSLROOTCERT, 'utf8') }
    : { rejectUnauthorized: false },
  application_name: 'lazo-migrate',
});

const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
const checksum = (sql) => createHash('sha256').update(sql).digest('hex').slice(0, 16);

try {
  await client.connect();

  const { rows: exists } = await client.query("select to_regclass('public.schema_migrations') as t");
  const firstRun = !exists[0].t;

  if (firstRun && !statusOnly) {
    await client.query(`
      create table public.schema_migrations (
        filename   text        primary key,
        checksum   text        not null default '',
        applied_at timestamptz not null default now()
      );
      alter table public.schema_migrations enable row level security;
    `);
    const { rows: events } = await client.query("select to_regclass('public.events') as t");
    if (events[0].t) {
      const baseline = files.filter((f) => f <= BASELINE);
      for (const f of baseline) {
        await client.query('insert into public.schema_migrations (filename, checksum) values ($1, $2)', [
          f,
          'baseline',
        ]);
      }
      console.log(`[migrate] existing database: recorded ${baseline.length} files up to ${BASELINE} as applied`);
    }
  }

  const applied = firstRun && statusOnly
    ? new Set()
    : new Set((await client.query('select filename from public.schema_migrations')).rows.map((r) => r.filename));
  const pending = files.filter((f) => !applied.has(f));

  if (statusOnly) {
    for (const f of files) console.log(`${applied.has(f) ? 'applied ' : 'PENDING '} ${f}`);
    if (firstRun) console.log('(no schema_migrations table yet: the first `npm run db:migrate` will baseline)');
    process.exit(0);
  }

  if (pending.length === 0) {
    console.log('[migrate] database is up to date');
  }

  for (const f of pending) {
    const sql = await readFile(new URL(f, DIR), 'utf8');
    process.stdout.write(`[migrate] applying ${f} … `);
    try {
      // One transaction per file: it applies completely or not at all.
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into public.schema_migrations (filename, checksum) values ($1, $2)', [
        f,
        checksum(sql),
      ]);
      await client.query('commit');
      console.log('ok');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      console.log('FAILED');
      console.error(`[migrate] ${f}: ${error.message}`);
      process.exit(1);
    }
  }

  // PostgREST (the Supabase API the server uses) caches the schema; refresh it
  // so new tables and columns are usable without restarting anything.
  if (pending.length) await client.query("notify pgrst, 'reload schema'");
} catch (error) {
  console.error(`[migrate] could not reach the database: ${error.message}`);
  process.exit(optional ? 0 : 1);
} finally {
  await client.end().catch(() => {});
}
