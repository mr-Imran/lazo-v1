import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { tierAllows, TIERS_MIGRATION } from '../payments/payments.service.js';

const UNDEFINED_TABLE = 'PGRST205';
const UNDEFINED_COLUMN = '42703';
const UUID = /^[0-9a-f-]{36}$/i;
const KINDS = ['print', 'flowers', 'travel', 'custom_domain'] as const;
const STATUSES = ['requested', 'in_progress', 'quoted', 'done', 'cancelled'] as const;
/** Printed products Lazo takes orders for (business plan §4). */
export const PRINT_PRODUCTS = ['invitations', 'save_the_dates', 'thank_you_cards', 'menus', 'signage', 'other'] as const;
export const TRAVEL_PRODUCTS = ['hotel_block', 'guest_transport', 'honeymoon', 'other'] as const;
/** Flowers by hand when no fulfilment partner covers the city (20261011000000_retailers_fulfilment.sql adds the kind). */
export const FLOWER_PRODUCTS = ['bouquet', 'centerpieces', 'ceremony_arch', 'boutonnieres', 'other'] as const;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

type Row = Record<string, unknown>;
type Kind = (typeof KINDS)[number];
const s = (v: unknown) => (typeof v === 'string' ? v : '');

interface EventCtx {
  id: string;
  ownerId: string;
  tier: string | null;
}

/**
 * Requests Lazo handles by hand for paying hosts: print runs and travel help
 * (Signature), and a custom domain (Premium). Admins work them in the
 * backend dashboard. No fulfilment partner is wired yet; the "quoted" state
 * carries Lazo's price and the host settles it with Lazo directly.
 */
@Injectable()
export class ConciergeService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  async list(event: EventCtx) {
    const { data, error } = await this.db.from('concierge_requests').select('*').eq('event_id', event.id).order('created_at', { ascending: false });
    if (error) throw this.fail('Could not load your requests', error);
    return { requests: (data as Row[]).map(toRequest), allowed: { print: tierAllows(event.tier, 'signature'), flowers: tierAllows(event.tier, 'signature'), travel: tierAllows(event.tier, 'signature'), customDomain: tierAllows(event.tier, 'premium') } };
  }

  /** { kind, product?, quantity?, details, address?, domain? } */
  async create(event: EventCtx, input: Row) {
    const kind = s(input.kind) as Kind;
    if (!KINDS.includes(kind)) throw new BadRequestException('kind must be print, flowers, travel or custom_domain');
    const need = kind === 'custom_domain' ? 'premium' : 'signature';
    if (!tierAllows(event.tier, need)) {
      throw new ForbiddenException(`${kind === 'custom_domain' ? 'A custom domain' : 'Concierge help'} needs the ${need === 'premium' ? 'Premium' : 'Signature'} plan.`);
    }

    const row: Row = { event_id: event.id, owner_id: event.ownerId, kind, details: s(input.details).trim().slice(0, 3000), address: s(input.address).trim().slice(0, 400) };
    if (kind === 'print') {
      if (!PRINT_PRODUCTS.includes(input.product as (typeof PRINT_PRODUCTS)[number])) throw new BadRequestException('Choose what to print');
      const qty = Number(input.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 10000) throw new BadRequestException('Quantity must be 1–10,000');
      row.product = input.product;
      row.quantity = qty;
      if (!row.address) throw new BadRequestException('Add a delivery address');
    } else if (kind === 'flowers') {
      if (!FLOWER_PRODUCTS.includes(input.product as (typeof FLOWER_PRODUCTS)[number])) throw new BadRequestException('Choose what flowers you need');
      const qty = Number(input.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 10000) throw new BadRequestException('Quantity must be 1–10,000');
      row.product = input.product;
      row.quantity = qty;
      if (!row.address) throw new BadRequestException('Add a delivery address');
    } else if (kind === 'travel') {
      if (!TRAVEL_PRODUCTS.includes(input.product as (typeof TRAVEL_PRODUCTS)[number])) throw new BadRequestException('Choose what you need help with');
      row.product = input.product;
      if (s(row.details).length < 10) throw new BadRequestException('Tell us a little about what you need');
    } else {
      const domain = s(input.domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!DOMAIN.test(domain)) throw new BadRequestException('Enter a domain like mievento.com');
      row.product = domain;
      const upd = await this.db.from('events').update({ custom_domain: domain, custom_domain_status: 'requested' }).eq('id', event.id);
      if (upd.error) throw this.fail('Could not save the domain', upd.error);
    }
    const { error } = await this.db.from('concierge_requests').insert(row);
    if (error) throw this.fail('Could not send the request', error);
    return this.list(event);
  }

  async cancel(event: EventCtx, requestId: string) {
    if (!UUID.test(requestId)) throw new NotFoundException('No such request');
    const { data, error } = await this.db
      .from('concierge_requests')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', requestId)
      .eq('event_id', event.id)
      .in('status', ['requested', 'quoted'])
      .select('id');
    if (error) throw this.fail('Could not cancel', error);
    if (!data?.length) throw new NotFoundException('That request can no longer be cancelled');
    return this.list(event);
  }

  // ---------------------------------------------------------------- admin

  async adminList() {
    const { data, error } = await this.db
      .from('concierge_requests')
      .select('*, events(name, slug, tier)')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw this.fail('Could not load requests', error);
    return { requests: (data as Row[]).map((r) => ({ ...toRequest(r), event: { name: s((r.events as Row | null)?.name), slug: s((r.events as Row | null)?.slug), tier: s((r.events as Row | null)?.tier) } })) };
  }

  /** { status?, adminNote?, quoteCents? }; a done custom_domain marks the event's domain active. */
  async adminUpdate(requestId: string, input: Row) {
    if (!UUID.test(requestId)) throw new NotFoundException('No such request');
    const patch: Row = { updated_at: new Date().toISOString() };
    if (input.status !== undefined) {
      if (!STATUSES.includes(input.status as (typeof STATUSES)[number])) throw new BadRequestException(`status must be one of ${STATUSES.join(', ')}`);
      patch.status = input.status;
    }
    if (input.adminNote !== undefined) patch.admin_note = s(input.adminNote).trim().slice(0, 2000);
    if (input.quoteCents !== undefined) {
      if (input.quoteCents === null || input.quoteCents === '') patch.quote_cents = null;
      else {
        const n = Number(input.quoteCents);
        if (!Number.isInteger(n) || n < 0) throw new BadRequestException('quoteCents must be a whole number');
        patch.quote_cents = n;
      }
    }
    const { data, error } = await this.db.from('concierge_requests').update(patch).eq('id', requestId).select('*');
    if (error) throw this.fail('Could not update the request', error);
    if (!data?.length) throw new NotFoundException('No such request');
    const row = data[0] as Row;
    if (row.kind === 'custom_domain' && (patch.status === 'done' || patch.status === 'cancelled')) {
      await this.db.from('events').update({ custom_domain_status: patch.status === 'done' ? 'active' : 'none' }).eq('id', s(row.event_id));
    }
    return this.adminList();
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_TABLE || error.code === UNDEFINED_COLUMN) return new ServiceUnavailableException(`Concierge tables are missing. Apply ${TIERS_MIGRATION}.`);
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

function toRequest(r: Row) {
  return {
    id: s(r.id),
    eventId: s(r.event_id),
    kind: s(r.kind),
    product: s(r.product),
    quantity: typeof r.quantity === 'number' ? r.quantity : null,
    details: s(r.details),
    address: s(r.address),
    status: s(r.status),
    adminNote: s(r.admin_note),
    quoteCents: typeof r.quote_cents === 'number' ? r.quote_cents : null,
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
  };
}
