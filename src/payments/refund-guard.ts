import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

export const ABUSE_MIGRATION = 'supabase/migrations/20261017000000_abuse_limits.sql';

const MISSING_FUNCTION = new Set(['PGRST202', '42883']);
const UNDEFINED_COLUMN = '42703';

type Target = 'vendor' | 'payment';

/**
 * Reserves `amount` on the row (refund_pending += amount) with a conditional
 * update in Postgres, so two refunds racing each other cannot together exceed
 * what was charged. Call before the gateway; then `settleRefund` with the
 * outcome. Both run as SQL functions from ABUSE_MIGRATION.
 */
export async function reserveRefund(db: SupabaseClient, target: Target, id: string, amount: number): Promise<void> {
  const { data, error } = await db.rpc(`lazo_${target}_refund_reserve`, { p_id: id, p_amount: amount });
  if (error) throw guardError(error);
  if (data !== true) throw new ConflictException('That amount exceeds what can still be refunded (another refund may be in progress).');
}

/** ok: pending → refunded. Not ok: the reservation is released. */
export async function settleRefund(db: SupabaseClient, target: Target, id: string, amount: number, ok: boolean): Promise<void> {
  const { error } = await db.rpc(`lazo_${target}_refund_settle`, { p_id: id, p_amount: amount, p_ok: ok });
  if (error) throw guardError(error);
}

/** Optional client key (≤ 64 chars) that makes a repeated refund request return the first result. */
export function parseIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 64 || !/^[\w.:-]+$/.test(value)) {
    throw new BadRequestException('idempotencyKey must be a string of up to 64 letters, digits, ".", ":", "_" or "-"');
  }
  return value;
}

function guardError(error: { code?: string; message: string }): Error {
  if (MISSING_FUNCTION.has(error.code ?? '') || error.code === UNDEFINED_COLUMN) {
    return new ServiceUnavailableException(`Refund guards are missing. Apply ${ABUSE_MIGRATION}.`);
  }
  return new ServiceUnavailableException(`Could not reserve the refund: ${error.message}`);
}
