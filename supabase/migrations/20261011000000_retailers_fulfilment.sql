-- Retailer API integrations (PRD §6.1 / MODE-2) and print / flowers / travel
-- fulfilment partners (PRD §6.3). Idempotent.
--
-- Retailers are CONFIGURATION rows: which adapter, which env vars hold the
-- credentials (never the values), what the adapter can do. Partners are NOT
-- seeded: real partners are contracted and added by an admin.

-- ---------------------------------------------------------------- retailers

create table if not exists public.retailers (
  key             text        primary key check (key ~ '^[a-z0-9_]{2,40}$'),
  name            text        not null check (length(name) between 1 and 80),
  adapter         text        not null check (adapter in ('amazon_paapi','mercadolibre')),
  country         text        not null default 'MX' check (length(country) = 2),
  enabled         boolean     not null default true,
  -- Names of the env vars the adapter reads. Values live only in the server env.
  credential_env  jsonb       not null default '[]'::jsonb,
  -- Affiliate tag appended to product links. Amazon's comes from
  -- AMAZON_PAAPI_PARTNER_TAG (the API needs it to sign requests); Mercado
  -- Libre's affiliate "matt_tool" id is set here by the admin once approved.
  affiliate_tag   text        not null default '',
  -- What the adapter offers: { catalog, availability, purchase_redirect, reservation }
  supports        jsonb       not null default '{}'::jsonb,
  synced_at       timestamptz,
  created_at      timestamptz not null default now()
);
alter table public.retailers enable row level security;

insert into public.retailers (key, name, adapter, country, credential_env, supports) values
  ('amazon_mx', 'Amazon México', 'amazon_paapi', 'MX',
   '["AMAZON_PAAPI_ACCESS_KEY","AMAZON_PAAPI_SECRET_KEY","AMAZON_PAAPI_PARTNER_TAG"]'::jsonb,
   '{"catalog":true,"availability":true,"purchase_redirect":true,"reservation":false}'::jsonb),
  ('mercadolibre', 'Mercado Libre México', 'mercadolibre', 'MX',
   '["MELI_APP_ID","MELI_CLIENT_SECRET"]'::jsonb,
   '{"catalog":true,"availability":true,"purchase_redirect":true,"reservation":false}'::jsonb)
on conflict (key) do nothing;

-- Registry items backed by a retailer: which store, its id there, and the last
-- price / stock check (INT-3: recheck before showing as buyable).
alter table public.registry_items
  add column if not exists retailer_key     text references public.retailers(key) on delete set null,
  add column if not exists available        boolean,
  add column if not exists price_checked_at timestamptz;
create index if not exists registry_items_retailer_idx on public.registry_items (retailer_key) where retailer_key is not null;

-- A guest following a store link (REG-3: a click is not a purchase). The
-- referrer is hashed; no guest identity is kept.
create table if not exists public.registry_clicks (
  id              uuid        primary key default gen_random_uuid(),
  event_id        text        not null references public.events(id) on delete cascade,
  registry_item_id uuid       not null references public.registry_items(id) on delete cascade,
  referrer_hash   text        not null default '',
  created_at      timestamptz not null default now()
);
create index if not exists registry_clicks_item_idx on public.registry_clicks (registry_item_id, created_at desc);
alter table public.registry_clicks enable row level security;

-- ------------------------------------------------------ fulfilment partners

create table if not exists public.fulfilment_partners (
  id              uuid        primary key default gen_random_uuid(),
  category        text        not null check (category in ('print','flowers','travel')),
  name            text        not null check (length(name) between 1 and 120),
  contact_email   text        not null default '' check (length(contact_email) <= 200),
  phone           text        not null default '' check (length(phone) <= 40),
  -- Cities / states the partner delivers to, e.g. ["CDMX","Guadalajara","JAL"].
  coverage        jsonb       not null default '[]'::jsonb,
  -- [{ key, name, priceCentavos, unit, leadDays }]
  products        jsonb       not null default '[]'::jsonb,
  notify_via      text        not null default 'email' check (notify_via in ('email','webhook')),
  webhook_url     text        not null default '' check (length(webhook_url) <= 500),
  -- Signs our webhook POSTs and the partner's status updates (HMAC-SHA256).
  webhook_secret  text        not null default '',
  -- Published terms (FUL-1): cutoff, fees, cancellation.
  terms           text        not null default '' check (length(terms) <= 3000),
  active          boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists fulfilment_partners_cat_idx on public.fulfilment_partners (category, active);
alter table public.fulfilment_partners enable row level security;

create table if not exists public.fulfilment_orders (
  id                uuid        primary key default gen_random_uuid(),
  partner_id        uuid        not null references public.fulfilment_partners(id) on delete restrict,
  event_id          text        not null references public.events(id) on delete cascade,
  owner_id          text        not null,
  category          text        not null check (category in ('print','flowers','travel')),
  product_key       text        not null check (length(product_key) <= 60),
  product_name      text        not null default '',
  quantity          integer     not null check (quantity between 1 and 10000),
  delivery_address  text        not null default '' check (length(delivery_address) <= 400),
  city              text        not null check (length(city) between 1 and 80),
  needed_by         date,
  notes             text        not null default '' check (length(notes) <= 3000),
  amount_centavos   bigint      not null check (amount_centavos >= 0),
  currency          text        not null default 'MXN',
  status            text        not null default 'submitted'
    check (status in ('submitted','confirmed','in_production','shipped','delivered','cancelled','rejected')),
  payment_status    text        not null default 'unpaid' check (payment_status in ('unpaid','paid','refunded')),
  partner_reference text        not null default '' check (length(partner_reference) <= 120),
  -- [{ status, at, by: 'host'|'partner'|'admin', note }]
  timeline          jsonb       not null default '[]'::jsonb,
  -- { via, ok, reference | error, at } — what happened when we told the partner.
  notification      jsonb,
  cancellation_reason text      not null default '' check (length(cancellation_reason) <= 600),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists fulfilment_orders_event_idx on public.fulfilment_orders (event_id, created_at desc);
create index if not exists fulfilment_orders_status_idx on public.fulfilment_orders (status, created_at desc);
alter table public.fulfilment_orders enable row level security;

-- Manual concierge requests gain "flowers" so the fallback covers every
-- fulfilment category.
alter table public.concierge_requests drop constraint if exists concierge_requests_kind_check;
alter table public.concierge_requests
  add constraint concierge_requests_kind_check check (kind in ('print','flowers','travel','custom_domain'));
