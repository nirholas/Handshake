# IRL nearby-read — threat model (H7)

The `/irl` world lets anyone place a 3D agent at a real GPS spot and lets a passer-by
discover it in AR. The single most sensitive thing the platform does here is reveal
**where an agent is**. This document states, honestly, what the public nearby read
protects against, how it degrades, and the residual exposure we accept by design.

Three reads return another user's location, all presence-gated and all bounded by a
radius: `GET /api/irl/pins?lat&lng&radius` (≤60 m, the per-viewer proximity feed),
`GET /api/irl/drops?lat&lng&radius` (≤80 m) and `GET /api/irl/world-lines/nearby`
(≤600 m). The pins feed is the one the controls below are written against; drops and
World Lines shipped later and inherit the same fix gate.

(`/api/irl/pins/mine`, `agent-card`, `agent-summary`, `interactions*`, `report`,
`share-frame` do not return others' coordinates. That was established by a
location-leak audit of the pins feed, which predates drops and World Lines and so
does not cover them.)

## What the read protects against

| Threat | Control | Where |
|---|---|---|
| **Remote browsing** ("show me agents in Tokyo from my couch") | The caller must send their **own** `lat`/`lng`; results are filtered to `distance_m <= radius`. There is no bbox/window/roster feed and no realtime pin broadcast. | `api/irl/pins.js` nearby branch; `multiplayer/src/rooms/IrlRoom.js` (syncs no pins) |
| **Wide-radius scrape** | `radius` is clamped to `[10, 60]` m server-side; a present-but-non-finite radius is rejected (no NaN box). | `api/irl/pins.js` `Math.min(60, Math.max(10, …))` |
| **Bulk grid harvest** | Per-IP rate limit on every read; **fail-closed** if the limiter can't decide (deny, never an unmetered window). Distinct-cell **sweep detection** fires a deduped, coordinate-free ops alert when one caller reads many geocells in a short window. | `limitFailClosedRead`, `recordCellRead` in `api/irl/pins.js`; `limits.publicIp` in `api/_lib/rate-limit.js` |
| **De-anonymization** (who placed this agent?) | The public projection is an explicit allow-list: `user_id` / `device_token` are never returned; only an `is_mine` boolean computed server-side. | `api/irl/pins.js` nearby projection |
| **Coordinate fingerprinting** | Returned coordinates are coarsened to 5 decimals (~1.1 m, finer than GPS error but stripped of the false-precision tail). The room origin is coarsened too; exact intra-room layout rides relative offsets, not absolute coords. | `roundCoord`, `PUBLIC_COORD_DP` in `api/irl/pins.js` |
| **Credential / position leak via logs** | `req.url` (which carries `lat`/`lng`/`deviceToken`) is redacted before any log/Sentry/Telegram sink. The sweep alert carries only a SHA-256 IP hash + a count — never a coordinate, IP, or geocell. | `redactUrl` in `api/_lib/http.js`; `recordCellRead` alert payload |
| **Stale / abusive pins surfacing** | `hidden_at IS NULL` (community-moderation hide at 3 distinct reporters) and `expires_at` (anon pins 7-day) filter every read path. | `api/irl/pins.js`, `api/irl/report.js` |

## Degradation behaviour (no silent fail-open)

- **Limiter degraded / throws on the read** → **fail closed**: the read returns a
  retryable `rate_limiter_unavailable` (HTTP 429), surfaced to the client as
  "temporarily unavailable, retrying." It never serves an unmetered read. The
  backing bucket (`limits.publicIp`) is an in-memory `local` limiter that never
  touches Redis, so it does not throw in practice; `limitFailClosedRead` makes the
  guarantee explicit and asserted (`tests/api/irl-pins-hardening.test.js`).
- **Write limiter degraded** (place/edit/delete) → **fail open**: the DB density,
  per-owner, and report-dedup caps still bound writes, so an infra hiccup never
  blocks a legitimate placement. This asymmetry is deliberate: a blind limiter on a
  *write* is bounded downstream; a blind limiter on the *location read* is not.
- **Sweep detection / ops alert** is best-effort: it is fire-and-forget, wrapped so
  it can never delay or fail the read, and degrades to "no alert" if the cache or
  Telegram is unavailable. It never widens or narrows what the read returns.

## Accepted residual exposure (by design — this is the product)

- **A person physically standing at a spot can see the handful of pins right where
  they stand.** That is the entire feature: you discover an agent in AR by being
  next to it. Within the ≤60 m radius, a co-located caller learns those pins'
  coarsened coordinates. We do not consider this a leak — it is the product working.
- **A determined attacker who physically walks a grid** can, cell by cell, see each
  cell's pins as they enter it (a real fix per cell, slowly, tripping neither the
  per-minute limit at low rate nor — if patient enough — necessarily the sweep
  threshold). The sweep detector raises the cost and surfaces the pattern to ops, but
  physical presence is, by definition, allowed to see what is physically present.
  We accept this; the data exposed is still coarsened, owner-stripped, and bounded to
  cells the attacker actually visited.
- **Coordinate precision is ~1.1 m, not exact.** This is a deliberate coverage cap:
  the public read intentionally returns less precision than the placement stored.
  Room-anchored agents keep exact intra-room layout via relative offsets, so the cap
  costs render quality nothing while removing the false-precision fingerprint.

## Proof-of-presence (H3) — live, and what it does NOT buy

`IRL_FIX_SECRET` is set in production, so `fixEnforced()` is true and all three
coordinate reads — `GET /api/irl/pins` (60 m), `GET /api/irl/drops` (80 m) and
`GET /api/irl/world-lines/nearby` (600 m) — reject a request that carries no valid
`x-irl-fix` token, a forged one, an expired one, or one minted more than
`FIX_TOLERANCE_M` (250 m) from the point being read. Before it was enabled, any of
those reads answered for **any coordinate on earth** from anywhere.

**Be honest about the ceiling.** `POST /api/irl/fix-token` mints from
*caller-supplied* `lat`/`lng`. There is no attestation that the caller is really
there — no device integrity check, no signed GNSS. So the token proves the caller
*claimed* a coordinate, not that they occupied it. What enforcement actually buys is
cost: a sweeper must now mint per ~250 m anchor instead of reading arbitrary points,
and both mint (30/min/IP) and read (60/min/IP) are rate-limited.

Concretely, from a single IP: a 60 m pin read covers ~0.011 km², so tiling
Manhattan's ~59 km² takes ~5 200 reads ≈ 90 minutes. World Lines is the cheapest
surface by far — its 600 m radius covers ~1.13 km² per read, so the same area falls
in under a minute. Rotating IPs collapses all of these numbers. Presence enforcement
is a speed bump with a real slope; it is not a wall.

> **Per-IP means per-IP only if the IP is real.** From the Vercel→Cloud Run migration
> until 2026-07-09, `clientIp()` fell back to `req.socket.remoteAddress` — the load
> balancer — so every per-IP bucket on the platform was in fact one global bucket.
> That made the limits simultaneously useless (no per-attacker ceiling) and harmful
> (one caller exhausted everyone's budget; `/api/irl/privacy` answered 429 to its
> first caller). `clientIp()` now reads `X-Forwarded-For` right-to-left, skipping the
> hops our own infrastructure appends and ignoring the caller-settable prefix. The
> numbers above assume that fix is deployed; see `tests/client-ip-proxy.test.js`.

## The control that does hold: private pins

`published = false` makes a pin **private** — it is withheld from every other
reader's nearby, room and World Line feed, while its owner still sees it in AR. A
private pin is not a cost imposed on an attacker; it is an absence. No sweep, at any
budget, with any number of IPs, returns a coordinate the query never selects.

- Enforced in both public pins reads (`api/irl/pins.js`) as
  `published IS NOT FALSE OR <caller owns the row>`, so the owner keeps their view.
- Enforced in the World Lines discovery join (`p.published IS NOT FALSE`), because
  that 600 m feed would otherwise be the cheapest private-pin bypass we ship.
- Anchoring a World Line to a private pin is refused at creation (409), not merely
  filtered at read time — a quest is a public invitation to a coordinate.
- `IRL_DEFAULT_PRIVATE=1` makes new placements private unless they explicitly ask to
  be public. It is set in production: while /irl is pre-launch and its operators test
  from their own homes, the safe default is the one that cannot leak by omission.
- The privacy center's unpublish writes `published`, not `hidden_at`. (`hidden_at`
  is moderation + expiry: it blanks a pin for *everyone*, owner included, which makes
  it useless to someone who wants to keep testing a placement they took out of view.)

Distinct from coordinate coarsening: coarsening reduces the precision of a coordinate
that is still returned. Privacy withholds the row.

## Out of scope here

- Attested presence — a device-signed or GNSS-signed fix would upgrade the token from
  "I claim I am here" to "I am here", denying the token-per-cell sweep described
  above. Until then, private pins, not the fix token, are the guarantee.
- Per-account reputation / banning of repeat sweepers (future).

No limit in this document silently reduces coverage: every cap above is written down.
If a future change tightens the radius, the rate limit, or the coordinate precision
in a way that drops legitimate discovery, update this file in the same change.
