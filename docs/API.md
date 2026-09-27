# Lazo API

Everything the backend exposes, as of 2026-09-24. Written for whoever builds the
frontend against it — there is no UI for the admin surface yet.

Base URL is the app itself (`http://localhost:3000` in development). All payloads
are JSON.

**`GET /api` returns this index live** — every route, its URL, what it needs, and
whether its payload is wrapped. It is read off the decorators at request time, so
it cannot drift from the real routing table. Start there rather than trusting the
tables below.

---

## Encrypted payloads

Bodies on `/api/*` can be wrapped in an authenticated envelope using a pre-shared
symmetric key (AES-256-GCM).

**This sits on top of HTTPS and does not replace it.** It is worth having for
server-to-server clients, where the key is genuinely secret: bodies stay
unreadable in logs, proxies and error trackers, and a captured envelope cannot be
replayed at a different endpoint. It buys nothing against a hostile browser user —
anything the browser can decrypt, its owner can too. The three HTML pages
therefore talk to the API in the clear.

### The envelope

```json
{
  "enc": "v1",
  "ts": 1790192266850,
  "iv": "Q172ErSrAESg6suL",
  "data": "QWGlEeK5Znn35LQ4fVFDeSZvSdiyUba0t/5qDLBAv4bXIiGO4UEb",
  "tag": "BQY29KOTuHuI66rs1YDilQ=="
}
```

`iv` is 12 bytes, `tag` is 16, both base64. `data` is the JSON body, encrypted.
`ts` is Unix milliseconds and is **authenticated** — editing it fails the tag
check. Payloads more than 5 minutes off the server clock are refused.

The GCM additional data is:

```
v1|<METHOD> <path>|<ts>
```

So an envelope is bound to one verb, one path and one instant. Move it and it
fails to authenticate rather than decrypting into the wrong handler.

### Calling an encrypted endpoint

Send the envelope as the whole body with the `x-lazo-encrypted: v1` header. The
reply comes back as an envelope too. On a `GET` there is no body to encrypt, so
the header alone opts the response in.

```js
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const key = Buffer.from(process.env.API_ENCRYPTION_KEY, 'hex'); // 32 bytes
const aad = (method, path, ts) => Buffer.from(`v1|${method} ${path}|${ts}`);

function seal(body, method, path) {
  const ts = Date.now();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(method, path, ts));
  const data = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
  return {
    enc: 'v1',
    ts,
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function open(envelope, method, path) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(aad(method, path, envelope.ts));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]).toString('utf8'),
  );
}

const path = '/api/events';
const res = await fetch(`http://localhost:3000${path}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-lazo-encrypted': 'v1',
    Authorization: `Bearer ${clerkSessionToken}`,
  },
  body: JSON.stringify(seal({ name: 'Ana & Mateo', type: 'wedding' }, 'POST', path)),
});

const event = open(await res.json(), 'POST', path);
```

Note the path passed to `open` is the **request** path — the response envelope is
bound to the same call, not to a separate response path.

### Modes

`API_ENCRYPTION_MODE` controls how strict the server is:

| Mode | Behaviour |
|---|---|
| `off` | Nothing is wrapped. Also the automatic fallback when no key is set. |
| `optional` | Default. Wrapped when the client opts in; plain requests still work. |
| `required` | Plain requests to `/api/*` are rejected with `400`. |

Two routes stay in the clear in every mode, because a client must be able to reach
them before it can encrypt anything: `GET /api` and `GET /api/auth/config`. Mark
others with `@PlainPayload()` if you ever need the same, but never put anything
user-specific behind it.

Authentication is unaffected either way: Clerk verifies the bearer token from
headers before any decryption happens, so a wrong key gives `400`, not `401`.

### Failures

All `400`, with deliberately uninformative messages — a caller learns that the
payload was bad, not which part:

| Message | Cause |
|---|---|
| `Encrypted payload could not be verified` | wrong key, tampered body, or an envelope captured from another route |
| `Encrypted payload has expired` | `ts` more than 5 minutes from the server clock |
| `Encrypted payload has a malformed iv` / `tag` | wrong byte length |
| `Encrypted payload was not valid JSON` | decrypted fine but the plaintext was not JSON |
| `x-lazo-encrypted was sent but the body is not an encrypted envelope` | header set, body plain |
| `This endpoint requires an encrypted payload...` | `required` mode, plain request |

Replay of the *same* envelope at the *same* route within the freshness window is
still possible — there is no used-nonce cache yet. Add one if that matters.

---

## Authentication

Clerk owns authentication. Supabase is only the database, and the browser never
talks to it directly.

Every route is protected by default. A route is open only if it is explicitly
marked public — currently `/`, `/login`, `/dashboard`, `/event` and
`GET /api/auth/config`.

There are two ways to prove who you are. Both land on the same user, so every
route behaves identically either way.

### API keys

For anything that is not a browser. Send the key as a header:

```
x-api-key: lazo_sk_...
```

A key **acts as the user who created it** — same events, same admin role if its
owner has one. It is checked before Clerk, so an API client never depends on
Clerk being reachable.

Keys are minted at `/keys` in the dashboard, or via `POST /api/keys`. The secret
is shown **once**; the server keeps only a SHA-256 hash and can never show it
again. Lose it and you mint a new one.

Managing keys requires a real browser session: a key cannot create or revoke
keys, so one leaked key cannot entrench itself. `POST /api/keys` with a key
instead of a session returns `403`.

| Route | Purpose |
|---|---|
| `GET /api/keys` | your keys — prefix, status, last used; never the secret |
| `POST /api/keys` | mint one. `{ "name": "Zapier import" }`. Returns `key` once |
| `POST /api/keys/:id/revoke` | stops it working immediately; the row is kept |
| `DELETE /api/keys/:id` | removes the row entirely |

`last_used_at` is stamped at most once every 5 minutes, so it is a rough
"recently active" signal, not an exact audit log.

### Clerk sessions

For the browser. Send the session token as a bearer token:

```js
const token = await window.Clerk.session.getToken();

await fetch('/api/events', {
  headers: { Authorization: `Bearer ${token}` },
});
```

Tokens are short-lived. Call `getToken()` per request rather than caching it.

### Loading Clerk in the browser

Since clerk-js v6.32 the UI components ship in a **separate** bundle. Loading only
`clerk.browser.js` gives you a working session but every `mountSignIn` /
`mountUserButton` call throws `Clerk was not loaded with Ui components`. Load both,
and pass the UI constructor to `load()`:

```html
<script src="https://cdn.jsdelivr.net/npm/@clerk/ui@1.34.0/dist/ui.browser.js"></script>
<script
  src="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6.32.1/dist/clerk.browser.js"
  data-clerk-publishable-key="pk_test_..."
></script>
<script>
  await window.Clerk.load({ clerkUICtor: window.__internal_ClerkUICtor });
</script>
```

Pin both to exact versions. Each bundle rewrites its own lazy-chunk URLs to the
version it was compiled as, so a floating range plus a CDN bump can leave the
loader and its chunks on different versions.

The publishable key is not hardcoded in the pages — fetch it from
`GET /api/auth/config` so the same build works across environments.

### Roles

There are two levels of access:

| Level | Who | What they see |
|---|---|---|
| Planner | any signed-in user | only their own events |
| Admin | `role: "admin"` in Clerk user metadata | every user's events, plus the user list |

The role is read server-side only — from the signed session token if the Clerk
instance puts metadata there, otherwise from Clerk's backend API (cached 60s).
Private metadata takes precedence over public. **Never gate anything that matters
on a role read in the browser**: a user can edit their local copy of their own
metadata. Treat a client-side role check as cosmetic and let the server decide.

To make someone an admin: Clerk Dashboard → the user → Metadata → Public → Edit →
`{ "role": "admin" }`. The editor is already scoped to public metadata, so the key
is `role`, not `public_metadata.role`.

---

## Errors

Standard Nest error envelopes:

```json
{ "message": "date must be a valid YYYY-MM-DD date", "error": "Bad Request", "statusCode": 400 }
```

`message` is a string for the errors this API raises. Show it directly — the
validation messages are written to be read by a person.

| Status | Means |
|---|---|
| `400` | Validation failed. `message` says which field and why. |
| `401` | Missing, expired or invalid session token. Send the user to `/login`. |
| `403` | Signed in, but not an admin. Deliberately says only `Not allowed`. |
| `404` | No such event **or** it belongs to someone else — the two are not distinguished on purpose. |
| `500` | Database or upstream failure. |
| `503` | Supabase or Clerk is not configured on the server. |

---

## The event object

```ts
interface Event {
  id: string;           // "CPEA7E" — six characters, the public identity
  ownerId: string;      // Clerk user id
  name: string;
  type: 'wedding' | 'quinceanera' | 'baptism' | 'corporate' | 'other';
  date: string;         // "2027-05-15", or "" if undecided
  location: string;     // "" if not set
  guestCount: number | null;
  createdAt: string;    // ISO timestamp
  mode: string;         // an event_modes.value, e.g. "boda"
  slug: string | null;
  state: 'anonymous_draft' | 'draft' | 'unpaid' | 'live' | 'past' | 'suspended';
  visibility: 'private' | 'unlisted' | 'public';
  timezone: string;     // "America/Mexico_City"
  palette: string;
  locale: string;       // "es-MX"
  currency: string;     // "MXN"
  tier: 'essential' | 'premium' | 'signature' | null;
  claimedAt: string | null;
  paidAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
}
```

**About `mode`.** The occasion. Its allowed values live in the `event_modes`
table, served by `GET /api/event-types` as `{ types: [{ value, label }] }`
(active rows only, in display order, public). Add, rename, reorder or hide an
occasion by changing rows in that table; no deploy needed.

**About `id`.** It is generated server-side from a 32-character alphabet with
`I`, `O`, `0` and `1` removed, so it survives being read aloud or typed off a
printed invitation. Treat it as case-insensitive: the API uppercases it on lookup,
so `/api/events/cpea7e` and `/api/events/CPEA7E` are the same event. Display it
uppercase.

Note the shape mismatch with the database, which the API handles for you: an
undecided date is `null` in Postgres but `""` over the wire, while `guestCount`
stays `null`.

---

## The dynamic resource API — `/api/v1`

The PRD's core records (section 9) are served by one generic layer rather than a
controller per table. A resource is a definition in
`src/dynamic/resources.registry.ts`; adding a table to the API means adding an
entry, not writing code.

`GET /api/v1/_schema` returns the registry: every resource, its URL, its fields
with types and constraints, and which operations it supports. Build forms and
client-side validation from that instead of keeping a second copy of the schema.

### Verbs

| Route | Purpose |
|---|---|
| `GET /api/v1/:resource` | list, filtered and paginated |
| `POST /api/v1/:resource` | create |
| `GET /api/v1/:resource/:id` | read one |
| `PATCH /api/v1/:resource/:id` | partial update |
| `DELETE /api/v1/:resource/:id` | delete, `204` |

List takes `limit` (1–100, default 25), `offset`, `search` (matches the first
free-text column) and any field marked `filterable` in the schema. It returns
`{ resource, rows, total, limit, offset }`.

A resource that does not support a verb returns `403` naming what it does
support — `orders` is list/read only, because order state belongs to the order
service, not a generic PATCH.

### Resources

`sub-events`, `households`, `guests`, `rsvps`, `seating-tables`,
`seat-assignments`, `photos`, `registry-items`, `gifts`, `vendors`,
`vendor-packages`, `integrations`, `quotes`, `orders`, `order-items`,
`fulfilments`, `payment-attempts`, `refunds`, `payouts`, `invoices`,
`message-consents`, `message-deliveries`, `audit-events`, `agent-tasks`.

### How access works

Each resource declares a scope:

- **owner** — the table has an owner column; you see your own rows. The owner is
  taken from your session and cannot be set in the payload.
- **event** — the table has `event_id`; you see rows belonging to events you own.
  Creating under someone else's event is `403`.
- **admin** — no per-user filter exists, so the resource is admin-only. Money,
  audit and agent tables sit here.

Admins bypass the scope filter on every resource.

### What you cannot write

Fields marked `readOnly` in the schema are rejected with `400`. That covers all
money columns (PAY-6 keeps amounts in integer centavos, moved only by payment
services), lifecycle states (`orders.status`, `vendors.status`,
`registry_items.status`), and provider references. This is deliberate: a generic
PATCH must not be able to mark an order paid or a vendor active.

`audit-events` is list/read only for the same reason — an editable audit trail
is not an audit trail.

### Errors

Postgres constraint violations are translated: `23505` → "already exists",
`23503` → "a referenced record does not exist", `23514` → "a value is outside
what this record allows". A missing table returns `503` naming the migration to
run.

---

## Planner endpoints

Scoped to the caller. A planner cannot reach another user's event by any route or
id — every query is filtered by owner.

### `GET /api/events`

All of the caller's events, newest first.

```json
{ "events": [ { "id": "CPEA7E", "...": "..." } ] }
```

Not paginated. Add pagination here if a single planner ever has enough events to
need it.

### `POST /api/events`

Creates an event and assigns its id.

```json
{
  "name": "Ana & Mateo",
  "type": "wedding",
  "date": "2027-05-15",
  "location": "Hacienda de Cortés, Morelos",
  "guestCount": 150
}
```

| Field | Required | Rules |
|---|---|---|
| `name` | no | up to 120 characters after trimming; see below |
| `type` | no | one of the five types; defaults to `other` |
| `mode` | no | a `value` from `GET /api/event-types`; defaults to `boda` |
| `date` | no | `YYYY-MM-DD`, must be a real date |
| `location` | no | up to 160 characters |
| `guestCount` | no | whole number 0–100000; `""` and `null` both mean "unset" |

Strings are trimmed. Numeric strings are accepted for `guestCount`, so posting a
raw `FormData` object works without coercing types first.

**Every field is optional.** `POST /api/events` with `{}` succeeds. Omitting
`name` falls back to the type's label — `"Wedding"`, `"Quinceañera"`, `"Baptism"`,
`"Corporate event"`, `"Event"` — which is what `/event` relies on: it collects a
type and a date only and lets the planner rename later. If you need to tell a
named event from a defaulted one, compare `name` against those labels; nothing is
stored to distinguish them.

Returns `201` with the created event, including its new `id`.

### `GET /api/events/:id`

One of the caller's events. `404` if it does not exist or belongs to someone else.

### `DELETE /api/events/:id`

Deletes one of the caller's events. Returns `204` with no body. `404` if it does
not exist or belongs to someone else.

---

## Admin endpoints

Every route below requires `role: "admin"` and returns `403 Not allowed`
otherwise. These ignore ownership by design.

### `GET /api/admin/me`

```json
{ "userId": "user_...", "role": "admin" }
```

Cheapest way for an admin UI to decide whether to render itself. A `403` here
means "not an admin" — a perfectly normal answer, not an error to surface.

### `GET /api/admin/stats`

```json
{
  "total": 3,
  "upcoming": 3,
  "undated": 0,
  "byType": { "wedding": 1, "quinceanera": 1, "baptism": 0, "corporate": 1, "other": 0 }
}
```

`upcoming` counts events dated today or later. `undated` counts events with no
date, which are in `total` but in neither `upcoming` nor any date range.

### `GET /api/admin/events`

Every event, newest first, paginated.

| Param | Default | Notes |
|---|---|---|
| `ownerId` | — | exact Clerk user id |
| `type` | — | one of the five types |
| `search` | — | case-insensitive substring of the event name |
| `from` | — | `YYYY-MM-DD`, event date at or after |
| `to` | — | `YYYY-MM-DD`, event date at or before |
| `limit` | `25` | 1–100 |
| `offset` | `0` | |

```json
{ "events": [ "..." ], "total": 42, "limit": 25, "offset": 0 }
```

`total` is the count matching the filters, not the page — use it for the pager.
Out-of-range `limit`/`offset` and malformed dates are `400`, so validate in the UI
before firing the request.

Two things worth knowing about `search`: `%`, `_`, `*`, `,`, `()` and `\` are
stripped before the query runs, so a user typing them gets a slightly broader
match rather than an error. And `from`/`to` filter on the **event date**, while
ordering is by **creation time** — a date range does not reorder results.

### `GET /api/admin/events/:id`

Any event, regardless of owner. `404` only if it genuinely does not exist.

### `DELETE /api/admin/events/:id`

Deletes any event. `204`, no body. There is no soft delete and no undo — confirm
in the UI.

### `GET /api/admin/media`

Every image in Supabase Storage, across the five buckets the API writes to
(`theme-previews`, `site-media`, `vendor-media`, `event-media`, `event-photos`),
walked recursively. Nothing is paginated: it is an inventory for the dashboard's
**Images** section.

```json
{
  "images": [
    { "bucket": "event-media", "path": "STZJ6Q/0e40….jpg", "name": "0e40….jpg",
      "size": 44745, "mimetype": "image/jpeg",
      "createdAt": "2026-09-25T…", "updatedAt": "2026-09-25T…",
      "url": "https://…/storage/v1/object/public/event-media/STZJ6Q/0e40….jpg" }
  ],
  "buckets": [
    { "bucket": "event-media", "purpose": "Photos hosts put on their event sites",
      "exists": true, "count": 4, "bytes": 3775551 }
  ],
  "totalCount": 11,
  "totalBytes": 4694416
}
```

`size` is in bytes. A bucket that has never received an upload has
`exists: false` (buckets are created on first upload). Newest first.

### `GET /api/admin/users`

Reads the user list from Clerk.

| Param | Default | Notes |
|---|---|---|
| `limit` | `25` | 1–100 |
| `offset` | `0` | |
| `query` | — | Clerk's own search across name and email |

```json
{
  "users": [
    {
      "id": "user_...",
      "email": "planner@example.com",
      "firstName": null,
      "lastName": null,
      "imageUrl": "https://img.clerk.com/...",
      "role": "admin",
      "createdAt": "2026-09-20T00:00:00.000Z",
      "lastSignInAt": "2026-09-23T18:04:11.000Z"
    }
  ],
  "total": 1,
  "limit": 25,
  "offset": 0
}
```

`role` is `"admin"` or `null`. Users are **not** mirrored into the database —
Clerk owns them, and an event stores only its owner's Clerk id. To show a user's
events, take their `id` from here and pass it as `ownerId` to
`GET /api/admin/events`. There is no endpoint that returns users with their event
counts attached; that would be one request per user today.

---

## Supporting endpoints

### `GET /api/auth/config` — public

```json
{
  "publishableKey": "pk_test_...",
  "configured": true,
  "methods": { "social": ["oauth_apple", "oauth_google"], "enterpriseSso": false, "passwordMinLength": 15 }
}
```

Fetch this before booting Clerk. `configured: false` means the server has no Clerk
keys — show a setup message rather than a broken sign-in box. `methods` is read
from the Clerk instance (cached five minutes), so render a provider button only
when its strategy is listed; turning one on in the Clerk dashboard makes it
appear without a deploy.

### Site builder

The create flow's progress lives on the event (`state: "draft"`); the frontend
routes are `/start/:eventId/...`, so a reload or another device resumes it.

| Route | Purpose |
|---|---|
| `GET /api/themes?mode=boda` | Public. Active rows of `themes` for that occasion (a theme with no `modes` suits all), in `position` order: `{ themes: [{ id, slug, name, description, previewUrl, modes }] }`. |
| `GET /api/services/:key` | Public. A priced service, e.g. `custom_theme` → `{ key, name, priceCentavos, currency }`. |
| `PATCH /api/events/:id` | `{ buildType: "template" \| "custom" }` and/or `{ themeId }`. A theme implies `template`; it must be active. |
| `POST /api/events/:id/custom-request` | Opens a custom-design request at the current price and marks the event `custom`. Idempotent: returns the open request if one exists. |
| `GET /api/events/:id/custom-request` | The open request, or `404`. |

Themes are managed from the dashboard's **Themes** section (admins only) or
through these admin routes:

| Route | Purpose |
|---|---|
| `GET /api/admin/themes` | Every theme, hidden ones included. |
| `POST /api/admin/themes` | JSON `{ name, slug?, description?, modes?, position?, previewUrl?, active? }`. Slug defaults from the name. Without `previewUrl` the theme starts hidden. |
| `PATCH /api/admin/themes/:id` | Any of the same fields. Activating needs an image. |
| `POST /api/admin/themes/:id/image` | `multipart/form-data`, field `image` (JPEG/PNG/WebP, ≤ 5 MB). Stored in the public `theme-previews` Storage bucket (created on first upload); replaces and deletes the previous upload. |
| `DELETE /api/admin/themes/:id` | Removes the theme and its stored image; events that picked it keep their row with `themeId: null`. |

`modes` values must exist in `event_modes`. Hosts only ever see themes that are
active and have an image. The multipart upload cannot be encrypted, so it fails
when `API_ENCRYPTION_MODE=required`.

### Occasion details and the automatic subdomain

`GET /api/event-types` now returns each occasion's questions and templates:

```json
{ "value": "boda", "label": "Wedding",
  "fields": [{ "key": "partner1", "label": "Bride's first name", "required": true, "maxLength": 40 }, …],
  "nameTemplate": "{partner1} & {partner2} wedding", "slugTemplate": "{partner1}-{partner2}" }
```

`POST /api/events` takes `details` (answers keyed by field key). The server
validates them against the occasion, names the event from `nameTemplate`
("Rajib & Jerin wedding") unless `name` is sent, and gives it a first
subdomain from `slugTemplate` (`rajib-jerin`, then `rajib-jerin-2`, … if
taken; accents are stripped, reserved words get the occasion appended).
`PATCH /api/events/:id` accepts `details` and `slug`, so both can be changed
later. The questions and templates are rows in `event_modes` — edit them in
Supabase to change the form.

### Event sites and subdomains

An event with `slug: "rajib-jerin"` has its public site at
`<scheme>://rajib-jerin.<SITE_DOMAIN>`. The **frontend** renders it: when the
app loads on a subdomain of `SITE_DOMAIN` it shows that event's site instead of
the app, using `GET /api/sites/by-slug/:slug`. This server only supplies data;
it does not route by Host. Only `state: "live"` events are returned. For local
testing set `SITE_DOMAIN=localhost:5173` (the Vite dev server): browsers route
every `*.localhost` name to this machine, so no DNS or hosts-file setup is
needed. CORS admits any `<slug>.<SITE_DOMAIN>` origin for built sites.

| Route | Purpose |
|---|---|
| `GET /api/sites/config` | Public. `{ configured, domain, scheme }`. |
| `GET /api/sites/by-slug/:slug` | Public. A live site: `{ slug, name, occasion, date, location, locale, themeName, themeImage }`. `404` with `reason: "missing"` or `"unpublished"` otherwise. |
| `GET /api/sites/check?slug=&eventId=` | `{ slug, available, url }`; `400` if the subdomain is malformed or reserved. |
| `PATCH /api/events/:id` `{ slug }` | Owner sets or clears (`null`) their subdomain. 3–63 chars, `a-z 0-9 -`, unique. |
| `PATCH /api/admin/events/:id` | Admin: `{ state, slug, name }`. `state: "live"` publishes and needs a subdomain. |
| `GET /api/admin/events?mode=&state=` | Adds occasion and state filters; rows include `theme` and `siteUrl`. |
| `GET /api/admin/users/mirror` | The `public.users` table with each user's event count. |
| `GET /api/admin/custom-requests` · `PATCH …/:id` `{ status }` | Custom design requests and their progress. |

### Guests & RSVP (`20260930000000_guests_rsvp.sql`)

| Route | Purpose |
|---|---|
| `GET /api/events/:id/guests` | Owner. `{ settings: { deadline, open }, subEvents, households: [{ id, name, inviteCode, email, phone, plusOneLimit, tags, invitedTo, notes, rsvpSubmittedAt, rsvpMessage, guests: [{ id, fullName, email, dietary, isChild, isPlusOne, rsvps: { [subEventId]: { status, menuChoice, allergies } } }] }], totals }` |
| `POST /api/events/:id/households` | Owner. `{ name, email?, phone?, plusOneLimit?, tags?, invitedTo?, notes?, guests: [{ id?, fullName, email?, dietary?, isChild? }] }`. Returns the overview. |
| `PATCH`/`DELETE /api/events/:id/households/:hid` | Owner. Guests with an `id` keep their answers. |
| `POST /api/events/:id/households/import` | Owner. `{ csv }`: columns household, name, email, phone, child, plus_ones (comma or semicolon). |
| `GET /api/events/:id/guests/export` | Owner. CSV, one row per guest, protected against formula injection. |
| `PATCH /api/events/:id/rsvp-settings` | Owner. `{ deadline?, open? }` |
| `PUT /api/events/:id/rsvps` | Owner. `{ guestId, subEventId, status }`: an answer the host enters. |
| `POST /api/sites/:slug/rsvp/find` | Public, live sites. `{ code }` → that household (guests, answers, `code`). `{ name }` (full name) → a masked view only: `{ masked: true, name, guests: [{ firstName }], submitted, deadline, open }`; the guest then enters the invitation code. |
| `POST /api/sites/:slug/rsvp` | Public. `{ code, answers: [{ guestId \| plusOneIndex, subEventId, status: attending\|declined, menuChoice?, allergies? }], plusOnes?: [{ fullName }], message? }` |

`PATCH /api/events/:id/sub-events/:subId` also takes `menuOptions: string[]` (up to 12).

### Site content, publishing, registry (`20261001000000_site_content.sql`)

| Route | Purpose |
|---|---|
| `GET /api/events/:id/site-content` | Owner. `{ content: { story, faq, stay, invitation, gifts, cover }, publish: { state, slug, publishedAt, protected } }` |
| `PATCH /api/events/:id/site-content` | Owner. Any section; each replaces that section. Photo URLs must come from `/media`. |
| `POST /api/events/:id/media` | Owner. multipart `image` (JPEG/PNG/WebP ≤ 8 MB) → `{ url }` in the `event-media` bucket. |
| `POST /api/events/:id/publish` · `/unpublish` | Owner. Publishing needs a subdomain. |
| `PUT /api/events/:id/site-password` | Owner. `{ password }` (6–100 chars) or `{ password: null }`. |
| `GET`/`POST /api/events/:id/registry` · `PATCH`/`DELETE …/:itemId` | Owner. Items `{ kind: retailer_link\|cash_fund, title, description?, externalUrl? (https), imageUrl? (https), priceCents?, goalCents? }`; `PATCH { available: true }` or `{ status: 'available' }` puts a given item back; `{ status: 'purchased' }` marks it given (the host confirms guest reports). The GET also returns reported `gifts`. |
| `PATCH /api/events/:id/gifts/:giftId` | Owner. `{ thanked }` |
| `POST /api/sites/:slug/unlock` | Public. `{ password }` → `{ token }`, sent back as `X-Site-Token` on `by-slug`, `rsvp*` and `gifts`. `401 { reason: "password" }` without it. |
| `POST /api/sites/:slug/gifts` | Public. `{ itemId?, name, email?, amountCents? (cash), message? }`: recorded as `source: guest_report`. The item's status does not change; the host confirms it with `PATCH …/registry/:itemId { status: 'purchased' }`. |

`GET /api/sites/by-slug/:slug` now includes `content` and `rsvp: { open, deadline }`, and registry items include `id`, `status` and `goalCents`. Each successful load counts a site view.

### Chat (`20261004000000_chat.sql`)

| Route | Purpose |
|---|---|
| `GET /api/chats` | My conversations (as host, and as vendor owner) with unread counts. |
| `POST /api/chats` | `{ kind: 'vendor', eventId, vendorId }` or `{ kind: 'support', eventId?, subject? }`; returns the (existing open or new) thread. |
| `GET /api/chats/:id?since=` | Thread and messages after `since`; marks read for the caller. |
| `POST /api/chats/:id/messages` | `{ body?, attachments?: [{ path, name, size, type }] }` (body ≤ 4000 chars; at least one of the two). Returns `{ message, warning }`: in a host↔vendor thread with no paid order yet, text with a phone, email or WhatsApp link is sent but `flagged` and `warning` explains why. Messages carry `kind` (`text` \| `offer` \| `system` \| `file`), `attachments` (with one-hour signed `url`s), `quoteId`, `orderId`, and for offers an `offer` object (quote lines, total, deposit, status, and the `order` it became). |
| `POST /api/chats/:id/transcript` · `POST /api/public/chats/:id/transcript` | Emails the thread to the visitor email stored on it (or the signed-in caller's account email). A different `email` in the body → 400; 2/hour per user or visitor. |
| `POST /api/chats/:id/attachments` | multipart `file` (JPEG, PNG, WebP or PDF, ≤ 10 MB; sniffed, not trusted; 20 files per thread per day → 429) → `{ attachment: { path, name, size, type, url } }`. Stored in the private `chat-files` bucket under `<conversation>/<uuid>.<ext>`; only paths of this thread can be sent. |
| `POST /api/chats/:id/offer` | Vendor in a host↔vendor thread. Same body as `POST /api/vendor/quotes` minus the target: `{ title, lineItems, amountCentavos, depositCentavos?, validUntil?, note? }` → creates and sends a `vendor_quote` tied to the conversation and posts an `offer` card. Needs an approved vendor with `charges_enabled`. The host accepts with the usual `POST /api/events/:id/quotes/:quoteId/accept` then `…/orders/:orderId/checkout`. |
| `POST /api/chats/:id/star` · `POST /api/chats/:id/archive` | `{ starred }` / `{ archived }` — per participant (stored on `conversation_reads`); the inbox rows carry `starred` and `archived`. |
| `POST /api/chats/:id/close` | |
| *(system lines)* | Quote and order events post `kind: 'system'` messages into the thread the quote belongs to (the one the offer was written in, else the open host+event+vendor thread): offer sent from the Quotes tab, accepted, declined, withdrawn, payment received, started, fulfilled, refunded, cancelled. |
| *(email alerts)* | In host↔vendor threads, when the recipient has no stream open, an email goes out through Resend (at most one per thread per 30 min). Needs `RESEND_API_KEY` + `MESSAGE_FROM_EMAIL`. |
| *(response stats)* | `GET /api/marketplace/listings` vendor cards carry `responseTime` ("2 h", "1 d"; average from the host's first message to the vendor's first reply) and `responseRate` (0–100). Empty / null until the vendor has answered a host. |
| `GET /api/admin/chats?kind=` · `GET /api/admin/chats/export?anonymize=1` | Admin. Every conversation; JSONL corpus download. |
| `GET /api/public/chats` · `POST /api/public/chats` · `GET …/:id?since=` · `POST …/:id/messages` | No session; `X-Visitor-Token` (random, ≥16 chars) identifies the browser. `POST { kind: 'support', name?, email? }` or `{ kind: 'guest', slug, name?, email? }` (live site; `X-Site-Token` on private sites). |

### Plans, messaging, photos, seating, concierge (`20261003000000_tiers_messaging_photos.sql`)

| Route | Purpose |
|---|---|
| `GET /api/plans` | Public. `{ plans: [{ key, tier, name, priceCentavos, currency }], payments: { configured, provider, methods, webhook } }` |
| `POST /api/events/:id/checkout` | Owner. `{ product }` → `{ url, attemptId }` (Stripe Checkout). |
| `POST /api/checkout/confirm` | Owner. `{ session }` → `{ applied, status, tier? }` |
| `GET /api/payments?eventId=` | Owner. Payment attempts. |
| `POST /api/webhooks/stripe` | Public, Stripe-signed. |
| `GET /api/admin/payments` | Admin. `{ payments: [{ …, amountCents, currency, stripeAmountCents, stripeCurrency, stripePaymentIntent, receiptUrl, succeededAt }], summary: { started, paid, totals: [{ currency, cents }] }, stripe: { livemode, available: [{ currency, cents }], pending: [...] } \| null }`. `stripe*` fields are what Stripe reported when the payment settled (null until then); `stripe` is the live account balance, null if Stripe is not configured. Needs `20261007000000_payment_stripe_amounts.sql`. |
| `POST /api/admin/payments/:id/sync` | Admin. Re-reads the purchase's Checkout session from Stripe, stores Stripe's amount and receipt, and applies the status (fills older rows or a missed webhook). |
| `GET/PATCH /api/admin/services/:key` | Admin. Prices; `{ name?, priceCentavos?, active? }`. |
| `GET /api/messaging/config` | Public. `{ email, sms, whatsapp: "link" }` |
| `GET /api/events/:id/messages` · `GET …/messages/preview?channel&audience` · `POST …/messages` | Owner, Premium. `{ channel: email\|sms, audience, subject?, body }`. Send returns the list plus `sent`, `failed`, `skipped` (households that got this channel in the last 10 min). 429 beyond the plan's daily cap (`services` `message_daily_cap_premium` / `_signature`, 500 without the rows); 10 sends/hour per user. |
| `GET /api/events/:id/photos` · `POST …/photos` (multipart `photo`) · `PATCH …/photos/:photoId { status, caption? }` · `PATCH …/gallery { open }` | Owner. |
| `GET/POST /api/sites/:slug/photos` | Public (token on private sites). Approved list; guest upload (multipart `photo`, `uploader`, `caption`); 429 once 200 photos await moderation. |
| `GET /api/events/:id/sub-events/:subId/seating` · `POST …/seating/tables` · `PATCH/DELETE …/tables/:tableId` · `PUT …/seating { guestId, tableId\|null }` · `POST …/seating/auto` | Owner. |
| `GET/POST /api/events/:id/concierge` · `POST …/concierge/:requestId/cancel` | Owner. `{ kind: print\|travel\|custom_domain, product?, quantity?, details?, address?, domain? }`. |
| `GET /api/admin/concierge` · `PATCH …/:requestId { status?, adminNote?, quoteCents? }` | Admin. |
| `GET /api/vendors/directory?department&city&q` | Public. Active vendors, no contact details. |

`PATCH /api/events/:id/site-content` also takes `travel: { airport, transport, parking, note }`. `GET /api/sites/by-slug/:slug` adds `tier` and `galleryOpen`.

### Planning, inquiries, stats (`20261002000000_planning.sql`)

| Route | Purpose |
|---|---|
| `GET /api/events/:id/planning` | Owner. `{ tasks, suggestionsAvailable, budget: { totalCents, items, estimatedCents, actualCents, paidCents } }` |
| `POST /api/events/:id/tasks/suggested` | Owner. Adds the occasion's suggested tasks not yet on the list. |
| `POST /api/events/:id/tasks` · `PATCH`/`DELETE …/:taskId` | Owner. `{ title, category?, dueDate?, notes?, done? }` |
| `PATCH /api/events/:id/budget` | Owner. `{ totalCents }` |
| `POST /api/events/:id/budget-items` · `PATCH`/`DELETE …/:itemId` | Owner. `{ name, category?, estimatedCents?, actualCents?, paidCents?, notes? }` |
| `GET /api/events/:id/stats` | Owner. Views (30 days, by day), invitations, answers, checklist, gifts, inquiries. |
| `GET`/`POST /api/events/:id/inquiries` | Owner. `{ type: location\|product, listingId, message, guestCount?, date?, email?, phone? }`. One open request per listing. |
| `GET /api/vendor/inquiries` · `POST /api/vendor/inquiries/:id/reply` | Vendor. `{ message, totalCents? }` |
| `GET /api/admin/activity` | Admin. Per-event activity and totals. |

### Site builder: Ceremony Info and Event Info

Needs `20260929000000_event_info.sql`. Before it is applied, the routes below return `503` naming it, and event-types returns empty `familySections` / `subEventKinds`.

| Route | Purpose |
|---|---|
| `GET /api/event-types` | Each type also has `familyTitle`, `familySections: [{ key, title, nameKey, nameLabel }]` and `subEventKinds: [{ value, label }]`. |
| `PATCH /api/events/:id` `{ families }` | Owner. `{ [sectionKey]: { father, mother, address } }`: unknown sections are dropped; 80/80/300 chars. Names go in `details[nameKey]`. The event response now includes `families`. |
| `GET /api/events/:id/sub-events` | Owner. `{ subEvents: [{ id, kind, name, date, arriveTime, beginTime, guestCount, venue: { name, address, imageUrl, locationId } \| null, position }] }`. |
| `POST /api/events/:id/sub-events` | Owner. `{ kind, date?, arriveTime?, beginTime?, guestCount?, venue? }`. `kind` must be offered for the occasion; `name` is its label. Up to 30. Returns the whole list. |
| `PATCH /api/events/:id/sub-events/:subId` | Owner. Any of the above. `venue`: `{ locationId }` (approved vendor location; also records a vendor pick), `{ name, address }`, or `null`. |
| `DELETE /api/events/:id/sub-events/:subId` | Owner. Returns the remaining list. |

The public site (`GET /api/sites/by-slug/:slug`) now adds `families: [{ key, title, name, father, mother }]`, with no addresses. Each sub-event adds `date`, `arriveTime`, `beginTime` and `imageUrl`, with no guest counts.

### Homepage

| Route | Purpose |
|---|---|
| `GET /api/event-types` | Public. Each type now also has `description` and `imageUrl` (empty until `20260928000000_homepage.sql`). |
| `GET /api/home/vendors` | Public. `{ vendors: [{ id, businessName, department, city, logoUrl }] }`: up to 4 active vendors, most recently approved first. |
| `POST /api/newsletter` `{ email }` | Public. `204`, also when the address is already subscribed. `400` for an invalid email. Rate-limited to 10 per IP per hour. |
| `GET /api/services/custom_domain` | Public. The custom-domain price (`priceCentavos`, `currency`). |
| `GET /api/admin/newsletter` | Admin. `{ subscribers: [{ id, email, source, createdAt, unsubscribedAt }] }`, newest first (up to 1000). |
| `GET /api/admin/event-modes` | Admin. Every occasion, inactive included: `{ modes: [{ value, label, description, imageUrl, position, active }] }`. |
| `PATCH /api/admin/event-modes/:value` | Admin. `{ label?, description?, position?, active? }`. |
| `POST /api/admin/event-modes/:value/image` | Admin. multipart `image` (JPEG/PNG/WebP ≤ 5 MB, checked by content) → `site-media` bucket. |

### Users — `/api/users`

Clerk owns identity; `public.users` is a mirror for joins and reporting.

| Route | Purpose |
|---|---|
| `POST /api/users/me/sync` | Re-read the caller from Clerk and upsert the row. No body. Call after every sign-in / sign-up. |
| `GET /api/users/me` | The caller's row. `404` until the first sync. |

```json
{
  "id": "user_...", "email": "...", "emailVerified": true,
  "firstName": "...", "lastName": "...", "imageUrl": "...",
  "clerkCreatedAt": "...", "lastSignInAt": "...", "createdAt": "...", "updatedAt": "..."
}
```

### `POST /api/webhooks/clerk` — public, Svix-signed

Keeps the mirror current for changes made outside the app. Subscribe to
`user.created`, `user.updated` and `user.deleted`, and set
`CLERK_WEBHOOK_SIGNING_SECRET`. Created/updated re-read the user from Clerk;
deleted removes the row. Unsigned or tampered requests get `400`.

### `GET /api/auth/session`

```json
{ "userId": "user_..." }
```

### `GET /api/me`

```json
{ "userId": "user_..." }
```

Same answer as `/api/auth/session`. Useful as a cheap "is my token still good?"
probe.

### Pages

`GET /login`, `GET /dashboard` and `GET /event` serve static HTML and are public.
These shells are public on purpose — Clerk gates them in the browser and every API
route they call is guarded, so the markup alone reveals nothing. A signed-out
visitor to `/dashboard` or `/event` is redirected to `/login`.

`/event` is the short create flow: occasion and date, nothing else. It posts to
`POST /api/events` with only `type` and `date`, then shows the generated id.
`/dashboard` has the fuller form with name, venue and guest count.

---

## Building against this

A workable order for the admin frontend:

1. Load Clerk, call `GET /api/admin/me`. On `403`, render nothing admin-shaped.
2. `GET /api/admin/stats` for the overview.
3. `GET /api/admin/events` with filters bound to the query params above; keep
   `limit`/`offset` in the URL so a filtered view is linkable.
4. `GET /api/admin/users` for the owner filter; map `ownerId` back to an email for
   display, since events carry only the Clerk id.

Re-read the token before each request, and treat a `401` mid-session as "sign in
again" rather than an error state.

## Server configuration

`.env`, documented in `.env.example`:

| Variable | Required | Purpose |
|---|---|---|
| `CLERK_PUBLISHABLE_KEY` | yes | handed to the browser via `/api/auth/config` |
| `CLERK_SECRET_KEY` | yes | verifies session tokens, reads users and roles |
| `SUPABASE_URL` | yes | project URL |
| `SUPABASE_SECRET_KEY` | yes | server-only; bypasses RLS, never sent to the browser |
| `OBSERVE_APP_KEY` / `OBSERVE_APP_SECRET` | no | telemetry; blank disables it |

`SUPABASE_SERVICE_ROLE_KEY` is accepted as an older name for
`SUPABASE_SECRET_KEY`.

If Clerk keys are missing the app still boots and serves the login page, which
reports the missing configuration; protected routes return `503`. If Supabase keys
are missing, event routes return `503` and everything else works.

The schema lives in `supabase/migrations/` and is applied by hand in the Supabase
SQL editor. Row level security is enabled on `events` with **no policies**, which
is deliberate: the server holds the secret key and bypasses RLS, so anon and
publishable keys can read nothing.

---

## Vendors and the marketplace

Migration: `supabase/migrations/20260926000000_vendor_marketplace.sql`.

**Lifecycle.** A vendor profile (`vendors`, one per account) starts as
`candidate`, is submitted to `pending_approval`, and an admin makes it
`active` or `rejected` (with a note the vendor sees); `paused` hides an active
vendor. Products (`vendor_packages`) and venue locations (`vendor_locations`)
each have `review_status` `pending → approved | rejected`; any content edit
sends an approved listing back to `pending`. Hosts only see approved, active
listings of active vendors.

| Route | Who | Purpose |
|---|---|---|
| `GET/POST/PATCH /api/vendor/me` | vendor | Own profile (`POST` creates it) |
| `POST /api/vendor/me/submit` | vendor | Send for approval (also re-submits after a rejection) |
| `POST /api/vendor/me/logo`, `POST /api/vendor/media` | vendor | Multipart `image` → public `vendor-media` bucket |
| `GET/POST/PATCH/DELETE /api/vendor/products[/:id]` | vendor | Products: `name, description, price` (pesos), `capacityMin/Max, availability, imageUrl, active` |
| `GET/POST/PATCH/DELETE /api/vendor/locations[/:id]` | vendor | Venue locations: `name, address, city, region, capacityMin/Max, description, imageUrl, active` |
| `GET/POST /api/vendor/promotions`, `POST …/:id/cancel` | vendor | Ask to feature an approved listing for 7, 14 or 30 days |
| `GET /api/vendor/stats` | vendor | Unique daily views and host selections per listing |
| `GET /api/marketplace/options` | public | Categories, purchase modes, availability values, promotion lengths |
| `GET /api/marketplace?department=&city=&q=&type=` | signed in | Approved listings; featured first |
| `POST /api/marketplace/views` | signed in | `{ type, id }` — one view per viewer, listing and day |
| `GET/POST /api/events/:id/vendor-picks`, `DELETE …/:pickId` | event owner | A host's selected venues/products for an event |
| `GET /api/admin/vendors?status=`, `PATCH /api/admin/vendors/:id` | admin | `{ action: approve \| reject \| pause \| activate, note }` |
| `GET /api/admin/vendor-listings?status=`, `PATCH …/:type/:id` | admin | `{ decision: approve \| reject, note }` |
| `GET /api/admin/vendor-promotions?status=`, `PATCH …/:id` | admin | `{ decision: approve \| reject \| end, note }`; approve starts the run now |

### Lazo's own products

Migration: `supabase/migrations/20260927000000_lazo_products.sql`.

Products the Lazo team lists itself, from admin → Vendors → **Own products**.
No vendor and no review step. `saleType` is either:

- `affiliate`: hosts buy on another store through `affiliateUrl`. The price is optional.
- `direct`: Lazo sells the product at `price` (pesos, stored as centavos). The price is required.

Active products appear in `GET /api/marketplace` as `type: 'lazo'` listings
with `vendor: null`, plus `saleType`, `buyUrl` (affiliate only) and
`sourceSite`. A city filter doesn't hide them (they're sold online), and
`type=lazo` returns only them. Hosts add them to an event with the usual
vendor-picks routes (`{ type: 'lazo', id }`).

**Reading a link** (`POST /api/admin/lazo-products/scrape`) follows redirects
such as `amzn.to` and refuses private or loopback addresses at every hop. It
reads schema.org Product JSON-LD, Open Graph and `product:price` meta tags,
microdata, and Amazon's own markup. When a store answers with a robot check,
it retries as a link-preview crawler. If the store still blocks it (Mercado
Libre, Walmart, Coppel from our network), it returns `502` with a message and
the admin types the details in by hand.

| Route | Who | Purpose |
|---|---|---|
| `GET /api/admin/lazo-products` | admin | Every product with `picks` (events) and `clicks` (affiliate Buy clicks) |
| `POST /api/admin/lazo-products/scrape` | admin | `{ url }` → `{ url, finalUrl, site, name, description, imageUrl, priceCentavos, currency, found[], warnings[] }`. Saves nothing |
| `POST /api/admin/lazo-products` | admin | `{ saleType, name, description, department, price, currency, imageUrl, affiliateUrl, sourceUrl, sourceSite, scraped, featured, active, position }` |
| `PATCH /api/admin/lazo-products/:id`, `DELETE …/:id` | admin | Partial update (checked against the saved row) / delete |
| `POST /api/admin/lazo-products/:id/image` | admin | Multipart `image` → `vendor-media/lazo-products/` |
| `POST /api/admin/lazo-products/:id/refresh` | admin | Re-reads an affiliate link and updates the price, plus the image if the product has none. Returns `{ product, found }` |
| `POST /api/marketplace/lazo-products/:id/click` | signed in | Counts a Buy click, one per viewer, product and day |


## PRD V1 gaps (2026-09-26)

Six streams; migrations `20261008000000` … `20261013000000`. Every route below answers 503 naming its migration file (or the missing env var) until that is in place. Money is integer centavos, MXN unless stated.

### A-core — drafts, invoices, post-event, seating export (`20261008000000_core_gaps.sql`)

### `POST /api/drafts`
Public, 20 per hour per IP. Same body as `POST /api/events` (`mode`, `details`, `date?`, `location?`). Saves an anonymous draft (`events.state = 'anonymous_draft'`, no owner, no subdomain). Response: the event plus `claimToken` (shown once; store it with the id). Expires 30 days after creation.

### `PATCH /api/drafts/:id`
Public. `{ token, details?, date?, location? }` — re-saves the answers of an unclaimed draft. 404 when the token is wrong, the draft expired or was claimed.

### `GET /api/drafts/:id?token=`
Public. The draft, or 404 (wrong token, expired — expired rows are deleted on read — or already claimed).

### `POST /api/drafts/:id/claim`
Session. `{ token }` → the event, now owned by the caller in state `draft` with `claimed_at` set and its first subdomain chosen. 404 if the token is wrong or someone else claimed it first.

### `GET /api/events/:id/invoices`
Owner. `{ invoices: Invoice[] }` newest first. Invoice: `{ id, number, status, eventId, eventName?, ownerId, paymentAttemptId, lineItems: [{ description, quantity, unitCentavos, totalCentavos }], subtotalCentavos, taxCentavos, taxRate, totalCentavos, currency, gateway, gatewayReference, rfc, razonSocial, cfdiUso, uuidFiscal, issuedAt, createdAt }`. IVA is included in the total (`subtotal + tax = total`).

### `GET /api/invoices/:id`
Owner. One invoice.

### `PATCH /api/invoices/:id/billing`
Owner. `{ rfc?, razonSocial?, cfdiUso? }` (RFC validated by shape; `cfdiUso` from a short SAT list). Returns the invoice. No CFDI is stamped.

### `GET /api/admin/invoices`
Admin. `{ invoices, totals: [{ currency, cents, tax }] }` (last 500).

### `GET /api/events/:id/after`
Owner. Post-event summary: `{ event: { id, name, date, closedAt, state, siteUrl }, guests: { invited, attending, came, noShow, unmarked, list: [{ id, name, guests: [{ id, name, attended, attending }] }] }, gifts: { total, thanked, list }, photos: { pending, total } }`.

### `PATCH /api/events/:id/guests/:guestId/attendance`
Owner. `{ attended: true | false | null }`. Returns the guest-list overview (guests now carry `attended`; the CSV export has an "Attended" column).

### `POST /api/events/:id/close`
Owner. Sets `events.closed_at` and returns the event (`closedAt`). The site stays live; RSVP reports closed (`rsvp.open = false` on `GET /api/sites/by-slug/:slug`, 403 on submit).

### `GET /api/events/:id/seating/export.csv?event=<subEventId>`
Owner. CSV (`text/csv`, BOM, CRLF): `Celebration, Table, Seat, Guest, Household, RSVP, Note` — one row per seat (empty seats marked), then unseated guests. Without `event`, every celebration.

### B — Vendor payments (Stripe Connect) — `src/vendor-payments/`, `20261009000000_vendor_orders.sql`

503 names `STRIPE_SECRET_KEY` / the migration when missing.

### `GET /api/vendor/payments`
Vendor's Connect state. `?refresh=1` re-reads Stripe. → `{ configured, webhook, methods, account: { accountId, onboardingStatus, chargesEnabled, payoutsEnabled, detailsSubmitted, disabledReason, currentlyDue[], syncedAt } }`

### `POST /api/vendor/payments/onboard`
Creates the Express account (first call) and returns an Account Link. → `{ url, accountId }`. Vendor must be `active`.

### `POST /api/vendor/payments/dashboard-link`
→ `{ url }` one-time login link to the vendor's Stripe Express dashboard.

### `GET /api/vendor/quotes`
→ `{ quotes: [{ id, inquiryId, listingType, listingId, eventId, title, lineItems[{description,quantity,unitCentavos}], amountCentavos, depositCentavos, currency, validUntil, status, note, sentAt, acceptedAt, declinedAt, event: { name, date } }] }`

### `POST /api/vendor/quotes`

Target is one of `{ inquiryId }`, `{ eventId, listingType, listingId }`, or `{ conversationId }` (an open host↔vendor thread of this vendor; `POST /api/chats/:id/offer` uses this). Quotes carry `conversationId` and `ownerId`.

Body: `{ inquiryId }` **or** `{ eventId, listingType: location|product, listingId }` (a listing that event picked), plus `title, lineItems, amountCentavos, depositCentavos?, validUntil?, note?, send?`. `send: true` needs `charges_enabled`. → `{ quote }`

### `PATCH /api/vendor/quotes/:id` — edit a draft or sent quote. Changing `lineItems`, `amountCentavos`, `depositCentavos` or `validUntil` on a sent quote reverts it to `draft` (send it again). → `{ quote, reverted }`
### `POST /api/vendor/quotes/:id/send` — draft → sent. → `{ quote }`
### `POST /api/vendor/quotes/:id/withdraw` — draft|sent → withdrawn. → `{ quote }`

### `GET /api/vendor/orders`
→ `{ orders: [{ id, quoteId, eventId, title, amountCentavos, quoteAmountCentavos, platformFeeCentavos, refundedCentavos, currency, status, paymentMethod, receiptUrl, stripePaymentIntent, paidAt, fulfilledAt, refunds[], disputes[], event }] }`

### `POST /api/vendor/orders/:id/status` — `{ status: in_progress | fulfilled }`. → `{ order }`
### `POST /api/vendor/orders/:id/refunds` — `{ amountCentavos?, reason, idempotencyKey? (≤ 64 chars) }`; omit the amount for everything left. The amount is reserved on the order (`refund_pending`) before Stripe is called, so concurrent refunds cannot exceed the charge (409). Repeating an `idempotencyKey` returns the refund it already made. → `{ order, refund: { id, status, repeated } }`

### `GET /api/events/:id/quotes`
Host: `{ quotes: [ …quote, vendor: { name, email, phone, chargesEnabled } ], orders: [ …order, vendor: { name } ], payments: { configured, webhook, methods } }` (drafts excluded).

### `POST /api/events/:id/quotes/:quoteId/accept` — sent → accepted, creates the order. → `{ order }` (pending_payment)
### `POST /api/events/:id/quotes/:quoteId/decline` → `{ quote }`
### `POST /api/events/:id/orders/:orderId/checkout` → `{ url, orderId }` Stripe Checkout (destination charge). Re-uses an open session.
### `POST /api/events/:id/orders/:orderId/cancel` — unpaid orders only. → `{ order }`
### `POST /api/orders/confirm` — `{ session: cs_… }` after the redirect. → `{ order }`
### `POST /api/webhooks/stripe-connect` — public; Stripe signature (`STRIPE_CONNECT_WEBHOOK_SECRET`, comma-separated list allowed). → `{ received, duplicate? }`

### `GET /api/admin/vendor-orders?status=&vendorId=&from=YYYY-MM-DD&to=YYYY-MM-DD`
→ `{ orders[], totals: { gross, platformFees, refunds, disputed, netToVendors, currency }, vendors: [{ id, name, status, stripeAccountId, onboardingStatus, chargesEnabled, payoutsEnabled, syncedAt, orders, paid, refunded, fees }], commission: { key, present, pct, active } }`
### `GET /api/admin/vendor-orders/reconcile?from=&to=` (default last 30 days, max 92)
→ `{ from, to, stripe: { transactions, gross, refunds, applicationFees }, db: { orders, gross, refunds, platformFees }, mismatches: [{ kind, stripeId, orderId, detail, stripeCentavos, dbCentavos }] }`
### `GET /api/admin/vendor-orders/commission` → `{ key, present, pct, active }`
### `PATCH /api/admin/vendor-orders/commission` — `{ pct }` 0–100.
### `POST /api/admin/vendor-orders/:id/refunds` — `{ amountCentavos?, reason, idempotencyKey? }` admin refund (same guards as the vendor route).

### C — WhatsApp Business Cloud API — `src/whatsapp/`, `20261010000000_whatsapp.sql`

### `GET /api/whatsapp/config`
Public. `{ configured, missing: [env names], webhook, webhookMissing }`. Booleans and variable names only.

### `GET /api/events/:id/whatsapp`
Owner. `{ config, allowed (Premium), templates (approved only), pendingTemplates (count), messages (channel whatsapp), deliveries }`. Delivery: `{ id, messageId, household, recipient (masked), status: queued|accepted|sent|delivered|read|failed, errorCode, errorTitle, at }`.

### `GET /api/events/:id/whatsapp/preview?templateId&audience`
Owner. `{ reachable, noConsent: [names], missing: [names without phone], sample: { household, params, text } | null }`. `audience` is `all|awaiting|attending|declined`.

### `POST /api/events/:id/whatsapp/send`
Owner, Premium, 503 when env missing. Body `{ templateId, audience, values?: { <param>: text } }` for placeholders outside `guest_name, event_name, event_date, rsvp_url, invite_code, venue`. Sends only to consenting households with a phone; returns the overview plus `sent`, `failed`, `skipped` (households messaged in the last 10 min). Errors: 400 template not approved / no recipients / missing value, 403 plan, 429 daily cap (same cap as email/SMS) or 10 sends/hour per user.

### `PATCH /api/events/:id/whatsapp/consent/:householdId`
Owner. `{ consent: boolean }` → `{ id, whatsappConsent, whatsappConsentAt, whatsappConsentSource: 'host', whatsappOptedOutAt }`. Setting true clears an opt-out only if the host explicitly does so; the guest list disables the toggle for opted-out households.

### `POST /api/sites/:slug/rsvp` (extended)
Body may include `whatsappConsent: boolean` and `whatsappPhone: string`. `find` / responses now include `phone` and `whatsappConsent` for the household.

### `GET /api/events/:id/guests` (extended)
Each household gains `whatsappConsent`, `whatsappConsentSource`, `whatsappOptedOutAt`.

### `GET /api/admin/whatsapp`
Admin. `{ config, templates: [{ id, name, language, category, body, params, sampleParams, status: pending|approved|rejected|paused, metaTemplateId, rejectedReason, syncedAt, submittedAt }], failures (7 days): [{ id, eventId, recipient (masked), template, errorCode, errorTitle, at }] }`.

### `POST /api/admin/whatsapp/templates/sync`
Admin. Reads `/<WABA_ID>/message_templates` and records each known template's Meta status. `{ synced, remote, templates }`.

### `POST /api/admin/whatsapp/templates/:templateId/submit`
Admin. Creates the template at Meta (BODY component with sample values). `{ templates }`.

### `GET /api/webhooks/whatsapp`
Public. Meta's verification: `hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` → the challenge as plain text.

### `POST /api/webhooks/whatsapp`
Public; `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with `WHATSAPP_APP_SECRET`) is the authentication. Handles `statuses[]` (with `errors[]`), inbound text opt-outs, and `message_template_status_update`. Always `{ received: true }` on a valid signature.

### D — Retailer catalogs and fulfilment partners — `src/retailers/`, `src/fulfilment/`, `20261011000000_retailers_fulfilment.sql`

### `GET /api/retailers`
Stores that can be searched. → `{ retailers: [{ key, name, adapter, country, enabled, configured, missingEnv[], supports, syncedAt }] }`

### `GET /api/retailers/:key/search?q=`
Live catalog search (10 results), cached 60 s per retailer+query (`cached: true`), 60/hour per user. 503 with the missing env var names when not configured. → `{ retailer, query, results: [{ retailer, externalId, title, imageUrl, priceCentavos, currency, available, url, attribution }] }`

### `POST /api/events/:id/registry/from-retailer`
Owner. Body `{ retailer, externalId }`. Re-reads the item from the store and adds it as a `retailer_api` registry item. → registry overview.

### `POST /api/events/:id/registry/refresh-availability`
Owner. Re-checks price and stock of every retailer-backed item; 429 when any item was checked less than an hour ago. → registry overview + `refreshed: { updated, problems[], at }`.

### `GET /api/events/:id/registry/clicks`
Owner. → `{ clicks: { [itemId]: count } }`

### `GET /api/sites/:slug/registry/:itemId/go`
Public. Records a click (hashed referrer) and 302-redirects to the store's affiliate URL. Private sites: `?t=<site token>`.

### `GET /api/events/:id/fulfilment`
Owner. → `{ orders: [...], cities: [...covered cities], eventCity }`

### `GET /api/events/:id/fulfilment/options?city=`
Owner. → `{ city, cities, partners: [{ id, name, category, products: [{ key, name, priceCentavos, unit, leadDays }], terms, notifyVia }] }` — only partners that cover `city`.

### `POST /api/events/:id/fulfilment/orders`
Owner. Body `{ partnerId, productKey, quantity (≤ 500), city, deliveryAddress?, neededBy? (YYYY-MM-DD), notes? }`. 409 with 5 open (submitted|confirmed) orders on the event; 10/hour per user. Notifies the partner in the background (email or signed webhook to a public host only) and stores the result on the order when it resolves. → same as GET.

### `POST /api/events/:id/fulfilment/orders/:orderId/cancel`
Owner. Body `{ reason? }`. Only while `submitted` or `confirmed`. Partner is notified. → same as GET.

### `POST /api/partners/fulfilment/:orderId/status`
Public, signed. Header `X-Lazo-Signature: sha256=<HMAC-SHA256(partner secret, raw body)>`. Body `{ status: confirmed|rejected|in_production|shipped|delivered, reference?, note? }`. → `{ ok, orderId, status }`

### `GET|POST /api/admin/fulfilment/partners`, `PATCH|DELETE /api/admin/fulfilment/partners/:partnerId`
Admin. Body `{ category, name, contactEmail?, phone?, coverage[], products[], notifyVia, webhookUrl?, terms?, active?, rotateSecret? }`. → `{ partners }` (includes `webhookSecret`).

### `GET /api/admin/fulfilment/orders`, `PATCH /api/admin/fulfilment/orders/:orderId`
Admin. Body `{ status?, note?, partnerReference?, paymentStatus? }`. → `{ orders }` with event, partner, timeline, notification.

### E — Corporate and memorial modes, Mercado Pago — `20261012000000_modes_mercadopago.sql`

Modes:

| Route | Purpose |
|---|---|
| `GET /api/event-types` | Now also `vocabulary: { es: {…}, en: {…} }`, `privacyDefaults: { passwordRequired, searchable, guestUploads, showGuestCount }`, `sections: string[]` per type (defaults before the migration). |
| `GET /api/events/:id` | Now also `privacy: { passwordRequired, searchable, guestUploads, showGuestCount }`, seeded from the mode on create. |
| `PATCH /api/events/:id/site-content` | Also accepts `agenda: [{ time, title, speaker, description }]`, `speakers: [{ name, role, bio, photoUrl }]`, `materials: [{ title, url, description }]`, `life: { born, died, biography, obituary, photoUrl }` (dates YYYY-MM-DD), `condolences: { enabled, intro }`, `donations: { org, url, note }`. Response `publish` gains `passwordRequired`. |
| `POST /api/events/:id/publish` | 400 when the mode requires a password and none is set. |
| `GET /api/sites/by-slug/:slug` | Now also `sections`, `vocabulary`, `showGuestCount`; `rsvp.open` is false and `registry` empty when the mode lacks those sections. |
| `GET /api/events/:id/condolences` · `PATCH …/condolences/:condolenceId { approved }` · `DELETE …/condolences/:condolenceId` | Owner. `{ condolences: [{ id, name, message, approved, createdAt }], pending }`. |
| `GET/POST /api/sites/:slug/condolences` | Public (token on private sites). Approved list; `POST { name?, message }` → `{ ok, pending: true }`; 403 unless the host enabled condolences. |

Payments:

| Route | Purpose |
|---|---|
| `GET /api/payments/config` | Public. `{ configured, provider, methods, webhook, gateways: [{ key, label, methods, active, configured, default }] }`. `GET /api/plans` returns the same object as `payments`. |
| `POST /api/events/:id/checkout` | Owner. `{ product, gateway?: 'stripe'\|'mercadopago' }` → `{ url, attemptId, gateway }`. Default gateway: `PAYMENTS_DEFAULT_GATEWAY`, else `payment_gateways.is_default`, else the first configured. |
| `POST /api/checkout/confirm` | Owner. Stripe: `{ session }`. Mercado Pago: `{ gateway: 'mercadopago', paymentId }` (or `?gateway=mercadopago&payment_id=`) → `{ applied, status, tier? }`. |
| `POST /api/webhooks/mercadopago` | Public, verified with `x-signature`/`x-request-id` against `MERCADOPAGO_WEBHOOK_SECRET`; re-reads the payment from the API and applies it (idempotent). |
| `POST /api/admin/payments/:id/refund` | Admin. `{ amountCentavos?, reason }` → `{ refunded, amountCentavos, reference, status }` on the attempt's own gateway. The amount is reserved (`payment_attempts.refund_pending`) before the gateway call; a concurrent refund over the charge → 409. A full refund of a plan sets `events.tier` back to the best remaining paid plan (or Free). |
| `GET /api/admin/payments/reconcile?from=YYYY-MM-DD&to=YYYY-MM-DD&gateway=stripe\|mercadopago` | Admin. `{ gateway, from, to, ok, totals: { oursCents, gatewayCents, oursCount, gatewayCount }, matched, mismatched: [{ attempt, gateway, problem }], missingInGateway, missingInDb }`. |
| `GET /api/admin/payments` | Now also `gateway`, `gatewayPaymentId`, `refundedCents`, `refundReference`, `refundedAt` per payment, `summary.refunded`, and `gateways`. |

### F — Analytics warehouse — `src/analytics/`, `20261013000000_analytics_warehouse.sql`

All `/api/admin/analytics/*` and the host route answer 503 naming `DATABASE_URL` when it is not set, and naming the migration when the `analytics` schema is missing.

### `GET /api/admin/analytics/config`
Whether the warehouse is reachable, the scheduler interval, which gateways can be reconciled, and the chart metrics.

```json
{ "configured": true, "intervalMinutes": 360, "gateways": { "stripe": true, "mercadopago": false },
  "metrics": [{ "key": "site_views", "label": "Site views", "unit": "count" }] }
```

### `GET /api/admin/analytics/overview?from&to`
Operating metrics for the range (YYYY-MM-DD, default last 30 days, max 400), computed from the `analytics` schema only. `ingest.hasRun=false` means the warehouse is empty. Sections: `events` (created/claimed/paid/published/liveTotal/publishRate), `siteViews`, `rsvps` (rate), `gifts`, `revenue` (byGateway[] gateway/flow/attempts/succeeded/failed/grossCents/refundedCents/feeCents; lazoRevenueCents, gmvCents, refundsCents, providerCostCents), `orders`, `vendors` (leads, listingViews, activeVendors), `messages` (byChannel[], deliveryRate), `chat[]` (avgFirstResponseSeconds per kind), `photos`, `reconciliation` (ok/mismatch/unchecked counts).

### `GET /api/admin/analytics/series?metric=&from&to`
One zero-filled daily series for charts. `metric` is one of the keys from `config` (site_views, events_created, events_published, events_paid, rsvps, gifts, gift_amount, revenue, refunds, gateway_fees, vendor_leads, vendor_views, messages_sent, messages_failed, chat_messages, chat_first_response, photos, orders_gmv).

```json
{ "metric": "revenue", "label": "Revenue (succeeded payments)", "unit": "cents", "from": "2026-09-01", "to": "2026-09-26",
  "points": [{ "day": "2026-09-01", "value": 0 }] }
```

### `GET /api/admin/analytics/ingest`
Scheduler state and the last 20 runs: `{ configured, running, intervalMinutes, nextRunAt, freshnessMinutes, lastOk, recent[] }`; a run is `{ id, startedAt, finishedAt, status: "running"|"ok"|"error", rows, error, windowFrom, windowTo, trigger }`.

### `POST /api/admin/analytics/ingest`
Runs one incremental ingest now (last successful window end − 1 day → now) and returns the run row. 409 while another run is in progress in this process.

### `GET /api/admin/analytics/reconciliation?from&to`
Rows of `analytics.revenue_reconciliation`: `{ day, gateway, dbGross, gatewayGross, dbCount, gatewayCount, gatewayFeeCents, delta, status: "ok"|"mismatch"|"unchecked", note, checkedAt }`.

### `POST /api/admin/analytics/reconcile`
Body `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }` (≤ 92 days). Fetches the gateway's totals for those days (Stripe via SDK; Mercado Pago when `MERCADOPAGO_ACCESS_TOKEN` is set), writes verdicts, and returns `{ rows, gateways: { stripe: "checked"|"unchecked", ... } }`.

### `GET /api/events/:id/analytics/daily?from&to`
Owner-only. The event's daily site views, RSVP answers by status and gifts by status from the warehouse, with `asOf` (last ingest window end). 503 when no ingest has run or the last one is older than 30 h — use `GET /api/events/:id/stats` (live) instead.

### `GET /api/event-types` — `gifts` (2026-09-26)

Each type now carries `gifts: { hint, fundLabel, fundExample, itemExample, searchIdeas[] }` from `event_modes.gifts` (`20261016000000_mode_gifts.sql`). Empty strings and `[]` until the migration is applied.
