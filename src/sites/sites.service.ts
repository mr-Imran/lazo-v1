import { Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { normalize, tokenMatches } from '../site-content/site-content.service.js';
import type { SiteContent } from '../site-content/site-content.service.js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import type { EventRow } from '../supabase/database.types.js';
import { familySections } from '../events/event-details.js';
import { sections as modeSections, vocabulary as modeVocabulary } from '../events/mode-config.js';
import type { SectionKey, Vocabulary } from '../events/mode-config.js';

/** A ceremony, reception… from sub_events, as a public site shows it. */
export interface PublicSubEvent {
  name: string;
  kind: string;
  startsAt: string | null;
  endsAt: string | null;
  venueName: string;
  address: string;
  dressCode: string;
  /** Local wall-clock values, as the host entered them (YYYY-MM-DD, HH:MM). */
  date: string | null;
  arriveTime: string | null;
  beginTime: string | null;
  /** The venue's photo, when it is a vendor location. */
  imageUrl: string;
}

/** A family on the site: names only. Addresses stay private. */
export interface PublicFamily {
  key: string;
  title: string;
  name: string;
  father: string;
  mother: string;
}

/** A registry entry as guests see it — no internal ids or payment state. */
export interface PublicRegistryItem {
  id: string;
  /** available | purchased (a guest reported buying it) */
  status: string;
  goalCents: number | null;
  kind: string;
  title: string;
  description: string;
  imageUrl: string;
  externalUrl: string;
  priceCents: number | null;
  currency: string;
  /** From the retailer's last stock check; null when unknown / not a store item. */
  available: boolean | null;
}

/** What a public site page needs, and nothing that isn't meant to be public. */
export interface PublicSite {
  slug: string;
  name: string;
  mode: string;
  occasion: string | null;
  date: string | null;
  location: string;
  state: EventRow['state'];
  locale: string;
  timezone: string;
  /** Occasion answers: names of the couple, honoree… */
  details: Record<string, string>;
  /** Picks the layout, e.g. "redtheme"; null renders the default page. */
  themeSlug: string | null;
  themeName: string | null;
  themeImage: string | null;
  subEvents: PublicSubEvent[];
  families: PublicFamily[];
  registry: PublicRegistryItem[];
  /** Whether guests can RSVP now (20260930000000_guests_rsvp.sql), and by when. */
  rsvp: { open: boolean; deadline: string | null };
  /** Story, FAQ, where to stay, invitation wording, gift note and bank details (20261001000000_site_content.sql). */
  content: SiteContent;
  /** Internal: the site password hash, checked by the controller and never sent. */
  passwordHash: string | null;
  /** Internal: for view counting; never sent. */
  eventId: string;
  /** Free sites carry Lazo branding; paid plans may hide it. */
  tier: string | null;
  galleryOpen: boolean;
  /** The mode's ordered section list (event_modes.sections). RSVP and registry are already stripped when absent. */
  sections: SectionKey[];
  /** The mode's labels per language (event_modes.vocabulary). */
  vocabulary: Vocabulary;
  /** Whether the site may say how many are coming (privacy default per mode). */
  showGuestCount: boolean;
}

@Injectable()
export class SitesService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
  ) {}

  /** The site at a subdomain, or null if no event claims it. */
  async findBySlug(slug: string): Promise<PublicSite | null> {
    const { data: event, error } = await this.db
      .from('events')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();

    if (error) throw new Error(`Could not load the site: ${error.message}`);
    if (!event) return null;

    // The tables below aren't in the hand-written schema types, so they are
    // read untyped and mapped field by field into the public shape.
    const untyped = this.db as unknown as {
      from: (table: string) => {
        select: (columns: string) => {
          eq: (column: string, value: string) => {
            order: (column: string, options: { ascending: boolean }) => Promise<{
              data: Record<string, unknown>[] | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };

    const [mode, theme, subEvents, registry] = await Promise.all([
      // '*' so the family columns are read when their migration is applied, and ignored when not.
      this.db.from('event_modes').select('*').eq('value', event.mode).maybeSingle(),
      event.theme_id
        ? this.db.from('themes').select('slug, name, preview_url').eq('id', event.theme_id).maybeSingle()
        : Promise.resolve({ data: null }),
      untyped
        .from('sub_events')
        .select('*')
        .eq('event_id', event.id)
        .order('position', { ascending: true }),
      untyped
        .from('registry_items')
        .select('*')
        .eq('event_id', event.id)
        .order('position', { ascending: true }),
    ]);

    if (subEvents.error) throw new Error(`Could not load the schedule: ${subEvents.error.message}`);
    if (registry.error) throw new Error(`Could not load the registry: ${registry.error.message}`);

    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    const textOrNull = (v: unknown) => (typeof v === 'string' ? v : null);
    const hhmm = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 5) : null);
    const details = (event.details ?? {}) as Record<string, string>;
    const answers = (event.families ?? {}) as Record<string, { father?: string; mother?: string }>;
    const modeRow = (mode.data ?? {}) as Record<string, unknown>;
    // Which sections the mode shows decides what leaves the server (EVT-3/5):
    // a corporate site never carries the registry, a memorial never RSVP.
    const sections = modeSections(modeRow.sections);
    const showRegistry = sections.includes('registry');
    const showRsvp = sections.includes('rsvp');
    const families = familySections((mode.data as Record<string, unknown> | null)?.family_sections).map((f) => ({
      key: f.key,
      title: f.title,
      name: details[f.nameKey] ?? '',
      father: answers[f.key]?.father ?? '',
      mother: answers[f.key]?.mother ?? '',
    }));

    return {
      slug,
      name: event.name,
      mode: event.mode,
      occasion: mode.data?.label ?? null,
      date: event.event_date,
      location: event.location,
      state: event.state,
      locale: event.locale,
      timezone: event.timezone,
      details: event.details ?? {},
      themeSlug: theme.data?.slug ?? null,
      themeName: theme.data?.name ?? null,
      themeImage: theme.data?.preview_url || null,
      subEvents: (subEvents.data ?? []).map((row) => ({
        name: text(row.name),
        kind: text(row.kind),
        startsAt: textOrNull(row.starts_at),
        endsAt: textOrNull(row.ends_at),
        venueName: text(row.venue_name),
        address: text(row.address),
        dressCode: text(row.dress_code),
        date: textOrNull(row.event_date),
        arriveTime: hhmm(row.arrive_time),
        beginTime: hhmm(row.begin_time),
        imageUrl: text(row.image_url),
      })),
      families,
      content: normalize((event as { site_content?: unknown }).site_content),
      passwordHash: (event as { site_password_hash?: string | null }).site_password_hash || null,
      eventId: event.id,
      tier: (event as { tier?: string | null }).tier ?? null,
      galleryOpen: (event as { gallery_open?: boolean }).gallery_open !== false,
      sections,
      vocabulary: modeVocabulary(modeRow.vocabulary),
      showGuestCount: (event as { show_guest_count?: boolean }).show_guest_count !== false,
      rsvp: {
        // Closed events (post-event flow, 20261008000000_core_gaps.sql) keep the site, not the RSVP.
        open: showRsvp && (event as { rsvp_open?: boolean }).rsvp_open === true && !(event as { closed_at?: string | null }).closed_at,
        deadline: (event as { rsvp_deadline?: string | null }).rsvp_deadline ?? null,
      },
      // Withdrawn gifts stay out of the public list.
      registry: (showRegistry ? (registry.data ?? []) : [])
        .filter((row) => row.status !== 'cancelled' && row.status !== 'refunded')
        .map((row) => ({
          id: text(row.id),
          status: text(row.status) || 'available',
          goalCents: typeof row.goal_cents === 'number' ? row.goal_cents : null,
          kind: text(row.kind),
          title: text(row.title),
          description: text(row.description),
          imageUrl: text(row.image_url),
          externalUrl: text(row.external_url),
          priceCents: typeof row.price_cents === 'number' ? row.price_cents : null,
          currency: text(row.currency) || 'MXN',
          available: typeof row.available === 'boolean' ? row.available : null,
        })),
    };
  }

  /** One page load of a live site (site_views). Best effort: never fails the request. */
  async countView(eventId: string): Promise<void> {
    try {
      await (this.db as unknown as { rpc: (fn: string, args: object) => Promise<unknown> }).rpc('lazo_count_site_view', {
        p_event_id: eventId,
      });
    } catch {
      // Missing migration or a hiccup: the site still loads.
    }
  }

  /** The bits of an event the public password gate needs. */
  async gate(slug: string): Promise<{ eventId: string; slug: string; state: string; passwordHash: string | null } | null> {
    const clean = String(slug).toLowerCase();
    if (!/^[a-z0-9-]{1,63}$/.test(clean)) return null;
    const { data, error } = await this.db.from('events').select('*').eq('slug', clean).maybeSingle();
    if (error) throw new Error(`Could not load the site: ${error.message}`);
    if (!data) return null;
    return {
      eventId: data.id,
      slug: clean,
      state: data.state,
      passwordHash: (data as { site_password_hash?: string | null }).site_password_hash || null,
    };
  }

  /** A live site the caller may see: 404 if not live, 401 if it is protected and the token is missing. */
  async openGate(slug: string, token: unknown): Promise<{ eventId: string }> {
    const gate = await this.gate(slug);
    if (!gate || gate.state !== 'live') throw new NotFoundException({ message: 'No site at this address', reason: 'missing' });
    if (gate.passwordHash && !tokenMatches(gate.slug, gate.passwordHash, token)) {
      throw new UnauthorizedException({ message: 'This site is private. Enter the password to continue.', reason: 'password' });
    }
    return { eventId: gate.eventId };
  }

  /** Whether a subdomain is free, ignoring the asking event's own claim. */
  async isAvailable(slug: string, exceptEventId?: string): Promise<boolean> {
    let query = this.db.from('events').select('id').eq('slug', slug);
    if (exceptEventId) query = query.neq('id', exceptEventId.toUpperCase());

    const { data, error } = await query.limit(1);
    if (error) throw new Error(`Could not check the subdomain: ${error.message}`);

    return data.length === 0;
  }

  private get db(): LazoSupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase;
  }
}
