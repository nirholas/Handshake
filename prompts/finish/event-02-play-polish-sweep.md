# 02 · /play polish sweep: every state designed, every path smooth, mobile solid

**How to run:** paste this whole file into a fresh Claude Code chat in the three.ws repo, or tell the agent to read `prompts/finish/event-02-play-polish-sweep.md`. Read [00-CONTEXT.md](event-00-CONTEXT.md) first.

**Operating clause:** finish 100%. Never end the session with a question, an unexecuted plan, or "let me know". CLAUDE.md hard rules bind: no mocks, no TODO comments, no em-dash characters, commits stage explicit paths only, pushes and production deploys are owner-gated. This surface is under concurrent development: re-read a file immediately before each edit and stage only your own paths.

## Step 0 · Re-derive the current state

```bash
git log --oneline -10 -- src/game/
git status --short src/game/ scripts/play-mobile-repro.mjs
npm run dev &   # port 3000; reuse if already running
```

Open `http://localhost:3000/play` in a real browser with DevTools open. Then walk the FULL user journey while logging every defect you see into a scratch list: cold load, lobby, avatar pick/create/upload, search, entering the $THREE world (`?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`), moving, chat, emotes, store, bank, wheel, quests board, friends drawer, leaving back to the lobby. Repeat at 375px width with touch emulation. Recent commits mention mobile-perf work on avatar chips and honest lobby/HUD states; whatever already shipped, do not redo.

## Tasks

Work the defect list you just built, worst first. Minimum bar to sweep for, with the usual owners of each class:

1. **Console hygiene:** zero errors and zero warnings from our code across the whole journey. Every one you see gets root-caused, not filtered.
2. **Every async surface has a designed loading, empty, and error state.** Lobby coin grid, search results, avatar gallery, friends drawer, jobs board, store/bank/wheel panels. Empty states say what to do next; error states say how to recover. The lobby and HUD chrome live in [src/game/coincommunities-ui.js](../../src/game/coincommunities-ui.js); panel UIs in [src/game/economy-ui.js](../../src/game/economy-ui.js), [src/game/quests-ui.js](../../src/game/quests-ui.js), [src/game/spin-wheel-ui.js](../../src/game/spin-wheel-ui.js), [src/game/friends-panel.js](../../src/game/friends-panel.js).
3. **Interactive-state audit:** every clickable element has hover, active, and focus-visible states, and is keyboard-reachable. Tab through the lobby end to end; fix what the ring skips.
4. **Mobile:** at 375px and 320px nothing overlaps, nothing overflows, touch targets are 40px+, the joystick/chat/emote/HUD stack leaves the world visible. Use `scripts/play-mobile-repro.mjs` if present as the harness for a scripted repro.
5. **Perceived speed:** the lobby must feel instant. Check for layout shift on coin-card image load (reserve aspect boxes), avatar chip pop-in, and any spinner that could be a skeleton. Do not add heavy work to boot; lazy-load anything new.
6. **Copy pass:** every string a player sees during the journey reads like a product, not a log line. Plain language, no jargon, no dead-end messages.
7. For anything you fix that players would notice, one collective `data/changelog.json` entry (tags: `improvement`), then `npm run build:pages`.

## Definition of done

- [ ] The full journey above runs clean in a real browser: zero console errors, zero warnings from our code, on desktop and at 375px.
- [ ] Your scratch defect list is empty or every remaining item is listed in the report with a reason it was out of scope (someone else's in-flight work, server-side, needs owner).
- [ ] Keyboard-only run of the lobby reaches every control.
- [ ] `npm run check:rules -- --paths <files you touched>` passes; `npm run test:core` passes; if you touched files with existing tests (`tests/`), those suites pass.
- [ ] Changelog entry present; committed with explicit paths; PROGRESS.md appended.

## Never blocked

| Blocker | Resolution |
|---|---|
| Multiplayer server absent locally | `npm run dev:walk-all` boots web + colyseus together; solo-world flows also work offline by design, so verify what you can and say which lane you used. |
| A defect lives in a file another agent has dirty in `git status` | Fix only if trivial and non-overlapping; otherwise record it in the report as in-flight elsewhere and move on. |
| A fix needs a server change in `multiplayer/` | That is in scope; the room handlers are in `multiplayer/src/rooms/WalkRoom.js` and the module tests under `tests/` show the patterns. |
| Playwright missing browsers | `npx playwright install chromium`. |

## Report format

The defect list with each item marked fixed / out-of-scope-and-why, the journey verification (desktop + 375px, console state), test output verbatim, files committed.
