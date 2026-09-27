-- Chat: host ↔ vendor conversations (about one event), and support
-- conversations with Lazo. Admins can read every conversation and write in
-- any. The database is the source of truth; the API also appends each
-- message to JSONL files on the server (CHAT_LOG_DIR) for later AI training.

create table if not exists public.conversations (
  id               uuid        primary key default gen_random_uuid(),
  kind             text        not null check (kind in ('vendor','support')),
  event_id         text        references public.events(id) on delete cascade,
  vendor_id        uuid        references public.vendors(id) on delete cascade,
  -- The host (or, for support started by a vendor, the vendor's account).
  customer_id      text        not null,
  -- Denormalised from vendors.owner_id so a vendor's inbox is one query.
  vendor_owner_id  text,
  subject          text        not null default '' check (length(subject) <= 200),
  status           text        not null default 'open' check (status in ('open','closed')),
  last_message_at  timestamptz,
  last_preview     text        not null default '',
  message_count    integer     not null default 0,
  created_at       timestamptz not null default now(),
  check ((kind = 'vendor') = (vendor_id is not null))
);

-- One open thread per host, event and vendor.
create unique index if not exists conversations_vendor_open
  on public.conversations (customer_id, event_id, vendor_id) where kind = 'vendor' and status = 'open';
create index if not exists conversations_customer_idx on public.conversations (customer_id, last_message_at desc);
create index if not exists conversations_vendor_owner_idx on public.conversations (vendor_owner_id, last_message_at desc);
create index if not exists conversations_kind_idx on public.conversations (kind, status, last_message_at desc);
alter table public.conversations enable row level security;

create table if not exists public.chat_messages (
  id               uuid        primary key default gen_random_uuid(),
  conversation_id  uuid        not null references public.conversations(id) on delete cascade,
  sender_id        text        not null,
  sender_role      text        not null check (sender_role in ('customer','vendor','admin')),
  body             text        not null check (length(body) between 1 and 4000),
  created_at       timestamptz not null default now()
);
create index if not exists chat_messages_conv_idx on public.chat_messages (conversation_id, created_at);
alter table public.chat_messages enable row level security;

-- Where each participant has read up to; unread = messages after this by others.
create table if not exists public.conversation_reads (
  conversation_id  uuid        not null references public.conversations(id) on delete cascade,
  user_id          text        not null,
  last_read_at     timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
alter table public.conversation_reads enable row level security;
