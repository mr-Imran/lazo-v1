// Uploads the homepage occasion-card images in supabase/seed/occasions/ to the
// public site-media bucket and points event_modes.image_url at them.
//
//   node scripts/seed-occasion-images.mjs
//
// Needs 20260928000000_homepage.sql applied. File names are event_modes
// values (boda.jpg → boda); files for occasions that don't exist are skipped,
// and occasions that already have an image are left alone (pass --force to
// replace them). Later changes belong in the dashboard: Homepage → Image.
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import '../dist/load-env.js';

const BUCKET = 'site-media';
const DIR = new URL('../supabase/seed/occasions/', import.meta.url);
const force = process.argv.includes('--force');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env');
const db = createClient(url, key, { auth: { persistSession: false } });

const { data: modes, error } = await db.from('event_modes').select('value, image_url');
if (error) throw new Error(`Could not read event_modes (is 20260928000000_homepage.sql applied?): ${error.message}`);
const byValue = new Map(modes.map((m) => [m.value, m]));

if ((await db.storage.getBucket(BUCKET)).error) {
  const created = await db.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: 5 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  });
  if (created.error && !/already exists/i.test(created.error.message)) throw created.error;
}

for (const file of await readdir(DIR)) {
  const value = file.replace(/\.jpg$/, '');
  const mode = byValue.get(value);
  if (!mode) { console.log(`skip ${file}: no occasion "${value}"`); continue; }
  if (mode.image_url && !force) { console.log(`skip ${file}: ${value} already has an image`); continue; }

  const path = `occasions/${value}/${randomUUID()}.jpg`;
  const up = await db.storage.from(BUCKET).upload(path, await readFile(new URL(file, DIR)), {
    contentType: 'image/jpeg',
    cacheControl: '31536000',
  });
  if (up.error) throw up.error;

  const publicUrl = db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  const saved = await db.from('event_modes').update({ image_url: publicUrl }).eq('value', value);
  if (saved.error) throw saved.error;
  console.log(`ok   ${value} → ${publicUrl}`);
}
