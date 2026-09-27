-- LAZO V1 backbone — the core records from PRD v1.2 section 9.
--
-- Conventions used throughout, from the PRD:
--   * Money is integer centavos plus an explicit currency (PAY-6). Never float.
--   * Lifecycle states are check constraints matching Appendix B exactly, so an
--     impossible state cannot be written even by a direct SQL client.
--   * Tenancy is an owner_id (a Clerk user id) or a path to one through
--     event_id / vendor_id. NFR-2 wants isolation enforced server-side; the API
--     layer derives its scope filter from these columns.
--   * RLS is enabled with no policies everywhere: the server holds the Supabase
--     secret key and bypasses it, so anon and publishable keys read nothing.
--
-- public.events already exists and is extended below rather than replaced, so
-- the ids already issued to hosts keep working.

-- ============================================================ events (extend)

alter table public.events
  add column if not exists slug          text unique,
  add column if not exists mode          text not null default 'boda'
    check (mode in ('boda','xv','bautizo','graduacion','corporate','memorial')),
  add column if not exists state         text not null default 'draft'
    check (state in ('anonymous_draft','draft','unpaid','live','past','suspended')),
  add column if not exists visibility    text not null default 'private'
    check (visibility in ('private','unlisted','public')),
  add column if not exists timezone      text not null default 'America/Mexico_City',
  add column if not exists palette       text not null default 'classic',
  add column if not exists locale        text not null default 'es-MX',
  add column if not exists currency      text not null default 'MXN',
  add column if not exists tier          text check (tier in ('essential','premium','signature')),
  add column if not exists claimed_at    timestamptz,
  add column if not exists paid_at       timestamptz,
  add column if not exists published_at  timestamptz,
  add column if not exists updated_at    timestamptz not null default now();

create index if not exists events_state_idx on public.events (state);
create index if not exists events_mode_idx  on public.events (mode);

-- ============================================================ event structure

create table if not exists public.sub_events (
  id           uuid        primary key default gen_random_uuid(),
  event_id     text        not null references public.events(id) on delete cascade,
  name         text        not null check (length(name) between 1 and 120),
  kind         text        not null default 'other'
    check (kind in ('ceremonia_civil','misa','recepcion','tornaboda','brindis','agenda','servicio','other')),
  starts_at    timestamptz,
  ends_at      timestamptz,
  venue_name   text        not null default '',
  address      text        not null default '',
  dress_code   text        not null default '',
  position     integer     not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists sub_events_event_idx on public.sub_events (event_id, position);

-- ============================================================ guests and RSVP

create table if not exists public.households (
  id           uuid        primary key default gen_random_uuid(),
  event_id     text        not null references public.events(id) on delete cascade,
  name         text        not null check (length(name) between 1 and 160),
  -- Event-scoped lookup code. RSVP-1: never exposes the full guest list.
  invite_code  text        not null,
  email        text        not null default '',
  phone        text        not null default '',
  address      text        not null default '',
  address_status text      not null default 'missing'
    check (address_status in ('missing','requested','collected')),
  plus_one_limit integer   not null default 0 check (plus_one_limit between 0 and 20),
  tags         text[]      not null default '{}',
  created_at   timestamptz not null default now(),
  unique (event_id, invite_code)
);

create index if not exists households_event_idx on public.households (event_id);

create table if not exists public.guests (
  id           uuid        primary key default gen_random_uuid(),
  event_id     text        not null references public.events(id) on delete cascade,
  household_id uuid        not null references public.households(id) on delete cascade,
  full_name    text        not null check (length(full_name) between 1 and 160),
  is_child     boolean     not null default false,
  is_plus_one  boolean     not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists guests_event_idx on public.guests (event_id);
create index if not exists guests_household_idx on public.guests (household_id);

create table if not exists public.rsvps (
  id           uuid        primary key default gen_random_uuid(),
  event_id     text        not null references public.events(id) on delete cascade,
  sub_event_id uuid        not null references public.sub_events(id) on delete cascade,
  guest_id     uuid        not null references public.guests(id) on delete cascade,
  status       text        not null default 'pending'
    check (status in ('pending','attending','declined','tentative')),
  menu_choice  text        not null default '',
  allergies    text        not null default '',
  song_request text        not null default '',
  message      text        not null default '',
  responded_at timestamptz,
  created_at   timestamptz not null default now(),
  -- RSVP-1: one answer per guest per sub-event.
  unique (guest_id, sub_event_id)
);

create index if not exists rsvps_event_idx on public.rsvps (event_id, status);

-- ============================================================ seating

create table if not exists public.seating_tables (
  id           uuid        primary key default gen_random_uuid(),
  event_id     text        not null references public.events(id) on delete cascade,
  sub_event_id uuid        not null references public.sub_events(id) on delete cascade,
  name         text        not null check (length(name) between 1 and 80),
  capacity     integer     not null check (capacity between 1 and 100),
  position     integer     not null default 0,
  created_at   timestamptz not null default now(),
  unique (sub_event_id, name)
);

create table if not exists public.seat_assignments (
  id             uuid        primary key default gen_random_uuid(),
  event_id       text        not null references public.events(id) on delete cascade,
  sub_event_id   uuid        not null references public.sub_events(id) on delete cascade,
  seating_table_id uuid      not null references public.seating_tables(id) on delete cascade,
  guest_id       uuid        not null references public.guests(id) on delete cascade,
  -- SEAT-1: an RSVP change flags the seat instead of silently dropping it.
  needs_review   boolean     not null default false,
  created_at     timestamptz not null default now(),
  -- SEAT-1: no duplicate assignment within one sub-event.
  unique (sub_event_id, guest_id)
);

create index if not exists seat_assignments_table_idx on public.seat_assignments (seating_table_id);

-- ============================================================ photos

create table if not exists public.photos (
  id            uuid        primary key default gen_random_uuid(),
  event_id      text        not null references public.events(id) on delete cascade,
  household_id  uuid        references public.households(id) on delete set null,
  storage_path  text        not null,
  content_type  text        not null,
  bytes         bigint      not null check (bytes > 0),
  -- PHOTO-2: nothing is visible until a host approves it.
  status        text        not null default 'pending'
    check (status in ('pending','approved','rejected','deleted')),
  moderated_by  text,
  moderated_at  timestamptz,
  -- PHOTO-1: proof that location metadata was stripped before storage.
  exif_stripped boolean     not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists photos_event_status_idx on public.photos (event_id, status);

-- ============================================================ registry and gifts

create table if not exists public.registry_items (
  id            uuid        primary key default gen_random_uuid(),
  event_id      text        not null references public.events(id) on delete cascade,
  kind          text        not null
    check (kind in ('retailer_link','retailer_api','cash_fund','group_gift','vendor_item')),
  title         text        not null check (length(title) between 1 and 200),
  description   text        not null default '',
  image_url     text        not null default '',
  external_url  text        not null default '',
  -- Set only for retailer_api / vendor_item.
  integration_id uuid,
  external_id   text,
  price_cents   bigint      check (price_cents >= 0),
  goal_cents    bigint      check (goal_cents >= 0),
  funded_cents  bigint      not null default 0 check (funded_cents >= 0),
  currency      text        not null default 'MXN',
  -- REG-3: an external link click is not a purchase.
  status        text        not null default 'available'
    check (status in ('available','reserved','pending','paid','purchased','cancelled','refunded')),
  position      integer     not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists registry_items_event_idx on public.registry_items (event_id, position);

create table if not exists public.gifts (
  id                uuid        primary key default gen_random_uuid(),
  event_id          text        not null references public.events(id) on delete cascade,
  registry_item_id  uuid        references public.registry_items(id) on delete set null,
  guest_name        text        not null default '',
  guest_email       text        not null default '',
  message           text        not null default '',
  amount_cents      bigint      not null check (amount_cents > 0),
  -- PAY-2: guest money is tracked apart from LAZO revenue.
  platform_fee_cents bigint     not null default 0 check (platform_fee_cents >= 0),
  provider_fee_cents bigint     not null default 0 check (provider_fee_cents >= 0),
  host_proceeds_cents bigint    not null default 0 check (host_proceeds_cents >= 0),
  currency          text        not null default 'MXN',
  status            text        not null default 'pending'
    check (status in ('pending','paid','failed','refunded','disputed')),
  thanked_at        timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists gifts_event_idx on public.gifts (event_id, status);

-- ============================================================ vendors

create table if not exists public.vendors (
  id             uuid        primary key default gen_random_uuid(),
  owner_id       text,
  business_name  text        not null check (length(business_name) between 1 and 160),
  department     text        not null
    check (department in ('venues','planning','catering','snacks','beverages','desserts',
                          'live_music','dj','shows','print','flowers','travel','retail','apparel','other')),
  city           text        not null default '' ,
  service_area   text[]      not null default '{}',
  -- VEN-1: unknown availability must never be shown as available.
  status         text        not null default 'candidate'
    check (status in ('candidate','onboarding','pending_approval','active','paused','rejected')),
  purchase_mode  text        not null default 'quote'
    check (purchase_mode in ('quote','catalog','fitting','fixed_package')),
  payment_ready  boolean     not null default false,
  verified_at    timestamptz,
  -- NOAPI-3: who confirmed the data, and how.
  intake_source  text        not null default 'staff'
    check (intake_source in ('staff','whatsapp','email','phone','portal','agent')),
  approved_by_vendor_at timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists vendors_department_idx on public.vendors (department, status);

create table if not exists public.vendor_packages (
  id           uuid        primary key default gen_random_uuid(),
  vendor_id    uuid        not null references public.vendors(id) on delete cascade,
  name         text        not null check (length(name) between 1 and 160),
  description  text        not null default '',
  price_cents  bigint      check (price_cents >= 0),
  currency     text        not null default 'MXN',
  capacity_min integer,
  capacity_max integer,
  -- INT-1: an adapter declares what it actually supports.
  availability text        not null default 'unknown'
    check (availability in ('unknown','on_request','confirmed','unavailable')),
  external_id  text,
  active       boolean     not null default true,
  created_at   timestamptz not null default now()
);

create index if not exists vendor_packages_vendor_idx on public.vendor_packages (vendor_id, active);

create table if not exists public.integrations (
  id             uuid        primary key default gen_random_uuid(),
  vendor_id      uuid        references public.vendors(id) on delete cascade,
  kind           text        not null
    check (kind in ('vendor_api','retailer_api','print','flowers','travel','whatsapp','gateway','invoicing')),
  provider       text        not null,
  environment    text        not null default 'sandbox'
    check (environment in ('sandbox','production')),
  -- INT-1: capabilities are declared, not assumed.
  capabilities   jsonb       not null default '{}'::jsonb,
  status         text        not null default 'configured'
    check (status in ('configured','testing','live','failing','disabled')),
  last_synced_at timestamptz,
  last_error     text        not null default '',
  created_at     timestamptz not null default now()
);

-- ============================================================ orders

create table if not exists public.quotes (
  id           uuid        primary key default gen_random_uuid(),
  event_id     text        not null references public.events(id) on delete cascade,
  vendor_id    uuid        not null references public.vendors(id) on delete cascade,
  -- MODE-1: quotes are versioned and holds expire explicitly.
  version      integer     not null default 1 check (version > 0),
  status       text        not null default 'requested'
    check (status in ('requested','sent','accepted','rejected','expired','superseded')),
  total_cents  bigint      check (total_cents >= 0),
  currency     text        not null default 'MXN',
  guest_count  integer,
  event_date   date,
  hold_expires_at timestamptz,
  accepted_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists quotes_event_idx on public.quotes (event_id, status);

create table if not exists public.orders (
  id             uuid        primary key default gen_random_uuid(),
  event_id       text        references public.events(id) on delete set null,
  vendor_id      uuid        references public.vendors(id) on delete set null,
  quote_id       uuid        references public.quotes(id) on delete set null,
  owner_id       text        not null,
  -- Appendix B: the three entry paths converge on one state machine.
  purchase_mode  text        not null
    check (purchase_mode in ('venue_quote','retail_catalog','fitting','fixed_package','fulfilment')),
  status         text        not null default 'draft'
    check (status in ('draft','awaiting_customer_approval','payment_pending','paid',
                      'confirmed','in_fulfilment','fulfilled','cancelled','failed','refunded')),
  -- MODE-5: opaque reference for the purchase case; a scan never authorizes payment.
  case_reference text        unique,
  subtotal_cents bigint      not null default 0 check (subtotal_cents >= 0),
  -- PAY-3: every component is recorded separately.
  platform_fee_cents bigint  not null default 0 check (platform_fee_cents >= 0),
  provider_fee_cents bigint  not null default 0 check (provider_fee_cents >= 0),
  vendor_proceeds_cents bigint not null default 0 check (vendor_proceeds_cents >= 0),
  total_cents    bigint      not null default 0 check (total_cents >= 0),
  currency       text        not null default 'MXN',
  promised_date  date,
  terms          text        not null default '',
  customer_approved_at timestamptz,
  vendor_confirmed_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists orders_event_idx on public.orders (event_id, status);
create index if not exists orders_owner_idx on public.orders (owner_id, created_at desc);
create index if not exists orders_vendor_idx on public.orders (vendor_id, status);

create table if not exists public.order_items (
  id            uuid        primary key default gen_random_uuid(),
  order_id      uuid        not null references public.orders(id) on delete cascade,
  registry_item_id uuid     references public.registry_items(id) on delete set null,
  vendor_package_id uuid    references public.vendor_packages(id) on delete set null,
  description   text        not null check (length(description) between 1 and 300),
  -- MODE-4: group outfits sit in one case with items assigned per person.
  assigned_to   text        not null default '',
  customization text        not null default '',
  quantity      integer     not null default 1 check (quantity > 0),
  unit_cents    bigint      not null default 0 check (unit_cents >= 0),
  currency      text        not null default 'MXN',
  external_id   text,
  created_at    timestamptz not null default now()
);

create index if not exists order_items_order_idx on public.order_items (order_id);

create table if not exists public.fulfilments (
  id            uuid        primary key default gen_random_uuid(),
  order_id      uuid        not null references public.orders(id) on delete cascade,
  category      text        not null
    check (category in ('vendor','print','flowers','travel','retail')),
  integration_id uuid       references public.integrations(id) on delete set null,
  status        text        not null default 'pending'
    check (status in ('pending','accepted','in_progress','shipped','delivered','cancelled','failed')),
  external_reference text   not null default '',
  promised_window text      not null default '',
  notes         text        not null default '',
  -- FUL-4: exceptions have a visible owner.
  escalation_owner text     not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists fulfilments_order_idx on public.fulfilments (order_id, status);

-- ============================================================ money

create table if not exists public.payment_attempts (
  id              uuid        primary key default gen_random_uuid(),
  -- PAY-1/2/3: which of the three money flows this belongs to.
  flow            text        not null
    check (flow in ('event_fee','gift','vendor_order')),
  event_id        text        references public.events(id) on delete set null,
  order_id        uuid        references public.orders(id) on delete set null,
  gift_id         uuid        references public.gifts(id) on delete set null,
  gateway         text        not null,
  method          text        not null default 'card' check (method in ('card','oxxo','spei','other')),
  -- Appendix B payment states.
  status          text        not null default 'created'
    check (status in ('created','pending','succeeded','failed','expired',
                      'partially_refunded','refunded','disputed')),
  amount_cents    bigint      not null check (amount_cents > 0),
  currency        text        not null default 'MXN',
  -- PAY-5/6: idempotency and duplicate/out-of-order callback tolerance.
  idempotency_key text        unique,
  provider_reference text     unique,
  failure_reason  text        not null default '',
  succeeded_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists payment_attempts_flow_idx on public.payment_attempts (flow, status);

create table if not exists public.refunds (
  id            uuid        primary key default gen_random_uuid(),
  payment_attempt_id uuid   not null references public.payment_attempts(id) on delete cascade,
  amount_cents  bigint      not null check (amount_cents > 0),
  currency      text        not null default 'MXN',
  status        text        not null default 'pending'
    check (status in ('pending','succeeded','failed')),
  reason        text        not null default '',
  -- AUTH-AI-2: a discretionary refund needs a named human.
  approved_by   text        not null default '',
  provider_reference text   unique,
  created_at    timestamptz not null default now()
);

create table if not exists public.payouts (
  id            uuid        primary key default gen_random_uuid(),
  -- PAY-3/MODE-6: payout is a separate state from payment success.
  recipient_kind text       not null check (recipient_kind in ('host','vendor')),
  recipient_id  text        not null,
  amount_cents  bigint      not null check (amount_cents > 0),
  currency      text        not null default 'MXN',
  status        text        not null default 'pending'
    check (status in ('pending','in_transit','paid','failed','reversed')),
  provider_reference text   unique,
  expected_at   timestamptz,
  settled_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists public.invoices (
  id            uuid        primary key default gen_random_uuid(),
  -- PAY-7: CFDI issuance has its own retryable state.
  payment_attempt_id uuid   references public.payment_attempts(id) on delete set null,
  event_id      text        references public.events(id) on delete set null,
  status        text        not null default 'pending'
    check (status in ('pending','issued','failed','cancelled','substituted')),
  provider      text        not null default '',
  provider_reference text   unique,
  uuid_fiscal   text,
  rfc           text        not null default '',
  total_cents   bigint      not null default 0 check (total_cents >= 0),
  currency      text        not null default 'MXN',
  last_error    text        not null default '',
  issued_at     timestamptz,
  created_at    timestamptz not null default now()
);

-- ============================================================ messaging

create table if not exists public.message_consents (
  id           uuid        primary key default gen_random_uuid(),
  event_id     text        references public.events(id) on delete cascade,
  channel      text        not null check (channel in ('whatsapp','email','sms')),
  recipient    text        not null,
  -- WA-1/WA-2: consent is recorded and opt-out is honoured.
  opted_in     boolean     not null default false,
  purpose      text        not null default 'transactional'
    check (purpose in ('transactional','marketing')),
  source       text        not null default '',
  opted_in_at  timestamptz,
  opted_out_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (channel, recipient, purpose, event_id)
);

create table if not exists public.message_deliveries (
  id           uuid        primary key default gen_random_uuid(),
  event_id     text        references public.events(id) on delete set null,
  channel      text        not null check (channel in ('whatsapp','email','sms')),
  recipient    text        not null,
  template     text        not null default '',
  status       text        not null default 'queued'
    check (status in ('queued','sent','delivered','read','failed','skipped')),
  -- WA-2: deduplicate sends.
  dedupe_key   text        unique,
  provider_reference text  unique,
  failure_reason text      not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists message_deliveries_status_idx on public.message_deliveries (status, created_at desc);

-- ============================================================ audit and agents

create table if not exists public.audit_events (
  id           uuid        primary key default gen_random_uuid(),
  -- NFR-2/ADM-1: sensitive administrative and payment changes are logged.
  actor_id     text        not null default '',
  actor_kind   text        not null default 'user'
    check (actor_kind in ('user','admin','agent','system','api_key')),
  action       text        not null,
  resource     text        not null,
  resource_id  text        not null default '',
  event_id     text        references public.events(id) on delete set null,
  before       jsonb,
  after        jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists audit_events_resource_idx on public.audit_events (resource, resource_id);
create index if not exists audit_events_created_idx  on public.audit_events (created_at desc);

create table if not exists public.agent_tasks (
  id            uuid        primary key default gen_random_uuid(),
  -- RUN-2: one row per agent task, with evidence and cost.
  role          text        not null
    check (role in ('vendor_ops','customer_order_ops','catalog_registry',
                    'payments_monitor','growth_content','engineering_quality')),
  role_version  text        not null default 'v1',
  trigger       text        not null default '',
  status        text        not null default 'queued'
    check (status in ('queued','running','waiting','escalated','done','failed','cancelled')),
  -- AUTH-AI-1: shadow mode first, then narrowly approved actions.
  execution_mode text       not null default 'draft'
    check (execution_mode in ('draft','shadow','live')),
  event_id      text        references public.events(id) on delete set null,
  vendor_id     uuid        references public.vendors(id) on delete set null,
  order_id      uuid        references public.orders(id) on delete set null,
  owner_id      text        not null default '',
  context       jsonb       not null default '{}'::jsonb,
  evidence      jsonb       not null default '{}'::jsonb,
  result        jsonb,
  -- RUN-5: cost is recorded per task, not estimated per persona.
  cost_centavos bigint      not null default 0 check (cost_centavos >= 0),
  model_steps   integer     not null default 0 check (model_steps >= 0),
  escalated_to  text        not null default '',
  escalation_due_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists agent_tasks_status_idx on public.agent_tasks (role, status, created_at desc);

-- ============================================================ lock it all down

do $$
declare t text;
begin
  foreach t in array array[
    'sub_events','households','guests','rsvps','seating_tables','seat_assignments',
    'photos','registry_items','gifts','vendors','vendor_packages','integrations',
    'quotes','orders','order_items','fulfilments','payment_attempts','refunds',
    'payouts','invoices','message_consents','message_deliveries','audit_events','agent_tasks'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
