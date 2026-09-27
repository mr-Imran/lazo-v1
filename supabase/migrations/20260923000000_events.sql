-- Events created in the Lazo dashboard.
--
-- Ownership is a Clerk user id, not a Supabase auth.uid(): Clerk is the only
-- authority on who is signed in, and the Nest guard has already verified the
-- session token before anything here is touched.

create table if not exists public.events (
  id          text        primary key,
  owner_id    text        not null,
  name        text        not null check (length(name) between 1 and 120),
  type        text        not null check (type in ('wedding', 'quinceanera', 'baptism', 'corporate', 'other')),
  event_date  date,
  location    text        not null default '' check (length(location) <= 160),
  guest_count integer     check (guest_count between 0 and 100000),
  created_at  timestamptz not null default now()
);

-- The dashboard only ever reads one owner's events, newest first.
create index if not exists events_owner_created_idx
  on public.events (owner_id, created_at desc);

-- Locked down with no policies on purpose. The server talks to this table with
-- the service role key, which bypasses RLS; anon and authenticated keys get
-- nothing, so a leaked publishable key cannot read anyone's events.
alter table public.events enable row level security;
