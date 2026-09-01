# Feature 11: live event ops (broadcast, stage moments, event config)

Tomorrow the $THREE world hosts a live event. The countdown already exists (`src/game/event-countdown.js` reads `public/event.json` through the shared `src/shared/event-config.js` reader and mounts a lobby banner + in-world pill). The live layer has since shipped in two of its three parts: the operator can speak to everyone in the world at once (`/internal/announce` + `scripts/announce-play.mjs`), and the world reacts when the event goes live (`src/game/meetup-event.js` agenda beats, go-live banner, and `src/game/fireworks.js`; the walkthrough is [docs/play-live-events.md](../play-live-events.md)). What is still missing is item 3, changing the event config without a redeploy. The list below records what exists so a rerun builds only the gap.

## Where the code lives

- Event config + countdown: `public/event.json`, `src/game/event-countdown.js` (self-attaching, zero edits to the core modules; keep that pattern). The same file is read by the home strip (`src/home-event-banner.js`), the API (`api/_lib/event-config.js`, from disk, cached a minute) and the game server (`multiplayer/src/event-window.js`, polled over HTTP every minute). Between events it holds an explicit no-event state (`id: null`) so `/event.json` still answers 200; edit it only through `npm run event:schedule -- --start <ISO> --duration <minutes> --apply` (`--rehearse 10` for a local dry run, `--clear` to reset) and gate the deploy on `npm run check:event`
- Multiplayer server (in-repo): `multiplayer/src/rooms/WalkRoom.js`, `multiplayer/src/social-hub.js`, the announce webhook in `multiplayer/src/index.js`; client socket + event bus: `src/game/community-net.js`
- In-world screens for takeover moments: `src/game/x402-jumbotron.js`, `src/game/chart-screen.js`
- Celebration FX precedent: the reaction-bar confetti in `src/game/coincommunities-ui.js`
- Admin/API patterns: look at existing authed admin endpoints under `api/` before inventing a new auth scheme

## What to build

1. **Operator broadcast.** Shipped as `POST /internal/announce` on the multiplayer server (`multiplayer/src/index.js`): HMAC-signed with `MULTIPLAYER_SHARED_SECRET` (falling back to `HOLDER_PASS_SECRET`) and timestamp-bound, so an unsigned or stale call is rejected before it reaches a room; there is no separate rate limit, the signature is the gate. It broadcasts on the existing `notice` channel (`kind: 'event'`, text capped at 300 characters, optional `title` 80 and `detail` 200, `durationMs` capped at 120 s) to every live `walk_world` room or one coin's world, so older clients get a toast and newer ones the centre-screen banner. Verify the banner queues, dismisses, and never overlaps chat or the joystick.
2. **Go-live moment.** Shipped in `src/game/meetup-event.js` (agenda, go-live banner) and `src/game/fireworks.js`, on the countdown pill's pulsing LIVE state. Everything reads the one config and mounts nothing when there is no event; keep it that way.
3. **Event config hardening.** Still open. `event.json` is baked into the image at build time, which means a config change mid-event needs a redeploy (today: `npm run event:schedule -- ... --apply`, `npm run check:event`, then the deploy runbook). Add a small authed read path (for example an `app_settings`-backed override checked after the static file, in `api/_lib/event-config.js` and `multiplayer/src/event-window.js` alike, since both read the file independently) so the operator can extend, rename, or end the event live without a deploy. Document the exact curl in the runbook (`10-event-day-runbook.md`).
4. **Broadcast script.** Shipped as `scripts/announce-play.mjs` (`node scripts/announce-play.mjs --title "Wheel hour" --detail "..." --coin <mint> --duration-ms 30000 "message"`; `--server http://localhost:2567` for a local test). It prints how many rooms and players it reached; the operator copy is in [LIVE-OPS.md](LIVE-OPS.md).

## Verify

- Two browser windows on `npm run dev` joined to the same coin world: a broadcast reaches both within a second; the banner queues, dismisses, and never overlaps the chat panel or mobile joystick.
- `event.json` state transitions (upcoming, live, over) exercised by editing the local file; nothing mounts when it is absent.
- `npm test` green; the broadcast endpoint's unsigned-call refusal is covered in `tests/multiplayer-server-boot.test.js`; add tests for the config override's auth.

## Report format

What shipped (files + one line each), the exact operator commands for event day, and anything deliberately deferred with a one-line reason. Add the `data/changelog.json` entry (feature tag) and a row in `STRUCTURE.md` for the live-ops surface.
