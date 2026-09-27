-- Guest list and RSVP.
--
-- Households (an invitation: one family or couple) hold guests; each guest
-- answers per sub-event (rsvps, one row per guest per sub-event — RSVP-1).
-- Guests find their invitation on the public site with the household's
-- invite code (from their invite link) or by typing their full name, and only
-- ever see their own household.

-- ============================================================ households

alter table public.households
  -- Sub-events this household is invited to; empty = every sub-event.
  add column if not exists invited_to        uuid[]      not null default '{}',
  add column if not exists rsvp_submitted_at timestamptz,
  add column if not exists rsvp_message      text        not null default '' check (length(rsvp_message) <= 600),
  add column if not exists notes             text        not null default '' check (length(notes) <= 600),
  add column if not exists updated_at        timestamptz not null default now();

-- ============================================================ guests

alter table public.guests
  add column if not exists email      text not null default '' check (length(email) <= 200),
  add column if not exists dietary    text not null default '' check (length(dietary) <= 300),
  -- Lower-case, accent-free, single-spaced full_name for "find my invitation".
  add column if not exists lookup_name text not null default '',
  add column if not exists position   integer not null default 0;

create or replace function public.lazo_lookup_name(value text) returns text
language sql immutable as $$
  select regexp_replace(
    lower(translate(coalesce(value, ''),
      'ÁÀÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇáàâäãéèêëíìîïóòôöõúùûüñç',
      'AAAAAEEEEIIIIOOOOOUUUUNCaaaaaeeeeiiiiooooouuuunc')),
    '\s+', ' ', 'g')
$$;

create or replace function public.lazo_guests_lookup_name() returns trigger
language plpgsql as $$
begin
  new.lookup_name := btrim(public.lazo_lookup_name(new.full_name));
  return new;
end
$$;

drop trigger if exists guests_lookup_name on public.guests;
create trigger guests_lookup_name
  before insert or update of full_name on public.guests
  for each row execute function public.lazo_guests_lookup_name();

update public.guests set lookup_name = btrim(public.lazo_lookup_name(full_name)) where lookup_name = '';

create index if not exists guests_lookup_idx on public.guests (event_id, lookup_name);

-- ============================================================ RSVP settings

alter table public.events
  add column if not exists rsvp_deadline date,
  add column if not exists rsvp_open     boolean not null default true;

-- Choices guests pick from for a sub-event's meal; empty = no menu question.
alter table public.sub_events
  add column if not exists menu_options text[] not null default '{}';
