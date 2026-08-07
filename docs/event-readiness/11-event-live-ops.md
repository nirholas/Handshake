# Feature 11: live event ops (broadcast, stage moments, event config)

Tomorrow the $THREE world hosts a live event. The countdown already exists (`src/game/event-countdown.js` reads `public/event.json` and mounts a lobby banner + in-world pill). What is missing is the live layer: a way for the operator to speak to everyone in the world at once, and for the world to visibly react when the event goes live. Build it end to end.

## Where the code lives

- Event config + countdown: `public/event.json`, `src/game/event-countdown.js` (self-attaching, zero edits to the core modules; keep that pattern)
- Multiplayer server (in-repo): `multiplayer/src/rooms/WalkRoom.js`, `multiplayer/src/social-hub.js`; client socket + event bus: `src/game/community-net.js`
- In-world screens for takeover moments: `src/game/x402-jumbotron.js`, `src/game/chart-screen.js`
- Celebration FX precedent: the reaction-bar confetti in `src/game/coincommunities-ui.js`
- Admin/API patterns: look at existing authed admin endpoints under `api/` before inventing a new auth scheme

## What to build

1. **Operator broadcast.** An authed API endpoint (follow the repo's existing admin-auth pattern; never an open endpoint) that pushes an announcement through the Colyseus room to every connected player in a given coin world (or all worlds). Client side: a distinct, high-visibility announcement banner in the HUD, auto-dismissing, queued if several arrive. Server-side rate limit so a bad script cannot spam every player.
2. **Go-live moment.** When `event.json` flips to live (the countdown module already computes the state), the world marks it: jumbotron takeover with the event name, a one-shot celebration burst, and the countdown pill switching to its pulsing LIVE state. All of it must degrade to nothing when there is no event.
3. **Event config hardening.** `event.json` is baked into the image at build time, which means a config change mid-event needs a redeploy. Add a small authed read path (for example an `app_settings`-backed override checked after the static file) so the operator can extend, rename, or end the event live without a deploy. Document the exact curl in the runbook (`10-event-day-runbook.md`).
4. **Broadcast script.** A `scripts/` helper the operator runs from this workspace: takes a message, calls the endpoint, prints how many players received it.

## Verify

- Two browser windows on `npm run dev` joined to the same coin world: a broadcast reaches both within a second; the banner queues, dismisses, and never overlaps the chat panel or mobile joystick.
- `event.json` state transitions (upcoming, live, over) exercised by editing the local file; nothing mounts when it is absent.
- `npm test` green; add tests for the broadcast endpoint's auth and rate limit.

## Report format

What shipped (files + one line each), the exact operator commands for event day, and anything deliberately deferred with a one-line reason. Add the `data/changelog.json` entry (feature tag) and a row in `STRUCTURE.md` for the live-ops surface.
