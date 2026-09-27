import { HttpException, HttpStatus } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Cost guards shared by email/SMS (MessagingService) and WhatsApp
 * (WhatsAppService). Every delivery costs money at the provider, so:
 *
 * - a per-plan daily cap on deliveries per event, read from `services`
 *   (`message_daily_cap_premium` / `message_daily_cap_signature`, the cap
 *   stored as price_centavos — migration 20261017000000_abuse_limits.sql);
 * - households that already received the same channel in the last
 *   DEDUPE_MINUTES are skipped (double-click, retried form) and reported.
 */
const FALLBACK_CAP = 500;
export const DEDUPE_MINUTES = 10;

type Row = Record<string, unknown>;

export async function dailyCapFor(db: SupabaseClient, tier: string | null | undefined): Promise<number> {
  const key = tier === 'signature' ? 'message_daily_cap_signature' : 'message_daily_cap_premium';
  const { data } = await db.from('services').select('price_centavos, active').eq('key', key).maybeSingle();
  const row = data as Row | null;
  if (!row || row.active === false) return FALLBACK_CAP;
  const cap = Number(row.price_centavos);
  return Number.isFinite(cap) && cap > 0 ? cap : FALLBACK_CAP;
}

export async function deliveriesLast24h(db: SupabaseClient, eventId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { count } = await db
    .from('message_deliveries')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .gte('created_at', since);
  return count ?? 0;
}

/** Throws 429 when `wanted` more deliveries would exceed the event's daily cap. */
export async function assertDailyQuota(db: SupabaseClient, eventId: string, tier: string | null | undefined, wanted: number): Promise<void> {
  const [cap, used] = await Promise.all([dailyCapFor(db, tier), deliveriesLast24h(db, eventId)]);
  if (used + wanted > cap) {
    const left = Math.max(0, cap - used);
    throw new HttpException(
      { statusCode: 429, error: 'Too Many Requests', message: `This event can send ${cap} messages per day on its plan; ${used} were sent in the last 24 hours (${left} left). Try again later or narrow the audience.` },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Household ids that already got this channel in the last DEDUPE_MINUTES. */
export async function recentlyMessaged(db: SupabaseClient, eventId: string, channel: string): Promise<Set<string>> {
  const since = new Date(Date.now() - DEDUPE_MINUTES * 60_000).toISOString();
  const { data } = await db
    .from('message_deliveries')
    .select('household_id')
    .eq('event_id', eventId)
    .eq('channel', channel)
    .gte('created_at', since)
    .limit(2000);
  return new Set(((data as Row[] | null) ?? []).map((r) => String(r.household_id ?? '')).filter(Boolean));
}
