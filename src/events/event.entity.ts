export const EVENT_TYPES = [
  'wedding',
  'quinceanera',
  'baptism',
  'corporate',
  'other',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Used to name an event that was created from a type and a date alone. */
export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  wedding: 'Wedding',
  quinceanera: 'Quinceañera',
  baptism: 'Baptism',
  corporate: 'Corporate event',
  other: 'Event',
};

/** How each type reads as a choice in the create flow's occasion picker. */
export const EVENT_TYPE_OPTION_LABELS: Record<EventType, string> = {
  wedding: 'Wedding',
  quinceanera: 'Quinceañera',
  baptism: 'Baptism',
  corporate: 'Corporate',
  other: 'Other',
};

export interface EventRecord {
  /** Short, human-shareable code — the event's public identity. */
  readonly id: string;
  readonly ownerId: string;
  name: string;
  type: EventType;
  /** ISO date (YYYY-MM-DD). Empty while the couple is still deciding. */
  date: string;
  location: string;
  guestCount: number | null;
  readonly createdAt: string;
  slug: string | null;
  mode: string;
  state: string;
  visibility: string;
  timezone: string;
  palette: string;
  locale: string;
  currency: string;
  tier: string | null;
  readonly claimedAt: string | null;
  readonly paidAt: string | null;
  readonly publishedAt: string | null;
  /** Set by the post-event flow's "Close event" (20261008000000_core_gaps.sql); RSVP stops, the site stays. */
  readonly closedAt: string | null;
  readonly updatedAt: string;
  /** How the site is being built; null until the host picks. */
  buildType: 'template' | 'custom' | null;
  /** The chosen theme for a template build. */
  themeId: string | null;
  /** The chosen theme's card, for listing screens; null without a theme. */
  theme: { id: string; name: string; previewUrl: string } | null;
  /** https://<slug>.<SITE_DOMAIN>, or null until the event has a slug. */
  siteUrl: string | null;
  /** Occasion-specific answers (names…), keyed by event_modes.fields keys. */
  details: Record<string, string>;
  /** Ceremony Info answers, keyed by event_modes.family_sections keys. Owner-only. */
  families: Record<string, FamilyAnswers>;
  /** Privacy switches, seeded from the mode's defaults (20261012000000_modes_mercadopago.sql). */
  privacy: { passwordRequired: boolean; searchable: boolean; guestUploads: boolean; showGuestCount: boolean };
}

export interface FamilyAnswers {
  father: string;
  mother: string;
  address: string;
}

/** PATCH /api/events/:id — only the create-flow choices, for now. */
export interface UpdateEventInput {
  buildType?: unknown;
  themeId?: unknown;
  /** Subdomain: <slug>.<SITE_DOMAIN>. null or "" clears it. */
  slug?: unknown;
  /** Replaces the occasion answers; validated against the event's mode. */
  details?: unknown;
  /** Replaces the Ceremony Info answers; validated against the mode's family_sections. */
  families?: unknown;
}

/** PATCH /api/admin/events/:id */
export interface AdminUpdateEventInput {
  state?: unknown;
  slug?: unknown;
  name?: unknown;
}

export interface CreateEventInput {
  name?: unknown;
  type?: unknown;
  /** An event_modes.value; the database default applies when omitted. */
  mode?: unknown;
  /** Answers to the mode's fields; drive the default name and subdomain. */
  details?: unknown;
  date?: unknown;
  location?: unknown;
  guestCount?: unknown;
}

/** Raw query string for the admin event list, before validation. */
export interface AdminEventQuery {
  ownerId?: unknown;
  type?: unknown;
  mode?: unknown;
  state?: unknown;
  search?: unknown;
  from?: unknown;
  to?: unknown;
  limit?: unknown;
  offset?: unknown;
}

export interface AdminEventFilter {
  ownerId: string | null;
  type: EventType | null;
  mode: string | null;
  state: string | null;
  search: string | null;
  from: string | null;
  to: string | null;
  limit: number;
  offset: number;
}

export interface AdminEventPage {
  events: EventRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface EventStats {
  total: number;
  upcoming: number;
  undated: number;
  withSubdomain: number;
  byMode: Record<string, number>;
  byState: Record<string, number>;
  byType: Record<EventType, number>;
}
