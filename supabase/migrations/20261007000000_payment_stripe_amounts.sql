-- What Stripe actually charged, recorded from the Checkout session when a
-- payment settles, so the admin dashboard shows Stripe's figure next to ours.
alter table public.payment_attempts
  add column if not exists stripe_amount_cents   bigint,
  add column if not exists stripe_currency       text,
  add column if not exists stripe_payment_intent text,
  add column if not exists receipt_url           text not null default '';
