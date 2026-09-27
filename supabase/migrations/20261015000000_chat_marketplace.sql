-- Marketplace chat (Fiverr / Upwork style) on top of the chat tables:
-- offers (vendor_quotes) sent and accepted inside a thread, order milestones
-- posted as system lines, file attachments, per-person star/archive, vendor
-- response-time stats, and email alerts when the other side is offline.
-- Builds on 20261004…20261006 (chat) and 20261009 (vendor_orders).

-- ============================================================ messages

-- kind: text (default), offer (quote_id set; the card shows the quote's
-- state), system (an event in the thread: paid, fulfilled, refunded…) or
-- file (attachments only). attachments = [{ path, name, size, type }] in the
-- private chat-files bucket; the API signs URLs when the thread is read.
alter table public.chat_messages
  add column if not exists kind        text    not null default 'text'
    check (kind in ('text', 'offer', 'system', 'file')),
  add column if not exists attachments jsonb   not null default '[]'::jsonb,
  add column if not exists quote_id    uuid    references public.vendor_quotes (id) on delete set null,
  add column if not exists order_id    uuid    references public.vendor_orders (id) on delete set null,
  -- Set when the text looked like an attempt to move off Lazo (phone, email,
  -- WhatsApp link) before any paid order between the two. Shown to admins.
  add column if not exists flagged     boolean not null default false;

alter table public.chat_messages drop constraint if exists chat_messages_sender_role_check;
alter table public.chat_messages
  add constraint chat_messages_sender_role_check
  check (sender_role in ('customer', 'vendor', 'admin', 'host', 'guest', 'system'));

-- System lines can be empty-bodied offers; keep 1..4000 for humans only.
alter table public.chat_messages drop constraint if exists chat_messages_body_check;
alter table public.chat_messages
  add constraint chat_messages_body_check check (length(body) <= 4000 and (kind <> 'text' or length(body) >= 1));

create index if not exists chat_messages_quote_idx on public.chat_messages (quote_id) where quote_id is not null;
create index if not exists chat_messages_flagged_idx on public.chat_messages (conversation_id) where flagged;

-- ============================================================ per-person flags

-- conversation_reads is already one row per (conversation, person): the
-- natural place for what that person did with the thread.
alter table public.conversation_reads
  add column if not exists starred  boolean not null default false,
  add column if not exists archived boolean not null default false;

-- ============================================================ conversations

alter table public.conversations
  -- When the vendor first answered a host, and how long that took. Averaged
  -- per vendor into "Usually responds within …" on Find vendors.
  add column if not exists first_reply_at      timestamptz,
  add column if not exists first_reply_seconds integer check (first_reply_seconds >= 0),
  -- Last time an "unread message" email went out for this thread (one per 30 min at most).
  add column if not exists last_notified_at    timestamptz;

create index if not exists conversations_vendor_stats_idx
  on public.conversations (vendor_id, created_at desc) where kind = 'vendor';

-- ============================================================ quotes ↔ threads

-- An offer written inside a thread. accept / decline / withdraw / paid /
-- fulfilled post a system line back into that thread.
alter table public.vendor_quotes
  add column if not exists conversation_id uuid references public.conversations (id) on delete set null;

create index if not exists vendor_quotes_conversation_idx on public.vendor_quotes (conversation_id) where conversation_id is not null;

-- Storage: the API creates the private bucket `chat-files` on first upload
-- (10 MB per file; images and PDFs). Nothing to run here.
