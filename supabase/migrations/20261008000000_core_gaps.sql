-- PRD V1 core gaps: anonymous drafts with a claim token, invoices for paid
-- plans, the post-event flow (attendance, closing an event) and the seating
-- export. Idempotent; safe to re-run.

-- ============================================================ anonymous drafts
--
-- The details step of the create flow saves the answers before sign-up as an
-- events row in state 'anonymous_draft' (already in the state check). The
-- browser keeps a raw claim token; only its SHA-256 is stored. Claiming sets
-- the owner and moves the row to 'draft'. Unclaimed drafts expire after 30
-- days (DraftsService deletes expired rows when it meets them).

alter table public.events alter column owner_id drop not null;

alter table public.events
  add column if not exists claim_token_hash text,
  add column if not exists claim_expires_at timestamptz;

-- Only an anonymous draft may be ownerless.
alter table public.events drop constraint if exists events_owner_unless_anonymous;
alter table public.events
  add constraint events_owner_unless_anonymous
  check (owner_id is not null or state = 'anonymous_draft');

create index if not exists events_claim_expires_idx
  on public.events (claim_expires_at)
  where state = 'anonymous_draft';

-- ============================================================ post-event
--
-- Whether a guest actually came (host-marked on the day or after), and when the
-- host closed the event. 'closed' is not a lifecycle state on purpose: the site
-- must stay live after the event, so closing is a timestamp and RSVP checks it.

alter table public.guests
  add column if not exists attended boolean;

alter table public.events
  add column if not exists closed_at timestamptz;

-- ============================================================ invoices
--
-- The invoices table exists since 20260924100000_v1_backbone.sql (PAY-7, with
-- CFDI fields for a later PAC integration). This fills it with a Lazo-issued
-- receipt per succeeded event_fee payment: sequential number, line items and
-- the IVA shown as included. No CFDI stamping happens here (status 'issued'
-- means issued by Lazo, uuid_fiscal stays null until a PAC is integrated).

create sequence if not exists public.invoice_number_seq;

create or replace function public.lazo_invoice_number() returns text
language sql volatile as $$
  select 'LAZO-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0')
$$;

alter table public.invoices
  add column if not exists number            text unique default public.lazo_invoice_number(),
  add column if not exists owner_id          text not null default '',
  add column if not exists line_items        jsonb not null default '[]'::jsonb,
  add column if not exists subtotal_centavos bigint not null default 0 check (subtotal_centavos >= 0),
  -- IVA 16 %, included in the total (Mexico): total - total / 1.16.
  add column if not exists tax_centavos      bigint not null default 0 check (tax_centavos >= 0),
  add column if not exists tax_rate          numeric(5,4) not null default 0.16,
  add column if not exists gateway           text not null default '',
  add column if not exists gateway_reference text not null default '',
  add column if not exists razon_social      text not null default '' check (length(razon_social) <= 200),
  add column if not exists cfdi_uso          text not null default '' check (length(cfdi_uso) <= 8),
  add column if not exists updated_at        timestamptz not null default now();

-- One invoice per payment attempt (idempotent creation from confirm + webhook).
create unique index if not exists invoices_attempt_uidx
  on public.invoices (payment_attempt_id)
  where payment_attempt_id is not null;
create index if not exists invoices_owner_idx on public.invoices (owner_id, issued_at desc);
create index if not exists invoices_event_idx on public.invoices (event_id, issued_at desc);

-- Row-level security was enabled by the backbone migration; keep it so.
alter table public.invoices enable row level security;
