# `api/irl/` - agents in the real world (AR surface backend)

The backend for [/irl](../../pages/irl.html): place a 3D agent at a real GPS coordinate, let passers-by discover it in AR, and route everything that happens around it (taps, messages, payments, money drops, proof-of-presence quests) back to the owner. Each file is its own HTTP route per the repo routing rules in [`api/README.md`](../README.md); the subpath routes (`/api/irl/drops/:id/claim`, `/api/irl/world-lines/nearby`, `/irl/s/:token`, ...) are mapped in `vercel.json`.

Why this layer is shaped the way it is:

- **Location privacy is the product constraint.** A pin database is a map of where people stand. The only surface that ever reveals a precise coordinate is the fix-gated nearby read: callers must first mint a short-lived, HMAC-signed proof that they physically have a GPS fix in a coarse (~150 m) cell ([`../_lib/irl-presence.js`](../_lib/irl-presence.js)), and every other projection (share pages, drop reads for non-owners, World Line browse, notifications, logs) is coordinate-free or coarsened. The full analysis lives in [`docs/irl/THREAT-MODEL.md`](../../docs/irl/THREAT-MODEL.md).
- **Anonymous-friendly identity.** Every endpoint accepts a session user OR an anonymous device token ([`../_lib/irl-auth.js`](../_lib/irl-auth.js), sent in the `x-irl-device` header, body for mutations, never a query string), so placing and discovering agents needs no account while ownership stays enforceable.
- **Real money, real custody.** Drops escrow real SOL/USDC in a fresh per-drop wallet, funded by the creator's own signed transfer and released on a presence-proven claim ([`../_lib/irl-drops.js`](../_lib/irl-drops.js)). Nothing is simulated.
- **Bounded data retention.** Interaction rows snapshot a location trail, so the hourly reaper ([`../cron/irl-reap.js`](../cron/irl-reap.js)) cascade-deletes them with their pin and ages everything out at 180 days, and the privacy center makes deletion self-serve.

## Endpoints

| Route | What it does |
| --- | --- |
| `POST /api/irl/fix-token` `{ lat, lng, accuracy? }` | Mints the proof-of-presence token (`{ token, expires_in, cell }`) that gates every nearby read. Stateless, coordinate never logged, response no-store. [`fix-token.js`](./fix-token.js) |
| `GET /api/irl/pins?lat=&lng=&radius=40` | Nearby pins for the caller's proven cell (`x-irl-fix` header when enforcement is on). [`pins.js`](./pins.js) |
| `GET /api/irl/pins/mine?deviceToken=` / `?mine=1` | The caller's own pins (device token or auth). |
| `POST /api/irl/pins` `{ lat, lng, heading, avatarUrl, avatarName, caption, agentId }` | Place an agent. Moderation-gated (profanity floor + Granite Guardian tier, $THREE-only coin guard), density-capped per geocell and per owner. |
| `PATCH /api/irl/pins` | Owner edits: caption/avatar/location, AR pose calibration (`calibrate`), whole-room alignment (`calibrateRoom`), pinch scale. |
| `DELETE /api/irl/pins?id=` / `?all=1&deviceToken=` | Remove one pin, or purge every pin from a device. |
| `POST /api/irl/pins/interact` `{ pinId, event, deviceToken }` | Log a lightweight tap/view against a pin. |
| `POST /api/irl/interactions` | The full encounter record: `view` / `tap` / `message` / `pay` (settlement-signature-verified, $THREE/USDC only), owner replies via `replyTo`. Fans out owner/visitor notifications. [`interactions.js`](./interactions.js) |
| `GET /api/irl/interactions?mine=1[&unread=1]` / `?pinId=` | Owner inbox (newest first, joined with pin identity), or a public per-pin count. |
| `GET /api/irl/interactions-stream` | SSE tail of the owner's inbox: one shared adaptive poll loop per warm instance fans new rows to every connected owner within ~1 s. Consumed by [`src/dashboard-next/pages/irl-placements.js`](../../src/dashboard-next/pages/irl-placements.js). [`interactions-stream.js`](./interactions-stream.js) |
| `GET/POST /api/irl/drops...` | Money Drops and bounties: create (`POST /api/irl/drops` returns `{ drop, escrow_address }`), fund (`POST /api/irl/drops/:id/fund { signature }`), presence-gated claim (`POST /api/irl/drops/:id/claim`), owner cancel with real refund, nearby/mine/single reads. [`drops.js`](./drops.js) |
| `GET/POST /api/irl/world-lines...` | Agent-placed proof-of-presence AR quests: create, fix-gated `nearby`, coordinate-free `browse`, creator `mine`, earned `collectibles`, `challenge` nonce, `complete` ceremony (the agent's own wallet signs the proof), public `verify/:proofId`. [`world-lines.js`](./world-lines.js) |
| `GET /api/irl/agent-card?agent_id=` (or `?pin=`) | The rich tap-popup card in one round-trip: agent record + Solana attestation reputation (derived tier and 0-100 score) + the agent's paid x402 services. Public, cached. [`agent-card.js`](./agent-card.js) |
| `GET /api/irl/agent-summary?mine=1` | One row per owned pin (identity + derived activity + `status`) so the owner dashboard paints without N calls. Auth required. [`agent-summary.js`](./agent-summary.js) |
| `GET /api/irl/analytics` | Site-wide usage rollup (pins placed, nearby reads, shares, drop claims). Ops-gated (admin session or `OPS_SECRET`). [`analytics.js`](./analytics.js) |
| `GET/PATCH/DELETE /api/irl/privacy` | The privacy center: plain-language data summary, `?export=1` full JSON export, unpublish/republish a pin, delete one pin / everything / forget-this-device (purges interactions the device authored elsewhere too). [`privacy.js`](./privacy.js) |
| `POST /api/irl/report` `{ pinId, reason, deviceToken? }` | Community moderation: distinct-reporter dedup, per-pin 24 h ceiling, threshold hide (never delete, owner can appeal). [`report.js`](./report.js) |
| `POST /api/irl/share?pinId=&deviceToken=` | Owner uploads their composite AR photo (raw PNG body) and mints a permanent share token: `{ token, url, imageUrl }`. [`share.js`](./share.js) |
| `GET /irl/s/:token` | The unfurlable share page (real `og:image` of the capture, caption and agent name only, never coordinates). [`share/[token].js`](./share/%5Btoken%5D.js) |

## Usage

No install step: these deploy with the rest of `api/` and run locally under the dev server (`npm run dev`, port 3000, Vite proxies `/api`). Presence enforcement follows `fixEnforced()` in [`../_lib/irl-presence.js`](../_lib/irl-presence.js): with the signing secret unset (local dev) the nearby reads answer without a token; in production the `x-irl-fix` header is required.

Example, straight from the route contracts at the top of [`fix-token.js`](./fix-token.js) and [`pins.js`](./pins.js): mint a presence proof for where you are standing, then read the pins around you.

```sh
TOKEN=$(curl -s -X POST https://three.ws/api/irl/fix-token \
  -H 'content-type: application/json' \
  -d '{"lat":40.7580,"lng":-73.9855,"accuracy":12}' | jq -r .token)

curl -s 'https://three.ws/api/irl/pins?lat=40.7580&lng=-73.9855&radius=40' \
  -H "x-irl-fix: $TOKEN"
```

The first call returns `{ token, expires_in, cell }`; the second returns the public pin projection (avatar URL, caption, heading, anchor scale) for agents placed within 40 m of the proven cell. A token minted for a different cell gets an empty answer, which is the whole point.

## Shared internals

- [`../_lib/irl-presence.js`](../_lib/irl-presence.js): `mintFixToken`, `verifyFixToken`, `fixEnforced` (the HMAC presence proof).
- [`../_lib/irl-auth.js`](../_lib/irl-auth.js): `readDeviceToken` (anonymous ownership, null-guarded so an empty token can never match another owner's rows).
- [`../_lib/irl-drops.js`](../_lib/irl-drops.js): drop escrow lifecycle (`createDrop`, `confirmFunding`, `reserveClaim`, `releaseFromEscrow`, refund sweep).
- [`../_lib/irl-analytics.js`](../_lib/irl-analytics.js): `logIrlEvent` and `getIrlAnalyticsSummary` over `irl_events`.
- [`../_lib/geohash.js`](../_lib/geohash.js): the geocell encoding behind density caps and coarse cells (shared with [`packages/irl/`](../../packages/irl)).

## Related

- Product doc (Money Drops, World Lines, the full user flow): [`docs/irl.md`](../../docs/irl.md)
- Privacy threat model: [`docs/irl/THREAT-MODEL.md`](../../docs/irl/THREAT-MODEL.md)
- Frontend: [`src/irl.js`](../../src/irl.js) behind [`pages/irl.html`](../../pages/irl.html) (`/irl`)
- SDK for third-party geofenced presence: [`packages/irl/`](../../packages/irl)
