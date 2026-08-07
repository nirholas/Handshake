# 04 · Event day in-world: a quest line and a live leaderboard

**How to run:** paste this whole file into a fresh Claude Code chat in the three.ws repo, or tell the agent to read `prompts/event/04-event-quests-leaderboard.md`. Read [00-CONTEXT.md](00-CONTEXT.md) first.

**Operating clause:** finish 100%. Never end the session with a question, an unexecuted plan, or "let me know". CLAUDE.md hard rules bind: no mocks, no TODO comments, no em-dash characters, commits stage explicit paths only, pushes and production deploys are owner-gated. Everything here is server-authoritative: the client renders, the server decides.

## Step 0 · Re-derive the current state

```bash
sed -n '1,80p' multiplayer/src/quests.js
sed -n '1,60p' multiplayer/src/quest-zones.js
grep -rn "leaderboard" multiplayer/src src/game api | head -20
cat public/event.json
```

Read the quest engine and its existing job definitions end to end before designing anything: the event quest line must ride the proven engine, not a parallel one. If a leaderboard already exists anywhere, extend it instead of building a second.

## The feature

During the event window (the same `public/event.json` every other surface reads), the $THREE world gets:

1. **An event quest line:** 3 to 5 jobs on the existing jobs board, tagged as event jobs, spanning what the world already does well: a gathering job, a delivery driving job, a combat job in a danger zone, a social job (e.g. visit named landmarks). Real cash/XP payouts through the existing server-side completion path. Outside the event window the jobs simply do not appear; gate them server-side on the clock, never client-side.
2. **A live event leaderboard:** ranked by event-quest completions (tiebreak: total event cash earned), persisted server-side for the duration of the event, visible two ways:
   - In-world: a panel reachable from the jobs board UI ([src/game/quests-ui.js](../../src/game/quests-ui.js)) showing top 10 plus your own rank.
   - The event page (`/event`, order 03) if it exists: reuse the same API. One read endpoint under [api/](../../api/), shaped like the neighboring `api/play/*` handlers.
3. **Winners are announced, not paid:** the leaderboard states that prizes are settled by the owner after the event. Do NOT wire any automatic on-chain payout; an on-chain spend is a CLAUDE.md stop-and-ask gate and the owner runs it manually after the event.

## Tasks

1. Define the event jobs in the quest engine's own format (`multiplayer/src/quests.js` / `quest-zones.js`), gated on the event window read server-side from the same config values (load `public/event.json` on the server; do not duplicate the times in code).
2. Track per-player event completions in the room's persistence the same way the economy persists purse/bank (see `multiplayer/src/economy.js` for the pattern and where persisted fields live).
3. Serve the leaderboard: a room message for the in-world panel (pattern: existing handlers in `multiplayer/src/rooms/WalkRoom.js`) and one HTTP read endpoint for the web.
4. Client panel in `quests-ui.js`: loading, empty ("no event runs yet, be the first"), populated, and error states, with your-own-rank pinned; matches the monochrome tokens; hover/focus states on everything clickable.
5. Tests: the quest gating (in/out of window) and leaderboard ranking logic get unit tests under [tests/](../../tests/), following `tests/spin-wheel.test.js` conventions.
6. Changelog entry (tags: `feature`) written for holders; `npm run build:pages`.

## Definition of done

- [ ] With the window temporarily set live, the jobs appear on the board, complete end to end (`npm run dev:walk-all`, real browser), pay out server-side, and rank on the leaderboard; with the window closed, none of it exists. Config restored afterward.
- [ ] Leaderboard read endpoint returns real data (curl it in the report).
- [ ] All new logic unit-tested; `npm test` passes with no `tail` piping; `npm run check:rules -- --paths <files you touched>` passes.
- [ ] No client-trusted state anywhere in the diff.
- [ ] Changelog entry present; committed with explicit paths; PROGRESS.md appended.

## Never blocked

| Blocker | Resolution |
|---|---|
| Quest engine format unclear | The existing jobs in `quests.js` are the spec; clone the closest one per event job and adjust. |
| Where persisted player state lives | Trace how the bank balance survives reconnects in `economy.js` + `WalkRoom.js`; use the same store. |
| Colyseus locally | `npm run dev:walk-all` runs it; its README under `multiplayer/` covers ports. |
| Prize mechanics tempt an on-chain payout | Do not build it. The gate is absolute; ranked list + owner settles manually is the design. |

## Report format

Jobs shipped (names + objectives), the end-to-end run as observed, curl of the leaderboard endpoint, test output verbatim, files committed.
