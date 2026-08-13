# three.ws · multiplayer

Authoritative [Colyseus](https://colyseus.io/) server for the realtime worlds on three.ws. One Node process hosts six room types:

| Room | Class | Powers |
| --- | --- | --- |
| `walk_world` | [`src/rooms/WalkRoom.js`](src/rooms/WalkRoom.js) | The open-world coin communities on `/play` and the walkaround world reached from `/walk`: movement, chat, voice signalling, voxel building, the in-game economy, combat, quests, and the minigames |
| `agora_world` | [`src/rooms/AgoraRoom.js`](src/rooms/AgoraRoom.js) | `/agora` play mode: walk the Commons among the working citizens and other live humans |
| `irl_world` | [`src/rooms/IrlRoom.js`](src/rooms/IrlRoom.js) | `/irl` geocell presence and ambient reactions |
| `clash_arena` | [`src/rooms/ClashRoom.js`](src/rooms/ClashRoom.js) | Coin Wars battles on `/play/war` |
| `stage_world` | [`src/rooms/StageRoom.js`](src/rooms/StageRoom.js) | Living Stages live performances |
| `studio_world` | [`src/rooms/StudioRoom.js`](src/rooms/StudioRoom.js) | `/ar/studio` shared build-together rooms |

This process runs as its own service, apart from the main web container: the request/response API and a long-lived WebSocket fleet have different scaling shapes, so the worlds get a dedicated deploy. Production is the `three-ws-multiplayer` Cloud Run service (see "Deploy" below). Clients resolve the host with [`src/shared/game-server-url.js`](../src/shared/game-server-url.js) in the web app: localhost first in dev, then the `walk-server` / `game-server` meta tag baked into the page.

## Run locally

```bash
# From the repo root
npm install                  # installs this workspace too
npm run dev:multi            # boots the Colyseus server on :2567

# Or, in another terminal, both servers together:
npm run dev:walk-all         # Vite (:3000) + Colyseus (:2567)
```

The Vite dev pages at `http://localhost:3000/walk` and `http://localhost:3000/play` autodiscover the server at `ws://localhost:2567` (see [`src/walk-net.js`](../src/walk-net.js)), so no environment plumbing is needed.

## Configuration (env)

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `2567` | TCP port to bind |
| `HOST` | `0.0.0.0` | Interface to bind |
| `ALLOWED_ORIGINS` | `localhost:3000-3003,three.ws,www.three.ws` | Comma-separated origin allow-list for the WS upgrade. `*.vercel.app` and `*.three.ws` are always allowed so preview deploys connect. |
| `WALK_ROOM_MAX_CLIENTS` | `100` | Per-room client cap for `walk_world` (clamped to 2-500) |
| `REDIS_URI` | unset | Colyseus room registry + presence Redis; setting it switches on horizontal scaling (see Scaling notes) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | unset | Durable persistence for builds, player profiles, cosmetics ownership, and the activity feed; memory-only without them |

## Endpoints

| Route | Purpose |
| --- | --- |
| `/health`, `/healthz` | Liveness probe, returns `{ok:true}` |
| `/colyseus` | Admin monitor UI ([@colyseus/monitor](https://docs.colyseus.io/tools/monitor/)); protect this behind a reverse proxy or basic auth in prod |
| WS upgrade | Colyseus protocol; clients connect with `new Client('ws://host:2567')` |

## Anti-cheat

Every `move` message is validated server-side in [`WalkRoom.js`](src/rooms/WalkRoom.js):

- **Max-step clamp**: positions farther than `1.2 m` from the player's last position are rejected (legit deltas at 15Hz × 4 m/s run speed are ~0.27 m).
- **World bounds**: the square open-world district, ±198 m from origin on x/z (`WORLD_BOUND_M`, mirroring `DISTRICT.half` in [`src/game/world-zones.js`](../src/game/world-zones.js)); out-of-bounds positions are clamped.
- **Y clamp**: vertical position pinned to `[-10, 10]`.
- **Rate limit**: 30 moves/sec per client window (twice the 15Hz the client sends), so it absorbs jitter without dropping legit traffic.
- **Field types**: every numeric field is `Number.isFinite`-checked; motion strings are validated against an allow-list.

## Reconnects

A dropped client does not resume its old session: `src/game/community-net.js` re-runs `joinOrCreate`, so it comes back with a new `sessionId`. Two things make that clean rather than messy, and both matter at event scale.

**The client's own previous session is retired on sight.** A socket that dies uncleanly (a phone sleeping, a tab freezing, a wifi handover) stays half-open here: the transport still reads it as OPEN and only reaps it once its ping retries expire, several seconds later. The client reconnects well inside that window, so without help the room holds two sessions for one person, and every other player watches a frozen copy of them standing at spawn. So a reconnecting client sends its previous session id as a `prevSession` join option and `WalkRoom._evictPriorSession` closes exactly that session.

`prevSession` on its own would be a kick primitive, since session ids are published on the player schema and anyone could name a stranger's. It is honoured only alongside a matching persistent player key (`client.userData.playerKey`, set from the identity `_resolveIdentity` verified: the wallet from `onAuth`, a wallet proven by a signed play pass, or a server-minted guest id sealed in an HMAC token). A second tab or a second device is never touched, because each carries its own prior session id.

**The client rebuilds its roster from the snapshot, not from memory.** The old room's listeners are removed before it leaves, so `onRemove` never fires for the peers it had. `/play` flags every peer stale when a reconnect starts, clears the flag for each peer the new room re-announces, and disposes whatever is still flagged once the first full state patch lands. Anyone who left while the client was away disappears then, instead of standing in the world for the rest of the session.

Two scripts in the repo root hold this behaviour down.

`scripts/play-reconnect-proof.mjs` is the fast one and needs nothing but Node: it starts its own server, joins as two players over `colyseus.js`, and asserts the room's end state directly. Nine checks, seconds to run, and it fails loudly if the eviction is removed (the room ends up holding the same player twice).

```bash
node scripts/play-reconnect-proof.mjs      # wire level, starts and stops its own server
```

`scripts/play-multiplayer-e2e.mjs` is the full product check: two real browser contexts in one coin world, exchanging movement, emotes and chat, surviving a forced network drop, then asserting the resynced state on both sides. It also covers what only a browser can judge, that chat is written as text and never parsed as markup, that the burst throttle holds, and that the log is capped.

```bash
npm run dev:walk-all                       # vite :3000 + this server :2567
node scripts/play-multiplayer-e2e.mjs      # two contexts, forced drop, resync assertions
BASE=https://three.ws node scripts/play-multiplayer-e2e.mjs   # against the live world
```

Two software-rendered 3D worlds at once is the heaviest thing you can ask a headless Chrome to do, so give the browser run a machine with headroom; the wire-level proof is the one to reach for on a busy box or in a tight loop.

There is also a fishing-lane smoke check in this directory: with a server on `:2567`, `node scripts/fish-smoke.mjs` joins `walk_world`, walks to the east pond, casts, and asserts the profile, catch notice, XP gain, and inventory land.

## Deploy (Cloud Run, production)

Production runs as the `three-ws-multiplayer` Cloud Run service in `us-central1`, separate from the main `three-ws-api` container. [`deploy-cloudrun.sh`](deploy-cloudrun.sh) is the whole deploy: Cloud Build builds the local [`Dockerfile`](Dockerfile), Cloud Run terminates TLS and hands back a stable https URL.

```bash
cd multiplayer
./deploy-cloudrun.sh          # override SERVICE/REGION/CPU/MEMORY/... via env
```

Read the script's header before touching capacity: it re-applies its CPU/memory/concurrency defaults on every deploy, so a hand-raised limit on the live service survives exactly until the next deploy. Without `REDIS_URI` it pins max-instances to 1 on purpose; players in the same coin world must land on the same instance until the room registry is shared.

Clients find the server through meta tags baked into the pages (use the `wss://` form of the service URL):

- `<meta name="walk-server">` in [`pages/temporary.html`](../pages/temporary.html), [`pages/agora.html`](../pages/agora.html), and [`pages/marketplace-walk.html`](../pages/marketplace-walk.html)
- `<meta name="game-server">` in [`pages/play.html`](../pages/play.html)

[`fly.toml`](fly.toml) is kept as an alternative host config (`fly launch --no-deploy`, set `ALLOWED_ORIGINS` and the Upstash secrets, `fly deploy`), but production is Cloud Run.

## Scaling notes

- A single Node process holds many rooms; Colyseus's matchmaker creates a new room per coin world as needed and spills into a fresh one when a room fills.
- `walk_world` caps at 100 clients per room by default (`MAX_CLIENTS_PER_ROOM` in [WalkRoom.js](src/rooms/WalkRoom.js), tunable via `WALK_ROOM_MAX_CLIENTS`, clamped to 2-500).
- Across instances: horizontal scaling is already wired in [`src/index.js`](src/index.js). Set `REDIS_URI` (e.g. a Memorystore instance) and the server boots with `@colyseus/redis-driver` + `@colyseus/redis-presence`, making matchmaking cluster-aware; `deploy-cloudrun.sh` then allows multiple instances. Without it the server logs `single-instance mode` and must stay at one instance.

## What the schema looks like on the wire

See [`src/schemas.js`](src/schemas.js). Each `Player` is 21 primitive fields (position, motion, identity, cosmetics, combat flags), encoded as a binary delta: only the fields that changed since the last patch are sent. The live wire budget is kept in the capacity comment above `MAX_CLIENTS_PER_ROOM` in [`WalkRoom.js`](src/rooms/WalkRoom.js): a full 100-client room costs each client roughly 40 KB/s down (99 peers × ~28 B average × 15 Hz), well inside both the container and a normal connection.
