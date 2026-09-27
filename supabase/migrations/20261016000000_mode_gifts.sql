-- Per-occasion gift guidance. The Gift step used to talk about honeymoons and
-- stand mixers for every occasion; a baby shower should suggest baby things.
-- Configuration lives on the mode row (like fields, vocabulary and sections),
-- so the copy and the store-search ideas are a row change, not a deploy.
--
-- Shape of event_modes.gifts:
-- {
--   "hint":         one line under "Your registry",
--   "fundLabel":    what a cash fund is for ("Cash fund for the nursery"),
--   "fundExample":  placeholder for a fund name,
--   "itemExample":  placeholder for a store gift name,
--   "searchIdeas":  chips shown in "Search a store"; clicking one runs that search
-- }

alter table public.event_modes
  add column if not exists gifts jsonb not null default '{}'::jsonb;

update public.event_modes set gifts = '{
  "hint": "Link gifts from any store, or add a cash fund for your honeymoon or new home.",
  "fundLabel": "Cash fund",
  "fundExample": "e.g. Honeymoon in Oaxaca",
  "itemExample": "e.g. KitchenAid stand mixer",
  "searchIdeas": ["batidora KitchenAid", "vajilla", "juego de sábanas", "cafetera", "maletas", "licuadora"]
}'::jsonb
where value = 'boda' and gifts = '{}'::jsonb;

update public.event_modes set gifts = '{
  "hint": "Link baby gifts from any store, or add a cash fund for the nursery, diapers or the first months.",
  "fundLabel": "Cash fund for the baby",
  "fundExample": "e.g. Fondo para pañales",
  "itemExample": "e.g. Carriola Chicco",
  "searchIdeas": ["carriola", "cuna", "pañalera", "monitor para bebé", "silla para auto bebé", "pañales", "mamilas", "ropa bebé recién nacido"]
}'::jsonb
where value = 'baby_shower' and gifts = '{}'::jsonb;

update public.event_modes set gifts = '{
  "hint": "Link gifts from any store, or add a cash fund.",
  "fundLabel": "Cash fund",
  "fundExample": "e.g. Viaje de XV",
  "itemExample": "e.g. Audífonos",
  "searchIdeas": ["audífonos", "cámara instantánea", "maleta", "perfume"]
}'::jsonb
where value in ('xv', 'graduacion') and gifts = '{}'::jsonb;

update public.event_modes set gifts = '{
  "hint": "Link gifts from any store, or add a cash fund for the baby.",
  "fundLabel": "Cash fund for the baby",
  "fundExample": "e.g. Fondo para el bebé",
  "itemExample": "e.g. Ropón de bautizo",
  "searchIdeas": ["ropón bautizo", "cuna", "cobija bebé", "juguetes bebé"]
}'::jsonb
where value = 'bautizo' and gifts = '{}'::jsonb;
