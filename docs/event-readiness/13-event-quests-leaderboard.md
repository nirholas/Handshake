# Feature 13: event quest line with a live leaderboard

Give event visitors something to chase. A time-boxed quest line that runs only during the event window, scored server-side, with a live leaderboard in the world and a cosmetic reward for finishers. The pieces all exist; this task wires them into one loop.

## Where the code lives

- Quests: `src/game/quests-ui.js`, `src/game/npc/quest-npcs.js`, `src/game/npc/quest-markers.js`
- Event window: `public/event.json` (the same config `src/game/event-countdown.js` reads; do not invent a second source of truth)
- Live scoreboard precedent: the King of the Totem round HUD in `src/game/coincommunities-ui.js` (server-authoritative scores pushed through the room)
- Server: `multiplayer/src/rooms/WalkRoom.js`; persistent scores belong in the database via an `api/` handler (migrations in `api/_lib/migrations/`, preview with `npm run db:status`)
- Leaderboard OG precedent: `api/og-leaderboard.js`; cosmetics reward path: `src/game/cosmetics-*.js` and the cosmetics API

## What to build

1. **The quest line.** Three to five event quests using existing verbs (visit landmarks, gather, emote with another player, take a photo if Feature 12 landed, make one x402 micro-purchase). Defined in data, gated on the event window from `event.json`; outside the window the quest giver and markers do not exist.
2. **Server-authoritative scoring.** Completion is validated and scored server-side (room or API, whichever the verb already trusts); the client never self-reports a finished quest. Persist per-wallet (signed-in) with a per-session fallback for anonymous players that clearly says sign in to enter the leaderboard.
3. **Live leaderboard.** An in-world board (panel or world screen) showing top players and your own rank, updating live without refresh. Also expose it at an API endpoint so the event host can put it on a projector.
4. **The reward.** Finishers get a real cosmetic granted through the existing cosmetics ownership path, visibly equipped-able immediately, with a celebration moment on grant.
5. **Anti-grief basics.** Rate limits on completion attempts, idempotent grants (finishing twice never double-grants), and no negative or NaN scores possible.

## Verify

- Full loop on `npm run dev` with two browsers: complete quests in one, watch the leaderboard move in both; reward granted once, persists across reload.
- Event window off: zero event-quest UI anywhere.
- `npm test` green; add tests for the scoring endpoint (auth, idempotency, window gating). `npm run db:status` before any migration; note what `db:migrate` would apply.

## Report format

The quest list as players will see it, files shipped, the leaderboard endpoint URL, migration status, and the `data/changelog.json` entry. One line on anything deferred.
