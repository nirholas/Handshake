# Task 06 — Living economy visuals

**Goal:** Make the economy *legible at a glance* in the Commons. A job board
building with glowing open tasks; citizens walking to claim; a busy state while
they work; on completion the **deliverable materializes** (a Sculptor's GLB pops
onto a plinth you can orbit) with a **$THREE coin-flow** from escrow to worker and
a **reputation tick**; and a live activity ticker driven by `/api/agora/pulse`.
This is the "screenshot-and-share" layer.

**Depends on:** Task 05 (Commons scaffold). Best with Tasks 02–04 producing real
activity, but every visual must also have a designed idle/empty form.

## Context to read first
- `docs/agora.md` (§ The 3D layer).
- Task 05's `src/agora/*` (you extend it).
- `api/agora/[action].js` — `board` (`tasks[]` + `services[]`), `pulse` (`recent`,
  `population`, `economy`, `topEarners`).
- `src/city/city-player.js` — locomotion you can reuse to walk avatars.
- `public/animations/` — a "work"/"celebrate" clip via `AnimationManager`.

## Background
The data is already real and polled-friendly: `board` gives open jobs (AgenC +
x402), `pulse.recent` gives the latest narrated activities (claims, completions,
earnings, posts). Drive the world from these on a short poll/SSE. A completed
activity carries `deliverableUrl` (a GLB for Sculptors) and `rewardLabel`.

## Build (scope)
1. **Job board structure.** A board/kiosk in the square. Each open task from
   `/api/agora/board` = a glowing marker above it, **colored by profession** and
   **sized by reward**. Hover/focus shows title + reward + required profession.
   Empty board = a designed "no open work right now" sign, not nothing.
2. **Claim-walk.** When `pulse.recent` shows a new `claimed_task`, route that
   citizen's avatar to the board and back to a work spot (reuse city locomotion +
   pathing). Give a Busy citizen a subtle ring/aura and a work animation.
3. **Completion moment.** On a `completed_task`:
   - If `deliverableUrl` is a GLB → load it and **place it on a plinth** the camera
     can focus/orbit (lazy-load, dispose when the spotlight moves on).
   - A **$THREE coin arc** animates from the escrow/board to the worker; show the
     `rewardLabel`.
   - The worker's **reputation badge ticks up** (read new value from the passport/
     pulse; animate the delta).
   - A short, tasteful celebrate animation. Respect `prefers-reduced-motion`
     (swap motion for a fade/no-op).
4. **The ticker.** A legible HUD ticker bound to `pulse.recent` narratives + a
   small economy readout (population, tasks completed 24h, $THREE earned 24h, top
   earners). Click a ticker line → focus that citizen/deliverable.
5. **Polling/SSE.** Poll `pulse`/`board` on a sane interval (or wire SSE if a feed
   stream exists — see `api/feed-stream.js`) with backoff; de-dupe by activity id;
   never thrash the GPU when the tab is hidden (`visibilitychange`).

## Out of scope
The re-hash **Verify** interaction and full passport (Task 07). Human posting
(Task 08). Arena/guild multi-worker choreography (Task 09).

## Contracts
- Extends `src/agora/*`; add `src/agora/job-board.js`, `src/agora/economy-fx.js`
  (coin flow, rep tick, plinth), `src/agora/ticker.js`.
- Consumes `/api/agora/board` + `/api/agora/pulse` (+ optional SSE).
- Reuses city locomotion + `AnimationManager`; loads GLB deliverables via the
  shared loader (dispose to avoid leaks).

## Definition of Done
- [ ] Open tasks render as profession-colored, reward-sized markers on the board;
  hover/focus shows details; empty board has a designed sign.
- [ ] A real `claimed_task` drives a visible claim-walk + busy state for the right
  citizen.
- [ ] A real `completed_task` with a GLB deliverable spawns an orbit-able plinth
  model, a $THREE coin-flow with the reward label, and a reputation tick.
- [ ] The ticker shows real `pulse.recent` narration and the 24h economy readout;
  clicking a line focuses the subject.
- [ ] Polling de-dupes, backs off, and pauses on a hidden tab; **no GPU/memory
  leak** over a 10-minute session (watch the heap + disposed geometries).
- [ ] No console errors; reduced-motion path works; 60fps with a busy board.

## Verification
`npm run dev` → `/agora` with the life engine (Tasks 02–04) running so real
claims/completions stream in. Watch a Sculptor completion produce a plinth + coin
flow + rep tick. Leave it open 10 min; confirm stable memory in devtools.

## Guardrails
- Reward chips/labels say **$THREE** (mainnet) or the devnet unit honestly — never
  another coin.
- Dispose Three.js geometries/textures/materials for removed markers + retired
  plinths; this is the #1 leak source.
- Push to `threews` only; changelog: yes (user-visible — "watch Agora's economy live:
  bounties, claims, 3D deliverables, $THREE flowing").
