import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { tokenMatches } from '../site-content/site-content.service.js';
import { consentView, rsvpConsentPatch } from '../whatsapp/consent.js';
import { sections as modeSections } from '../events/mode-config.js';

export const GUESTS_MIGRATION = 'supabase/migrations/20260930000000_guests_rsvp.sql';
const UNDEFINED_TABLE = 'PGRST205';
const UNDEFINED_COLUMN = '42703';
const UNIQUE_VIOLATION = '23505';
const UUID = /^[0-9a-f-]{36}$/i;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_HOUSEHOLDS = 2000;
const MAX_GUESTS_PER_HOUSEHOLD = 30;
const MAX_IMPORT_ROWS = 3000;
const STATUSES = ['pending', 'attending', 'declined', 'tentative'] as const;

type Row = Record<string, unknown>;
type Status = (typeof STATUSES)[number];
const s = (v: unknown) => (typeof v === 'string' ? v : '');

/** Same normalisation as public.lazo_lookup_name(): lower-case, no accents, single spaces. */
export function lookupName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface GuestAnswer {
  status: Status;
  menuChoice: string;
  allergies: string;
}

export interface HostGuest {
  id: string;
  fullName: string;
  email: string;
  dietary: string;
  isChild: boolean;
  isPlusOne: boolean;
  /** Post-event: did they come? null until the host marks it (20261008000000_core_gaps.sql). */
  attended: boolean | null;
  rsvps: Record<string, GuestAnswer>;
}

export interface HostHousehold {
  id: string;
  name: string;
  inviteCode: string;
  email: string;
  phone: string;
  plusOneLimit: number;
  tags: string[];
  invitedTo: string[];
  notes: string;
  rsvpSubmittedAt: string | null;
  rsvpMessage: string;
  guests: HostGuest[];
}

interface EventRef {
  id: string;
}

/** Guest list (host) and RSVP (guests on the public site). */
@Injectable()
export class GuestsService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  // =================================================================== host

  /** Everything the guest-list screen shows, with per-celebration totals. */
  async overview(event: EventRef) {
    const [households, guests, rsvps, subEvents, settings] = await Promise.all([
      this.q(this.db.from('households').select('*').eq('event_id', event.id).order('created_at', { ascending: true })),
      this.q(this.db.from('guests').select('*').eq('event_id', event.id).order('position').order('created_at')),
      this.q(this.db.from('rsvps').select('*').eq('event_id', event.id)),
      this.q(
        this.db
          .from('sub_events')
          .select('id, name, event_date, begin_time, position, menu_options')
          .eq('event_id', event.id)
          .order('position'),
      ),
      this.q(this.db.from('events').select('rsvp_deadline, rsvp_open').eq('id', event.id).single()),
    ]);

    const answers = new Map<string, Record<string, GuestAnswer>>();
    for (const r of rsvps as Row[]) {
      const byGuest = answers.get(s(r.guest_id)) ?? {};
      byGuest[s(r.sub_event_id)] = {
        status: s(r.status) as Status,
        menuChoice: s(r.menu_choice),
        allergies: s(r.allergies),
      };
      answers.set(s(r.guest_id), byGuest);
    }

    const guestsByHousehold = new Map<string, HostGuest[]>();
    for (const g of guests as Row[]) {
      const list = guestsByHousehold.get(s(g.household_id)) ?? [];
      list.push({
        id: s(g.id),
        fullName: s(g.full_name),
        email: s(g.email),
        dietary: s(g.dietary),
        isChild: g.is_child === true,
        isPlusOne: g.is_plus_one === true,
        attended: typeof g.attended === 'boolean' ? g.attended : null,
        rsvps: answers.get(s(g.id)) ?? {},
      });
      guestsByHousehold.set(s(g.household_id), list);
    }

    const list: HostHousehold[] = (households as Row[]).map((h) => toHousehold(h, guestsByHousehold.get(s(h.id)) ?? []));
    const subs = (subEvents as Row[]).map((e) => ({
      id: s(e.id),
      name: s(e.name),
      date: typeof e.event_date === 'string' ? e.event_date : null,
      beginTime: typeof e.begin_time === 'string' ? e.begin_time.slice(0, 5) : null,
      menuOptions: Array.isArray(e.menu_options) ? (e.menu_options as string[]) : [],
    }));

    const perSubEvent: Record<string, { invited: number; attending: number; declined: number; pending: number }> = {};
    for (const sub of subs) {
      const totals = { invited: 0, attending: 0, declined: 0, pending: 0 };
      for (const h of list) {
        if (h.invitedTo.length && !h.invitedTo.includes(sub.id)) continue;
        for (const g of h.guests) {
          totals.invited++;
          const status = g.rsvps[sub.id]?.status ?? 'pending';
          if (status === 'attending') totals.attending++;
          else if (status === 'declined') totals.declined++;
          else totals.pending++;
        }
      }
      perSubEvent[sub.id] = totals;
    }

    const settingsRow = settings as unknown as Row;
    return {
      settings: {
        deadline: typeof settingsRow.rsvp_deadline === 'string' ? settingsRow.rsvp_deadline : null,
        open: settingsRow.rsvp_open !== false,
      },
      subEvents: subs,
      households: list,
      totals: {
        households: list.length,
        guests: list.reduce((n, h) => n + h.guests.length, 0),
        responded: list.filter((h) => h.rsvpSubmittedAt).length,
        perSubEvent,
      },
    };
  }

  /** { name, email?, phone?, plusOneLimit?, tags?, invitedTo?, notes?, guests: [{ fullName, email?, dietary?, isChild? }] } */
  async createHousehold(event: EventRef, input: Row) {
    const { count, error } = await this.db
      .from('households')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', event.id);
    if (error) throw this.fail('Could not count invitations', error);
    if ((count ?? 0) >= MAX_HOUSEHOLDS) throw new BadRequestException(`Up to ${MAX_HOUSEHOLDS} invitations per event`);

    const fields = await this.householdFields(event, input, true);
    const guests = parseGuests(input.guests, true);
    const id = await this.insertHousehold(event.id, fields);
    await this.replaceGuests(event.id, id, guests);
    return this.overview(event);
  }

  async updateHousehold(event: EventRef, householdId: string, input: Row) {
    await this.findHousehold(event.id, householdId);
    const fields = await this.householdFields(event, input, false);
    if (Object.keys(fields).length) {
      const { error } = await this.db
        .from('households')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('id', householdId)
        .eq('event_id', event.id);
      if (error) throw this.fail('Could not save the invitation', error);
    }
    if (input.guests !== undefined) await this.replaceGuests(event.id, householdId, parseGuests(input.guests, true));
    return this.overview(event);
  }

  async removeHousehold(event: EventRef, householdId: string) {
    await this.findHousehold(event.id, householdId);
    const { error } = await this.db.from('households').delete().eq('id', householdId).eq('event_id', event.id);
    if (error) throw this.fail('Could not delete the invitation', error);
    return this.overview(event);
  }

  /**
   * CSV with a header row. Columns (any order, case-insensitive):
   * household, name (required), email, phone, child (yes/no), plus_ones.
   * Rows with the same household are one invitation; a blank household
   * makes the guest their own invitation.
   */
  async importCsv(event: EventRef, csv: unknown) {
    if (typeof csv !== 'string' || !csv.trim()) throw new BadRequestException('Paste or upload a CSV file');
    if (csv.length > 1_000_000) throw new BadRequestException('The file is too large (1 MB maximum)');

    const rows = parseCsv(csv);
    if (rows.length < 2) throw new BadRequestException('The CSV needs a header row and at least one guest');
    if (rows.length - 1 > MAX_IMPORT_ROWS) throw new BadRequestException(`Up to ${MAX_IMPORT_ROWS} guests per import`);

    const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
    const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
    const iName = col('name', 'guest', 'guest_name', 'full_name', 'nombre');
    if (iName === -1) throw new BadRequestException('The CSV needs a "name" column');
    const iHouse = col('household', 'family', 'party', 'invitation', 'familia');
    const iEmail = col('email', 'correo');
    const iPhone = col('phone', 'telefono', 'teléfono', 'whatsapp');
    const iChild = col('child', 'is_child', 'nino', 'niño');
    const iPlus = col('plus_ones', 'plus_one', 'plusones', 'acompanantes', 'acompañantes');

    const groups = new Map<string, { name: string; email: string; phone: string; plus: number; guests: ParsedGuest[] }>();
    let skipped = 0;
    rows.slice(1).forEach((r, i) => {
      const name = (r[iName] ?? '').trim().slice(0, 160);
      if (!name) {
        skipped++;
        return;
      }
      const house = (iHouse >= 0 ? r[iHouse] : '')?.trim().slice(0, 160) || name;
      const key = house.toLowerCase() || `row-${i}`;
      const group = groups.get(key) ?? { name: house, email: '', phone: '', plus: 0, guests: [] };
      const email = (iEmail >= 0 ? r[iEmail] : '')?.trim().slice(0, 200) ?? '';
      const phone = (iPhone >= 0 ? r[iPhone] : '')?.trim().slice(0, 40) ?? '';
      group.email ||= email;
      group.phone ||= phone;
      const plus = iPlus >= 0 ? Number.parseInt(r[iPlus] ?? '', 10) : 0;
      if (Number.isFinite(plus)) group.plus = Math.max(group.plus, Math.min(20, Math.max(0, plus)));
      if (group.guests.length < MAX_GUESTS_PER_HOUSEHOLD) {
        group.guests.push({
          fullName: name,
          email,
          dietary: '',
          isChild: iChild >= 0 && /^(y|yes|si|sí|true|1|x)$/i.test((r[iChild] ?? '').trim()),
        });
      }
      groups.set(key, group);
    });

    for (const g of groups.values()) {
      const id = await this.insertHousehold(event.id, {
        name: g.name,
        email: g.email,
        phone: g.phone,
        plus_one_limit: g.plus,
      });
      await this.replaceGuests(event.id, id, g.guests);
    }

    return {
      imported: { households: groups.size, guests: [...groups.values()].reduce((n, g) => n + g.guests.length, 0), skipped },
      ...(await this.overview(event)),
    };
  }

  /** One row per guest and celebration answer, for spreadsheets. */
  async exportCsv(event: EventRef): Promise<string> {
    const data = await this.overview(event);
    const header = ['Household', 'Invite code', 'Guest', 'Child', 'Plus-one', 'Email', 'Phone', 'Dietary', 'Attended'];
    for (const sub of data.subEvents) header.push(`${sub.name} — RSVP`, `${sub.name} — Menu`);
    header.push('Message');

    const lines = [header];
    for (const h of data.households) {
      for (const g of h.guests) {
        const line = [
          h.name,
          h.inviteCode,
          g.fullName,
          g.isChild ? 'yes' : '',
          g.isPlusOne ? 'yes' : '',
          g.email || h.email,
          h.phone,
          [g.dietary, ...Object.values(g.rsvps).map((a) => a.allergies)].filter(Boolean).join('; '),
          g.attended === null ? '' : g.attended ? 'yes' : 'no',
        ];
        for (const sub of data.subEvents) {
          const invited = !h.invitedTo.length || h.invitedTo.includes(sub.id);
          const a = g.rsvps[sub.id];
          line.push(invited ? (a?.status ?? 'pending') : 'not invited', a?.menuChoice ?? '');
        }
        line.push(h.rsvpMessage);
        lines.push(line);
      }
    }
    // Leading apostrophe stops spreadsheets running cells as formulas (CSV injection).
    const cell = (v: string) => {
      const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    return '﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n');
  }

  /** { deadline?: 'YYYY-MM-DD' | null, open?: boolean } */
  async updateSettings(event: EventRef, input: Row) {
    const patch: Row = {};
    if (input.deadline !== undefined) {
      if (input.deadline === null || input.deadline === '') patch.rsvp_deadline = null;
      else if (typeof input.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.deadline)) patch.rsvp_deadline = input.deadline;
      else throw new BadRequestException('deadline must be a date (YYYY-MM-DD)');
    }
    if (input.open !== undefined) {
      if (typeof input.open !== 'boolean') throw new BadRequestException('open must be true or false');
      patch.rsvp_open = input.open;
    }
    if (!Object.keys(patch).length) throw new BadRequestException('Nothing to update');
    const { error } = await this.db.from('events').update(patch).eq('id', event.id);
    if (error) throw this.fail('Could not save RSVP settings', error);
    return this.overview(event);
  }

  /**
   * Post-event: { attended: true | false | null } on one guest. Null clears
   * the mark. Needs guests.attended from 20261008000000_core_gaps.sql.
   */
  async setAttendance(event: EventRef, guestId: string, input: Row) {
    if (!/^[0-9a-f-]{36}$/i.test(guestId)) throw new NotFoundException('No such guest');
    if (input.attended !== null && typeof input.attended !== 'boolean') {
      throw new BadRequestException('attended must be true, false or null');
    }
    const { data, error } = await this.db
      .from('guests')
      .update({ attended: input.attended })
      .eq('id', guestId)
      .eq('event_id', event.id)
      .select('id');
    if (error?.code === UNDEFINED_COLUMN) {
      throw new ServiceUnavailableException('Attendance is not set up. Apply supabase/migrations/20261008000000_core_gaps.sql.');
    }
    if (error) throw this.fail('Could not save attendance', error);
    if (!data?.length) throw new NotFoundException('No such guest');
    return this.overview(event);
  }

  /** The host records an answer for a guest (a phone call, a message…). */
  async setAnswer(event: EventRef, input: Row) {
    const guestId = s(input.guestId);
    const subEventId = s(input.subEventId);
    const status = s(input.status) as Status;
    if (!UUID.test(guestId) || !UUID.test(subEventId)) throw new BadRequestException('guestId and subEventId are required');
    if (!STATUSES.includes(status)) throw new BadRequestException(`status must be one of ${STATUSES.join(', ')}`);
    await this.assertBelongs('guests', guestId, event.id);
    await this.assertBelongs('sub_events', subEventId, event.id);

    const { error } = await this.db.from('rsvps').upsert(
      {
        event_id: event.id,
        guest_id: guestId,
        sub_event_id: subEventId,
        status,
        responded_at: status === 'pending' ? null : new Date().toISOString(),
      },
      { onConflict: 'guest_id,sub_event_id' },
    );
    if (error) throw this.fail('Could not save the answer', error);
    if (status === 'declined') await this.flagSeats([{ guest_id: guestId, sub_event_id: subEventId }]);
    return this.overview(event);
  }

  /** SEAT-1: seats of guests who declined are flagged, never silently removed. */
  private async flagSeats(declined: Row[]) {
    for (const r of declined) {
      await this.db
        .from('seat_assignments')
        .update({ needs_review: true })
        .eq('guest_id', s(r.guest_id))
        .eq('sub_event_id', s(r.sub_event_id));
    }
  }

  // ================================================================= public

  /**
   * "Find your invitation": { code } from an invite link, or { name } typed
   * by the guest (their full name, as the host wrote it). Only live sites
   * with RSVP open. Returns one household and nothing about anyone else.
   */
  async find(slug: string, input: Row, token?: string) {
    const event = await this.liveEvent(slug, token);
    let householdId: string | null = null;

    if (typeof input.code === 'string' && input.code.trim()) {
      const code = input.code.trim().toUpperCase().slice(0, 40);
      const { data, error } = await this.db
        .from('households')
        .select('id')
        .eq('event_id', event.id)
        .eq('invite_code', code)
        .maybeSingle();
      if (error) throw this.fail('Could not look up the invitation', error);
      householdId = (data as Row | null)?.id as string | null;
      if (!householdId) throw new NotFoundException('That invitation code isn’t valid for this event.');
    } else if (typeof input.name === 'string') {
      const name = lookupName(input.name.slice(0, 160));
      // A full name, not a fragment: stops fishing through the list letter by letter.
      if (name.length < 5 || !name.includes(' ')) {
        throw new BadRequestException('Type your first and last name as they appear on your invitation.');
      }
      const { data, error } = await this.db
        .from('guests')
        .select('household_id')
        .eq('event_id', event.id)
        .eq('lookup_name', name)
        .limit(3);
      if (error) throw this.fail('Could not look up the invitation', error);
      const ids = [...new Set((data as Row[]).map((r) => s(r.household_id)))];
      if (ids.length === 0) {
        throw new NotFoundException('We couldn’t find that name. Check the spelling, or use the code on your invitation.');
      }
      if (ids.length > 1) {
        throw new ConflictException('More than one invitation matches that name. Please use the code on your invitation.');
      }
      // A name is not a secret: show only enough for the guest to recognise
      // their invitation, then ask for the code before anything else.
      return this.maskedHousehold(event, ids[0]);
    } else {
      throw new BadRequestException('Enter your invitation code or your full name');
    }

    return this.publicHousehold(event, householdId!);
  }

  /** What a name search reveals: the household's name, first names, and whether it has answered. No code, phone, menu or allergies. */
  private async maskedHousehold(event: LiveEvent, householdId: string) {
    const [house, guests] = await Promise.all([
      this.q(this.db.from('households').select('id, name, rsvp_submitted_at').eq('id', householdId).eq('event_id', event.id).single()),
      this.q(this.db.from('guests').select('full_name, is_plus_one').eq('household_id', householdId).eq('is_plus_one', false).order('position').order('created_at')),
    ]);
    const h = house as unknown as Row;
    return {
      masked: true as const,
      name: s(h.name),
      submitted: typeof h.rsvp_submitted_at === 'string',
      guests: (guests as Row[]).map((g) => ({ firstName: s(g.full_name).trim().split(/\s+/)[0] ?? '' })),
      deadline: event.deadline,
      open: event.open,
    };
  }

  /**
   * { code, answers: [{ guestId, subEventId, status, menuChoice?, allergies? }],
   *   plusOnes?: [{ fullName }], message? }
   */
  async submit(slug: string, input: Row, token?: string) {
    const event = await this.liveEvent(slug, token);
    if (!event.open) throw new ForbiddenException('RSVPs are closed for this event.');
    if (event.deadline && event.deadline < todayIn(event.timezone)) {
      throw new ForbiddenException('The RSVP deadline has passed. Please contact the hosts.');
    }

    const code = s(input.code).trim().toUpperCase().slice(0, 40);
    if (!code) throw new BadRequestException('Missing invitation code');
    const { data: house, error } = await this.db
      .from('households')
      .select('*')
      .eq('event_id', event.id)
      .eq('invite_code', code)
      .maybeSingle();
    if (error) throw this.fail('Could not load the invitation', error);
    if (!house) throw new NotFoundException('That invitation code isn’t valid for this event.');
    const household = house as Row;

    // Plus-ones first, so they can be answered for in the same submission.
    const limit = Number(household.plus_one_limit ?? 0);
    if (input.plusOnes !== undefined) {
      const plusOnes = parseGuests(input.plusOnes, false).slice(0, limit);
      await this.db.from('guests').delete().eq('household_id', household.id).eq('is_plus_one', true);
      if (plusOnes.length) {
        const { error: insertError } = await this.db.from('guests').insert(
          plusOnes.map((g, i) => ({
            event_id: event.id,
            household_id: household.id,
            full_name: g.fullName,
            is_plus_one: true,
            position: 100 + i,
          })),
        );
        if (insertError) throw this.fail('Could not save your guests', insertError);
      }
    }

    const view = await this.publicHousehold(event, s(household.id));
    const guestIds = new Set(view.guests.map((g) => g.id));
    const subIds = new Map(view.subEvents.map((e) => [e.id, e]));
    const plusOneIds = new Set(view.guests.filter((g) => g.isPlusOne).map((g) => g.id));

    if (!Array.isArray(input.answers) || input.answers.length === 0) throw new BadRequestException('Answer for at least one guest');
    if (input.answers.length > 400) throw new BadRequestException('Too many answers');

    const now = new Date().toISOString();
    const rows: Row[] = [];
    for (const raw of input.answers as Row[]) {
      if (typeof raw !== 'object' || raw === null) throw new BadRequestException('Each answer must be an object');
      // Plus-ones are new rows, so the client refers to them by position.
      let guestId = s(raw.guestId);
      if (!guestIds.has(guestId) && typeof raw.plusOneIndex === 'number') {
        guestId = view.guests.filter((g) => g.isPlusOne)[raw.plusOneIndex]?.id ?? '';
      }
      if (!guestIds.has(guestId)) continue;
      const sub = subIds.get(s(raw.subEventId));
      if (!sub) continue;
      const status = s(raw.status) as Status;
      if (!['attending', 'declined'].includes(status)) throw new BadRequestException('Answer attending or declined');
      const menuChoice = s(raw.menuChoice).slice(0, 120);
      if (menuChoice && !sub.menuOptions.includes(menuChoice)) throw new BadRequestException('Pick a menu option from the list');
      rows.push({
        event_id: event.id,
        guest_id: guestId,
        sub_event_id: sub.id,
        status,
        menu_choice: status === 'attending' ? menuChoice : '',
        allergies: status === 'attending' ? s(raw.allergies).trim().slice(0, 300) : '',
        responded_at: now,
      });
    }
    if (!rows.length && !plusOneIds.size) throw new BadRequestException('Answer for at least one guest');

    if (rows.length) {
      const { error: upsertError } = await this.db.from('rsvps').upsert(rows, { onConflict: 'guest_id,sub_event_id' });
      if (upsertError) throw this.fail('Could not save your RSVP', upsertError);
      await this.flagSeats(rows.filter((r) => r.status === 'declined'));
    }
    const { error: houseError } = await this.db
      .from('households')
      // WhatsApp consent from the form travels with the answers (WA-1).
      .update({ rsvp_submitted_at: now, rsvp_message: s(input.message).trim().slice(0, 600), updated_at: now, ...(rsvpConsentPatch(input) ?? {}) })
      .eq('id', household.id);
    if (houseError) throw this.fail('Could not save your RSVP', houseError);

    return this.publicHousehold(event, s(household.id));
  }

  // ============================================================== internals

  private async publicHousehold(event: LiveEvent, householdId: string) {
    const [house, guests, subEvents] = await Promise.all([
      this.q(this.db.from('households').select('*').eq('id', householdId).eq('event_id', event.id).single()),
      this.q(this.db.from('guests').select('*').eq('household_id', householdId).order('position').order('created_at')),
      this.q(this.db.from('sub_events').select('*').eq('event_id', event.id).order('position')),
    ]);
    const h = house as unknown as Row;
    const invited = Array.isArray(h.invited_to) ? (h.invited_to as string[]) : [];
    const guestRows = guests as Row[];
    const answers = guestRows.length
      ? await this.q(this.db.from('rsvps').select('*').in('guest_id', guestRows.map((g) => s(g.id))))
      : [];
    const byGuest = new Map<string, Record<string, GuestAnswer>>();
    for (const r of answers as Row[]) {
      const m = byGuest.get(s(r.guest_id)) ?? {};
      m[s(r.sub_event_id)] = { status: s(r.status) as Status, menuChoice: s(r.menu_choice), allergies: s(r.allergies) };
      byGuest.set(s(r.guest_id), m);
    }

    return {
      code: s(h.invite_code),
      name: s(h.name),
      plusOneLimit: Number(h.plus_one_limit ?? 0),
      submittedAt: typeof h.rsvp_submitted_at === 'string' ? h.rsvp_submitted_at : null,
      message: s(h.rsvp_message),
      phone: s(h.phone),
      whatsappConsent: consentView(h).whatsappConsent,
      deadline: event.deadline,
      open: event.open,
      guests: guestRows.map((g) => ({
        id: s(g.id),
        fullName: s(g.full_name),
        isChild: g.is_child === true,
        isPlusOne: g.is_plus_one === true,
        answers: byGuest.get(s(g.id)) ?? {},
      })),
      subEvents: (subEvents as Row[])
        .filter((e) => !invited.length || invited.includes(s(e.id)))
        .map((e) => ({
          id: s(e.id),
          name: s(e.name),
          date: typeof e.event_date === 'string' ? e.event_date : null,
          beginTime: typeof e.begin_time === 'string' ? e.begin_time.slice(0, 5) : null,
          venueName: s(e.venue_name),
          menuOptions: Array.isArray(e.menu_options) ? (e.menu_options as string[]) : [],
        })),
    };
  }

  private async liveEvent(slug: string, token?: string): Promise<LiveEvent> {
    const clean = String(slug).toLowerCase();
    if (!/^[a-z0-9-]{1,63}$/.test(clean)) throw new NotFoundException('No site at this address');
    const { data, error } = await this.db.from('events').select('*').eq('slug', clean).maybeSingle();
    if (error) throw this.fail('Could not load the event', error);
    const row = data as Row | null;
    if (!row || row.state !== 'live') throw new NotFoundException('No site at this address');
    if (!('rsvp_open' in row)) throw new ServiceUnavailableException(`RSVP is not set up. Apply ${GUESTS_MIGRATION}.`);
    // The mode decides whether the site has an RSVP at all (event_modes.sections, EVT-3/4).
    const { data: mode } = await this.db.from('event_modes').select('*').eq('value', s(row.mode)).maybeSingle();
    if (mode && !modeSections((mode as Row).sections).includes('rsvp')) {
      throw new ForbiddenException('This kind of event does not take RSVPs.');
    }
    const hash = typeof row.site_password_hash === 'string' ? row.site_password_hash : '';
    if (hash && !tokenMatches(clean, hash, token)) {
      throw new UnauthorizedException({ message: 'This site is private. Enter the password to continue.', reason: 'password' });
    }
    return {
      id: s(row.id),
      // A closed event (post-event flow) keeps its site but takes no more answers.
      open: row.rsvp_open !== false && !row.closed_at,
      deadline: typeof row.rsvp_deadline === 'string' ? row.rsvp_deadline : null,
      timezone: s(row.timezone) || 'America/Mexico_City',
    };
  }

  private async householdFields(event: EventRef, input: Row, full: boolean): Promise<Row> {
    const row: Row = {};
    if (input.name !== undefined || full) {
      const name = s(input.name).trim();
      if (!name) throw new BadRequestException('Give the invitation a name (e.g. "Familia Pérez")');
      if (name.length > 160) throw new BadRequestException('Name must be 160 characters or fewer');
      row.name = name;
    }
    const text = (key: string, column: string, max: number) => {
      if (input[key] === undefined) return;
      const v = s(input[key]).trim();
      if (v.length > max) throw new BadRequestException(`${key} must be ${max} characters or fewer`);
      row[column] = v;
    };
    text('email', 'email', 200);
    text('phone', 'phone', 40);
    text('notes', 'notes', 600);
    if (input.plusOneLimit !== undefined) {
      const n = Number(input.plusOneLimit);
      if (!Number.isInteger(n) || n < 0 || n > 20) throw new BadRequestException('Plus-ones must be 0–20');
      row.plus_one_limit = n;
    }
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags)) throw new BadRequestException('tags must be a list');
      row.tags = [...new Set(input.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 12);
    }
    if (input.invitedTo !== undefined) {
      if (!Array.isArray(input.invitedTo)) throw new BadRequestException('invitedTo must be a list');
      const ids = [...new Set(input.invitedTo.map(String))];
      if (ids.some((id) => !UUID.test(id))) throw new BadRequestException('Unknown celebration');
      if (ids.length) {
        const { data, error } = await this.db.from('sub_events').select('id').eq('event_id', event.id).in('id', ids);
        if (error) throw this.fail('Could not check the celebrations', error);
        if ((data ?? []).length !== ids.length) throw new BadRequestException('Unknown celebration');
      }
      row.invited_to = ids;
    }
    return row;
  }

  private async insertHousehold(eventId: string, fields: Row): Promise<string> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      const { data, error } = await this.db
        .from('households')
        .insert({ ...fields, event_id: eventId, invite_code: code })
        .select('id')
        .single();
      if (!error) return s((data as Row).id);
      if (error.code !== UNIQUE_VIOLATION) throw this.fail('Could not save the invitation', error);
    }
    throw new InternalServerErrorException('Could not create a unique invitation code');
  }

  /** Keeps existing guests (by id) so their answers survive; adds new ones; removes the rest. */
  private async replaceGuests(eventId: string, householdId: string, guests: ParsedGuest[]) {
    const { data, error } = await this.db.from('guests').select('id').eq('household_id', householdId);
    if (error) throw this.fail('Could not load the guests', error);
    const existing = new Set((data as Row[]).map((g) => s(g.id)));
    const keep = new Set(guests.filter((g) => g.id && existing.has(g.id)).map((g) => g.id!));
    const drop = [...existing].filter((id) => !keep.has(id));

    if (drop.length) {
      const { error: delError } = await this.db.from('guests').delete().in('id', drop);
      if (delError) throw this.fail('Could not remove guests', delError);
    }
    for (const [i, g] of guests.entries()) {
      const row = {
        full_name: g.fullName,
        email: g.email,
        dietary: g.dietary,
        is_child: g.isChild,
        position: i,
      };
      const result =
        g.id && keep.has(g.id)
          ? await this.db.from('guests').update(row).eq('id', g.id)
          : await this.db.from('guests').insert({ ...row, event_id: eventId, household_id: householdId });
      if (result.error) throw this.fail('Could not save the guests', result.error);
    }
  }

  private async findHousehold(eventId: string, householdId: string) {
    if (!UUID.test(householdId)) throw new NotFoundException('No such invitation');
    const { data, error } = await this.db.from('households').select('id').eq('id', householdId).eq('event_id', eventId).maybeSingle();
    if (error) throw this.fail('Could not load the invitation', error);
    if (!data) throw new NotFoundException('No such invitation');
  }

  private async assertBelongs(table: string, id: string, eventId: string) {
    const { data, error } = await this.db.from(table).select('id').eq('id', id).eq('event_id', eventId).maybeSingle();
    if (error) throw this.fail('Could not check the record', error);
    if (!data) throw new NotFoundException('Not found in this event');
  }

  private async q<T>(query: PromiseLike<{ data: T | null; error: { code?: string; message: string } | null }>): Promise<T> {
    const { data, error } = await query;
    if (error) throw this.fail('Could not load the guest list', error);
    return (data ?? []) as T;
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_TABLE || error.code === UNDEFINED_COLUMN) {
      return new ServiceUnavailableException(`Guest list tables are missing or out of date. Apply ${GUESTS_MIGRATION}.`);
    }
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

interface LiveEvent {
  id: string;
  open: boolean;
  deadline: string | null;
  timezone: string;
}

interface ParsedGuest {
  id?: string;
  fullName: string;
  email: string;
  dietary: string;
  isChild: boolean;
}

function parseGuests(value: unknown, requireOne: boolean): ParsedGuest[] {
  if (value === undefined || value === null) {
    if (requireOne) throw new BadRequestException('Add at least one guest');
    return [];
  }
  if (!Array.isArray(value)) throw new BadRequestException('guests must be a list');
  const guests = value
    .filter((g): g is Row => typeof g === 'object' && g !== null)
    .map((g) => ({
      id: UUID.test(s(g.id)) ? s(g.id) : undefined,
      fullName: s(g.fullName).trim().replace(/\s+/g, ' ').slice(0, 160),
      email: s(g.email).trim().slice(0, 200),
      dietary: s(g.dietary).trim().slice(0, 300),
      isChild: g.isChild === true,
    }))
    .filter((g) => g.fullName);
  if (requireOne && guests.length === 0) throw new BadRequestException('Add at least one guest');
  if (guests.length > MAX_GUESTS_PER_HOUSEHOLD) {
    throw new BadRequestException(`Up to ${MAX_GUESTS_PER_HOUSEHOLD} guests per invitation`);
  }
  return guests;
}

function toHousehold(h: Row, guests: HostGuest[]): HostHousehold {
  return {
    id: s(h.id),
    name: s(h.name),
    inviteCode: s(h.invite_code),
    email: s(h.email),
    phone: s(h.phone),
    plusOneLimit: Number(h.plus_one_limit ?? 0),
    tags: Array.isArray(h.tags) ? (h.tags as string[]) : [],
    invitedTo: Array.isArray(h.invited_to) ? (h.invited_to as string[]) : [],
    notes: s(h.notes),
    rsvpSubmittedAt: typeof h.rsvp_submitted_at === 'string' ? h.rsvp_submitted_at : null,
    rsvpMessage: s(h.rsvp_message),
    ...consentView(h),
    guests,
  };
}

/** RFC 4180-ish: quoted fields, doubled quotes, commas or semicolons, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
