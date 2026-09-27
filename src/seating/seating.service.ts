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
import { TIERS_MIGRATION } from '../payments/payments.service.js';

const UUID = /^[0-9a-f-]{36}$/i;
const SHAPES = ['round', 'long', 'square'] as const;
const MAX_TABLES = 200;
const UNDEFINED_COLUMN = '42703';

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * Seating per celebration: tables and who sits where. Only guests invited to
 * the celebration are seated; a guest who later declines keeps their seat
 * but it is flagged for review (SEAT-1), never silently dropped.
 */
@Injectable()
export class SeatingService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  async overview(eventId: string, subEventId: string) {
    await this.assertSubEvent(eventId, subEventId);
    const [tables, seats, households, guests, rsvps] = await Promise.all([
      this.db.from('seating_tables').select('*').eq('sub_event_id', subEventId).order('position').order('created_at'),
      this.db.from('seat_assignments').select('*').eq('sub_event_id', subEventId),
      this.db.from('households').select('id, name, invited_to').eq('event_id', eventId),
      this.db.from('guests').select('id, household_id, full_name, is_child').eq('event_id', eventId).order('position'),
      this.db.from('rsvps').select('guest_id, status').eq('sub_event_id', subEventId),
    ]);
    for (const r of [tables, seats, households, guests, rsvps]) if (r.error) throw this.fail('Could not load seating', r.error);

    const houseById = new Map((households.data as Row[]).map((h) => [s(h.id), h]));
    const status = new Map((rsvps.data as Row[]).map((r) => [s(r.guest_id), s(r.status)]));
    const seatOf = new Map((seats.data as Row[]).map((a) => [s(a.guest_id), a]));

    // Everyone whose household is invited to this celebration.
    const people = (guests.data as Row[])
      .filter((g) => {
        const h = houseById.get(s(g.household_id));
        const invited = Array.isArray(h?.invited_to) ? (h!.invited_to as string[]) : [];
        return h && (invited.length === 0 || invited.includes(subEventId));
      })
      .map((g) => ({
        id: s(g.id),
        name: s(g.full_name),
        isChild: g.is_child === true,
        householdId: s(g.household_id),
        household: s(houseById.get(s(g.household_id))?.name),
        rsvp: status.get(s(g.id)) ?? 'pending',
        tableId: seatOf.has(s(g.id)) ? s(seatOf.get(s(g.id))!.seating_table_id) : null,
        needsReview: seatOf.get(s(g.id))?.needs_review === true,
      }));

    const list = (tables.data as Row[]).map((t) => ({
      id: s(t.id),
      name: s(t.name),
      capacity: Number(t.capacity ?? 0),
      shape: s(t.shape) || 'round',
      notes: s(t.notes),
      guests: people.filter((p) => p.tableId === s(t.id)),
    }));
    return {
      tables: list,
      unseated: people.filter((p) => !p.tableId),
      totals: {
        seats: list.reduce((n, t) => n + t.capacity, 0),
        seated: people.filter((p) => p.tableId).length,
        attending: people.filter((p) => p.rsvp === 'attending').length,
        people: people.length,
      },
    };
  }

  /** { name, capacity, shape?, notes? } */
  async createTable(eventId: string, subEventId: string, input: Row) {
    await this.assertSubEvent(eventId, subEventId);
    const { count } = await this.db.from('seating_tables').select('id', { count: 'exact', head: true }).eq('sub_event_id', subEventId);
    if ((count ?? 0) >= MAX_TABLES) throw new BadRequestException(`Up to ${MAX_TABLES} tables`);
    const row = parseTable(input, true);
    const { error } = await this.db.from('seating_tables').insert({ ...row, event_id: eventId, sub_event_id: subEventId, position: (count ?? 0) + 1 });
    if (error) throw this.fail('Could not add the table', error);
    return this.overview(eventId, subEventId);
  }

  async updateTable(eventId: string, subEventId: string, tableId: string, input: Row) {
    if (!UUID.test(tableId)) throw new NotFoundException('No such table');
    const row = parseTable(input, false);
    if (!Object.keys(row).length) throw new BadRequestException('Nothing to update');
    const { data, error } = await this.db.from('seating_tables').update(row).eq('id', tableId).eq('event_id', eventId).select('id');
    if (error) throw this.fail('Could not save the table', error);
    if (!data?.length) throw new NotFoundException('No such table');
    return this.overview(eventId, subEventId);
  }

  async removeTable(eventId: string, subEventId: string, tableId: string) {
    if (!UUID.test(tableId)) throw new NotFoundException('No such table');
    const { error } = await this.db.from('seating_tables').delete().eq('id', tableId).eq('event_id', eventId);
    if (error) throw this.fail('Could not delete the table', error);
    return this.overview(eventId, subEventId);
  }

  /** { guestId, tableId | null } — seats or unseats one guest. */
  async seat(eventId: string, subEventId: string, input: Row) {
    const guestId = s(input.guestId);
    if (!UUID.test(guestId)) throw new BadRequestException('guestId is required');
    if (input.tableId === null || input.tableId === '') {
      const { error } = await this.db.from('seat_assignments').delete().eq('guest_id', guestId).eq('sub_event_id', subEventId);
      if (error) throw this.fail('Could not unseat', error);
      return this.overview(eventId, subEventId);
    }
    const tableId = s(input.tableId);
    if (!UUID.test(tableId)) throw new BadRequestException('tableId is required');
    const view = await this.overview(eventId, subEventId);
    const table = view.tables.find((t) => t.id === tableId);
    if (!table) throw new NotFoundException('No such table');
    const person = [...view.unseated, ...view.tables.flatMap((t) => t.guests)].find((p) => p.id === guestId);
    if (!person) throw new NotFoundException('That guest is not invited to this celebration');
    if (person.tableId !== tableId && table.guests.length >= table.capacity) throw new BadRequestException(`${table.name} is full`);

    const { error } = await this.db.from('seat_assignments').upsert(
      { event_id: eventId, sub_event_id: subEventId, seating_table_id: tableId, guest_id: guestId, needs_review: false },
      { onConflict: 'sub_event_id,guest_id' },
    );
    if (error) throw this.fail('Could not seat the guest', error);
    return this.overview(eventId, subEventId);
  }

  /** Seats every unseated attending guest, household by household, wherever there is room. */
  async autoSeat(eventId: string, subEventId: string) {
    const view = await this.overview(eventId, subEventId);
    const room = new Map(view.tables.map((t) => [t.id, t.capacity - t.guests.length]));
    const byHouse = new Map<string, typeof view.unseated>();
    for (const p of view.unseated.filter((p) => p.rsvp === 'attending')) byHouse.set(p.householdId, [...(byHouse.get(p.householdId) ?? []), p]);

    const rows: Row[] = [];
    for (const members of [...byHouse.values()].sort((a, b) => b.length - a.length)) {
      // The smallest table that fits the whole household; else spread.
      const fit = view.tables.filter((t) => (room.get(t.id) ?? 0) >= members.length).sort((a, b) => room.get(a.id)! - room.get(b.id)!)[0];
      for (const p of members) {
        const target = fit ?? view.tables.find((t) => (room.get(t.id) ?? 0) > 0);
        if (!target) break;
        room.set(target.id, room.get(target.id)! - 1);
        rows.push({ event_id: eventId, sub_event_id: subEventId, seating_table_id: target.id, guest_id: p.id, needs_review: false });
      }
    }
    if (rows.length) {
      const { error } = await this.db.from('seat_assignments').upsert(rows, { onConflict: 'sub_event_id,guest_id' });
      if (error) throw this.fail('Could not seat guests', error);
    }
    return this.overview(eventId, subEventId);
  }

  /**
   * One row per seat (table, seat number, guest, household, RSVP), then the
   * unseated guests with an empty table, per celebration. Safe for spreadsheets.
   */
  async exportCsv(eventId: string, subEventId: string | null): Promise<string> {
    const { data, error } = await this.db.from('sub_events').select('id, name').eq('event_id', eventId).order('position');
    if (error) throw this.fail('Could not load celebrations', error);
    const subs = (data as Row[]).filter((e) => !subEventId || s(e.id) === subEventId);
    if (subEventId && !subs.length) throw new NotFoundException('No such celebration');

    const lines: string[][] = [['Celebration', 'Table', 'Seat', 'Guest', 'Household', 'RSVP', 'Note']];
    for (const sub of subs) {
      const view = await this.overview(eventId, s(sub.id));
      for (const t of view.tables) {
        t.guests.forEach((p, i) => lines.push([s(sub.name), t.name, String(i + 1), p.name, p.household, p.rsvp, p.needsReview ? 'declined after seating' : '']));
        for (let i = t.guests.length; i < t.capacity; i++) lines.push([s(sub.name), t.name, String(i + 1), '', '', '', 'empty']);
      }
      for (const p of view.unseated) lines.push([s(sub.name), '', '', p.name, p.household, p.rsvp, 'not seated']);
    }
    // Leading apostrophe stops spreadsheets running cells as formulas (CSV injection).
    const cell = (v: string) => {
      const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    return '\ufeff' + lines.map((l) => l.map(cell).join(',')).join('\r\n');
  }

  private async assertSubEvent(eventId: string, subEventId: string) {
    if (!UUID.test(subEventId)) throw new NotFoundException('No such celebration');
    const { data, error } = await this.db.from('sub_events').select('id').eq('id', subEventId).eq('event_id', eventId).maybeSingle();
    if (error) throw this.fail('Could not load the celebration', error);
    if (!data) throw new NotFoundException('No such celebration');
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_COLUMN) return new ServiceUnavailableException(`Seating tables are out of date. Apply ${TIERS_MIGRATION}.`);
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

function parseTable(input: Row, full: boolean): Row {
  const row: Row = {};
  if (input.name !== undefined || full) {
    const name = s(input.name).trim();
    if (!name || name.length > 80) throw new BadRequestException('Name the table (1–80 characters)');
    row.name = name;
  }
  if (input.capacity !== undefined || full) {
    const n = Number(input.capacity);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new BadRequestException('Seats must be 1–100');
    row.capacity = n;
  }
  if (input.shape !== undefined) {
    if (!SHAPES.includes(input.shape as (typeof SHAPES)[number])) throw new BadRequestException('shape must be round, long or square');
    row.shape = input.shape;
  }
  if (input.notes !== undefined) row.notes = s(input.notes).trim().slice(0, 300);
  return row;
}
