# World Lines: agent-signed proof of presence

A **World Line** is a quest an agent leaves at a real place. Someone walks to that spot, completes the agent's challenge in a live ceremony panel (a tap, a passphrase, or a quiz), and the agent's own wallet signs an ed25519 **proof of presence**: a tamper-evident receipt that says *this visitor was in this area and did this thing*. The proof is independently verifiable by anyone, ownable by the visitor, and it never carries a coordinate finer than a roughly 1 km cell.

Live at `three.ws/world-lines`. Four tabs: **Near me** (fix-gated quests within walking range), **Explore** (coordinate-free region roll-up), **My proofs** (your earned collectibles, each re-verifiable in place), and **Create** (place a quest on a pin you own, plus the completion dashboard). The active tab is mirrored into the URL hash (`#near`, `#explore`, `#collectibles`, `#create`), so a tab is linkable and the back button walks tabs; Left/Right/Home/End move between them from the keyboard.

This document is the deep reference. For where World Lines sits inside the wider IRL product (placing agents, discovering by walking up, Money Drops, the presence privacy contract), read the short version first: [IRL: agents in the real world](./irl.md#world-lines). The REST summary lives in the [API reference](./api-reference.md); everything below is the full contract, the anti-cheat reasoning, and the exact privacy posture as coded.

Code: [api/irl/world-lines.js](../api/irl/world-lines.js) (all nine endpoints), [api/\_lib/world-lines.js](../api/_lib/world-lines.js) (the pure crypto and ceremony core), [src/world-lines.js](../src/world-lines.js) (the page), [src/irl/world-line-ar.js](../src/irl/world-line-ar.js) (the completion ceremony), [src/irl/world-lines-client.js](../src/irl/world-lines-client.js) (browser client), [packages/irl](../packages/irl/README.md) (the npm SDK).

---

## The model in one pass

```
your IRL pin (precise lat/lng, yours)
   └── World Line (title, prompt, challenge, reward, difficulty, expiry)
          stores: pin_id + coarse_cell (~1.1 km) + region_cell (~5 km)
          signs with: the agent's custodial ed25519 wallet key
                │
                ▼  a visitor walks there
       challenge  →  single-use nonce (HMAC, 5 min, bound to quest + cell)
                ▼
        complete  →  co-location re-checked, interaction graded,
                     agent signs the canonical message
                ▼
   presence proof  →  { signature, signed_message, signer_pubkey, coarse_cell }
                     collectible mint id: presence:<proof-id>
                ▼
          verify  →  anyone re-runs the ed25519 check, no auth, no account
```

Two tables back it, both created on demand by the handler:

| Table | Holds | Location data in it |
| --- | --- | --- |
| `irl_world_lines` | creator, agent id, signer pubkey, anchor `pin_id`, title, prompt, `challenge_spec`, reward, difficulty, caps, expiry | `coarse_cell` (precision-6 geohash, about 1.2 km by 0.6 km) and `region_cell` (precision-5, about 5 km). No latitude or longitude column. |
| `irl_presence_proofs` | quest id, agent id, signer pubkey, `nonce_id`, salted `completer_hash`, signature, signed message, challenge kind, collectible mint and name | `coarse_cell` only. |

The precise coordinate of the quest lives in exactly one place: the anchor row in `irl_pins`, which the creator placed themselves. The World Line points at it by id and reads it server-side only to compute a co-location boolean.

---

## Creating a World Line

`POST /api/irl/world-lines`, signed in, CSRF-protected. The rules are ownership rules, not preferences:

1. **You must own the anchor pin.** The pin carries the precise spot, so anchoring to someone else's pin would publish their coordinate. Wrong owner returns `403`.
2. **The pin must be public.** A World Line is an open invitation for strangers to walk to a place. Anchoring one to a pin whose `published` is `false` returns `409` with guidance to make the pin public first, rather than silently hiding the quest from discovery later.
3. **You must own the signing agent.** The agent's custodial wallet signs every proof this quest ever mints, so accountability is non-negotiable. The agent defaults to the pin's agent; pass `agentId` to use another agent you own. A pin with no agent and no `agentId` returns `400`.
4. **Anonymous device placements cannot create quests.** They have no agent wallet, so there is nothing to sign with. `401`.

At creation the handler provisions (idempotently) the agent's Solana wallet and stores its address as `signer_pubkey`. Verification is therefore anchored to the key in force when the quest was created, which is what makes a proof checkable years later without trusting the current state of the agent.

### Body

| Field | Type | Notes |
| --- | --- | --- |
| `pinId` | string, required | A pin you own, public, not hidden, not expired. |
| `title` | string, required | Up to 80 chars. Whitespace-collapsed, content-gated. |
| `prompt` | string | Up to 240 chars. The line the agent speaks aloud in the ceremony. |
| `agentId` | uuid | Defaults to the anchor pin's agent. Must be yours. |
| `challenge` | object | `{ kind: "tap" \| "quiz" \| "phrase", ... }`. Defaults to `tap`. |
| `reward_kind` | `collectible` \| `three_pool` | Anything else normalizes to `collectible`. |
| `reward_ref` | string | Up to 80 chars. Also becomes the collectible's name when set. |
| `difficulty` | `easy` \| `medium` \| `hard` | Anything else normalizes to `easy`. |
| `max_completions` | integer | 1 to 100000. Omit for unlimited. |
| `lifetime_days` | number | 1 to 90, default 30. |

`camelCase` aliases are accepted for `maxCompletions` and `rewardKind`.

**Content gate.** `title`, `prompt`, and the challenge's `prompt` / `question` all pass the same floor a pin caption does: a slur blacklist and a coin guard that permits only `$THREE`. A cashtag other than `$THREE`, or a base58 mint ending in `pump` that is not the `$THREE` contract, returns `422` with the offending field.

**Caps.** 30 active quests per creator (`429 quest_limit`), 200 active quests per roughly 5 km region (`429 region_full`), and a create rate limit of 15 per 10 minutes per IP.

### Challenge kinds

Normalized and validated in [api/\_lib/world-lines.js](../api/_lib/world-lines.js):

- **`tap`** (default). Presence *is* the challenge. The visitor walks up and taps the agent. Nothing to grade beyond co-location.
- **`phrase`** with `phrase` (up to 80 chars, required). Stored lowercased and whitespace-normalized. The visitor must reproduce it; grading is case and spacing insensitive.
- **`quiz`** with `question` (up to 240 chars), `choices` (2 to 4, each up to 60 chars), and `answer` (the index of the correct choice). An out-of-range index is a `400`.

The stored spec contains the answer, so it is redacted for anyone who has not proven co-location: `GET /api/irl/world-lines/:id` returns the quiz question and choices but not the answer index, and never echoes a passphrase. Only the creator's own dashboard and a co-located caller see the full spec. This is deliberate: a remote caller who could read the answer could pre-solve every quest in a city.

### Rewards, stated precisely

The collectible's display name is `reward_ref` when you set one, otherwise it is derived from the quest title with a "proof of presence" suffix, so setting `reward_ref` is how you control what the visitor's collectible is called.

`reward_kind` is quest metadata. `collectible` means the reward is the agent-signed proof itself, which is minted on completion and appears in the visitor's collectibles. `three_pool` labels a quest as backing a `$THREE` prize pool and renders as such on the page, but the completion path performs no token transfer: the only thing `complete` mints is the proof. If you need real escrowed value at a place today, use Money Drops (fresh per-drop escrow wallet, on-chain release to the claimer), described in [IRL](./irl.md#money-drops).

---

## The quest and challenge flow

What the visitor sees, and what the server checks under each step. The ceremony state machine is [src/irl/world-line-ar.js](../src/irl/world-line-ar.js); every state below is a rendered state, including the failure ones (speaking, awaiting the interaction, submitting, granted, already completed, capacity reached, no longer active, and error).

The ceremony runs as a designed in-page panel on every device, with the agent's avatar rendered live and breathing in the card. The module also carries a self-contained immersive WebXR layer (`enterAR()`, floor hit-test, avatar anchored to the detected surface). On a browser that reports `immersive-ar` support the intro panel grows a "Meet the agent in AR" button that starts it; everywhere else no button renders and the panel is what visitors get, and an AR session that fails to start falls back to the panel's begin step. Nothing about the proof depends on which of the two is used, because the client owns no secrets and the server enforces co-location, the nonce, the signature, the caps, and idempotency regardless.

**1. Discover.** The page watches geolocation, mints a fix token, and calls `GET /nearby`. Each quest card shows a distance chip coarsened to 10 m, the difficulty, the reward, and whether you already hold its proof. Under 80 m the button becomes "You're here, begin"; further away it reads "Travel here to begin".

**2. Open the encounter.** The client fetches `GET /:id` with the fix so the server can decide whether to reveal the answer. The agent's avatar renders in the card (idle clip retargeted onto its own rig) and the quest prompt is shown.

**3. Begin.** `POST /challenge`. The server re-derives co-location, refuses if the quest is at capacity, short-circuits with `already_completed` plus your existing `proof_id` if you have done this one, and otherwise mints a single-use nonce and returns the fully revealed challenge spec. The agent speaks the prompt through `/api/tts/speak`; speech is best-effort and the prompt is always on screen, so a TTS failure never blocks the quest.

**4. Interact.** `tap` renders one button. `phrase` renders a text input. `quiz` renders the choices as a radiogroup. A wrong answer is recoverable: `complete` returns `422 challenge_failed`, the ceremony re-renders the interaction with the error inline, and the same nonce is still spendable until it expires.

**5. Complete.** `POST /complete` with the nonce plus `answer` or `phrase`. On success the card shows the signing agent's key, the collectible mint id, and a link that re-verifies the signature in public. The creator gets a notification carrying the quest id, title, coarse cell, new completion count, and a link back to their dashboard. Nothing else: not the coordinate, not who completed it.

Server-side, `complete` runs eight steps in this order, and each one can end the request:

1. Co-location, re-derived from scratch (never carried over from the challenge call).
2. Nonce verification: unforged HMAC, inside its 5 minute TTL, and bound to this quest id and coarse cell.
3. Interaction grading for `quiz` and `phrase`. For `tap` the interaction is presence, already proven.
4. One proof per visitor per quest: an existing proof is returned as-is rather than minting a second.
5. Capacity re-check, immediately before signing.
6. The agent wallet signs the canonical message, and the server verifies its own signature against the `signer_pubkey` captured at creation before persisting anything. A stored proof is therefore always genuine.
7. Insert under two unique indexes, `nonce_id` and `(world_line_id, completer_hash)`, so a racing double completion is a clean conflict that returns the existing proof instead of a double mint. Then the collectible id is stamped and the completion count is bumped under the capacity guard.
8. Notify the creator.

### Anti-cheat, summarized

| Attack | What stops it |
| --- | --- |
| Complete from across town | Fix token proves a real recent GPS fix, then the server measures the claimed point against the anchor pin's own coordinates. The request body is never trusted for the distance check. |
| Pre-solve quizzes remotely, then walk up once | The answer is redacted from every non-co-located read of the quest. |
| Replay a captured completion | The nonce is single-use: `nonce_id` carries a `UNIQUE` index, and a replay returns the original proof (idempotent), never a second one. |
| Forge a nonce | The nonce is an HMAC over its payload with a server secret, compared in constant time, and bound to the quest id and coarse cell. |
| Farm a quest for many collectibles | `(world_line_id, completer_hash)` is unique. One proof per visitor per quest, whether identified by account or device token. |
| Lift someone else's proof and claim it | The signed bytes include the completer's salted hash, so a proof only ever attests to one visitor. |
| Mint proofs without the agent | The signing key is the agent's custodial wallet, and the verifier checks against the pubkey captured at creation. |
| Script the endpoints | Per-IP limits: 15 creates per 10 min, 30 challenges per 5 min, 20 completes per 5 min, 240 public reads per min, 60 nearby lookups per min, 30 fix mints per min. |

---

## How proximity is proven and bounded

Two mechanisms compose. Neither alone is sufficient.

**The fix token** ([api/\_lib/irl-presence.js](../api/_lib/irl-presence.js)) turns "query anywhere" into "query where you are". The client posts its live fix to `POST /api/irl/fix-token` and gets back a stateless, HMAC-signed token whose payload holds the fix rounded to 3 decimal places (about 110 m), the precision-7 geocell it fell in, and an issue time. TTL is 180 s. A read is honoured when the claimed point is within 250 m of the token anchor. No DB row, no stored coordinate.

**The server-side distance check** (`resolveColocation`) then measures the claimed point against the anchor pin's unrounded coordinates with a haversine, and requires 80 m or better. So a caller must both hold a genuine fix near the point they claim *and* have that point actually be at the quest.

Every radius in play, and why they differ:

| Bound | Value | Purpose |
| --- | --- | --- |
| Co-location for `challenge` and `complete` | 80 m | Slightly wider than the 60 m pin read, to tolerate GPS jitter at the moment of the tap. |
| Nearby discovery, default | 250 m | Wide enough for "a quest is about 250 m north" wayfinding. |
| Nearby discovery, max | 600 m | Hard ceiling; the request's radius is clamped to `[30, 600]`. |
| Fix-token anchor tolerance | 250 m | About one geocell plus edge slack, so a walker near a cell boundary keeps polling without re-minting. |
| Distance returned to the client | rounded to 10 m | Successive reads cannot be triangulated into an exact spot. |
| Coarse cell stored on quests and proofs | precision-6 geohash, about 1.2 km by 0.6 km | The only location a proof carries. |
| Region cell used by public browse | precision-5 geohash, about 5 km | Aggregate-only discovery map. |
| Nearby result cap | 50 rows before the radius filter | Bounds a sweep's yield per request. |

`GET /nearby` also enforces the anchor pin's visibility (`p.published IS NOT FALSE`). It has the widest coordinate-bearing radius on the platform, so without that filter it would be the cheapest private-pin bypass in the product.

**Enforcement is config-gated.** `fixEnforced()` is true only when `IRL_FIX_SECRET` is set to at least 16 characters. Without it (local and preview) the token check is skipped, but the server-side distance check still runs, so co-location is never simply trusted. Same shape for the nonce: `WORLD_LINE_SECRET` must be set in production; otherwise a stable, deliberately non-secret dev key is used, and a nonce minted under the dev key stops verifying the moment a real secret is configured.

---

## What the agent signs

One canonical, domain-separated, versioned string. Field order is fixed, and every field is coarse or hashed:

```
three.ws/world-line-presence:v1|wl=<worldLineId>|cell=<coarseCell>|nonce=<nonceId>|who=<completerHash>
```

- `PROOF_DOMAIN` (`three.ws/world-line-presence:v1`) prevents a signature from being replayed as a different kind of attestation, and gives future versions a clean break.
- `wl` binds the proof to one quest.
- `cell` is the precision-6 geohash of the anchor, derived from the pin, not from the caller. It is the only location in the signed bytes.
- `nonce` is the nonce id, which is the first 32 chars of the nonce's HMAC. It ties the proof to one server-authorized attempt at a specific time window.
- `who` is `sha256("wlc:" + secret + ":" + stableId)` truncated to 32 chars, where `stableId` is the account id when signed in, otherwise the device token. Stable, so the same visitor maps to the same hash, and salted with a server secret so it cannot be dictionary-attacked back to a device token.

The signature is ed25519 over the UTF-8 bytes of that string, produced with the agent's Solana keypair seed and returned base58 alongside the base58 public key. Nothing in the signed payload, the nonce, or any log line is finer than the coarse cell.

---

## Verifying a proof as a third party

### Over HTTP, no auth

<!-- runnable: no the proof id is illustrative; substitute one from a real collectible -->
```bash
curl -s https://three.ws/api/irl/world-lines/verify/9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f
```

```json
{
  "verified": true,
  "proof": {
    "id": "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
    "world_line_id": "1b2a3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    "world_line_title": "Find the lobby greeter",
    "agent_id": "7c6b5a49-3827-1605-f4e3-d2c1b0a99887",
    "signer_pubkey": "<base58 ed25519 public key>",
    "coarse_cell": "u4pruy",
    "signed_message": "three.ws/world-line-presence:v1|wl=1b2a3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d|cell=u4pruy|nonce=<32-char nonce id>|who=<32-char completer hash>",
    "signature": "<base58 ed25519 signature>",
    "signature_scheme": "ed25519",
    "collectible_mint": "presence:9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
    "collectible_name": "<reward_ref when set, else the quest title with a proof-of-presence suffix>",
    "completed_at": "2026-07-30T11:02:14.318Z"
  }
}
```

`verified` is not a stored flag. The endpoint re-runs the ed25519 check over `signed_message` against `signer_pubkey` on every request, using only fields present on the returned row. A malformed key or signature yields `verified: false` rather than an error. Unknown proof id returns `404`.

### Offline, trusting nobody

The response is self-contained, so you can re-check it yourself. This is the same code path `/verify` runs:

```js
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

const res = await fetch('https://three.ws/api/irl/world-lines/verify/' + proofId);
const { proof } = await res.json();

const pub = bs58.decode(proof.signer_pubkey);
const sig = bs58.decode(proof.signature);
const msg = new TextEncoder().encode(proof.signed_message);

const genuine = pub.length === 32 && sig.length === 64 && ed25519.verify(sig, msg, pub);
console.log(genuine ? 'genuine proof of presence' : 'not genuine');
```

What a `true` result actually tells you: the holder of the agent's private key attested that the visitor identified by `who` completed quest `wl` in cell `cell` under server nonce `nonce`. It does not tell you the exact spot (by design), and it does not tell you the visitor's identity (only that it is one stable visitor). To tie a proof to a person, ask them to fetch it from their own `GET /collectibles`, which is scoped to their session or device token.

Coverage for the crypto core lives in [tests/world-lines-crypto.test.js](../tests/world-lines-crypto.test.js): tampered message, tampered signature, wrong signer, cross-quest nonce reuse, expiry, and the "another visitor cannot reuse this signature" case.

---

## Privacy: exactly what is stored

The engineering analysis for all of IRL is the [IRL threat model](./irl/THREAT-MODEL.md); the user-facing summary is the `three.ws/irl-privacy` page. World Lines specifically:

**Stored.**

- On the quest: the anchor `pin_id`, a precision-6 coarse cell (about 1 km), a precision-5 region cell (about 5 km), the creator's user id, the agent id, the signer pubkey, and the creator's own text.
- On a proof: the coarse cell, the nonce id, the salted completer hash, the signature and signed message, the challenge kind, and the collectible mint and name.
- Also on a proof row, server-side only: `completer_user_id` and `completer_device`. The raw device token is stored because `GET /collectibles` scopes an anonymous visitor's own collection to it. It is never returned by any endpoint (`publicProof`, `collectibleOf`, and the collectibles query all select around it), never enters the signed message, and never reaches a notification or a log line.

**Not stored, anywhere.**

- The visitor's latitude and longitude. They are parsed from the request, used to verify the fix token and compute one distance, and discarded. No row, no log.
- The quest's coordinate on the quest itself. It exists only on the creator's own pin row.
- A precise coordinate in a proof, a nonce, a notification, or the collectible.
- Camera frames or gyroscope readings. The ceremony renders locally; nothing is uploaded.
- Analytics events. Unlike pins and shares, the World Lines handler writes no `irl_events` rows, so there is no separate telemetry trail for quest reads.

**Never revealed.**

- Who completed a quest. The creator's dashboard and the completion notification carry counts grouped by coarse cell, nothing more.
- A quest's location to a non-co-located caller. `browse` is aggregate-only and never returns a coordinate or a distance; `nearby` requires a fix token and returns distance rounded to 10 m; `:id` redacts the challenge answer without co-location.
- Another visitor's collectibles. The collectibles query null-guards each identity arm, so a missing identifier cannot widen the scope.

**Retention.** A quest always carries an expiry (creator-chosen, 90 days maximum). The hourly reaper [api/cron/irl-reap.js](../api/cron/irl-reap.js) deletes a quest one day past expiry, then sweeps every proof whose quest no longer exists. A proof lives as long as its quest, so a collectible is durable but not permanent: if you want to hold on to one, keep the verify response, which is fully self-verifying without the server.

---

## API contract

Base path `/api/irl/world-lines`. CORS allows GET, POST, OPTIONS with credentials. Headers used throughout:

| Header | Meaning |
| --- | --- |
| `x-irl-fix` | The proof-of-presence token from `POST /api/irl/fix-token`. Required on co-located calls when `IRL_FIX_SECRET` is configured. |
| `x-irl-device` | The anonymous device token. A bearer credential, so it rides in the header only, never in a URL. |
| `X-CSRF-Token` | Required on `POST /api/irl/world-lines` (the only authed write). |

### Mint a fix token first

```bash
curl -s https://three.ws/api/irl/fix-token \
  -H 'content-type: application/json' \
  -H 'x-irl-device: 6b1e1c9a-0f4d-4e6a-9d7a-2f0c8b5a1e33' \
  -d '{"lat":37.77493,"lng":-122.41942,"accuracy":8}'
```

```json
{ "token": "<base64url payload>.<hmac>", "expires_in": 180, "cell": "9q8yyk8" }
```

Re-mint when you move far enough to leave the token's area or when it ages out. The shipped browser client caches one token per coordinate rounded to 3 decimals (roughly 110 m) and re-mints 15 s before expiry.

### `POST /api/irl/world-lines`

Create. Auth plus CSRF. Returns `201` with the owner view of the quest (full `challenge_spec` included, since you wrote it).

```bash
curl -s https://three.ws/api/irl/world-lines \
  -H 'content-type: application/json' \
  -H 'X-CSRF-Token: <token from /api/csrf-token>' \
  -b 'session=<your session cookie>' \
  -d '{
    "pinId": "3f2a1b0c-9d8e-7f6a-5b4c-3d2e1f0a9b8c",
    "title": "Find the lobby greeter",
    "prompt": "Welcome, traveler. Tap me to prove you came.",
    "challenge": { "kind": "quiz", "question": "What floor am I on?", "choices": ["Ground", "Third"], "answer": 0 },
    "difficulty": "easy",
    "reward_kind": "collectible",
    "max_completions": 250,
    "lifetime_days": 30
  }'
```

```json
{
  "world_line": {
    "id": "1b2a3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    "agent_id": "7c6b5a49-3827-1605-f4e3-d2c1b0a99887",
    "signer_pubkey": "<base58 ed25519 public key>",
    "pin_id": "3f2a1b0c-9d8e-7f6a-5b4c-3d2e1f0a9b8c",
    "coarse_cell": "9q8yyk",
    "region_cell": "9q8yy",
    "title": "Find the lobby greeter",
    "prompt": "Welcome, traveler. Tap me to prove you came.",
    "challenge": { "kind": "quiz", "prompt": null, "question": "What floor am I on?", "choices": ["Ground", "Third"], "answer": 0 },
    "reward_kind": "collectible",
    "reward_ref": null,
    "difficulty": "easy",
    "max_completions": 250,
    "completion_count": 0,
    "created_at": "2026-07-30T10:41:07.882Z",
    "expires_at": "2026-08-29T10:41:07.882Z"
  }
}
```

Errors: `401` not signed in, `403` pin or agent not yours, `404` pin or agent not found, `409` pin is private, `422` content gate, `429` quest or region cap or rate limit, `502` the agent's signing wallet could not be provisioned.

### `GET /api/irl/world-lines/nearby?lat=&lng=[&radius=]`

Fix-gated discovery. Radius clamps to `[30, 600]`, default 250.

```bash
curl -s 'https://three.ws/api/irl/world-lines/nearby?lat=37.77493&lng=-122.41942&radius=400' \
  -H 'x-irl-fix: <token>' \
  -H 'x-irl-device: 6b1e1c9a-0f4d-4e6a-9d7a-2f0c8b5a1e33'
```

```json
{
  "world_lines": [
    {
      "id": "1b2a3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
      "agent_id": "7c6b5a49-3827-1605-f4e3-d2c1b0a99887",
      "signer_pubkey": "<base58 ed25519 public key>",
      "pin_id": "3f2a1b0c-9d8e-7f6a-5b4c-3d2e1f0a9b8c",
      "coarse_cell": "9q8yyk",
      "title": "Find the lobby greeter",
      "prompt": "Welcome, traveler. Tap me to prove you came.",
      "challenge": { "kind": "quiz", "prompt": null, "question": "What floor am I on?", "choices": ["Ground", "Third"] },
      "reward_kind": "collectible",
      "difficulty": "easy",
      "max_completions": 250,
      "completion_count": 12,
      "distance_m": 70,
      "completed_by_me": false,
      "capacity_reached": false
    }
  ]
}
```

Note the redacted challenge: no `answer`. Errors: `400` missing or non-finite `lat`/`lng` or an unparseable radius, `401 fix_required` (with a `reason` of `missing`, `malformed`, `forged`, `expired`, or `out_of_area`), `429` rate limited.

### `GET /api/irl/world-lines/browse[?region=&difficulty=]`

Public, no fix, no coordinates. With no query it returns the region roll-up, which is the only branch that sets an edge cache header (60 s, with a 300 s stale-while-revalidate window):

```bash
curl -s https://three.ws/api/irl/world-lines/browse
```

```json
{ "regions": [ { "region_cell": "9q8yy", "quests": 7, "hard": 2, "completions": 41 } ] }
```

With `region` (a precision-5 geohash from the roll-up) it returns that region's quests, up to 60, optionally filtered by `difficulty`:

```bash
curl -s 'https://three.ws/api/irl/world-lines/browse?region=9q8yy&difficulty=hard'
```

```json
{
  "region": "9q8yy",
  "quests": [
    { "id": "1b2a3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d", "title": "Find the lobby greeter",
      "reward_kind": "collectible", "difficulty": "hard", "completion_count": 12, "capacity_reached": false }
  ]
}
```

An invalid `region` is ignored (you get the roll-up) rather than erroring.

### `GET /api/irl/world-lines/:id[?lat=&lng=]`

Single quest. Pass the fix and coordinates to unlock the full challenge spec; omit them for the "travel here" view.

<!-- runnable: no the quest id is illustrative; substitute one from GET /browse -->
```bash
curl -s 'https://three.ws/api/irl/world-lines/1b2a3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d?lat=37.77493&lng=-122.41942' \
  -H 'x-irl-fix: <token>'
```

```json
{ "world_line": { "id": "1b2a3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d", "challenge": { "kind": "quiz", "prompt": null, "question": "What floor am I on?", "choices": ["Ground", "Third"], "answer": 0 } }, "colocated": true }
```

`colocated` is `false` (and the answer withheld) whenever the coordinates are absent, the fix fails, or the distance exceeds 80 m. Errors: `400` invalid id, `404` unknown, hidden, or expired quest.

### `POST /api/irl/world-lines/challenge`

Issue a single-use nonce. Requires co-location.

```bash
curl -s https://three.ws/api/irl/world-lines/challenge \
  -H 'content-type: application/json' \
  -H 'x-irl-fix: <token>' \
  -H 'x-irl-device: 6b1e1c9a-0f4d-4e6a-9d7a-2f0c8b5a1e33' \
  -d '{"world_line_id":"1b2a3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d","lat":37.77493,"lng":-122.41942}'
```

```json
{
  "nonce": "<base64url payload>.<hmac>",
  "expires_in": 300,
  "challenge": { "kind": "quiz", "prompt": null, "question": "What floor am I on?", "choices": ["Ground", "Third"], "answer": 0 },
  "agent_id": "7c6b5a49-3827-1605-f4e3-d2c1b0a99887",
  "world_line": { "id": "1b2a3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d", "title": "Find the lobby greeter", "prompt": "Welcome, traveler. Tap me to prove you came.", "reward_kind": "collectible", "reward_ref": null }
}
```

If you already completed this quest you get `200 { "already_completed": true, "proof_id": "...", "collectible_mint": "..." }` instead of a nonce. Errors: `400` bad body or id, `401 fix_required`, `403 not_colocated` (with `within_m: 80`), `404` unknown quest, `409 capacity_reached`, `410 anchor_gone` (the pin was removed or expired), `429` rate limited, `500` if the nonce could not be minted.

### `POST /api/irl/world-lines/complete`

The proof ceremony. Send the nonce from `challenge` plus the interaction payload: `answer` (choice index) for a quiz, `phrase` for a phrase quest, nothing extra for a tap.

```bash
curl -s https://three.ws/api/irl/world-lines/complete \
  -H 'content-type: application/json' \
  -H 'x-irl-fix: <token>' \
  -H 'x-irl-device: 6b1e1c9a-0f4d-4e6a-9d7a-2f0c8b5a1e33' \
  -d '{"world_line_id":"1b2a3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d","nonce":"<nonce>","lat":37.77493,"lng":-122.41942,"answer":0}'
```

```json
{
  "ok": true,
  "proof": {
    "id": "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
    "world_line_id": "1b2a3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    "agent_id": "7c6b5a49-3827-1605-f4e3-d2c1b0a99887",
    "signer_pubkey": "<base58 ed25519 public key>",
    "coarse_cell": "9q8yyk",
    "signature": "<base58 ed25519 signature>",
    "signed_message": "three.ws/world-line-presence:v1|wl=1b2a3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d|cell=9q8yyk|nonce=<32-char nonce id>|who=<32-char completer hash>",
    "signature_scheme": "ed25519",
    "completed_at": "2026-07-30T11:02:14.318Z",
    "verify_url": "/api/irl/world-lines/verify/9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f"
  },
  "collectible": {
    "mint": "presence:9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
    "name": "<reward_ref when set, else the quest title with a proof-of-presence suffix>",
    "kind": "proof-of-presence",
    "reward_kind": "collectible",
    "signer_pubkey": "<base58 ed25519 public key>",
    "signature": "<base58 ed25519 signature>",
    "proof_id": "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f"
  }
}
```

A repeat call returns `200` with `already_completed: true` and the original proof. Errors: `400` bad body, missing nonce, or bad id, `401 fix_required`, `403 not_colocated` or `403 invalid_nonce` (`reason`: `missing`, `malformed`, `forged`, `mismatch`), `404` unknown quest, `409 capacity_reached` or `409 already_completed`, `410 anchor_gone` or `410 invalid_nonce` with `reason: "expired"`, `422 challenge_failed` (wrong answer or passphrase, retryable with the same nonce), `429` rate limited, `502` if the agent could not sign or the server's own signature check failed.

### `GET /api/irl/world-lines/mine`

Creator dashboard. Auth. Returns up to 100 of your quests including hidden and expired ones, each with the full `challenge_spec`, plus a completions heatmap grouped by coarse cell.

<!-- runnable: 401 requires an authenticated session; with a real session cookie this returns 200 -->
```bash
curl -s https://three.ws/api/irl/world-lines/mine -b 'session=<your session cookie>'
```

```json
{
  "world_lines": [ { "id": "1b2a3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d", "title": "Find the lobby greeter", "completion_count": 12, "max_completions": 250, "coarse_cell": "9q8yyk", "expired": false, "hidden": false } ],
  "heatmap": [ { "world_line_id": "1b2a3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d", "coarse_cell": "9q8yyk", "completions": 12 } ]
}
```

Errors: `401` not signed in.

### `GET /api/irl/world-lines/collectibles`

Your earned proofs, up to 200, newest first. Scoped to your session or your device token; one of the two is required (`400` otherwise).

```bash
curl -s https://three.ws/api/irl/world-lines/collectibles \
  -H 'x-irl-device: 6b1e1c9a-0f4d-4e6a-9d7a-2f0c8b5a1e33'
```

```json
{
  "collectibles": [
    {
      "mint": "presence:9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
      "name": "<reward_ref when set, else the quest title with a proof-of-presence suffix>",
      "kind": "proof-of-presence",
      "reward_kind": "collectible",
      "signer_pubkey": "<base58 ed25519 public key>",
      "signature": "<base58 ed25519 signature>",
      "proof_id": "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
      "world_line_id": "1b2a3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
      "world_line_title": "Find the lobby greeter",
      "difficulty": "easy",
      "coarse_cell": "9q8yyk",
      "earned_at": "2026-07-30T11:02:14.318Z",
      "verify_url": "/api/irl/world-lines/verify/9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f"
    }
  ]
}
```

### `GET /api/irl/world-lines/verify/:proofId`

Public. See "Verifying a proof as a third party" above.

---

## Build on it with the SDK

[`@three-ws/irl`](../packages/irl/README.md) wraps every endpoint with the presence plumbing handled for you: `nearbyWorldLines`, `browseWorldLines`, `getWorldLine`, `createWorldLine`, `myWorldLines`, `myCollectibles`, `challengeWorldLine`, `completeWorldLine`, and `verifyProof`. It mirrors the server's validation client-side (challenge kinds, difficulties, reward kinds, region cell shape) so a malformed quest fails fast with a readable message instead of a round-trip, and it normalizes snake_case responses into camelCase shapes.

```js
import { createIrl } from '@three-ws/irl';

const irl = createIrl({ baseUrl: 'https://three.ws' });
const presence = await irl.checkIn({ lat: 37.77493, lng: -122.41942 });

const quests = await irl.nearbyWorldLines(presence, { radius: 400 });
const started = await irl.challengeWorldLine({ worldLineId: quests[0].id, presence });
const done = await irl.completeWorldLine({
  worldLineId: quests[0].id,
  nonce: started.nonce,
  presence,
  answer: started.challenge.kind === 'quiz' ? 0 : undefined,
});

const check = await irl.verifyProof(done.proof.id);
console.log(check.verified, done.collectible.mint);
```

The zero-config path is the same functions imported directly (`import { checkIn, nearbyWorldLines } from '@three-ws/irl'`); use `createIrl` when you want to bind a base URL, an `apiKey` for signed-in creation, or a default device token once.

---

## Configuration

| Variable | Effect if unset |
| --- | --- |
| `IRL_FIX_SECRET` (16+ chars) | Fix tokens are minted and verified with a stable non-secret dev key and the token gate is bypassed. The server-side distance check still runs. Required in production. |
| `WORLD_LINE_SECRET` (16+ chars) | Nonces and completer hashes fall back to a stable non-secret dev key. Required in production. Rotating it invalidates outstanding nonces and changes every future completer hash, so past proofs stay verifiable while a visitor's hash for new quests changes. |

Both handlers log their enforcement mode once per cold start, so a production misconfiguration is visible without grepping request logs.

---

## Related

- [IRL: agents in the real world](./irl.md#world-lines), the product-level overview and the rest of the presence layer.
- [IRL threat model](./irl/THREAT-MODEL.md), the adversarial analysis behind every radius and cap above.
- [Place a 3D agent in your real environment](./tutorials/place-agent-irl.md), how to create the anchor pin a World Line needs.
- [API reference](./api-reference.md), the one-screen summary of these endpoints alongside the rest of `/api/irl/*`.
- [AR](./ar.md), the camera and WebXR layer the ceremony builds on.
