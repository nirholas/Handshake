# Coin Wars

Two coin communities meet in one arena and fight. The side that reaches the kill
cap first wins, the result is written to a battle ledger, and an Elo league is
recomputed from that ledger. Every world on `/play` has a **war portal** in its
plaza: that is where you see where your community stands, queue it for a battle,
watch a war that is already running, and land back when it is over.

You fight **for the coin you hold**. The arena will not seat you under a
community whose coin you do not hold, and that is enforced server-side, not in
the UI.

---

## Playing it

1. Enter a coin world: `/play?coin=<mint>` (or pick one from the lobby).
2. Walk to the war portal in the north-west plaza. The board lights up as you
   come into range and shows this community's Elo rating, rank, record, K/D and
   its last battles.
3. Press `E` (or tap the prompt). The portal verifies you hold the coin using the
   same gate the Holders world uses, then puts your community in line.
4. When a second community queues, both sides are handed the same battle and the
   arena opens at `/play/war`.
5. Fight: `W A S D` or the on-screen stick to move, drag to look, `Space` / `F`
   or the Fire button to swing. The server decides what lands.
6. When the round ends, **Back to the world** returns you to the exact world you
   left, with the result already on the portal board.

While a war involving your coin is live, anyone standing at the portal sees the
score, the round clock and a kill feed on the board without joining the fight.
A battle still in its lobby reads "waiting on both sides" until both communities
have fielded a fighter, and a battle that has already ended is never flown as
live: the portal skips it when it picks the running war to banner.

---

## How a battle is put together

### The rendezvous: `matchKey`

`ClashRoom` is registered with `filterBy(['matchKey'])`, so every fighter
carrying the same key lands in the same room instance. The key format is owned by
[`multiplayer/src/war-matchmaking.js`](../multiplayer/src/war-matchmaking.js):

```
w1:<network>:<lower mint>:<higher mint>:<slot>
```

Both communities derive the identical key regardless of who queued first (the
mints are sorted), and the `slot` makes a rematch a distinct battle so the
ledger's one-row-per-`matchKey` rule still holds.

```js
import { mintMatchKey, sideOf } from './multiplayer/src/war-matchmaking.js';

const key = mintMatchKey({ mintA: THREE_MINT, mintB: RIVAL_MINT, slot: Date.now() });
sideOf(key, THREE_MINT); // 'a' or 'b': which column of the scoreboard you are
```

### The queue

Queueing is a fold over a shared list, held under a short Redis lock so two
players pressing "enter the war" in different worlds at the same instant cannot
mint two keys for what should be one battle:

- **waiting**: nobody else is in line; you are now the one waiting (90 s).
- **matched**: you just paired with a waiting community.
- **paired**: the other side queued first and already paired with you; here is
  the key (claimable for 10 minutes).

### The ticket

Whoever joins a key **first also creates the room**, and the room needs to know
the two competing communities. If it took those from the joining client, one
fighter could open an arena naming any opponent they liked and post a league
result against a community that never turned up.

So the API seals the pairing into an HMAC-signed **war ticket**
([`api/_lib/war-ticket.js`](../api/_lib/war-ticket.js) signs,
[`multiplayer/src/war-ticket.js`](../multiplayer/src/war-ticket.js) verifies) and
`ClashRoom.onCreate` takes the factions from the ticket. A ticket whose factions
do not match the mints its own key encodes is rejected, so a signed pairing
cannot be replayed into a different arena.

This sits one layer above the holder pass: the **holder pass** proves *you may
fight for this coin*, the **war ticket** proves *this is a real match between
these two communities*.

### The league

`clash_battles` is the ledger: one row per finished battle, written by the game
server over an HMAC-signed `POST /api/wars?action=report`. Standings are
**recomputed** from that ledger with the pure Elo math in
[`multiplayer/src/war-standings.js`](../multiplayer/src/war-standings.js), the
same module the arena's own league uses. There is no second implementation, so a
rating shown on a portal board is never a second opinion.

### Spectating

A running battle publishes a small JSON snapshot to Redis every couple of seconds
([`multiplayer/src/war-live.js`](../multiplayer/src/war-live.js)): phase, both
scores, the roster counts, the round clock and the last knockdowns. The portal
board polls that. Nothing about spectating opens a second socket or a second 3D
render.

---

## The API

### `GET /api/wars`

The board. Everything the portal renders in one read.

```bash
curl "https://three.ws/api/wars?network=mainnet&coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&limit=8"
```

```jsonc
{
  "data": {
    "network": "mainnet",
    "coin": "FeMb...pump",
    "standing": { "rank": 1, "rating": 1032, "wins": 3, "losses": 1, "draws": 0, "kd": 1.4, "streak": 2, "winRate": 0.75 },
    "standings": [ /* the full ladder, rating desc */ ],
    "ledgerAvailable": true,
    "battlesRead": 4,
    "seasonWindowFull": false,
    "recent": [ { "matchKey": "w1:mainnet:...", "winner": "FeMb...pump", "reason": "score_cap", "a": {}, "b": {}, "mvp": {}, "endedAt": 1770000000000 } ],
    "recentAvailable": true,
    "live": [ /* running battles involving this coin */ ],
    "queue": { "available": true, "waiting": [ { "mint": "...", "symbol": "...", "since": 1770000000000 } ] }
  }
}
```

`ledgerAvailable` and `recentAvailable` are honest flags, not decoration: the
ledger (Postgres) and the live registry (Redis) fail independently, and the
portal says which one is missing rather than rendering an empty board that reads
as "no wars".

### `GET /api/wars?action=live&coin=<mint>`

Just the running battles. This is the spectator poll: it never touches Postgres.

### `POST /api/wars?action=queue`

```bash
curl -X POST "https://three.ws/api/wars?action=queue" \
  -H 'content-type: application/json' \
  -d '{"coin":"FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump","symbol":"THREE","network":"mainnet"}'
```

Returns `{"data":{"status":"waiting","waiting":1}}` or, once paired:

```json
{"data":{"status":"matched","matchKey":"w1:mainnet:...","ticket":"<signed>","side":"a","opponent":{"mint":"...","symbol":"..."}}}
```

### `POST /api/wars?action=leave`

Takes a community out of the queue: `{"coin":"<mint>","network":"mainnet"}`.

### `POST /api/wars?action=report`

The game server only. HMAC-SHA256 of the raw body in `x-war-signature`, keyed on
`WAR_RESULT_SECRET`. Idempotent on `matchKey`, so a retried report updates the
row instead of counting a battle twice.

---

## URL shapes

**Portal to arena** (produced by `src/game/war-portal.js`):

```
/play/war?match=<matchKey>&ticket=<signed pairing>&side=a|b
         &coin=<mint>&name=&symbol=&image=&network=mainnet
         &holderPass=<signed holding>&return=<path back into the coin world>
```

**Arena back to the world** (the `return` value, plus the match key so the result
echoes):

```
/play?coin=<mint>&name=&symbol=&image=&tier=holders&war=<matchKey>
```

`/play/war` also works as a direct destination: with a valid `match` + `ticket`
but no `holderPass`, it mints its own from the signed-in session. Without a
pairing at all it says so and offers the way back rather than showing an empty
battlefield. `return` is only ever honoured as a same-origin path.

---

## Configuration

| Variable | Used by | Purpose |
|---|---|---|
| `WAR_TICKET_SECRET` | API + game server | Signs and verifies a war pairing. Falls back to `WAR_RESULT_SECRET`, then `HOLDER_PASS_SECRET`, so a deployment with either one already works. Required in production. |
| `WAR_RESULT_SECRET` | API + game server | Signs the battle report the game server posts to the ledger. |
| `HOLDER_PASS_SECRET` | API + game server | The holder pass that proves you hold the coin you fight for. |
| `DATABASE_URL` | API | The `clash_battles` ledger the standings are folded from. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | API + game server | The matchmaking queue and the live spectator registry. Without these, wars cannot be queued (the portal says so) and nothing can be spectated; the ladder still reads. |
| `THREE_WS_API_BASE` | game server | Where the game server posts battle results. Defaults to `https://three.ws`. |

---

## Where the code is

| Piece | File |
|---|---|
| The in-world portal | [`src/game/war-portal.js`](../src/game/war-portal.js), [`src/game/war-portal.css`](../src/game/war-portal.css) |
| Portal location in the plaza | [`multiplayer/src/world-features.js`](../multiplayer/src/world-features.js) (`WAR_PORTAL`) |
| The arena page | [`pages/play/war.html`](../pages/play/war.html), [`src/play/war.js`](../src/play/war.js), [`src/play/war-world.js`](../src/play/war-world.js) |
| The room | [`multiplayer/src/rooms/ClashRoom.js`](../multiplayer/src/rooms/ClashRoom.js) (`clash_arena`) |
| Match rules (phases, score cap, sudden death) | [`multiplayer/src/clash.js`](../multiplayer/src/clash.js) |
| Pairing math | [`multiplayer/src/war-matchmaking.js`](../multiplayer/src/war-matchmaking.js) |
| League math | [`multiplayer/src/war-standings.js`](../multiplayer/src/war-standings.js) |
| Spectator snapshots | [`multiplayer/src/war-live.js`](../multiplayer/src/war-live.js) |
| The endpoint + store | [`api/wars.js`](../api/wars.js), [`api/_lib/wars-store.js`](../api/_lib/wars-store.js) |
| Tests | [`tests/war-matchmaking.test.js`](../tests/war-matchmaking.test.js), [`tests/clash-match.test.js`](../tests/clash-match.test.js) |

Related: [the in-game economy](in-game-economy.md), [play hardening](play-hardening.md).
