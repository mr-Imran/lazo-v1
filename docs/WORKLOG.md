# LAZO — work log

What has been built, how the pieces fit, what's set up, and what's still open.
Newest session first. API details live in [API.md](API.md); this file is the
map and the history.

---

## Status at a glance (end of 2026-09-26)

| Area | State |
|---|---|
| Create flow (occasion → details → sign-up → build choice → theme → dashboard) | Built, working |
| Auth (Clerk) + user mirror in Supabase | Built, working |
| Host dashboard (frontend `/dashboard`) | Built |
| Event sites on subdomains (`<slug>.localhost:5173`) | Built; one theme ("Red Theme") |
| Backend admin dashboard (`localhost:3000/dashboard`) | Built: events, sites, users, custom requests, themes, vendors |
| Vendor marketplace (vendor dashboard, admin approval, host picks) | Built, migration applied |
| Lazo's own products (affiliate links with scraping, or direct price) | Built, migration applied |
| RSVP, guest list, site builder, planning, messaging, photos, seating, chat, plan payments (Stripe) | Built, **migrations `20260930…20261007` not applied yet** |
| Anonymous drafts + claim, invoices (no CFDI), post-event flow, PWA, seating export | Built (A), **`20261008` not applied** |
| Vendor payments: Stripe Connect quotes → orders → refunds/disputes, reconciliation | Built (B), **`20261009` not applied**; needs Connect enabled + webhooks |
| WhatsApp Business Cloud API (consent, templates, sends, webhook) | Built (C), **`20261010` not applied**; needs Meta WABA + template approval |
| Retailer catalogs (Amazon PA-API, Mercado Libre) + print/flowers/travel partners | Built (D), **`20261011` not applied**; needs API creds + contracted partners |
| Corporate & memorial modes (sections, vocabulary, privacy, condolences) + Mercado Pago gateway | Built (E), **`20261012` not applied**; needs MP credentials |
| Analytics warehouse (`analytics` schema, scheduled ingest, revenue reconciliation) | Built (F), **`20261013` not applied**; needs `DATABASE_URL` |
| Marketplace chat (offers in the thread, order milestones, attachments, star/archive/search, response-time badges, contact guard, offline email alerts) | Built, **`20261015` not applied** |
| Launch occasions | **Wedding and Baby Shower only** (2026-09-26); other modes inactive after `20261014` |

**Migrations** (`lazobackend/supabase/migrations/`, run in the Supabase SQL editor, in order):

| File | Applied |
|---|---|
| `20260923000000_events.sql` | yes |
| `20260924000000_api_keys.sql` | yes |
| `20260924100000_v1_backbone.sql` | yes |
| `20260924200000_event_modes.sql` | yes |
| `20260924300000_users.sql` | yes |
| `20260925000000_website_builder.sql` | yes |
| `20260925100000_event_details.sql` | yes |
| `20260926000000_vendor_marketplace.sql` | yes (checked 2026-09-25) |
| `20260927000000_lazo_products.sql` | yes (checked 2026-09-25) |
| `20260928000000_homepage.sql` | yes (images seeded) |
| `20260929000000_event_info.sql` | yes (checked 2026-09-25) |
| `20260930000000_guests_rsvp.sql` | **no** |
| `20261001000000_site_content.sql` | **no** |
| `20261002000000_planning.sql` | **no** |
| `20261003000000_tiers_messaging_photos.sql` | **no** |
| `20261004000000_chat.sql` | **no** |
| `20261005000000_chat_everyone.sql` | **no** |
| `20261006000000_chat_live.sql` | not recorded here before; check `npm run db:status` |
| `20261007000000_payment_stripe_amounts.sql` | **no** (2026-09-26, no DATABASE_URL locally) |
| `20261008000000_core_gaps.sql` | **no** |
| `20261009000000_vendor_orders.sql` | **no** |
| `20261010000000_whatsapp.sql` | **no** |
| `20261011000000_retailers_fulfilment.sql` | **no** |
| `20261012000000_modes_mercadopago.sql` | **no** |
| `20261013000000_analytics_warehouse.sql` | **no** (creates schema `analytics`; keep it out of PostgREST's exposed schemas) |
| `20261014000000_focus_wedding_babyshower.sql` | **no** (adds Baby Shower, deactivates XV/baptism/graduation/corporate/memorial) |
| `20261016000000_mode_gifts.sql` | **no** (gift copy and search ideas per occasion) |
| `20261017000000_abuse_limits.sql` | **no** (send caps, refund_pending + reserve/settle functions, vendor_refunds.idempotency_key) |
| `20261015000000_chat_marketplace.sql` | **no** (needs `20261004…06` chat and `20261009` vendor_orders first) |

**Automatic migrations** (from 2026-09-25): `npm run db:migrate` applies pending files and records them in `public.schema_migrations`. `npm run db:status` lists them, and `npm run serve` migrates before starting.
- It needs `DATABASE_URL` in `lazobackend/.env` (Supabase → Project Settings → Database → Connection string → Session pooler). Without it, `serve` skips migrating with a warning.
- On its first run against this database it records everything up to `20260929000000_event_info.sql` as already applied (override with `MIGRATE_BASELINE`), then applies the rest.
- Every migration so far is idempotent, so re-running one is harmless.

Checked against the live database on 2026-09-24.

**Needs attention**

- ~~Leaked `lazo_sk_` key in `lazofrontend/.env.local`~~ — **fixed 2026-09-25**: removed, key `LAZOFRONTv1` revoked, bundle rebuilt and scanned clean.
- **Nothing from this session is committed.** `lazobackend` has only its first two commits and today's files are untracked; `lazofrontend` is not a git repository at all.
- `lazobackend/LAZO_PRD_v1.2 (1).pdf` is an empty file (0 bytes). Vendor scope was taken from `LAZO_Comprehensive_Business_Plan_2026.pdf` instead.

---

## How it fits together

```
lazofrontend (React 19 + Vite, :5173)          lazobackend (NestJS 12, :3000)          Supabase (Postgres + Storage)
  app at localhost:5173  ──── /api (Vite proxy) ──▶  REST API  ─── secret key ──▶  tables, RLS on, no policies
  event sites at <slug>.localhost:5173               admin dashboard at /dashboard        buckets: theme-previews, vendor-media
  Clerk (custom UI, @clerk/react 6)  ─── session token ──▶ ClerkAuthGuard + RolesGuard
```

- **Clerk owns identity**: passwords, email codes, Google/Apple, sessions, password reset. The backend only verifies Clerk sessions. `public.users` is a mirror, synced by `POST /api/users/me/sync` after every sign-in (the server re-reads Clerk) and optionally by the Clerk webhook.
- **Admin role** comes from Clerk user metadata `{"role": "admin"}`. Admin today: `nu.imran.2000.bd@gmail.com`. The `+1` account and `webxcloud.bd@gmail.com` are planners.
- **All data is real.** No mock or placeholder data anywhere. Lists come from tables; empty tables show empty states. Keep it that way.
- **Configuration that is data lives in tables**, so it changes without a deploy: occasions and their form fields and name/subdomain templates (`event_modes`), themes (`themes`), prices (`services`).
- **The create flow's progress lives on the event row** (`state = 'draft'`), addressed by `/start/:eventId/...`, so reloads and other devices resume it.

### Environment

`lazobackend/.env` (see `.env.example` for all of them):

| Variable | Notes |
|---|---|
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk dev instance `handy-sloth-7786.clerk.accounts.dev` |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Server-only; bypasses RLS |
| `API_ENCRYPTION_KEY`, `API_ENCRYPTION_MODE=optional` | Optional payload encryption. Multipart uploads fail if set to `required` |
| `SITE_DOMAIN=localhost:5173` | Event sites are served **by the frontend** at `<slug>.<SITE_DOMAIN>`; `*.localhost` needs no DNS |
| `CORS_ORIGINS` | Optional; defaults to `localhost:5173,4173`. Site subdomains are allowed automatically |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Optional; not set. Only needed for `POST /api/webhooks/clerk` |

`lazofrontend/.env.local`: `VITE_API_URL=http://localhost:3000`. In dev, Vite proxies `/api`, so no CORS is involved.

Clerk instance settings that shape the UI (read live via `GET /api/auth/config`): Google and Apple on; Facebook and enterprise SSO off; email + password with email-code verification; **minimum password length 15**.

### Run it

```bash
cd lazofrontend && npm run dev           # :5173, app; event sites at <slug>.localhost:5173

# API, kept alive by PM2 (restarts on crash / memory leak, back after logon):
cd lazobackend && npm run serve          # build + start or reload `lazo-api` under PM2, then pm2 save
npm run serve:status                     # up? restarts, memory, uptime
npm run serve:logs                       # follow logs (files in lazobackend/logs, rotated 10 MB x 14)
npm run serve:stop                       # stop it

# Or, while editing backend code (auto-reload, but no crash restart):
cd lazobackend && npm run start:dev      # don't run both: they share port 3000
```

**Keeping the API up** (added 2026-09-25):
- PM2 (`npm i -g pm2`, config `lazobackend/ecosystem.config.cjs`): restarts on crash with exponential backoff, restarts above 700 MB, gives 10 s for a graceful shutdown. A crash-and-recover was tested (killed process → back in about 3 s).
- The app itself: unhandled promise rejections are logged, not fatal; an uncaught exception exits so PM2 starts a clean process; a failed start (e.g. port taken) exits and is retried; `enableShutdownHooks()` is on.
- After a reboot: the scheduled task **"LAZO API (PM2 resurrect)"** (per user, at logon, after 20 s) runs `pm2 resurrect`. Install or remove it with `lazobackend/scripts/install-autostart.ps1` (`-Remove`). It restores whatever `pm2 save` recorded, and `npm run serve` saves.
- `GET /api/health` returns 200 `{status:"ok", database:"ok"}`, or 503 when the database doesn't answer. Point an uptime monitor at it.

---

## Session 2026-09-27: lazoAI (monitor, security scan, training) and the frontend↔backend link

**How the link works today.** Dev: Vite proxies `/api` → `VITE_API_URL || http://localhost:3000` (`vite.config.js`), so the app is same-origin and `config.apiBase` is empty. Production build: the app calls `VITE_API_URL` directly, so its origin must be in `CORS_ORIGINS`. `apiFetch` maps a refused connection to `ApiError(0, "Could not reach the server…")`; through the dev proxy a dead API surfaces as HTTP 500 from Vite ("Request failed (500)"). There is no global offline banner or retry: each page shows its own error. **If the API falls:** PM2 (`npm run serve`) restarts it with backoff and after reboot, but at the time of writing the API was running under `start:dev`, not PM2. `/api/health` returns 503 when the database is down.

**`lazoai/` (new, Python 3.14 + Flask, port 5050).** `python run.py`, config in `lazoai/.env` (falls back to `lazobackend/.env` for `DATABASE_URL`). Local SQLite `lazoai/data/lazoai.db` holds probes, incidents, findings and training runs (operational telemetry, not product data).
- Monitor: every 30 s probes the API health, the Vite server, the dev-proxy path, the CORS path, Postgres (read-only session) and Clerk config; opens/closes incidents; diagnoses a dead API (port vs PM2 state); `LAZOAI_AUTO_RESTART=1` runs `pm2 restart lazo-api`; a Restart button does it on demand.
- Security: live (headers, CORS reflection, anonymous access to 8 protected routes, stack-trace leaks, API bound to 0.0.0.0, public dashboard shell) and static (`VITE_` secrets, bare tokens in `.env` comments, gitignore, `npm audit` both projects, risky source patterns, hardening wired in `main.ts`, `@Public()` inventory). First scan found: a bare credential-looking token in a comment at `lazobackend/.env:6` (delete/rotate), 2 high + 1 moderate npm advisories in the backend (`undici`, `tmp`, `inquirer`…), the API listening on all interfaces, `API_ENCRYPTION_MODE=optional`, no CSP on API responses, 49 `@Public()` handlers across 21 controllers. CORS, auth guards and error hiding all passed.
- Training (real rows only): `chat_guard` (message → flagged), `chat_kind` (first message → conversation kind), `vendor_dept` (vendor text → department); TF-IDF + logistic regression, needs ≥30 rows and ≥5 per class, otherwise the run is recorded as *skipped* with the counts. Today: 19 messages / 0 flagged, 4 support conversations, 1 vendor → nothing trainable yet. JSONL export of chats with hashed ids for LLM fine-tuning.
- Agent: rule-based assessment with prioritised actions; optional written answer through Claude Opus 5 when `ANTHROPIC_API_KEY` is set in `lazoai/.env`.

---

## Session 2026-09-26: admin dashboard redesign

`public/dashboard.html` only; the sections' JavaScript and every API call are unchanged (they render the same class names).
- **Tokens + dark mode.** All colours are `:root` variables; dark follows the system, and the moon button in the sidebar footer cycles light → dark → system (`localStorage` `lazo-admin-theme`, per browser).
- **Shell.** Sticky sidebar with the 20 sections grouped (Workspace, Operations, Marketplace, Content, Insights; any new key not listed lands in "More"), avatar + role, unread-chat badge on Chats (same count as the tab title). Sticky, blurred page header. Below 960px the sidebar is a drawer (menu button, scrim, Esc).
- **Pieces.** Tiles with a side accent, sticky table headers, row actions as quiet chips, underlined subtabs, segmented control, inputs with focus rings, warm `pill-bad` for restricted/disputed, chat list rows and message bubbles as classes (`chat-item`, `bubble admin|offer|flagged`) instead of hard-coded colours.
- Verified in headless Chrome (light, dark, 500px). Not done: the ~100 small inline `style=""` snippets inside section renderers still exist (spacing only, no colours), so they are theme-safe.

---

## Session 2026-09-26: vendors paid through Lazo's own Stripe (no Connect)

Changed the vendor-payment model at the founder's direction. Before: each vendor onboarded a Stripe Connect Express account and hosts paid by destination charge with an application fee. Now: hosts pay vendor quotes **into Lazo's own Stripe account** (the same account as plan fees), Lazo keeps its commission and settles the net with each vendor out of band. Vendors set up nothing.
- **Checkout** (`vendor-orders.service.ts`): dropped the vendor `stripe_account_id`/`charges_enabled` requirement and the `application_fee_amount` + `transfer_data.destination`; the PaymentIntent is a plain charge on Lazo's account. Commission is still stored per order (`platform_fee_centavos`) as what Lazo keeps.
- **Refunds**: plain refunds on Lazo's account (removed `reverse_transfer` / `refund_application_fee`).
- **Vendor dashboard → Payments** now shows earnings, not onboarding: total received through Lazo, Lazo's commission, net owed to the vendor, and a per-order table with the Stripe receipt. New `GET /api/vendor/payments` shape `{ configured, summary: { totals, orders, currency } }`; removed `POST /api/vendor/payments/onboard` and `/dashboard-link`. Frontend `VendorPayments.jsx` rewritten.
- **Webhook**: vendor-order events now arrive on Lazo's main account. Both `/api/webhooks/stripe` (plans) and `/api/webhooks/stripe-connect` (vendor orders) may receive each other's events; verified each ignores the other's (plan handler needs `attemptId`, vendor handler needs `flow==='vendor_order'`), and they dedupe in separate tables. The Connect `account.updated` endpoint is no longer needed; `.env.example` updated.
- Unused Connect columns on `vendors` (`stripe_account_id`, `charges_enabled`, `payouts_enabled`, `stripe_onboarding_status`) are left in place (no destructive drop); onboarding methods removed from `vendor-connect.service.ts` (kept `syncAccount` for webhook safety).
- Not changed: the admin Vendor-orders settlement view still totals gross, commission, refunds and net-to-vendors correctly; it just no longer needs the Connect columns. No migration, no new env var. Left open: an admin "mark vendor paid out" step to track settlement (today net-owed is shown but payouts are tracked outside Lazo).

## Session 2026-09-26: second security pass

A second read-only audit re-verified the earlier fixes (all hold) and found three more:
- **Cross-tenant write in the dynamic API (HIGH).** `PATCH /api/v1/<event-scoped resource>` accepted `event_id` in the body; the update matched on the old event_id but set the new one, moving the row into another host's event (e.g. planting a cash-fund registry item that redirects guests to an attacker URL on a victim's public site). Fixed in `dynamic.service.ts` `update()`: the scope column (`event_id`/`owner_id`) is now stripped from every update body, so a row can never change owner. Create still takes it from the body (event) or session (owner).
- **Rate-limit path bypass (MEDIUM).** Express routes case-insensitively and ignores a trailing slash, but the limiter's regexes were anchored and case-sensitive, so `/retailers/x/SEARCH` or `/search/` skipped the per-user rule and fell through to the loose global limit (paid retailer API abuse, transcript email abuse). `http-hardening.ts` now matches rules against a lowercased, trailing-slash-trimmed path.
- **SSRF via redirect in the partner webhook (MEDIUM).** `partner-notify.ts` validated the webhook host but then followed redirects, so a partner endpoint could 302 to `169.254.169.254`. Now `redirect: 'manual'` and a 3xx is rejected.

Backend `tsc` clean (pre-existing e2e-spec error only), `nest build` ok. No migration or env change.

Lower-risk items left for a product decision (documented in the audit): API keys are unscoped (a key has its owner's full non-admin authority); `events.id` are 6-char shareable codes, which eases targeting; guest photo uploads sit in a public bucket with unguessable URLs; the analytics ingest lock is per-process; a DNS-rebinding TOCTOU remains in the (admin-only) scraper/image fetch; `settle()` does not assert charged == expected as defense-in-depth.

## Session 2026-09-26: abuse and cost limits

Security/cost review fixes. Migration **`20261017000000_abuse_limits.sql` (not applied)**; new env var **`TRUST_PROXY_HOPS`** (`.env.example`; number of proxies in front of the API, 0 on a laptop — without it every rate limit behind a load balancer counts the proxy's IP).

- **Rate limits per user** (`src/common/http-hardening.ts`). `trust proxy` is set in `main.ts` from `TRUST_PROXY_HOPS`, and the limiter is now mounted after `clerkMiddleware` (local JWT check only) so it can read the session. Rules marked `perUser` key on the Clerk user id when there is a session (IP otherwise): `writes`, `uploads` (now also `…/attachments`), and new rules `messages-send` (10/h: `POST /api/events/:id/messages` and `…/whatsapp/send`), `fulfilment-orders` (10/h), `retailer-search` (60/h), `chat-transcript` (2/h). `site-public` also covers `…/condolences`.
- **Send quotas** (`src/messaging/send-quota.ts`, used by `MessagingService.send` and `WhatsAppService.send`). Deliveries per event in the last 24 h are counted in `message_deliveries`; beyond the plan's cap → 429. Caps are `services` rows `message_daily_cap_premium` (1000) / `message_daily_cap_signature` (3000), the cap in `price_centavos`; missing rows fall back to 500. Households that already got the same channel in the last 10 min are skipped; both sends now return `sent`, `failed`, `skipped` on top of the usual payload.
- **Chat transcript relay closed** (`chat.service.ts`): the transcript only goes to the thread's stored visitor email or the signed-in caller's account email; a different `email` in the body → 400. Attachments: 20 per conversation per day (storage listing) → 429.
- **Fulfilment orders** (`fulfilment.service.ts`): quantity ≤ 500; at most 5 open (submitted|confirmed) orders per event → 409; the partner notification no longer blocks the request (fire-and-forget, result stored on the row when it resolves). Webhook URLs are checked with the scraper's `assertPublicHost` (now exported from `product-scraper.ts`) when an admin saves a partner and again in `partner-notify.ts` before every POST (SSRF).
- **RSVP name lookup** (`guests.service.ts`): `POST /api/sites/:slug/rsvp/find { name }` now returns a masked household `{ masked: true, name, guests: [{ firstName }], submitted, deadline, open }` — no code, phone, allergies or menu. `{ code }` still returns the full household; submitting still needs the code. Frontend `RsvpDialog.jsx`: a name search shows the household and first names and asks for the invitation code ("That's not me" goes back); three new Spanish strings in `i18n/es.js`.
- **Refund atomicity** (`src/payments/refund-guard.ts`, migration): `refund_pending` on `vendor_orders` and `payment_attempts`, reserved with the SQL functions `lazo_vendor_refund_reserve` / `lazo_payment_refund_reserve` (conditional update: `refunded + pending + amount <= charged`, 409 otherwise) before Stripe/Mercado Pago, then `…_settle` moves pending → refunded (or releases it on failure). Vendor refunds accept an optional `idempotencyKey` (≤ 64 chars, unique per order on `vendor_refunds.idempotency_key`); repeating it returns the existing refund (`refund.repeated: true`). Missing functions → 503 naming the migration.
- **Dynamic registry** (`resources.registry.ts`): `message-consents` is list/read only; `households.invite_code` is read-only (gift money columns were already).
- **Retailers** (`retailers.service.ts`): 60 s in-memory search cache per `(retailer, query)` (`cached` in the response); `refresh-availability` → 429 when any item was checked less than an hour ago.
- **Guest photos** (`photos.service.ts`): 200 pending (unmoderated) photos per event → 429.
- **Registry** (`registry.service.ts`): a guest gift report no longer flips the item to `purchased` (anyone could hide every gift); the host confirms with `PATCH /api/events/:id/registry/:itemId { status: 'purchased' | 'available' }`. Frontend Gift step got a "Mark as given" link next to "Put back on the list".
- **Sent quotes** (`vendor-quotes.service.ts`): editing lines, amount, deposit or validity of a `sent` quote reverts it to `draft` (`reverted: true`; a system line tells the host); the vendor sends it again.

## Session 2026-09-26: marketplace chat (Fiverr / Upwork style)

Migration `20261015000000_chat_marketplace.sql` (needs the chat migrations `20261004…06` and `20261009_vendor_orders` first). Chat routes 503 naming it when the new columns are missing. The `20261010_whatsapp.sql` regex `{1,512}` was also fixed (Postgres caps repetition at 255).

What the host↔vendor thread now does, on top of live delivery, typing, presence and canned replies:
- **Offers inside the chat.** Vendor: "Create an offer" in the composer opens the same quote form as the Quotes tab (lines, deposit, valid-until, note) and `POST /api/chats/:id/offer` creates a sent `vendor_quote` with `conversation_id` plus an `offer` message. The card shows lines, total, deposit, validity and state. Host: **Accept and pay** (accept → order → Stripe Checkout, back to the event's orders page as before) or **Decline**; **Pay now** on an accepted-but-unpaid order. Vendor: **Withdraw**. Needs the vendor approved with `charges_enabled` (the API says so otherwise).
- **Order milestones as system lines** (`kind: 'system'`, sender `system`): quote sent from the Quotes tab (posted as an offer card into the open thread), accepted, declined, withdrawn, payment received (from `markPaid`, so webhook and redirect both post it once), started, fulfilled, refunded (vendor or admin), cancelled. Posted by `chat-system.ts` helpers (plain functions) so the vendor payment services don't import `ChatService` — which itself injects `VendorQuotesService` for offers. A thread is found by the quote's `conversation_id`, else the open host+event+vendor thread.
- **Attachments.** 📎 or paste: `POST /api/chats/:id/attachments` (multipart, JPEG/PNG/WebP/PDF by signature, ≤ 10 MB) into the private bucket `chat-files` (created on first upload), then sent as `attachments` on the message (≤ 10, only paths of that thread). Threads return one-hour signed URLs; images show inline, PDFs as links. File-only messages have `kind: 'file'` and a "📎 name" preview.
- **Inbox.** Search box, filters All / Unread / Starred / Archived with counts, relative time per row, unread rows bold. Star and Archive live in the thread header (per participant, on `conversation_reads`). An archived thread stays visible while open and under Archived. Hidden in the compact widget.
- **Response-time badge.** The vendor's first reply in a thread records `first_reply_seconds`; Find vendors cards show "Usually responds within 2 h · 95% response rate" (`vendorResponseStats`, last 200 threads per vendor). Nothing shows until a vendor has answered someone.
- **Contact guard (Fiverr style).** In a host↔vendor thread with no paid order between the parties, a message with a phone number, email or WhatsApp/Telegram link is still delivered but `flagged` and the sender sees a warning; admins see the flag in the dashboard thread. A banner in the thread says why payments should stay on Lazo.
- **Email alerts.** When the recipient of a host↔vendor message has no live stream open, Resend sends "X sent you a message on Lazo" with a link to the thread (host: `/dashboard/chats/:id`; vendor: `/vendor?tab=chats&chat=:id`), at most one per thread per 30 min (`conversations.last_notified_at`). Silent without `RESEND_API_KEY`.
- **Admin dashboard** thread view renders system lines, offer cards with quote/order state, flags and attachment links.
- `apiFetch` now passes `FormData` bodies through (no JSON header). `QuoteForm` is exported from `VendorQuotes.jsx` with `heading` / `hint` / `saveLabel` / `allowDraft` props.

Not done: message editing/deletion; reporting or blocking a user; a per-order "requirements" step; deposits still settle the balance outside Lazo (unchanged); the email alert is plain text with no template. Test walk: host → Find vendors → Message → vendor (approved, Stripe on) replies from `/vendor` → Chats → Create an offer → host sees the card, Accept and pay (card 4242…) → both sides see "Payment received" → vendor Start / Mark fulfilled from Quotes & orders → lines appear in the thread.

## Session 2026-09-26: gifts per occasion

The Gift step's copy and store-search ideas now come from `event_modes.gifts` (migration `20261016000000_mode_gifts.sql`, **not applied**): `hint`, `fundLabel`, `fundExample`, `itemExample`, `searchIdeas`. A baby shower says "Link baby gifts… cash fund for the nursery", the fund button reads "Cash fund for the baby", and the "Search a store" panel shows idea chips (carriola, cuna, pañalera, monitor…) that run that search in the chosen store. Weddings keep the honeymoon wording. `GET /api/event-types` returns `gifts` (empty strings until the migration, in which case the step keeps generic wording). Edit the row to change the ideas; no deploy.

## Session 2026-09-26: launch focus — Wedding and Baby Shower only

Founder decision: Lazo launches with two occasions. Migration `20261014000000_focus_wedding_babyshower.sql` (**not applied**) adds the `baby_shower` mode (fields: mom's name, partner's name, baby's name; name "Ana's baby shower", slug `ana-babyshower`; description, family section, vocabulary, privacy defaults, sections; sub-event kinds Baby Shower, Brunch, Games) and sets `active = false` on xv, bautizo, graduacion, corporate and memorial. Inactive modes disappear from the picker, `GET /api/event-types` and the homepage cards; existing events in those modes keep working, and the admin dashboard still lists all modes. Reactivating one is a row change.
- Homepage copy now says "A wedding or a baby shower…" (`OccasionCarousel.jsx`, `es.js`). `CLAUDE.md` states the focus.
- Needs the user: apply the migration, then upload a Baby Shower card image in dashboard → Homepage (`event_modes.image_url` is empty for the new row), and add a theme for `baby_shower` in dashboard → Themes (themes are filtered by mode, so the theme picker is empty for baby showers until one exists).
- The corporate/memorial sections built earlier today stay in the code and turn on again if those modes are reactivated.

## Session 2026-09-26: PRD V1 gaps — six streams

Usage guide for everything in this session: [USAGE-2026-09-26.md](USAGE-2026-09-26.md) (setup order, env per feature, how hosts, vendors, guests and admins use each piece, what is not built).

Six parallel streams closed the remaining PRD V1 gaps; the integrator wired them into the shared files (`app.module.ts`, `App.jsx`, `main.jsx`, `index.html`, `EventOverview.jsx` + `accents.css`, `dashboard.html`, these docs). Six migrations, `20261008000000` … `20261013000000`, are **not applied** (no `DATABASE_URL` locally); every new route answers 503 naming its file until then. Checks after integration: `npx tsc --noEmit` clean (only the pre-existing `test/app.e2e-spec.ts` `supertest/types` error), `npx nest build` ok, `npx vite build` ok, `oxlint` 0 errors in both apps (warnings pre-existing), and `node dist/main.js` boots with every new route mapped and no DI errors.

Integration notes:
- `PaymentsService` now injects both `InvoicesService` (A) and `MercadoPagoService` (E); both are registered as providers.
- `EventRegistryRetailerController` (D) is listed before `SiteContentController` because both live under `api/events/:id/registry`.
- The event overview has three more tool cards: "Quotes & orders" (always), "After the event" (once the date has passed or the event is closed) and "Messages of condolence" (memorial mode). `accents.css` styles the cards by position, so the conditional ones go last and the "Open your site" card is now styled by its class (`.ov-link--site`) instead of by position. "Messages" and "Print, flowers & travel" subtitles were updated. The overview also handles the Mercado Pago return (`?gateway=mercadopago&payment_id=` → `POST /api/checkout/confirm`).
- The floating chat hides on `/invoices/*` as well as `/print/*`.
- Dashboard: five new admin sections (Invoices, Vendor orders, WhatsApp, Fulfilment, Analytics); the Payments section was replaced by stream E's version (gateway column, refunds, reconcile). `migrationNote()` now shows a 503 message verbatim when it already names a migration file or an env var, instead of always pointing at `api_keys`.
- Lint fixes in files streams touched or that blocked a clean run: two event handlers named `use*` (`Messages.jsx` `applyTemplate`, `ChatInbox.jsx` `applyShortcut`) were renamed so the hooks rule passes; two duplicate keys with identical values (`Delete`, `refunded`) were removed from `es.js`.

### A-core: anonymous drafts, invoices, post-event, PWA, seating export

Migration `20261008000000_core_gaps.sql` (**not applied**; no DATABASE_URL locally). It drops `events.owner_id NOT NULL` (guarded by a check: ownerless only in state `anonymous_draft`), adds `events.claim_token_hash`, `claim_expires_at`, `closed_at`, `guests.attended`, extends the backbone `invoices` table (sequential `number` from `invoice_number_seq` via `lazo_invoice_number()`, `owner_id`, `line_items`, `subtotal_centavos`, `tax_centavos`, `tax_rate`, `gateway`, `gateway_reference`, `razon_social`, `cfdi_uso`, unique index per payment attempt).

- **Anonymous draft + claim** (`src/drafts/`): the details step now saves the answers server-side as an `events` row in state `anonymous_draft` (`POST /api/drafts`, public, rate-limited 20/h per IP; `PATCH /api/drafts/:id` re-saves; `GET /api/drafts/:id?token=`). The raw claim token is returned once and only its SHA-256 is stored; the browser keeps `{id, token}` in localStorage `lazo.anonDraft`. `AuthComplete` claims it (`POST /api/drafts/:id/claim`, sets owner, `claimed_at`, state `draft`, and picks the subdomain then — anonymous rows reserve no slug). If the claim fails (expired, migration missing) it falls back to the old sessionStorage path. Drafts expire after 30 days: expired rows are deleted when read (no scheduler). Anonymous drafts never appear in host lists (owner-scoped queries); admins see them in Events with state `anonymous_draft`.
- **Invoices** (`src/invoices/`): every succeeded `event_fee` payment gets an `invoices` row `LAZO-YYYY-000001…` with line items, subtotal, IVA 16 % shown as included, total, gateway + PaymentIntent reference. Created from `PaymentsService.apply` on both the confirm and the webhook path, idempotent by attempt id (unique index + race handling); a failure to create one is logged and never blocks the plan upgrade. Routes: `GET /api/events/:id/invoices`, `GET /api/invoices/:id`, `PATCH /api/invoices/:id/billing` (`rfc`, `razonSocial`, `cfdiUso`), `GET /api/admin/invoices`. Frontend: printable `/invoices/:id` (own print CSS) with the billing form; the Upgrade page lists invoices. **Not done: CFDI stamping.** No PAC (Facturama / SW Sapien) is integrated; the receipt says so and `uuid_fiscal` stays null. Existing paid attempts get an invoice the next time their session is applied (`POST /api/admin/payments/:id/sync`).
- **Post-event flow** (`src/after-event/`, page `/dashboard/events/:id/after`): invited vs attending vs came (host ticks guests off; `PATCH /api/events/:id/guests/:guestId/attendance { attended }`, also a new "Attended" column in the guest CSV), gifts and thank-you progress (reuses `gifts.thanked_at`), photos pending, guest CSV download, and "Close event" (`POST /api/events/:id/close` → `events.closed_at`). `closed` is deliberately not a lifecycle state (the check constraint has none and the public site must stay up): `GuestsService.liveEvent` and `SitesService` report RSVP closed once `closed_at` is set, so guests see the site but cannot answer. The overview shows the "After the event" link once the date has passed.
- **PWA**: `manifest.webmanifest` (es-MX, standalone, theme `#2c5f7c`, PNG icons 192/512 rendered from `favicon.svg`), `sw.js` (app-shell precache, network-first API with a 5-minute stale window for the public catalogue routes only, cache-first hashed assets, `offline.html` fallback). Registered only on the app host in production builds, never on event-site subdomains.
- **Seating export/print**: `GET /api/events/:id/seating/export.csv?event=` (one celebration or all; a row per seat, empty seats and unseated guests included, CSV-injection safe) and `/print/:eventId/seating` (A4 portrait, tables as columns). Buttons on the Seating page.
- Also: `users.service` ignores ownerless rows when counting events per user; `http-hardening` has `drafts` and `draft-reads` limits.

Open: CFDI/PAC integration; a background job to purge expired anonymous drafts (today they are purged on read only); translations of the new dashboard pages are partial (keys added to `es.js`, page bodies still mostly English like the other dashboard pages). `Details.jsx` was fully rewritten (a failed patch truncated it); content is the original plus the anonymous-draft save — eyeball it once.

### B-vendor-payments: Stripe Connect

Migration `20261009000000_vendor_orders.sql` (not applied yet). Everything below 503s naming it until applied; Stripe calls 503 with `STRIPE_SECRET_KEY` when unset.

- **Model:** Lazo is a Stripe Connect platform. Each vendor gets an **Express account (MX, MXN)**; host payments are **destination charges** on Lazo's account with `application_fee_amount` = Lazo's commission and `transfer_data.destination` = the vendor's account. Stripe pays the vendor out to their bank; Lazo never holds vendor money beyond Stripe's flow.
- **Tables:** `vendors` + `stripe_account_id`, `stripe_onboarding_status (pending|complete|restricted)`, `charges_enabled`, `payouts_enabled`, `stripe_synced_at`; `vendor_quotes` (from an inquiry or a host pick; line items JSON, amount, optional deposit, valid_until, status draft→sent→accepted|declined|expired|withdrawn); `vendor_orders` (one per accepted quote; amount charged = deposit or full, `platform_fee_centavos`, Stripe session/intent/charge/transfer ids, receipt URL, `refunded_centavos`, status pending_payment|paid|in_progress|fulfilled|cancelled|refunded|disputed); `vendor_refunds`; `vendor_disputes`; `vendor_stripe_events` (webhook idempotency). Commission = `services.vendor_commission_pct` (price_centavos = % × 100, default 1000 = 10 %; `active=false` → 0 %).
- **Vendor** (`/vendor` → Payments): `POST /api/vendor/payments/onboard` creates the Express account once (idempotent per vendor) and returns an Account Link; the return URL comes back to `/vendor?tab=payments&onboarded=1`, which re-reads Stripe. `GET /api/vendor/payments?refresh=1` syncs status; `POST …/dashboard-link` opens the Stripe Express dashboard. Requires an approved (active) vendor.
- **Vendor** (`/vendor` → Quotes & orders): writes a quote for an inquiry (line items, deposit, valid-until, note), saves a draft or sends it (sending requires `charges_enabled`), withdraws; orders list with Start / Mark fulfilled / Refund (full or partial → real `stripe.refunds.create` on the PaymentIntent with `reverse_transfer` and `refund_application_fee`, so the host gets everything back and vendor + Lazo shares are reversed pro rata).
- **Host** (`/dashboard/events/:id/orders`): quotes received with lines and totals, Accept and pay (creates the order, then Checkout: card + OXXO/SPEI as enabled in Stripe, `locale es`), Decline, Pay again / Cancel an unpaid order, receipt link, refund and dispute state. Return `?order_checkout=cs_…` → `POST /api/orders/confirm` (idempotent with the webhook — works on a laptop without a public URL).
- **Webhook** `POST /api/webhooks/stripe-connect`: `payment_intent.succeeded`, `checkout.session.completed|async_payment_succeeded|expired`, `charge.refunded` (mirrors dashboard refunds too), `charge.dispute.created|updated|closed` (order → disputed; won restores the previous status, lost → refunded), `account.updated` (onboarding status). Signature verified on the raw body; each event id processed once (`vendor_stripe_events`). `STRIPE_CONNECT_WEBHOOK_SECRET` accepts a comma-separated list because Stripe delivers `account.updated` for connected accounts only to a *Connect* endpoint, and payment events to an *Account* endpoint — two endpoints, two secrets, same URL. If the plans endpoint is subscribed to `checkout.session.*` it also receives vendor-order sessions; `PaymentsService` ignores sessions without `attemptId` metadata, so that is safe.
- **Admin** (dashboard → Vendor orders): filters by date/status, totals (gross, Lazo fees net of refunds, refunds, disputed, net to vendors), per-vendor settlement (account, onboarding, charges/payouts, paid/refunded/fees), admin refunds, commission % editor, and **Reconcile with Stripe** (`GET /api/admin/vendor-orders/reconcile?from&to`, max 92 days): pulls balance transactions and lists mismatches (charge missing in DB / in Stripe, amount differs, refund or dispute not recorded).
- **Env:** `STRIPE_SECRET_KEY` (existing), `STRIPE_CONNECT_WEBHOOK_SECRET`, `APP_URL` (return pages).
- **Not done / needs the user:** (1) apply the migration; (2) enable Connect in the Stripe dashboard (Express, Mexico) — until then `POST /api/vendor/payments/onboard` answers 503 "Stripe Connect is not enabled" (seen 2026-09-26: Stripe rejected `accounts.create` with "You can only create new accounts if you've signed up for Connect") and OXXO/SPEI if wanted; (3) create the two webhook endpoints; (4) a live Stripe account in Mexico needs KYC for Lazo itself before live Express accounts can be created; (5) deposits: only the deposit is charged through Lazo — the balance is settled between host and vendor outside (no second Checkout yet); (6) no email/notification to the host when a quote arrives (messaging stream); (7) dispute evidence is submitted in the Stripe dashboard, not here; (8) the `vendor_commission_pct` row shows as a "price" in Payments → Prices — cosmetic.

Test walk: vendor approved → Payments → Set up with Stripe (test mode) → Check status shows charges on → host requests a quote in Find vendors → vendor writes and sends the quote → host Accept and pay (card 4242…) → back on `/orders` as Paid with a receipt → vendor Start / Mark fulfilled / Refund → admin Vendor orders → Reconcile.

### C-whatsapp: WhatsApp Business Cloud API (PRD 6.4)

Built: `src/whatsapp/` — `WhatsAppService` talks to Meta Graph API v21.0 (`/<WABA_ID>/message_templates` to list/create templates, `/<PHONE_NUMBER_ID>/messages` to send template messages). Sends are template-only (Meta rule), sequential with a 150 ms gap, restricted to households with `whatsapp_consent = true` and no `whatsapp_opted_out_at`, numbers normalised to E.164 (10-digit MX → +52). Each send writes a `message_deliveries` row (`channel = whatsapp`, `wa_message_id`, `wa_status = accepted`); the webhook moves it to sent/delivered/read/failed and never steps a status backwards. Meta error codes 131047 (24h window), 131026 (not on WhatsApp), 131049/131050, 132000/132001 are mapped to plain-language titles stored in `wa_error_title`. Inbound text `STOP`/`BAJA`/`ALTO`/`CANCELAR`/`UNSUBSCRIBE` sets `whatsapp_opted_out_at` on every household with that number (matched via previous deliveries and the stored phone) and also writes an opt-out row in `message_consents`. Template review results (`message_template_status_update`) update `whatsapp_templates.status`.

Consent (WA-1): the public RSVP form has an optional "Recibir avisos por WhatsApp" checkbox with a phone field; submit saves `whatsapp_consent`, `_at`, `_source = rsvp_form` and the phone on the household. Hosts see a WA consent pill per invitation on the guest list and can toggle it (`source = host`); a guest who replied STOP cannot be re-opted by the host.

Host UI: Messages page → channel WhatsApp → `WhatsAppPanel.jsx`: approved-template picker, audience, preview rendered from the first real recipient (server-side `{{n}}` substitution), custom params for template placeholders the server does not know, send, and a per-delivery table (invitation, masked number, status, Meta error title). Shows "not configured" naming the missing env vars, "webhook not set up" naming its vars, and "no template approved yet (n awaiting review)". `messaging.service.ts` was not edited; `MessagingService.list` still returns whatsapp campaign rows because they share the `messages` table, and `Messages.jsx` filters those out of the email/SMS list.

Admin: WhatsApp section — templates with Meta status, Submit to Meta, Sync from Meta, delivery failures for the last 7 days.

Migration: `supabase/migrations/20261010000000_whatsapp.sql` — `whatsapp_templates` (seeded with two *pending* definitions `lazo_invitation`, `lazo_reminder`, es_MX, UTILITY; these must be submitted and approved by Meta before anything can be sent), `households.whatsapp_consent/_at/_source/_opted_out_at`, `message_deliveries.wa_message_id/wa_status/wa_error_code/wa_error_title/wa_status_at`, `messages.channel` check now allows `whatsapp`, `messages.template_id`.

Env (in `.env.example`): `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID` (sends/sync/submit), `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` (webhook). Callback URL `https://<api host>/api/webhooks/whatsapp`, subscribe to `messages` and `message_template_status_update`.

Needs the user (external launch dependency, PRD WA-3): a Meta Business verification, a WhatsApp Business Account with a production phone number (not the test number), a permanent System User token, template approval by Meta, and a real opted-in recipient test before beta. Nothing is faked: with no env the API answers 503 naming the variable, and with no approved template the send button stays disabled.

Not done: retry scheduling for transient Meta errors (WA-2 "retry only appropriate failures") — failures are recorded with their code so a later job can retry non-final ones; template body editing from the admin (definitions are configuration rows, edit in SQL or add a form later); media/header/button components (body-only templates); per-guest (vs per-household) sends.

### D-retail-fulfilment: retailer catalogs (PRD §6.1 / MODE-2) and fulfilment partners (PRD §6.3)

Migration `20261011000000_retailers_fulfilment.sql` (not applied yet).

Retailers:
- `retailers` table = configuration rows (adapter, env var *names*, `supports` flags, affiliate tag, `synced_at`). Seeded: `amazon_mx` (Amazon Product Advertising API 5.0, `webservices.amazon.com.mx`, SigV4 signed by hand in `src/retailers/amazon-paapi.adapter.ts`) and `mercadolibre` (`api.mercadolibre.com/sites/MLM/search`, `/items?ids=`, app token via `client_credentials` cached in memory, `src/retailers/mercadolibre.adapter.ts`). Common contract `src/retailers/retailer-adapter.ts`: `search / getItems / availability` → `{ retailer, externalId, title, imageUrl, priceCentavos, currency, available, url, attribution }`.
- Env: `AMAZON_PAAPI_ACCESS_KEY`, `AMAZON_PAAPI_SECRET_KEY`, `AMAZON_PAAPI_PARTNER_TAG`, `MELI_APP_ID`, `MELI_CLIENT_SECRET` (in `.env.example`). Missing env → 503 naming the variables; `GET /api/retailers` reports `configured` + `missingEnv` per store and the Gift step says "not configured" with the names. Mercado Libre's affiliate id (`matt_tool`) goes in `retailers.affiliate_tag` when the program approves it; Amazon's tag is in every `DetailPageURL` the API returns.
- `registry_items` gained `retailer_key`, `available`, `price_checked_at` (uses the existing `external_id`, kind `retailer_api`). `POST /api/events/:id/registry/from-retailer` re-reads the item from the store before saving (INT-3). `POST .../registry/refresh-availability` re-checks price/stock for all retailer items.
- Guest purchase flow = `purchase_redirect`: the Red theme's "View gift" now links to `GET /api/sites/:slug/registry/:itemId/go` (public; records a row in `registry_clicks` with a hashed referrer, then 302 to the affiliate URL; private-site token rides as `?t=`). "Out of stock at the store" replaces the label when `available === false`. The "I bought this" report stays as the reservation flow; `reservation: false` in `supports` — neither store offers an API reservation.
- NOT done: API checkout / order confirmation inside Lazo (MODE-2 "order confirmation and fulfilment status"): neither Amazon Associates nor Mercado Libre's public API sells on behalf of a third party; the purchase happens on the store. Group contributions toward a retailer item (MODE-3) are not built.

Fulfilment partners (print, flowers, travel):
- `fulfilment_partners` (category, contact, `coverage` cities, `products` `[{key,name,priceCentavos,unit,leadDays}]`, `notify_via` email|webhook, webhook URL + secret, published `terms`, active). **Nothing seeded**: the admin adds contracted partners in dashboard → Fulfilment.
- `fulfilment_orders`: status `submitted → confirmed → in_production → shipped → delivered`, or `cancelled` (host, only while submitted/confirmed) / `rejected` (partner). `timeline` JSON of every change with who made it; `notification` JSON stores what happened when the partner was told; `payment_status` unpaid|paid|refunded set by admin (no payment provider for partner orders yet); `partner_reference`.
- `src/fulfilment/`: `GET /api/events/:id/fulfilment` (orders + covered cities), `GET .../fulfilment/options?city=` (only partners/products that deliver there), `POST .../fulfilment/orders` (validates coverage + product + lead time, then notifies the partner: Resend email with `RESEND_API_KEY`/`MESSAGE_FROM_EMAIL`, or `POST` to the webhook with `X-Lazo-Signature: sha256=<hmac>`), `POST .../orders/:id/cancel`. Partner status: `POST /api/partners/fulfilment/:orderId/status` (public, HMAC over the raw body with the partner's secret). Admin: partners CRUD + rotate secret, orders PATCH (status with note, paymentStatus, partnerReference). `API_PUBLIC_URL` env optional (the status URL put in partner emails; defaults to the request host).
- Frontend `Concierge.jsx`: "Order from a partner" (city select from real coverage → partners → order form → orders with timeline and Cancel). Flowers added to manual concierge requests too (`concierge_requests.kind` check widened in the migration; `FLOWER_PRODUCTS` in `concierge.service.ts`). Manual requests remain the fallback.
- NOT done: payment collection for partner orders (PAY-3 split of gross / fee / proceeds), artwork proof approval for print (FUL-2), traveller itinerary acceptance for travel (FUL-2 — today travel is request + notes + partner confirmation/reference). No partner API adapters exist beyond email/webhook because no partner is contracted yet. Neither retailer API has been exercised against live credentials (none available); smoke-test with the first keys (`GET /api/retailers/amazon_mx/search?q=licuadora`).

### E-modes-gateway: corporate and memorial modes, Mercado Pago — `20261012000000_modes_mercadopago.sql`

**Modes (PRD EVT-3/4/5).** `event_modes` gains `vocabulary` (`{es:{…},en:{…}}` labels per mode), `privacy_defaults` (`password_required, searchable, guest_uploads, show_guest_count`) and `sections` (ordered public-site section keys). The six rows are configured in the migration: boda/xv/bautizo/graduacion keep `hero,story,schedule,venue,registry,rsvp,photos`; corporate is `hero,agenda,speakers,venue,rsvp,materials` (uploads off, guest count hidden, registry absent); memorial is `hero,life,service,condolences,donations,photos` (password required, not searchable, uploads off). Bautizo also defaults to password-required (minors, EVT-5).
`events` gains `password_required`, `searchable`, `show_guest_count`; `gallery_open` doubles as the guest-uploads switch. `EventsService.create` copies the mode's defaults onto the new row (only once the migration is applied; before that the insert omits the columns). `GET /api/event-types` returns `vocabulary`, `privacyDefaults`, `sections`. `GET /api/events/:id` returns `privacy: { passwordRequired, searchable, guestUploads, showGuestCount }`.
Enforcement: `POST /api/events/:id/publish` refuses (400) when `password_required` and no site password; guest photo uploads already refuse when `gallery_open` is false (now false by default for corporate/memorial); `GET /api/sites/by-slug` reports `rsvp.open=false` and an empty `registry` when the mode's sections lack them; `POST /api/sites/:slug/rsvp` refuses (403) for modes without an `rsvp` section. `site-content` (jsonb on `events`) accepts new keys `agenda[]`, `speakers[]`, `materials[]`, `life{}`, `condolences{enabled,intro}`, `donations{}` with validation. New `condolences` table + service/controllers (public POST/GET on the site; host list/approve/delete). Public site payload adds `sections`, `vocabulary`, `showGuestCount`; `publish.passwordRequired` on site-content.
Frontend: `src/i18n/useVocabulary.js` (`useVocabulary(eventOrType)` → `v(key, fallback)`; `vocabularyOf()` for public sites); `src/site/sections/` (Agenda, Speakers, Materials, Life, Condolences form + approved list, Donations; `MODE_SECTIONS`, `showsSection`, `modeSectionsOf`); default `PublicSite` and `RedTheme` render the mode's sections in order, use the vocabulary for RSVP/Registry/Gallery labels, and hide RSVP/registry/photos when the mode does not list them. Builder: `ModeSections.jsx` on Event Info edits the mode's sections; Go Live shows the password requirement and disables Publish until it is set. New dashboard page `pages/dashboard/Condolences.jsx` (route `/dashboard/events/:id/condolences`, overview link for memorial events).

**Mercado Pago (PRD PAY-4/5/6).** `src/payments/mercadopago.service.ts`: Checkout Pro preference (`POST /checkout/preferences`, MXN, `external_reference` = attempt id, `back_urls`, `auto_return` only on https, `notification_url` from `API_URL`), `GET /v1/payments/:id`, `POST /v1/payments/:id/refunds`, `GET /v1/payments/search` (paged), and `x-signature` HMAC verification (`id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, 10-minute window). `PaymentsService` refactored around one `settle()` (never moves a paid attempt backwards, applies the tier once) used by both gateways; `payment_gateways` table (stripe default) with `configured` decided by env; `PAYMENTS_DEFAULT_GATEWAY` override. `payment_attempts` gains `gateway_payment_id` (MP payment id), `refunded_centavos`, `refund_reference`, `refunded_at`. Upgrade page shows a gateway chooser only when more than one gateway is configured and lists each gateway's methods from the API; payment history shows gateway and refunds. Admin Payments section: gateway column and status, Refund per settled purchase, Reconcile panel.

Env (`.env.example`, block "Payments: Mercado Pago"): `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`, `API_URL` (public https base of the API, used as `notification_url`; blank on a laptop), `PAYMENTS_DEFAULT_GATEWAY` (`stripe|mercadopago`).

**Needs the user:** apply the migration; a Mercado Pago application (production credentials, MXN account) → `MERCADOPAGO_ACCESS_TOKEN`; register the webhook `https://<api>/api/webhooks/mercadopago` (topic Payments) → `MERCADOPAGO_WEBHOOK_SECRET`; `API_URL` in production. OXXO/SPEI availability on Mercado Pago depends on the account (PAY-6 launch matrix to verify); the methods listed per gateway are data in `payment_gateways.methods` — edit the row if a method is not enabled.

**Not done / notes:** `searchable` is stored and returned but there is no public discovery index yet to honour it. CFDI/invoicing adjustments on refund (PAY-7) are out of scope. The `refunds` table from the backbone is not written to; refund state lives on `payment_attempts`. Admin cannot toggle `payment_gateways` rows from the dashboard (edit the table). The Stripe reconcile lists PaymentIntents created up to 7 days before `from` so OXXO settlements match. Mode-specific content lives as keys inside `events.site_content` (jsonb), not new columns; privacy defaults are copied onto the event at creation so a host can change them later.

### F-analytics: analytics warehouse, scheduled ingest, revenue reconciliation (PRD §2.1 / §8)

A separate analytical store as the Postgres schema `analytics` in the same Supabase project (migration `20261013000000_analytics_warehouse.sql`). No cross-schema foreign keys, ids copied as values, owner ids stored as sha256 hashes: it is designed to move to a physically separate database later (production option; the `ingest` function then runs over an FDW copy of the source tables). The schema is **not** exposed through PostgREST, so supabase-js never sees it; the backend reads it over the direct `pg` connection `DATABASE_URL` (already used by `scripts/migrate.mjs`). Without `DATABASE_URL` every analytics route answers 503 naming it; without the migration, 503 naming the file.

- Tables: `dim_date` (2025–2032), `dim_event` (SCD-lite current row + `first_seen_at`), `dim_vendor`, `fact_daily` (generic `day, metric_key, dims jsonb, value`: event funnel created/claimed/paid/published by mode, orders, GMV, refunds, photos, users), `fact_site_views_daily`, `fact_rsvps_daily`, `fact_gifts_daily`, `fact_payments` (one row per attempt with gateway amount, refunds, gateway fee), `fact_vendor_leads_daily` (listing views, selections, quotes, chats), `fact_messages_daily` (campaign counters + per-recipient deliveries incl. WhatsApp), `fact_chat_daily` (volume + average first-response seconds), `ingest_runs`, `revenue_reconciliation`.
- Ingest is SQL: `analytics.ingest(window_from, window_to, trigger)` recomputes whole days in the window (delete+insert for daily facts, upsert by natural key for per-row facts) and records an `ingest_runs` row even on failure; `analytics.ingest_incremental()` runs from the last successful window end minus one day to now (first run: from the oldest event). The backend `AnalyticsIngestService` calls it on a timer (`ANALYTICS_INGEST_INTERVAL_MINUTES`, default 360, `0` off; first run ~60 s after boot) and from `POST /api/admin/analytics/ingest` with an in-process lock. A commented `cron.schedule` for pg_cron is in the migration as the alternative (enable one, not both).
- Reconciliation (DATA-3): `POST /api/admin/analytics/reconcile {from,to}` compares `fact_payments` per day/gateway with Stripe balance transactions (SDK) and Mercado Pago `/v1/payments/search` (needs `MERCADOPAGO_ACCESS_TOKEN`; otherwise rows stay `unchecked`, never assumed ok). Verdict `ok|mismatch|unchecked` with delta and gateway fees; Stripe per-charge fees are written back to `fact_payments.fee_cents` (matched on payment intent) so "provider costs" is real.
- Dashboards: `/dashboard#analytics` (KPI tiles, inline SVG chart with 19 whitelisted metrics, ingest panel with Run now, reconciliation table, date range). Everything is computed from `analytics.*`, never from `public`.
- Host-facing: `GET /api/events/:id/analytics/daily` serves per-event daily views/RSVPs/gifts from the warehouse only while the last successful ingest is < 30 h old; otherwise 503 pointing at the live `/stats`.

Env: `DATABASE_URL` (required for analytics), `ANALYTICS_INGEST_INTERVAL_MINUTES`, `MERCADOPAGO_ACCESS_TOKEN` (optional). `@types/pg` was added as a dev dependency (`pg` was already a dependency).

Not done / caveats: no Mercado Pago payments existed when this was written, so its reconciliation path is exercised only once a token and MP attempts exist. Days are UTC on both sides. Acquisition source (DATA-2) is not tracked because no source table records it. `fact_payments.fee_cents` is 0 until reconciliation runs. The SQL could not be executed locally (no `DATABASE_URL` here); it was written against the current migrations and reviewed, but the first run in the SQL editor is the real test.

## Session 2026-09-26: accents stylesheet was losing to page styles

- `lazofrontend/src/accents.css` is imported from `main.jsx`, so it lands **before** every page stylesheet (`Planning.css`, `Guests.css`, `Builder.css`, ...). Any property both files set was won by the page file. Visible result on the event overview: the icon tiles drew (they come from `::before`/`::after`) but the 76px left padding did not, so icons sat on top of the titles ("ts & RSVPs", "klist & budget"). The same ordering silently dropped the tab gradients, pill colours, inbox avatar gradient, badge colour and step-card stripe colours.
- Fix: every selector in `accents.css` is now prefixed with `:root`, which outranks the page rules regardless of load order. The file header says why.
- While there: `.dash-card` no longer gets `overflow: hidden` (it would have clipped the ••• menu that drops below the card). The theme image corners are rounded directly instead, matching the 640px breakpoint in `Dashboard.css`.

## Session 2026-09-26: Stripe's charged amount in the admin dashboard

- **Migration `20261007000000_payment_stripe_amounts.sql`** (apply in the SQL editor):
  `payment_attempts.stripe_amount_cents`, `stripe_currency`, `stripe_payment_intent`, `receipt_url`.
- When a Checkout session settles (webhook or `/checkout/confirm`), `PaymentsService.apply`
  now stores Stripe's `amount_total` / currency, the PaymentIntent id and the receipt URL
  (one extra `paymentIntents.retrieve` with `latest_charge` expanded).
- **`GET /api/admin/payments`** also returns `summary` (paid / started, paid totals per
  currency using Stripe's figure where recorded) and `stripe` (live account balance,
  available + pending, and test/live mode). **`POST /api/admin/payments/:id/sync`** re-reads
  one purchase from Stripe: use it for rows paid before this change.
- Dashboard → Payments: a Revenue panel (recorded totals, Stripe balance, mode) and a
  "Stripe charged" column with the receipt link; a mismatch with our price shows in red.
  A Sync button per row.
- Checked: the configured key is a **test-mode** account; balance call works
  (pending USD 482.98 from test payments, available 0).
- Stripe CLI installed at `E:\tools\stripe` (user PATH). Newer CLI needs `--events`:
  `stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired --forward-to localhost:3000/api/webhooks/stripe`.

## Session 2026-09-26: sign-in no longer blocks on an incomplete draft

- **Bug**: after sign-up, `AuthComplete` created the draft event from the occasion in
  `sessionStorage`; if a required detail was missing (e.g. an occasion picked but the
  details step skipped) the server answered 400 "Bride's first name is required" and
  the boot screen showed "We couldn't finish setting up your account" with no way on.
- **Fix** (`lazofrontend/src/pages/auth/AuthComplete.jsx`): the account sync still
  blocks on failure, but a 400 from creating the event now opens `/dashboard` with a
  router-state notice. The draft is kept, so "Finish the details" goes to `/start/details`.
- **New**: `SystemBanner` in `Dashboard.jsx` (`.dash-banner`, warning / info tones),
  fed by `location.state.notice = { tone, title, message, action: { label, to } }`.
  Dismissing clears the history state so a reload doesn't bring it back.

## Session 2026-09-26: Images inventory in the admin dashboard

- **New dashboard section "Images"** (`/dashboard#media`, admin only): every file in
  Storage with a thumbnail, path, bucket, MIME type, size and upload date, plus a
  per-bucket summary (file count, bytes, whether the bucket exists yet). Filter by
  bucket or path, sort newest / largest / by path. Read-only: images are still
  managed from the section that owns them (Themes, Homepage, Vendors, event sites).
- **`GET /api/admin/media`** (`src/admin/media.service.ts`, `media-admin.controller.ts`)
  walks the five buckets recursively via the Storage API (`list` is one level deep
  and pages at 1000, so folders are descended and pages followed). Sizes come from
  the object metadata, so there is no table to migrate.
- Verified against the live project: 11 files, 4.5 MB, across 4 existing buckets;
  `vendor-media` does not exist yet (no vendor upload so far).
- The API on :3000 was running as a plain `node dist/main` from a terminal (not PM2),
  so it was rebuilt but **not restarted**; restart it to get the route.

## Session 2026-09-26: chat delivery hardening and lower resource use

Investigated "admin reply not reaching the frontend": the API stream, the Vite proxy and a headless-browser run of the real widget all deliver within a second. The reply in question was sent in the same minute the API restarted and frontend files were changing (HMR), so the visitor's tab was reconnecting. Fixed the gaps that made that lossy:
- **Replay on reconnect:** when the stream comes back, open threads refetch from their last message and the inbox reloads (`reconnect` event). Before, anything sent during a gap was never shown until a 30 s poll.
- **Fallback always starts** when the stream is down (previously skipped if the very first attempt failed).
- `ChatNotifier` no longer re-creates the connection when Clerk's `getToken` identity changes.

Resource use:
- **Visitors open no stream** until they open the widget or already have an open thread; signed-in users keep one idle connection per tab (a few bytes every 25 s).
- Inbox refreshes are coalesced (one per 1.5 s), the admin dashboard's list/thread refreshes are coalesced (0.8–1.5 s), polls run only while the stream is down (10 s), and threads' own polls are 30 s safety nets.
- Server: one in-memory listener per open stream; publishing is a loop over the thread's participants. No timers per conversation.

Dev note: editing chat client files while a tab is open leaves the old module streaming and the new one idle (HMR duplicates module state). Hard-refresh the tab after frontend edits; production builds have no HMR.

## Session 2026-09-26: live-chat details (tawk.to style)

Migration `20261006000000_chat_live.sql`. On all three sides (visitor/guest widget, host and vendor inbox, backend dashboard):
- **Presence:** online = a live stream is open. `GET /api/chats/presence?vendorId=` (support and a vendor); every thread returns `peerOnline`; streams also carry `presence` events for admins. The widget shows "Online now" or "Offline — leave a message", and when support is offline a first message needs an email.
- **Typing** (`POST …/:id/typing`, throttled to one per 2.5 s, exempt from the write limiter) and **seen** (`read` events when the other side opens the thread).
- **Visitor context:** page URL, language, screen and browser sent with each visitor message (`context`), shown to staff in the thread header.
- **Canned replies** (`chat_shortcuts`): admins share one set (managed in the dashboard's Chats section), vendors have their own (Chats tab). Typed as `/name` in a reply; Tab inserts the first match.
- **Greeting bubble** after 8 s, once per session. **Rating** (1–5 + note) and **emailed transcript** (Resend) once a chat is closed; ratings show on the admin list and thread.
- **Assign:** an admin can "Take this chat" (`assigned_to`) so two agents don't answer the same visitor.
- Names: admin and vendor messages show the sender's first name from the users mirror.

## Session 2026-09-26: realtime chat

- **Live delivery** by server-sent events: `GET /api/chats/stream` (session; admins also get the `admin` channel) and `GET /api/public/chats/stream` (visitor token). `ChatEventsService` is an in-process bus keyed by user id; `send()` publishes to the thread's participants and admins, new threads publish `conversation`. Pings every 25 s. One PM2 process is fine; several would need Redis pub/sub.
- **One client per tab** (`src/chat/client.js`, mounted by `ChatNotifier` on every page and on event sites): opens the stream with `fetch` + Authorization (EventSource can't send headers), reconnects with backoff, and falls back to polling every 10 s only while the stream is down. It deduplicates by message id and is the **only** thing that rings — which fixes the double chime (the background watcher and the open thread each rang before). A thread that is on screen and focused doesn't ring; messages this tab sent never do.
- Inbox list, threads and the widget subscribe to the client and refetch on events; their own polls are now 30–60 s safety nets that pause while the stream is connected.
- Backend dashboard: same stream; rings once per non-admin message and refreshes the Chats section on events.

## Session 2026-09-26: chat alerts

- `src/chat/notify.js`: a synthesised two-tone chime (Web Audio, no file), a browser Notification when the tab is in the background, and a "(n)" badge in the tab title. Sound is armed by the first click or key press, as browsers require; a mute toggle (🔔/🔕) in the inbox is remembered in localStorage. Notification permission is asked only when someone opens a chat.
- `ChatNotifier` polls the inbox every 15 s on every page and on event sites (signed-in inbox or the visitor's public inbox) and rings when the unread total goes up. Open threads ring on their own poll for incoming messages; a 1.5 s throttle stops double rings.
- Backend dashboard: same chime and title badge when unread conversations grow (polls `/api/admin/chats` every 15 s).
- **Open:** no email/SMS/push when the person is not on the site at all.

## Session 2026-09-26: looks

- **Backend dashboard:** white theme (dark mode removed), white sidebar with a coloured icon tile per section (`TINTS` in `dashboard.html`), tinted active item, stat tiles with a coloured top edge and staggered entrance, panels fade in.
- **Frontend:** `src/accents.css` (loaded from `main.jsx`) adds a seven-colour palette by position: coloured stat tiles, icon tiles on the event overview's tool links, striped builder cards, gradient tabs and primary buttons, hover lifts on cards, coloured seating tables and inbox avatars. No markup changes; it styles the existing classes.
- **Fixed:** the builder's step progress line replayed from zero on every step. It now remembers its last position across page changes and slides from there (`BuilderLayout.jsx`, `lastProgress`).

## Session 2026-09-26: chat for everyone

A floating chat button on every page (`src/chat/ChatWidget.jsx`, mounted in `App.jsx` and on public sites):
- **Signed in:** the inbox in a panel (vendor threads, support, guest questions), with "Open inbox" for the full page.
- **Not signed in:** a support chat with Lazo. The browser gets a random token (`localStorage lazo.visitor`, sent as `X-Visitor-Token`); the server stores only its hash as `customer_id = visitor:<hash>`. Name and email are optional.
- **Event sites:** "Ask the hosts", a third conversation kind `guest` (event + `host_id`), private between that guest's browser and the host. Hosts see them in their inbox; on private sites the site token is required too.

Public routes: `GET/POST /api/public/chats`, `GET /api/public/chats/:id`, `POST /api/public/chats/:id/messages` (60 writes per 10 min per IP). Messages carry roles `host` and `guest` in addition to customer/vendor/admin; the JSONL log records them the same way.

**Caveat:** a visitor who clears their browser storage loses access to their thread (nothing links it to a person). Admins can still see and answer it, and the email they left, if any, is shown.

## Session 2026-09-26: chat

One chat system, two kinds of conversation (`conversations.kind`):
- **vendor** — a host and a vendor, about one event (one open thread per host + event + vendor). Started from "Message" on a listing in Find vendors, or from the vendor directory once signed in. Admins can read and reply in any.
- **support** — anyone (host or vendor) with Lazo. "Chat with Lazo" in the inbox reuses the open support thread.

Pages: `/dashboard/chats` (hosts), the "Chats" tab on the vendor dashboard (same component, embedded), Inbox link with an unread badge in the dashboard header, and backend dashboard → Chats (every conversation, reply as Lazo, filters by kind).

Delivery is polling (thread every 4 s, inbox every 10 s, only while the tab is visible), so it works on one PM2 process with no sockets. Reads are tracked per participant (`conversation_reads`); unread = messages by others after that.

**Training corpus:** every message is appended to `<CHAT_LOG_DIR>/<conversationId>.jsonl` (default `lazobackend/data/chats/`, gitignored) as `{ conversationId, kind, eventId, vendorId, messageId, senderRole, sender (HMAC-hashed id), body, createdAt }`. Admins download it all with `GET /api/admin/chats/export` (`?anonymize=1` also drops event and vendor ids). The message text itself can still contain names and phone numbers; scrub before training. The privacy page says chats may be used to improve Lazo.

**Open:** no push/email notification of new messages (only the badge), no attachments, no typing indicator.

## Session 2026-09-25 (night): paid plans, messaging, photos, seating, print & travel, Spanish

All new tables are in `20261003000000_tiers_messaging_photos.sql`. Everything below degrades to a 503 naming that file until it is applied.

**Paid plans (Stripe Checkout)** — `src/payments/`
- Plans are `services` rows `tier_premium` (MXN 2,499) and `tier_signature` (MXN 8,999): the low end of the business plan's ranges. Editable in the backend dashboard → Payments. `events.tier` null = free.
- Flow: `POST /api/events/:id/checkout { product }` → Stripe hosted Checkout (card; OXXO and SPEI when enabled in the Stripe dashboard) → back to `/dashboard/events/:id?checkout=cs_…` → `POST /api/checkout/confirm` reads the session and applies the plan. The webhook `POST /api/webhooks/stripe` does the same for async payments (OXXO) and is idempotent with the confirm.
- Records: `payment_attempts` (flow `event_fee`, gateway `stripe`), one per Checkout session.
- Gates: Premium = email/SMS messaging, custom domain request, no Lazo branding on the site. Signature = Premium + print runs and travel help by Lazo.
- **Not done:** guest money never goes through Lazo (by design, business plan §2). Mercado Pago / Conekta are not wired; the service is Stripe-only.
- Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_URL`.

**Messaging** — `src/messaging/`, page `/dashboard/events/:id/messages`
- Email via Resend, SMS via Twilio, WhatsApp = the per-invitation `wa.me` links on the guest list (no provider).
- A message picks a channel and audience (everyone / awaiting / attending / declined), with `{name} {link} {event} {date}` filled per household. The page shows how many invitations are reachable before sending.
- Rows: `messages` (the campaign) and `message_deliveries` (one per household, with the provider id or failure). Consent rows are written to `message_consents`; recipients with `opted_out_at` are skipped. **Open:** no inbound STOP handling yet (Twilio handles carrier-level STOP).
- Env: `RESEND_API_KEY`, `MESSAGE_FROM_EMAIL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. `GET /api/messaging/config` says which are set.

**Photo gallery** — `src/photos/`, page `/dashboard/events/:id/photos`
- Hosts upload (approved at once); guests upload from the site or the QR code (`<site>/?upload=1`), pending until approved (PHOTO-2). EXIF/XMP/IPTC is stripped from JPEG, eXIf/text chunks from PNG, EXIF/XMP from WebP before storage (PHOTO-1, `src/common/strip-metadata.ts`).
- Bucket `event-photos` (public, random paths; only approved photos are listed). `events.gallery_open` switches guest uploads.
- Public: `GET/POST /api/sites/:slug/photos` (token-gated on private sites, 30 uploads per 10 min per IP).

**Seating** — `src/seating/`, page `/dashboard/events/:id/seating`
- Per celebration: tables (name, seats, shape) and assignments. Only guests whose household is invited to that celebration appear. "Seat attending guests by household" fills tables household by household.
- SEAT-1: a guest who declines after being seated is flagged (`needs_review`), shown in amber, never removed.

**Print & travel** — `src/concierge/`, page `/dashboard/events/:id/concierge`
- Print-it-yourself (free): `/print/:id/invitation|save-the-date|menu|thank-you`, built from the event with a QR code to the site; the browser prints or saves a PDF.
- Lazo concierge (Signature): print runs and travel help as `concierge_requests`; admins move them through requested → in_progress → quoted → done in the dashboard → Concierge, with a note and a quote. No print or travel partner is integrated; Lazo fulfils by hand.
- Custom domain (Premium): requested here too; `events.custom_domain` + status. DNS is set up by hand; marking the request done sets the status to active. **Open:** the frontend still only serves `<slug>.SITE_DOMAIN`; serving a custom domain needs the hosting layer to route it.
- "Getting there" (airport, transport, parking) lives on Event Info next to Where to stay, as `site_content.travel`.

**Spanish** — `src/i18n/` (frontend)
- `t('English source text')` with a Spanish dictionary (`es.js`). The header globe toggles the language (remembered in localStorage; first guess from the browser). Public sites follow the event's `locale`, not the visitor.
- Translated: homepage, header, footer, pricing, vendor directory, help/terms/privacy, the create flow shell, builder shell, and everything guests see (password gate, RSVP, gifts, upload, red theme labels). **Not yet:** the inside of the host dashboard pages (guests, planning, messages…) and the vendor dashboard are English-only.

**Public pages:** `/pricing` (plans from the services table), `/vendors` (approved vendor directory, `GET /api/vendors/directory`), `/help`, `/terms`, `/privacy` (drafts, marked for legal review; the help form writes to `VITE_SUPPORT_EMAIL`).

**Backend dashboard:** Payments (prices + purchases) and Concierge sections.

**Open:** Mercado Pago/Conekta, inbound SMS opt-out, custom-domain routing, dashboard-page translations, printing/travel partners.

## Session 2026-09-25 (late): the MVP from the business plan

The PRD file (`LAZO_PRD_v1.2 (1).pdf`) is empty (0 bytes). Scope came from `~/Downloads/LAZO_Comprehensive_Business_Plan_2026.pdf` §4.1 "Recommended MVP Scope", with Zola as the reference product.

| MVP item | Built |
|---|---|
| Account creation and event setup | (before) |
| Public or password-protected event pages | Go Live: publish/unpublish by the host (free), and an optional site password. The password is scrypt-hashed; guests get an HMAC token (`X-Site-Token`) that every public site route checks. |
| Guest list and RSVP collection | `/dashboard/events/:id/guests`: households with invite codes, guests, plus-ones, tags, invited-to per celebration, CSV import/export, deadline and open/closed, host-entered answers. Guests RSVP on the site with their invite link (`?rsvp=CODE`) or their full name (exact, accent-insensitive match; one household only; rate-limited). Answers are per guest and celebration, with menu choice and allergies. |
| Universal registry plus cash fund | Gift step: store links and cash funds, plus bank details (CLABE) for transfers. Guests report "I bought this" or "I sent my gift" (`gifts.source = 'guest_report'`); the host ticks off thank-yous. **No payment provider yet**: no money moves through Lazo. |
| Basic checklist and budget | `/dashboard/events/:id/planning`: checklist (optional suggested tasks per occasion from `checklist_templates`, dated back from the event date), budget total and lines (estimate, actual, paid). |
| Vendor profiles and inquiry forms | "Request a quote" on Find vendors (stored in `quotes`); the vendor answers in a new "Quote requests" tab with a message and optional price; the host sees replies. |
| Premium templates, custom domain, paid tier | **Not built.** Needs a payment provider and your tier prices (the plan lists Essential 899–1,199, Premium 2,499–4,499, Signature 8,999–17,499 MXN as indicative). |
| Analytics dashboard for hosts and vendors | `/dashboard/events/:id` (was "coming soon"): site views over 30 days (`site_views`, counted per page load), invitations answered, attending, checklist, gifts, vendor replies, plus links to every tool. Vendors already had views and picks. |

**Builder:** Story (cover photo, story text and photo, Q&A), Gift, Invitation (wording with live preview, share link and WhatsApp, pointer to personal links) and Go Live (checklist, address, password, publish) are built. "Where to stay" sits on Event Info.
- Photos go to the public `event-media` bucket (8 MB, type checked by content). Site content only accepts photo URLs from this event's folder.

**Red theme:**
- Cover photo behind the hero, the invitation message, Our Story, Where to Stay, a registry with "I bought this" / "Contribute" / "See bank details", and Q&A.
- The nav shows only sections that have content.
- RSVP buttons open the RSVP dialog, in theme colours. They are hidden while RSVPs are closed or there are no celebrations.

**Backend dashboard:** new "Activity" section (`GET /api/admin/activity`): per-event views, invitations, guests, attending, registry, gifts, tasks and quotes. Missing migrations are named.

**New backend modules:** `src/guests/`, `src/site-content/` (content, publishing, password, registry), `src/planning/` (checklist, budget, stats, inquiries, admin activity).

**Rate limits added:** RSVP lookups and answers (40 per 10 min per IP); unlock and gift messages (20 per 10 min).

**Still to do (not started):**
- Payments and paid tiers (provider plus prices).
- Email/SMS/WhatsApp sending (a provider is needed; WhatsApp share links work today).
- Photo gallery with guest QR uploads (`photos` table exists).
- Seating chart (`seating_tables` exists).
- Spanish UI.
- Printing, travel booking.

## Session 2026-09-25: site builder — Ceremony Info and Event Info

The site builder now runs **Theme → Ceremony Info → Event Info**, then back to the dashboard. The shell is `src/pages/builder/BuilderLayout.jsx`:
- Top: logo and a close button (X, to the dashboard).
- Right: the couple photo (`assets/builder-side.jpg`, cropped from the mockup) with "I'm just browsing".
- Bottom: Back · stepper · Next. The stepper (`steps.js`) is Topic · Theme · Ceremony Info · Event Info · Story · Gift · Invitation · Go Live. Built steps are clickable; Story onward show as coming soon.
- Picking a theme now continues to Ceremony Info (it used to go to the dashboard). "Edit Site" on the dashboard and the old `/start/:id/editor` both open Ceremony Info.

**Ceremony Info** (`/start/:id/ceremony`)
- The families come from `event_modes.family_sections` (boda: groom and bride; xv, bautizo, graduacion: one family; corporate and memorial: none, so the step is skipped).
- Each section's own name is a `details` field (`nameKey`, e.g. partner2 = groom), so renaming here renames everywhere.
- Father, mother and address are saved in `events.families` (via `PATCH /api/events/:id { details, families }`).
- **Addresses are never public**: the site only gets names.

**Event Info** (`/start/:id/events`)
- Sub-events (`sub_events`) as cards, with an add/edit modal: type, date, guests-arrive time, begins time, total guests. The card menu has Edit, Select/Change venue and Delete.
- Types come from the new `sub_event_kinds` table, per occasion. `sub_events.kind` now references it instead of a fixed check.
- Times are stored as the host typed them (`event_date`, `arrive_time`, `begin_time`). `starts_at` is derived in the event's timezone (`zonedToUtc`).
- **Venue picker:** approved vendor locations (`GET /api/marketplace?type=location`, with search and a capacity warning), or a venue the host types in, or remove.
  - Picking a vendor venue copies its name, address and photo onto the sub-event, and records a `vendor_selections` pick, so the vendor sees it.
  - The API only accepts approved, active locations of active vendors.
- Guest counts are private (not in the public site payload).

**Red theme**
- Parents come from the families.
- The framed "… info" block features the reception, or the first celebration, with its own date, arrival and start times.
- New **"More … events"** cards cover the rest: venue photo, date, time, place, "View Direction" (Google Maps), a per-celebration .ics, and RSVP (still disabled).

**Not built yet:** Story, Gift, Invitation and Go Live steps; RSVP.

## Session 2026-09-25: homepage

**Full homepage** (`src/pages/home/`), built from the long mockup: hero, occasion cards, "Choose what your site includes", vendors, the start band, gift methods, and the footer.

| Section | Data |
|---|---|
| Occasion line and occasion cards | `GET /api/event-types`. The new `description` and `image_url` columns on `event_modes`. A card preselects the occasion and opens `/start/details`. |
| Choose what your site includes | Static product copy in `homeContent.js`. Only Dress code has a photo (cropped from the mockup); the other cards use a tone colour until photos are supplied. |
| Find and book the best vendors | `GET /api/home/vendors`: up to 4 `active` vendors (name, department, city). No ratings or price levels exist, so none are shown. Empty state until vendors are approved. |
| Your event starts here | The `custom_domain` service row ($300 MXN, seeded by the migration). The sentence is hidden if the row is missing. |
| Guests give however they like | Static copy (OXXO, SPEI, installments, cash funds). **Payments are not built.** |
| Footer newsletter | `POST /api/newsletter` → `newsletter_subscribers` (lowercased, unique, 10 per IP per hour). |

- **Backend:** `src/home/` (HomeService, HomeController, HomeAdminController).
- **Admin:** new dashboard section **Homepage**. Edit card descriptions, upload card images (to the public `site-media` bucket, created on first upload), and see newsletter sign-ups.
- **Seed images:** `supabase/seed/occasions/*.jpg`, cropped from the mockup with the baked-in text removed, for boda, xv and bautizo. `primera_comunion.jpg` is kept for when that occasion exists. Upload them with `node scripts/seed-occasion-images.mjs`, after the migration. It skips occasions that already have an image.
- The mockup lists Quinceañeras, First Communions and Birthdays; event_modes has XV Años, Graduation, Corporate and Memorial. Adding occasions is a row change, and each new occasion also needs its form `fields`.
- **Left out** (no data for them): social links, the Mexico/USD pickers (a static "Mexico · MXN" is shown instead), and the footer's example-site link.
- **Copy to review:** the vendor text promises ratings and protected payments, which aren't built yet.

**Motion pass (same day):**
- **Sizing:** desktop scaled down about 20%. The mockup is @2x; it now fits a 1366–1600px laptop at 100% zoom.
- **Page transitions:** `src/motion/TransitionRouter.jsx` replaces `BrowserRouter`. Every pathname change (Link, `navigate()`, back/forward) runs through `document.startViewTransition`: the old page lifts away and the new one settles in, and back reverses the direction. The CSS is in `index.css` (`::view-transition-*`). The marketing header has `view-transition-name: site-header`, so it stays put between marketing pages. Query-only changes don't animate. New pages open scrolled to the top.
- **Click effects:** `src/motion/ripple.js` (installed in `main.jsx`) adds a ripple to every `.btn` and `[data-ripple]`. All `.btn`s now lift on hover and press in on click; primary buttons get a sheen.
- **Homepage:**
  - The hero plays a word-by-word title, staggered copy, and a photo zoom-in with a parallax on scroll (`motion.js` `useParallax`). There's a candle glow and a scroll cue.
  - The header is sticky and turns solid on scroll; its slide-in plays once per visit.
  - Sections reveal on scroll (`data-reveal`, `useReveal`, which also catches cards loaded later).
  - Feature carousel: a sliding tab pill, dimmed neighbours, and autoplay every 5.5s with a timer bar. Autoplay pauses on hover/focus, only runs in view, and stops once the visitor interacts.
  - Hover lifts on cards; the dots are clickable.
- `prefers-reduced-motion` turns all of it off.

**Earlier the same day:** hero only.

- `/` is now the public homepage (`src/pages/home/Home.jsx`), built from the dark hero mockup. It replaces the old `HomeRedirect`, which was deleted. Signed-in users see their avatar, which links to `/dashboard`; signed-out users see "Log in".
- The occasion line is `GET /api/event-types` (event_modes labels, joined with " - ").
- "See an example" goes to `/themes`, a public gallery built from `GET /api/themes`.
- The shared marketing header is `src/pages/home/SiteHeader.jsx`: Home, Vendor (`/vendors`, ComingSoon), I'm a vendor (`/vendor`), Pricing (`/pricing`, ComingSoon), a hamburger below 860px.
- **Open:**
  - "Español" is shown disabled; there is no i18n yet.
  - `src/assets/home-hero.jpg` was cropped from the mockup screenshot. Replace it with the original photo for full resolution.
  - The mockup lists plurals ("Weddings…"); event_modes labels are singular.

## Session 2026-09-25: security review

Everything below is fixed and tested unless marked **open**.

**Data exposure**
- Supabase direct access: probed every table with the public (publishable) key. All return 0 rows and inserts are refused (RLS on everywhere). Pending migrations also enable RLS.
- Leaked `lazo_sk_` key (admin account, `LAZOFRONTv1`, in the public bundle): removed from `.env.local`, **revoked** in `api_keys` (`revoked_at` set; clearing it would restore it), bundle rebuilt and scanned for `lazo_sk_`, `sb_secret_`, `sk_`, `whsec_`: none.
- 5xx responses no longer include database or provider messages. `HideInternalErrors` (`src/common/http-hardening.ts`) logs the detail with a reference and returns a generic message. 4xx responses and the dev-only 503 "apply migration" hints are unchanged.

**Access control**
- Admin routes now **refuse API keys** (`roles.guard.ts`). Keys act as their owner for normal routes only, so a leaked admin key can't approve, delete or publish.
- Clerk `authorizedParties` is set (`main.ts`): only session tokens minted for `CORS_ORIGINS` + `DASHBOARD_ORIGINS` are accepted.
- CORS: the app origins get credentialed access; event-site subdomains get uncredentialed access only; other origins get nothing.
- Bug found along the way: an **empty `CORS_ORIGINS=` in `.env` overrode the defaults** (`??` → `||`), which locked out built frontends. Same fix for `DASHBOARD_ORIGINS`.

**Injection / XSS**
- `registry_items.external_url` / `image_url` were free text in `/api/v1` (a `javascript:` link would run on the public site). There is a new `url` field type, https-only (`dynamic.service.ts`).
- A vendor could set `logo_url` to anything through `PATCH /api/vendor/me`. Now only an upload sets it.
- Frontend `src/safeUrl.js`: `safeUrl()` for data-driven links and images (http(s) only), `cssUrl()` for CSS `url()`, and `samePath()` for the post-sign-in redirect. The old check let `/\evil.com` through as an open redirect.

**Uploads**
- File type is checked from the file's bytes (`src/common/image-type.ts`), not the client's Content-Type: only real JPEG/PNG/WebP reach the public buckets.
- `multer` (via `@nestjs/platform-express`) had 4 high advisories (DoS, size-limit bypass). Upgraded to platform-express 12.1.0 / multer 2.4.0; production audit is clean. 5 dev-only advisories remain (not shipped).

**Abuse**
- Security headers on every response: nosniff, `X-Frame-Options: DENY`, referrer policy, permissions policy; `Cache-Control: no-store` on `/api`; HSTS in production over https.
- In-memory rate limits per IP: 600 req/min on `/api`, 60 writes/min, 30 uploads per 10 min; 429 with `Retry-After`. Webhooks are exempt.

**Reviewed, fine as is**
- Roles come only from Clerk public/private metadata, never from anything the browser sends.
- API keys are stored as SHA-256 hashes and compared in constant time.
- Every owner route scopes by `owner_id` or `findOneFor`.
- `.env` files are gitignored.
- The product scraper (`product-scraper.ts`, admin-only) blocks private addresses on every redirect hop.

**Open (lower risk)**
- The scraper checks DNS and then fetches, so a DNS-rebinding host could still swap addresses in between. It is admin-only; to close it, pin the resolved IP in the fetch.
- No Content-Security-Policy yet. The dashboard's inline script and Clerk CDN need a tuned policy; add one with nonces.
- Rate limits are per-process and in memory. With several instances, move them to Redis and set Express `trust proxy`.
- Public sites expose everything in an event's `details` once it is live. That is fine for names, but keep private answers out of those fields.

## Session 2026-09-24 (later): Lazo's own products

Admin → Vendors → **Own products** tab (`OwnProducts` in `public/dashboard.html`).
- **Two sale types.** *Affiliate link*: paste the link, press **Read details**, and the name, description, image, price and currency are filled in from the store page for the admin to check before saving. *Direct price*: Lazo sells the product itself, and the price is required.
- **Scraper** `src/vendors/product-scraper.ts` uses no new dependencies. It reads JSON-LD Product, then OG and product meta, then microdata, then Amazon markup. It follows redirects by hand and blocks private IPs at each hop. After a robot check it retries as a link-preview crawler (`facebookexternalhit`), which Amazon serves. It warns when a link lands on a category page or the page shows no price.
  - Tested 2026-09-24: amazon.com.mx works (title, full-size image, bullets, MXN price). amazon.com got everything except the price, which isn't shown to our region. Shopify stores (allbirds.com) work through JSON-LD. Mercado Libre, Walmart MX and Coppel block every request from this network, so the admin gets a clear message and enters the details by hand.
- **Refresh price** re-reads an affiliate link and updates the price (and the image if the product has none). The name and description are left alone.
- **Host side:** Find vendors lists these products as `type: 'lazo'`, labelled "Sold by Lazo" or "From amazon.com.mx", with a **Buy on … ↗** link (click counted, `rel="sponsored"`). They can be added to an event like vendor listings. The Kind filter has a "Lazo products" option.
- **Tables** (`20260927000000_lazo_products.sql`): `lazo_products`, `lazo_product_picks`, `lazo_product_clicks`. Until the migration is applied, the marketplace simply shows no Lazo products, and the admin tab says to apply the migration.
- Code: `src/vendors/lazo-products.service.ts`, `LazoProductsAdminController` in `vendors.controller.ts`, and marketplace changes in `marketplace.service.ts`.
- Not built: checkout for direct products (payments are still open item 6), and scheduled price refreshes.

## Session 2026-09-24

### 1. Fixed: occasion list not loading
- The backend had no CORS, so a built frontend (calling `:3000` directly) was blocked. Added `app.enableCors`, configurable with `CORS_ORIGINS` (`src/main.ts`).

### 2. Removed sample data; the occasion list comes from the database
- Removed example values from the old dashboard forms.
- New table **`event_modes`** (value, label, position, active). `events.mode` references it. `GET /api/event-types` reads it. It holds the six PRD occasions: boda (Wedding), xv (XV Años), bautizo (Baptism), graduacion (Graduation), corporate, memorial.
- The events API now returns every column (`mode`, `state`, `visibility`, `slug`, …).

### 3. Sign-up / log-in (Clerk custom UI, matching the barn-photo mockups)
Frontend `src/auth/*`, `src/pages/auth/*`:
- `/signup`: Google/Apple buttons (only the ones enabled in Clerk), email, MORE OPTIONS.
- `/signup/email` (names, email, password) → `/signup/check-email` (Open Gmail for Gmail addresses) → `/signup/verify` (6-digit code).
- `/login` (password + providers), `/login/verify` (new-device email code), `/login/reset` (password reset by code).
- `/sso-callback`, then `/auth/complete`. That page syncs the user, creates or reuses the draft event, and routes on.
- Signed-in visitors to the auth pages see "You're already signed in", with Continue or Use a different account.
- Backend: `public.users` mirror (`src/users/*`), `POST /api/users/me/sync`, `GET /api/users/me`, and a Clerk webhook `POST /api/webhooks/clerk` (Svix-verified; `rawBody` is on in `main.ts`).

### 4. Create flow after sign-in
- **Details step** `/start/details` (before sign-up). The questions come from `event_modes.fields`: a wedding asks for the bride's and groom's first names, XV Años for the quinceañera's name, and so on. Every occasion also asks for a date (with a **Decide later** button) and a city or venue. Answers wait in `sessionStorage` (`lazo.draft`) and are saved in one step at sign-up.
- The server names the event from `name_template` ("Rajib & Jerin wedding") and picks the first subdomain from `slug_template` (`rajib-jerin`, then `-2`, `-3` if taken; accents stripped; reserved words get the occasion appended). Code: `src/events/event-details.ts`.
- `/start/:eventId/website`: "How would you like to create your {occasion} website?", with a toast.
  - **Build your site** → `/start/:id/theme`.
  - **Request a Customize theme** → saves a `custom_theme_requests` row at the price in `services` (`custom_theme` = 59900 centavos MXN) → `/start/:id/custom`.
- `/start/:id/theme` lists active themes with an image for the event's occasion. Picking one saves `events.theme_id` and goes to the dashboard.
- Migration `website_builder`: `themes` (empty until an admin adds some), `services`, `events.build_type` / `events.theme_id`, `custom_theme_requests`.

### 5. Host dashboard (frontend `/dashboard`)
- One card per event: theme image, name, occasion, status line, web address with copy and **Edit** (live availability check), and Go to website (live sites only).
- The ••• menu has **Edit Site** (resumes the first unfinished step), **Find vendors**, and **Delete**.
- The "Try Lazo Build Your Site" side card can be dismissed.
- Header: For vendors, Help, Account Settings (Clerk profile), and an avatar menu with Sign out.
- `/` sends signed-in users to `/dashboard` and everyone else to `/start`.

### 6. Subdomains and public sites
- `SITE_DOMAIN` + `SITE_SCHEME` (`src/sites/site-config.ts`). Subdomain rules: 3–63 characters, lowercase letters, digits and single hyphens, unique, platform words reserved. An event needs a subdomain before it can go live.
- **Sites are rendered by the frontend.** `src/main.jsx` checks the hostname: on a subdomain it renders `src/site/PublicSite.jsx`, otherwise the app. Data comes from `GET /api/sites/by-slug/:slug` (live events only; `404` with `reason: missing | unpublished`).
- The backend does **not** route by Host header. That was tried first and removed at the user's request.

### 7. Red Theme (`themes.slug = redtheme`, id `7097eea7-…3b71`)
- `lazofrontend/src/site/themes/red/`: `RedTheme.jsx`/`.css` plus the gold ornaments cut out of the mockup (`floral`, `corner`, `knot`, `side` PNGs). Themes are registered by slug in `src/site/themes/index.js`. A slug with no entry uses the default page.
- Uses real data only: names from `details`; date and location from the event; ceremony and reception from `sub_events`; registry from `registry_items`; a Google Maps embed and an Add to Calendar `.ics` when an address or date exists. Missing values show the design's "—".
- **RSVP is disabled** ("opens soon"). **Story, Where to Stay and Theme Customize** are not shown until their data or the editor exists.
- Event `imran-mew` ("IMRAN & MEW wedding") uses this theme and is still a draft. Publish it from admin → Sites to see it at `http://imran-mew.localhost:5173`.

### 8. Backend admin dashboard (`lazobackend/public/dashboard.html`, one file, hash routes)
- **Everyone:** Overview, Events (with a subdomain editor dialog), API keys.
- **Admins:** Admin (all events: filters, change state or publish, subdomains), **Vendors** (applications, listings, promotions, all vendors), Sites (domain settings, publish or unpublish), Users (the `public.users` mirror), Custom requests (status), **Themes** (add or edit, image upload to the `theme-previews` bucket, show or hide).
- Tile numbers use lining digits; the serif old-style digits read as "I"/"O".

### 9. Vendor marketplace (latest; migration `vendor_marketplace` **not applied yet**)
Scope comes from the business plan: vendor profiles and verification, launch categories, promoted placement (no price set yet, per the plan), and lead attribution.
- **Tables:** `vendors` extended with contact details, review fields and one profile per account; `vendor_packages` (products) extended with image and review status; new `vendor_locations`, `vendor_promotions`, `vendor_selections` (host picks), `vendor_listing_views` (unique per viewer, listing and day).
- **Lifecycle:** vendor `candidate → pending_approval → active | rejected` (with a note) `| paused`. Listings go `pending → approved | rejected`, and any content edit sends one back to `pending`. Hosts only see approved, active listings from active vendors.
- **Vendor dashboard** at frontend `/vendor`, with tabs: Overview (picks, events, views, a per-listing table), Profile (plus Submit for approval), Venue locations, Products, Promote (7/14/30 days, reviewed by an admin).
- **Admin:** backend dashboard → Vendors, with tabs Applications, Listings, Promotions and All vendors. Rejecting needs a reason.
- **Host side:** event ••• → Find vendors (`/dashboard/events/:id/vendors`). Filters by category, venue or product, city and text, with featured listings first. Opening Details records a view; **Add to my event** records a selection.
- Code: backend `src/vendors/*`, frontend `src/pages/vendor/*` and `src/pages/dashboard/FindVendors.jsx`.
- After a signed-out visit to a protected page (for example `/vendor`), sign-in returns there (`sessionStorage` key `lazo.returnTo`).

---

## Open items / next steps

1. Run `20260926000000_vendor_marketplace.sql` and `20260927000000_lazo_products.sql`, then add an affiliate product and a direct product and check them in Find vendors. Walk the vendor flow: apply → admin approves → host picks.
2. ~~Deal with the leaked `lazo_sk_` key~~ — done 2026-09-25. Security follow-ups: see "Open (lower risk)" in the 2026-09-25 session.
3. Put both projects under git and commit.
4. ~~Theme Customize / site editor~~ — done as the builder steps (2026-09-25). ~~RSVP and guest list~~ — done. ~~Anonymous drafts~~ — done 2026-09-26 (stream A).
5. Payments for custom themes and promotions (prices in `services`; promotion pricing not decided).
6. Production: real `SITE_DOMAIN` plus wildcard DNS to the frontend host; set `CLERK_WEBHOOK_SIGNING_SECRET`; Facebook and SSO in Clerk if wanted (the buttons appear automatically).
7. **Apply migrations `20260930000000` … `20261013000000`** (SQL editor, or set `DATABASE_URL` and `npm run db:migrate`), then restart the API.

**Needs the user (2026-09-26, PRD V1 gaps):**

- **`DATABASE_URL`** in `lazobackend/.env` (Session pooler URI): required for the analytics warehouse and for `npm run db:migrate`. Keep the `analytics` schema out of PostgREST's exposed schemas.
- **Stripe Connect** (stream B): enable Connect (Express, Mexico) in the Stripe dashboard, OXXO/SPEI if wanted; create two webhook endpoints on `/api/webhooks/stripe-connect` (Account events: payment_intent.succeeded, checkout.session.completed / async_payment_succeeded / expired, charge.refunded, charge.dispute.created/updated/closed; Connect events: account.updated) → `STRIPE_CONNECT_WEBHOOK_SECRET` (comma-separated); `APP_URL` in production. Live Express accounts need Lazo's own KYC in Mexico.
- **Meta WhatsApp** (stream C): Meta Business verification, a WhatsApp Business Account with a production phone number, a permanent System User token → `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`; register the webhook `/api/webhooks/whatsapp` with `WHATSAPP_WEBHOOK_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET`; submit and get the two templates approved (admin → WhatsApp → Submit, then Sync); a real opted-in recipient test before beta.
- **Mercado Pago** (stream E): production credentials (MXN account) → `MERCADOPAGO_ACCESS_TOKEN`; webhook `/api/webhooks/mercadopago` (topic Payments) → `MERCADOPAGO_WEBHOOK_SECRET`; `API_URL` in production; verify OXXO/SPEI availability on the account and edit `payment_gateways.methods` to match.
- **Retailer APIs** (stream D): Amazon Associates MX approved for the Product Advertising API → `AMAZON_PAAPI_ACCESS_KEY`, `AMAZON_PAAPI_SECRET_KEY`, `AMAZON_PAAPI_PARTNER_TAG`; Mercado Libre developer app → `MELI_APP_ID`, `MELI_CLIENT_SECRET`, and `retailers.affiliate_tag` once the affiliate program approves. Smoke-test with the first keys (`GET /api/retailers/amazon_mx/search?q=licuadora`).
- **Fulfilment partners** (stream D): contract at least one printer, one florist and one travel agency and add them in dashboard → Fulfilment (coverage, prices, terms); `RESEND_API_KEY` + `MESSAGE_FROM_EMAIL` for partner emails; `API_PUBLIC_URL` in production.
- **CFDI** (stream A): a PAC account (Facturama, SW Sapien…) if real stamping is wanted; the invoice UI already collects RFC / razón social / uso de CFDI.
- Eyeball `lazofrontend/src/pages/Details.jsx` once (rewritten in stream A after a truncated patch).
