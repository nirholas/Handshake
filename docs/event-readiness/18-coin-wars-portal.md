# Feature 18: Coin Wars portal inside the world

Coin Wars is finished and, since the portal landed, visible. `ClashRoom` runs full community-vs-community battles (lobby, countdown, live, sudden death, kill cap, round clock) with an Elo league behind it, the arena is a real page at /play/war, and every coin world's plaza has a war portal (`src/game/war-portal.js`, constructed by `coincommunities.js`) to see the standings, queue for a war, and come back with the result without leaving /play. The player-facing walkthrough is [docs/coin-wars.md](../coin-wars.md). This prompt is now the spec to verify against and extend, not a blank build.

## Where the code lives

- Server: `multiplayer/src/rooms/ClashRoom.js` (registered as `clash_arena` with `filterBy(['matchKey'])` in `multiplayer/src/index.js`), match logic in `multiplayer/src/clash.js`, league in `multiplayer/src/war-standings.js`, summaries in `multiplayer/src/war-report.js`, schemas in `multiplayer/src/clash-schemas.js`, pairing in `multiplayer/src/war-matchmaking.js` and live-war state in `multiplayer/src/war-live.js`
- Public API: `api/wars.js` (`GET /api/wars?coin=` for the board, `?action=live` for the spectator poll, `POST ?action=queue` and `?action=leave` for the queue, `POST ?action=report` for the game server's HMAC-signed result), backed by `api/_lib/wars-store.js` and the signed war ticket in `api/_lib/war-ticket.js`. Standings are folded from the battle ledger by `war-standings.js`, the same module the arena uses, never recomputed
- Arena client the portal hands off to: `pages/play/war.html`, `src/play/war.js`, `src/play/war-world.js` (ClashRoom is authoritative; the client renders and sends intent). `/play/arena` (`src/play/arena.js`, `arena-world.js`) is the Sniper Arena, the AI-agent trading floor, not Coin Wars; do not route war traffic there
- Gating: the same holder pass as the Holders world (`multiplayer/src/holder-pass.js`, `api/community/holder-pass.js`)
- World mount: the portal in `src/game/war-portal.js` follows the landmark precedent in `src/game/wheel-station.js` and the canvas-board precedent in `src/game/chart-screen.js`; live feed producer `multiplayer/src/feed.js` (`war-result` is an allowed event type)
- Deep-link return path: the canonical URL emission in `src/game/coincommunities.js` (`history.replaceState` in `enter()`)

## What to build

1. **The portal landmark.** Shipped: the board in `war-portal.js` paints this coin's league row, recent battles, and any live war from `GET /api/wars`. Idle cost is zero by design: nothing is fetched until a player is inside the board's legibility ring (`WAR_PORTAL_BOARD_REACH`), the slow poll runs while someone idles near it, and the fast poll only while a war involving this coin is live, the panel is open, or the community is queued. Verify those cadences hold; do not add a second fetch path.
2. **Queue from the world.** Shipped: E at the portal runs the holder gate, `POST /api/wars?action=queue` pairs the community with a waiting one and returns the `matchKey` plus a signed war ticket (ClashRoom takes both competing communities from the ticket, never from a joining client), and the handoff goes to `/play/war` with a return link carrying `coin`, `name`, `symbol`, `image` so coming back lands in the same world with no lobby detour. Verify the round trip both ways.
3. **Spectate without leaving.** Shipped: while a war involving this coin is live the board becomes a scoreboard (score, round clock, kill feed) off the `?action=live` poll, text and numbers only, with the same numbers in the panel's spectator card.
4. **Results echo.** Partly shipped: the game server reports the result through `POST /api/wars?action=report`, `war-result` events go out through `multiplayer/src/feed.js`, and a win holds a 9 s takeover on the board (`HYPE_MS`). Still open: a jumbotron moment on the chart screen, and a ticker row if Feature 15 lands.
5. **Honest empty states.** Shipped for the unranked community, the empty battle log, the unreachable ledger, and the empty kill feed (each says what it is and what to do, e.g. "No wars fought yet. Press E to queue this community, the arena opens as soon as a second one does."). Verify each still renders in the designed style of the lobby's retry cards.

## Verify

- Two browsers on `npm run dev`: queue from the portal in both, complete a short war on the arena page, return via the return link into the same coin world, and see the result echoed on the portal board.
- Holder gating verified both ways: a gated war refuses cleanly with the existing gate UX; an open war admits.
- Portal costs nothing when idle: no polling while no player is near it, no console errors.
- `npm test` green.

## Report format

Files shipped, the standings read path (existing or the one endpoint you added), the handoff and return URL shapes, and the `data/changelog.json` entry.
