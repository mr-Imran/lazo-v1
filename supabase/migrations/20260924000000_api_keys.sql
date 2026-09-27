-- API keys, so a client can call the API without a browser session.
--
-- A key belongs to a Clerk user and acts as that user: requests authenticated
-- with it see exactly the same events the owner would. Only the SHA-256 hash is
-- stored, so a leaked database does not hand over working credentials.

create table if not exists public.api_keys (
  id           uuid        primary key default gen_random_uuid(),
  owner_id     text        not null,
  name         text        not null check (length(name) between 1 and 80),
  -- The public half of the key: enough to find the row, useless on its own.
  prefix       text        not null unique,
  -- SHA-256 of the full key, hex. Not bcrypt on purpose: the secret is 32
  -- bytes of CSPRNG output, so there is nothing to brute-force, and this is
  -- checked on every request.
  hash         text        not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- Every request with a key looks the row up by prefix.
create index if not exists api_keys_prefix_idx on public.api_keys (prefix);
-- The management page lists one owner's keys, newest first.
create index if not exists api_keys_owner_created_idx
  on public.api_keys (owner_id, created_at desc);

-- Same posture as public.events: the server holds the secret key and bypasses
-- RLS, so anon and publishable keys get nothing.
alter table public.api_keys enable row level security;
