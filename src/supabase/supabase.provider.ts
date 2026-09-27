import { Logger } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';

export const SUPABASE_CLIENT = 'SUPABASE_CLIENT';

export type LazoSupabaseClient = SupabaseClient<Database>;

/**
 * Supabase renamed the server-side key: new projects issue `sb_secret_...` as
 * SUPABASE_SECRET_KEY, older ones a JWT as SUPABASE_SERVICE_ROLE_KEY. Either
 * works here, so accept both rather than forcing a rename.
 */
const secretKey = (): string | undefined =>
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

export const isSupabaseConfigured = (): boolean =>
  Boolean(process.env.SUPABASE_URL && secretKey());

/**
 * A single server-side client for the whole process.
 *
 * The secret key bypasses row level security, so it must never leave the
 * server — the browser gets nothing but the REST routes in EventsController.
 * Resolves to null when the keys are absent so the app still boots and serves
 * the login page; EventsService reports the missing configuration instead.
 */
export const supabaseProvider = {
  provide: SUPABASE_CLIENT,
  useFactory: (): LazoSupabaseClient | null => {
    if (!isSupabaseConfigured()) {
      new Logger('Supabase').warn(
        'SUPABASE_URL / SUPABASE_SECRET_KEY are not set — events cannot be stored. See .env.example.',
      );

      return null;
    }

    return createClient<Database>(process.env.SUPABASE_URL!, secretKey()!, {
      // There is no end user session here: Clerk owns auth, and this client
      // only ever runs server-side on behalf of an already-verified request.
      auth: { persistSession: false, autoRefreshToken: false },
    });
  },
};
