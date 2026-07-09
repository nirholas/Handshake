<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/irl</h1>

<p align="center"><strong>Geofenced, real-world presence for agents and avatars — check in at a place, prove you were there, discover who and what is nearby.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/irl"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/irl?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/irl"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/irl?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/irl?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/irl?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#money-drops">Money Drops</a> ·
  <a href="#world-lines">World Lines</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="https://three.ws/irl">three.ws</a>
</p>

---

> `@three-ws/irl` is the official client for **three.ws IRL** — the layer that
> drops 3D agents and avatars at real-world GPS coordinates and lets people
> *stumble onto them in AR by walking up*. You check in at a spot, mint a
> short-lived proof-of-presence token from your live fix, and read back only the
> agents within a tight radius of where you actually stand. It wraps the public
> `/api/irl/*` endpoints: presence minting, GPS pin placement, the geofenced
> nearby feed, the real-world interaction log, **[Money Drops](#money-drops)**
> (real SOL / USDC / $THREE escrowed at a spot, claimable only by walking up)
> and **[World Lines](#world-lines)** (agent-signed proof-of-presence AR
> quests). Presence is the contract — there is no browseable map, no roster, no
> "query any point on earth." You see what's around you, because you're there.
> It pairs with [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge)
> (make the avatar) and [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar)
> (render it where you placed it).

## Why

Hand-rolling "agents in the real world" looks easy until you hit the privacy
math. A naive `GET /pins?lat=&lng=` is a location-harvest API: anyone scripts a
grid sweep and reconstructs every placement on earth. three.ws IRL closes that
hole structurally, and this SDK gives you the whole flow as plain functions:

- **Presence is proven, not claimed.** Before you can read nearby agents you
  mint a fix token from your *real* geolocation. The server only answers for the
  coarse area that token was minted in — "query anywhere" becomes "query where
  you are." No token banking, no remote scraping.
- **Tight by default.** The nearby feed is radius-capped at **60 m** (default
  40 m), returns at most 50 pins, and is IP rate-limited with sweep detection —
  large enough to render an agent as you walk up, small enough that one read only
  ever reveals the handful right where you stand.
- **Anonymous-friendly.** Place and manage pins from a device token — no login.
  Authenticated owners get permanent pins; anonymous pins lapse after 7 days.
- **Coordinates are minimized.** The public feed coarsens lat/lng to ~1.1 m,
  never returns owner ids, and never logs the caller's position.

This is the SDK twin of the live [/irl](https://three.ws/irl) surface — the same
endpoints, exposed as plain functions.

## Install

```bash
npm install @three-ws/irl
```

Zero runtime dependencies. Works in Node 18+ and the browser (uses `fetch` and,
in the browser, the Geolocation API). To render what you discover, add
[`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar).

## Quick start

Check in where you stand, then see who's around:

```js
import { checkIn, nearby } from '@three-ws/irl';

const fix = await checkIn();              // reads the browser's GPS, mints a presence token
const agents = await nearby(fix);         // only answers for the area you checked in at

for (const a of agents) {
  console.log(a.avatar_name, `${a.distance_m}m away`, a.caption);
}
```

Place your own agent at the spot you're standing on:

```js
import { checkIn, placePin } from '@three-ws/irl';

const fix = await checkIn();
const { pin } = await placePin({
  lat: fix.lat,
  lng: fix.lng,
  avatarName: 'Scout',
  avatarUrl: 'https://cdn.three.ws/forge/scout.glb', // from @three-ws/forge
  caption: 'Say hi — I drop $THREE alpha here',
});

console.log(pin.id, pin.permanent ? 'permanent' : 'expires in 7 days');
```

Pass explicit coordinates (Node, or any non-browser fix source):

```js
const fix = await checkIn({ lat: 40.7411, lng: -73.9897 });
const agents = await nearby(fix, { radius: 60 });
```

Log that you met an agent IRL:

```js
import { interact } from '@three-ws/irl';
await interact({ pinId: agent.id, type: 'tap', message: 'Found you in Madison Square Park' });
```

## API

### `checkIn(input?) → Promise<Presence>`

Establish presence at a location. With no argument it reads the browser's
Geolocation API; pass `{ lat, lng, accuracy? }` to supply a fix yourself. Mints a
short-lived proof-of-presence token via `POST /api/irl/fix-token` and returns it
alongside the fix so `nearby()` can prove the read.

**Returns** `Presence`

| Field | Type | Notes |
|---|---|---|
| `lat` / `lng` | `number` | The fix used to mint the token. |
| `token` | `string` | HMAC-signed presence token (header `x-irl-fix` on reads). |
| `expires_in` | `number` | Token lifetime in seconds — **180** (3 min). Re-`checkIn()` when it lapses. |
| `cell` | `string` | The precision-7 geohash (~153 m) the fix fell in — the client's "re-mint on cell change" trigger. |

The token anchor is coarsened to ~110 m server-side, so the token itself never
carries a fine coordinate. A read is authorized only when its claimed point is
within **250 m** of the anchor and the token is unexpired.

### `nearby(presence, options?) → Promise<Pin[]>`

Read agents within the radius of where you checked in. Wraps
`GET /api/irl/pins?lat=&lng=&radius=` with the presence token in the `x-irl-fix`
header.

| Option | Type | Default | Notes |
|---|---|---|---|
| `radius` | `number` | `40` | Metres. Clamped server-side to **10–60 m**. |

Each returned `Pin` (allow-list projection — never `user_id` or `device_token`):

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Pin UUID. |
| `agent_id` | `string \| null` | Linked agent identity, if any. |
| `lat` / `lng` | `number` | Coarsened to ~1.1 m (5 dp). |
| `heading` | `number` | Facing, 0–359°. |
| `distance_m` | `number` | Great-circle metres from your fix. |
| `avatar_url` | `string` | GLB to load (relative or first-party https). |
| `avatar_name` / `caption` | `string \| null` | Public display text. |
| `x402_endpoint` | `string \| null` | First-party pay target for the agent. |
| `view_count` | `number` | Deduplicated visitor count. |
| `avatar_version` | `number` | Bumps on a remote outfit re-skin — diff to swap the GLB. |
| `room_id`, `rel_east_m`, `rel_north_m`, `origin_*` | — | Room frame for shared-anchor clusters (null on standalone pins). |
| `is_mine` | `boolean` | True for the caller's own pins. |

Pins are sorted nearest-first and filtered to those within `radius`.

### `placePin(input) → Promise<{ pin }>`

Drop a 3D agent at a coordinate. Wraps `POST /api/irl/pins`.

| Field | Type | Notes |
|---|---|---|
| `lat` / `lng` | `number` | **Required.** Range-checked. |
| `heading` | `number` | Initial facing in degrees (default 0). |
| `avatarUrl` | `string` | GLB URL — relative same-origin or https (no private hosts). |
| `avatarName` | `string` | ≤ 40 chars. |
| `caption` | `string` | ≤ 140 chars. Content-gated; may reference only `$THREE`. |
| `agentId` | `string` | Link the pin to a registered agent. |
| `x402Endpoint` | `string` | Pay target — must be a first-party three.ws host. |
| `anchor` | `object` | Optional pose `{ heightM, yawDeg, quat, source }` for AR replay. |
| `placementKind` | `'precise' \| 'approximate'` | `approximate` blurs the spot by `fuzzRadiusM` (10–500 m). |

Pass the device token (anonymous ownership) via the `deviceToken` field or set a
default with `configure({ deviceToken })`. Returns `201` with the created pin and
a `permanent` flag (`true` for signed-in owners, `false` — 7-day expiry — for
anonymous).

### `myPins(options?) → Promise<Pin[]>`

List the pins you placed. With a device token, wraps `GET /api/irl/pins/mine`
(the token rides the `x-irl-device` header, never the URL); for a signed-in
session, `GET /api/irl/pins?mine=1`.

### `interact(input) → Promise<object>`

Log a real-world encounter. Wraps `POST /api/irl/interactions`.

| Field | Type | Notes |
|---|---|---|
| `pinId` | `string` | **Required.** The agent you met. |
| `type` | `'view' \| 'tap' \| 'message' \| 'pay'` | `view` repeats from one device collapse within 5 min. |
| `message` | `string` | ≤ 280 chars (for `message`). |
| `deviceToken` | `string` | Anonymous viewer attribution. |

`agent_id` and owner are taken from the pin, never the caller. A `pay` must carry
a valid on-chain settlement signature and a `$THREE`/USDC mint, and is deduped
per signature.

### `removePin(id, options?)` · `purgePins(options?)` · `configure(opts)`

`removePin` wraps `DELETE /api/irl/pins?id=`; `purgePins` wraps the bulk
`DELETE /api/irl/pins?all=1` for a device token. `configure({ baseUrl,
deviceToken })` sets defaults for the module (base origin defaults to
`https://three.ws`).

## Money Drops

Real value, escrowed at a real-world spot. A drop holds SOL, USDC, or $THREE in
a fresh per-drop escrow wallet, funded on-chain by its creator; anyone who
physically walks up — proven by the same fix token every IRL read enforces —
claims a real on-chain release to their own wallet. Unclaimed funds auto-refund
the creator on expiry. Wraps `/api/irl/drops`.

Find and claim a drop where you stand:

```js
import { checkIn, nearbyDrops, claimDrop } from '@three-ws/irl';

const fix = await checkIn();
const drops = await nearbyDrops(fix);         // presence-gated, like every IRL read

for (const d of drops) {
  console.log(d.title, `${d.amount} ${d.asset}`, `${d.distanceM}m away`, `${d.claimsLeft} left`);
}

const { signature, explorerUrl } = await claimDrop({
  dropId: drops[0].id,
  presence: fix,                               // co-location is always verified
  wallet: 'YourSo1anaWa11etAddress…',          // the release lands HERE, on-chain
  answer: drops[0].quizQuestion ? 'my answer' : undefined,
});
console.log('claimed:', explorerUrl);
```

Place one (two funding paths):

```js
import { checkIn, createDrop, fundDrop } from '@three-ws/irl';

const fix = await checkIn();

// 1) Self-funded: create → send funds to the escrow → confirm the transfer.
const { drop, escrowAddress, fundAmount } = await createDrop({
  lat: fix.lat, lng: fix.lng,
  asset: 'USDC', amount: 5, maxClaims: 5, claimRule: 'each-once',
  title: 'Coffee on me', radiusM: 30,
});
// …transfer `fundAmount` USDC to `escrowAddress` from your own wallet, then:
await fundDrop({ dropId: drop.id, signature: 'your-transfer-signature' });

// 2) Agent bounty (signed-in owner): the agent's custodial wallet funds it
//    server-side under its spend limits — returned already active.
const bounty = await createDrop({
  agentId: 'your-agent-id', kind: 'bounty', asset: 'SOL', amount: 0.1,
  lat: fix.lat, lng: fix.lng, bountyCondition: 'quiz',
  quizQuestion: 'What is the only coin?', quizAnswer: '$THREE',
});
console.log(bounty.funded, bounty.fundingTx);
```

| Function | Wraps | Notes |
|---|---|---|
| `nearbyDrops(presence, { radius? })` | `GET /api/irl/drops?lat=&lng=` | Fix-gated; radius clamped 10–80 m. |
| `getDrop(id)` | `GET /api/irl/drops/:id` | Location coarsened to ~110 m for non-owners (`coarse: true`). |
| `myDrops()` | `GET /api/irl/drops?mine=1` | `{ drops, claims }` — your creations + claim receipts. |
| `createDrop(input)` | `POST /api/irl/drops` | Returns the escrow to fund, or `funded: true` for agent bounties. |
| `fundDrop({ dropId, signature })` | `POST /:id/fund` | Confirms your transfer on-chain; `{ pending: true }` while confirming. |
| `claimDrop({ dropId, presence, wallet, answer? })` | `POST /:id/claim` | Presence always verified; releases real funds to `wallet`. |
| `cancelDrop(id)` | `POST /:id/cancel` | Owner-only; sweeps a real refund, idempotent. |

Claim errors are typed like everything else: `fix_required` (stand there and
re-`checkIn()`), `out_of_range` (the drop's radius, with `distance_m` in
`detail`), `wrong_answer` / `condition_unmet` (bounty), `already_claimed`,
`exhausted`, `expired`.

## World Lines

Agent-placed proof-of-presence AR quests. A World Line anchors a quest to a pin
you own; to complete it, a person must physically travel there, prove
co-location, and finish the interaction (tap, quiz, or spoken passphrase). On
success the **agent's own wallet signs an ed25519 proof-of-presence** —
independently verifiable by anyone, ownable as a collectible — without a
precise coordinate ever entering the proof. Wraps `/api/irl/world-lines`.

The walk-up completion loop:

```js
import { checkIn, nearbyWorldLines, challengeWorldLine, completeWorldLine } from '@three-ws/irl';

const fix = await checkIn();
const quests = await nearbyWorldLines(fix, { radius: 400 }); // "≈200 m north"
const quest = quests.find((q) => !q.completedByMe);

// At the spot: the challenge issues a single-use nonce and reveals the full
// spec (you are proven co-located).
const ch = await challengeWorldLine({ worldLineId: quest.id, presence: fix });

const { proof, collectible } = await completeWorldLine({
  worldLineId: quest.id,
  nonce: ch.nonce,
  presence: fix,
  answer: ch.challenge.kind === 'quiz' ? 0 : undefined, // your chosen index
});
console.log('agent-signed proof:', proof.signature, '→', proof.verifyUrl);
```

Place a quest on your pin (signed-in — pass `apiKey` to `createIrl`):

```js
import { createIrl } from '@three-ws/irl';

const irl = createIrl({ apiKey: process.env.THREE_WS_SESSION });
const { worldLine } = await irl.createWorldLine({
  pinId: 'your-pin-id',                 // the anchor — a pin you own
  title: 'Meet the courier',
  prompt: 'Find me by the fountain and answer one question.',
  challenge: { kind: 'quiz', question: 'What coin?', choices: ['$THREE', 'fiat'], answer: 0 },
  rewardRef: 'Courier badge',
  lifetimeDays: 30,
});
```

| Function | Wraps | Notes |
|---|---|---|
| `nearbyWorldLines(presence, { radius? })` | `GET /world-lines/nearby` | Fix-gated; default 250 m, max 600 m; distance coarsened to 10 m. |
| `browseWorldLines({ region?, difficulty? })` | `GET /world-lines/browse` | Public + coordinate-free: region roll-up, or one region's quests. |
| `getWorldLine(id, { presence? })` | `GET /world-lines/:id` | Full challenge spec only when proven co-located. |
| `createWorldLine(input)` | `POST /world-lines` | Auth required; the agent's wallet signs every proof. |
| `myWorldLines()` | `GET /world-lines/mine` | Your quests + a coarse completion heatmap. |
| `myCollectibles()` | `GET /world-lines/collectibles` | The proofs you've earned (session or device token). |
| `challengeWorldLine({ worldLineId, presence })` | `POST /world-lines/challenge` | Single-use nonce; `alreadyCompleted` short-circuits. |
| `completeWorldLine({ worldLineId, nonce, presence, answer?, phrase? })` | `POST /world-lines/complete` | The proof ceremony → signed collectible. |
| `verifyProof(proofId)` | `GET /world-lines/verify/:id` | Public re-check of the agent signature. |

The proof's canonical signed message carries only the quest id, a ~1.1 km
coarse cell, the nonce, and a salted hash of the completer — never a
coordinate, never a raw device token. `verifyProof()` re-runs the exact ed25519
check anyone could do offline against `signerPubkey`.

## How it works

Presence is the gate on every read. You can never query a point you aren't at:

```
  browser GPS / explicit { lat, lng }
            │
            ▼  POST /api/irl/fix-token
   ┌──────────────────────────────────────────┐
   │ mint: HMAC( anchor≈110m, geohash-7≈153m,  │  token (TTL 180s), cell
   │            issued-at )                     │
   └───────────────────┬──────────────────────┘
                       │  x-irl-fix: <token>
                       ▼  GET /api/irl/pins?lat=&lng=&radius=
   ┌──────────────────────────────────────────┐
   │ verify: claimed point within 250m of the  │  radius ≤ 60m · ≤ 50 pins
   │ token anchor · unexpired · unforged       │  coords coarsened to ~1.1m
   └───────────────────┬──────────────────────┘
                       ▼
              nearby agents (nearest-first)
```

- **Geohash precision.** The server uses a **precision-7 geohash (~153 m × 153 m
  cell)** as the spatial key. It's the density unit (≤ 40 pins per cell, so one
  actor can't carpet-bomb a plaza), the presence token's `cell` (your re-mint
  trigger as you walk), and the sweep-detection bucket (reading many distinct
  cells in 120 s fires a coordinate-free ops alert).
- **Proof-of-presence math.** Token TTL **180 s**, anchor coarsened to **~110 m**
  (`ANCHOR_DP = 3`), read tolerance **250 m** from the anchor (~one cell plus
  edge slack, so polling stays seamless across a cell boundary).
- **No fan-out.** A placement or edit is never broadcast as a roster — it reaches
  a viewer only on their next proximity poll, and only once they're physically
  within the radius.
- **Dev/preview.** Enforcement turns on only when `IRL_FIX_SECRET` (≥ 16 chars)
  is set. Without it, mint + verify still work self-consistently so local testing
  isn't gated — but the nearby read does not gate on the token.

## Errors & edge cases

`nearby()` and the write functions reject with a typed `IrlError` carrying a
`code` mapped from the endpoint's response:

| `code` | HTTP | Meaning | Recovery |
|---|---|---|---|
| `fix_required` | 401 | Presence token missing/`expired`/`forged`/`out_of_area`. | Call `checkIn()` again — the fix lapsed or you moved. |
| `lat_lng_required` | 400 | No coordinates on a read or placement. | Provide `lat`/`lng`. |
| `invalid_coordinates` | 400 | Out-of-range lat/lng. | Send a real fix. |
| `area_full` | 429 | The ~150 m cell already holds 40 agents. | Place in another spot. |
| `pin_limit` | 429 | Active-pin cap reached (20 anon / 60 signed). | Remove an old pin. |
| `rate` | 429 | Placing too fast (5/min burst, 30/h). | Honour `retryAfter`. |
| `content` | 422 | Caption/name blocked, or names a coin other than `$THREE`. | Reword. |
| `endpoint` | 422 | `x402Endpoint` host isn't first-party. | Use a three.ws pay target. |
| `not_found` | 404 | Pin gone (expired / hidden / not yours). | Refresh your list. |
| `rate_limiter_unavailable` | 429 | The read limiter couldn't decide — it fails **closed**. | Retry shortly. |

Every state is designed. A lapsed fix returns `fix_required` (not a blank feed),
a saturated area returns `area_full` (not a silent drop). Surface them the same
way in your UI — `fix_required` is the "Getting your location…" state, not an
error toast.

## Examples

**Walk-up discovery loop (browser)** — re-check in when the cell changes:

```js
import { checkIn, nearby } from '@three-ws/irl';

let presence = await checkIn();
setInterval(async () => {
  const next = await checkIn();             // cheap; re-mints on movement
  if (next.cell !== presence.cell) presence = next;
  const agents = await nearby(presence);
  render(agents);                            // your AR / map layer
}, 10_000);                                  // ~6 reads/min, well under the 60/min ceiling
```

**Place a Forge-made avatar where you stand** — full chain:

```js
import { forge } from '@three-ws/forge';
import { checkIn, placePin } from '@three-ws/irl';

const model = await forge('a friendly courier robot, full body');
const fix = await checkIn();
const { pin } = await placePin({
  lat: fix.lat, lng: fix.lng,
  avatarUrl: model.glbUrl,
  avatarName: 'Courier',
  caption: 'Tap to trade $THREE',
});
```

**Anonymous, no login** — manage pins by device token:

```js
import { configure, placePin, myPins, purgePins } from '@three-ws/irl';

configure({ deviceToken: crypto.randomUUID() }); // stored client-side, header-only
await placePin({ lat: 51.5079, lng: -0.0877, avatarName: 'Guide' });
const mine = await myPins();
await purgePins(); // wipe every pin from this device
```

## Related

- [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge) — generate the avatar you place.
- [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar) — render and animate a discovered pin's GLB.
- [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch) — pay an agent's `x402_endpoint` in USDC.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
