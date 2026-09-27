-- Chat for everyone: signed-out visitors can chat with Lazo support, and
-- guests on an event site can chat with its hosts. Visitors are identified
-- by a browser token (customer_id 'visitor:<hash>'), never by an account.

alter table public.conversations drop constraint if exists conversations_kind_check;
alter table public.conversations
  add constraint conversations_kind_check check (kind in ('vendor','support','guest'));

alter table public.conversations drop constraint if exists conversations_check;
alter table public.conversations
  add constraint conversations_check check ((kind = 'vendor') = (vendor_id is not null));

alter table public.conversations
  -- For kind 'guest': the event owner, who answers.
  add column if not exists host_id       text,
  -- What a visitor or guest told us about themselves (optional).
  add column if not exists visitor_name  text not null default '' check (length(visitor_name) <= 120),
  add column if not exists visitor_email text not null default '' check (length(visitor_email) <= 200);

create index if not exists conversations_host_idx on public.conversations (host_id, last_message_at desc);

alter table public.chat_messages drop constraint if exists chat_messages_sender_role_check;
alter table public.chat_messages
  add constraint chat_messages_sender_role_check check (sender_role in ('customer','vendor','admin','host','guest'));
