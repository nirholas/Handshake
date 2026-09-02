# Event pack · shared context

Read this file before running any work order in this directory. Every order assumes these facts.

## The event

- **What:** $THREE Community Day, a live community event held inside the `/play` world.
- **When:** 2026-08-08. The authoritative start/end times live in [public/event.json](../../public/event.json) and NOWHERE else. If the owner has stated a different time in chat, update that file first; every countdown surface reads it.
- **Where:** the flagship $THREE world:
  `/play?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&name=three.ws&symbol=three`
- **The promoted coin is $THREE** (CA `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`). Nothing referencing any other crypto project gets committed without explicit owner approval (CLAUDE.md commit gate).

## The surface

`/play` is Coin Communities, the browser isometric MMO. Orient with the `/play` rows in [STRUCTURE.md](../../STRUCTURE.md) before touching anything. Key facts that bite:

- Entry HTML: [pages/play.html](../../pages/play.html). Client core: [src/game/coincommunities.js](../../src/game/coincommunities.js) (world) and [src/game/coincommunities-ui.js](../../src/game/coincommunities-ui.js) (lobby + HUD chrome). Both are under active concurrent development; prefer the self-attaching side-module pattern ([src/game/ambient-crowd.js](../../src/game/ambient-crowd.js), [src/game/event-countdown.js](../../src/game/event-countdown.js)) over editing them.
- Server: the Colyseus room in [multiplayer/src/rooms/WalkRoom.js](../../multiplayer/src/rooms/WalkRoom.js). All economy, quest, combat, and cosmetic state is server-authoritative. Never grant anything client-side.
- Design language: monochrome. White is the only color (`--cc-*` tokens in [src/game/coincommunities.css](../../src/game/coincommunities.css)). Match it exactly; a colored banner reads as a bug on this surface.
- The countdown feature already shipped: [src/game/event-countdown.js](../../src/game/event-countdown.js) mounts a lobby banner and an in-world pill from `public/event.json` (states: upcoming, live, over; auto-unmounts after `endsAt`).

## Conventions binding every order here

- CLAUDE.md governs: no mocks, no TODOs, no em-dash anywhere, execute without interviewing the owner, deploys and pushes are owner-gated, changelog entry for every user-visible change (`data/changelog.json`, then `npm run build:pages`).
- Commit with explicit paths only (concurrent agents share this worktree; `git add -A` sweeps their work).
- Scope `npm run check:rules -- --paths <your files>` to your own touched files.
- Verify UI work in a real browser (`npm run dev`, port 3000). For the game world end to end use `npm run dev:walk-all`.
- Append a dated entry to [PROGRESS.md](event-PROGRESS.md) when you finish an order: what shipped, what remains, evidence.

## Run order

01 and 07 are the spine: 01 makes the countdown real for the actual event time, 07 is the final go/no-go sweep and must run LAST, after every other order that is going to land has landed. 02 through 06 are independent of each other; run as many as time allows, highest value first: 02 (polish), 03 (landing page), 04 (event quests), 05 (cosmetic drop), 06 (photo mode).

## Retire this file when the campaign is done (required)

This file is shared context rather than a single order, so it outlives the
prompts that cite it. Delete it in the commit that closes the LAST prompt of
this campaign, once nothing else in `prompts/finish/` references it:

       grep -rl 'event-00-CONTEXT' prompts/finish/
       git rm prompts/finish/event-00-CONTEXT.md

While any sibling prompt of this campaign is still on disk, leave this file in
place and keep it accurate instead. The shrinking directory is the only signal
to the next agent that a campaign is closed.
