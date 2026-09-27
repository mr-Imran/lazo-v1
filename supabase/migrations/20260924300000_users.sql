-- A local mirror of Clerk users.
--
-- Clerk stays the source of truth for identity (passwords, codes, OAuth,
-- sessions). This table is a copy so the database can join, filter and report
-- on people without calling Clerk per row. It is written two ways:
--   * POST /api/users/me/sync — the frontend calls it right after sign-in or
--     sign-up; the server re-reads the user from Clerk's Backend API, so a
--     client can never write its own profile fields here.
--   * POST /api/webhooks/clerk — user.created / user.updated / user.deleted,
--     so changes made in Clerk (dashboard, profile edits) land here too.

create table if not exists public.users (
  id               text        primary key,          -- Clerk user id (user_...)
  email            text,
  email_verified   boolean     not null default false,
  first_name       text,
  last_name        text,
  image_url        text,
  clerk_created_at timestamptz,
  last_sign_in_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists users_email_idx on public.users (lower(email));

-- Same convention as every other table: RLS on, no policies, server-only access.
alter table public.users enable row level security;
