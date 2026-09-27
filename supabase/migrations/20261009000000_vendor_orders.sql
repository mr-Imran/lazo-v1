-- Vendor payments (business plan §2.1): a vendor answers an inquiry with a
-- formal quote, the host accepts and pays through Stripe Checkout, and the
-- money goes to the vendor's Stripe Connect Express account as a destination
-- charge with Lazo's commission kept as the application fee. Refunds,
-- disputes and the vendor's onboarding state are recorded here too.
--
-- Money is integer centavos. Builds on public.vendors (V1 backbone +
-- vendor_marketplace) and public.quotes (the host→vendor inquiries from
-- 20261002000000_planning.sql).

-- ============================================================ vendors: settlement

alter table public.vendors
  add column if not exists stripe_account_id        text,
  add column if not exists stripe_onboarding_status text        not null default 'pending'
    check (stripe_onboarding_status in ('pending', 'complete', 'restricted')),
  add column if not exists payouts_enabled          boolean     not null default false,
  add column if not exists charges_enabled          boolean     not null default false,
  add column if not exists stripe_synced_at         timestamptz;

create unique index if not exists vendors_stripe_account_unique
  on public.vendors (stripe_account_id) where stripe_account_id is not null;

-- ============================================================ quotes

-- A vendor's priced offer to one event. Starts from an inquiry (quotes row)
-- or from a listing the host picked (vendor_selections); either way the
-- host who owns the event is the only one who can accept it.
create table if not exists public.vendor_quotes (
  id                uuid        primary key default gen_random_uuid(),
  inquiry_id        uuid        references public.quotes (id) on delete set null,
  listing_type      text        check (listing_type in ('location', 'product')),
  listing_id        uuid,
  vendor_id         uuid        not null references public.vendors (id) on delete cascade,
  event_id          text        not null references public.events (id) on delete cascade,
  owner_id          text        not null,
  title             text        not null check (length(title) between 1 and 160),
  -- [{ description, quantity, unit_centavos }] — informational; amount_centavos is what is charged.
  line_items        jsonb       not null default '[]'::jsonb,
  amount_centavos   bigint      not null check (amount_centavos > 0),
  currency          text        not null default 'MXN',
  -- When set, Checkout charges only the deposit; the rest is settled between host and vendor.
  deposit_centavos  bigint      check (deposit_centavos > 0 and deposit_centavos <= amount_centavos),
  valid_until       timestamptz,
  status            text        not null default 'draft'
    check (status in ('draft', 'sent', 'accepted', 'declined', 'expired', 'withdrawn')),
  note              text        not null default '' check (length(note) <= 2000),
  sent_at           timestamptz,
  accepted_at       timestamptz,
  declined_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists vendor_quotes_vendor_idx on public.vendor_quotes (vendor_id, created_at desc);
create index if not exists vendor_quotes_event_idx  on public.vendor_quotes (event_id, status);
alter table public.vendor_quotes enable row level security;

-- ============================================================ orders

-- One per accepted quote. amount_centavos is what Checkout charges (the
-- deposit when the quote has one, the full amount otherwise);
-- platform_fee_centavos is Lazo's commission, taken as the Stripe
-- application fee on that charge.
create table if not exists public.vendor_orders (
  id                      uuid        primary key default gen_random_uuid(),
  quote_id                uuid        not null unique references public.vendor_quotes (id) on delete restrict,
  event_id                text        not null references public.events (id) on delete cascade,
  vendor_id               uuid        not null references public.vendors (id) on delete restrict,
  owner_id                text        not null,
  amount_centavos         bigint      not null check (amount_centavos > 0),
  quote_amount_centavos   bigint      not null check (quote_amount_centavos >= amount_centavos),
  platform_fee_centavos   bigint      not null default 0 check (platform_fee_centavos >= 0 and platform_fee_centavos <= amount_centavos),
  currency                text        not null default 'MXN',
  status                  text        not null default 'pending_payment'
    check (status in ('pending_payment', 'paid', 'in_progress', 'fulfilled', 'cancelled', 'refunded', 'disputed')),
  -- Where the order was before a dispute opened, so a won dispute can restore it.
  pre_dispute_status      text,
  stripe_checkout_session text,
  stripe_payment_intent   text,
  stripe_charge           text,
  stripe_transfer         text,
  payment_method          text        not null default '',
  receipt_url             text        not null default '',
  refunded_centavos       bigint      not null default 0 check (refunded_centavos >= 0),
  paid_at                 timestamptz,
  fulfilled_at            timestamptz,
  cancelled_at            timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists vendor_orders_vendor_idx on public.vendor_orders (vendor_id, created_at desc);
create index if not exists vendor_orders_event_idx  on public.vendor_orders (event_id, created_at desc);
create index if not exists vendor_orders_status_idx on public.vendor_orders (status, created_at desc);
create unique index if not exists vendor_orders_session_unique
  on public.vendor_orders (stripe_checkout_session) where stripe_checkout_session is not null;
create unique index if not exists vendor_orders_intent_unique
  on public.vendor_orders (stripe_payment_intent) where stripe_payment_intent is not null;
alter table public.vendor_orders enable row level security;

-- ============================================================ refunds

create table if not exists public.vendor_refunds (
  id                uuid        primary key default gen_random_uuid(),
  order_id          uuid        not null references public.vendor_orders (id) on delete cascade,
  amount_centavos   bigint      not null check (amount_centavos > 0),
  reason            text        not null default '' check (length(reason) <= 1000),
  requested_by      text        not null default 'vendor' check (requested_by in ('vendor', 'admin', 'stripe')),
  stripe_refund_id  text        unique,
  status            text        not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed', 'cancelled')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists vendor_refunds_order_idx on public.vendor_refunds (order_id, created_at desc);
alter table public.vendor_refunds enable row level security;

-- ============================================================ disputes

create table if not exists public.vendor_disputes (
  id                 uuid        primary key default gen_random_uuid(),
  order_id           uuid        not null references public.vendor_orders (id) on delete cascade,
  stripe_dispute_id  text        not null unique,
  amount_centavos    bigint      not null check (amount_centavos >= 0),
  currency           text        not null default 'MXN',
  reason             text        not null default '',
  -- Stripe's dispute status as-is (warning_needs_response, needs_response, under_review, won, lost, …).
  status             text        not null default '',
  evidence_due_by    timestamptz,
  -- '' while open, then won | lost (mirrors status once closed).
  outcome            text        not null default '',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists vendor_disputes_order_idx on public.vendor_disputes (order_id);
alter table public.vendor_disputes enable row level security;

-- ============================================================ webhook idempotency

-- Every Stripe event id the Connect webhook has processed. A redelivery is a no-op.
create table if not exists public.vendor_stripe_events (
  id           text        primary key,
  type         text        not null,
  received_at  timestamptz not null default now()
);
alter table public.vendor_stripe_events enable row level security;

-- ============================================================ commission

-- Lazo's cut of every vendor order, as a services row so admins edit it in
-- the dashboard. price_centavos holds the percentage × 100: 1000 = 10.00 %.
insert into public.services (key, name, price_centavos, currency) values
  ('vendor_commission_pct', 'Vendor commission (% × 100; 1000 = 10%)', 1000, 'MXN')
on conflict (key) do nothing;
