# 02 · /play polish sweep: the in-world half

**How to run:** paste this whole file into a fresh Claude Code chat in the three.ws repo, or tell the agent to read `prompts/finish/event-02-play-polish-sweep.md`. Read [00-CONTEXT.md](event-00-CONTEXT.md) first.

**Operating clause:** finish 100%. Never end the session with a question, an unexecuted plan, or "let me know". CLAUDE.md hard rules bind: no mocks, no TODO comments, no em-dash characters, commits stage explicit paths only, pushes and production deploys are owner-gated. This surface is under heavy concurrent development: re-read a file immediately before each edit and stage only your own paths.

Rewritten 2026-09-02 to its remainder. The lobby half is verified and is not yours to redo. The in-world half is still owed, and the reason it is still owed is now a measured machine condition rather than a mystery. Read "The one precondition" before you run anything.

## What is already verified (do not redo)

- **The lobby, twice.** The 2026-08-08 preflight measured 130 desktop / 91 mobile tab stops with 0 focus rings missing and 0 controls refusing focus, 31 coin cards, 7 presets, create modal and gallery both closing on Escape, search resolving to hits and to a designed empty state, CLS 0.0065, no horizontal overflow at 1440 or 375. A 2026-09-02 re-run agreed: `[focus:lobby] 114 tabbable, 0 kinds without a focus ring, 0 that refuse focus`, 21 cards, 0 skeletons.
- **The world boots headless on this box.** This retires the residual the preflight and the order-04 agent both recorded ("the 3D scene will not boot headless under this load"). On 2026-09-02 `scripts/play-journey-audit.mjs` drove a real cold load, the lobby, search, the create modal, the gallery, world entry into the $THREE world, the HUD, and the store, bank, wheel and emote panel probes, in headless Chromium under `--use-gl=swiftshader --enable-unsafe-swiftshader`. The path works. There is no need to invent a new harness.

## The one precondition, and it is the whole reason this order is still open

**Run this on a quiet box.** `scripts/play-journey-audit.mjs` measures with wall-clock waits, so CPU contention does not slow it down, it makes it lie. Measured on 2026-09-02:

- At load average 43 on 16 cores the run reached the world but the shared Vite dev server on port 3000 died at +67s, and every subsequent line was `net::ERR_CONNECTION_REFUSED`. A store panel that "failed to load its module" and a `LOADER NEVER CLEARED` were both artifacts of a dead server, not defects.
- At load average 220 the same harness printed `LOBBY NEVER BECAME VISIBLE` at +125s and then `[state:lobby-first-paint] {"cards":21}` at +211s, and printed `GRID NEVER RESOLVED (no cards, no empty state, no error state)` about a grid holding 21 cards. Every verdict in that run is a false negative.

So, before you start and again when you finish:

```bash
uptime                                            # 1-minute load must be well under 16
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/play   # must be 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:2567/health # world server, must be 200
```

If the load is high, wait it out or take the box quiet; do not run the sweep and do not report its output. If either server is down, `npm run dev:walk-all` boots both. A run whose tail shows a burst of `ERR_CONNECTION_REFUSED` on `localhost:3000` is a dead-server run: discard it and rerun, never triage its findings.

## Step 0 · Re-derive the current state

```bash
git log --oneline -15 -- src/game/
git status --short src/game/
```

`src/game/photo-mode.js` and its neighbours were being actively edited on 2026-09-02 under order 06. Anything dirty or freshly committed there belongs to that work.

## The run

```bash
TAB_CHECK=1 node scripts/play-journey-audit.mjs            # desktop 1440x900
VIEWPORT=375 node scripts/play-journey-audit.mjs           # phone
VIEWPORT=320 node scripts/play-journey-audit.mjs           # narrowest supported
```

Each takes minutes even on a quiet box. Capture all three to files and build the defect list from them, then reproduce each finding by hand in a headed browser before you change any code: the harness locates defects, it does not diagnose them.

Two known harness readings to interpret rather than file:

- `[overflow:panel:*]` rows for `div.cc-label.ac-name`, `div.ac-prompt`, `span.ac-key`, `div.tik-prompt`, `div.npc-prompt` and `div.cc-label.npc-name` are billboard labels positioned in world space, so far-negative and far-positive `left` values are how they are supposed to behave when their subject is off camera. Confirm that reading once, then treat those selectors as noise. A DOM panel overflowing is a real defect; a world label at x=5746 is not.
- `[panel:bank] no trigger visible` is correct. The bank is proximity-gated behind its ATM by design ("the bank makes you walk there", changelog 2026-08-08), so it has no HUD button. Same for the Wheel of Fortune, which is gated behind its station; the harness excludes the emote wheel from that probe on purpose. Reaching those two panels means walking the avatar to the station, not clicking a HUD button.

## Tasks

Work the defect list worst first. The bar, with the usual owner of each class:

1. **Console hygiene in-world:** zero errors and zero warnings from our code across world entry, movement, chat, emotes, the store, the bank, the wheel, the jobs board and the friends drawer. Root-cause every one; never filter.
2. **Every in-world async surface has a designed loading, empty and error state.** Panel UIs live in [src/game/economy-ui.js](../../src/game/economy-ui.js), [src/game/quests-ui.js](../../src/game/quests-ui.js), [src/game/spin-wheel-ui.js](../../src/game/spin-wheel-ui.js), [src/game/friends-panel.js](../../src/game/friends-panel.js); the HUD chrome is in [src/game/coincommunities-ui.js](../../src/game/coincommunities-ui.js). Empty states say what to do next; error states say how to recover.
3. **Interactive-state audit in-world:** every panel control has hover, active and focus-visible states and is keyboard reachable, and Escape closes every panel that opens.
4. **Mobile at 375 and 320:** nothing overlaps, nothing overflows, touch targets 40px or larger, and the joystick, chat, emote and HUD stack still leave the world visible.
5. **Copy pass:** every string a player sees in-world reads like a product, not a log line.
6. For anything a player would notice, one collective `data/changelog.json` entry (tags: `improvement`), then `npm run build:pages`.

## Definition of done

- [ ] Three clean harness runs (desktop, 375, 320) captured on a quiet box, each with a live dev server at the start and the end of the run.
- [ ] The defect list is empty or every remaining item is in the report with a reason it was out of scope (in-flight elsewhere, server-side, needs owner).
- [ ] Every fix reproduced by hand in a headed browser before and after.
- [ ] `npm run check:rules -- --paths <files you touched>` passes; `npm run test:core` passes; any existing suite covering a file you touched passes.
- [ ] Changelog entry present; committed with explicit paths; [PROGRESS.md](event-PROGRESS.md) appended.

## Never blocked

| Blocker | Resolution |
|---|---|
| Load average too high to measure | Wait, or run it later in the session. Reporting a contended run as a defect list is worse than reporting nothing; the 2026-09-02 attempt is the cautionary example. |
| Dev server dies mid-run | It is shared with every other agent on this worktree. Restart with `npm run dev:walk-all`, discard the poisoned run, rerun. |
| A defect lives in a file another agent has dirty in `git status` | Fix only if trivial and non-overlapping; otherwise record it as in-flight elsewhere and move on. |
| A fix needs a server change in `multiplayer/` | In scope. Room handlers are in `multiplayer/src/rooms/WalkRoom.js`; the module tests under `tests/` show the patterns. |
| Playwright missing browsers | `npx playwright install chromium`. |

## Report format

The three run files, the defect list with each item marked fixed / out-of-scope-and-why, the load average at the start and end of each run, test output verbatim, files committed.

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/event-02-play-polish-sweep.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
