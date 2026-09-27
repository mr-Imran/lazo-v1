-- Corporate and memorial modes on the shared event engine (PRD EVT-3/4/5),
-- and the second event-fee gateway, Mercado Pago (PRD PAY-4/5/6).
--
-- 1. event_modes gets three configuration columns, read by GET /api/event-types:
--    vocabulary       { "es": {...}, "en": {...} }  labels the UI uses per mode
--    privacy_defaults { password_required, searchable, guest_uploads, show_guest_count }
--                     copied onto an event when it is created in that mode
--    sections         ordered section keys the public site renders for the mode
-- 2. events gets the privacy switches the defaults are copied into. Guest
--    uploads reuse the existing gallery_open column.
-- 3. condolences: remembrance messages guests leave on a memorial site,
--    moderated by the host before they show (EVT-4).
-- 4. payment_attempts gets refund columns; payment_gateways lists the
--    gateways on offer and which is the default.
--
-- Mode-specific site content (agenda, speakers, materials, life, condolences,
-- donations) lives as keys inside events.site_content (jsonb, from
-- 20261001000000_site_content.sql), validated by SiteContentService.

-- ============================================================ event modes

alter table public.event_modes
  add column if not exists vocabulary       jsonb not null default '{}'::jsonb,
  add column if not exists privacy_defaults jsonb not null default '{}'::jsonb,
  add column if not exists sections         jsonb not null default '[]'::jsonb;

alter table public.events
  add column if not exists password_required boolean not null default false,
  add column if not exists searchable        boolean not null default true,
  add column if not exists show_guest_count  boolean not null default true;

update public.event_modes set
  vocabulary = '{
    "es": {"guests":"Invitados","guest":"Invitado","rsvp":"Confirmar asistencia","ceremony":"Ceremonia","schedule":"Itinerario","gifts":"Mesa de regalos","story":"Nuestra historia","photos":"Galería","hosts":"Los novios","celebration":"boda"},
    "en": {"guests":"Guests","guest":"Guest","rsvp":"RSVP","ceremony":"Ceremony","schedule":"Schedule","gifts":"Registry","story":"Our story","photos":"Gallery","hosts":"The couple","celebration":"wedding"}
  }'::jsonb,
  privacy_defaults = '{"password_required":false,"searchable":true,"guest_uploads":true,"show_guest_count":true}'::jsonb,
  sections = '["hero","story","schedule","venue","registry","rsvp","photos"]'::jsonb
where value = 'boda';

update public.event_modes set
  vocabulary = '{
    "es": {"guests":"Invitados","guest":"Invitado","rsvp":"Confirmar asistencia","ceremony":"Ceremonia","schedule":"Itinerario","gifts":"Mesa de regalos","story":"Mi historia","photos":"Galería","hosts":"La quinceañera","celebration":"XV años"},
    "en": {"guests":"Guests","guest":"Guest","rsvp":"RSVP","ceremony":"Ceremony","schedule":"Schedule","gifts":"Registry","story":"My story","photos":"Gallery","hosts":"The quinceañera","celebration":"XV años"}
  }'::jsonb,
  privacy_defaults = '{"password_required":false,"searchable":true,"guest_uploads":true,"show_guest_count":true}'::jsonb,
  sections = '["hero","story","schedule","venue","registry","rsvp","photos"]'::jsonb
where value = 'xv';

update public.event_modes set
  vocabulary = '{
    "es": {"guests":"Invitados","guest":"Invitado","rsvp":"Confirmar asistencia","ceremony":"Ceremonia","schedule":"Programa","gifts":"Regalos","story":"Nuestra historia","photos":"Galería","hosts":"La familia","celebration":"bautizo"},
    "en": {"guests":"Guests","guest":"Guest","rsvp":"RSVP","ceremony":"Ceremony","schedule":"Program","gifts":"Gifts","story":"Our story","photos":"Gallery","hosts":"The family","celebration":"baptism"}
  }'::jsonb,
  -- Events involving minors default to private (EVT-5).
  privacy_defaults = '{"password_required":true,"searchable":false,"guest_uploads":true,"show_guest_count":true}'::jsonb,
  sections = '["hero","story","schedule","venue","registry","rsvp","photos"]'::jsonb
where value = 'bautizo';

update public.event_modes set
  vocabulary = '{
    "es": {"guests":"Invitados","guest":"Invitado","rsvp":"Confirmar asistencia","ceremony":"Ceremonia","schedule":"Programa","gifts":"Regalos","story":"Mi historia","photos":"Galería","hosts":"El graduado","celebration":"graduación"},
    "en": {"guests":"Guests","guest":"Guest","rsvp":"RSVP","ceremony":"Ceremony","schedule":"Program","gifts":"Gifts","story":"My story","photos":"Gallery","hosts":"The graduate","celebration":"graduation"}
  }'::jsonb,
  privacy_defaults = '{"password_required":false,"searchable":true,"guest_uploads":true,"show_guest_count":true}'::jsonb,
  sections = '["hero","story","schedule","venue","registry","rsvp","photos"]'::jsonb
where value = 'graduacion';

update public.event_modes set
  vocabulary = '{
    "es": {"guests":"Asistentes","guest":"Asistente","rsvp":"Registrarse","ceremony":"Programa","schedule":"Agenda","gifts":"Regalos","story":"Acerca del evento","photos":"Fotos","hosts":"Organizadores","celebration":"evento","agenda":"Agenda","speakers":"Ponentes","materials":"Materiales"},
    "en": {"guests":"Attendees","guest":"Attendee","rsvp":"Register","ceremony":"Program","schedule":"Agenda","gifts":"Gifts","story":"About the event","photos":"Photos","hosts":"Organizers","celebration":"event","agenda":"Agenda","speakers":"Speakers","materials":"Materials"}
  }'::jsonb,
  -- Password optional, guest uploads off, registry off (EVT-3).
  privacy_defaults = '{"password_required":false,"searchable":true,"guest_uploads":false,"show_guest_count":false}'::jsonb,
  sections = '["hero","agenda","speakers","venue","rsvp","materials"]'::jsonb
where value = 'corporate';

update public.event_modes set
  vocabulary = '{
    "es": {"guests":"Acompañantes","guest":"Acompañante","rsvp":"Confirmar asistencia","ceremony":"Servicio","schedule":"Servicio","gifts":"Donativos","story":"Su vida","photos":"Recuerdos","hosts":"La familia","celebration":"homenaje","life":"Su vida","service":"Servicio","condolences":"Mensajes de condolencia","donations":"En lugar de flores"},
    "en": {"guests":"Attendees","guest":"Attendee","rsvp":"Let us know you are coming","ceremony":"Service","schedule":"Service","gifts":"Donations","story":"Their life","photos":"Memories","hosts":"The family","celebration":"memorial","life":"Their life","service":"Service","condolences":"Messages of condolence","donations":"In lieu of flowers"}
  }'::jsonb,
  -- Private by default; messages and photos are moderated (EVT-4).
  privacy_defaults = '{"password_required":true,"searchable":false,"guest_uploads":false,"show_guest_count":false}'::jsonb,
  sections = '["hero","life","service","condolences","donations","photos"]'::jsonb
where value = 'memorial';

-- ============================================================ condolences

create table if not exists public.condolences (
  id          uuid        primary key default gen_random_uuid(),
  event_id    text        not null references public.events(id) on delete cascade,
  name        text        not null default '' check (length(name) <= 120),
  message     text        not null check (length(message) between 1 and 2000),
  approved    boolean     not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists condolences_event_idx on public.condolences (event_id, approved, created_at desc);
alter table public.condolences enable row level security;

-- ============================================================ payments

-- provider_reference stays the checkout object (Stripe session / MP preference);
-- gateway_payment_id is the settled payment (MP payment id; Stripe keeps its
-- PaymentIntent in stripe_payment_intent), the thing refunds and reconciliation key on.
alter table public.payment_attempts
  add column if not exists gateway_payment_id text,
  add column if not exists refunded_centavos  bigint not null default 0,
  add column if not exists refund_reference   text,
  add column if not exists refunded_at        timestamptz;
create index if not exists payment_attempts_gateway_payment_idx on public.payment_attempts (gateway, gateway_payment_id);

-- The event-fee gateways on offer. `configured` is decided at runtime from
-- env (STRIPE_SECRET_KEY, MERCADOPAGO_ACCESS_TOKEN); `is_default` is the one
-- the checkout uses when the host does not pick, unless PAYMENTS_DEFAULT_GATEWAY
-- is set. Which methods each gateway offers is data too.
create table if not exists public.payment_gateways (
  key        text        primary key check (key in ('stripe','mercadopago')),
  label      text        not null,
  methods    jsonb       not null default '[]'::jsonb,
  active     boolean     not null default true,
  is_default boolean     not null default false,
  position   integer     not null default 0,
  created_at timestamptz not null default now()
);
alter table public.payment_gateways enable row level security;

insert into public.payment_gateways (key, label, methods, is_default, position) values
  ('stripe',      'Stripe',       '["card","oxxo","spei"]'::jsonb,                        true,  10),
  ('mercadopago', 'Mercado Pago', '["card","oxxo","spei","mercadopago_balance"]'::jsonb, false, 20)
on conflict (key) do nothing;
