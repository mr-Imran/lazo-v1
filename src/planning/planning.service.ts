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

export const PLANNING_MIGRATION = 'supabase/migrations/20261002000000_planning.sql';
const UNDEFINED_TABLE = 'PGRST205';
const UNDEFINED_COLUMN = '42703';
const UUID = /^[0-9a-f-]{36}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CENTS = 10_000_000_000; // MXN 100M typo guard
const MAX_TASKS = 400;
const MAX_BUDGET_ITEMS = 300;

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

interface EventCtx {
  id: string;
  mode: string;
  date: string;
  ownerId: string;
}

/** Checklist, budget, inquiries to vendors, and the host's numbers. */
@Injectable()
export class PlanningService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  // ================================================================ planning

  async overview(event: EventCtx) {
    const [tasks, items, eventRow, templates] = await Promise.all([
      this.db.from('planning_tasks').select('*').eq('event_id', event.id).order('position').order('created_at'),
      this.db.from('budget_items').select('*').eq('event_id', event.id).order('position').order('created_at'),
      this.db.from('events').select('budget_cents').eq('id', event.id).single(),
      this.templatesFor(event.mode),
    ]);
    for (const r of [tasks, items, eventRow]) if (r.error) throw this.fail('Could not load your plan', r.error);

    const taskList = (tasks.data as Row[]).map(toTask);
    const titles = new Set(taskList.map((t) => t.title.toLowerCase()));
    const budgetItems = (items.data as Row[]).map(toBudgetItem);
    return {
      tasks: taskList,
      suggestionsAvailable: templates.filter((t) => !titles.has(t.title.toLowerCase())).length,
      budget: {
        totalCents: num((eventRow.data as Row).budget_cents),
        items: budgetItems,
        estimatedCents: budgetItems.reduce((n, i) => n + i.estimatedCents, 0),
        actualCents: budgetItems.reduce((n, i) => n + (i.actualCents ?? i.estimatedCents), 0),
        paidCents: budgetItems.reduce((n, i) => n + i.paidCents, 0),
      },
    };
  }

  /** Adds the occasion's suggested tasks the host doesn't have yet, dated back from the event. */
  async addSuggested(event: EventCtx) {
    const templates = await this.templatesFor(event.mode);
    const { data, error } = await this.db.from('planning_tasks').select('title, position').eq('event_id', event.id);
    if (error) throw this.fail('Could not load your checklist', error);
    const existing = new Set((data as Row[]).map((t) => s(t.title).toLowerCase()));
    const start = (data as Row[]).reduce((n, t) => Math.max(n, Number(t.position ?? 0)), 0) + 1;
    const rows = templates
      .filter((t) => !existing.has(t.title.toLowerCase()))
      .map((t, i) => ({
        event_id: event.id,
        title: t.title,
        category: t.category,
        due_date: event.date ? monthsBefore(event.date, t.monthsBefore) : null,
        position: start + i,
      }));
    if (rows.length) {
      const insert = await this.db.from('planning_tasks').insert(rows);
      if (insert.error) throw this.fail('Could not add the checklist', insert.error);
    }
    return this.overview(event);
  }

  async createTask(event: EventCtx, input: Row) {
    const { count } = await this.db.from('planning_tasks').select('id', { count: 'exact', head: true }).eq('event_id', event.id);
    if ((count ?? 0) >= MAX_TASKS) throw new BadRequestException(`Up to ${MAX_TASKS} tasks`);
    const row = parseTask(input, true);
    const { error } = await this.db.from('planning_tasks').insert({ ...row, event_id: event.id, position: (count ?? 0) + 1 });
    if (error) throw this.fail('Could not add the task', error);
    return this.overview(event);
  }

  async updateTask(event: EventCtx, taskId: string, input: Row) {
    await this.assertRow('planning_tasks', taskId, event.id);
    const row = parseTask(input, false);
    if (input.done !== undefined) row.done_at = input.done === true ? new Date().toISOString() : null;
    if (!Object.keys(row).length) throw new BadRequestException('Nothing to update');
    const { error } = await this.db.from('planning_tasks').update(row).eq('id', taskId).eq('event_id', event.id);
    if (error) throw this.fail('Could not save the task', error);
    return this.overview(event);
  }

  async removeTask(event: EventCtx, taskId: string) {
    await this.assertRow('planning_tasks', taskId, event.id);
    const { error } = await this.db.from('planning_tasks').delete().eq('id', taskId).eq('event_id', event.id);
    if (error) throw this.fail('Could not delete the task', error);
    return this.overview(event);
  }

  /** { totalCents: number | null } */
  async setBudget(event: EventCtx, input: Row) {
    const total = cents(input.totalCents, 'Budget', true);
    const { error } = await this.db.from('events').update({ budget_cents: total }).eq('id', event.id);
    if (error) throw this.fail('Could not save the budget', error);
    return this.overview(event);
  }

  async createBudgetItem(event: EventCtx, input: Row) {
    const { count } = await this.db.from('budget_items').select('id', { count: 'exact', head: true }).eq('event_id', event.id);
    if ((count ?? 0) >= MAX_BUDGET_ITEMS) throw new BadRequestException(`Up to ${MAX_BUDGET_ITEMS} budget lines`);
    const row = parseBudgetItem(input, true);
    const { error } = await this.db.from('budget_items').insert({ ...row, event_id: event.id, position: (count ?? 0) + 1 });
    if (error) throw this.fail('Could not add the budget line', error);
    return this.overview(event);
  }

  async updateBudgetItem(event: EventCtx, itemId: string, input: Row) {
    await this.assertRow('budget_items', itemId, event.id);
    const row = parseBudgetItem(input, false);
    if (!Object.keys(row).length) throw new BadRequestException('Nothing to update');
    const { error } = await this.db.from('budget_items').update(row).eq('id', itemId).eq('event_id', event.id);
    if (error) throw this.fail('Could not save the budget line', error);
    return this.overview(event);
  }

  async removeBudgetItem(event: EventCtx, itemId: string) {
    await this.assertRow('budget_items', itemId, event.id);
    const { error } = await this.db.from('budget_items').delete().eq('id', itemId).eq('event_id', event.id);
    if (error) throw this.fail('Could not delete the budget line', error);
    return this.overview(event);
  }

  // ================================================================ analytics

  /** The host dashboard's numbers for one event. Each part is empty until its migration is applied. */
  async stats(event: EventCtx) {
    const since = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const [views, households, rsvps, tasks, gifts, inquiries] = await Promise.all([
      this.db.from('site_views').select('day, views').eq('event_id', event.id).gte('day', since).order('day'),
      this.db.from('households').select('id, rsvp_submitted_at').eq('event_id', event.id),
      this.db.from('rsvps').select('status').eq('event_id', event.id),
      this.db.from('planning_tasks').select('done_at').eq('event_id', event.id),
      this.db.from('gifts').select('id').eq('event_id', event.id),
      this.db.from('quotes').select('status').eq('event_id', event.id),
    ]);
    const rows = (r: { data: unknown; error: unknown }) => (r.error ? [] : ((r.data as Row[] | null) ?? []));

    const byDay = rows(views).map((v) => ({ day: s(v.day), views: Number(v.views ?? 0) }));
    const statuses = rows(rsvps).map((r) => s(r.status));
    const taskRows = rows(tasks);
    const quoteRows = rows(inquiries);
    return {
      views: { last30: byDay.reduce((n, d) => n + d.views, 0), byDay },
      invitations: {
        total: rows(households).length,
        responded: rows(households).filter((h) => h.rsvp_submitted_at).length,
      },
      answers: {
        attending: statuses.filter((x) => x === 'attending').length,
        declined: statuses.filter((x) => x === 'declined').length,
      },
      checklist: { total: taskRows.length, done: taskRows.filter((t) => t.done_at).length },
      gifts: rows(gifts).length,
      inquiries: { total: quoteRows.length, answered: quoteRows.filter((q) => q.status !== 'requested').length },
    };
  }

  // ================================================================ inquiries

  /** Host → vendor: { type: 'location' | 'product', listingId, message, guestCount?, date?, email?, phone? } */
  async createInquiry(event: EventCtx, input: Row) {
    const type = s(input.type);
    const listingId = s(input.listingId);
    if (!['location', 'product'].includes(type) || !UUID.test(listingId)) throw new BadRequestException('Choose a venue or product');
    const table = type === 'location' ? 'vendor_locations' : 'vendor_packages';
    const { data: listing, error } = await this.db
      .from(table)
      .select('id, vendor_id, active, review_status, vendors!inner(status)')
      .eq('id', listingId)
      .maybeSingle();
    if (error) throw this.fail('Could not load the listing', error);
    const l = listing as Row | null;
    if (!l || l.active !== true || l.review_status !== 'approved' || (l.vendors as Row)?.status !== 'active') {
      throw new NotFoundException('That listing is not available');
    }

    const message = s(input.message).trim();
    if (message.length < 10) throw new BadRequestException('Tell the vendor a little about what you need (10+ characters)');
    if (message.length > 2000) throw new BadRequestException('Message must be 2000 characters or fewer');
    const guestCount = input.guestCount === undefined || input.guestCount === null || input.guestCount === '' ? null : Number(input.guestCount);
    if (guestCount !== null && (!Number.isInteger(guestCount) || guestCount < 0 || guestCount > 100000)) {
      throw new BadRequestException('Guests must be a whole number');
    }
    const date = s(input.date);
    if (date && !DATE.test(date)) throw new BadRequestException('Date must be YYYY-MM-DD');

    // One open inquiry per event and listing: asking twice just updates it.
    const { data: open } = await this.db
      .from('quotes')
      .select('id')
      .eq('event_id', event.id)
      .eq(type === 'location' ? 'location_id' : 'package_id', listingId)
      .eq('status', 'requested')
      .maybeSingle();

    const row = {
      event_id: event.id,
      vendor_id: l.vendor_id,
      owner_id: event.ownerId,
      location_id: type === 'location' ? listingId : null,
      package_id: type === 'product' ? listingId : null,
      message,
      guest_count: guestCount,
      event_date: date || event.date || null,
      contact_email: s(input.email).trim().slice(0, 200),
      contact_phone: s(input.phone).trim().slice(0, 40),
      status: 'requested',
      updated_at: new Date().toISOString(),
    };
    const result = open
      ? await this.db.from('quotes').update(row).eq('id', (open as Row).id)
      : await this.db.from('quotes').insert(row);
    if (result.error) throw this.fail('Could not send your request', result.error);
    return this.hostInquiries(event);
  }

  async hostInquiries(event: EventCtx) {
    const { data, error } = await this.db
      .from('quotes')
      .select('*, vendors(business_name, email, phone)')
      .eq('event_id', event.id)
      .order('created_at', { ascending: false });
    if (error) throw this.fail('Could not load your requests', error);
    return { inquiries: (data as Row[]).map((q) => toInquiry(q, 'host')) };
  }

  async vendorInquiries(ownerId: string) {
    const vendor = await this.vendorFor(ownerId);
    const { data, error } = await this.db
      .from('quotes')
      .select('*, events(name, mode, event_date)')
      .eq('vendor_id', vendor.id)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw this.fail('Could not load requests', error);
    return { inquiries: (data as Row[]).map((q) => toInquiry(q, 'vendor')) };
  }

  /** Vendor → host: { message, totalCents? } */
  async reply(ownerId: string, quoteId: string, input: Row) {
    const vendor = await this.vendorFor(ownerId);
    if (!UUID.test(quoteId)) throw new NotFoundException('No such request');
    const message = s(input.message).trim();
    if (!message) throw new BadRequestException('Write a reply');
    if (message.length > 2000) throw new BadRequestException('Reply must be 2000 characters or fewer');
    const total = cents(input.totalCents, 'Price', true);
    const { data, error } = await this.db
      .from('quotes')
      .update({
        vendor_reply: message,
        total_cents: total,
        status: 'sent',
        replied_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', quoteId)
      .eq('vendor_id', vendor.id)
      .select('id');
    if (error) throw this.fail('Could not send the reply', error);
    if (!data?.length) throw new NotFoundException('No such request');
    return this.vendorInquiries(ownerId);
  }

  // ================================================================ internals

  private async vendorFor(ownerId: string): Promise<{ id: string }> {
    const { data, error } = await this.db.from('vendors').select('id, status').eq('owner_id', ownerId).maybeSingle();
    if (error) throw this.fail('Could not load your vendor profile', error);
    if (!data) throw new ForbiddenException('Create your vendor profile first');
    return { id: s((data as Row).id) };
  }

  private async templatesFor(mode: string) {
    const { data, error } = await this.db.from('checklist_templates').select('*').order('position');
    if (error) {
      if (error.code === UNDEFINED_TABLE) return [];
      throw this.fail('Could not load the checklist', error);
    }
    return (data as Row[])
      .filter((t) => {
        const modes = Array.isArray(t.modes) ? (t.modes as string[]) : [];
        return modes.length === 0 || modes.includes(mode);
      })
      .map((t) => ({ title: s(t.title), category: s(t.category), monthsBefore: Number(t.months_before ?? 0) }));
  }

  private async assertRow(table: string, id: string, eventId: string) {
    if (!UUID.test(id)) throw new NotFoundException('Not found');
    const { data, error } = await this.db.from(table).select('id').eq('id', id).eq('event_id', eventId).maybeSingle();
    if (error) throw this.fail('Could not load', error);
    if (!data) throw new NotFoundException('Not found');
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_TABLE || error.code === UNDEFINED_COLUMN) {
      return new ServiceUnavailableException(`Planning tables are missing or out of date. Apply ${PLANNING_MIGRATION}.`);
    }
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

function monthsBefore(date: string, months: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Math.round(months * 30.4));
  return d.toISOString().slice(0, 10);
}

function cents(value: unknown, label: string, nullable: boolean): number | null {
  if (value === null || value === undefined || value === '') {
    if (nullable) return null;
    return 0;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_CENTS) throw new BadRequestException(`${label} must be a valid amount`);
  return n;
}

function parseTask(input: Row, full: boolean): Row {
  const row: Row = {};
  if (input.title !== undefined || full) {
    const title = s(input.title).trim();
    if (!title) throw new BadRequestException('Give the task a name');
    if (title.length > 160) throw new BadRequestException('Task must be 160 characters or fewer');
    row.title = title;
  }
  if (input.category !== undefined) row.category = s(input.category).trim().slice(0, 60);
  if (input.notes !== undefined) row.notes = s(input.notes).trim().slice(0, 1000);
  if (input.dueDate !== undefined) {
    if (input.dueDate === null || input.dueDate === '') row.due_date = null;
    else if (typeof input.dueDate === 'string' && DATE.test(input.dueDate)) row.due_date = input.dueDate;
    else throw new BadRequestException('Due date must be a date');
  }
  return row;
}

function parseBudgetItem(input: Row, full: boolean): Row {
  const row: Row = {};
  if (input.name !== undefined || full) {
    const name = s(input.name).trim();
    if (!name) throw new BadRequestException('Name the budget line');
    if (name.length > 160) throw new BadRequestException('Name must be 160 characters or fewer');
    row.name = name;
  }
  if (input.category !== undefined) row.category = s(input.category).trim().slice(0, 60);
  if (input.notes !== undefined) row.notes = s(input.notes).trim().slice(0, 1000);
  if (input.estimatedCents !== undefined || full) row.estimated_cents = cents(input.estimatedCents, 'Estimate', false) ?? 0;
  if (input.actualCents !== undefined) row.actual_cents = cents(input.actualCents, 'Actual cost', true);
  if (input.paidCents !== undefined) row.paid_cents = cents(input.paidCents, 'Paid', false) ?? 0;
  return row;
}

function toTask(r: Row) {
  return {
    id: s(r.id),
    title: s(r.title),
    category: s(r.category),
    dueDate: typeof r.due_date === 'string' ? r.due_date : null,
    notes: s(r.notes),
    done: typeof r.done_at === 'string',
    doneAt: typeof r.done_at === 'string' ? r.done_at : null,
  };
}

function toBudgetItem(r: Row) {
  return {
    id: s(r.id),
    category: s(r.category),
    name: s(r.name),
    estimatedCents: Number(r.estimated_cents ?? 0),
    actualCents: num(r.actual_cents),
    paidCents: Number(r.paid_cents ?? 0),
    notes: s(r.notes),
  };
}

function toInquiry(q: Row, side: 'host' | 'vendor') {
  const base = {
    id: s(q.id),
    status: s(q.status),
    type: q.location_id ? 'location' : 'product',
    listingId: s(q.location_id ?? q.package_id),
    message: s(q.message),
    guestCount: num(q.guest_count),
    date: typeof q.event_date === 'string' ? q.event_date : null,
    reply: s(q.vendor_reply),
    totalCents: num(q.total_cents),
    currency: s(q.currency) || 'MXN',
    repliedAt: typeof q.replied_at === 'string' ? q.replied_at : null,
    createdAt: s(q.created_at),
  };
  if (side === 'host') {
    const v = (q.vendors ?? {}) as Row;
    return { ...base, vendor: { name: s(v.business_name), email: s(v.email), phone: s(v.phone) } };
  }
  const e = (q.events ?? {}) as Row;
  // The vendor sees how to reach the host only because the host chose to write to them.
  return {
    ...base,
    event: { name: s(e.name), mode: s(e.mode), date: typeof e.event_date === 'string' ? e.event_date : null },
    contact: { email: s(q.contact_email), phone: s(q.contact_phone) },
  };
}
