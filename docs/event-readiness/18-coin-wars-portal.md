# Feature 18: Coin Wars portal inside the world

Coin Wars is finished and invisible. `ClashRoom` runs full community-vs-community battles (lobby, countdown, live, sudden death, kill cap, round clock) with an Elo league behind it, but the only door is the standalone page at /play/arena. Nobody standing in the $THREE world knows wars exist. Build the portal: see the standings, queue for a war, and come back with the result, all from inside /play.

## Where the code lives

- Server: `multiplayer/src/rooms/ClashRoom.js` (registered as `clash_arena` with `filterBy(['matchKey'])` in `multiplayer/src/index.js`), match logic in `multiplayer/src/clash.js`, league in `multiplayer/src/war-standings.js`, summaries in `multiplayer/src/war-report.js`, schemas in `multiplayer/src/clash-schemas.js`
- Arena client to hand off to: `pages/play/arena.html`, `src/play/arena.js`, `src/play/arena-world.js` (read how it resolves `matchKey` and gates entry before inventing anything)
- Gating: the same holder pass as the Holders world (`multiplayer/src/holder-pass.js`, `api/community/holder-pass.js`)
- World mount: landmark precedent in `src/game/wheel-station.js`; jumbotron precedent in `src/game/chart-screen.js`; live feed producer `multiplayer/src/feed.js`
- Deep-link return path: the canonical URL emission in `src/game/coincommunities.js` (`history.replaceState` on entry)

## What to build

1. **The portal landmark.** A war portal structure in the plaza with a board showing real league state: this coin's Elo standing, recent war results (`war-report.js` output), and any war currently live. If the standings surface has no public API yet, expose one thin read endpoint under `api/` that serves exactly what the arena client already trusts; do not fork the math.
2. **Queue from the world.** An "enter the war" interaction that runs the same gate the arena page runs (holder pass where required), resolves the `matchKey` the same way, and hands off to `/play/arena` with a return link that carries the full coin identity (`coin`, `name`, `symbol`, `image`) so coming back lands in the same world with no lobby detour.
3. **Spectate without leaving.** While a war involving this coin is live, the portal's board becomes a spectator screen: live score, kill feed, round clock, sourced from the clash room state or a cheap polling read. Text and numbers, not a second 3D render.
4. **Results echo.** When a war ends, the result lands in the world: a feed event through `multiplayer/src/feed.js` and a short jumbotron moment for a win. If Feature 15's ticker landed, the result appears there too.
5. **Honest empty states.** No wars yet, standings empty, matchmaking quiet: each state says what it is and what a player can do about it, in the designed style of the lobby's retry cards.

## Verify

- Two browsers on `npm run dev`: queue from the portal in both, complete a short war on the arena page, return via the return link into the same coin world, and see the result echoed on the portal board.
- Holder gating verified both ways: a gated war refuses cleanly with the existing gate UX; an open war admits.
- Portal costs nothing when idle: no polling while no player is near it, no console errors.
- `npm test` green.

## Report format

Files shipped, the standings read path (existing or the one endpoint you added), the handoff and return URL shapes, and the `data/changelog.json` entry.
