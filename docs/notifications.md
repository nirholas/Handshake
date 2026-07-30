# Notifications: the bell, the /notifications center, and the inbox API

Everything that happens to your work on three.ws (a payment lands, a skill
sells, someone remixes your model, follows you, a quest finishes, a royalty
arrives) becomes a row in one per-user inbox. Two surfaces read that inbox:
the bell in the site header, and the full notification center at
[/notifications](https://three.ws/notifications). This page documents both
surfaces as coded, the category system behind the filter tabs, and the
complete API contract. Where those notifications come from (which features
fire which events) is covered in [The social layer](./social-layer.md#notification-bell);
this page picks up where that one leaves off.

| Piece | Where | Source |
|---|---|---|
| Bell dropdown | The bell button in the header, on every page | [src/notifications.js](../src/notifications.js) |
| Notification center | [/notifications](https://three.ws/notifications) | [pages/notifications.html](../pages/notifications.html), [src/notifications-page.js](../src/notifications-page.js) |
| Preference editor | `/dashboard/settings` | [src/dashboard-next/pages/settings.js](../src/dashboard-next/pages/settings.js) |
| Inbox API | `GET/POST/DELETE /api/notifications/*` | [api/notifications/](../api/notifications/README.md) |

One inbox, two views. The dropdown holds the latest page for a quick glance;
the `/notifications` page adds category tabs, per-row delete, and cursor
pagination for the full history. Both import the same icon, label, link, and
escaping helpers from [src/notifications.js](../src/notifications.js), so a
notification always reads identically in both places.

---

## The notification record

Every row the API returns is

```
{ id, type, payload, read_at, created_at }
```

- `type` is a machine string like `skill_purchased`, `remix`, `follow`,
  `quest_complete`, or `royalty_paid`. The full producing vocabulary is
  `USER_EVENT_TYPES` in [api/_lib/feed.js](../api/_lib/feed.js) plus the types
  written directly by the purchase, forge, withdrawal, and security flows.
- `payload` carries the type-specific details (actor name, skill name, amounts,
  a `link` for click-through). The human-readable sentence is built client-side
  by `notifLabel()`; the click target is resolved by `notifLink()` from
  `payload.link`, then a Solana transaction signature (`payload.tx_signature`,
  linked to its Solscan page), then `payload.agent_id`.
- `read_at` is null until the notification is read; `created_at` orders the
  inbox and doubles as the pagination cursor.

Payload values are other users' text, so both surfaces HTML-escape every
interpolated string, and `notifLink()` only permits same-origin relative paths
or absolute `http(s)` URLs. A hostile payload cannot inject markup or drive
navigation into a `javascript:` URL. Payment amounts denominated in `$THREE`
render with the `$THREE` label; other recognized mints render with their
standard symbol, and an unrecognized mint degrades to a bare number rather
than naming a coin.

## Categories: how the filter tabs group types

The `/notifications` page has eight tabs: **All**, **Sales & earnings**,
**Purchases**, **Social**, **In person**, **Market alerts**, **Creations**,
and **Account**. Each notification type maps to exactly one category; the
mapping (`TYPE_CATEGORY`) lives in
[api/_lib/notify-prefs.js](../api/_lib/notify-prefs.js) and is mirrored in
[src/notifications-page.js](../src/notifications-page.js) for tab filtering.

| Category (tab) | Key | Notification types |
|---|---|---|
| Sales & earnings | `sales` | `skill_purchased`, `asset_purchased`, `sale`, `payment-earned`, `payment_received`, `referral_earned`, `referral_signup`, `referral_reward`, `pump_launch_filled`, `royalty_paid` |
| Purchases | `purchases` | `skill_purchase_confirmed`, `asset_purchase_confirmed`, `skill_gift_received`, `skill_gift_sent` |
| Social | `social` | `remix`, `reply`, `embed`, `mention`, `fork`, `follow`, `dm_received`, `agent_review`, `quest_complete` |
| In person | `irl` | `irl_interaction`, `irl_reply` |
| Market alerts | `alerts` | `pump_alert` |
| Creations | `creations` | `forge_complete`, `forge_failed` |
| Account | `account` | `withdrawal_completed`, `withdrawal_failed`, `payment_mismatch`, `asset_payment_mismatch`, `skill_payment_mismatch`, `security_alert`, `wallet_anomaly_frozen`, plus any type not in the map |

Two details worth knowing:

- **Unmapped types fall back to `account`**, so a newly added notification
  type is never silently undeliverable or unfilterable.
- **Tab filtering is client-side** over the pages already fetched. The API's
  own `?type=` parameter filters server-side by a single exact type (e.g.
  `?type=pump_alert`), not by category.

## How the bell and unread state work

The bell ([src/notifications.js](../src/notifications.js)) is mounted by the
shared nav on every page and is deliberately cheap:

- **Auth-aware.** It reads a local sign-in hint (`3dagent:auth-hint` in
  localStorage). Signed out: no polling at all, the badge stays hidden, and
  opening the panel shows a sign-in prompt instead of an empty inbox.
- **Polling.** Signed in, it fetches `GET /api/notifications?limit=20` every
  30 seconds, re-polls when the tab regains focus, and pauses while the tab
  is hidden.
- **One fetch per user, not per tab.** All open tabs share the result through
  a localStorage cache plus a BroadcastChannel: whichever tab wins a
  best-effort fetch lock spends the request and broadcasts the payload;
  every other tab reuses it for the poll interval. A new tab seeds its badge
  from the cache instantly without its own request.
- **Backoff.** A 429 from the per-user rate budget starts an exponential
  backoff (doubling from 30 seconds, capped at 5 minutes), so the badge
  self-heals without hammering a drained budget.
- **The badge** shows the server's `unread_count` (rendered as `99+` past 99),
  updates its `aria-label`, and announces changes politely to screen readers.
- **Opening the panel marks everything read.** The dropdown is a glance
  surface: if anything is unread when it opens, it fires
  `POST /api/notifications/read-all` and zeroes the badge. Clicking a single
  row also marks that row read, sends an `opened` funnel beacon to
  `POST /api/notifications/track`, and navigates to the resolved link.
- **Push upsell at the value moment.** While the panel is open (never on page
  load), a one-time banner offers Web Push if it is supported, configured,
  not yet subscribed, and not previously declined. Push plumbing lives in
  [src/push-notifications.js](../src/push-notifications.js) and
  [public/push-sw.js](../public/push-sw.js).

## The notification center: /notifications

[pages/notifications.html](../pages/notifications.html) (served at
`/notifications`, `noindex`) is the overflow surface the dropdown never has
to be: full history, filterable, deletable.

- **Auth wall.** Without the local sign-in hint (or on a 401 from the API)
  the page shows a sign-in wall linking to `/login?next=/notifications`.
- **Category tabs** filter the fetched list client-side per the table above.
  The active tab is reflected with `aria-selected`; each empty category has
  its own designed empty state.
- **Pagination.** Pages of 30 load via the `before` cursor: the Load more
  button passes the last row's `created_at` back to the API and appends the
  result. The button renders only while the API reports `has_more`.
- **Per-row actions.** Clicking a row marks it read, tracks the open, and
  navigates. The delete button on each row removes it permanently
  (`DELETE /api/notifications/:id`), optimistically in the UI and
  fire-and-forget on the wire. Mark all read clears everything at once.
- Unlike the dropdown, the page never auto-marks the whole inbox read on
  open; unread rows stay highlighted until clicked or bulk-cleared.

## API contract

All endpoints require authentication: a session cookie or a bearer credential
(API key / OAuth). Unauthenticated calls answer
`401 { "error": "unauthorized" }`. State-changing routes additionally require
a CSRF token for cookie sessions (fetch one from `GET /api/csrf-token`, echo
it in the `X-CSRF-Token` header); bearer callers are CSRF-exempt, which is
what the examples below use. Every query is scoped to the caller's `user_id`,
so one user can never read, mark, or delete another's notifications. The
same endpoints are exposed as MCP tools by
[packages/notifications-mcp](../packages/notifications-mcp/README.md).

### List the inbox

```
GET /api/notifications?limit=20&type=<type>&before=<iso>
```

`limit` is 1..50 (default 20). `type` filters one exact notification type.
`before` pages past a `created_at` cursor.

```sh
curl -s 'https://three.ws/api/notifications?limit=5' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

```json
{
  "notifications": [
    {
      "id": "5f3c9c2a-1111-4222-8333-444455556666",
      "type": "remix",
      "payload": { "actor": "mira", "royaltyPaid": true, "royaltyUsd": 0.012, "link": "/viewer?src=..." },
      "read_at": null,
      "created_at": "2026-07-30T09:14:02.511Z"
    }
  ],
  "unread_count": 3,
  "has_more": false
}
```

> Source: [api/notifications/index.js](../api/notifications/index.js).

### Mark one read

```sh
curl -s -X POST \
  'https://three.ws/api/notifications/5f3c9c2a-1111-4222-8333-444455556666/read' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

Returns `{ id, read_at }`. Idempotent: an already-read row keeps its original
`read_at`. 404 if the row is not the caller's.

> Source: [api/notifications/[id]/read.js](../api/notifications/%5Bid%5D/read.js).

### Mark everything read

```sh
curl -s -X POST 'https://three.ws/api/notifications/read-all' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

Returns `{ marked_read: <count> }`.

> Source: [api/notifications/read-all.js](../api/notifications/read-all.js).

### Delete one

```sh
curl -s -X DELETE \
  'https://three.ws/api/notifications/5f3c9c2a-1111-4222-8333-444455556666' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

Returns `{ ok: true, id, deleted: true }`; 400 for a non-UUID id, 404 if the
row is not the caller's. Removal is permanent.

> Source: [api/notifications/[id]/index.js](../api/notifications/%5Bid%5D/index.js).

### Track a funnel event

```
POST /api/notifications/track
{ "notification_id": "<uuid>", "channel": "push" | "in_app", "event": "opened" | "returned" }
```

An idempotent analytics beacon closing the sent-to-opened-to-returned loop:
the service worker fires `opened` on a push click, the app fires `returned`
when it boots from a push-sourced open. Session-cookie auth only (no bearer),
CSRF-exempt, deduplicated server-side.

> Source: [api/notifications/track.js](../api/notifications/track.js).

### Preferences

```sh
# Read the resolved category x channel matrix
curl -s 'https://three.ws/api/notifications/preferences' \
  -H 'Authorization: Bearer YOUR_API_KEY'

# Turn push off for the social category
curl -s -X PUT 'https://three.ws/api/notifications/preferences' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'content-type: application/json' \
  -d '{ "categories": { "social": { "push": false } } }'
```

GET returns `{ categories, channels, prefs, push: { subscribed_devices } }`:
the seven categories from the table above, the four channels (`in_app`,
`push`, `email`, `telegram`), and the caller's resolved matrix. PUT stores a
sparse override; unknown categories, channels, and keys are dropped, and the
response echoes the re-resolved matrix. The body also accepts
`telegram_chat_id` (digits, settable and clearable) for the Telegram channel.

Delivery gating notes, all enforced in
[api/_lib/notify-prefs.js](../api/_lib/notify-prefs.js):

- Muting `in_app` for a category writes no inbox row at all for it: nothing
  in `unread_count`, nothing in `GET /api/notifications`, and turning it back
  on is not retroactive. The channels are independent, so a muted bell with
  push left on still delivers the OS notification.
- The `account` category's `in_app` channel is locked on. It is the durable
  record of withdrawals and security events, and the fallback bucket for
  unmapped types; the other three channels stay fully mutable.
- A user who never saved gets the defaults, and new categories light up
  automatically without a backfill.

The visual editor for all of this is the Notifications panel in
`/dashboard/settings` ([source](../src/dashboard-next/pages/settings.js)),
one click from the gear icon in both notification surfaces.

> Source: [api/notifications/preferences.js](../api/notifications/preferences.js).
> The endpoint-level README at
> [api/notifications/README.md](../api/notifications/README.md) covers the
> same routes from the operator's side (rate limits, table names, routing).

---

## Related pages

- [The social layer](./social-layer.md): where notification events come from
  and how they connect to the feed, follows, and portfolios.
- [api/notifications/README.md](../api/notifications/README.md): the
  endpoint directory's own reference.
- [packages/notifications-mcp](../packages/notifications-mcp/README.md): the
  same inbox as MCP tools for machine clients.
