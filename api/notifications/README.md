# `api/notifications/` - the in-app notification inbox

Authenticated endpoints behind the notification bell: list the caller's recent notifications, mark one or all as read, dismiss (delete) one, record delivery-funnel events, and read or edit the category-by-channel preference matrix. Each file is its own HTTP route (`api/notifications/read-all.js` serves `POST /api/notifications/read-all`, see [`api/README.md`](../README.md) for the routing rules). Mapped in [`STRUCTURE.md`](../../STRUCTURE.md) under "Notification bell & preferences".

Why this layer exists: notifications are written once into the `user_notifications` table by [`../_lib/feed.js`](../_lib/feed.js) (`publishUserEvent()`) from every producing feature (remixes, DMs, coin graduations, follows, sales, purchases, IRL, market alerts, account events), and fan out to the extra channels through [`../_lib/notify.js`](../_lib/notify.js). These endpoints are the read/manage side of that pipeline: one inbox contract that the bell dropdown, the full `/notifications` page, the dashboard settings panel, and the [`packages/notifications-mcp`](../../packages/notifications-mcp/README.md) MCP server all share.

Every route requires authentication and answers `401 { "error": "unauthorized" }` without it. Reads and writes accept a session cookie or a bearer credential (API key / OAuth) via `getRequestUser()`; state-changing routes also require CSRF for cookie sessions ([`../_lib/csrf.js`](../_lib/csrf.js)), which self-exempts bearer callers. All rows are account-scoped: every query filters on the caller's `user_id`, so one user can never read, mark, or delete another's notifications. Rate limits are per user via [`../_lib/rate-limit.js`](../_lib/rate-limit.js); errors follow the platform shape from [`../_lib/http.js`](../_lib/http.js).

## Endpoints

| Route | Does | Notes |
| --- | --- | --- |
| `GET /api/notifications?limit&type&before` | List recent notifications, newest first | `limit` 1..50 (default 20); `type` filters one notification type (e.g. `?type=pump_alert`, validated against `^[a-z0-9_]{1,40}$`); `before` is a `created_at` cursor for "load more" on [`pages/notifications.html`](../../pages/notifications.html). Returns `{ notifications, unread_count, has_more }` |
| `POST /api/notifications/:id/read` | Mark a single notification as read | Idempotent (`read_at = coalesce(read_at, now())`); returns `{ id, read_at }`, 400 if `:id` is not a uuid, 404 if the row is not the caller's. Handler: [`[id]/read.js`](./%5Bid%5D/read.js) |
| `DELETE /api/notifications/:id` | Permanently remove one notification | The bell's dismiss action and the MCP `delete_notification` tool; returns `{ ok, id, deleted }`. Handler: [`[id]/index.js`](./%5Bid%5D/index.js) |
| `POST /api/notifications/read-all` | Mark every unread notification as read | Returns `{ marked_read: <count> }` |
| `POST /api/notifications/track` | Record a re-engagement funnel event | Body `{ notification_id?, channel: 'push'\|'in_app', event: 'opened'\|'returned' }`. Closes the sent-to-opened-to-returned loop: the service worker ([`public/push-sw.js`](../../public/push-sw.js)) fires `opened` on push click, the app fires `returned` when it boots from `?source=push`. Session-auth only, CSRF-exempt idempotent beacon (deduped by a partial unique index); `sent` rows are written server-side by [`../_lib/notify.js`](../_lib/notify.js) |
| `GET /api/notifications/preferences` | Read the full resolved preference matrix | Returns `{ categories, channels, prefs, push: { subscribed_devices } }`, everything the settings UI renders from |
| `PUT /api/notifications/preferences` | Save preference overrides | Body `{ categories: { <cat>: { <channel>: bool } }, telegram_chat_id? }`; sanitised sparse overlay, unknown keys dropped, returns the re-resolved matrix. **Partial:** the body merges onto what is stored, so a key you omit keeps its saved value. Send `telegram_chat_id: null` (or `''`) to disconnect Telegram deliberately. A malformed body is a 400 that writes nothing, never a silent reset |

## The preference matrix

Defaults and resolution live in [`../_lib/notify-prefs.js`](../_lib/notify-prefs.js), the shared module both `preferences.js` and the delivery pipeline import:

- `CATEGORIES`: the seven user-facing groups every notification type maps into: `sales`, `purchases`, `social`, `irl`, `alerts`, `creations`, `account` (each with a label and description for the UI). `categoryForType()` maps any notification `type` to its category; unmapped types fall back to `account` so a new type is never silently undeliverable.
- `CHANNELS`: `in_app` (the bell inbox, on by default for every category), `push` (Web Push, on by default but only reaches users who subscribed a device), `email` (defaults on only for money and security categories), `telegram` (opt-in, needs a linked chat id).
- `resolvePrefs(userId)` overlays the user's stored sparse prefs (table `notification_preferences`) onto the defaults, so a user who has never saved gets a sensible matrix and new categories appear automatically. `channelEnabled(prefs, type, channel)` is the single delivery gate the send path consults.
- `readStoredPrefs(userId)` returns that stored sparse row untouched, without the defaults overlaid. The `PUT` merges onto it rather than onto the resolved matrix, so saving one category never freezes today's defaults for every other category into the row.

Muting `in_app` for a category really does silence the bell for it: [`../_lib/notify.js`](../_lib/notify.js) checks `channelEnabled(prefs, type, 'in_app')` *before* inserting into `user_notifications`, so a muted category writes no row, contributes nothing to `unread_count`, and never appears in `GET /api/notifications`. The other channels are independent: a user who mutes the bell for `social` but leaves push on still gets the OS notification (its payload simply carries a null `notificationId`). Turning `in_app` back on affects new notifications only; nothing is backfilled.

## Consumers

- Bell dropdown client: [`src/notifications.js`](../../src/notifications.js) (poll, unread badge, per-item read/dismiss, `track` beacon).
- Full notification center: [`pages/notifications.html`](../../pages/notifications.html), served at `/notifications` (route table in [`vercel.json`](../../vercel.json)), uses the `before` cursor for paging.
- Preference editor: [`src/dashboard-next/pages/settings.js`](../../src/dashboard-next/pages/settings.js) at `/dashboard/settings`.
- Push plumbing: [`src/push-notifications.js`](../../src/push-notifications.js) and [`public/push-sw.js`](../../public/push-sw.js) report funnel events into `track`.
- Machine clients: [`packages/notifications-mcp`](../../packages/notifications-mcp/README.md) exposes the same endpoints as MCP tools over bearer auth.

## Usage

No install step: these deploy with the rest of `api/` and run locally under the dev server (`npm run dev`, port 3000, Vite proxies `/api`). No extra env vars; the endpoints use the platform database (`DATABASE_URL`) and session/auth stack already configured for `api/`.

Example, straight from the route contract at the top of [`index.js`](./index.js) (`GET /api/notifications` lists recent notifications for the authenticated user):

```sh
curl -s 'https://three.ws/api/notifications?limit=5' \
  -H 'Cookie: session=<your session cookie>'
```

Returns `{ "notifications": [ { "id", "type", "payload", "read_at", "created_at" } ], "unread_count": <int>, "has_more": <bool> }`. Add `&type=pump_alert` to scope to one notification type, or pass the last row's `created_at` as `&before=` to page further back. Unauthenticated calls answer `401 { "error": "unauthorized", "message": "sign in required" }`.

## Related

- [`api/README.md`](../README.md), how routing, `_lib/`, and auth work across the whole API surface.
- [`docs/social-layer.md`](../../docs/social-layer.md), the product-level doc for the social features that feed this inbox.
- [`packages/notifications-mcp/README.md`](../../packages/notifications-mcp/README.md), the MCP server built on these endpoints.
- [`STRUCTURE.md`](../../STRUCTURE.md), the map of every product surface.
