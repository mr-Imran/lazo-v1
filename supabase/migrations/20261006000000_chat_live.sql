-- Live-chat details, tawk.to style: what the agent sees about a visitor,
-- canned replies, ratings, and who is handling a support thread.

alter table public.conversations
  -- The page the visitor was on when they last wrote, and their browser.
  add column if not exists visitor_page  text  not null default '' check (length(visitor_page) <= 500),
  add column if not exists visitor_meta  jsonb not null default '{}'::jsonb,
  -- 1–5 from the customer/guest after the chat, with an optional note.
  add column if not exists rating        integer check (rating between 1 and 5),
  add column if not exists rating_note   text  not null default '' check (length(rating_note) <= 600),
  add column if not exists rated_at      timestamptz,
  -- Admin who picked up a support thread (their Clerk id), if any.
  add column if not exists assigned_to   text;

-- Canned replies. owner_id null = shared by every admin; otherwise a vendor's own.
create table if not exists public.chat_shortcuts (
  id         uuid        primary key default gen_random_uuid(),
  owner_id   text,
  shortcut   text        not null check (shortcut ~ '^[a-z0-9_-]{1,30}$'),
  body       text        not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create unique index if not exists chat_shortcuts_owner_key on public.chat_shortcuts (coalesce(owner_id, ''), shortcut);
alter table public.chat_shortcuts enable row level security;
