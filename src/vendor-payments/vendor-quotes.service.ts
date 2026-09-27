import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ChatEventsService } from '../chat/chat.events.js';
import { conversationForQuote, postSystemLine } from '../chat/chat-system.js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import {
  centavos,
  commissionBps,
  dbError,
  feeFor,
  lineItems,
  requireDb,
  s,
  sn,
  text,
  toOrder,
  toQuote,
  UUID,
  vendorFor,
} from './vendor-payments.common.js';
import type { Row } from './vendor-payments.common.js';

interface EventCtx {
  id: string;
  ownerId: string;
}

/**
 * Quotes: a vendor prices an inquiry (or a listing the host picked), sends
 * it, and the host accepts (which creates the order to pay) or declines.
 */
@Injectable()
export class VendorQuotesService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
    private readonly chatEvents: ChatEventsService,
  ) {}

  // ================================================================ vendor side

  async vendorQuotes(ownerId: string) {
    const vendor = await vendorFor(this.db, ownerId);
    const { data, error } = await this.db
      .from('vendor_quotes')
      .select('*, events(name, event_date)')
      .eq('vendor_id', s(vendor.id))
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw dbError('Could not load your quotes', error);
    return { quotes: (data as Row[]).map(withEvent) };
  }

  /**
   * { inquiryId } or { eventId, listingType, listingId } (a listing that event picked)
   * or { conversationId } (an offer written in a host<->vendor thread), plus
   * title, lineItems, amountCentavos, depositCentavos?, validUntil?, note, send?
   */
  async create(ownerId: string, input: Row) {
    const vendor = await vendorFor(this.db, ownerId);
    const vendorId = s(vendor.id);
    const target = await this.target(vendorId, input);
    const fields = this.fields(input);
    const send = input.send === true;
    if (send) this.assertCanSend(vendor);

    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from('vendor_quotes')
      .insert({
        ...target,
        ...fields,
        vendor_id: vendorId,
        status: send ? 'sent' : 'draft',
        sent_at: send ? now : null,
        updated_at: now,
      })
      .select('*, events(name, event_date)')
      .single();
    if (error) throw dbError('Could not create the quote', error);
    return { quote: withEvent(data as Row) };
  }

  /**
   * Edits a draft. A sent quote can be edited too, but changing what the host
   * would pay (lines, amount, deposit, validity) takes it back to draft: the
   * vendor sends it again, so the host never accepts numbers they did not see.
   */
  async update(ownerId: string, id: string, input: Row) {
    const vendor = await vendorFor(this.db, ownerId);
    const current = await this.owned(s(vendor.id), id);
    if (!['draft', 'sent'].includes(current.status)) throw new ConflictException(`A ${current.status} quote can no longer be edited`);
    const now = new Date().toISOString();
    const patch = this.fields(input, current);
    const revert = current.status === 'sent' && ['line_items', 'amount_centavos', 'deposit_centavos', 'valid_until'].some((k) => k in patch);
    const { data, error } = await this.db
      .from('vendor_quotes')
      .update({ ...patch, ...(revert ? { status: 'draft', sent_at: null } : {}), updated_at: now })
      .eq('id', id)
      .select('*, events(name, event_date)')
      .single();
    if (error) throw dbError('Could not save the quote', error);
    const quote = withEvent(data as Row);
    if (revert) await this.milestone(quote, `The vendor is revising the offer “${quote.title}”; a new version will follow.`, ownerId);
    return { quote, reverted: revert };
  }

  async send(ownerId: string, id: string) {
    const vendor = await vendorFor(this.db, ownerId);
    const current = await this.owned(s(vendor.id), id);
    if (current.status !== 'draft') throw new ConflictException('Only a draft can be sent');
    this.assertCanSend(vendor);
    const out = await this.setStatus(id, 'sent', { sent_at: new Date().toISOString() });
    await this.milestone(out.quote, `Offer: ${out.quote.title} · ${money(out.quote.amountCentavos, out.quote.currency)}`, ownerId, 'offer');
    return out;
  }

  async withdraw(ownerId: string, id: string) {
    const vendor = await vendorFor(this.db, ownerId);
    const current = await this.owned(s(vendor.id), id);
    if (!['draft', 'sent'].includes(current.status)) throw new ConflictException(`A ${current.status} quote cannot be withdrawn`);
    const out = await this.setStatus(id, 'withdrawn');
    if (current.status === 'sent') await this.milestone(out.quote, `The vendor withdrew the offer “${out.quote.title}”.`, ownerId);
    return out;
  }

  // ================================================================ host side

  /** Everything the host sees: sent/accepted/declined quotes and the orders they became. */
  async hostQuotes(event: EventCtx) {
    const [quotes, orders] = await Promise.all([
      this.db
        .from('vendor_quotes')
        .select('*, vendors(business_name, email, phone, charges_enabled)')
        .eq('event_id', event.id)
        .neq('status', 'draft')
        .order('created_at', { ascending: false }),
      this.db
        .from('vendor_orders')
        .select('*, vendors(business_name), vendor_refunds(*), vendor_disputes(*)')
        .eq('event_id', event.id)
        .order('created_at', { ascending: false }),
    ]);
    if (quotes.error) throw dbError('Could not load quotes', quotes.error);
    if (orders.error) throw dbError('Could not load orders', orders.error);
    return {
      quotes: (quotes.data as Row[]).map(withVendor),
      orders: (orders.data as Row[]).map((r) => ({ ...toOrder(r), vendor: { name: s((r.vendors as Row | null)?.business_name) } })),
    };
  }

  /** Accepting creates the order (pending_payment). The host then starts Checkout on it. */
  async accept(event: EventCtx, quoteId: string) {
    const quote = await this.forHost(event, quoteId);
    if (quote.status !== 'sent') throw new ConflictException(quote.status === 'expired' ? 'This quote has expired' : `This quote is ${quote.status}`);
    const { data: vendor, error: vErr } = await this.db.from('vendors').select('charges_enabled, status').eq('id', quote.vendorId).maybeSingle();
    if (vErr) throw dbError('Could not load the vendor', vErr);
    if ((vendor as Row | null)?.charges_enabled !== true) throw new ConflictException('This vendor cannot take payments yet. Ask them to finish their Stripe setup.');

    const amount = quote.depositCentavos ?? quote.amountCentavos;
    const bps = await commissionBps(this.db);
    const now = new Date().toISOString();

    // Insert first: the unique quote_id makes a double click a no-op.
    const { data: order, error } = await this.db
      .from('vendor_orders')
      .insert({
        quote_id: quote.id,
        event_id: event.id,
        vendor_id: quote.vendorId,
        owner_id: event.ownerId,
        amount_centavos: amount,
        quote_amount_centavos: quote.amountCentavos,
        platform_fee_centavos: feeFor(amount, bps),
        currency: quote.currency,
        status: 'pending_payment',
        updated_at: now,
      })
      .select('*')
      .single();
    if (error?.code === '23505') {
      const { data: existing } = await this.db.from('vendor_orders').select('*, vendor_refunds(*), vendor_disputes(*)').eq('quote_id', quote.id).maybeSingle();
      return { order: toOrder(existing as Row) };
    }
    if (error) throw dbError('Could not create the order', error);

    const upd = await this.db.from('vendor_quotes').update({ status: 'accepted', accepted_at: now, updated_at: now }).eq('id', quote.id);
    if (upd.error) throw dbError('Could not accept the quote', upd.error);
    await this.milestone(quote, `Offer accepted: ${quote.title}. Waiting for payment of ${money(amount, quote.currency)}.`, event.ownerId, 'system', s((order as Row).id));
    return { order: toOrder(order as Row) };
  }

  async decline(event: EventCtx, quoteId: string) {
    const quote = await this.forHost(event, quoteId);
    if (quote.status !== 'sent' && quote.status !== 'expired') throw new ConflictException(`This quote is ${quote.status}`);
    const out = await this.setStatus(quote.id, 'declined', { declined_at: new Date().toISOString() });
    await this.milestone(quote, `Offer declined: ${quote.title}.`, event.ownerId);
    return out;
  }

  // ================================================================ internals

  private assertCanSend(vendor: Row) {
    if (vendor.status !== 'active') throw new ConflictException('Your vendor profile must be approved before you can send quotes');
    if (vendor.charges_enabled !== true) throw new ConflictException('Finish your Stripe payments setup before sending quotes (Payments tab)');
  }

  /** Resolves who the quote is for: the inquiry's event and host, or a listing the host picked. */
  private async target(vendorId: string, input: Row): Promise<Row> {
    const conversationId = s(input.conversationId);
    if (conversationId) {
      if (!UUID.test(conversationId)) throw new NotFoundException('No such conversation');
      const { data, error } = await this.db
        .from('conversations')
        .select('id, kind, event_id, customer_id, vendor_id, status')
        .eq('id', conversationId)
        .eq('vendor_id', vendorId)
        .eq('kind', 'vendor')
        .maybeSingle();
      if (error) throw dbError('Could not load the conversation', error);
      const c = data as Row | null;
      if (!c) throw new NotFoundException('No such conversation');
      if (c.status === 'closed') throw new ConflictException('This conversation is closed');
      return { inquiry_id: null, conversation_id: conversationId, event_id: s(c.event_id), owner_id: s(c.customer_id), listing_type: null, listing_id: null };
    }
    const inquiryId = s(input.inquiryId);
    if (inquiryId) {
      if (!UUID.test(inquiryId)) throw new NotFoundException('No such request');
      const { data, error } = await this.db
        .from('quotes')
        .select('id, event_id, owner_id, vendor_id, location_id, package_id')
        .eq('id', inquiryId)
        .eq('vendor_id', vendorId)
        .maybeSingle();
      if (error) throw dbError('Could not load the request', error);
      const q = data as Row | null;
      if (!q) throw new NotFoundException('No such request');
      let ownerId = s(q.owner_id);
      if (!ownerId) {
        // Inquiries from before owner_id existed: the event knows its owner.
        const { data: ev } = await this.db.from('events').select('owner_id').eq('id', s(q.event_id)).maybeSingle();
        ownerId = s((ev as Row | null)?.owner_id);
      }
      if (!ownerId) throw new NotFoundException('That request has no host');
      return {
        inquiry_id: inquiryId,
        event_id: s(q.event_id),
        owner_id: ownerId,
        listing_type: q.location_id ? 'location' : q.package_id ? 'product' : null,
        listing_id: sn(q.location_id) ?? sn(q.package_id),
      };
    }

    const eventId = s(input.eventId).toUpperCase();
    const listingType = s(input.listingType);
    const listingId = s(input.listingId);
    if (!eventId || !['location', 'product'].includes(listingType) || !UUID.test(listingId)) {
      throw new BadRequestException('Quote a request (inquiryId) or a listing a host picked (eventId, listingType, listingId)');
    }
    const { data, error } = await this.db
      .from('vendor_selections')
      .select('owner_id')
      .eq('event_id', eventId)
      .eq('vendor_id', vendorId)
      .eq(listingType === 'location' ? 'location_id' : 'package_id', listingId)
      .maybeSingle();
    if (error) throw dbError('Could not load the host pick', error);
    if (!data) throw new NotFoundException('That event has not picked this listing');
    return { inquiry_id: null, event_id: eventId, owner_id: s((data as Row).owner_id), listing_type: listingType, listing_id: listingId };
  }

  private fields(input: Row, current?: ReturnType<typeof toQuote>): Row {
    const out: Row = {};
    if (input.title !== undefined || !current) out.title = text(input.title, 160, 'Title', true);
    if (input.lineItems !== undefined) {
      out.line_items = lineItems(input.lineItems).map((li) => ({ description: li.description, quantity: li.quantity, unit_centavos: li.unitCentavos }));
    }
    if (input.amountCentavos !== undefined || !current) out.amount_centavos = centavos(input.amountCentavos, 'Amount', { required: true });
    if (input.depositCentavos !== undefined) out.deposit_centavos = centavos(input.depositCentavos, 'Deposit');
    if (input.validUntil !== undefined) {
      const v = s(input.validUntil);
      if (v && Number.isNaN(Date.parse(v))) throw new BadRequestException('validUntil must be a date');
      out.valid_until = v ? new Date(v).toISOString() : null;
    }
    if (input.note !== undefined) out.note = text(input.note, 2000, 'Note');

    const amount = Number(out.amount_centavos ?? current?.amountCentavos ?? 0);
    const deposit = out.deposit_centavos === undefined ? current?.depositCentavos ?? null : (out.deposit_centavos as number | null);
    if (deposit !== null && deposit > amount) throw new BadRequestException('The deposit cannot exceed the amount');
    return out;
  }

  private async owned(vendorId: string, id: string) {
    if (!UUID.test(id)) throw new NotFoundException('No such quote');
    const { data, error } = await this.db.from('vendor_quotes').select('*').eq('id', id).eq('vendor_id', vendorId).maybeSingle();
    if (error) throw dbError('Could not load the quote', error);
    if (!data) throw new NotFoundException('No such quote');
    return toQuote(data as Row);
  }

  private async forHost(event: EventCtx, id: string) {
    if (!UUID.test(id)) throw new NotFoundException('No such quote');
    const { data, error } = await this.db.from('vendor_quotes').select('*').eq('id', id).eq('event_id', event.id).neq('status', 'draft').maybeSingle();
    if (error) throw dbError('Could not load the quote', error);
    if (!data) throw new NotFoundException('No such quote');
    return toQuote(data as Row);
  }

  private async setStatus(id: string, status: string, extra: Row = {}) {
    const { data, error } = await this.db
      .from('vendor_quotes')
      .update({ status, ...extra, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*, events(name, event_date)')
      .single();
    if (error) throw dbError('Could not update the quote', error);
    return { quote: withEvent(data as Row) };
  }

  /** Posts a line into the host<->vendor thread this quote lives in (if any). Never fails the action. */
  private async milestone(
    quote: { id: string; conversationId?: string | null; ownerId?: string; eventId: string; vendorId: string },
    body: string,
    actorId: string,
    kind: 'system' | 'offer' = 'system',
    orderId: string | null = null,
  ) {
    try {
      // An offer written in the thread already has its card; only its outcomes are posted.
      if (kind === 'offer' && quote.conversationId) return;
      const conv = await conversationForQuote(this.db, quote);
      if (!conv) return;
      await postSystemLine(this.db, this.chatEvents, conv, { kind, body, quoteId: quote.id, orderId, actorId });
    } catch {
      // The thread mirrors the quote; the quote itself is already saved.
    }
  }

  private get db() {
    return requireDb(this.supabase);
  }
}

function money(centavos: number, currency = 'MXN'): string {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency, maximumFractionDigits: 2 }).format(centavos / 100);
}

function withEvent(r: Row) {
  const e = (r.events ?? {}) as Row;
  return { ...toQuote(r), event: { name: s(e.name), date: sn(e.event_date) } };
}

function withVendor(r: Row) {
  const v = (r.vendors ?? {}) as Row;
  return { ...toQuote(r), vendor: { name: s(v.business_name), email: s(v.email), phone: s(v.phone), chargesEnabled: v.charges_enabled === true } };
}
