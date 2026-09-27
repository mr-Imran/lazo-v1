-- Homepage: occasion cards, the custom-domain price, and newsletter sign-ups.
--
-- The homepage's "Planning an event has never been this easy" carousel is
-- event_modes: each card shows the label, a one-line description and an
-- image. Admins edit them in the backend dashboard (Occasions); images are
-- uploaded to the public site-media bucket, which the API creates on first
-- upload.

-- ============================================================ event_modes (extend)

alter table public.event_modes
  add column if not exists description text not null default '' check (length(description) <= 200),
  add column if not exists image_url   text not null default '';

-- Copy from the homepage design. Only rows still empty are filled, so edits
-- made in the dashboard are never overwritten by re-running this file.
update public.event_modes set description = 'Civil, church, reception and tornaboda, with RSVPs by family.'
  where value = 'boda' and description = '';
update public.event_modes set description = 'Mass, waltz and party, with chambelanes and damas by name.'
  where value = 'xv' and description = '';
update public.event_modes set description = 'Mass and family lunch, with godparents and guest list.'
  where value = 'bautizo' and description = '';

-- ============================================================ services

-- "A custom domain costs $300 MXN, once." (homepage call to action).
insert into public.services (key, name, price_centavos, currency) values
  ('custom_domain', 'Custom domain', 30000, 'MXN')
on conflict (key) do nothing;

-- ============================================================ newsletter

-- Footer sign-up ("Get the latest updates, tips and inspiration").
create table if not exists public.newsletter_subscribers (
  id               uuid        primary key default gen_random_uuid(),
  email            text        not null check (length(email) between 3 and 254),
  source           text        not null default 'homepage' check (length(source) <= 40),
  created_at       timestamptz not null default now(),
  unsubscribed_at  timestamptz
);

-- One row per address, whatever the case it was typed in.
create unique index if not exists newsletter_subscribers_email_unique
  on public.newsletter_subscribers (lower(email));

alter table public.newsletter_subscribers enable row level security;
