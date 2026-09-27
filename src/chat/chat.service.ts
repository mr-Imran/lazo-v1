import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { sniffImageType } from '../common/image-type.js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { VendorQuotesService } from '../vendor-payments/vendor-quotes.service.js';
import { appUrl } from '../vendor-payments/vendor-payments.common.js';
import { ChatEventsService } from './chat.events.js';
import { CHAT_MARKETPLACE_MIGRATION, looksOffPlatform, postSystemLine } from './chat-system.js';

export const CHAT_MIGRATION = 'supabase/migrations/20261004000000_chat.sql';
export const CHAT_LIVE_MIGRATION = 'supabase/migrations/20261006000000_chat_live.sql';
export const CHAT_FILES_BUCKET = 'chat-files';
const MAX_ATTACHMENTS_PER_DAY = 20;
export const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024;
const UNDEFINED_TABLE = 'PGRST205';
const UNDEFINED_COLUMN = '42703';
const UUID = /^[0-9a-f-]{36}$/i;
const PAGE = 200;
const SIGNED_URL_SECONDS = 3600;
const NOTIFY_EVERY_MS = 30 * 60 * 1000;
const FILE_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

type Row = Record<string, unknown>;
type Role = 'customer' | 'vendor' | 'admin' | 'host' | 'guest' | 'system';
const s = (v: unknown) => (typeof v === 'string' ? v : '');

export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
}

export interface Attachment {
  path: string;
  name: string;
  size: number;
  type: string;
  /** Signed, one hour; filled in when a thread is read. */
  url?: string;
}

interface Caller {
  /** A Clerk user id, or 'visitor:<hash>' for someone without an account. */
  userId: string;
  isAdmin: boolean;
}

/** The identity a signed-out browser gets from its X-Visitor-Token. */
export function visitorId(token: unknown): string {
  const raw = s(token).trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(raw)) throw new BadRequestException('Missing visitor token');
  return `visitor:${createHmac('sha256', process.env.CHAT_LOG_SALT || process.env.SUPABASE_SECRET_KEY || 'lazo').update(raw).digest('hex').slice(0, 32)}`;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderRole: Role;
  mine: boolean;
  /** text | offer (quoteId) | system | file */
  kind: string;
  body: string;
  attachments: Attachment[];
  quoteId: string | null;
  orderId: string | null;
  flagged: boolean;
  createdAt: string;
}

/**
 * Conversations between a host and a vendor (about one event) or with Lazo
 * support. Admins see everything and may write anywhere. Besides the
 * database, every message is appended to <CHAT_LOG_DIR>/<conversation>.jsonl
 * with hashed sender ids, so the corpus for training can be exported without
 * touching the live tables.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly logDir = process.env.CHAT_LOG_DIR || join(process.cwd(), 'data', 'chats');

  private readonly resend = process.env.RESEND_API_KEY && process.env.MESSAGE_FROM_EMAIL ? new Resend(process.env.RESEND_API_KEY) : null;
  private bucketReady: Promise<void> | null = null;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
    private readonly events: ChatEventsService,
    private readonly quotes: VendorQuotesService,
  ) {
    // A participant coming online or going offline is shown to the other side.
    this.events.onPresence = (channels, online) => {
      for (const c of channels) {
        // Only the first connection (or the last disconnect) changes what the other side sees.
        if (c === 'admin' || c.startsWith('presence:') || this.events.isOnline(c) !== online) continue;
        this.events.publish(['presence:' + c], { type: 'presence', conversationId: '', payload: { channel: c, online } });
      }
      if (channels.includes('admin')) this.events.publish(['presence:admin'], { type: 'presence', conversationId: '', payload: { channel: 'admin', online: this.events.isOnline('admin') } });
    };
  }

  /** Who is reachable right now: Lazo support (any admin connected), and a vendor's owner. */
  async presence(vendorId?: string) {
    let vendorOnline: boolean | null = null;
    if (vendorId && UUID.test(vendorId)) {
      const { data } = await this.db.from('vendors').select('owner_id').eq('id', vendorId).maybeSingle();
      vendorOnline = data ? this.events.isOnline(s((data as Row).owner_id)) : null;
    }
    return { support: this.events.isOnline('admin'), vendor: vendorOnline, connections: this.events.connections };
  }

  /** The other party's presence in one thread, for the thread header. */
  private peerOnline(row: Row, role: Role): boolean {
    if (row.kind === 'support') return role === 'customer' ? this.events.isOnline('admin') : this.events.isOnline(s(row.customer_id));
    if (row.kind === 'vendor') return role === 'customer' ? this.events.isOnline(s(row.vendor_owner_id)) : this.events.isOnline(s(row.customer_id));
    return role === 'guest' ? this.events.isOnline(s(row.host_id)) : this.events.isOnline(s(row.customer_id));
  }

  /** "X is typing…" to the other participants. Not stored. */
  async typing(caller: Caller, id: string, input: Row) {
    const conv = await this.access(caller, id);
    this.events.publish(
      this.channels(conv.row).filter((c) => c !== caller.userId),
      { type: 'typing', conversationId: id, payload: { userId: caller.userId, role: conv.role, typing: input.typing !== false } },
    );
    return { ok: true };
  }

  /** The visitor's page and browser, remembered on the thread for the agent. */
  async context(caller: Caller, id: string, input: Row) {
    const conv = await this.access(caller, id);
    if (conv.role !== 'customer' && conv.role !== 'guest') return { ok: true };
    const page = s(input.page).slice(0, 500);
    const meta = { userAgent: s(input.userAgent).slice(0, 300), language: s(input.language).slice(0, 20), referrer: s(input.referrer).slice(0, 500), screen: s(input.screen).slice(0, 20) };
    await this.db.from('conversations').update({ visitor_page: page, visitor_meta: meta }).eq('id', id);
    return { ok: true };
  }

  /** { rating: 1–5, note? } from the customer or guest once the chat is over. */
  async rate(caller: Caller, id: string, input: Row) {
    const conv = await this.access(caller, id);
    if (conv.role !== 'customer' && conv.role !== 'guest') throw new ForbiddenException('Only the person who asked can rate');
    const rating = Number(input.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new BadRequestException('Rate from 1 to 5');
    const { error } = await this.db
      .from('conversations')
      .update({ rating, rating_note: s(input.note).trim().slice(0, 600), rated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw this.fail('Could not save your rating', error);
    return this.thread(caller, id);
  }

  /** Emails the whole thread to `email` (or the address on file). Needs Resend. */
  async transcript(caller: Caller, id: string, input: Row) {
    if (!this.resend) throw new ServiceUnavailableException('Email is not set up on this server.');
    const conv = await this.access(caller, id);
    // Only the address already tied to this thread (the visitor's, or the
    // signed-in caller's account email) — never an arbitrary address, or the
    // endpoint becomes a relay that mails a stranger's inbox.
    const known = await this.transcriptRecipient(caller, conv.row);
    const requested = s(input.email).trim().toLowerCase();
    if (requested && requested !== known.toLowerCase()) {
      throw new BadRequestException('Transcripts can only be sent to the email on this conversation or your account.');
    }
    const email = known;
    if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new BadRequestException('There is no email on this conversation to send the transcript to.');
    const { data, error } = await this.db.from('chat_messages').select('*').eq('conversation_id', id).order('created_at');
    if (error) throw this.fail('Could not load the conversation', error);
    const lines = ((data as Row[]) ?? []).map((m) => `[${new Date(s(m.created_at)).toLocaleString('es-MX')}] ${s(m.sender_role)}: ${s(m.body)}`);
    const text = `Your conversation on Lazo (${s(conv.row.subject) || s(conv.row.kind)})\n\n${lines.join('\n')}\n`;
    const { error: sendError } = await this.resend.emails.send({ from: process.env.MESSAGE_FROM_EMAIL!, to: email, subject: 'Your Lazo chat transcript', text });
    if (sendError) throw new InternalServerErrorException(`Could not send: ${sendError.message}`);
    return { ok: true };
  }

  /** The visitor email stored on the thread, else the signed-in caller's account email. */
  private async transcriptRecipient(caller: Caller, row: Row): Promise<string> {
    const stored = s(row.visitor_email).trim();
    if (stored) return stored;
    if (caller.userId.startsWith('visitor:')) return '';
    const { data } = await this.db.from('users').select('email').eq('id', caller.userId).maybeSingle();
    return s((data as Row | null)?.email).trim();
  }

  // ------------------------------------------------------------ canned replies

  /** Admins: the shared set (owner null). Vendors: their own. Hosts: none. */
  async shortcuts(caller: Caller) {
    if (caller.isAdmin) return this.shortcutList(null);
    const vendor = await this.vendorOf(caller.userId);
    return vendor ? this.shortcutList(caller.userId) : { shortcuts: [] };
  }

  async addShortcut(caller: Caller, input: Row) {
    const owner = caller.isAdmin ? null : (await this.vendorOf(caller.userId)) ? caller.userId : undefined;
    if (owner === undefined) throw new ForbiddenException('Only admins and vendors have canned replies');
    const shortcut = s(input.shortcut).trim().toLowerCase().replace(/^\//, '');
    const body = s(input.body).trim();
    if (!/^[a-z0-9_-]{1,30}$/.test(shortcut)) throw new BadRequestException('Use letters, numbers, - or _ (up to 30) for the shortcut');
    if (!body || body.length > 2000) throw new BadRequestException('The reply must be 1–2000 characters');
    // Same shortcut again replaces the reply (the unique index is on coalesce(owner_id, '')).
    let del = this.db.from('chat_shortcuts').delete().eq('shortcut', shortcut);
    del = owner === null ? del.is('owner_id', null) : del.eq('owner_id', owner);
    await del;
    const ins = await this.db.from('chat_shortcuts').insert({ owner_id: owner, shortcut, body });
    if (ins.error) throw this.fail('Could not save the reply', ins.error);
    return this.shortcutList(owner);
  }

  async removeShortcut(caller: Caller, id: string) {
    if (!UUID.test(id)) throw new NotFoundException('No such reply');
    const owner = caller.isAdmin ? null : caller.userId;
    let q = this.db.from('chat_shortcuts').delete().eq('id', id);
    q = owner === null ? q.is('owner_id', null) : q.eq('owner_id', owner);
    const { error } = await q;
    if (error) throw this.fail('Could not delete the reply', error);
    return this.shortcutList(owner);
  }

  private async shortcutList(owner: string | null) {
    let q = this.db.from('chat_shortcuts').select('*').order('shortcut');
    q = owner === null ? q.is('owner_id', null) : q.eq('owner_id', owner);
    const { data, error } = await q;
    if (error) {
      if (error.code === UNDEFINED_TABLE) return { shortcuts: [] };
      throw this.fail('Could not load canned replies', error);
    }
    return { shortcuts: ((data as Row[]) ?? []).map((r) => ({ id: s(r.id), shortcut: s(r.shortcut), body: s(r.body) })) };
  }

  /** Admin picks up (or hands off) a support thread. */
  async assign(adminId: string, id: string, input: Row) {
    if (!UUID.test(id)) throw new NotFoundException('No such conversation');
    const to = input.release === true ? null : adminId;
    const { error } = await this.db.from('conversations').update({ assigned_to: to }).eq('id', id);
    if (error) throw this.fail('Could not assign', error);
    return { assignedTo: to };
  }

  /** Everyone who should hear about a conversation: its participants and every admin. */
  private channels(row: Row): string[] {
    return [s(row.customer_id), s(row.vendor_owner_id), s(row.host_id), 'admin'].filter(Boolean);
  }

  /** My inbox: conversations I'm the customer of, plus (if I own a vendor) my vendor's. */
  async inbox(caller: Caller) {
    const vendor = await this.vendorOf(caller.userId);
    // As the customer of support/vendor threads, the owner of a vendor, and the host guests write to.
    const parts = [`customer_id.eq.${caller.userId}`, `host_id.eq.${caller.userId}`];
    if (vendor) parts.push(`vendor_owner_id.eq.${caller.userId}`);
    const { data, error } = await this.db
      .from('conversations')
      .select('*')
      .or(parts.join(','))
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(PAGE);
    if (error) throw this.fail('Could not load your conversations', error);
    return { conversations: await this.decorate((data as Row[]) ?? [], caller), vendorId: vendor?.id ?? null };
  }

  /** Admin: every conversation, newest activity first. */
  async adminList(kind?: string) {
    let q = this.db.from('conversations').select('*').order('last_message_at', { ascending: false, nullsFirst: false });
    if (kind === 'vendor' || kind === 'support' || kind === 'guest') q = q.eq('kind', kind);
    const { data, error } = await q.limit(500);
    if (error) throw this.fail('Could not load conversations', error);
    return { conversations: await this.decorate((data as Row[]) ?? [], { userId: 'admin', isAdmin: true }) };
  }

  /**
   * { kind: 'vendor', eventId, vendorId } (host → vendor, reuses the open thread)
   * { kind: 'support', eventId?, subject? } (anyone → Lazo)
   */
  async start(caller: Caller, input: Row) {
    const kind = s(input.kind);
    if (kind === 'vendor') {
      const eventId = s(input.eventId).toUpperCase();
      const vendorId = s(input.vendorId);
      if (!eventId || !UUID.test(vendorId)) throw new BadRequestException('eventId and vendorId are required');
      const [event, vendor] = await Promise.all([
        this.db.from('events').select('id, name, owner_id').eq('id', eventId).maybeSingle(),
        this.db.from('vendors').select('id, business_name, owner_id, status').eq('id', vendorId).maybeSingle(),
      ]);
      if (event.error) throw this.fail('Could not load the event', event.error);
      if (!event.data || (event.data as Row).owner_id !== caller.userId) throw new NotFoundException('No such event');
      const v = vendor.data as Row | null;
      if (!v || v.status !== 'active' || !v.owner_id) throw new NotFoundException('That vendor is not available');
      if (v.owner_id === caller.userId) throw new BadRequestException('That is your own vendor profile');

      const { data: open } = await this.db
        .from('conversations')
        .select('id')
        .eq('kind', 'vendor')
        .eq('status', 'open')
        .eq('customer_id', caller.userId)
        .eq('event_id', eventId)
        .eq('vendor_id', vendorId)
        .maybeSingle();
      if (open) return this.thread(caller, s((open as Row).id));

      const { data, error } = await this.db
        .from('conversations')
        .insert({ kind: 'vendor', event_id: eventId, vendor_id: vendorId, customer_id: caller.userId, vendor_owner_id: s(v.owner_id), subject: s(v.business_name) })
        .select('id')
        .single();
      if (error) throw this.fail('Could not start the conversation', error);
      this.events.publish([s(v.owner_id), 'admin'], { type: 'conversation', conversationId: s((data as Row).id), payload: { kind: 'vendor' } });
      return this.thread(caller, s((data as Row).id));
    }
    if (kind === 'guest') {
      // A guest on a live site writes to its hosts. Only visitors reach this (see PublicChatController).
      const slug = s(input.slug).toLowerCase();
      const { data: ev, error } = await this.db.from('events').select('id, owner_id, state, name').eq('slug', slug).maybeSingle();
      if (error) throw this.fail('Could not load the event', error);
      const event = ev as Row | null;
      if (!event || event.state !== 'live') throw new NotFoundException('No site at this address');
      const { data: open } = await this.db
        .from('conversations')
        .select('id')
        .eq('kind', 'guest')
        .eq('status', 'open')
        .eq('customer_id', caller.userId)
        .eq('event_id', s(event.id))
        .maybeSingle();
      if (open) return this.thread(caller, s((open as Row).id));
      const { data, error: insErr } = await this.db
        .from('conversations')
        .insert({
          kind: 'guest',
          event_id: s(event.id),
          host_id: s(event.owner_id),
          customer_id: caller.userId,
          subject: s(event.name),
          visitor_name: s(input.name).trim().slice(0, 120),
          visitor_email: s(input.email).trim().slice(0, 200),
        })
        .select('id')
        .single();
      if (insErr) throw this.fail('Could not start the conversation', insErr);
      this.events.publish([s(event.owner_id), 'admin'], { type: 'conversation', conversationId: s((data as Row).id), payload: { kind: 'guest' } });
      return this.thread(caller, s((data as Row).id));
    }
    if (kind === 'support') {
      const eventId = s(input.eventId).toUpperCase() || null;
      if (eventId) {
        const { data } = await this.db.from('events').select('id').eq('id', eventId).eq('owner_id', caller.userId).maybeSingle();
        if (!data) throw new NotFoundException('No such event');
      }
      const { data: open } = await this.db
        .from('conversations')
        .select('id')
        .eq('kind', 'support')
        .eq('status', 'open')
        .eq('customer_id', caller.userId)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (open) {
        // A visitor may add their name later.
        const name = s(input.name).trim().slice(0, 120);
        const email = s(input.email).trim().slice(0, 200);
        if (name || email) await this.db.from('conversations').update({ ...(name && { visitor_name: name }), ...(email && { visitor_email: email }) }).eq('id', s((open as Row).id));
        return this.thread(caller, s((open as Row).id));
      }
      const { data, error } = await this.db
        .from('conversations')
        .insert({
          kind: 'support',
          event_id: eventId,
          customer_id: caller.userId,
          subject: s(input.subject).trim().slice(0, 200) || 'Support',
          visitor_name: s(input.name).trim().slice(0, 120),
          visitor_email: s(input.email).trim().slice(0, 200),
        })
        .select('id')
        .single();
      if (error) throw this.fail('Could not start the conversation', error);
      this.events.publish(['admin'], { type: 'conversation', conversationId: s((data as Row).id), payload: { kind: 'support' } });
      return this.thread(caller, s((data as Row).id));
    }
    throw new BadRequestException('kind must be vendor, support or guest');
  }

  /** One conversation and its messages (after `since`, if given). Marks it read for the caller. */
  async thread(caller: Caller, id: string, since?: string) {
    const conv = await this.access(caller, id);
    let q = this.db.from('chat_messages').select('*').eq('conversation_id', id).order('created_at', { ascending: true });
    if (since && !Number.isNaN(Date.parse(since))) q = q.gt('created_at', new Date(since).toISOString());
    const { data, error } = await q.limit(500);
    if (error) throw this.fail('Could not load messages', error);

    const readAt = new Date().toISOString();
    await this.db.from('conversation_reads').upsert({ conversation_id: id, user_id: caller.userId, last_read_at: readAt });
    // "Seen" for whoever wrote the last messages.
    this.events.publish(this.channels(conv.row).filter((c) => c !== caller.userId), { type: 'read', conversationId: id, payload: { userId: caller.userId, role: conv.role, readAt } });

    const rows = (data as Row[]) ?? [];
    const [names, signed, offers] = await Promise.all([this.senderNames(rows), this.signAttachments(rows), this.offersIn(rows)]);
    const [decorated] = await this.decorate([conv.row], caller);
    return {
      conversation: {
        ...decorated,
        peerOnline: this.peerOnline(conv.row, conv.role),
        // Fiverr-style guard rails: contact details are flagged until an order is paid.
        hasPaidOrder: conv.row.kind === 'vendor' ? await this.hasPaidOrder(conv.row) : true,
        assignedTo: s(conv.row.assigned_to) || null,
        rating: typeof conv.row.rating === 'number' ? conv.row.rating : null,
        ratingNote: s(conv.row.rating_note),
        // Only staff see where the visitor is and what they use.
        ...(conv.role === 'admin' || conv.role === 'vendor' || conv.role === 'host'
          ? { visitorPage: s(conv.row.visitor_page), visitorMeta: (conv.row.visitor_meta as Row) ?? {} }
          : {}),
      },
      role: conv.role,
      messages: rows.map((m) => ({
        ...toMessage(m, caller.userId, signed),
        senderName: names.get(s(m.sender_id)) ?? '',
        ...(m.quote_id ? { offer: offers.get(s(m.quote_id)) ?? null } : {}),
      })),
    };
  }

  /**
   * { body?, attachments?: [{ path, name, size, type }] } — attachments come
   * from POST …/attachments first. In a host↔vendor thread with no paid order
   * yet, text that carries a phone, email or WhatsApp link is still sent but
   * flagged, and the reply carries a `warning` to show.
   */
  async send(caller: Caller, id: string, input: Row) {
    const conv = await this.access(caller, id);
    if (conv.row.status === 'closed') throw new BadRequestException('This conversation is closed');
    const body = s(input.body).trim();
    const attachments = this.attachmentsIn(input.attachments, id);
    if (!body && !attachments.length) throw new BadRequestException('Write a message');
    if (body.length > 4000) throw new BadRequestException('Messages must be 4000 characters or fewer');

    const guarded = conv.row.kind === 'vendor' && (conv.role === 'customer' || conv.role === 'vendor') && looksOffPlatform(body) && !(await this.hasPaidOrder(conv.row));
    const preview = body || (attachments.length === 1 ? `📎 ${attachments[0].name}` : `📎 ${attachments.length} files`);

    const { data, error } = await this.db
      .from('chat_messages')
      .insert({
        conversation_id: id,
        sender_id: caller.userId,
        sender_role: conv.role,
        kind: body ? 'text' : 'file',
        body,
        attachments,
        flagged: guarded,
      })
      .select('*')
      .single();
    if (error) throw this.fail('Could not send the message', error);
    const message = data as Row;

    const update: Row = { last_message_at: s(message.created_at), last_preview: preview.slice(0, 120), message_count: Number(conv.row.message_count ?? 0) + 1 };
    // The vendor's first answer to a host: what "Usually responds within …" is made of.
    if (conv.row.kind === 'vendor' && conv.role === 'vendor' && !conv.row.first_reply_at) {
      const { data: first } = await this.db
        .from('chat_messages')
        .select('created_at')
        .eq('conversation_id', id)
        .eq('sender_id', s(conv.row.customer_id))
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (first) {
        update.first_reply_at = s(message.created_at);
        update.first_reply_seconds = Math.max(0, Math.round((Date.parse(s(message.created_at)) - Date.parse(s((first as Row).created_at))) / 1000));
      }
    }
    await this.db.from('conversations').update(update).eq('id', id);
    await this.db.from('conversation_reads').upsert({ conversation_id: id, user_id: caller.userId, last_read_at: s(message.created_at) });
    await this.log(conv.row, message);

    // Push to everyone in the thread (and admins) right away. Each side gets
    // the same payload; the client compares senderId with its own id.
    const signed = await this.signAttachments([message]);
    this.events.publish(this.channels(conv.row), {
      type: 'message',
      conversationId: id,
      payload: { message: { ...toMessage(message, '', signed), senderName: (await this.senderNames([message])).get(caller.userId) ?? '' }, kind: s(conv.row.kind), preview: preview.slice(0, 120) },
    });
    void this.notifyOffline(conv.row, conv.role, caller.userId, preview);

    return {
      message: toMessage(message, caller.userId, signed),
      warning: guarded
        ? 'Keep the conversation on Lazo until an order is paid: payments made outside are not protected, and this message was flagged for review.'
        : null,
    };
  }

  // ------------------------------------------------------------ marketplace

  /** Storage is billed per byte: at most MAX_ATTACHMENTS_PER_DAY files per thread per day. */
  private async assertAttachmentQuota(conversationId: string): Promise<void> {
    const { data } = await this.db.storage.from(CHAT_FILES_BUCKET).list(conversationId, { limit: 1000, sortBy: { column: 'created_at', order: 'desc' } });
    const since = Date.now() - 24 * 60 * 60_000;
    const today = ((data as Row[] | null) ?? []).filter((f) => new Date(s(f.created_at)).getTime() >= since).length;
    if (today >= MAX_ATTACHMENTS_PER_DAY) {
      throw new HttpException(
        { statusCode: 429, error: 'Too Many Requests', message: `Up to ${MAX_ATTACHMENTS_PER_DAY} files per conversation per day.` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Stores one file (image or PDF, ≤ 10 MB) for a thread; the caller then sends it in a message. */
  async upload(caller: Caller, id: string, file: UploadedFile | undefined): Promise<{ attachment: Attachment }> {
    const conv = await this.access(caller, id);
    if (conv.row.status === 'closed') throw new BadRequestException('This conversation is closed');
    if (!file) throw new BadRequestException('Attach a file (field "file")');
    if (file.size > MAX_CHAT_FILE_BYTES) throw new BadRequestException('Files must be 10 MB or smaller');
    const type = sniffImageType(file.buffer) ?? (file.buffer.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf' : null);
    if (!type) throw new BadRequestException('Only JPEG, PNG, WebP images and PDF files can be attached');
    await this.ensureBucket();
    await this.assertAttachmentQuota(id);
    const path = `${id}/${randomUUID()}.${FILE_EXT[type]}`;
    const up = await this.db.storage.from(CHAT_FILES_BUCKET).upload(path, file.buffer, { contentType: type, cacheControl: '31536000' });
    if (up.error) throw new InternalServerErrorException(`Could not store the file: ${up.error.message}`);
    const name = s(file.originalname).replace(/[\r\n\t]/g, ' ').trim().slice(0, 160) || `file.${FILE_EXT[type]}`;
    const attachment: Attachment = { path, name, size: file.size, type };
    const { data } = await this.db.storage.from(CHAT_FILES_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
    return { attachment: { ...attachment, url: data?.signedUrl } };
  }

  /**
   * Vendor writes an offer inside a host↔vendor thread: a vendor_quote tied
   * to this conversation, sent at once, plus an `offer` message the host can
   * accept (→ order → Checkout) or decline from the thread.
   * { title, lineItems, amountCentavos, depositCentavos?, validUntil?, note? }
   */
  async offer(caller: Caller, id: string, input: Row) {
    const conv = await this.access(caller, id);
    if (conv.row.kind !== 'vendor' || conv.role !== 'vendor') throw new ForbiddenException('Only the vendor in a host conversation can send an offer');
    if (conv.row.status === 'closed') throw new BadRequestException('This conversation is closed');
    const { quote } = await this.quotes.create(caller.userId, { ...input, conversationId: id, send: true });
    const line = await postSystemLine(this.db, this.events, conv.row, {
      kind: 'offer',
      body: `Offer: ${quote.title} · ${money(quote.amountCentavos, quote.currency)}${quote.depositCentavos ? ` (deposit ${money(quote.depositCentavos, quote.currency)})` : ''}`,
      quoteId: quote.id,
      actorId: caller.userId,
    });
    if (!line) throw this.fail('Could not post the offer', { code: UNDEFINED_COLUMN, message: 'chat_messages.kind' });
    await this.log(conv.row, line);
    return { quote, message: { ...toMessage(line, caller.userId, new Map()), offer: quote } };
  }

  /** { starred } — a personal flag, per participant. */
  async star(caller: Caller, id: string, input: Row) {
    await this.access(caller, id);
    return this.setFlag(caller, id, { starred: input.starred !== false });
  }

  /** { archived } — hides the thread from the main list for this person only. */
  async archive(caller: Caller, id: string, input: Row) {
    await this.access(caller, id);
    return this.setFlag(caller, id, { archived: input.archived !== false });
  }

  private async setFlag(caller: Caller, id: string, flag: Row) {
    const { data: existing } = await this.db.from('conversation_reads').select('last_read_at').eq('conversation_id', id).eq('user_id', caller.userId).maybeSingle();
    const { error } = await this.db
      .from('conversation_reads')
      .upsert({ conversation_id: id, user_id: caller.userId, last_read_at: s((existing as Row | null)?.last_read_at) || new Date(0).toISOString(), ...flag });
    if (error) throw this.fail('Could not save', error);
    return { ok: true, ...flag };
  }

  private attachmentsIn(value: unknown, conversationId: string): Attachment[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 10) throw new BadRequestException('Attach at most 10 files per message');
    return value.map((raw) => {
      const r = (raw ?? {}) as Row;
      const path = s(r.path);
      // Only files uploaded for this very thread can be referenced.
      if (!path.startsWith(`${conversationId}/`) || !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/i.test(path)) throw new BadRequestException('Unknown attachment');
      return { path, name: s(r.name).slice(0, 160) || path.split('/').pop()!, size: Number(r.size ?? 0), type: s(r.type) };
    });
  }

  /** Signed URLs for every attachment in these messages, keyed by path. */
  private async signAttachments(rows: Row[]): Promise<Map<string, string>> {
    const paths = rows.flatMap((m) => (Array.isArray(m.attachments) ? (m.attachments as Row[]).map((a) => s(a.path)) : [])).filter(Boolean);
    if (!paths.length) return new Map();
    const { data } = await this.db.storage.from(CHAT_FILES_BUCKET).createSignedUrls([...new Set(paths)], SIGNED_URL_SECONDS);
    return new Map(((data ?? []) as Array<{ path: string | null; signedUrl: string }>).filter((d) => d.path && d.signedUrl).map((d) => [d.path!, d.signedUrl]));
  }

  /** The quotes (and the orders they became) behind the offer cards in a thread. */
  private async offersIn(rows: Row[]): Promise<Map<string, Row>> {
    const ids = [...new Set(rows.map((m) => s(m.quote_id)).filter(Boolean))];
    if (!ids.length) return new Map();
    const [quotes, orders] = await Promise.all([
      this.db.from('vendor_quotes').select('*').in('id', ids),
      this.db.from('vendor_orders').select('*').in('quote_id', ids),
    ]);
    const orderByQuote = new Map(((orders.data as Row[] | null) ?? []).map((o) => [s(o.quote_id), o]));
    return new Map(
      ((quotes.data as Row[] | null) ?? []).map((q) => {
        const o = orderByQuote.get(s(q.id));
        const validUntil = s(q.valid_until) || null;
        const status = s(q.status) === 'sent' && validUntil && Date.parse(validUntil) < Date.now() ? 'expired' : s(q.status);
        return [
          s(q.id),
          {
            id: s(q.id),
            eventId: s(q.event_id),
            title: s(q.title),
            lineItems: Array.isArray(q.line_items) ? (q.line_items as Row[]).map((li) => ({ description: s(li.description), quantity: Number(li.quantity ?? 1), unitCentavos: Number(li.unit_centavos ?? 0) })) : [],
            amountCentavos: Number(q.amount_centavos ?? 0),
            depositCentavos: typeof q.deposit_centavos === 'number' ? q.deposit_centavos : null,
            currency: s(q.currency) || 'MXN',
            validUntil,
            status,
            note: s(q.note),
            order: o ? { id: s(o.id), status: s(o.status), amountCentavos: Number(o.amount_centavos ?? 0), receiptUrl: s(o.receipt_url), refundedCentavos: Number(o.refunded_centavos ?? 0) } : null,
          },
        ];
      }),
    );
  }

  private async hasPaidOrder(conv: Row): Promise<boolean> {
    const { data } = await this.db
      .from('vendor_orders')
      .select('id')
      .eq('event_id', s(conv.event_id))
      .eq('vendor_id', s(conv.vendor_id))
      .in('status', ['paid', 'in_progress', 'fulfilled'])
      .limit(1);
    return Boolean(data?.length);
  }

  /**
   * "You have a new message" by email when the other side has no stream
   * open, at most once per 30 minutes per thread. Only for account holders in
   * host↔vendor threads; support and guests already have their own paths.
   */
  private async notifyOffline(conv: Row, senderRole: Role, senderId: string, preview: string) {
    try {
      if (!this.resend || conv.kind !== 'vendor') return;
      const toUser = senderRole === 'vendor' ? s(conv.customer_id) : s(conv.vendor_owner_id);
      if (!toUser || toUser === senderId || this.events.isOnline(toUser)) return;
      const last = s(conv.last_notified_at);
      if (last && Date.now() - Date.parse(last) < NOTIFY_EVERY_MS) return;
      const [{ data: user }, { data: vendor }] = await Promise.all([
        this.db.from('users').select('email, first_name').eq('id', toUser).maybeSingle(),
        senderRole === 'vendor' ? Promise.resolve({ data: null }) : this.db.from('vendors').select('email').eq('id', s(conv.vendor_id)).maybeSingle(),
      ]);
      const email = s((vendor as Row | null)?.email) || s((user as Row | null)?.email);
      if (!email) return;
      const { data: from } =
        senderRole === 'vendor'
          ? await this.db.from('vendors').select('business_name').eq('id', s(conv.vendor_id)).maybeSingle()
          : await this.db.from('users').select('first_name, last_name').eq('id', senderId).maybeSingle();
      const f = (from ?? {}) as Row;
      const who = s(f.business_name) || [s(f.first_name), s(f.last_name)].filter(Boolean).join(' ') || 'Someone';
      const link = senderRole === 'vendor' ? `${appUrl()}/dashboard/chats/${s(conv.id)}` : `${appUrl()}/vendor?tab=chats&chat=${s(conv.id)}`;
      await this.db.from('conversations').update({ last_notified_at: new Date().toISOString() }).eq('id', s(conv.id));
      await this.resend.emails.send({
        from: process.env.MESSAGE_FROM_EMAIL!,
        to: email,
        subject: `${who} sent you a message on Lazo`,
        text: `${who} wrote:\n\n${preview.slice(0, 500)}\n\nReply on Lazo: ${link}\n`,
      });
    } catch (err) {
      this.logger.warn(`Chat email alert failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = (async () => {
        const found = await this.db.storage.getBucket(CHAT_FILES_BUCKET);
        if (found.data) return;
        const created = await this.db.storage.createBucket(CHAT_FILES_BUCKET, { public: false, fileSizeLimit: MAX_CHAT_FILE_BYTES, allowedMimeTypes: Object.keys(FILE_EXT) });
        if (created.error && !/already exists/i.test(created.error.message)) throw new InternalServerErrorException(`Could not create the ${CHAT_FILES_BUCKET} bucket: ${created.error.message}`);
      })().catch((err) => {
        this.bucketReady = null;
        throw err;
      });
    }
    return this.bucketReady;
  }

  async close(caller: Caller, id: string) {
    await this.access(caller, id);
    const { error } = await this.db.from('conversations').update({ status: 'closed' }).eq('id', id);
    if (error) throw this.fail('Could not close the conversation', error);
    return this.thread(caller, id);
  }

  /**
   * Admin export for training: every message, one JSON object per line.
   * Sender ids are always hashed; `anonymize` also drops event and vendor ids.
   * Reads the JSONL files on disk (written as messages arrive); falls back to
   * the database for anything logged before CHAT_LOG_DIR existed.
   */
  async exportJsonl(anonymize: boolean): Promise<string> {
    const lines: string[] = [];
    try {
      for (const file of (await readdir(this.logDir)).filter((f) => f.endsWith('.jsonl')).sort()) {
        lines.push(...(await readFile(join(this.logDir, file), 'utf8')).split('\n').filter(Boolean));
      }
    } catch {
      // No log directory yet: nothing on disk.
    }
    if (!lines.length) {
      const { data, error } = await this.db
        .from('chat_messages')
        .select('*, conversations(kind, event_id, vendor_id)')
        .order('created_at', { ascending: true })
        .limit(20000);
      if (error) throw this.fail('Could not export', error);
      for (const m of (data as Row[]) ?? []) {
        const c = (m.conversations ?? {}) as Row;
        lines.push(JSON.stringify(this.record({ kind: s(c.kind), event_id: c.event_id, vendor_id: c.vendor_id, id: m.conversation_id }, m)));
      }
    }
    if (!anonymize) return lines.join('\n') + '\n';
    return (
      lines
        .map((l) => {
          try {
            const o = JSON.parse(l) as Row;
            delete o.eventId;
            delete o.vendorId;
            return JSON.stringify(o);
          } catch {
            return '';
          }
        })
        .filter(Boolean)
        .join('\n') + '\n'
    );
  }

  // ------------------------------------------------------------- internals

  /** Which role the caller has in this conversation, or 403. */
  private async access(caller: Caller, id: string): Promise<{ row: Row; role: Role }> {
    if (!UUID.test(id)) throw new NotFoundException('No such conversation');
    const { data, error } = await this.db.from('conversations').select('*').eq('id', id).maybeSingle();
    if (error) throw this.fail('Could not load the conversation', error);
    const row = data as Row | null;
    if (!row) throw new NotFoundException('No such conversation');
    if (row.customer_id === caller.userId) return { row, role: row.kind === 'guest' ? 'guest' : 'customer' };
    if (row.kind === 'vendor' && row.vendor_owner_id === caller.userId) return { row, role: 'vendor' };
    if (row.kind === 'guest' && row.host_id === caller.userId) return { row, role: 'host' };
    if (caller.isAdmin) return { row, role: 'admin' };
    throw new ForbiddenException('Not your conversation');
  }

  /** First names for account holders who wrote; visitors have none. */
  private async senderNames(rows: Row[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((m) => s(m.sender_id)).filter((id) => id && !id.startsWith('visitor:')))];
    if (!ids.length) return new Map();
    const { data } = await this.db.from('users').select('id, first_name').in('id', ids);
    return new Map(((data as Row[] | null) ?? []).map((u) => [s(u.id), s(u.first_name)]));
  }

  private async vendorOf(userId: string): Promise<{ id: string } | null> {
    if (userId.startsWith('visitor:')) return null;
    const { data } = await this.db.from('vendors').select('id').eq('owner_id', userId).maybeSingle();
    return data ? { id: s((data as Row).id) } : null;
  }

  /** Adds names, event names and unread counts for the caller. */
  private async decorate(rows: Row[], caller: Caller) {
    if (!rows.length) return [];
    const ids = rows.map((r) => s(r.id));
    const userIds = [...new Set(rows.flatMap((r) => [s(r.customer_id), s(r.vendor_owner_id), s(r.host_id)]).filter((id) => id && !id.startsWith('visitor:')))];
    const eventIds = [...new Set(rows.map((r) => s(r.event_id)).filter(Boolean))];
    const vendorIds = [...new Set(rows.map((r) => s(r.vendor_id)).filter(Boolean))];
    const [users, events, vendors, reads, recent] = await Promise.all([
      userIds.length ? this.db.from('users').select('id, first_name, last_name, email').in('id', userIds) : { data: [] },
      eventIds.length ? this.db.from('events').select('id, name').in('id', eventIds) : { data: [] },
      vendorIds.length ? this.db.from('vendors').select('id, business_name, logo_url').in('id', vendorIds) : { data: [] },
      this.db.from('conversation_reads').select('conversation_id, last_read_at, starred, archived').in('conversation_id', ids).eq('user_id', caller.userId),
      this.db.from('chat_messages').select('conversation_id, sender_id, created_at').in('conversation_id', ids).order('created_at', { ascending: false }).limit(2000),
    ]);
    const name = (u: Row) => [s(u.first_name), s(u.last_name)].filter(Boolean).join(' ') || s(u.email) || 'Guest';
    const userMap = new Map(((users.data as Row[] | null) ?? []).map((u) => [s(u.id), name(u)]));
    const eventMap = new Map(((events.data as Row[] | null) ?? []).map((e) => [s(e.id), s(e.name)]));
    const vendorMap = new Map(((vendors.data as Row[] | null) ?? []).map((v) => [s(v.id), { name: s(v.business_name), logoUrl: s(v.logo_url) }]));
    const readRows = (reads.data as Row[] | null) ?? [];
    const readMap = new Map(readRows.map((r) => [s(r.conversation_id), s(r.last_read_at)]));
    const flagMap = new Map(readRows.map((r) => [s(r.conversation_id), { starred: r.starred === true, archived: r.archived === true }]));
    const unread = new Map<string, number>();
    for (const m of (recent.data as Row[] | null) ?? []) {
      const cid = s(m.conversation_id);
      if (s(m.sender_id) === caller.userId) continue;
      const readAt = readMap.get(cid);
      if (!readAt || s(m.created_at) > readAt) unread.set(cid, (unread.get(cid) ?? 0) + 1);
    }

    return rows.map((r) => {
      const vendor = vendorMap.get(s(r.vendor_id));
      const mine =
        r.customer_id === caller.userId ? (r.kind === 'guest' ? 'guest' : 'customer') : r.vendor_owner_id === caller.userId ? 'vendor' : r.host_id === caller.userId ? 'host' : 'admin';
      // Whoever started it: an account holder's name, or what a visitor told us.
      const customer = userMap.get(s(r.customer_id)) ?? (s(r.visitor_name) || (r.kind === 'guest' ? 'Guest' : 'Visitor'));
      // What to call the thread from the caller's side.
      let title: string;
      if (r.kind === 'support') title = mine === 'customer' ? 'Lazo support' : customer;
      else if (r.kind === 'guest') title = mine === 'guest' ? `${eventMap.get(s(r.event_id)) ?? 'The hosts'}` : customer;
      else title = mine === 'customer' ? (vendor?.name ?? 'Vendor') : customer;
      return {
        id: s(r.id),
        kind: s(r.kind),
        status: s(r.status),
        eventId: s(r.event_id) || null,
        eventName: eventMap.get(s(r.event_id)) ?? null,
        vendorId: s(r.vendor_id) || null,
        vendorName: vendor?.name ?? null,
        vendorLogo: vendor?.logoUrl ?? '',
        customerName: customer,
        visitorEmail: s(r.visitor_email),
        title,
        subject: s(r.subject),
        lastMessageAt: s(r.last_message_at) || null,
        lastPreview: s(r.last_preview),
        messageCount: Number(r.message_count ?? 0),
        unread: unread.get(s(r.id)) ?? 0,
        starred: flagMap.get(s(r.id))?.starred ?? false,
        archived: flagMap.get(s(r.id))?.archived ?? false,
        myRole: mine,
        rating: typeof r.rating === 'number' ? r.rating : null,
        assignedTo: s(r.assigned_to) || null,
        visitorPage: s(r.visitor_page),
      };
    });
  }

  private record(conv: Row, m: Row) {
    return {
      conversationId: s(conv.id),
      kind: s(conv.kind),
      eventId: s(conv.event_id) || null,
      vendorId: s(conv.vendor_id) || null,
      messageId: s(m.id),
      senderRole: s(m.sender_role),
      sender: hashId(s(m.sender_id)),
      body: s(m.body),
      createdAt: s(m.created_at),
    };
  }

  /** Append the message to the conversation's JSONL file. Never fails the send. */
  private async log(conv: Row, m: Row) {
    try {
      await mkdir(this.logDir, { recursive: true });
      await appendFile(join(this.logDir, `${s(conv.id)}.jsonl`), JSON.stringify(this.record(conv, m)) + '\n', 'utf8');
    } catch (err) {
      this.logger.warn(`Could not write chat log: ${err instanceof Error ? err.message : err}`);
    }
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_TABLE) return new ServiceUnavailableException(`Chat tables are missing. Apply ${CHAT_MIGRATION}.`);
    if (error.code === UNDEFINED_COLUMN) return new ServiceUnavailableException(`Chat tables are out of date. Apply ${CHAT_MARKETPLACE_MIGRATION}.`);
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

/** Stable pseudonym for a user id in the training logs; not reversible without the secret. */
function hashId(id: string): string {
  const secret = process.env.CHAT_LOG_SALT || process.env.SUPABASE_SECRET_KEY || 'lazo';
  return createHmac('sha256', secret).update(id).digest('hex').slice(0, 16);
}

function toMessage(m: Row, me: string, signed: Map<string, string>): ChatMessage {
  const attachments = Array.isArray(m.attachments) ? (m.attachments as Row[]) : [];
  return {
    id: s(m.id),
    senderId: s(m.sender_id),
    senderRole: s(m.sender_role) as Role,
    mine: s(m.sender_id) === me,
    kind: s(m.kind) || 'text',
    body: s(m.body),
    attachments: attachments.map((a) => ({ path: s(a.path), name: s(a.name), size: Number(a.size ?? 0), type: s(a.type), url: signed.get(s(a.path)) })),
    quoteId: s(m.quote_id) || null,
    orderId: s(m.order_id) || null,
    flagged: m.flagged === true,
    createdAt: s(m.created_at),
  };
}

function money(centavos: number, currency = 'MXN'): string {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency, maximumFractionDigits: 2 }).format(centavos / 100);
}
