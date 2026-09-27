-- Analytics warehouse (PRD §2.1, §8 DATA-1..3, GATE-5).
--
-- A separate analytical store, implemented as the dedicated Postgres schema
-- `analytics` inside the same Supabase project. It is designed to move to a
-- physically separate database later (a production option): nothing in it
-- references `public` with a foreign key, ids are copied as plain values, and
-- the only bridge is the `analytics.ingest(...)` function, which reads
-- `public` and upserts here. On a separate database the same function body
-- runs over postgres_fdw / a dblink copy of the source tables.
--
-- Access: the schema is NOT exposed through PostgREST (do not add it to the
-- API "Exposed schemas" list). supabase-js therefore never sees it; the backend
-- reads it over the direct `pg` connection `DATABASE_URL` (already a dependency
-- of scripts/migrate.mjs). Only the service role (and the owner) may use it.
--
-- Facts are recomputed per whole day for every day the ingest window touches,
-- so a run is restartable and idempotent (DATA-1: stable ids + dedup):
-- daily facts are deleted-then-inserted for those days, one-row-per-attempt
-- facts are upserted on their natural key.

create schema if not exists analytics;

-- ---------------------------------------------------------------------------
-- Dimensions
-- ---------------------------------------------------------------------------
create table if not exists analytics.dim_date (
  day         date primary key,
  year        integer not null,
  month       integer not null,
  month_start date    not null,
  week_start  date    not null,
  dow         integer not null,          -- 0 = Sunday … 6 = Saturday
  is_weekend  boolean not null
);

insert into analytics.dim_date (day, year, month, month_start, week_start, dow, is_weekend)
select d::date,
       extract(year from d)::int,
       extract(month from d)::int,
       date_trunc('month', d)::date,
       date_trunc('week', d)::date,
       extract(dow from d)::int,
       extract(dow from d) in (0, 6)
from generate_series('2025-01-01'::date, '2032-12-31'::date, interval '1 day') as g(d)
on conflict (day) do nothing;

-- SCD-lite: one row per event, overwritten on every ingest (current values),
-- with first_seen_at kept. owner_hash is a one-way sha256 of the Clerk user id
-- so the warehouse holds no account identifier (DATA-3: minimise PII).
create table if not exists analytics.dim_event (
  event_id      text primary key,
  mode          text not null default '',
  tier          text,
  state         text not null default '',
  city          text not null default '',      -- events.location as entered by the host
  owner_hash    text not null default '',
  created_at    timestamptz,
  claimed_at    timestamptz,
  paid_at       timestamptz,
  published_at  timestamptz,
  event_date    date,
  first_seen_at timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists analytics.dim_vendor (
  vendor_id     text primary key,
  department    text not null default '',
  city          text not null default '',
  status        text not null default '',
  purchase_mode text not null default '',
  payment_ready boolean not null default false,
  created_at    timestamptz,
  first_seen_at timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Facts
-- ---------------------------------------------------------------------------
-- Generic daily metric (anything without its own fact table). `dims` is the
-- dimension tuple, e.g. {"mode":"boda"} or {}.
create table if not exists analytics.fact_daily (
  day        date    not null,
  metric_key text    not null,
  dims       jsonb   not null default '{}'::jsonb,
  value      numeric not null default 0,
  primary key (day, metric_key, dims)
);

create table if not exists analytics.fact_site_views_daily (
  day      date    not null,
  event_id text    not null,
  views    integer not null default 0,
  primary key (day, event_id)
);

-- day = when the answer was given (responded_at), else when the row was created.
create table if not exists analytics.fact_rsvps_daily (
  day      date    not null,
  event_id text    not null,
  status   text    not null,
  count    integer not null default 0,
  primary key (day, event_id, status)
);

create table if not exists analytics.fact_gifts_daily (
  day                 date   not null,
  event_id            text   not null,
  status              text   not null,
  count               integer not null default 0,
  amount_cents        bigint not null default 0,
  platform_fee_cents  bigint not null default 0,
  provider_fee_cents  bigint not null default 0,
  host_proceeds_cents bigint not null default 0,
  primary key (day, event_id, status)
);

-- One row per payment attempt (DATA-2 payment facts). gateway_amount_cents is
-- what the gateway said it charged (Stripe: stripe_amount_cents); fee_cents is
-- filled by reconciliation from the gateway's balance transaction, 0 until then.
create table if not exists analytics.fact_payments (
  attempt_id           text   primary key,
  day                  date   not null,
  gateway              text   not null,
  flow                 text   not null,
  method               text   not null default 'card',
  status               text   not null,
  amount_cents         bigint not null default 0,
  gateway_amount_cents bigint,
  fee_cents            bigint not null default 0,
  refunded_cents       bigint not null default 0,
  currency             text   not null default 'MXN',
  event_id             text,
  provider_reference   text,          -- our reference (Stripe: checkout session id)
  gateway_reference    text,          -- the gateway's charge reference (Stripe: payment intent id)
  created_at           timestamptz not null,
  succeeded_at         timestamptz,
  updated_at           timestamptz not null default now()
);
create index if not exists fact_payments_day_gateway_idx on analytics.fact_payments (day, gateway);
create index if not exists fact_payments_provider_ref_idx on analytics.fact_payments (provider_reference);
create index if not exists fact_payments_gateway_ref_idx on analytics.fact_payments (gateway_reference);

create table if not exists analytics.fact_vendor_leads_daily (
  day              date    not null,
  vendor_id        text    not null,
  listing_views    integer not null default 0,
  selections       integer not null default 0,
  quotes_requested integer not null default 0,
  conversations    integer not null default 0,
  primary key (day, vendor_id)
);

-- source = 'campaign' (public.messages: host email/SMS blasts, counters only)
--        | 'delivery' (public.message_deliveries: per-recipient rows, incl. WhatsApp)
create table if not exists analytics.fact_messages_daily (
  day        date    not null,
  source     text    not null,
  channel    text    not null,
  event_id   text    not null default '',
  recipients integer not null default 0,
  sent       integer not null default 0,
  delivered  integer not null default 0,
  failed     integer not null default 0,
  primary key (day, source, channel, event_id)
);

-- Response time: seconds from the customer's first message to the first reply
-- by the vendor or Lazo, averaged over conversations started that day.
create table if not exists analytics.fact_chat_daily (
  day                        date    not null,
  kind                       text    not null,
  conversations_started      integer not null default 0,
  messages                   integer not null default 0,
  customer_messages          integer not null default 0,
  vendor_messages            integer not null default 0,
  admin_messages             integer not null default 0,
  responded_conversations    integer not null default 0,
  avg_first_response_seconds numeric,
  primary key (day, kind)
);

-- ---------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------
create table if not exists analytics.ingest_runs (
  id          bigserial primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running' check (status in ('running','ok','error')),
  rows        integer not null default 0,
  error       text not null default '',
  window_from timestamptz not null,
  window_to   timestamptz not null,
  trigger     text not null default 'manual'      -- manual | scheduler | cron | sql
);
create index if not exists ingest_runs_started_idx on analytics.ingest_runs (started_at desc);

-- DATA-3: warehouse totals vs what the gateway reports, per day and gateway.
create table if not exists analytics.revenue_reconciliation (
  day               date   not null,
  gateway           text   not null,
  db_gross          bigint not null default 0,   -- succeeded amount_cents in fact_payments
  gateway_gross     bigint,                      -- gateway's gross for that day, null when unchecked
  db_count          integer not null default 0,
  gateway_count     integer,
  gateway_fee_cents bigint,
  delta             bigint,                      -- gateway_gross - db_gross
  status            text   not null default 'unchecked' check (status in ('ok','mismatch','unchecked')),
  note              text   not null default '',
  checked_at        timestamptz,
  primary key (day, gateway)
);

-- ---------------------------------------------------------------------------
-- Ingest (SQL implementation, shared by the backend scheduler and pg_cron)
-- ---------------------------------------------------------------------------
-- Recomputes every fact for the whole days touched by [window_from, window_to]
-- and refreshes the dimensions. Returns the ingest_runs row it wrote.
create or replace function analytics.ingest(window_from timestamptz, window_to timestamptz, run_trigger text default 'sql')
returns analytics.ingest_runs
language plpgsql
security definer
set search_path = public, analytics
as $$
declare
  run      analytics.ingest_runs;
  d0       date := window_from::date;
  d1       date := window_to::date;
  t_end    timestamptz := (window_to::date + 1)::timestamptz;   -- exclusive upper bound
  t_start  timestamptz := window_from::date::timestamptz;
  n        integer := 0;
  total    integer := 0;
begin
  insert into analytics.ingest_runs (window_from, window_to, trigger)
  values (window_from, window_to, coalesce(run_trigger, 'sql'))
  returning * into run;

  begin
    -- Dimensions: small tables, refreshed whole.
    insert into analytics.dim_event (event_id, mode, tier, state, city, owner_hash,
                                     created_at, claimed_at, paid_at, published_at, event_date, updated_at)
    select e.id, e.mode, e.tier, e.state, coalesce(e.location, ''),
           encode(sha256(convert_to(coalesce(e.owner_id, ''), 'UTF8')), 'hex'),
           e.created_at, e.claimed_at, e.paid_at, e.published_at, e.event_date, now()
    from public.events e
    on conflict (event_id) do update set
      mode = excluded.mode, tier = excluded.tier, state = excluded.state, city = excluded.city,
      owner_hash = excluded.owner_hash, created_at = excluded.created_at, claimed_at = excluded.claimed_at,
      paid_at = excluded.paid_at, published_at = excluded.published_at, event_date = excluded.event_date,
      updated_at = now();
    get diagnostics n = row_count; total := total + n;

    insert into analytics.dim_vendor (vendor_id, department, city, status, purchase_mode, payment_ready, created_at, updated_at)
    select v.id::text, v.department, coalesce(v.city, ''), v.status, v.purchase_mode, v.payment_ready, v.created_at, now()
    from public.vendors v
    on conflict (vendor_id) do update set
      department = excluded.department, city = excluded.city, status = excluded.status,
      purchase_mode = excluded.purchase_mode, payment_ready = excluded.payment_ready,
      created_at = excluded.created_at, updated_at = now();
    get diagnostics n = row_count; total := total + n;

    -- Site views: the source is already daily.
    delete from analytics.fact_site_views_daily where day between d0 and d1;
    insert into analytics.fact_site_views_daily (day, event_id, views)
    select sv.day, sv.event_id, sv.views from public.site_views sv where sv.day between d0 and d1;
    get diagnostics n = row_count; total := total + n;

    -- RSVPs by answer day.
    delete from analytics.fact_rsvps_daily where day between d0 and d1;
    insert into analytics.fact_rsvps_daily (day, event_id, status, count)
    select coalesce(r.responded_at, r.created_at)::date, r.event_id, r.status, count(*)
    from public.rsvps r
    where coalesce(r.responded_at, r.created_at) >= t_start and coalesce(r.responded_at, r.created_at) < t_end
    group by 1, 2, 3;
    get diagnostics n = row_count; total := total + n;

    -- Gifts (guest money, kept apart from Lazo revenue).
    delete from analytics.fact_gifts_daily where day between d0 and d1;
    insert into analytics.fact_gifts_daily (day, event_id, status, count, amount_cents, platform_fee_cents, provider_fee_cents, host_proceeds_cents)
    select g.created_at::date, g.event_id, g.status, count(*),
           sum(g.amount_cents), sum(g.platform_fee_cents), sum(g.provider_fee_cents), sum(g.host_proceeds_cents)
    from public.gifts g
    where g.created_at >= t_start and g.created_at < t_end
    group by 1, 2, 3;
    get diagnostics n = row_count; total := total + n;

    -- Payments: one row per attempt, keyed by the attempt id, refreshed when
    -- the attempt was created or changed inside the window.
    insert into analytics.fact_payments (attempt_id, day, gateway, flow, method, status, amount_cents,
                                         gateway_amount_cents, refunded_cents, currency, event_id,
                                         provider_reference, gateway_reference, created_at, succeeded_at, updated_at)
    select p.id::text, coalesce(p.succeeded_at, p.created_at)::date, p.gateway, p.flow, p.method, p.status,
           p.amount_cents, p.stripe_amount_cents,
           coalesce((select sum(r.amount_cents) from public.refunds r
                     where r.payment_attempt_id = p.id and r.status = 'succeeded'), 0),
           p.currency, p.event_id, p.provider_reference, p.stripe_payment_intent, p.created_at, p.succeeded_at, now()
    from public.payment_attempts p
    where (p.created_at >= t_start and p.created_at < t_end)
       or (p.updated_at >= t_start and p.updated_at < t_end)
       or (p.succeeded_at >= t_start and p.succeeded_at < t_end)
    on conflict (attempt_id) do update set
      day = excluded.day, gateway = excluded.gateway, flow = excluded.flow, method = excluded.method,
      status = excluded.status, amount_cents = excluded.amount_cents,
      gateway_amount_cents = excluded.gateway_amount_cents, refunded_cents = excluded.refunded_cents,
      currency = excluded.currency, event_id = excluded.event_id,
      provider_reference = excluded.provider_reference, gateway_reference = excluded.gateway_reference,
      succeeded_at = excluded.succeeded_at, updated_at = now();
    get diagnostics n = row_count; total := total + n;

    -- Vendor leads: listing views, selections, quote requests, conversations opened.
    delete from analytics.fact_vendor_leads_daily where day between d0 and d1;
    insert into analytics.fact_vendor_leads_daily (day, vendor_id, listing_views, selections, quotes_requested, conversations)
    select day, vendor_id, sum(lv), sum(sel), sum(q), sum(c) from (
      select viewed_on as day, vendor_id::text as vendor_id, count(*) as lv, 0 as sel, 0 as q, 0 as c
        from public.vendor_listing_views where viewed_on between d0 and d1 group by 1, 2
      union all
      select created_at::date, vendor_id::text, 0, count(*), 0, 0
        from public.vendor_selections where created_at >= t_start and created_at < t_end group by 1, 2
      union all
      select created_at::date, vendor_id::text, 0, 0, count(*), 0
        from public.quotes where created_at >= t_start and created_at < t_end group by 1, 2
      union all
      select created_at::date, vendor_id::text, 0, 0, 0, count(*)
        from public.conversations where vendor_id is not null and created_at >= t_start and created_at < t_end group by 1, 2
    ) u
    group by 1, 2;
    get diagnostics n = row_count; total := total + n;

    -- Messages: campaign counters plus per-recipient deliveries.
    delete from analytics.fact_messages_daily where day between d0 and d1;
    insert into analytics.fact_messages_daily (day, source, channel, event_id, recipients, sent, delivered, failed)
    select m.created_at::date, 'campaign', m.channel, m.event_id,
           sum(m.recipients), sum(m.sent), 0, sum(m.failed)
    from public.messages m
    where m.created_at >= t_start and m.created_at < t_end
    group by 1, 2, 3, 4
    union all
    select d.created_at::date, 'delivery', d.channel, coalesce(d.event_id, ''),
           count(*),
           count(*) filter (where d.status in ('sent', 'delivered', 'read')),
           count(*) filter (where d.status in ('delivered', 'read')),
           count(*) filter (where d.status = 'failed')
    from public.message_deliveries d
    where d.created_at >= t_start and d.created_at < t_end
    group by 1, 2, 3, 4;
    get diagnostics n = row_count; total := total + n;

    -- Chat: volume by day, and first-response time for conversations started that day.
    delete from analytics.fact_chat_daily where day between d0 and d1;
    insert into analytics.fact_chat_daily (day, kind, conversations_started, messages, customer_messages,
                                           vendor_messages, admin_messages, responded_conversations,
                                           avg_first_response_seconds)
    with starts as (
      select c.created_at::date as day, c.kind, count(*) as started
      from public.conversations c
      where c.created_at >= t_start and c.created_at < t_end
      group by 1, 2
    ), msgs as (
      select m.created_at::date as day, c.kind,
             count(*) as messages,
             count(*) filter (where m.sender_role = 'customer') as customer_messages,
             count(*) filter (where m.sender_role = 'vendor') as vendor_messages,
             count(*) filter (where m.sender_role = 'admin') as admin_messages
      from public.chat_messages m
      join public.conversations c on c.id = m.conversation_id
      where m.created_at >= t_start and m.created_at < t_end
      group by 1, 2
    ), first_reply as (
      select c.created_at::date as day, c.kind,
             (select min(m.created_at) from public.chat_messages m
               where m.conversation_id = c.id and m.sender_role = 'customer') as asked_at,
             (select min(m.created_at) from public.chat_messages m
               where m.conversation_id = c.id and m.sender_role <> 'customer'
                 and m.created_at > (select min(m2.created_at) from public.chat_messages m2
                                     where m2.conversation_id = c.id and m2.sender_role = 'customer')) as replied_at
      from public.conversations c
      where c.created_at >= t_start and c.created_at < t_end
    ), response as (
      select day, kind,
             count(*) filter (where replied_at is not null) as responded,
             avg(extract(epoch from (replied_at - asked_at))) filter (where replied_at is not null) as avg_seconds
      from first_reply
      group by 1, 2
    ), keys as (
      select day, kind from starts union select day, kind from msgs
    )
    select k.day, k.kind,
           coalesce(s.started, 0), coalesce(m.messages, 0), coalesce(m.customer_messages, 0),
           coalesce(m.vendor_messages, 0), coalesce(m.admin_messages, 0),
           coalesce(r.responded, 0), r.avg_seconds
    from keys k
    left join starts s on s.day = k.day and s.kind = k.kind
    left join msgs m on m.day = k.day and m.kind = k.kind
    left join response r on r.day = k.day and r.kind = k.kind;
    get diagnostics n = row_count; total := total + n;

    -- Generic daily metrics: the event funnel (DATA-2) by mode, and photos.
    delete from analytics.fact_daily where day between d0 and d1;
    insert into analytics.fact_daily (day, metric_key, dims, value)
    select day, metric_key, dims, sum(value) from (
      select created_at::date as day, 'events_created' as metric_key, jsonb_build_object('mode', mode) as dims, count(*)::numeric as value
        from public.events where created_at >= t_start and created_at < t_end group by 1, 3
      union all
      select claimed_at::date, 'events_claimed', jsonb_build_object('mode', mode), count(*)
        from public.events where claimed_at >= t_start and claimed_at < t_end group by 1, 3
      union all
      select paid_at::date, 'events_paid', jsonb_build_object('mode', mode, 'tier', coalesce(tier, '')), count(*)
        from public.events where paid_at >= t_start and paid_at < t_end group by 1, 3
      union all
      select published_at::date, 'events_published', jsonb_build_object('mode', mode), count(*)
        from public.events where published_at >= t_start and published_at < t_end group by 1, 3
      union all
      select created_at::date, 'orders_created', jsonb_build_object('purchase_mode', purchase_mode), count(*)
        from public.orders where created_at >= t_start and created_at < t_end group by 1, 3
      union all
      select updated_at::date, 'orders_fulfilled', '{}'::jsonb, count(*)
        from public.orders where status = 'fulfilled' and updated_at >= t_start and updated_at < t_end group by 1
      union all
      select updated_at::date, 'orders_gmv_cents', '{}'::jsonb, sum(total_cents)
        from public.orders where status in ('paid','confirmed','in_fulfilment','fulfilled') and updated_at >= t_start and updated_at < t_end group by 1
      union all
      select created_at::date, 'photos_uploaded', jsonb_build_object('status', status), count(*)
        from public.photos where created_at >= t_start and created_at < t_end group by 1, 3
      union all
      select created_at::date, 'refunds_cents', jsonb_build_object('status', status), sum(amount_cents)
        from public.refunds where created_at >= t_start and created_at < t_end group by 1, 3
      union all
      select created_at::date, 'users_created', '{}'::jsonb, count(*)
        from public.users where created_at >= t_start and created_at < t_end group by 1
    ) u
    group by 1, 2, 3;
    get diagnostics n = row_count; total := total + n;

    -- Every day with payments gets a reconciliation row, unchecked until a
    -- reconcile run compares it with the gateway.
    insert into analytics.revenue_reconciliation as rr (day, gateway, db_gross, db_count)
    select p.day, p.gateway,
           coalesce(sum(p.amount_cents) filter (where p.status in ('succeeded','partially_refunded','refunded')), 0),
           count(*) filter (where p.status in ('succeeded','partially_refunded','refunded'))
    from analytics.fact_payments p
    where p.day between d0 and d1
    group by 1, 2
    on conflict (day, gateway) do update set
      db_gross = excluded.db_gross, db_count = excluded.db_count,
      -- A changed DB total invalidates an earlier verdict.
      status = case when rr.db_gross = excluded.db_gross and rr.db_count = excluded.db_count
                    then rr.status else 'unchecked' end;

    update analytics.ingest_runs
       set finished_at = now(), status = 'ok', rows = total
     where id = run.id
    returning * into run;
  exception when others then
    update analytics.ingest_runs
       set finished_at = now(), status = 'error', rows = total, error = sqlerrm
     where id = run.id
    returning * into run;
  end;

  return run;
end;
$$;

-- Incremental run: from the last successful window end minus one day (so late
-- callbacks and edits to yesterday's rows are picked up) to now. A first run
-- starts at the oldest event.
create or replace function analytics.ingest_incremental(run_trigger text default 'cron')
returns analytics.ingest_runs
language plpgsql
security definer
set search_path = public, analytics
as $$
declare
  last_to timestamptz;
  from_ts timestamptz;
begin
  select max(window_to) into last_to from analytics.ingest_runs where status = 'ok';
  if last_to is null then
    select coalesce(min(created_at), now()) into from_ts from public.events;
  else
    from_ts := last_to - interval '1 day';
  end if;
  return analytics.ingest(from_ts, now(), run_trigger);
end;
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
-- RLS on (no policies): only the owner and the service role read these, and
-- both bypass RLS; the API roles have no grants at all.
alter table analytics.dim_date               enable row level security;
alter table analytics.dim_event              enable row level security;
alter table analytics.dim_vendor             enable row level security;
alter table analytics.fact_daily             enable row level security;
alter table analytics.fact_site_views_daily  enable row level security;
alter table analytics.fact_rsvps_daily       enable row level security;
alter table analytics.fact_gifts_daily       enable row level security;
alter table analytics.fact_payments          enable row level security;
alter table analytics.fact_vendor_leads_daily enable row level security;
alter table analytics.fact_messages_daily    enable row level security;
alter table analytics.fact_chat_daily        enable row level security;
alter table analytics.ingest_runs            enable row level security;
alter table analytics.revenue_reconciliation enable row level security;

revoke all on schema analytics from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on schema analytics from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on schema analytics from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema analytics to service_role;
    grant all on all tables in schema analytics to service_role;
    grant all on all sequences in schema analytics to service_role;
    grant execute on all functions in schema analytics to service_role;
    alter default privileges in schema analytics grant all on tables to service_role;
    alter default privileges in schema analytics grant all on sequences to service_role;
  end if;
end $$;

revoke execute on function analytics.ingest(timestamptz, timestamptz, text) from public;
revoke execute on function analytics.ingest_incremental(text) from public;

-- ---------------------------------------------------------------------------
-- Optional: schedule inside the database with pg_cron (Supabase: Database →
-- Extensions → pg_cron). The backend already runs the same ingest every
-- ANALYTICS_INGEST_INTERVAL_MINUTES; enable ONE of the two, not both.
-- ---------------------------------------------------------------------------
-- create extension if not exists pg_cron;
-- select cron.schedule('lazo-analytics-ingest', '15 */6 * * *',
--   $$select analytics.ingest_incremental('cron')$$);
-- -- To stop it later: select cron.unschedule('lazo-analytics-ingest');
