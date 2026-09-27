/**
 * Hand-written to match supabase/migrations. Kept small on purpose — regenerate
 * with `npx supabase gen types typescript` once the schema grows.
 *
 * Everything here is a `type`, not an `interface`, and that matters: supabase-js
 * constrains each table to `Record<string, unknown>`, and only type aliases of
 * object literals get TypeScript's implicit index signature. An interface fails
 * that constraint silently — the client falls back to an untyped schema and
 * every query degrades to `never`.
 */
export type EventRow = {
  id: string;
  // Null only while state = 'anonymous_draft' (20261008000000_core_gaps.sql).
  owner_id: string | null;
  name: string;
  type: string;
  event_date: string | null;
  location: string;
  guest_count: number | null;
  created_at: string;
  // Added by 20260924100000_v1_backbone.sql; all have defaults or are nullable.
  slug: string | null;
  mode: string;
  state: string;
  visibility: string;
  timezone: string;
  palette: string;
  locale: string;
  currency: string;
  tier: string | null;
  claimed_at: string | null;
  paid_at: string | null;
  published_at: string | null;
  updated_at: string;
  // Added by 20260925000000_website_builder.sql.
  build_type: 'template' | 'custom' | null;
  theme_id: string | null;
  // Added by 20260925100000_event_details.sql: answers keyed by field key.
  details: Record<string, string>;
  // Added by 20260929000000_event_info.sql (absent until it is applied).
  families?: Record<string, { father: string; mother: string; address: string }>;
  // Privacy switches from 20261012000000_modes_mercadopago.sql (absent until applied).
  password_required?: boolean;
  searchable?: boolean;
  show_guest_count?: boolean;
  gallery_open?: boolean;
  // Added by 20261008000000_core_gaps.sql (absent until it is applied).
  claim_token_hash?: string | null;
  claim_expires_at?: string | null;
  closed_at?: string | null;
};

/** Columns Postgres fills in (or leaves null) when the insert omits them. */
type EventDefaulted =
  | 'created_at'
  | 'slug'
  | 'mode'
  | 'state'
  | 'visibility'
  | 'timezone'
  | 'palette'
  | 'locale'
  | 'currency'
  | 'tier'
  | 'claimed_at'
  | 'paid_at'
  | 'published_at'
  | 'updated_at'
  | 'build_type'
  | 'theme_id'
  | 'details';

export type EventInsert = Omit<EventRow, EventDefaulted> & Partial<Pick<EventRow, EventDefaulted>>;

export type EventModeRow = {
  value: string;
  label: string;
  position: number;
  active: boolean;
  created_at: string;
  // Added by 20260925100000_event_details.sql.
  fields: { key: string; label: string; required?: boolean; maxLength?: number }[];
  name_template: string | null;
  slug_template: string | null;
  // Added by 20260928000000_homepage.sql (absent until it is applied).
  description?: string;
  image_url?: string;
};

export type EventModeInsert = Omit<
  EventModeRow,
  'position' | 'active' | 'created_at' | 'fields' | 'name_template' | 'slug_template' | 'description' | 'image_url'
> &
  Partial<Pick<EventModeRow, 'position' | 'active' | 'created_at'>>;

export type UserRow = {
  id: string;
  email: string | null;
  email_verified: boolean;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  clerk_created_at: string | null;
  last_sign_in_at: string | null;
  created_at: string;
  updated_at: string;
};

export type UserInsert = Omit<UserRow, 'created_at' | 'updated_at'> &
  Partial<Pick<UserRow, 'created_at' | 'updated_at'>>;

export type ThemeRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  preview_url: string;
  modes: string[];
  position: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type ThemeInsert = Pick<ThemeRow, 'slug' | 'name' | 'preview_url'> &
  Partial<Omit<ThemeRow, 'slug' | 'name' | 'preview_url'>>;

export type ServiceRow = {
  key: string;
  name: string;
  price_centavos: number;
  currency: string;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type ServiceInsert = Pick<ServiceRow, 'key' | 'name' | 'price_centavos'> &
  Partial<Omit<ServiceRow, 'key' | 'name' | 'price_centavos'>>;

export type CustomThemeRequestRow = {
  id: string;
  event_id: string;
  owner_id: string;
  service_key: string;
  price_centavos: number;
  currency: string;
  status: 'requested' | 'in_progress' | 'delivered' | 'cancelled';
  created_at: string;
  updated_at: string;
};

export type CustomThemeRequestInsert = Omit<
  CustomThemeRequestRow,
  'id' | 'status' | 'created_at' | 'updated_at'
> &
  Partial<Pick<CustomThemeRequestRow, 'id' | 'status' | 'created_at' | 'updated_at'>>;

export type ApiKeyRow = {
  id: string;
  owner_id: string;
  name: string;
  prefix: string;
  hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** id and created_at are filled in by Postgres defaults. */
export type ApiKeyInsert = Omit<ApiKeyRow, 'id' | 'created_at' | 'last_used_at' | 'revoked_at'> & {
  id?: string;
  created_at?: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
};

export type Database = {
  public: {
    Tables: {
      events: {
        Row: EventRow;
        Insert: EventInsert;
        Update: Partial<EventInsert>;
        Relationships: [];
      };
      event_modes: {
        Row: EventModeRow;
        Insert: EventModeInsert;
        Update: Partial<EventModeInsert>;
        Relationships: [];
      };
      themes: {
        Row: ThemeRow;
        Insert: ThemeInsert;
        Update: Partial<ThemeInsert>;
        Relationships: [];
      };
      services: {
        Row: ServiceRow;
        Insert: ServiceInsert;
        Update: Partial<ServiceInsert>;
        Relationships: [];
      };
      custom_theme_requests: {
        Row: CustomThemeRequestRow;
        Insert: CustomThemeRequestInsert;
        Update: Partial<CustomThemeRequestInsert>;
        Relationships: [];
      };
      users: {
        Row: UserRow;
        Insert: UserInsert;
        Update: Partial<UserInsert>;
        Relationships: [];
      };
      api_keys: {
        Row: ApiKeyRow;
        Insert: ApiKeyInsert;
        Update: Partial<ApiKeyInsert>;
        Relationships: [];
      };
    };
    // Mapped-over-never, exactly as `supabase gen types` emits an empty group:
    // a plain Record<string, never> would give Views an index signature that
    // swallows every name, and from('events') would resolve to a view.
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
