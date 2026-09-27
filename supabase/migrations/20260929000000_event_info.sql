-- Site builder steps "Ceremony Info" and "Event Info".
--
-- Ceremony Info: each occasion lists the families it asks about
-- (event_modes.family_sections); the answers live on events.families. The
-- person's own name stays in events.details (e.g. partner2 = the groom), so
-- the section only points at it with nameKey.
--
-- Event Info: the celebrations that make up the event (ceremony, reception,
-- after party…) are sub_events. Which kinds an occasion offers is the new
-- sub_event_kinds table, replacing the fixed check on sub_events.kind. Each
-- sub-event gets its own date, guest-arrival and start times, expected guests,
-- and optionally a venue picked from an approved vendor location.

-- ============================================================ families

alter table public.event_modes
  add column if not exists family_title    text  not null default '',
  add column if not exists family_sections jsonb not null default '[]'::jsonb;

-- Answers, keyed by section key: { "groom": { "father": "", "mother": "", "address": "" } }.
-- Validated by the API against the event's mode. Addresses are never public.
alter table public.events
  add column if not exists families jsonb not null default '{}'::jsonb;

update public.event_modes set
  family_title = 'Together with Our Families',
  family_sections = '[
    {"key":"groom","title":"The Groom''s Family","nameKey":"partner2","nameLabel":"Groom name"},
    {"key":"bride","title":"The Bride''s Family","nameKey":"partner1","nameLabel":"Bride name"}
  ]'::jsonb
where value = 'boda' and family_sections = '[]'::jsonb;

update public.event_modes set
  family_title = 'Together with Our Family',
  family_sections = '[
    {"key":"family","title":"The Quinceañera''s Family","nameKey":"honoree","nameLabel":"Quinceañera''s name"}
  ]'::jsonb
where value = 'xv' and family_sections = '[]'::jsonb;

update public.event_modes set
  family_title = 'Together with Our Family',
  family_sections = '[
    {"key":"family","title":"The Baby''s Family","nameKey":"honoree","nameLabel":"Baby''s name"}
  ]'::jsonb
where value = 'bautizo' and family_sections = '[]'::jsonb;

update public.event_modes set
  family_title = 'Together with Our Family',
  family_sections = '[
    {"key":"family","title":"The Graduate''s Family","nameKey":"honoree","nameLabel":"Graduate''s name"}
  ]'::jsonb
where value = 'graduacion' and family_sections = '[]'::jsonb;

-- ============================================================ sub-event kinds

create table if not exists public.sub_event_kinds (
  value     text    primary key check (value ~ '^[a-z0-9_]+$'),
  label     text    not null check (length(label) between 1 and 60),
  -- Occasions (event_modes.value) that offer it; empty = every occasion.
  modes     text[]  not null default '{}',
  position  integer not null default 0,
  active    boolean not null default true
);

alter table public.sub_event_kinds enable row level security;

-- The first eight are the values the old check allowed, so existing rows stay valid.
insert into public.sub_event_kinds (value, label, modes, position) values
  ('ceremonia_civil', 'Civil Ceremony',      '{boda}',                           20),
  ('misa',            'Mass',                '{xv,bautizo,memorial,graduacion}', 30),
  ('recepcion',       'Reception',           '{boda,xv,bautizo,graduacion}',     40),
  ('tornaboda',       'Tornaboda',           '{boda}',                           80),
  ('brindis',         'Toast',               '{}',                               90),
  ('agenda',          'Main Program',        '{corporate}',                      15),
  ('servicio',        'Service',             '{memorial}',                       15),
  ('other',           'Other',               '{}',                              999),
  ('ceremonia',       'Wedding Ceremony',    '{boda}',                           10),
  ('cena',            'Wedding Dinner',      '{boda}',                           50),
  ('after_party',     'After Party',         '{boda,xv,graduacion,corporate}',   60),
  ('mehendi',         'Mehendi',             '{boda}',                           70),
  ('vals',            'Waltz',               '{xv}',                             45),
  ('graduacion',      'Graduation Ceremony', '{graduacion}',                     10)
on conflict (value) do nothing;

alter table public.sub_events drop constraint if exists sub_events_kind_check;
alter table public.sub_events
  drop constraint if exists sub_events_kind_fkey,
  add constraint sub_events_kind_fkey
    foreign key (kind) references public.sub_event_kinds (value) on update cascade;

-- ============================================================ sub-events (extend)

-- Local wall-clock values as the host typed them (shown as-is on the site);
-- starts_at is derived from event_date + begin_time in the event's timezone.
alter table public.sub_events
  add column if not exists event_date         date,
  add column if not exists arrive_time        time,
  add column if not exists begin_time         time,
  add column if not exists guest_count        integer check (guest_count between 0 and 100000),
  add column if not exists vendor_location_id uuid references public.vendor_locations (id) on delete set null,
  add column if not exists image_url          text not null default '',
  add column if not exists updated_at         timestamptz not null default now();

create index if not exists sub_events_location_idx on public.sub_events (vendor_location_id)
  where vendor_location_id is not null;
