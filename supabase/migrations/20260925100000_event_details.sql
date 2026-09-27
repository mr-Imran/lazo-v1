-- Occasion-specific details (names of the couple, the quinceañera, the
-- graduate…) and the rules that turn them into an event name and a subdomain.
--
-- event_modes.fields is the form the create flow shows for that occasion:
--   [{ "key": "partner1", "label": "Bride's first name", "required": true, "maxLength": 40 }, …]
-- event_modes.name_template / slug_template use {key} placeholders:
--   "{partner1} & {partner2} wedding"  →  "Rajib & Jerin wedding"
--   "{partner1}-{partner2}"            →  rajib-jerin.<SITE_DOMAIN>
-- Edit these rows to change the form or the generated names; no deploy needed.

alter table public.event_modes
  add column if not exists fields        jsonb not null default '[]'::jsonb,
  add column if not exists name_template text,
  add column if not exists slug_template text;

-- The answers, keyed by field key. Validated by the API against the mode's fields.
alter table public.events
  add column if not exists details jsonb not null default '{}'::jsonb;

update public.event_modes set
  fields = '[
    {"key":"partner1","label":"Bride''s first name","required":true,"maxLength":40},
    {"key":"partner2","label":"Groom''s first name","required":true,"maxLength":40}
  ]'::jsonb,
  name_template = '{partner1} & {partner2} wedding',
  slug_template = '{partner1}-{partner2}'
where value = 'boda';

update public.event_modes set
  fields = '[
    {"key":"honoree","label":"Quinceañera''s first name","required":true,"maxLength":40}
  ]'::jsonb,
  name_template = '{honoree}''s XV Años',
  slug_template = '{honoree}-xv'
where value = 'xv';

update public.event_modes set
  fields = '[
    {"key":"honoree","label":"Baby''s first name","required":true,"maxLength":40},
    {"key":"parents","label":"Parents'' names","required":false,"maxLength":80}
  ]'::jsonb,
  name_template = '{honoree}''s baptism',
  slug_template = '{honoree}-bautizo'
where value = 'bautizo';

update public.event_modes set
  fields = '[
    {"key":"honoree","label":"Graduate''s first name","required":true,"maxLength":40},
    {"key":"school","label":"School or university","required":false,"maxLength":80}
  ]'::jsonb,
  name_template = '{honoree}''s graduation',
  slug_template = '{honoree}-graduacion'
where value = 'graduacion';

update public.event_modes set
  fields = '[
    {"key":"company","label":"Company name","required":true,"maxLength":60},
    {"key":"event_name","label":"Event name","required":true,"maxLength":60}
  ]'::jsonb,
  name_template = '{event_name}',
  slug_template = '{company}-{event_name}'
where value = 'corporate';

update public.event_modes set
  fields = '[
    {"key":"honoree","label":"Name of your loved one","required":true,"maxLength":60}
  ]'::jsonb,
  name_template = 'In memory of {honoree}',
  slug_template = '{honoree}-memorial'
where value = 'memorial';
