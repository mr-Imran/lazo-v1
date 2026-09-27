-- Abuse and cost limits (session 2026-09-26).
--
-- 1. Daily send caps per plan, as services rows (price_centavos holds the cap;
--    edit the row to change it, no deploy). Missing rows fall back to 500/day.
-- 2. Refund atomicity: a pending amount is reserved on the row *before* Stripe
--    or Mercado Pago is called, with a conditional update, so two concurrent
--    refunds cannot together exceed what was charged. On success the pending
--    amount moves to refunded; on failure it is released.
-- 3. Client idempotency keys on vendor refunds: repeating a request returns
--    the refund it already created.
--
-- Idempotent: safe to run more than once.

-- ============================================================ send caps

insert into public.services (key, name, price_centavos, currency, active) values
  ('message_daily_cap_premium',   'Messages per event per day (Premium plan)',   1000, 'MXN', true),
  ('message_daily_cap_signature', 'Messages per event per day (Signature plan)', 3000, 'MXN', true)
on conflict (key) do nothing;

create index if not exists message_deliveries_event_created_idx
  on public.message_deliveries (event_id, created_at desc);

-- ============================================================ refunds

alter table public.vendor_orders
  add column if not exists refund_pending bigint not null default 0 check (refund_pending >= 0);

alter table public.payment_attempts
  add column if not exists refund_pending bigint not null default 0 check (refund_pending >= 0);

alter table public.vendor_refunds
  add column if not exists idempotency_key text check (length(idempotency_key) <= 64);

create unique index if not exists vendor_refunds_idempotency_idx
  on public.vendor_refunds (order_id, idempotency_key) where idempotency_key is not null;

-- Reserve: true when the amount still fits (refunded + pending + amount <= charged).
create or replace function public.lazo_vendor_refund_reserve(p_id uuid, p_amount bigint) returns boolean
language sql security definer set search_path = public as $$
  with u as (
    update public.vendor_orders
       set refund_pending = refund_pending + p_amount, updated_at = now()
     where id = p_id and p_amount > 0
       and refunded_centavos + refund_pending + p_amount <= amount_centavos
    returning 1
  )
  select exists (select 1 from u)
$$;

-- Settle: p_ok moves pending → refunded (and closes the order when fully refunded); otherwise releases it.
create or replace function public.lazo_vendor_refund_settle(p_id uuid, p_amount bigint, p_ok boolean) returns void
language sql security definer set search_path = public as $$
  update public.vendor_orders
     set refund_pending    = greatest(0, refund_pending - p_amount),
         refunded_centavos = case when p_ok then refunded_centavos + p_amount else refunded_centavos end,
         status            = case when p_ok and refunded_centavos + p_amount >= amount_centavos then 'refunded' else status end,
         updated_at        = now()
   where id = p_id
$$;

create or replace function public.lazo_payment_refund_reserve(p_id uuid, p_amount bigint) returns boolean
language sql security definer set search_path = public as $$
  with u as (
    update public.payment_attempts
       set refund_pending = refund_pending + p_amount, updated_at = now()
     where id = p_id and p_amount > 0
       and refunded_centavos + refund_pending + p_amount <= coalesce(stripe_amount_cents, amount_cents, 0)
    returning 1
  )
  select exists (select 1 from u)
$$;

create or replace function public.lazo_payment_refund_settle(p_id uuid, p_amount bigint, p_ok boolean) returns void
language sql security definer set search_path = public as $$
  update public.payment_attempts
     set refund_pending    = greatest(0, refund_pending - p_amount),
         refunded_centavos = case when p_ok then refunded_centavos + p_amount else refunded_centavos end,
         updated_at        = now()
   where id = p_id
$$;

revoke all on function public.lazo_vendor_refund_reserve(uuid, bigint)           from public, anon, authenticated;
revoke all on function public.lazo_vendor_refund_settle(uuid, bigint, boolean)   from public, anon, authenticated;
revoke all on function public.lazo_payment_refund_reserve(uuid, bigint)          from public, anon, authenticated;
revoke all on function public.lazo_payment_refund_settle(uuid, bigint, boolean)  from public, anon, authenticated;
grant execute on function public.lazo_vendor_refund_reserve(uuid, bigint)          to service_role;
grant execute on function public.lazo_vendor_refund_settle(uuid, bigint, boolean)  to service_role;
grant execute on function public.lazo_payment_refund_reserve(uuid, bigint)         to service_role;
grant execute on function public.lazo_payment_refund_settle(uuid, bigint, boolean) to service_role;
