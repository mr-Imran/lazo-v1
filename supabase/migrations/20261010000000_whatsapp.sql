-- WhatsApp Business Cloud API (PRD 6.4, WA-1..WA-3): template definitions
-- with their Meta review status, per-household consent, and provider
-- delivery status on message_deliveries.

-- ============================================================ templates

-- One row per template we submit to Meta. body is the text with {{1}}..{{n}}
-- placeholders; params says what fills each one, in order, from a fixed
-- vocabulary the server knows (guest_name, event_name, event_date, rsvp_url,
-- invite_code, venue) or a key the host types into "values" when sending.
-- sample_params is what Meta's reviewers see as example text; it is never
-- sent to a guest. status mirrors Meta's; nothing here is approved until the
-- sync says so.
create table if not exists public.whatsapp_templates (
  id               uuid        primary key default gen_random_uuid(),
  name             text        not null check (name ~ '^[a-z0-9_]+$' and char_length(name) <= 512),
  language         text        not null default 'es_MX',
  category         text        not null default 'UTILITY' check (category in ('UTILITY','MARKETING')),
  body             text        not null check (length(body) between 1 and 1024),
  params           jsonb       not null default '[]'::jsonb,
  sample_params    jsonb       not null default '[]'::jsonb,
  status           text        not null default 'pending'
    check (status in ('pending','approved','rejected','paused')),
  meta_template_id text        not null default '',
  rejected_reason  text        not null default '',
  synced_at        timestamptz,
  submitted_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (name, language)
);
alter table public.whatsapp_templates enable row level security;

-- Definitions to submit (status pending). They become usable only after Meta
-- approves them and "Sync from Meta" records that.
insert into public.whatsapp_templates (name, language, category, body, params, sample_params) values
  ('lazo_invitation', 'es_MX', 'UTILITY',
   'Hola {{1}}, tienes una invitación a {{2}} el {{3}}. Confirma tu asistencia y consulta los detalles aquí: {{4}}',
   '["guest_name","event_name","event_date","rsvp_url"]',
   '["Familia García","la boda de Ana y Luis","14 de febrero de 2027","https://ana-y-luis.lazo.mx/?rsvp=ABCD12"]'),
  ('lazo_reminder', 'es_MX', 'UTILITY',
   'Hola {{1}}, aún no recibimos tu confirmación para {{2}} ({{3}}). ¿Nos acompañas? Responde aquí: {{4}}',
   '["guest_name","event_name","event_date","rsvp_url"]',
   '["Familia García","la boda de Ana y Luis","14 de febrero de 2027","https://ana-y-luis.lazo.mx/?rsvp=ABCD12"]')
on conflict (name, language) do nothing;

-- ============================================================ consent

-- WA-1: sends go only to households that said yes (on the RSVP form, by the
-- host, or on import) and have not replied STOP/BAJA/ALTO since.
alter table public.households
  add column if not exists whatsapp_consent        boolean     not null default false,
  add column if not exists whatsapp_consent_at     timestamptz,
  add column if not exists whatsapp_consent_source text        not null default ''
    check (whatsapp_consent_source in ('', 'rsvp_form', 'host', 'import')),
  add column if not exists whatsapp_opted_out_at   timestamptz;

-- ============================================================ deliveries

-- WA-2: Meta's own status per message id, updated by the webhook.
alter table public.message_deliveries
  add column if not exists wa_message_id text,
  add column if not exists wa_status     text check (wa_status in ('accepted','sent','delivered','read','failed')),
  add column if not exists wa_error_code integer,
  add column if not exists wa_error_title text not null default '',
  add column if not exists wa_status_at  timestamptz;
create index if not exists message_deliveries_wa_message_idx on public.message_deliveries (wa_message_id);

-- Campaign rows can now be WhatsApp template sends.
alter table public.messages drop constraint if exists messages_channel_check;
alter table public.messages add constraint messages_channel_check check (channel in ('email','sms','whatsapp'));
alter table public.messages
  add column if not exists template_id uuid references public.whatsapp_templates(id) on delete set null;
