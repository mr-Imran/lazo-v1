-- Paid tiers (Stripe), guest messaging (Resend email, Twilio SMS), the photo
-- gallery, seating, and concierge requests (print, travel, custom domain).

-- ============================================================ tiers and prices

-- Prices are services rows, so the admin dashboard can change them. Amounts
-- are the low end of the business plan's indicative ranges (section 8.4).
insert into public.services (key, name, price_centavos, currency) values
  ('tier_premium',   'Premium plan',   249900, 'MXN'),
  ('tier_signature', 'Signature plan', 899900, 'MXN')
on conflict (key) do nothing;

-- events.tier: null = free. The check already allows essential/premium/signature.
alter table public.events
  add column if not exists custom_domain        text check (length(custom_domain) <= 253),
  add column if not exists custom_domain_status text not null default 'none'
    check (custom_domain_status in ('none','requested','active'));

-- Stripe Checkout sessions map to payment_attempts (flow 'event_fee') by
-- provider_reference; the webhook flips them to succeeded and sets the tier.
alter table public.payment_attempts
  add column if not exists owner_id  text,
  add column if not exists product   text not null default '',   -- services.key
  add column if not exists checkout_url text not null default '';
create index if not exists payment_attempts_owner_idx on public.payment_attempts (owner_id, created_at desc);

-- ============================================================ messaging

-- What the host wrote, so a delivery row can point at its campaign.
create table if not exists public.messages (
  id           uuid        primary key default gen_random_uuid(),
  event_id     text        not null references public.events(id) on delete cascade,
  channel      text        not null check (channel in ('email','sms')),
  audience     text        not null default 'all'
    check (audience in ('all','awaiting','attending','declined')),
  subject      text        not null default '' check (length(subject) <= 200),
  body         text        not null check (length(body) between 1 and 4000),
  recipients   integer     not null default 0,
  sent         integer     not null default 0,
  failed       integer     not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists messages_event_idx on public.messages (event_id, created_at desc);
alter table public.messages enable row level security;

alter table public.message_deliveries
  add column if not exists message_id   uuid references public.messages(id) on delete cascade,
  add column if not exists household_id uuid references public.households(id) on delete set null;
create index if not exists message_deliveries_message_idx on public.message_deliveries (message_id);

-- ============================================================ photos (extend)

alter table public.photos
  add column if not exists public_url  text not null default '',
  add column if not exists caption     text not null default '' check (length(caption) <= 200),
  add column if not exists uploader    text not null default '' check (length(uploader) <= 120),
  add column if not exists source      text not null default 'guest' check (source in ('host','guest')),
  add column if not exists width       integer,
  add column if not exists height      integer;

-- Gallery settings on the event.
alter table public.events
  add column if not exists gallery_open boolean not null default true;

-- ============================================================ seating (extend)

alter table public.seating_tables
  add column if not exists shape text not null default 'round' check (shape in ('round','long','square')),
  add column if not exists notes text not null default '' check (length(notes) <= 300);

-- ============================================================ concierge requests

-- Print orders and travel help, handled by Lazo (Signature plan). An admin
-- moves them through status and can note a price; payment for print runs is
-- settled separately for now.
create table if not exists public.concierge_requests (
  id           uuid        primary key default gen_random_uuid(),
  event_id     text        not null references public.events(id) on delete cascade,
  owner_id     text        not null,
  kind         text        not null check (kind in ('print','travel','custom_domain')),
  product      text        not null default '' check (length(product) <= 60),
  quantity     integer     check (quantity between 1 and 10000),
  details      text        not null default '' check (length(details) <= 3000),
  address      text        not null default '' check (length(address) <= 400),
  status       text        not null default 'requested'
    check (status in ('requested','in_progress','quoted','done','cancelled')),
  admin_note   text        not null default '' check (length(admin_note) <= 2000),
  quote_cents  bigint      check (quote_cents >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists concierge_event_idx on public.concierge_requests (event_id, created_at desc);
create index if not exists concierge_status_idx on public.concierge_requests (status, created_at desc);
alter table public.concierge_requests enable row level security;

-- Travel information the host shows guests (site_content.travel is validated
-- by the API; this comment documents the shape):
--   { airport, transport, parking, note }
