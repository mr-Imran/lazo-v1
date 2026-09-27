// The per-mode configuration added by 20261012000000_modes_mercadopago.sql:
// vocabulary (UI labels per language), privacy defaults (copied onto a new
// event) and the ordered section list the public site renders. Everything
// here tolerates the columns being absent so older databases still work.

export const MODES_MIGRATION = 'supabase/migrations/20261012000000_modes_mercadopago.sql';

/** { es: { guests: "Asistentes", … }, en: { … } } */
export type Vocabulary = Record<string, Record<string, string>>;

export interface PrivacyDefaults {
  passwordRequired: boolean;
  searchable: boolean;
  guestUploads: boolean;
  showGuestCount: boolean;
}

/** Section keys a mode can list. Unknown keys in the row are dropped. */
export const SECTION_KEYS = [
  'hero',
  'story',
  'schedule',
  'venue',
  'registry',
  'rsvp',
  'photos',
  'agenda',
  'speakers',
  'materials',
  'life',
  'service',
  'condolences',
  'donations',
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** Sections every mode shows when the row has none configured (pre-migration behaviour). */
export const DEFAULT_SECTIONS: SectionKey[] = ['hero', 'story', 'schedule', 'venue', 'registry', 'rsvp', 'photos'];

export function vocabulary(value: unknown): Vocabulary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Vocabulary = {};
  for (const [lang, labels] of Object.entries(value as Record<string, unknown>)) {
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) continue;
    out[lang] = Object.fromEntries(
      Object.entries(labels as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  }
  return out;
}

/** Everything open unless the row says otherwise — the pre-migration behaviour. */
export function privacyDefaults(value: unknown): PrivacyDefaults {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  return {
    passwordRequired: v.password_required === true,
    searchable: v.searchable !== false,
    guestUploads: v.guest_uploads !== false,
    showGuestCount: v.show_guest_count !== false,
  };
}

export function sections(value: unknown): SectionKey[] {
  if (!Array.isArray(value)) return DEFAULT_SECTIONS;
  const known = value.filter((k): k is SectionKey => typeof k === 'string' && (SECTION_KEYS as readonly string[]).includes(k));
  return known.length ? known : DEFAULT_SECTIONS;
}

export const GIFTS_MIGRATION = 'supabase/migrations/20261016000000_mode_gifts.sql';

/** Copy and store-search ideas for the Gift step, per occasion (event_modes.gifts). */
export interface GiftConfig {
  hint: string;
  fundLabel: string;
  fundExample: string;
  itemExample: string;
  searchIdeas: string[];
}

/** Empty strings and no ideas until the gifts migration fills the row; the UI keeps generic wording then. */
export function giftConfig(value: unknown): GiftConfig {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '');
  return {
    hint: str('hint'),
    fundLabel: str('fundLabel'),
    fundExample: str('fundExample'),
    itemExample: str('itemExample'),
    searchIdeas: Array.isArray(v.searchIdeas) ? v.searchIdeas.filter((x): x is string => typeof x === 'string').slice(0, 12) : [],
  };
}
