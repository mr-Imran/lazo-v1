import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { EVENT_TYPES, EVENT_TYPE_LABELS } from './event.entity.js';
import type {
  AdminEventFilter,
  AdminEventPage,
  AdminEventQuery,
  CreateEventInput,
  EventRecord,
  EventStats,
  EventType,
  UpdateEventInput,
  AdminUpdateEventInput,
} from './event.entity.js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import { parseSlug, siteUrlFor } from '../sites/site-config.js';
import { baseSlug, familySections, fillTemplate, firstFreeSlug, parseDetails, parseFamilies } from './event-details.js';
import type { DetailField } from './event-details.js';
import { privacyDefaults } from './mode-config.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import type { EventRow } from '../supabase/database.types.js';

// No I/O/0/1 — these codes get read aloud and typed off a printed invitation.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_NAME = 120;
const MAX_LOCATION = 160;
const ID_COLLISION_RETRIES = 5;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH = 80;
// ilike wildcards, the LIKE escape character, and PostgREST's own filter
// separators — all stripped from search text before it becomes a pattern.
const WILDCARDS = /[%_,()*\\]/g;

/** Postgres unique_violation — the generated id was already taken. */
const UNIQUE_VIOLATION = '23505';
/** Postgres foreign_key_violation — here, a mode not in event_modes. */
const FOREIGN_KEY_VIOLATION = '23503';
const MAX_MODE = 40;
const STATES = ['anonymous_draft', 'draft', 'unpaid', 'live', 'past', 'suspended'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long an unclaimed anonymous draft lives (20261008000000_core_gaps.sql). */
const CLAIM_DAYS = 30;
export const CORE_GAPS_MIGRATION = 'supabase/migrations/20261008000000_core_gaps.sql';
const UNDEFINED_COLUMN = '42703';

@Injectable()
export class EventsService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
  ) {}

  async findAllFor(ownerId: string): Promise<EventRecord[]> {
    const { data, error } = await this.db
      .from('events')
      .select('*')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException(`Could not load events: ${error.message}`);
    }

    return this.withThemes(data.map(toRecord));
  }

  /**
   * Fills in `theme` with one extra query for all the themes involved, rather
   * than a join, so the hand-written schema types stay relationship-free.
   */
  private async withThemes(records: EventRecord[]): Promise<EventRecord[]> {
    const ids = [...new Set(records.map((r) => r.themeId).filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return records;

    const { data, error } = await this.db
      .from('themes')
      .select('id, name, preview_url')
      .in('id', ids);

    if (error) {
      throw new InternalServerErrorException(`Could not load themes: ${error.message}`);
    }

    const byId = new Map(data.map((t) => [t.id, { id: t.id, name: t.name, previewUrl: t.preview_url }]));

    return records.map((r) => ({ ...r, theme: (r.themeId && byId.get(r.themeId)) || null }));
  }

  async findOneFor(ownerId: string, id: string): Promise<EventRecord> {
    const { data, error } = await this.db
      .from('events')
      .select('*')
      .eq('id', id.toUpperCase())
      .eq('owner_id', ownerId)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(`Could not load event: ${error.message}`);
    }

    if (!data) {
      throw new NotFoundException(`No event with id ${id}`);
    }

    const [record] = await this.withThemes([toRecord(data)]);

    return record!;
  }

  /**
   * With an owner: a draft in the create flow. With `null`: an anonymous
   * draft saved from the details step before sign-up. No subdomain is
   * reserved for it (that happens on claim, so unclaimed drafts never hold a
   * name), and the raw claim token comes back once in `claimToken`.
   */
  async create(ownerId: string | null, input: CreateEventInput): Promise<EventRecord & { claimToken?: string }> {
    const type = this.parseType(input.type);
    const mode = this.parseText(input.mode, MAX_MODE, 'mode');
    const occasion = mode ? await this.modeRow(mode) : null;
    const details = occasion ? parseDetails(occasion.fields, input.details) : {};
    if (!occasion && input.details !== undefined) {
      throw new BadRequestException('details need a mode');
    }

    // First choice of subdomain from the occasion's template ("rajib-jerin");
    // the host can change it later. Taken ones get -2, -3 … appended.
    const base = occasion && ownerId ? baseSlug(occasion.slug_template, details, occasion.value) : null;
    let slug = base ? firstFreeSlug(base, await this.slugsLike(base)) : null;

    const claimToken = ownerId ? null : randomBytes(24).toString('base64url');
    const anonymous = claimToken
      ? {
          state: 'anonymous_draft',
          claim_token_hash: hashToken(claimToken),
          claim_expires_at: new Date(Date.now() + CLAIM_DAYS * 86_400_000).toISOString(),
        }
      : {};

    const draft = {
      owner_id: ownerId,
      ...anonymous,
      // Naming is optional. The column still requires something: an explicit
      // name, else the occasion's template filled with the details ("Rajib &
      // Jerin wedding"), else the occasion's label, else the legacy type's.
      name:
        this.parseText(input.name, MAX_NAME, 'name') ||
        fillTemplate(occasion?.name_template ?? null, details)?.slice(0, MAX_NAME) ||
        occasion?.label ||
        EVENT_TYPE_LABELS[type],
      details,
      type,
      event_date: this.parseDate(input.date),
      location: this.parseText(input.location, MAX_LOCATION, 'location'),
      guest_count: this.parseGuestCount(input.guestCount),
      // Checked by the events_mode_fkey reference to event_modes, not a copy
      // of the list here. Omitted means the column default.
      ...(mode ? { mode } : {}),
      // The mode's privacy defaults (EVT-3/4/5), only once
      // 20261012000000_modes_mercadopago.sql has added both sides.
      ...(occasion?.privacy
        ? {
            password_required: occasion.privacy.passwordRequired,
            searchable: occasion.privacy.searchable,
            gallery_open: occasion.privacy.guestUploads,
            show_guest_count: occasion.privacy.showGuestCount,
          }
        : {}),
    };

    // The primary key does the collision check for us, so retry on the (very
    // unlikely) clash rather than pre-reading the table.
    for (let attempt = 0; attempt < ID_COLLISION_RETRIES; attempt++) {
      const { data, error } = await this.db
        .from('events')
        .insert({ ...draft, id: generateId(), ...(slug ? { slug } : {}) })
        .select('*')
        .single();

      if (!error) {
        return claimToken ? { ...toRecord(data), claimToken } : toRecord(data);
      }

      if (error.code === UNDEFINED_COLUMN && claimToken) {
        throw new ServiceUnavailableException(`Anonymous drafts are not set up. Apply ${CORE_GAPS_MIGRATION}.`);
      }

      if (error.code === FOREIGN_KEY_VIOLATION) {
        throw new BadRequestException('mode must be one of the values from GET /api/event-types');
      }

      if (error.code !== UNIQUE_VIOLATION) {
        throw new InternalServerErrorException(`Could not create event: ${error.message}`);
      }

      // Either the id or the subdomain was taken meanwhile; re-pick the
      // subdomain too so a concurrent sign-up can't wedge this one.
      if (base && /slug/i.test(`${error.message} ${error.details ?? ''}`)) {
        slug = firstFreeSlug(base, await this.slugsLike(base));
      }
    }

    throw new InternalServerErrorException('Could not allocate a unique event id');
  }

  /**
   * An anonymous draft by id and raw claim token. Expired drafts are deleted
   * on sight (the cleanup for 20261008000000_core_gaps.sql) and reported as
   * missing, so nothing has to run on a schedule.
   */
  async findAnonymousDraft(id: string, token: unknown): Promise<EventRecord> {
    const raw = typeof token === 'string' ? token.trim() : '';
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(raw)) throw new NotFoundException('No draft with that id and token');

    const { data, error } = await this.db
      .from('events')
      .select('*')
      .eq('id', id.toUpperCase())
      .eq('state', 'anonymous_draft')
      .maybeSingle();

    if (error?.code === UNDEFINED_COLUMN) {
      throw new ServiceUnavailableException(`Anonymous drafts are not set up. Apply ${CORE_GAPS_MIGRATION}.`);
    }
    if (error) throw new InternalServerErrorException(`Could not load the draft: ${error.message}`);

    if (!data || !data.claim_token_hash || data.claim_token_hash !== hashToken(raw)) {
      throw new NotFoundException('No draft with that id and token');
    }
    if (data.claim_expires_at && Date.parse(data.claim_expires_at) < Date.now()) {
      await this.db.from('events').delete().eq('id', data.id).eq('state', 'anonymous_draft');
      throw new NotFoundException('That draft has expired');
    }
    return toRecord(data);
  }

  /** The details step re-saves as the visitor edits: { details?, date?, location? }. */
  async updateAnonymousDraft(id: string, token: unknown, input: UpdateEventInput & CreateEventInput): Promise<EventRecord> {
    const draft = await this.findAnonymousDraft(id, token);
    const patch: EventPatch & { event_date?: string | null; location?: string } = {};
    if (input.details !== undefined) {
      const occasion = await this.modeRow(draft.mode);
      patch.details = parseDetails(occasion.fields, input.details);
      patch.name = fillTemplate(occasion.name_template, patch.details)?.slice(0, MAX_NAME) || occasion.label;
    }
    if (input.date !== undefined) patch.event_date = this.parseDate(input.date);
    if (input.location !== undefined) patch.location = this.parseText(input.location, MAX_LOCATION, 'location');
    if (Object.keys(patch).length === 0) throw new BadRequestException('Nothing to update: send details, date and/or location');

    const { data, error } = await this.db
      .from('events')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', draft.id)
      .eq('state', 'anonymous_draft')
      .select('*')
      .maybeSingle();
    if (error) throw new InternalServerErrorException(`Could not update the draft: ${error.message}`);
    if (!data) throw new NotFoundException('That draft was already claimed');
    return toRecord(data);
  }

  /**
   * Gives an anonymous draft to the signed-in user: owner set, state 'draft',
   * and the subdomain chosen now (create() skipped it for anonymous rows).
   */
  async claim(ownerId: string, id: string, token: unknown): Promise<EventRecord> {
    const draft = await this.findAnonymousDraft(id, token);
    const occasion = draft.mode ? await this.modeRow(draft.mode) : null;
    const base = occasion && !draft.slug ? baseSlug(occasion.slug_template, draft.details, occasion.value) : null;
    let slug = base ? firstFreeSlug(base, await this.slugsLike(base)) : null;

    for (let attempt = 0; attempt < ID_COLLISION_RETRIES; attempt++) {
      const { data, error } = await this.db
        .from('events')
        .update({
          owner_id: ownerId,
          state: 'draft',
          claimed_at: new Date().toISOString(),
          claim_token_hash: null,
          claim_expires_at: null,
          updated_at: new Date().toISOString(),
          ...(slug ? { slug } : {}),
        })
        .eq('id', draft.id)
        .eq('state', 'anonymous_draft')
        .select('*')
        .maybeSingle();

      if (!error) {
        // Another tab claimed it first: it now belongs to whoever did.
        if (!data) throw new NotFoundException('That draft was already claimed');
        return toRecord(data);
      }
      if (error.code !== UNIQUE_VIOLATION || !base) {
        throw new InternalServerErrorException(`Could not claim the draft: ${error.message}`);
      }
      slug = firstFreeSlug(base, await this.slugsLike(base));
    }
    throw new InternalServerErrorException('Could not allocate a subdomain for the draft');
  }

  /** Marks the event closed (post-event flow). The site stays live; RSVP stops. */
  async close(ownerId: string, id: string): Promise<EventRecord> {
    const { data, error } = await this.db
      .from('events')
      .update({ closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id.toUpperCase())
      .eq('owner_id', ownerId)
      .select('*')
      .maybeSingle();
    if (error?.code === UNDEFINED_COLUMN) {
      throw new ServiceUnavailableException(`Closing events is not set up. Apply ${CORE_GAPS_MIGRATION}.`);
    }
    if (error) throw new InternalServerErrorException(`Could not close the event: ${error.message}`);
    if (!data) throw new NotFoundException(`No event with id ${id}`);
    const [record] = await this.withThemes([toRecord(data)]);
    return record!;
  }

  /**
   * The create flow's choices. Choosing a theme implies a template build;
   * switching to a custom build clears any theme picked earlier.
   */
  async update(ownerId: string, id: string, input: UpdateEventInput): Promise<EventRecord> {
    const patch: EventPatch = {};

    if (input.slug !== undefined) patch.slug = parseSlug(input.slug);

    if (input.details !== undefined) {
      const current = await this.findOneFor(ownerId, id);
      patch.details = parseDetails((await this.modeRow(current.mode)).fields, input.details);
    }

    if (input.families !== undefined) {
      const current = await this.findOneFor(ownerId, id);
      patch.families = parseFamilies(await this.familySectionsFor(current.mode), input.families);
    }

    if (input.buildType !== undefined) {
      if (input.buildType !== 'template' && input.buildType !== 'custom') {
        throw new BadRequestException("buildType must be 'template' or 'custom'");
      }
      patch.build_type = input.buildType;
      if (input.buildType === 'custom') patch.theme_id = null;
    }

    if (input.themeId !== undefined) {
      if (typeof input.themeId !== 'string' || !UUID.test(input.themeId)) {
        throw new BadRequestException('themeId must be a theme id');
      }
      await this.assertActiveTheme(input.themeId);
      patch.theme_id = input.themeId;
      patch.build_type = 'template';
    }

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('Nothing to update: send details, families, slug, buildType and/or themeId');
    }

    return this.applyPatch(id, patch, ownerId);
  }

  /**
   * Admin-only: lifecycle state (publishing), subdomain and name on any
   * event. Reachable only through @Roles('admin') routes.
   */
  async updateAsAdmin(id: string, input: AdminUpdateEventInput): Promise<EventRecord> {
    const patch: EventPatch = {};

    if (input.slug !== undefined) patch.slug = parseSlug(input.slug);
    if (input.name !== undefined) {
      const name = this.parseText(input.name, MAX_NAME, 'name');
      if (!name) throw new BadRequestException('name cannot be empty');
      patch.name = name;
    }
    if (input.state !== undefined) {
      patch.state = this.parseState(input.state) ?? undefined;
      if (!patch.state) throw new BadRequestException('state cannot be empty');
      if (patch.state === 'live') patch.published_at = new Date().toISOString();
    }

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('Nothing to update: send state, slug and/or name');
    }

    if (patch.state === 'live') {
      const current = await this.findAnyById(id);
      const slug = patch.slug === undefined ? current.slug : patch.slug;
      if (!slug) throw new BadRequestException('Give the event a subdomain before publishing it');
    }

    return this.applyPatch(id, patch, null);
  }

  /** Writes a patch, scoped to the owner unless ownerId is null (admin). */
  private async applyPatch(id: string, patch: EventPatch, ownerId: string | null): Promise<EventRecord> {
    let query = this.db
      .from('events')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id.toUpperCase());

    if (ownerId) query = query.eq('owner_id', ownerId);

    const { data, error } = await query.select('*').maybeSingle();

    if (error?.code === UNIQUE_VIOLATION) {
      throw new BadRequestException(`The subdomain "${patch.slug}" is already taken`);
    }

    if (error) {
      throw new InternalServerErrorException(`Could not update event: ${error.message}`);
    }

    if (!data) {
      throw new NotFoundException(`No event with id ${id}`);
    }

    const [record] = await this.withThemes([toRecord(data)]);

    return record!;
  }

  private async assertActiveTheme(themeId: string): Promise<void> {
    const { data, error } = await this.db
      .from('themes')
      .select('id')
      .eq('id', themeId)
      .eq('active', true)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(`Could not check theme: ${error.message}`);
    }

    if (!data) {
      throw new BadRequestException('That theme is not available');
    }
  }

  /** The occasion's row, or a 400 naming the valid values. */
  /** The Ceremony Info sections for an occasion (20260929000000_event_info.sql). */
  private async familySectionsFor(mode: string) {
    const { data, error } = await this.db.from('event_modes').select('*').eq('value', mode).maybeSingle();
    if (error) throw new InternalServerErrorException(`Could not load the occasion: ${error.message}`);
    const row = data as Record<string, unknown> | null;
    if (!row || !('family_sections' in row)) {
      throw new ServiceUnavailableException(
        'Ceremony info is not set up. Apply supabase/migrations/20260929000000_event_info.sql.',
      );
    }
    return familySections(row.family_sections);
  }

  private async modeRow(mode: string): Promise<{
    value: string;
    label: string;
    fields: DetailField[];
    name_template: string | null;
    slug_template: string | null;
    /** null until 20261012000000_modes_mercadopago.sql is applied. */
    privacy: ReturnType<typeof privacyDefaults> | null;
  }> {
    const { data, error } = await this.db
      .from('event_modes')
      .select('*')
      .eq('value', mode)
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(`Could not load the occasion: ${error.message}`);
    }
    if (!data) {
      throw new BadRequestException('mode must be one of the values from GET /api/event-types');
    }

    const row = data as Record<string, unknown>;
    return {
      value: data.value,
      label: data.label,
      name_template: data.name_template,
      slug_template: data.slug_template,
      fields: Array.isArray(data.fields) ? data.fields : [],
      privacy: 'privacy_defaults' in row ? privacyDefaults(row.privacy_defaults) : null,
    };
  }

  /** Subdomains already starting with `base`, to pick the next free one. */
  private async slugsLike(base: string): Promise<Set<string>> {
    const { data, error } = await this.db.from('events').select('slug').like('slug', `${base}%`);

    if (error) {
      throw new InternalServerErrorException(`Could not check subdomains: ${error.message}`);
    }

    return new Set(data.map((row) => row.slug).filter((s): s is string => Boolean(s)));
  }

  async remove(ownerId: string, id: string): Promise<void> {
    const { data, error } = await this.db
      .from('events')
      .delete()
      .eq('id', id.toUpperCase())
      .eq('owner_id', ownerId)
      .select('id');

    if (error) {
      throw new InternalServerErrorException(`Could not delete event: ${error.message}`);
    }

    // Scoping the delete by owner means "no rows" covers both a missing event
    // and someone else's, which is what we want to report either way.
    if (data.length === 0) {
      throw new NotFoundException(`No event with id ${id}`);
    }
  }

  // ---------------------------------------------------------------- admin
  // Everything below ignores ownership on purpose and is reachable only
  // through @Roles('admin'). Keep that decorator on any route that calls in.

  async findAllAsAdmin(filter: AdminEventFilter): Promise<AdminEventPage> {
    let query = this.db.from('events').select('*', { count: 'exact' });

    if (filter.ownerId) {
      query = query.eq('owner_id', filter.ownerId);
    }

    if (filter.type) {
      query = query.eq('type', filter.type);
    }

    if (filter.mode) {
      query = query.eq('mode', filter.mode);
    }

    if (filter.state) {
      query = query.eq('state', filter.state);
    }

    if (filter.search) {
      query = query.ilike('name', `%${filter.search}%`);
    }

    if (filter.from) {
      query = query.gte('event_date', filter.from);
    }

    if (filter.to) {
      query = query.lte('event_date', filter.to);
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(filter.offset, filter.offset + filter.limit - 1);

    if (error) {
      throw new InternalServerErrorException(`Could not load events: ${error.message}`);
    }

    return {
      events: await this.withThemes(data.map(toRecord)),
      total: count ?? data.length,
      limit: filter.limit,
      offset: filter.offset,
    };
  }

  async findAnyById(id: string): Promise<EventRecord> {
    const { data, error } = await this.db
      .from('events')
      .select('*')
      .eq('id', id.toUpperCase())
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(`Could not load event: ${error.message}`);
    }

    if (!data) {
      throw new NotFoundException(`No event with id ${id}`);
    }

    return toRecord(data);
  }

  async removeAny(id: string): Promise<void> {
    const { data, error } = await this.db
      .from('events')
      .delete()
      .eq('id', id.toUpperCase())
      .select('id');

    if (error) {
      throw new InternalServerErrorException(`Could not delete event: ${error.message}`);
    }

    if (data.length === 0) {
      throw new NotFoundException(`No event with id ${id}`);
    }
  }

  /**
   * PostgREST has no GROUP BY, so this is a handful of head-only count
   * queries rather than one aggregate. Cheap enough at this size; move it to
   * a Postgres view or RPC if the table ever gets large.
   */
  async stats(): Promise<EventStats> {
    const today = new Date().toISOString().slice(0, 10);

    const countOf = async (
      build: (q: ReturnType<LazoSupabaseClient['from']>) => unknown,
    ): Promise<number> => {
      const { count, error } = (await build(
        this.db.from('events'),
      )) as unknown as { count: number | null; error: { message: string } | null };

      if (error) {
        throw new InternalServerErrorException(`Could not load stats: ${error.message}`);
      }

      return count ?? 0;
    };

    const [total, upcoming, undated, ...perType] = await Promise.all([
      countOf((q) => q.select('*', { count: 'exact', head: true })),
      countOf((q) => q.select('*', { count: 'exact', head: true }).gte('event_date', today)),
      countOf((q) => q.select('*', { count: 'exact', head: true }).is('event_date', null)),
      ...EVENT_TYPES.map((type) =>
        countOf((q) => q.select('*', { count: 'exact', head: true }).eq('type', type)),
      ),
    ]);

    // One narrow read for the breakdowns PostgREST can't group. Fine at this
    // size; move to a view or RPC if the table grows large.
    const { data: rows, error: rowsError } = await this.db.from('events').select('mode, state, slug');

    if (rowsError) {
      throw new InternalServerErrorException(`Could not load stats: ${rowsError.message}`);
    }

    const tally = (key: 'mode' | 'state') =>
      rows.reduce<Record<string, number>>((acc, row) => {
        acc[row[key]] = (acc[row[key]] ?? 0) + 1;
        return acc;
      }, {});

    return {
      total,
      upcoming,
      undated,
      withSubdomain: rows.filter((row) => row.slug).length,
      byMode: tally('mode'),
      byState: tally('state'),
      byType: Object.fromEntries(
        EVENT_TYPES.map((type, index) => [type, perType[index] ?? 0]),
      ) as Record<EventType, number>,
    };
  }

  parseAdminQuery(query: AdminEventQuery): AdminEventFilter {
    return {
      ownerId: this.parseText(query.ownerId, 120, 'ownerId') || null,
      type: query.type === undefined || query.type === '' ? null : this.parseType(query.type),
      mode: this.parseText(query.mode, MAX_MODE, 'mode') || null,
      state: this.parseState(query.state),
      search: this.parseSearch(query.search),
      from: this.parseDate(query.from),
      to: this.parseDate(query.to),
      limit: this.parseBoundedInt(query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE, 'limit'),
      offset: this.parseBoundedInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset'),
    };
  }

  /**
   * The text goes into an ilike pattern, so the wildcards have to go: a bare
   * `%` would turn a search into "match everything", and a comma would be read
   * as a filter separator by PostgREST.
   */
  private parseSearch(value: unknown): string | null {
    const search = this.parseText(value, MAX_SEARCH, 'search')
      .replace(WILDCARDS, ' ')
      .trim();

    return search || null;
  }

  private parseState(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (!STATES.includes(value as (typeof STATES)[number])) {
      throw new BadRequestException(`state must be one of: ${STATES.join(', ')}`);
    }
    return value as string;
  }

  private parseBoundedInt(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
    field: string,
  ): number {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new BadRequestException(`${field} must be a whole number between ${min} and ${max}`);
    }

    return parsed;
  }

  private get db(): LazoSupabaseClient {
    if (!this.supabase) {
      throw new ServiceUnavailableException('The database is not configured');
    }

    return this.supabase;
  }

  private parseText(value: unknown, max: number, field: string): string {
    if (value === undefined || value === null) {
      return '';
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }

    const text = value.trim();

    if (text.length > max) {
      throw new BadRequestException(`${field} must be at most ${max} characters`);
    }

    return text;
  }

  private parseType(value: unknown): EventType {
    if (value === undefined || value === null || value === '') {
      return 'other';
    }

    if (!EVENT_TYPES.includes(value as EventType)) {
      throw new BadRequestException(`type must be one of: ${EVENT_TYPES.join(', ')}`);
    }

    return value as EventType;
  }

  /** Returns null rather than '' — the column is a nullable date. */
  private parseDate(value: unknown): string | null {
    const date = this.parseText(value, 10, 'date');

    if (!date) {
      return null;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
      throw new BadRequestException('date must be a valid YYYY-MM-DD date');
    }

    return date;
  }

  private parseGuestCount(value: unknown): number | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    const count = Number(value);

    if (!Number.isInteger(count) || count < 0 || count > 100_000) {
      throw new BadRequestException('guestCount must be a whole number between 0 and 100000');
    }

    return count;
  }
}

/** Claim tokens are stored hashed, like passwords: a DB read must not yield a usable token. */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function generateId(): string {
  let code = '';

  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }

  return code;
}

type EventPatch = {
  build_type?: 'template' | 'custom';
  closed_at?: string | null;
  theme_id?: string | null;
  slug?: string | null;
  state?: string;
  name?: string;
  published_at?: string;
  details?: Record<string, string>;
  families?: Record<string, { father: string; mother: string; address: string }>;
};

function toRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    // Null only for anonymous drafts, which owner-scoped reads never return.
    ownerId: row.owner_id ?? '',
    name: row.name,
    type: row.type as EventType,
    date: row.event_date ?? '',
    location: row.location,
    guestCount: row.guest_count,
    createdAt: row.created_at,
    slug: row.slug,
    mode: row.mode,
    state: row.state,
    visibility: row.visibility,
    timezone: row.timezone,
    palette: row.palette,
    locale: row.locale,
    currency: row.currency,
    tier: row.tier,
    claimedAt: row.claimed_at,
    paidAt: row.paid_at,
    publishedAt: row.published_at,
    closedAt: row.closed_at ?? null,
    updatedAt: row.updated_at,
    buildType: row.build_type,
    themeId: row.theme_id,
    theme: null,
    siteUrl: siteUrlFor(row.slug),
    details: row.details ?? {},
    families: row.families ?? {},
    privacy: {
      passwordRequired: (row as { password_required?: boolean }).password_required === true,
      searchable: (row as { searchable?: boolean }).searchable !== false,
      guestUploads: (row as { gallery_open?: boolean }).gallery_open !== false,
      showGuestCount: (row as { show_guest_count?: boolean }).show_guest_count !== false,
    },
  };
}
