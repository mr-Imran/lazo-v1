import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { tierAllows } from '../payments/payments.service.js';
import { assertDailyQuota, DEDUPE_MINUTES, recentlyMessaged } from '../messaging/send-quota.js';
import { toE164 } from '../messaging/messaging.service.js';
import { siteUrlFor } from '../sites/site-config.js';

export const WHATSAPP_MIGRATION = 'supabase/migrations/20261010000000_whatsapp.sql';
const GRAPH = 'https://graph.facebook.com/v21.0';
const UNDEFINED_TABLE = 'PGRST205';
const UNDEFINED_COLUMN = '42703';
const MAX_RECIPIENTS = 500;
const SEND_GAP_MS = 150;
const AUDIENCES = ['all', 'awaiting', 'attending', 'declined'] as const;
/** Meta error codes we treat as final for this recipient (no retry). */
const FINAL_ERRORS: Record<number, string> = {
  131047: 'Re-engagement message: more than 24 hours since the guest last wrote to us',
  131026: 'This number is not on WhatsApp',
  131049: 'Meta chose not to deliver to keep the guest’s experience healthy',
  131050: 'The guest has stopped receiving marketing messages',
  132000: 'Wrong number of template parameters',
  132001: 'Template does not exist or is not approved in this language',
};
const STATUS_RANK: Record<string, number> = { accepted: 0, sent: 1, delivered: 2, read: 3, failed: 9 };
const OPT_OUT_WORDS = new Set(['stop', 'baja', 'alto', 'cancelar', 'unsubscribe']);
/** Values the server can fill without the host typing anything. */
const KNOWN_PARAMS = ['guest_name', 'event_name', 'event_date', 'rsvp_url', 'invite_code', 'venue'] as const;

type Row = Record<string, unknown>;
type Audience = (typeof AUDIENCES)[number];
const s = (v: unknown) => (typeof v === 'string' ? v : '');

interface EventCtx {
  id: string;
  name: string;
  slug: string | null;
  date: string;
  location: string;
  tier: string | null;
  locale: string;
}

export interface WaTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  body: string;
  params: string[];
  sampleParams: string[];
  status: string;
  metaTemplateId: string;
  rejectedReason: string;
  syncedAt: string | null;
  submittedAt: string | null;
}

/**
 * WhatsApp through Meta's Business Cloud API (PRD 6.4). Sends are template
 * messages only, to households that consented, and every send is a
 * message_deliveries row whose wa_status the webhook keeps current.
 *
 * Env: WHATSAPP_ACCESS_TOKEN (system-user token), WHATSAPP_PHONE_NUMBER_ID,
 * WHATSAPP_BUSINESS_ACCOUNT_ID; the webhook needs WHATSAPP_WEBHOOK_VERIFY_TOKEN
 * and WHATSAPP_APP_SECRET. Meta's template approval is an external dependency:
 * templates stay "pending" here until a sync says Meta approved them.
 */
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly token = process.env.WHATSAPP_ACCESS_TOKEN ?? '';
  private readonly phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
  private readonly wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '';
  private readonly verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? '';
  private readonly appSecret = process.env.WHATSAPP_APP_SECRET ?? '';

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  /** Which env vars are set. Booleans only; safe to expose. */
  config() {
    const missing = [
      ['WHATSAPP_ACCESS_TOKEN', this.token],
      ['WHATSAPP_PHONE_NUMBER_ID', this.phoneId],
      ['WHATSAPP_BUSINESS_ACCOUNT_ID', this.wabaId],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    const webhookMissing = [
      ['WHATSAPP_WEBHOOK_VERIFY_TOKEN', this.verifyToken],
      ['WHATSAPP_APP_SECRET', this.appSecret],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    return { configured: missing.length === 0, missing, webhook: webhookMissing.length === 0, webhookMissing };
  }

  private assertConfigured() {
    const c = this.config();
    if (!c.configured) throw new ServiceUnavailableException(`WhatsApp is not set up (${c.missing.join(', ')}).`);
  }

  // ============================================================ host

  /** Everything the host's WhatsApp page needs. */
  async overview(event: EventCtx) {
    const [templates, messages] = await Promise.all([this.templates(), this.messages(event.id)]);
    const ids = messages.map((m) => m.id);
    const deliveries = ids.length ? await this.deliveries(event.id, ids) : [];
    return {
      config: this.config(),
      allowed: tierAllows(event.tier, 'premium'),
      templates: templates.filter((t) => t.status === 'approved'),
      pendingTemplates: templates.filter((t) => t.status !== 'approved').length,
      messages,
      deliveries,
    };
  }

  /**
   * Who a template send would reach, and the first recipient's rendered text
   * so the host sees real substitution before sending.
   */
  async preview(event: EventCtx, templateId: unknown, audience: unknown, values: Row = {}) {
    const template = await this.template(s(templateId));
    const list = await this.recipients(event, parseAudience(audience));
    const reachable = list.filter((r) => r.to && r.consent);
    const first = reachable[0];
    return {
      reachable: reachable.length,
      noConsent: list.filter((r) => r.to && !r.consent).map((r) => r.name),
      missing: list.filter((r) => !r.to).map((r) => r.name),
      sample: first ? { household: first.name, params: this.params(template, first, event, values), text: render(template.body, this.params(template, first, event, values)) } : null,
    };
  }

  /** { templateId, audience, values? } — sends now, one household at a time. */
  async send(event: EventCtx, input: Row) {
    if (!tierAllows(event.tier, 'premium')) throw new ForbiddenException('Sending WhatsApp messages needs the Premium plan.');
    this.assertConfigured();
    const template = await this.template(s(input.templateId));
    if (template.status !== 'approved') throw new BadRequestException(`Template "${template.name}" is not approved by Meta yet (${template.status}).`);
    const audience = parseAudience(input.audience);
    const values = typeof input.values === 'object' && input.values !== null ? (input.values as Row) : {};

    const reachable = (await this.recipients(event, audience)).filter((r) => r.to && r.consent);
    if (!reachable.length) throw new BadRequestException('No one in that audience has a phone and WhatsApp consent yet.');
    if (reachable.length > MAX_RECIPIENTS) throw new BadRequestException(`Up to ${MAX_RECIPIENTS} recipients per message`);
    // A double-click or a retried form must not bill Meta twice.
    const recent = await recentlyMessaged(this.db, event.id, 'whatsapp');
    const list = reachable.filter((r) => !recent.has(r.id));
    const skipped = reachable.length - list.length;
    if (!list.length) throw new BadRequestException(`Everyone in that audience already received a WhatsApp in the last ${DEDUPE_MINUTES} minutes.`);
    await assertDailyQuota(this.db, event.id, event.tier, list.length);
    // Every param must resolve for the first recipient, or Meta rejects all of them.
    for (const p of template.params) {
      if (!KNOWN_PARAMS.includes(p as (typeof KNOWN_PARAMS)[number]) && !s(values[p]).trim()) {
        throw new BadRequestException(`Give a value for "${p}"`);
      }
    }

    const { data: message, error } = await this.db
      .from('messages')
      .insert({ event_id: event.id, channel: 'whatsapp', audience, subject: template.name, body: template.body, recipients: list.length, template_id: template.id })
      .select('*')
      .single();
    if (error) throw this.fail('Could not save the message', error);
    const messageId = s((message as Row).id);

    let sent = 0;
    let failed = 0;
    for (const r of list) {
      const params = this.params(template, r, event, values);
      const dedupe = `${messageId}:${r.id}`;
      const { data: delivery, error: dErr } = await this.db
        .from('message_deliveries')
        .insert({ event_id: event.id, message_id: messageId, household_id: r.id, channel: 'whatsapp', recipient: r.to, template: template.name, status: 'queued', dedupe_key: dedupe })
        .select('id')
        .single();
      if (dErr) {
        failed++;
        this.logger.warn(`delivery row for household ${r.id} failed: ${dErr.message}`);
        continue;
      }
      const deliveryId = s((delivery as Row).id);
      const now = new Date().toISOString();
      try {
        const waId = await this.sendTemplate(r.to, template, params);
        await this.db
          .from('message_deliveries')
          .update({ status: 'sent', provider_reference: waId, wa_message_id: waId, wa_status: 'accepted', wa_status_at: now, updated_at: now })
          .eq('id', deliveryId);
        sent++;
      } catch (err) {
        failed++;
        const e = err instanceof MetaError ? err : new MetaError(0, err instanceof Error ? err.message : 'Send failed');
        await this.db
          .from('message_deliveries')
          .update({ status: 'failed', failure_reason: e.title.slice(0, 300), wa_status: 'failed', wa_error_code: e.code || null, wa_error_title: e.title.slice(0, 300), wa_status_at: now, updated_at: now })
          .eq('id', deliveryId);
        this.logger.warn(`WhatsApp to household ${r.id} failed (${e.code}): ${e.title}`);
      }
      await sleep(SEND_GAP_MS);
    }
    await this.db.from('messages').update({ sent, failed }).eq('id', messageId);
    return { ...(await this.overview(event)), sent, failed, skipped };
  }

  /** Host marks consent for a household by hand (they asked in person). */
  async setConsent(event: EventCtx, householdId: string, consent: unknown) {
    if (typeof consent !== 'boolean') throw new BadRequestException('consent must be true or false');
    const now = new Date().toISOString();
    const patch = consent
      ? { whatsapp_consent: true, whatsapp_consent_at: now, whatsapp_consent_source: 'host', whatsapp_opted_out_at: null, updated_at: now }
      : { whatsapp_consent: false, whatsapp_consent_source: 'host', updated_at: now };
    const { data, error } = await this.db.from('households').update(patch).eq('id', householdId).eq('event_id', event.id).select('id, whatsapp_consent, whatsapp_consent_at, whatsapp_consent_source, whatsapp_opted_out_at').maybeSingle();
    if (error) throw this.fail('Could not save consent', error);
    if (!data) throw new NotFoundException('No such invitation');
    const h = data as Row;
    return { id: s(h.id), whatsappConsent: h.whatsapp_consent === true, whatsappConsentAt: s(h.whatsapp_consent_at) || null, whatsappConsentSource: s(h.whatsapp_consent_source), whatsappOptedOutAt: s(h.whatsapp_opted_out_at) || null };
  }

  // ============================================================ admin

  async adminOverview() {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [templates, failures] = await Promise.all([
      this.templates(),
      this.db
        .from('message_deliveries')
        .select('id, event_id, recipient, template, wa_error_code, wa_error_title, failure_reason, wa_status_at, created_at')
        .eq('channel', 'whatsapp')
        .eq('status', 'failed')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(200),
    ]);
    if (failures.error) throw this.fail('Could not load failures', failures.error);
    return {
      config: this.config(),
      templates,
      failures: ((failures.data as Row[] | null) ?? []).map((d) => ({
        id: s(d.id),
        eventId: s(d.event_id),
        recipient: maskPhone(s(d.recipient)),
        template: s(d.template),
        errorCode: typeof d.wa_error_code === 'number' ? d.wa_error_code : null,
        errorTitle: s(d.wa_error_title) || s(d.failure_reason),
        at: s(d.wa_status_at) || s(d.created_at),
      })),
    };
  }

  /** GET /<WABA_ID>/message_templates and record each known template's Meta status. */
  async syncTemplates() {
    this.assertConfigured();
    const templates = await this.templates();
    const remote: Row[] = [];
    let url: string | null = `${GRAPH}/${this.wabaId}/message_templates?fields=id,name,language,status,category,rejected_reason&limit=100`;
    while (url) {
      const page = (await this.graph(url)) as Row;
      remote.push(...((page.data as Row[] | undefined) ?? []));
      const paging = page.paging as Row | undefined;
      url = s(paging?.next) || null;
    }
    const now = new Date().toISOString();
    let updated = 0;
    for (const t of templates) {
      const r = remote.find((x) => s(x.name) === t.name && s(x.language) === t.language);
      if (!r) continue;
      const { error } = await this.db
        .from('whatsapp_templates')
        .update({ status: metaStatus(s(r.status)), meta_template_id: s(r.id), rejected_reason: s(r.rejected_reason).slice(0, 500), synced_at: now, updated_at: now })
        .eq('id', t.id);
      if (error) throw this.fail('Could not save template status', error);
      updated++;
    }
    return { synced: updated, remote: remote.length, templates: await this.templates() };
  }

  /** POST create the template at Meta. It comes back PENDING until reviewed. */
  async submitTemplate(id: string) {
    this.assertConfigured();
    const t = await this.template(id);
    if (t.params.length !== t.sampleParams.length) throw new BadRequestException('Give one sample value per parameter (Meta needs examples).');
    const body: Row = {
      name: t.name,
      language: t.language,
      category: t.category,
      components: [{ type: 'BODY', text: t.body, ...(t.params.length ? { example: { body_text: [t.sampleParams] } } : {}) }],
    };
    const res = (await this.graph(`${GRAPH}/${this.wabaId}/message_templates`, body)) as Row;
    const now = new Date().toISOString();
    const { error } = await this.db
      .from('whatsapp_templates')
      .update({ meta_template_id: s(res.id), status: metaStatus(s(res.status) || 'PENDING'), rejected_reason: '', submitted_at: now, synced_at: now, updated_at: now })
      .eq('id', t.id);
    if (error) throw this.fail('Could not record the submission', error);
    return { templates: await this.templates() };
  }

  // ============================================================ webhook

  /** Meta's subscription handshake: echo hub.challenge when the verify token matches. */
  verify(mode: unknown, token: unknown, challenge: unknown): string {
    if (!this.verifyToken) throw new ServiceUnavailableException('WHATSAPP_WEBHOOK_VERIFY_TOKEN is not set');
    if (mode !== 'subscribe' || token !== this.verifyToken || typeof challenge !== 'string') throw new ForbiddenException('Bad verify token');
    return challenge;
  }

  /** Status updates, inbound opt-outs and template review results. */
  async webhook(rawBody: Buffer | undefined, signature: string | undefined) {
    if (!this.appSecret) throw new ServiceUnavailableException('WHATSAPP_APP_SECRET is not set');
    if (!rawBody) throw new BadRequestException('Empty body');
    const expected = `sha256=${createHmac('sha256', this.appSecret).update(rawBody).digest('hex')}`;
    const given = signature ?? '';
    if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      throw new ForbiddenException('Bad signature');
    }
    let payload: Row;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Row;
    } catch {
      throw new BadRequestException('Body is not JSON');
    }
    for (const entry of (payload.entry as Row[] | undefined) ?? []) {
      for (const change of (entry.changes as Row[] | undefined) ?? []) {
        const value = (change.value as Row | undefined) ?? {};
        if (change.field === 'messages') {
          for (const st of (value.statuses as Row[] | undefined) ?? []) await this.applyStatus(st);
          for (const msg of (value.messages as Row[] | undefined) ?? []) await this.applyInbound(msg);
        } else if (change.field === 'message_template_status_update') {
          await this.applyTemplateUpdate(value);
        }
      }
    }
    return { received: true };
  }

  private async applyStatus(st: Row) {
    const waId = s(st.id);
    const status = s(st.status).toLowerCase();
    if (!waId || !(status in STATUS_RANK)) return;
    const { data } = await this.db.from('message_deliveries').select('id, wa_status').eq('wa_message_id', waId).maybeSingle();
    if (!data) return;
    const row = data as Row;
    // Meta can deliver out of order; never step a "read" back to "delivered".
    if ((STATUS_RANK[s(row.wa_status)] ?? -1) >= STATUS_RANK[status]! && status !== 'failed') return;
    const firstError = ((st.errors as Row[] | undefined) ?? [])[0];
    const ts = typeof st.timestamp === 'string' || typeof st.timestamp === 'number' ? new Date(Number(st.timestamp) * 1000).toISOString() : new Date().toISOString();
    const patch: Row = { wa_status: status, wa_status_at: ts, updated_at: new Date().toISOString() };
    if (status === 'failed') {
      const code = Number(firstError?.code ?? 0) || null;
      const title = FINAL_ERRORS[code ?? 0] || s(firstError?.title) || s(firstError?.message) || 'Delivery failed';
      Object.assign(patch, { status: 'failed', wa_error_code: code, wa_error_title: title.slice(0, 300), failure_reason: title.slice(0, 300) });
    } else if (status === 'delivered' || status === 'read') {
      patch.status = status;
    }
    await this.db.from('message_deliveries').update(patch).eq('id', s(row.id));
  }

  /** A guest wrote back. "STOP"/"BAJA"/"ALTO" opts their household out. */
  private async applyInbound(msg: Row) {
    if (msg.type !== 'text') return;
    const text = s((msg.text as Row | undefined)?.body).trim().toLowerCase();
    if (!OPT_OUT_WORDS.has(text)) return;
    const from = `+${s(msg.from).replace(/\D/g, '')}`;
    const now = new Date().toISOString();
    // Households we have sent to at this number, plus any whose stored phone
    // normalises to it. The last 10 digits are the Mexican national number.
    const { data: sentTo } = await this.db.from('message_deliveries').select('household_id').eq('channel', 'whatsapp').eq('recipient', from);
    const ids = new Set(((sentTo as Row[] | null) ?? []).map((d) => s(d.household_id)).filter(Boolean));
    const { data: byPhone } = await this.db.from('households').select('id, phone').ilike('phone', `%${from.slice(-10)}%`);
    for (const h of (byPhone as Row[] | null) ?? []) if (toE164(s(h.phone)) === from) ids.add(s(h.id));
    if (ids.size) {
      await this.db.from('households').update({ whatsapp_opted_out_at: now, whatsapp_consent: false, updated_at: now }).in('id', [...ids]);
    }
    // Also the channel-wide consent ledger the other channels use.
    await this.db.from('message_consents').insert({ channel: 'whatsapp', recipient: from, purpose: 'transactional', opted_in: false, source: 'inbound_stop', opted_out_at: now });
    this.logger.log(`WhatsApp opt-out from ${maskPhone(from)} (${ids.size} household(s))`);
  }

  private async applyTemplateUpdate(value: Row) {
    const name = s(value.message_template_name);
    const language = s(value.message_template_language);
    const status = metaStatus(s(value.event));
    if (!name || !language) return;
    await this.db
      .from('whatsapp_templates')
      .update({ status, meta_template_id: s(value.message_template_id), rejected_reason: s(value.reason).slice(0, 500), synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('name', name)
      .eq('language', language);
  }

  // ============================================================ Meta calls

  /** POST /<PHONE_NUMBER_ID>/messages with a template; returns Meta's message id. */
  private async sendTemplate(to: string, template: WaTemplate, params: string[]): Promise<string> {
    const body: Row = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        ...(params.length ? { components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] } : {}),
      },
    };
    const res = (await this.graph(`${GRAPH}/${this.phoneId}/messages`, body)) as Row;
    const id = s(((res.messages as Row[] | undefined) ?? [])[0]?.id);
    if (!id) throw new MetaError(0, 'Meta accepted the request without a message id');
    return id;
  }

  private async graph(url: string, body?: Row): Promise<unknown> {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as Row;
    if (!res.ok || json.error) {
      const err = (json.error as Row | undefined) ?? {};
      const code = Number(err.code ?? 0);
      const detail = s((err.error_data as Row | undefined)?.details);
      throw new MetaError(code, FINAL_ERRORS[code] || detail || s(err.message) || `Meta returned ${res.status}`);
    }
    return json;
  }

  // ============================================================ data

  private async templates(): Promise<WaTemplate[]> {
    const { data, error } = await this.db.from('whatsapp_templates').select('*').order('created_at');
    if (error) throw this.fail('Could not load WhatsApp templates', error);
    return (data as Row[]).map(toTemplate);
  }

  private async template(id: string): Promise<WaTemplate> {
    if (!id) throw new BadRequestException('Pick a template');
    const { data, error } = await this.db.from('whatsapp_templates').select('*').eq('id', id).maybeSingle();
    if (error) throw this.fail('Could not load the template', error);
    if (!data) throw new NotFoundException('No such template');
    return toTemplate(data as Row);
  }

  private async messages(eventId: string) {
    const { data, error } = await this.db.from('messages').select('*').eq('event_id', eventId).eq('channel', 'whatsapp').order('created_at', { ascending: false }).limit(50);
    if (error) throw this.fail('Could not load messages', error);
    return (data as Row[]).map((r) => ({
      id: s(r.id),
      templateId: s(r.template_id) || null,
      templateName: s(r.subject),
      audience: s(r.audience),
      body: s(r.body),
      recipients: Number(r.recipients ?? 0),
      sent: Number(r.sent ?? 0),
      failed: Number(r.failed ?? 0),
      createdAt: s(r.created_at),
    }));
  }

  private async deliveries(eventId: string, messageIds: string[]) {
    const [{ data, error }, households] = await Promise.all([
      this.db.from('message_deliveries').select('*').eq('event_id', eventId).eq('channel', 'whatsapp').in('message_id', messageIds).order('created_at', { ascending: false }).limit(1000),
      this.db.from('households').select('id, name').eq('event_id', eventId),
    ]);
    if (error) throw this.fail('Could not load deliveries', error);
    const names = new Map(((households.data as Row[] | null) ?? []).map((h) => [s(h.id), s(h.name)]));
    return (data as Row[]).map((d) => ({
      id: s(d.id),
      messageId: s(d.message_id),
      household: names.get(s(d.household_id)) ?? '—',
      recipient: maskPhone(s(d.recipient)),
      status: s(d.wa_status) || s(d.status),
      errorCode: typeof d.wa_error_code === 'number' ? d.wa_error_code : null,
      errorTitle: s(d.wa_error_title) || s(d.failure_reason),
      at: s(d.wa_status_at) || s(d.updated_at) || s(d.created_at),
    }));
  }

  /** Households in the audience with their E.164 phone and consent state. */
  private async recipients(event: EventCtx, audience: Audience) {
    const { data, error } = await this.db.from('households').select('*').eq('event_id', event.id).order('created_at');
    if (error) throw this.fail('Could not load the guest list', error);
    const rows = (data as Row[]) ?? [];
    if (rows.length && !('whatsapp_consent' in rows[0]!)) throw new ServiceUnavailableException(`WhatsApp consent columns are missing. Apply ${WHATSAPP_MIGRATION}.`);

    let rsvpStatus = new Map<string, string>();
    if (audience === 'attending' || audience === 'declined') {
      const [{ data: rsvps }, { data: guests }] = await Promise.all([
        this.db.from('rsvps').select('guest_id, status').eq('event_id', event.id),
        this.db.from('guests').select('id, household_id').eq('event_id', event.id),
      ]);
      const houseOf = new Map(((guests as Row[] | null) ?? []).map((g) => [s(g.id), s(g.household_id)]));
      rsvpStatus = new Map();
      for (const r of (rsvps as Row[] | null) ?? []) {
        const h = houseOf.get(s(r.guest_id));
        if (h && r.status === 'attending') rsvpStatus.set(h, 'attending');
        else if (h && !rsvpStatus.has(h) && r.status === 'declined') rsvpStatus.set(h, 'declined');
      }
    }

    return rows
      .filter((h) => {
        if (audience === 'awaiting') return !h.rsvp_submitted_at;
        if (audience === 'attending') return rsvpStatus.get(s(h.id)) === 'attending';
        if (audience === 'declined') return rsvpStatus.get(s(h.id)) === 'declined';
        return true;
      })
      .map((h) => ({
        id: s(h.id),
        name: s(h.name),
        code: s(h.invite_code),
        to: toE164(s(h.phone)),
        consent: h.whatsapp_consent === true && !h.whatsapp_opted_out_at,
      }));
  }

  /** The template's parameters in order, filled for one household. */
  private params(template: WaTemplate, r: { name: string; code: string }, event: EventCtx, values: Row): string[] {
    const site = event.slug ? siteUrlFor(event.slug) : '';
    const date = event.date ? new Date(`${event.date}T12:00:00`).toLocaleDateString(event.locale || 'es-MX', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    const known: Record<string, string> = {
      guest_name: r.name,
      event_name: event.name,
      event_date: date,
      rsvp_url: site ? `${site}/?rsvp=${r.code}` : '',
      invite_code: r.code,
      venue: event.location,
    };
    // Meta rejects newlines, tabs and 4+ spaces inside a parameter.
    return template.params.map((p) => (known[p] ?? s(values[p])).replace(/\s+/g, ' ').trim().slice(0, 1024));
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_TABLE || error.code === UNDEFINED_COLUMN) {
      return new ServiceUnavailableException(`WhatsApp tables are missing. Apply ${WHATSAPP_MIGRATION}.`);
    }
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

class MetaError extends Error {
  constructor(
    readonly code: number,
    readonly title: string,
  ) {
    super(title);
  }
}

function parseAudience(v: unknown): Audience {
  const a = (v ?? 'all') as Audience;
  if (!AUDIENCES.includes(a)) throw new BadRequestException('audience must be all, awaiting, attending or declined');
  return a;
}

/** Meta reports APPROVED / PENDING / REJECTED / PAUSED / DISABLED / IN_APPEAL… */
function metaStatus(v: string): WaTemplate['status'] {
  const u = v.toUpperCase();
  if (u === 'APPROVED') return 'approved';
  if (u === 'REJECTED' || u === 'DISABLED') return 'rejected';
  if (u === 'PAUSED') return 'paused';
  return 'pending';
}

/** {{1}}..{{n}} → the params, for previews. */
export function render(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? '');
}

/** +52 55 1234 5678 → +52•••••5678, for logs and the admin table. */
function maskPhone(phone: string): string {
  return phone.length > 6 ? `${phone.slice(0, 3)}•••••${phone.slice(-4)}` : phone;
}

function toTemplate(r: Row): WaTemplate {
  const strings = (v: unknown) => (Array.isArray(v) ? v.map((x) => s(x)) : []);
  return {
    id: s(r.id),
    name: s(r.name),
    language: s(r.language),
    category: s(r.category),
    body: s(r.body),
    params: strings(r.params),
    sampleParams: strings(r.sample_params),
    status: s(r.status),
    metaTemplateId: s(r.meta_template_id),
    rejectedReason: s(r.rejected_reason),
    syncedAt: s(r.synced_at) || null,
    submittedAt: s(r.submitted_at) || null,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
