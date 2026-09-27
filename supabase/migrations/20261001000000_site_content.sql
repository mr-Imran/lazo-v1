-- Site builder steps Story, Gift, Invitation and Go Live.
--
-- events.site_content holds the host's words and choices for the public site,
-- validated by the API (SiteContentService):
--   story      { title, body, photoUrl }
--   faq        [{ q, a }]
--   stay       [{ name, address, url, phone, note }]       ("Where to stay")
--   invitation { message, closing }
--   gifts      { note, bank: { holder, bank, clabe, reference } }
-- Photos are uploaded to the public event-media bucket (created on first upload).
--
-- Password-protected sites: site_password_hash is a scrypt hash; the public
-- API asks for the password before returning anything.
--
-- Gifts guests tell the hosts about (a bank transfer, a store purchase) are
-- rows in public.gifts with status 'pending' and source 'guest_report', so they
-- are never mistaken for money that moved through a payment provider (PAY-2).

alter table public.events
  add column if not exists site_content       jsonb not null default '{}'::jsonb,
  add column if not exists site_password_hash text;

alter table public.gifts
  add column if not exists source text not null default 'payment'
    check (source in ('payment', 'guest_report'));

-- One store purchase report per registry item is enough to take it off the list.
create index if not exists gifts_item_idx on public.gifts (registry_item_id) where registry_item_id is not null;
