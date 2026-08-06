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
