# Task 05 — The Commons (3D scaffold)

**Goal:** Stand up `/agora` — the watchable world — on the existing City
substrate. Render real citizens from `/api/agora/citizens` as avatars living in
the scene, with idle animation and name labels, a click-to-inspect passport
panel, and fully designed loading/empty/error states. This is the shell the
economy visuals (Task 06) and interactions (Tasks 07/08) hang on.

**Depends on:** Task 01 (API live). Ideally Task 02 has seeded citizens so the
scene isn't empty, but the empty state must be designed regardless.

## Context to read first
- `docs/agora.md` (§ The 3D layer) and `00-INDEX.md`.
- `pages/city.html` + `src/city/city-world.js` (scene/renderer/loop),
  `city-map.js`, `city-player.js`, `city-camera.js`, `city.css` — **reuse this.**
- `src/glb-canonicalize.js`, `src/animation-manager.js`, `src/agent-avatar.js`,
  `public/animations/` — avatar load + idle/walk clips.
- `api/agora/[action].js` — `citizens` + `passport` shapes you consume.
- `data/pages.json`, `vite.config.js` — how to register a page + route.

## Background
The City already builds a Three.js world with a controllable player, a map, and a
third-person camera. Agora reuses that scene and **adds a population**: each
citizen is an avatar placed at its `position`, wearing its `avatarUrl` GLB
(canonicalized + retargeted so the shared idle/walk clips drive any rig — see the
avatar pipeline note in CLAUDE.md). Multiple avatars must coexist; pool/instance
sensibly so 50+ citizens stay at 60fps.

## Build (scope)
1. **Page + route.** `pages/agora.html` (mirror `pages/city.html`'s head/mount) +
   `src/agora/agora-world.js` entry. Register in `data/pages.json` (`path:/agora`,
   title/description, auth null) and wire the Vite input if needed.
2. **Mount the City scene.** Reuse `city-world.js`'s scene/renderer/camera/loop
   (extract a shared helper if cleaner, without breaking `/city`). Free-orbit or
   third-person camera over the square.
3. **Populate.** Fetch `/api/agora/citizens`, place an avatar per citizen at its
   `position` (fall back to a deterministic layout if positions are 0). Load each
   `avatarUrl` GLB through the canonicalize→retarget→AnimationManager path; play
   idle. Cache/share GLBs and clips; lazy-load; cap concurrent loads. A floating
   name + profession label per avatar (billboarded, legible, accessible).
4. **Inspect.** Click/tap an avatar (and keyboard focus + Enter) → a side panel
   that fetches `/api/agora/passport?id=…` and shows the basics (name, profession,
   status, reputation, stake, tasks completed, recent activity). The rich passport
   UI is Task 07 — keep this panel a clean, real first version.
5. **States.** Loading = a skeleton/`spinner`-free progressive load (avatars fade
   in). Empty (`citizens.empty`) = a designed "the Commons is quiet — no citizens
   yet" with a link to docs/how it works, **not** a blank void. Error = an
   actionable retry. Resize/responsive (320/768/1440). Respect
   `prefers-reduced-motion`.

## Out of scope
Job board building, claim-walk, completion artifacts, $THREE flows, ticker
(Task 06). Verify button + cross-chain handshake (Task 07). Human avatar/auth
(Task 08).

## Contracts
- New: `pages/agora.html`, `src/agora/agora-world.js`, `src/agora/citizen-avatar.js`,
  `src/agora/passport-panel.js`, `src/agora/agora.css`. Reuse `src/city/*` and the
  avatar pipeline; don't fork them.
- Consumes `/api/agora/citizens` + `/api/agora/passport`.
- `data/pages.json` gains the `/agora` entry.

## Definition of Done
- [ ] `/agora` loads in a real browser via `npm run dev` with **no console errors**.
- [ ] Real citizens render as animated avatars with labels; the count matches
  `/api/agora/citizens`.
- [ ] Clicking (and keyboard-focusing) a citizen opens a passport panel with real
  data from `/api/agora/passport`.
- [ ] Empty, loading, and error states are all designed and reachable (test each:
  zero citizens, slow network, API down).
- [ ] 50 citizens stay smooth (test with a seeded or synthetic-position fleet —
  performance only, not fake economic data); GLBs/clips are shared not reloaded.
- [ ] Responsive at 320/768/1440; reduced-motion honored; focus rings present.

## Verification
`npm run dev` → open `/agora`. Network tab shows real `/api/agora/*` calls. Toggle
the API off to see the error state; point at an empty DB to see the empty state.
Throttle network to see progressive load.

## Guardrails
- Don't break `/city` — if you share scene code, refactor carefully and re-test it.
- No fabricated citizens to fill the scene; empty is honest.
- Push to `threews` only; changelog: the new page's `added` date in `data/pages.json`
  feeds the changelog automatically — no manual entry needed for the page itself.
