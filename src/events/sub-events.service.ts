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

export const EVENT_INFO_MIGRATION = 'supabase/migrations/20260929000000_event_info.sql';
const UNDEFINED_TABLE = 'PGRST205';
const UNDEFINED_COLUMN = '42703';
const UNIQUE_VIOLATION = '23505';
const MAX_SUB_EVENTS = 30;
const UUID = /^[0-9a-f-]{36}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

export interface SubEventKind {
  value: string;
  label: string;
}

/** A sub-event as its owner sees it in the builder. */
export interface SubEvent {
  id: string;
  kind: string;
  name: string;
  date: string | null;
  arriveTime: string | null;
  beginTime: string | null;
  guestCount: number | null;
  /** Meal choices guests pick from when they RSVP; empty = no menu question. */
  menuOptions: string[];
  venue: {
    name: string;
    address: string;
    imageUrl: string;
    /** Set when the venue is an approved vendor location. */
    locationId: string | null;
  } | null;
  position: number;
}

/** Owner-scoped CRUD for sub_events. The caller has already checked ownership. */
@Injectable()
export class SubEventsService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  /** Kinds an occasion offers, in display order. Empty until the migration is applied. */
  async kindsFor(mode: string): Promise<SubEventKind[]> {
    const { data, error } = await this.db
      .from('sub_event_kinds')
      .select('value, label, modes, position')
      .eq('active', true)
      .order('position', { ascending: true });
    if (error?.code === UNDEFINED_TABLE) return [];
    if (error) throw this.fail('Could not load event types', error);

    return (data as Row[])
      .filter((k) => {
        const modes = Array.isArray(k.modes) ? (k.modes as string[]) : [];
        return modes.length === 0 || modes.includes(mode);
      })
      .map((k) => ({ value: s(k.value), label: s(k.label) }));
  }

  /** Every active kind with its modes, for the public event-types list. */
  async allKinds(): Promise<{ value: string; label: string; modes: string[] }[]> {
    const { data, error } = await this.db
      .from('sub_event_kinds')
      .select('value, label, modes, position')
      .eq('active', true)
      .order('position', { ascending: true });
    if (error) return [];
    return (data as Row[]).map((k) => ({
      value: s(k.value),
      label: s(k.label),
      modes: Array.isArray(k.modes) ? (k.modes as string[]) : [],
    }));
  }

  async list(eventId: string): Promise<SubEvent[]> {
    const { data, error } = await this.db
      .from('sub_events')
      .select('*')
      .eq('event_id', eventId)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw this.fail('Could not load your events', error);
    return (data as Row[]).map(toSubEvent);
  }

  async create(event: EventContext, input: Row): Promise<SubEvent[]> {
    const existing = await this.list(event.id);
    if (existing.length >= MAX_SUB_EVENTS) {
      throw new BadRequestException(`An event can have up to ${MAX_SUB_EVENTS} celebrations`);
    }

    // _vendor_id is not a column: it rides along from parse() so the pick can
    // be recorded, and must never reach the insert/update.
    const { _vendor_id: vendorId, ...row } = await this.parse(event, input, null);
    const position = existing.reduce((max, e) => Math.max(max, e.position), -1) + 1;
    const { error } = await this.db.from('sub_events').insert({ ...row, event_id: event.id, position });
    if (error) throw this.fail('Could not add the event', error);

    await this.recordVenuePick(event, vendorId, row.vendor_location_id);
    return this.list(event.id);
  }

  async update(event: EventContext, subEventId: string, input: Row): Promise<SubEvent[]> {
    const current = await this.find(event.id, subEventId);
    const { _vendor_id: vendorId, ...row } = await this.parse(event, input, current);
    if (Object.keys(row).length === 0) throw new BadRequestException('Nothing to update');

    const { error } = await this.db
      .from('sub_events')
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq('id', subEventId)
      .eq('event_id', event.id);
    if (error) throw this.fail('Could not save the event', error);

    await this.recordVenuePick(event, vendorId, row.vendor_location_id);
    return this.list(event.id);
  }

  async remove(eventId: string, subEventId: string): Promise<SubEvent[]> {
    await this.find(eventId, subEventId);
    const { error } = await this.db.from('sub_events').delete().eq('id', subEventId).eq('event_id', eventId);
    if (error) throw this.fail('Could not delete the event', error);
    return this.list(eventId);
  }

  // ------------------------------------------------------------ parsing

  /**
   * { kind, date, arriveTime, beginTime, guestCount, venue } where venue is
   * { locationId } (an approved vendor location), { name, address } (typed
   * by the host) or null (clear). `current` is the row being edited; null
   * means creating, which requires a kind.
   */
  private async parse(event: EventContext, input: Row, current: Row | null): Promise<Row> {
    const row: Row = {};
    const full = current === null;

    if (input.kind !== undefined || full) {
      const kinds = await this.kindsFor(event.mode);
      if (kinds.length === 0) {
        throw new ServiceUnavailableException(`Event types are not set up. Apply ${EVENT_INFO_MIGRATION}.`);
      }
      const kind = kinds.find((k) => k.value === input.kind);
      if (!kind) throw new BadRequestException('Choose an event type');
      row.kind = kind.value;
      row.name = kind.label;
    }

    if (input.date !== undefined) row.event_date = parseDate(input.date);
    if (input.arriveTime !== undefined) row.arrive_time = parseTime(input.arriveTime, 'Guests arrive time');
    if (input.beginTime !== undefined) row.begin_time = parseTime(input.beginTime, 'Begins time');

    if (input.guestCount !== undefined) {
      if (input.guestCount === null || input.guestCount === '') {
        row.guest_count = null;
      } else {
        const n = Number(input.guestCount);
        if (!Number.isInteger(n) || n < 0 || n > 100000) {
          throw new BadRequestException('Total guests must be a whole number up to 100,000');
        }
        row.guest_count = n;
      }
    }

    if (input.venue !== undefined) Object.assign(row, await this.parseVenue(input.venue));

    if (input.menuOptions !== undefined) {
      if (!Array.isArray(input.menuOptions)) throw new BadRequestException('menuOptions must be a list');
      const options = [...new Set(input.menuOptions.map((o) => String(o).trim()).filter(Boolean))];
      if (options.length > 12) throw new BadRequestException('Up to 12 menu options');
      if (options.some((o) => o.length > 60)) throw new BadRequestException('Menu options must be 60 characters or fewer');
      row.menu_options = options;
    }

    // starts_at keeps the schedule sortable and gives calendars a real instant.
    if (row.event_date !== undefined || row.begin_time !== undefined) {
      const before = current ?? {};
      const date = (row.event_date !== undefined ? row.event_date : before.event_date) as string | null;
      const time = (row.begin_time !== undefined ? row.begin_time : before.begin_time) as string | null;
      row.starts_at = date && time ? zonedToUtc(date, String(time).slice(0, 5), event.timezone) : null;
    }

    return row;
  }

  private async parseVenue(value: unknown): Promise<Row> {
    const cleared = { vendor_location_id: null, venue_name: '', address: '', image_url: '' };
    if (value === null) return cleared;
    if (typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('venue must be an object or null');
    const venue = value as Row;

    if (venue.locationId !== undefined) {
      const id = String(venue.locationId);
      if (!UUID.test(id)) throw new BadRequestException('Unknown venue');
      const { data, error } = await this.db
        .from('vendor_locations')
        .select('id, name, address, city, image_url, active, review_status, vendor_id, vendors!inner(status)')
        .eq('id', id)
        .maybeSingle();
      if (error) throw this.fail('Could not load the venue', error);
      const location = data as Row | null;
      const vendorStatus = (location?.vendors as Row | undefined)?.status;
      // Only what hosts can see in the marketplace: approved, active, active vendor.
      if (!location || location.active !== true || location.review_status !== 'approved' || vendorStatus !== 'active') {
        throw new NotFoundException('That venue is not available');
      }
      return {
        vendor_location_id: location.id,
        venue_name: s(location.name).slice(0, 200),
        address: [s(location.address), s(location.city)].filter(Boolean).join(', ').slice(0, 300),
        image_url: s(location.image_url),
        _vendor_id: location.vendor_id,
      };
    }

    const name = typeof venue.name === 'string' ? venue.name.trim() : '';
    const address = typeof venue.address === 'string' ? venue.address.trim() : '';
    if (!name) throw new BadRequestException('Enter the venue name');
    if (name.length > 200) throw new BadRequestException('Venue name must be 200 characters or fewer');
    if (address.length > 300) throw new BadRequestException('Address must be 300 characters or fewer');
    return { ...cleared, venue_name: name, address };
  }

  /** Picking a vendor's venue counts as a pick, so the vendor sees it in their numbers. */
  private async recordVenuePick(event: EventContext, vendorId: unknown, locationId: unknown): Promise<void> {
    if (!vendorId || !locationId) return;
    const { error } = await this.db.from('vendor_selections').insert({
      event_id: event.id,
      owner_id: event.ownerId,
      vendor_id: vendorId,
      location_id: locationId,
    });
    if (error && error.code !== UNIQUE_VIOLATION) throw this.fail('Could not save the venue pick', error);
  }

  private async find(eventId: string, subEventId: string): Promise<Row> {
    if (!UUID.test(subEventId)) throw new NotFoundException('No such event');
    const row = await this.rawFor(eventId, subEventId);
    if (!row.id) throw new NotFoundException('No such event');
    return row;
  }

  private async rawFor(eventId: string, subEventId: unknown): Promise<Row> {
    if (typeof subEventId !== 'string' || !UUID.test(subEventId)) return {};
    const { data, error } = await this.db
      .from('sub_events')
      .select('*')
      .eq('id', subEventId)
      .eq('event_id', eventId)
      .maybeSingle();
    if (error) throw this.fail('Could not load the event', error);
    return (data as Row | null) ?? {};
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_TABLE || error.code === UNDEFINED_COLUMN) {
      return new ServiceUnavailableException(`Event info tables are missing or out of date. Apply ${EVENT_INFO_MIGRATION}.`);
    }
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

/** The parts of the parent event the service needs. */
export interface EventContext {
  id: string;
  ownerId: string;
  mode: string;
  timezone: string;
}

function parseDate(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new BadRequestException('Date must be a valid date');
  }
  return value;
}

function parseTime(value: unknown, label: string): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !TIME.test(value)) throw new BadRequestException(`${label} must be HH:MM`);
  return value;
}

/** 2026-11-29 + 19:00 in America/Mexico_City → the UTC instant (ISO). */
export function zonedToUtc(date: string, time: string, timeZone: string): string {
  const guess = new Date(`${date}T${time}:00Z`);
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(guess)
        .map((p) => [p.type, p.value]),
    );
    const asZoned = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return new Date(guess.getTime() - (asZoned - guess.getTime())).toISOString();
  } catch {
    return guess.toISOString();
  }
}

export function toSubEvent(row: Row): SubEvent {
  const hhmm = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 5) : null);
  const venueName = s(row.venue_name);
  return {
    id: s(row.id),
    kind: s(row.kind),
    name: s(row.name),
    date: typeof row.event_date === 'string' ? row.event_date : null,
    arriveTime: hhmm(row.arrive_time),
    beginTime: hhmm(row.begin_time),
    guestCount: typeof row.guest_count === 'number' ? row.guest_count : null,
    menuOptions: Array.isArray(row.menu_options) ? (row.menu_options as string[]) : [],
    venue: venueName
      ? {
          name: venueName,
          address: s(row.address),
          imageUrl: s(row.image_url),
          locationId: typeof row.vendor_location_id === 'string' ? row.vendor_location_id : null,
        }
      : null,
    position: Number(row.position ?? 0),
  };
}
