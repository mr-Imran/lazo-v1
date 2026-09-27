import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChatEventsService } from './chat.events.js';

/**
 * Plain helpers shared by ChatService and the vendor payment services, so
 * quotes and orders can post into a thread without importing ChatService
 * (which itself needs VendorQuotesService for in-chat offers).
 */
export const CHAT_MARKETPLACE_MIGRATION = 'supabase/migrations/20261015000000_chat_marketplace.sql';

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

export interface SystemLine {
  body: string;
  kind?: 'system' | 'offer';
  quoteId?: string | null;
  orderId?: string | null;
  /** Who caused it; their own tab won't ring. '' for Stripe/webhooks. */
  actorId?: string;
}

/**
 * The open host↔vendor thread a quote belongs to: the one the offer was
 * written in, else the open thread between that host, event and vendor.
 */
export async function conversationForQuote(db: SupabaseClient, quote: { conversationId?: string | null; ownerId?: string; eventId: string; vendorId: string }): Promise<Row | null> {
  if (quote.conversationId) {
    const { data } = await db.from('conversations').select('*').eq('id', quote.conversationId).maybeSingle();
    if (data) return data as Row;
  }
  if (!quote.ownerId) return null;
  const { data } = await db
    .from('conversations')
    .select('*')
    .eq('kind', 'vendor')
    .eq('status', 'open')
    .eq('customer_id', quote.ownerId)
    .eq('event_id', quote.eventId)
    .eq('vendor_id', quote.vendorId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  return (data as Row | null) ?? null;
}

/**
 * Appends a system (or offer) line to a thread and pushes it live. Never
 * throws: a missing column before the migration is applied only means the
 * thread doesn't show the milestone.
 */
export async function postSystemLine(db: SupabaseClient, events: ChatEventsService, conv: Row, line: SystemLine): Promise<Row | null> {
  const kind = line.kind ?? 'system';
  const { data, error } = await db
    .from('chat_messages')
    .insert({
      conversation_id: s(conv.id),
      sender_id: line.actorId || 'system',
      sender_role: kind === 'offer' ? 'vendor' : 'system',
      kind,
      body: line.body.slice(0, 4000),
      quote_id: line.quoteId ?? null,
      order_id: line.orderId ?? null,
    })
    .select('*')
    .single();
  if (error || !data) return null;
  const m = data as Row;
  await db
    .from('conversations')
    .update({ last_message_at: s(m.created_at), last_preview: line.body.slice(0, 120), message_count: Number(conv.message_count ?? 0) + 1 })
    .eq('id', s(conv.id));
  events.publish([s(conv.customer_id), s(conv.vendor_owner_id), s(conv.host_id), 'admin'].filter(Boolean), {
    type: 'message',
    conversationId: s(conv.id),
    payload: {
      message: {
        id: s(m.id),
        senderId: s(m.sender_id),
        senderRole: s(m.sender_role),
        kind,
        body: s(m.body),
        attachments: [],
        quoteId: line.quoteId ?? null,
        orderId: line.orderId ?? null,
        createdAt: s(m.created_at),
        senderName: '',
      },
      kind: s(conv.kind),
      preview: line.body.slice(0, 120),
    },
  });
  return m;
}

export interface ResponseStats {
  /** Average seconds from the host's first message to the vendor's first reply, over answered threads. */
  avgSeconds: number | null;
  /** Answered threads / threads with a host message, 0–1. */
  rate: number | null;
  threads: number;
}

/**
 * "Usually responds within …" per vendor, from the last 200 threads each.
 * Threads without any host message don't count.
 */
export async function vendorResponseStats(db: SupabaseClient, vendorIds: string[]): Promise<Map<string, ResponseStats>> {
  const out = new Map<string, ResponseStats>();
  if (!vendorIds.length) return out;
  const { data, error } = await db
    .from('conversations')
    .select('vendor_id, first_reply_seconds, message_count')
    .eq('kind', 'vendor')
    .in('vendor_id', vendorIds)
    .gt('message_count', 0)
    .order('created_at', { ascending: false })
    .limit(200 * vendorIds.length);
  if (error) return out; // Before the migration: no stats, no failure.
  const acc = new Map<string, { sum: number; answered: number; total: number }>();
  for (const r of (data as Row[]) ?? []) {
    const id = s(r.vendor_id);
    const a = acc.get(id) ?? { sum: 0, answered: 0, total: 0 };
    a.total += 1;
    if (typeof r.first_reply_seconds === 'number') {
      a.answered += 1;
      a.sum += r.first_reply_seconds;
    }
    acc.set(id, a);
  }
  for (const [id, a] of acc) {
    out.set(id, { avgSeconds: a.answered ? Math.round(a.sum / a.answered) : null, rate: a.total ? a.answered / a.total : null, threads: a.total });
  }
  return out;
}

const PHONE = /(?:\+?\d[\s().-]*){10,}/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const OFF_PLATFORM = /\b(wa\.me|whatsapp|telegram|t\.me|signal)\b/i;

/** Does a message look like it moves the deal off Lazo? Used only before a paid order exists. */
export function looksOffPlatform(body: string): boolean {
  return PHONE.test(body) || EMAIL.test(body) || OFF_PLATFORM.test(body);
}

/** "2 h", "3 d", "15 min" for a response-time badge. */
export function humanDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86400) return `${Math.max(1, Math.round(seconds / 3600))} h`;
  return `${Math.max(1, Math.round(seconds / 86400))} d`;
}
