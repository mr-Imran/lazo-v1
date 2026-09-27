import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { SITE_CONTENT_MIGRATION } from './site-content.service.js';

const UUID = /^[0-9a-f-]{36}$/i;
const KINDS = ['retailer_link', 'cash_fund'] as const;
const MAX_ITEMS = 200;
const MAX_CENTAVOS = 100_000_000 * 100; // MXN 100M: a typo guard, not a business rule
const UNDEFINED_COLUMN = '42703';

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const n = (v: unknown) => (typeof v === 'number' ? v : v == null ? null : Number(v));

export interface RegistryItem {
  id: string;
  kind: string;
  title: string;
  description: string;
  imageUrl: string;
  externalUrl: string;
  priceCents: number | null;
  goalCents: number | null;
  currency: string;
  status: string;
  position: number;
  /** Set when the item came from a retailer API (see src/retailers). */
  retailerKey: string | null;
  externalId: string | null;
  available: boolean | null;
  priceCheckedAt: string | null;
}

/**
 * The Gift step: store links and cash funds (registry_items), and the gifts
 * guests tell the hosts about. No money moves here: a cash-fund gift is a
 * bank transfer the guest reports, recorded as source 'guest_report' (PAY-2).
 * Payments through a licensed provider come later and will use source 'payment'.
 */
@Injectable()
export class RegistryService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  async overview(eventId: string) {
    const [items, gifts] = await Promise.all([
      this.db.from('registry_items').select('*').eq('event_id', eventId).order('position').order('created_at'),
      this.db.from('gifts').select('*').eq('event_id', eventId).order('created_at', { ascending: false }),
    ]);
    if (items.error) throw this.fail('Could not load the registry', items.error);
    if (gifts.error) throw this.fail('Could not load gifts', gifts.error);
    return {
      items: (items.data as Row[]).map(toItem),
      gifts: (gifts.data as Row[]).map((g) => ({
        id: s(g.id),
        itemId: typeof g.registry_item_id === 'string' ? g.registry_item_id : null,
        guestName: s(g.guest_name),
        guestEmail: s(g.guest_email),
        message: s(g.message),
        amountCents: n(g.amount_cents),
        currency: s(g.currency) || 'MXN',
        status: s(g.status),
        source: s(g.source) || 'payment',
        thankedAt: typeof g.thanked_at === 'string' ? g.thanked_at : null,
        createdAt: s(g.created_at),
      })),
    };
  }

  /** { kind, title, description?, externalUrl?, imageUrl?, priceCents?, goalCents? } */
  async create(eventId: string, input: Row) {
    const { count, error } = await this.db
      .from('registry_items')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId);
    if (error) throw this.fail('Could not count registry items', error);
    if ((count ?? 0) >= MAX_ITEMS) throw new BadRequestException(`Up to ${MAX_ITEMS} registry items`);

    const row = parseItem(input, true);
    const { data: last } = await this.db
      .from('registry_items')
      .select('position')
      .eq('event_id', eventId)
      .order('position', { ascending: false })
      .limit(1);
    const position = ((last as Row[] | null)?.[0]?.position as number | undefined) ?? -1;
    const insert = await this.db.from('registry_items').insert({ ...row, event_id: eventId, position: Math.min(999, position + 1) });
    if (insert.error) throw this.fail('Could not add the gift', insert.error);
    return this.overview(eventId);
  }

  async update(eventId: string, itemId: string, input: Row) {
    await this.findItem(eventId, itemId);
    const row = parseItem(input, false);
    if (input.available === true) row.status = 'available';
    // The host confirms a gift arrived (or puts it back): guests can only report.
    if (input.status !== undefined) {
      if (input.status !== 'available' && input.status !== 'purchased') throw new BadRequestException('status must be available or purchased');
      row.status = input.status;
    }
    if (!Object.keys(row).length) throw new BadRequestException('Nothing to update');
    const { error } = await this.db.from('registry_items').update(row).eq('id', itemId).eq('event_id', eventId);
    if (error) throw this.fail('Could not save the gift', error);
    return this.overview(eventId);
  }

  async remove(eventId: string, itemId: string) {
    await this.findItem(eventId, itemId);
    const { error } = await this.db.from('registry_items').delete().eq('id', itemId).eq('event_id', eventId);
    if (error) throw this.fail('Could not delete the gift', error);
    return this.overview(eventId);
  }

  /** { thanked: boolean } — the host's thank-you list. */
  async markThanked(eventId: string, giftId: string, input: Row) {
    if (!UUID.test(giftId)) throw new NotFoundException('No such gift');
    const { data, error } = await this.db
      .from('gifts')
      .update({ thanked_at: input.thanked === true ? new Date().toISOString() : null })
      .eq('id', giftId)
      .eq('event_id', eventId)
      .select('id');
    if (error) throw this.fail('Could not save', error);
    if (!data?.length) throw new NotFoundException('No such gift');
    return this.overview(eventId);
  }

  // ------------------------------------------------------------ public side

  /**
   * A guest tells the hosts about a gift: { itemId?, name, email?, amountCents?, message? }.
   * Only the gifts row is written: an anonymous report must not take an item
   * off the list (anyone could hide every gift). The host confirms it with
   * PATCH …/registry/:itemId { status: 'purchased' }.
   */
  async report(eventId: string, input: Row) {
    const name = s(input.name).trim().slice(0, 160);
    if (!name) throw new BadRequestException('Tell the hosts who the gift is from');
    const email = s(input.email).trim().slice(0, 200);
    const message = s(input.message).trim().slice(0, 600);

    let item: RegistryItem | null = null;
    if (input.itemId !== undefined && input.itemId !== null) {
      item = await this.findItem(eventId, s(input.itemId));
      if (item.status === 'purchased') throw new BadRequestException('Someone has already given this gift');
    }

    let amount = n(input.amountCents);
    if (item?.kind === 'retailer_link' || item?.kind === 'retailer_api') amount = item.priceCents ?? amount;
    if (amount === null || !Number.isInteger(amount) || amount <= 0 || amount > MAX_CENTAVOS) {
      throw new BadRequestException('Enter the amount you sent');
    }

    const { error } = await this.db.from('gifts').insert({
      event_id: eventId,
      registry_item_id: item?.id ?? null,
      guest_name: name,
      guest_email: email,
      message,
      amount_cents: amount,
      host_proceeds_cents: 0,
      currency: item?.currency || 'MXN',
      status: 'pending',
      source: 'guest_report',
    });
    if (error) throw this.fail('Could not send your message', error);
    return { ok: true };
  }

  /** Items guests may see: not withdrawn. */
  async publicItems(eventId: string): Promise<RegistryItem[]> {
    const { data, error } = await this.db.from('registry_items').select('*').eq('event_id', eventId).order('position');
    if (error) throw this.fail('Could not load the registry', error);
    return (data as Row[]).map(toItem).filter((i) => !['cancelled', 'refunded'].includes(i.status));
  }

  private async findItem(eventId: string, itemId: string): Promise<RegistryItem> {
    if (!UUID.test(itemId)) throw new NotFoundException('No such gift');
    const { data, error } = await this.db.from('registry_items').select('*').eq('id', itemId).eq('event_id', eventId).maybeSingle();
    if (error) throw this.fail('Could not load the gift', error);
    if (!data) throw new NotFoundException('No such gift');
    return toItem(data as Row);
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_COLUMN) {
      return new ServiceUnavailableException(`Gift tables are out of date. Apply ${SITE_CONTENT_MIGRATION}.`);
    }
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

function parseItem(input: Row, full: boolean): Row {
  const row: Row = {};
  if (input.kind !== undefined || full) {
    if (!KINDS.includes(input.kind as (typeof KINDS)[number])) throw new BadRequestException('Choose a store gift or a cash fund');
    row.kind = input.kind;
  }
  if (input.title !== undefined || full) {
    const title = s(input.title).trim();
    if (!title) throw new BadRequestException('Give the gift a name');
    if (title.length > 200) throw new BadRequestException('Name must be 200 characters or fewer');
    row.title = title;
  }
  if (input.description !== undefined) {
    const d = s(input.description).trim();
    if (d.length > 1000) throw new BadRequestException('Description must be 1000 characters or fewer');
    row.description = d;
  }
  for (const [key, column] of [
    ['externalUrl', 'external_url'],
    ['imageUrl', 'image_url'],
  ] as const) {
    if (input[key] === undefined) continue;
    const v = s(input[key]).trim();
    if (!v) {
      row[column] = '';
      continue;
    }
    // https only: these become links and images on a public page.
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      throw new BadRequestException(`${key === 'externalUrl' ? 'Store link' : 'Image'} must be a web address (https://…)`);
    }
    if (url.protocol !== 'https:') throw new BadRequestException('Use an https:// address');
    if (v.length > 500) throw new BadRequestException('That address is too long');
    row[column] = url.toString();
  }
  for (const [key, column] of [
    ['priceCents', 'price_cents'],
    ['goalCents', 'goal_cents'],
  ] as const) {
    if (input[key] === undefined) continue;
    if (input[key] === null || input[key] === '') {
      row[column] = null;
      continue;
    }
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < 0 || value > MAX_CENTAVOS) throw new BadRequestException('Enter a valid amount');
    row[column] = value;
  }
  return row;
}

function toItem(r: Row): RegistryItem {
  return {
    id: s(r.id),
    kind: s(r.kind),
    title: s(r.title),
    description: s(r.description),
    imageUrl: s(r.image_url),
    externalUrl: s(r.external_url),
    priceCents: n(r.price_cents),
    goalCents: n(r.goal_cents),
    currency: s(r.currency) || 'MXN',
    status: s(r.status) || 'available',
    position: Number(r.position ?? 0),
    retailerKey: typeof r.retailer_key === 'string' ? r.retailer_key : null,
    externalId: typeof r.external_id === 'string' ? r.external_id : null,
    available: typeof r.available === 'boolean' ? r.available : null,
    priceCheckedAt: typeof r.price_checked_at === 'string' ? r.price_checked_at : null,
  };
}
