-- Create flow, after sign-in: how the site gets built, and which theme.
--
-- The flow's progress lives on the event row itself (state = 'draft'), so a
-- reload, another tab or another device resumes where the host left off:
--   events.build_type  — 'template' (Build your site) or 'custom' (our team)
--   events.theme_id    — the chosen theme, for template builds
--
-- themes starts empty on purpose: rows are added in Supabase (or later an
-- admin screen) with real preview images. GET /api/themes serves active rows.

-- ============================================================ themes

create table if not exists public.themes (
  id           uuid        primary key default gen_random_uuid(),
  slug         text        not null unique check (slug ~ '^[a-z0-9-]+$'),
  name         text        not null check (length(name) between 1 and 80),
  description  text        not null default '' check (length(description) <= 200),
  preview_url  text        not null,                 -- card image, https URL
  -- Occasions the theme suits (event_modes.value). Empty means every occasion.
  modes        text[]      not null default '{}',
  position     integer     not null default 0,
  active       boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists themes_active_idx on public.themes (active, position);

alter table public.themes enable row level security;

-- ============================================================ services

-- Priced things the host can order, so a price is a row and never a literal
-- in the UI. Money is integer centavos plus currency (PAY-6).
create table if not exists public.services (
  key             text        primary key check (key ~ '^[a-z0-9_]+$'),
  name            text        not null,
  price_centavos  integer     not null check (price_centavos >= 0),
  currency        text        not null default 'MXN',
  active          boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.services enable row level security;

-- The one price the product already states: a custom site is 599 pesos.
insert into public.services (key, name, price_centavos, currency) values
  ('custom_theme', 'Custom website design', 59900, 'MXN')
on conflict (key) do nothing;

-- ============================================================ events (extend)

alter table public.events
  add column if not exists build_type text check (build_type in ('template', 'custom')),
  add column if not exists theme_id   uuid references public.themes (id) on delete set null;

-- ============================================================ custom requests

create table if not exists public.custom_theme_requests (
  id              uuid        primary key default gen_random_uuid(),
  event_id        text        not null references public.events (id) on delete cascade,
  owner_id        text        not null,
  service_key     text        not null references public.services (key),
  -- The price at the moment of asking; a later price change doesn't rewrite it.
  price_centavos  integer     not null check (price_centavos >= 0),
  currency        text        not null,
  status          text        not null default 'requested'
    check (status in ('requested', 'in_progress', 'delivered', 'cancelled')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- At most one open request per event; asking twice returns the same one.
create unique index if not exists custom_theme_requests_open_idx
  on public.custom_theme_requests (event_id)
  where status in ('requested', 'in_progress');

create index if not exists custom_theme_requests_owner_idx
  on public.custom_theme_requests (owner_id, created_at desc);

alter table public.custom_theme_requests enable row level security;
