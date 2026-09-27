import {
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { notifyPartner, verify } from './partner-notify.js';
import { assertPublicHost } from '../vendors/product-scraper.js';
import type { NotificationResult, Partner } from './partner-notify.js';

export const FULFILMENT_MIGRATION = 'supabase/migrations/20261011000000_retailers_fulfilment.sql';
const UNDEFINED_TABLE = 'PGRST205';
const UNDEFINED_COLUMN = '42703';
const UUID = /^[0-9a-f-]{36}$/i;
export const CATEGORIES = ['print', 'flowers', 'travel'] as const;
export const ORDER_STATUSES = ['submitted', 'confirmed', 'in_production', 'shipped', 'delivered', 'cancelled', 'rejected'] as const;
const PAYMENT_STATUSES = ['unpaid', 'paid', 'refunded'] as const;
const MAX_OPEN_ORDERS = 5;
const MAX_QUANTITY = 500;

/** Statuses a partner may set, and from which ones. */
const PARTNER_MOVES: Record<string, readonly string[]> = {
  confirmed: ['submitted'],
  rejected: ['submitted', 'confirmed'],
  in_production: ['confirmed'],
  shipped: ['confirmed', 'in_production'],
  delivered: ['confirmed', 'in_production', 'shipped'],
};
const CANCELLABLE = ['submitted', 'confirmed'];
const TERMINAL = ['delivered', 'cancelled', 'rejected'];

type Row = Record<string, unknown>;
type Category = (typeof CATEGORIES)[number];
const s = (v: unknown) => (typeof v === 'string' ? v : '');

interface EventCtx {
  id: string;
  ownerId: string;
  name: string;
  location: string;
}

export interface PartnerProduct {
  key: string;
  name: string;
  priceCentavos: number;
  unit: string;
  leadDays: number;
}

/** "Ciudad de México" and "CDMX " compare equal to "ciudad de mexico" / "cdmx". */
export function normCity(v: unknown): string {
  return s(v)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Print, flowers and travel through contracted partners (PRD §6.3). A host
 * can only order what a partner actually delivers in their city; anything
 * else stays a manual concierge request. Every status change is kept in the
 * order's timeline; partners report through a signed endpoint or by mail to
 * ops, who update it in the admin.
 */
@Injectable()
export class FulfilmentService {
  private readonly logger = new Logger(FulfilmentService.name);
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  // ---------------------------------------------------------------- host

  /** Cities any active partner covers, so the host picks from real options. */
  async cities(): Promise<string[]> {
    const partners = await this.activePartners();
    const seen = new Map<string, string>();
    for (const p of partners) for (const c of p.coverage) if (!seen.has(normCity(c))) seen.set(normCity(c), c);
    return [...seen.values()].sort((a, b) => a.localeCompare(b, 'es'));
  }

  /** What is orderable in a city: partners with their products, per category. */
  async options(city: unknown) {
    const wanted = normCity(city);
    const partners = (await this.activePartners()).filter((p) => wanted && p.coverage.some((c) => normCity(c) === wanted));
    return {
      city: s(city).trim(),
      cities: await this.cities(),
      partners: partners.map((p) => ({ id: p.id, name: p.name, category: p.category, products: p.products, terms: p.terms, notifyVia: p.notifyVia })),
    };
  }

  async list(event: EventCtx) {
    const { data, error } = await this.db.from('fulfilment_orders').select('*, fulfilment_partners(name)').eq('event_id', event.id).order('created_at', { ascending: false });
    if (error) throw this.fail('Could not load your orders', error);
    return { orders: (data as Row[]).map(toOrder), cities: await this.cities(), eventCity: event.location };
  }

  /** { partnerId, productKey, quantity, city, deliveryAddress?, neededBy?, notes? } */
  async create(event: EventCtx, input: Row, statusUrlFor: (orderId: string) => string) {
    const partner = await this.partner(s(input.partnerId));
    if (!partner.active) throw new BadRequestException('That partner is not taking orders');
    const city = s(input.city).trim().slice(0, 80);
    if (!city) throw new BadRequestException('Choose the delivery city');
    if (!partner.coverage.some((c) => normCity(c) === normCity(city))) throw new BadRequestException(`${partner.name} does not deliver to ${city}`);
    const product = partner.products.find((p) => p.key === s(input.productKey));
    if (!product) throw new BadRequestException('Choose a product this partner offers');
    const quantity = Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) throw new BadRequestException(`Quantity must be 1–${MAX_QUANTITY}`);
    const address = s(input.deliveryAddress).trim().slice(0, 400);
    if (partner.category !== 'travel' && !address) throw new BadRequestException('Add a delivery address');
    const notes = s(input.notes).trim().slice(0, 3000);
    if (partner.category === 'travel' && notes.length < 10) throw new BadRequestException('Describe the trip: dates, travellers, cities');
    let neededBy: string | null = null;
    if (s(input.neededBy)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s(input.neededBy))) throw new BadRequestException('neededBy must be YYYY-MM-DD');
      neededBy = s(input.neededBy);
      const earliest = new Date();
      earliest.setDate(earliest.getDate() + product.leadDays);
      if (new Date(`${neededBy}T12:00:00`) < earliest) throw new BadRequestException(`${product.name} needs ${product.leadDays} days of lead time`);
    }

    // Each order costs a partner notification; a runaway client must not open dozens.
    const { count: open } = await this.db
      .from('fulfilment_orders')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', event.id)
      .in('status', ['submitted', 'confirmed']);
    if ((open ?? 0) >= MAX_OPEN_ORDERS) {
      throw new ConflictException(`This event already has ${MAX_OPEN_ORDERS} open orders. Wait for one to be delivered or cancel it first.`);
    }

    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from('fulfilment_orders')
      .insert({
        partner_id: partner.id,
        event_id: event.id,
        owner_id: event.ownerId,
        category: partner.category,
        product_key: product.key,
        product_name: product.name,
        quantity,
        delivery_address: address,
        city,
        needed_by: neededBy,
        notes,
        amount_centavos: product.priceCentavos * quantity,
        currency: 'MXN',
        status: 'submitted',
        timeline: [{ status: 'submitted', at: now, by: 'host', note: '' }],
      })
      .select('*')
      .single();
    if (error) throw this.fail('Could not place the order', error);
    const order = data as Row;
    const orderId = s(order.id);

    // The partner's mail server or webhook may be slow; the host's request
    // does not wait for it. The result lands on the row when it resolves.
    void notifyPartner(partner, {
      kind: 'order.created',
      orderId,
      eventName: event.name,
      category: partner.category,
      productKey: product.key,
      productName: product.name,
      quantity,
      city,
      deliveryAddress: address,
      neededBy,
      notes,
      amountCentavos: product.priceCentavos * quantity,
      currency: 'MXN',
      statusUrl: statusUrlFor(orderId),
    })
      .then((notification) => this.db.from('fulfilment_orders').update({ notification, updated_at: new Date().toISOString() }).eq('id', orderId))
      .then(({ error: nErr }) => {
        if (nErr) this.logger.warn(`Could not store the partner notification for order ${orderId}: ${nErr.message}`);
      })
      .catch((err: unknown) => this.logger.warn(`Partner notification for order ${orderId} failed: ${err instanceof Error ? err.message : String(err)}`));
    return this.list(event);
  }

  async cancel(event: EventCtx, orderId: string, input: Row, statusUrlFor: (orderId: string) => string) {
    const order = await this.order(orderId, event.id);
    if (!CANCELLABLE.includes(s(order.status))) throw new BadRequestException('This order can no longer be cancelled. Contact Lazo support.');
    const reason = s(input.reason).trim().slice(0, 600);
    await this.move(order, 'cancelled', 'host', reason, { cancellation_reason: reason });
    const partner = await this.partner(s(order.partner_id)).catch(() => null);
    if (partner) {
      const notification: NotificationResult = await notifyPartner(partner, {
        kind: 'order.cancelled',
        orderId: s(order.id),
        eventName: event.name,
        category: s(order.category),
        productKey: s(order.product_key),
        productName: s(order.product_name),
        quantity: Number(order.quantity),
        city: s(order.city),
        deliveryAddress: s(order.delivery_address),
        neededBy: typeof order.needed_by === 'string' ? order.needed_by : null,
        notes: '',
        amountCentavos: Number(order.amount_centavos),
        currency: s(order.currency) || 'MXN',
        cancellationReason: reason,
        statusUrl: statusUrlFor(s(order.id)),
      });
      await this.db.from('fulfilment_orders').update({ notification }).eq('id', s(order.id));
    }
    return this.list(event);
  }

  // ------------------------------------------------------------- partner

  /** Signed status update from the partner: { status, reference?, note? }. */
  async partnerStatus(orderId: string, rawBody: Buffer | undefined, signature: string | undefined) {
    if (!UUID.test(orderId)) throw new NotFoundException('No such order');
    const { data, error } = await this.db.from('fulfilment_orders').select('*').eq('id', orderId).maybeSingle();
    if (error) throw this.fail('Could not load the order', error);
    if (!data) throw new NotFoundException('No such order');
    const order = data as Row;
    const partner = await this.partner(s(order.partner_id));
    if (!partner.webhookSecret) throw new ForbiddenException('This partner has no signing secret; ask Lazo ops to update the order');
    if (!rawBody || !verify(partner.webhookSecret, rawBody, signature)) throw new UnauthorizedException('Bad X-Lazo-Signature');

    let body: Row;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as Row;
    } catch {
      throw new BadRequestException('Body must be JSON');
    }
    const status = s(body.status);
    const from = PARTNER_MOVES[status];
    if (!from) throw new BadRequestException(`status must be one of ${Object.keys(PARTNER_MOVES).join(', ')}`);
    if (!from.includes(s(order.status))) throw new BadRequestException(`Cannot go from ${s(order.status)} to ${status}`);
    const patch: Row = {};
    if (s(body.reference)) patch.partner_reference = s(body.reference).slice(0, 120);
    await this.move(order, status, 'partner', s(body.note).slice(0, 600), patch);
    return { ok: true, orderId, status };
  }

  // --------------------------------------------------------------- admin

  async adminPartners() {
    const { data, error } = await this.db.from('fulfilment_partners').select('*').order('category').order('name');
    if (error) throw this.fail('Could not load partners', error);
    return { partners: (data as Row[]).map(toPartnerAdmin) };
  }

  /** { category, name, contactEmail?, phone?, coverage[], products[], notifyVia, webhookUrl?, terms?, active? } */
  async adminCreatePartner(input: Row) {
    const row = parsePartner(input, true);
    await assertWebhookTarget(row);
    // A fresh secret for every partner: signs our webhooks and their status posts.
    row.webhook_secret = randomBytes(24).toString('hex');
    const { error } = await this.db.from('fulfilment_partners').insert(row);
    if (error) throw this.fail('Could not add the partner', error);
    return this.adminPartners();
  }

  async adminUpdatePartner(id: string, input: Row) {
    if (!UUID.test(id)) throw new NotFoundException('No such partner');
    const row = parsePartner(input, false);
    await assertWebhookTarget(row);
    if (input.rotateSecret === true) row.webhook_secret = randomBytes(24).toString('hex');
    if (!Object.keys(row).length) throw new BadRequestException('Nothing to update');
    row.updated_at = new Date().toISOString();
    const { data, error } = await this.db.from('fulfilment_partners').update(row).eq('id', id).select('id');
    if (error) throw this.fail('Could not save the partner', error);
    if (!data?.length) throw new NotFoundException('No such partner');
    return this.adminPartners();
  }

  async adminRemovePartner(id: string) {
    if (!UUID.test(id)) throw new NotFoundException('No such partner');
    const { error } = await this.db.from('fulfilment_partners').delete().eq('id', id);
    // Partners with orders are kept (FK restrict): deactivate instead.
    if (error?.code === '23503') throw new BadRequestException('This partner has orders. Deactivate it instead.');
    if (error) throw this.fail('Could not remove the partner', error);
    return this.adminPartners();
  }

  async adminOrders() {
    const { data, error } = await this.db
      .from('fulfilment_orders')
      .select('*, fulfilment_partners(name), events(name, slug)')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw this.fail('Could not load orders', error);
    return { orders: (data as Row[]).map((r) => ({ ...toOrder(r), event: { name: s((r.events as Row | null)?.name), slug: s((r.events as Row | null)?.slug) } })) };
  }

  /** { status?, note?, partnerReference?, paymentStatus? } */
  async adminUpdateOrder(orderId: string, input: Row) {
    const order = await this.order(orderId);
    const patch: Row = {};
    if (s(input.partnerReference)) patch.partner_reference = s(input.partnerReference).slice(0, 120);
    if (input.paymentStatus !== undefined) {
      if (!PAYMENT_STATUSES.includes(input.paymentStatus as (typeof PAYMENT_STATUSES)[number])) throw new BadRequestException(`paymentStatus must be one of ${PAYMENT_STATUSES.join(', ')}`);
      patch.payment_status = input.paymentStatus;
    }
    const status = s(input.status);
    if (status) {
      if (!ORDER_STATUSES.includes(status as (typeof ORDER_STATUSES)[number])) throw new BadRequestException(`status must be one of ${ORDER_STATUSES.join(', ')}`);
      if (TERMINAL.includes(s(order.status)) && status !== s(order.status)) throw new BadRequestException(`Order is already ${s(order.status)}`);
      await this.move(order, status, 'admin', s(input.note).slice(0, 600), patch);
    } else {
      if (!Object.keys(patch).length) throw new BadRequestException('Nothing to update');
      const { error } = await this.db.from('fulfilment_orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', orderId);
      if (error) throw this.fail('Could not update the order', error);
    }
    return this.adminOrders();
  }

  // ------------------------------------------------------------ internals

  private async move(order: Row, status: string, by: 'host' | 'partner' | 'admin', note: string, extra: Row = {}) {
    const timeline = Array.isArray(order.timeline) ? (order.timeline as Row[]) : [];
    const { error } = await this.db
      .from('fulfilment_orders')
      .update({ ...extra, status, timeline: [...timeline, { status, at: new Date().toISOString(), by, note }], updated_at: new Date().toISOString() })
      .eq('id', s(order.id));
    if (error) throw this.fail('Could not update the order', error);
  }

  private async order(orderId: string, eventId?: string): Promise<Row> {
    if (!UUID.test(orderId)) throw new NotFoundException('No such order');
    let q = this.db.from('fulfilment_orders').select('*').eq('id', orderId);
    if (eventId) q = q.eq('event_id', eventId);
    const { data, error } = await q.maybeSingle();
    if (error) throw this.fail('Could not load the order', error);
    if (!data) throw new NotFoundException('No such order');
    return data as Row;
  }

  private async partner(id: string): Promise<Partner & { category: Category; coverage: string[]; products: PartnerProduct[]; terms: string; active: boolean }> {
    if (!UUID.test(id)) throw new NotFoundException('No such partner');
    const { data, error } = await this.db.from('fulfilment_partners').select('*').eq('id', id).maybeSingle();
    if (error) throw this.fail('Could not load the partner', error);
    if (!data) throw new NotFoundException('No such partner');
    return toPartner(data as Row);
  }

  private async activePartners() {
    const { data, error } = await this.db.from('fulfilment_partners').select('*').eq('active', true).order('name');
    if (error) throw this.fail('Could not load partners', error);
    return (data as Row[]).map(toPartner);
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_TABLE || error.code === UNDEFINED_COLUMN) {
      return new ServiceUnavailableException(`Fulfilment tables are missing. Apply ${FULFILMENT_MIGRATION}.`);
    }
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

function toPartner(r: Row) {
  return {
    id: s(r.id),
    name: s(r.name),
    category: s(r.category) as Category,
    contactEmail: s(r.contact_email),
    notifyVia: (r.notify_via === 'webhook' ? 'webhook' : 'email') as 'email' | 'webhook',
    webhookUrl: s(r.webhook_url),
    webhookSecret: s(r.webhook_secret),
    coverage: Array.isArray(r.coverage) ? (r.coverage as unknown[]).map(s).filter(Boolean) : [],
    products: Array.isArray(r.products) ? (r.products as Row[]).map(toProduct).filter((p) => p.key) : [],
    terms: s(r.terms),
    active: r.active === true,
  };
}

function toPartnerAdmin(r: Row) {
  return { ...toPartner(r), phone: s(r.phone), createdAt: s(r.created_at), updatedAt: s(r.updated_at) };
}

function toProduct(p: Row): PartnerProduct {
  return {
    key: s(p.key).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60),
    name: s(p.name).trim().slice(0, 120),
    priceCentavos: Number.isInteger(Number(p.priceCentavos)) && Number(p.priceCentavos) >= 0 ? Number(p.priceCentavos) : 0,
    unit: s(p.unit).trim().slice(0, 30) || 'unit',
    leadDays: Number.isInteger(Number(p.leadDays)) && Number(p.leadDays) >= 0 ? Number(p.leadDays) : 0,
  };
}

function parsePartner(input: Row, full: boolean): Row {
  const row: Row = {};
  if (full || input.category !== undefined) {
    if (!CATEGORIES.includes(input.category as Category)) throw new BadRequestException('category must be print, flowers or travel');
    row.category = input.category;
  }
  if (full || input.name !== undefined) {
    const name = s(input.name).trim();
    if (!name || name.length > 120) throw new BadRequestException('Give the partner a name (up to 120 characters)');
    row.name = name;
  }
  if (input.contactEmail !== undefined) {
    const email = s(input.contactEmail).trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Enter a valid contact email');
    row.contact_email = email.slice(0, 200);
  }
  if (input.phone !== undefined) row.phone = s(input.phone).trim().slice(0, 40);
  if (input.coverage !== undefined) {
    const list = Array.isArray(input.coverage) ? input.coverage : s(input.coverage).split(',');
    row.coverage = [...new Set(list.map((c) => s(c).trim().slice(0, 80)).filter(Boolean))];
  }
  if (input.products !== undefined) {
    if (!Array.isArray(input.products)) throw new BadRequestException('products must be a list');
    const products = (input.products as Row[]).map(toProduct);
    if (products.some((p) => !p.key || !p.name)) throw new BadRequestException('Every product needs a key and a name');
    if (new Set(products.map((p) => p.key)).size !== products.length) throw new BadRequestException('Product keys must be unique');
    row.products = products;
  }
  if (full || input.notifyVia !== undefined) {
    if (input.notifyVia !== 'email' && input.notifyVia !== 'webhook') throw new BadRequestException('notifyVia must be email or webhook');
    row.notify_via = input.notifyVia;
  }
  if (input.webhookUrl !== undefined) {
    const url = s(input.webhookUrl).trim();
    if (url && !/^https:\/\/[^\s]+$/.test(url)) throw new BadRequestException('Webhook URL must start with https://');
    row.webhook_url = url.slice(0, 500);
  }
  if (input.terms !== undefined) row.terms = s(input.terms).trim().slice(0, 3000);
  if (input.active !== undefined) row.active = input.active === true;
  if (row.notify_via === 'webhook' && row.webhook_url === '') throw new BadRequestException('A webhook partner needs a webhook URL');
  return row;
}

function toOrder(r: Row) {
  const n = r.notification as Row | null | undefined;
  return {
    id: s(r.id),
    eventId: s(r.event_id),
    partnerId: s(r.partner_id),
    partnerName: s((r.fulfilment_partners as Row | null)?.name),
    category: s(r.category),
    productKey: s(r.product_key),
    productName: s(r.product_name),
    quantity: Number(r.quantity),
    deliveryAddress: s(r.delivery_address),
    city: s(r.city),
    neededBy: typeof r.needed_by === 'string' ? r.needed_by : null,
    notes: s(r.notes),
    amountCentavos: Number(r.amount_centavos),
    currency: s(r.currency) || 'MXN',
    status: s(r.status),
    paymentStatus: s(r.payment_status) || 'unpaid',
    partnerReference: s(r.partner_reference),
    timeline: Array.isArray(r.timeline) ? (r.timeline as Row[]) : [],
    notification: n ? { via: s(n.via), ok: n.ok === true, reference: s(n.reference), error: s(n.error), at: s(n.at) } : null,
    cancellationReason: s(r.cancellation_reason),
    canCancel: CANCELLABLE.includes(s(r.status)),
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}

/** An admin-entered webhook URL must not point Lazo's server at itself or the private network. */
async function assertWebhookTarget(row: Row): Promise<void> {
  const url = s(row.webhook_url);
  if (!url) return;
  await assertPublicHost(new URL(url));
}
