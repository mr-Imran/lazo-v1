-- Product focus (decided 2026-09-26): Lazo launches with two occasions only,
-- Wedding and Baby Shower. The other modes stay in the table (existing events
-- keep their mode, the foreign key still holds) but are hidden from the picker,
-- the homepage cards and the theme filters by active = false. Re-activating one
-- later is a row change.

-- ============================================================ baby shower

insert into public.event_modes (value, label, position, active, description, fields, name_template, slug_template)
values (
  'baby_shower',
  'Baby Shower',
  20,
  true,
  'Games, gifts and brunch, with a registry and RSVPs by family.',
  '[
    {"key":"parent1","label":"Mom''s first name","required":true,"maxLength":40},
    {"key":"parent2","label":"Partner''s first name","required":false,"maxLength":40},
    {"key":"baby","label":"Baby''s name (if chosen)","required":false,"maxLength":40}
  ]'::jsonb,
  '{parent1}''s baby shower',
  '{parent1}-babyshower'
)
on conflict (value) do update set
  label = excluded.label,
  position = excluded.position,
  active = true;

-- Fill the later-added configuration only where it is still empty, so edits
-- made in the dashboard survive a re-run.
update public.event_modes set
  fields = '[
    {"key":"parent1","label":"Mom''s first name","required":true,"maxLength":40},
    {"key":"parent2","label":"Partner''s first name","required":false,"maxLength":40},
    {"key":"baby","label":"Baby''s name (if chosen)","required":false,"maxLength":40}
  ]'::jsonb,
  name_template = '{parent1}''s baby shower',
  slug_template = '{parent1}-babyshower'
where value = 'baby_shower' and (fields = '[]'::jsonb or name_template is null);

update public.event_modes set
  description = 'Games, gifts and brunch, with a registry and RSVPs by family.'
where value = 'baby_shower' and description = '';

update public.event_modes set
  family_title = 'Together with Our Family',
  family_sections = '[
    {"key":"family","title":"The Family","nameKey":"parent1","nameLabel":"Mom''s name"}
  ]'::jsonb
where value = 'baby_shower' and family_sections = '[]'::jsonb;

update public.event_modes set
  vocabulary = '{
    "es": {"guests":"Invitados","guest":"Invitado","rsvp":"Confirmar asistencia","ceremony":"Celebración","schedule":"Programa","gifts":"Mesa de regalos","story":"Nuestra historia","photos":"Galería","hosts":"Los papás","celebration":"baby shower"},
    "en": {"guests":"Guests","guest":"Guest","rsvp":"RSVP","ceremony":"Celebration","schedule":"Program","gifts":"Registry","story":"Our story","photos":"Gallery","hosts":"The parents","celebration":"baby shower"}
  }'::jsonb,
  privacy_defaults = '{"password_required":false,"searchable":true,"guest_uploads":true,"show_guest_count":true}'::jsonb,
  sections = '["hero","story","schedule","venue","registry","rsvp","photos"]'::jsonb
where value = 'baby_shower' and (vocabulary is null or vocabulary = '{}'::jsonb);

-- Celebrations a baby shower can have. The generic kinds (brindis, other) have
-- modes = '{}' and already apply to every occasion.
insert into public.sub_event_kinds (value, label, modes, position) values
  ('baby_shower', 'Baby Shower', '{baby_shower}', 10),
  ('brunch',      'Brunch',      '{baby_shower}', 20),
  ('juegos',      'Games',       '{baby_shower}', 30)
on conflict (value) do nothing;

-- ============================================================ hide the rest

update public.event_modes set active = false
where value in ('xv', 'bautizo', 'graduacion', 'corporate', 'memorial');

update public.event_modes set active = true, position = 10 where value = 'boda';
