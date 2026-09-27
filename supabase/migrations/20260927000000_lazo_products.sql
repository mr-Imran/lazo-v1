-- Lazo's own products: listed by the Lazo team from the admin dashboard, not
-- by a vendor, so they skip vendor review.
--
-- Two ways to sell:
--   affiliate — the host buys on another store through affiliate_url. Name,
--               description, image and price are read from that page when
--               the admin pastes the link (and can be edited or re-read).
--   direct    — Lazo sells it at price_cents.
--
-- Hosts see active products in Find vendors next to vendor listings.

create table if not exists public.lazo_products (
  id               uuid        primary key default gen_random_uuid(),
  sale_type        text        not null check (sale_type in ('affiliate', 'direct')),
  name             text        not null check (length(name) between 1 and 200),
  description      text        not null default '' check (length(description) <= 4000),
  department       text        not null default 'retail' check (department in (
    'venues', 'planning', 'catering', 'snacks', 'beverages', 'desserts', 'live_music',
    'dj', 'shows', 'print', 'flowers', 'travel', 'retail', 'apparel', 'other')),
  price_cents      bigint      check (price_cents >= 0),
  currency         text        not null default 'MXN' check (currency ~ '^[A-Z]{3}$'),
  image_url        text        not null default '',
  -- Affiliate only: the link hosts are sent to, the page it landed on, and
  -- the store's host name ("amazon.com.mx") shown as "Buy on …".
  affiliate_url    text        not null default '' check (length(affiliate_url) <= 2000),
  source_url       text        not null default '' check (length(source_url) <= 2000),
  source_site      text        not null default '' check (length(source_site) <= 120),
  scraped_at       timestamptz,
  featured         boolean     not null default false,
  active           boolean     not null default true,
  position         integer     not null default 0,
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (sale_type <> 'affiliate' or affiliate_url <> ''),
  check (sale_type <> 'direct' or price_cents is not null)
);

create index if not exists lazo_products_active_idx on public.lazo_products (active, position);
alter table public.lazo_products enable row level security;

-- A host adding a Lazo product to one of their events (like vendor_selections).
create table if not exists public.lazo_product_picks (
  id          uuid        primary key default gen_random_uuid(),
  event_id    text        not null references public.events (id) on delete cascade,
  owner_id    text        not null,
  product_id  uuid        not null references public.lazo_products (id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (event_id, product_id)
);

create index if not exists lazo_product_picks_product_idx on public.lazo_product_picks (product_id);
alter table public.lazo_product_picks enable row level security;

-- Clicks on an affiliate "Buy" button, one per signed-in viewer, product and day.
create table if not exists public.lazo_product_clicks (
  id          uuid        primary key default gen_random_uuid(),
  product_id  uuid        not null references public.lazo_products (id) on delete cascade,
  viewer_id   text        not null,
  clicked_on  date        not null default current_date,
  created_at  timestamptz not null default now(),
  unique (viewer_id, product_id, clicked_on)
);

create index if not exists lazo_product_clicks_product_idx on public.lazo_product_clicks (product_id);
alter table public.lazo_product_clicks enable row level security;
