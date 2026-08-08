# three.ws · multiplayer

Authoritative [Colyseus](https://colyseus.io/) server that powers the `/walk` page on three.ws.

This process runs **outside** the Vercel deploy — Vercel doesn't host long-lived WebSockets, so this server lives next to the static site (Fly.io, Railway, Render, or a small VPS). The client at `three.ws/walk` connects to it over a WebSocket and exchanges player state through the `WalkRoom` defined in [`src/rooms/WalkRoom.js`](src/rooms/WalkRoom.js).

## Run locally

```bash
# From the repo root
npm install                  # installs this workspace too
npm run dev:multi            # boots the Colyseus server on :2567

# Or, in another terminal, both servers together:
npm run dev:walk-all         # Vite (:3000) + Colyseus (:2567)
```

The Vite dev page at `http://localhost:3000/walk` will autodiscover the server at `ws://localhost:2567`.

## Configuration (env)

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `2567` | TCP port to bind |
| `HOST` | `0.0.0.0` | Interface to bind |
| `ALLOWED_ORIGINS` | `localhost:3000-3003,three.ws,www.three.ws` | Comma-separated origin allow-list for the WS upgrade. `*.vercel.app` and `*.three.ws` are always allowed so preview deploys connect. |

## Endpoints

| Route | Purpose |
| --- | --- |
| `/health`, `/healthz` | Liveness probe — returns `{ok:true}` |
| `/colyseus` | Admin monitor UI ([@colyseus/monitor](https://docs.colyseus.io/tools/monitor/)) — protect this behind a reverse proxy or basic auth in prod |
| WS upgrade | Colyseus protocol — clients connect with `new Client('ws://host:2567')` |

## Anti-cheat

Every `move` message is validated server-side in [`WalkRoom.js`](src/rooms/WalkRoom.js):

- **Max-step clamp**: positions farther than `1.2 m` from the player's last position are rejected (legit deltas at 15Hz × 4 m/s run speed are ~0.27 m).
- **World bounds**: a 60 m radius around origin; out-of-bounds positions are clamped.
- **Y clamp**: vertical position pinned to `[-10, 10]`.
- **Rate limit**: 30 moves/sec per client window — well above the 15Hz the client sends, so it absorbs jitter without dropping legit traffic.
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

## Deploy to Fly.io

```bash
cd multiplayer
fly launch --no-deploy            # reads fly.toml (already in this dir)
fly secrets set ALLOWED_ORIGINS=https://three.ws,https://www.three.ws
fly deploy
```

After deploy, point the client at the new host by adding a meta tag to `walk.html`:

```html
<meta name="walk-server" content="wss://three-ws-multiplayer.fly.dev">
```

## Scaling notes

- A single Node process holds many rooms (each room = one WalkRoom instance).
- Each room caps at 100 clients by default (`MAX_CLIENTS_PER_ROOM` in [WalkRoom.js](src/rooms/WalkRoom.js), tunable via the `WALK_ROOM_MAX_CLIENTS` env var). Colyseus's matchmaker creates a new room when the current one fills.
- Across machines: add [`@colyseus/redis-presence`](https://docs.colyseus.io/scalability/redis-presence/) + a Redis instance so matchmaking is cluster-aware. This is a config-only change to [`src/index.js`](src/index.js); add it when you cross ~200 concurrent players.
- Memory budget: ~5 MB per 50-player room on Node 22. The default Fly VM (256 MB) holds plenty of rooms.

## What the schema looks like on the wire

See [`src/schemas.js`](src/schemas.js). Each `Player` is 8 fields, encoded as a binary delta: only the fields that changed since the last patch are sent. At 15Hz × 50 players × ~24 bytes/player avg = ~18 KB/s outbound per fully-busy room — fine on any VPS.
