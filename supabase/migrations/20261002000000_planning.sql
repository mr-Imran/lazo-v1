-- Planning workspace (checklist and budget), vendor inquiries, and site views.

-- ============================================================ checklist

-- Suggested tasks by occasion, offered to the host as a starting point
-- ("Start from our checklist"); nothing is added to an event automatically.
-- months_before: how long before the event date the task is due.
create table if not exists public.checklist_templates (
  id            uuid    primary key default gen_random_uuid(),
  modes         text[]  not null default '{}',   -- empty = every occasion
  title         text    not null check (length(title) between 1 and 160),
  category      text    not null default '' check (length(category) <= 60),
  months_before numeric(4,1) not null default 0,
  position      integer not null default 0,
  unique (title, modes)
);
alter table public.checklist_templates enable row level security;

insert into public.checklist_templates (modes, title, category, months_before, position) values
  ('{}',       'Set your total budget',                        'Budget',      12, 10),
  ('{}',       'Draft your guest list',                        'Guests',      11, 20),
  ('{}',       'Choose a date and book the venue',             'Venue',       11, 30),
  ('{boda}',   'Book the church or civil registry',            'Ceremony',    10, 40),
  ('{xv}',     'Book the church for the mass',                 'Ceremony',     8, 40),
  ('{}',       'Book the caterer',                             'Vendors',      9, 50),
  ('{boda,xv}','Book the photographer and videographer',       'Vendors',      9, 60),
  ('{boda,xv}','Book music: band, DJ or mariachi',             'Vendors',      8, 70),
  ('{boda}',   'Choose padrinos and madrinas',                 'Ceremony',     8, 80),
  ('{xv}',     'Choose chambelanes and practice the waltz',    'Ceremony',     6, 80),
  ('{boda}',   'Choose the wedding dress and suits',           'Attire',       7, 90),
  ('{xv}',     'Choose the XV dress',                          'Attire',       6, 90),
  ('{}',       'Publish your event website',                   'Guests',       6, 100),
  ('{}',       'Send save-the-dates',                          'Guests',       6, 110),
  ('{boda}',   'Create your gift registry',                    'Gifts',        5, 120),
  ('{}',       'Book florist and decoration',                  'Vendors',      5, 130),
  ('{boda,xv}','Order the cake',                               'Vendors',      3, 140),
  ('{}',       'Send invitations',                             'Guests',       3, 150),
  ('{}',       'Book hotel rooms for out-of-town guests',      'Travel',       3, 160),
  ('{boda}',   'Get the civil marriage paperwork ready',       'Ceremony',     2, 170),
  ('{}',       'Confirm the menu and tasting',                 'Vendors',      2, 180),
  ('{}',       'Chase missing RSVPs',                          'Guests',       1, 190),
  ('{}',       'Finalise seating and give numbers to vendors', 'Guests',     0.5, 200),
  ('{}',       'Confirm times with every vendor',              'Vendors',   0.25, 210),
  ('{}',       'Send thank-you notes',                         'Gifts',       -1, 220)
on conflict (title, modes) do nothing;

create table if not exists public.planning_tasks (
  id          uuid        primary key default gen_random_uuid(),
  event_id    text        not null references public.events(id) on delete cascade,
  title       text        not null check (length(title) between 1 and 160),
  category    text        not null default '' check (length(category) <= 60),
  due_date    date,
  notes       text        not null default '' check (length(notes) <= 1000),
  done_at     timestamptz,
  position    integer     not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists planning_tasks_event_idx on public.planning_tasks (event_id, position);
alter table public.planning_tasks enable row level security;

-- ============================================================ budget

alter table public.events
  add column if not exists budget_cents bigint check (budget_cents >= 0);

-- Money in integer centavos (PAY-6). These are the host's own numbers; no
-- money moves through them.
create table if not exists public.budget_items (
  id              uuid        primary key default gen_random_uuid(),
  event_id        text        not null references public.events(id) on delete cascade,
  category        text        not null default '' check (length(category) <= 60),
  name            text        not null check (length(name) between 1 and 160),
  estimated_cents bigint      not null default 0 check (estimated_cents >= 0),
  actual_cents    bigint      check (actual_cents >= 0),
  paid_cents      bigint      not null default 0 check (paid_cents >= 0),
  vendor_id       uuid        references public.vendors(id) on delete set null,
  notes           text        not null default '' check (length(notes) <= 1000),
  position        integer     not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists budget_items_event_idx on public.budget_items (event_id, position);
alter table public.budget_items enable row level security;

-- ============================================================ vendor inquiries

-- A host's "request a quote" is a quotes row with status 'requested'; the
-- vendor's answer (a message and optionally a price) moves it to 'sent'.
alter table public.quotes
  add column if not exists owner_id      text,
  add column if not exists location_id   uuid references public.vendor_locations(id) on delete set null,
  add column if not exists package_id    uuid references public.vendor_packages(id) on delete set null,
  add column if not exists message       text not null default '' check (length(message) <= 2000),
  add column if not exists contact_email text not null default '' check (length(contact_email) <= 200),
  add column if not exists contact_phone text not null default '' check (length(contact_phone) <= 40),
  add column if not exists vendor_reply  text not null default '' check (length(vendor_reply) <= 2000),
  add column if not exists replied_at    timestamptz,
  add column if not exists updated_at    timestamptz not null default now();
create index if not exists quotes_vendor_idx on public.quotes (vendor_id, created_at desc);

-- ============================================================ site views

-- Page loads of a live site per day, for the host's dashboard.
create table if not exists public.site_views (
  event_id  text    not null references public.events(id) on delete cascade,
  day       date    not null,
  views     integer not null default 0,
  primary key (event_id, day)
);
alter table public.site_views enable row level security;

create or replace function public.lazo_count_site_view(p_event_id text) returns void
language sql security definer set search_path = public as $$
  insert into public.site_views (event_id, day, views)
  values (p_event_id, (now() at time zone 'America/Mexico_City')::date, 1)
  on conflict (event_id, day) do update set views = public.site_views.views + 1
$$;
-- Only the server (service role) may count views.
revoke all on function public.lazo_count_site_view(text) from public, anon, authenticated;
grant execute on function public.lazo_count_site_view(text) to service_role;
