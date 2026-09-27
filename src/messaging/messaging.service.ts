import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Resend } from 'resend';
import twilio from 'twilio';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { tierAllows, TIERS_MIGRATION } from '../payments/payments.service.js';
import { siteUrlFor } from '../sites/site-config.js';
import { assertDailyQuota, DEDUPE_MINUTES, recentlyMessaged } from './send-quota.js';

const UNDEFINED_TABLE = 'PGRST205';
const UNDEFINED_COLUMN = '42703';
const MAX_RECIPIENTS = 500;
const AUDIENCES = ['all', 'awaiting', 'attending', 'declined'] as const;

type Row = Record<string, unknown>;
type Channel = 'email' | 'sms';
const s = (v: unknown) => (typeof v === 'string' ? v : '');

interface EventCtx {
  id: string;
  name: string;
  slug: string | null;
  date: string;
  tier: string | null;
  locale: string;
}

/**
 * Messages from a host to their guests: email through Resend, SMS through
 * Twilio. WhatsApp is a click-to-chat link per household on the guest list
 * (no API needed). Sending needs the Premium plan; the providers cost money
 * per message.
 *
 * Env: RESEND_API_KEY + MESSAGE_FROM_EMAIL ("Lazo <hola@yourdomain>");
 * TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM (an E.164 number or a
 * Messaging Service SID starting with MG).
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);
  private readonly resend: Resend | null;
  private readonly twilio: ReturnType<typeof twilio> | null;
  private readonly fromEmail = process.env.MESSAGE_FROM_EMAIL ?? '';
  private readonly fromSms = process.env.TWILIO_FROM ?? '';

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {
    this.resend = process.env.RESEND_API_KEY && this.fromEmail ? new Resend(process.env.RESEND_API_KEY) : null;
    this.twilio =
      process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && this.fromSms
        ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
        : null;
  }

  config() {
    return { email: Boolean(this.resend), sms: Boolean(this.twilio), whatsapp: 'link' as const };
  }

  async list(event: EventCtx) {
    const { data, error } = await this.db
      .from('messages')
      .select('*')
      .eq('event_id', event.id)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw this.fail('Could not load messages', error);
    return { messages: (data as Row[]).map(toMessage), providers: this.config(), allowed: tierAllows(event.tier, 'premium') };
  }

  /**
   * Who a message would reach: per audience and channel, how many households
   * have an address, and how many don't. So the host sees the gap before sending.
   */
  async preview(event: EventCtx, channel: unknown, audience: unknown) {
    const list = await this.recipients(event, parseChannel(channel), parseAudience(audience));
    return {
      reachable: list.filter((r) => r.to).length,
      missing: list.filter((r) => !r.to).map((r) => r.household.name),
    };
  }

  /** { channel, audience, subject?, body } — sends now and records each delivery. */
  async send(event: EventCtx, input: Row) {
    if (!tierAllows(event.tier, 'premium')) throw new ForbiddenException('Sending email and SMS needs the Premium plan.');
    const channel = parseChannel(input.channel);
    const audience = parseAudience(input.audience);
    if (channel === 'email' && !this.resend) throw new ServiceUnavailableException('Email is not set up (RESEND_API_KEY, MESSAGE_FROM_EMAIL).');
    if (channel === 'sms' && !this.twilio) throw new ServiceUnavailableException('SMS is not set up (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM).');

    const body = s(input.body).trim();
    const subject = s(input.subject).trim();
    if (body.length < 5) throw new BadRequestException('Write a message');
    if (body.length > 4000) throw new BadRequestException('Message must be 4000 characters or fewer');
    if (channel === 'email' && !subject) throw new BadRequestException('Give the email a subject');
    if (channel === 'sms' && body.length > 640) throw new BadRequestException('SMS must be 640 characters or fewer (about 4 segments)');

    const reachable = (await this.recipients(event, channel, audience)).filter((r) => r.to);
    if (!reachable.length) throw new BadRequestException('No one in that audience has an address for this channel yet.');
    if (reachable.length > MAX_RECIPIENTS) throw new BadRequestException(`Up to ${MAX_RECIPIENTS} recipients per message`);
    // A double-click or a retried form must not bill the provider twice.
    const recent = await recentlyMessaged(this.db, event.id, channel);
    const list = reachable.filter((r) => !recent.has(r.household.id));
    const skipped = reachable.length - list.length;
    if (!list.length) throw new BadRequestException(`Everyone in that audience already received a ${channel} in the last ${DEDUPE_MINUTES} minutes.`);
    await assertDailyQuota(this.db, event.id, event.tier, list.length);

    const { data: message, error } = await this.db
      .from('messages')
      .insert({ event_id: event.id, channel, audience, subject, body, recipients: list.length })
      .select('*')
      .single();
    if (error) throw this.fail('Could not save the message', error);
    const messageId = s((message as Row).id);

    let sent = 0;
    let failed = 0;
    for (const r of list) {
      const dedupe = `${messageId}:${r.household.id}`;
      const text = fill(body, r, event);
      const { data: delivery, error: dErr } = await this.db
        .from('message_deliveries')
        .insert({ event_id: event.id, message_id: messageId, household_id: r.household.id, channel, recipient: r.to, template: 'host_message', status: 'queued', dedupe_key: dedupe })
        .select('id')
        .single();
      if (dErr) {
        failed++;
        continue;
      }
      const deliveryId = s((delivery as Row).id);
      try {
        const ref = channel === 'email' ? await this.sendEmail(r.to, fill(subject, r, event), text) : await this.sendSms(r.to, text);
        await this.db.from('message_deliveries').update({ status: 'sent', provider_reference: ref, updated_at: new Date().toISOString() }).eq('id', deliveryId);
        await this.recordConsent(event.id, channel, r.to);
        sent++;
      } catch (err) {
        failed++;
        const reason = err instanceof Error ? err.message.slice(0, 300) : 'Send failed';
        await this.db.from('message_deliveries').update({ status: 'failed', failure_reason: reason, updated_at: new Date().toISOString() }).eq('id', deliveryId);
        this.logger.warn(`${channel} to household ${r.household.id} failed: ${reason}`);
      }
    }
    await this.db.from('messages').update({ sent, failed }).eq('id', messageId);
    return { ...(await this.list(event)), sent, failed, skipped };
  }

  // ------------------------------------------------------------- internals

  private async recipients(event: EventCtx, channel: Channel, audience: (typeof AUDIENCES)[number]) {
    const [households, guests, optOuts] = await Promise.all([
      this.db.from('households').select('*').eq('event_id', event.id).order('created_at'),
      this.db.from('guests').select('household_id, email').eq('event_id', event.id),
      this.db.from('message_consents').select('recipient').eq('event_id', event.id).eq('channel', channel).not('opted_out_at', 'is', null),
    ]);
    if (households.error) throw this.fail('Could not load the guest list', households.error);
    const blocked = new Set((optOuts.data as Row[] | null)?.map((r) => s(r.recipient)) ?? []);
    const firstEmail = new Map<string, string>();
    for (const g of (guests.data as Row[] | null) ?? []) {
      if (s(g.email) && !firstEmail.has(s(g.household_id))) firstEmail.set(s(g.household_id), s(g.email));
    }

    let rsvpStatus = new Map<string, string>();
    if (audience === 'attending' || audience === 'declined') {
      const { data } = await this.db.from('rsvps').select('guest_id, status').eq('event_id', event.id);
      const { data: g } = await this.db.from('guests').select('id, household_id').eq('event_id', event.id);
      const houseOf = new Map(((g as Row[] | null) ?? []).map((x) => [s(x.id), s(x.household_id)]));
      rsvpStatus = new Map();
      for (const r of (data as Row[] | null) ?? []) {
        const h = houseOf.get(s(r.guest_id));
        if (h && r.status === 'attending') rsvpStatus.set(h, 'attending');
        else if (h && !rsvpStatus.has(h) && r.status === 'declined') rsvpStatus.set(h, 'declined');
      }
    }

    return ((households.data as Row[]) ?? [])
      .filter((h) => {
        if (audience === 'awaiting') return !h.rsvp_submitted_at;
        if (audience === 'attending') return rsvpStatus.get(s(h.id)) === 'attending';
        if (audience === 'declined') return rsvpStatus.get(s(h.id)) === 'declined';
        return true;
      })
      .map((h) => {
        const raw = channel === 'email' ? s(h.email) || firstEmail.get(s(h.id)) || '' : toE164(s(h.phone));
        const to = raw && !blocked.has(raw) ? raw : '';
        return { household: { id: s(h.id), name: s(h.name), code: s(h.invite_code) }, to };
      });
  }

  private async sendEmail(to: string, subject: string, text: string): Promise<string> {
    const { data, error } = await this.resend!.emails.send({
      from: this.fromEmail,
      to,
      subject,
      text,
      html: toHtml(text),
    });
    if (error) throw new Error(error.message);
    return data?.id ?? '';
  }

  private async sendSms(to: string, text: string): Promise<string> {
    const params: { to: string; body: string; from?: string; messagingServiceSid?: string } = { to, body: text };
    if (this.fromSms.startsWith('MG')) params.messagingServiceSid = this.fromSms;
    else params.from = this.fromSms;
    const msg = await this.twilio!.messages.create(params);
    return msg.sid;
  }

  /** WA-1: a consent row per recipient, marked as coming from the host's guest list. */
  private async recordConsent(eventId: string, channel: Channel, recipient: string) {
    await this.db.from('message_consents').upsert(
      { event_id: eventId, channel, recipient, purpose: 'transactional', opted_in: true, source: 'host_guest_list', opted_in_at: new Date().toISOString() },
      { onConflict: 'channel,recipient,purpose,event_id', ignoreDuplicates: true },
    );
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_TABLE || error.code === UNDEFINED_COLUMN) {
      return new ServiceUnavailableException(`Messaging tables are missing. Apply ${TIERS_MIGRATION}.`);
    }
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

function parseChannel(v: unknown): Channel {
  if (v !== 'email' && v !== 'sms') throw new BadRequestException('channel must be email or sms');
  return v;
}

function parseAudience(v: unknown): (typeof AUDIENCES)[number] {
  const a = (v ?? 'all') as (typeof AUDIENCES)[number];
  if (!AUDIENCES.includes(a)) throw new BadRequestException('audience must be all, awaiting, attending or declined');
  return a;
}

/** {name}, {link}, {event}, {date} in the host's text. */
function fill(text: string, r: { household: { name: string; code: string } }, event: EventCtx): string {
  const site = event.slug ? siteUrlFor(event.slug) : '';
  const link = site ? `${site}/?rsvp=${r.household.code}` : '';
  const date = event.date ? new Date(`${event.date}T12:00:00`).toLocaleDateString(event.locale || 'es-MX', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  return text.replace(/\{name\}/g, r.household.name).replace(/\{link\}/g, link).replace(/\{event\}/g, event.name).replace(/\{date\}/g, date);
}

/** Mexican numbers without a country code get +52. Anything unparseable is dropped. */
export function toE164(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (!digits) return '';
  // "+52 1 55…" and "521 55…" are the old mobile format; the 1 is dropped today.
  const legacy = digits.replace(/^\+?521(\d{10})$/, '+52$1');
  if (legacy.startsWith('+')) return /^\+\d{8,15}$/.test(legacy) ? legacy : '';
  if (/^52\d{10}$/.test(legacy)) return `+${legacy}`;
  if (/^\d{10}$/.test(legacy)) return `+52${legacy}`;
  return '';
}

function toHtml(text: string): string {
  const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const linked = esc.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>');
  return `<div style="font-family:Inter,Arial,sans-serif;font-size:16px;line-height:1.6;color:#111">${linked.replace(/\n/g, '<br>')}</div>`;
}

function toMessage(r: Row) {
  return {
    id: s(r.id),
    channel: s(r.channel),
    audience: s(r.audience),
    subject: s(r.subject),
    body: s(r.body),
    recipients: Number(r.recipients ?? 0),
    sent: Number(r.sent ?? 0),
    failed: Number(r.failed ?? 0),
    createdAt: s(r.created_at),
  };
}
