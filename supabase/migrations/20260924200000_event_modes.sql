-- Occasions a host can pick in the create flow, as data rather than code.
--
-- GET /api/event-types reads this table (active rows, by position), so adding,
-- renaming, reordering or hiding an occasion is a row change, not a deploy.
-- The rows below are the PRD modes already allowed by the check constraint on
-- events.mode; the foreign key replaces that constraint so the two lists
-- cannot drift apart.

create table if not exists public.event_modes (
  value       text        primary key check (value ~ '^[a-z0-9_]+$'),
  label       text        not null check (length(label) between 1 and 60),
  position    integer     not null default 0,
  active      boolean     not null default true,
  created_at  timestamptz not null default now()
);

-- Same convention as every other table: RLS on, no policies, server-only access.
alter table public.event_modes enable row level security;

insert into public.event_modes (value, label, position) values
  ('boda',       'Wedding',    10),
  ('xv',         'XV Años',    20),
  ('bautizo',    'Baptism',    30),
  ('graduacion', 'Graduation', 40),
  ('corporate',  'Corporate',  50),
  ('memorial',   'Memorial',   60)
on conflict (value) do nothing;

-- Swap the hard-coded check for a reference to the table. Deactivating a mode
-- (active = false) hides it from the picker without orphaning existing events.
alter table public.events drop constraint if exists events_mode_check;

alter table public.events
  drop constraint if exists events_mode_fkey,
  add constraint events_mode_fkey
    foreign key (mode) references public.event_modes (value) on update cascade;
