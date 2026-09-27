-- Vendor side: profiles that are approved before they go public, products and
-- venue locations that are reviewed before hosts see them, promotion
-- requests, and the numbers vendors are shown (views and selections).
--
-- Builds on public.vendors / public.vendor_packages from the V1 backbone.
-- vendors.status keeps its lifecycle: candidate → pending_approval → active,
-- or rejected (with review_note) / paused.

-- ============================================================ vendors (extend)

alter table public.vendors
  add column if not exists description  text        not null default '' check (length(description) <= 2000),
  add column if not exists phone        text        not null default '' check (length(phone) <= 40),
  add column if not exists email        text        not null default '' check (length(email) <= 160),
  add column if not exists website      text        not null default '' check (length(website) <= 300),
  add column if not exists instagram    text        not null default '' check (length(instagram) <= 80),
  add column if not exists logo_url     text        not null default '',
  add column if not exists submitted_at timestamptz,
  add column if not exists reviewed_at  timestamptz,
  add column if not exists reviewed_by  text,
  add column if not exists review_note  text        not null default '',
  add column if not exists updated_at   timestamptz not null default now();

-- One vendor profile per account.
create unique index if not exists vendors_owner_unique on public.vendors (owner_id) where owner_id is not null;

-- ============================================================ products (extend)

alter table public.vendor_packages
  add column if not exists image_url     text        not null default '',
  add column if not exists review_status text        not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected')),
  add column if not exists review_note   text        not null default '',
  add column if not exists reviewed_at   timestamptz,
  add column if not exists updated_at    timestamptz not null default now();

create index if not exists vendor_packages_review_idx on public.vendor_packages (review_status);

-- ============================================================ venue locations

create table if not exists public.vendor_locations (
  id            uuid        primary key default gen_random_uuid(),
  vendor_id     uuid        not null references public.vendors (id) on delete cascade,
  name          text        not null check (length(name) between 1 and 160),
  description   text        not null default '' check (length(description) <= 2000),
  address       text        not null default '' check (length(address) <= 300),
  city          text        not null default '' check (length(city) <= 80),
  region        text        not null default '' check (length(region) <= 80),
  capacity_min  integer     check (capacity_min >= 0),
  capacity_max  integer     check (capacity_max >= 0),
  image_url     text        not null default '',
  active        boolean     not null default true,
  review_status text        not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected')),
  review_note   text        not null default '',
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (capacity_max is null or capacity_min is null or capacity_max >= capacity_min)
);

create index if not exists vendor_locations_vendor_idx on public.vendor_locations (vendor_id);
create index if not exists vendor_locations_review_idx on public.vendor_locations (review_status);
alter table public.vendor_locations enable row level security;

-- ============================================================ promotions

-- A vendor asks to feature one product or location for N days; an admin
-- approves (which starts the window) or rejects. Featured while
-- status = 'approved' and now() is between starts_at and ends_at.
create table if not exists public.vendor_promotions (
  id           uuid        primary key default gen_random_uuid(),
  vendor_id    uuid        not null references public.vendors (id) on delete cascade,
  package_id   uuid        references public.vendor_packages (id) on delete cascade,
  location_id  uuid        references public.vendor_locations (id) on delete cascade,
  days         integer     not null check (days between 1 and 90),
  message      text        not null default '' check (length(message) <= 500),
  status       text        not null default 'requested'
    check (status in ('requested', 'approved', 'rejected', 'cancelled')),
  starts_at    timestamptz,
  ends_at      timestamptz,
  review_note  text        not null default '',
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now(),
  check ((package_id is null) <> (location_id is null))
);

create index if not exists vendor_promotions_vendor_idx on public.vendor_promotions (vendor_id, created_at desc);
create index if not exists vendor_promotions_status_idx on public.vendor_promotions (status, ends_at);
alter table public.vendor_promotions enable row level security;

-- ============================================================ host selections

-- A host picking a venue location or a product for one of their events.
-- This is what "how many users selected it" counts.
create table if not exists public.vendor_selections (
  id           uuid        primary key default gen_random_uuid(),
  event_id     text        not null references public.events (id) on delete cascade,
  owner_id     text        not null,
  vendor_id    uuid        not null references public.vendors (id) on delete cascade,
  package_id   uuid        references public.vendor_packages (id) on delete cascade,
  location_id  uuid        references public.vendor_locations (id) on delete cascade,
  created_at   timestamptz not null default now(),
  check ((package_id is null) <> (location_id is null))
);

create unique index if not exists vendor_selections_package_unique
  on public.vendor_selections (event_id, package_id) where package_id is not null;
create unique index if not exists vendor_selections_location_unique
  on public.vendor_selections (event_id, location_id) where location_id is not null;
create index if not exists vendor_selections_vendor_idx on public.vendor_selections (vendor_id);
alter table public.vendor_selections enable row level security;

-- ============================================================ listing views

-- One row per signed-in viewer, listing and day: "views" means unique daily
-- views, so refreshing a page doesn't inflate a vendor's numbers.
create table if not exists public.vendor_listing_views (
  id           uuid        primary key default gen_random_uuid(),
  vendor_id    uuid        not null references public.vendors (id) on delete cascade,
  package_id   uuid        references public.vendor_packages (id) on delete cascade,
  location_id  uuid        references public.vendor_locations (id) on delete cascade,
  viewer_id    text        not null,
  viewed_on    date        not null default current_date,
  created_at   timestamptz not null default now(),
  check ((package_id is null) <> (location_id is null))
);

create unique index if not exists vendor_listing_views_package_unique
  on public.vendor_listing_views (viewer_id, package_id, viewed_on) where package_id is not null;
create unique index if not exists vendor_listing_views_location_unique
  on public.vendor_listing_views (viewer_id, location_id, viewed_on) where location_id is not null;
create index if not exists vendor_listing_views_vendor_idx on public.vendor_listing_views (vendor_id);
alter table public.vendor_listing_views enable row level security;
