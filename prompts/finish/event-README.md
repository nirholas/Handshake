# event/ · $THREE Community Day (window 2026-08-09 17:00 to 19:30 UTC)

Work-order pack for the first live community event held in the `/play` world. Each numbered file is a self-contained paste-and-run prompt per the [prompts/ standard](../README.md); [00-CONTEXT.md](event-00-CONTEXT.md) carries the shared facts and MUST be read first by every order.

The event is over and `public/event.json` is back to its explicit no-event state. Six of the eight orders are retired (their files remain readable in git history). Two polish orders are left, and neither is blocked on anything but a quiet machine.

**What actually happened, established 2026-09-02 and written up in [PROGRESS.md](event-PROGRESS.md):** the API and frontend shipped the event build ahead of the window, so the countdown, the `/event` page and the in-world meetup layer (agenda, go-live moments, fireworks) ran. The `three-ws-multiplayer` service was never redeployed, so the quest line, the leaderboard and the souvenir grant were absent from the running process. Nothing was granted, no standing ever existed, and there is nothing to settle. All of that code is live on production today and is waiting on the next `public/event.json` window.

| Order | What it ships | State (measured 2026-09-02) |
|---|---|---|
| 01 event countdown | Real event times, countdown on `/play` and the home page | Retired: `src/game/event-countdown.js`, `src/home-event-banner.js`, changelog 2026-08-07 |
| [02-play-polish-sweep.md](event-02-play-polish-sweep.md) | In-world UI/UX defect sweep of `/play`: states, a11y, mobile, copy | Open, rewritten to its remainder. The lobby half is verified twice over and off limits. The world boots headless here after all, and `scripts/play-journey-audit.mjs` reaches every surface, so what is left is one run on a quiet box: the order now carries the load-average precondition and the two harness readings that are noise. |
| 03 event landing page | `/event` with countdown, schedule, .ics, live headcount | Retired: `pages/event.html`, `src/event-page.js`, `api/play/population.js`, changelog 2026-08-08 |
| 04 event quests + leaderboard | Server-authoritative event jobs and a live ranking | Retired: `multiplayer/src/event-window.js`, `event-leaderboard.js`, `api/play/event-leaderboard.js`, 42 tests, changelog 2026-08-08 |
| 05 event cosmetic drop | Free commemorative wearable granted during the window | Retired: `multiplayer/src/event-drop.js`, `public/accessories/laurel-meetup.glb`, `docs/event-souvenirs.md`, changelog 2026-08-08. Shipped as code; never reached a player, see above. |
| [06-photo-mode-share.md](event-06-photo-mode-share.md) | Photo mode with a branded share card: capture, preview, download, copy | Open and under active work by another agent as of 2026-09-02 19:25Z (retake fix, unit tests, a check script, an e2e through the real capture path). What remains is that agent's: the cross-engine verification and the `data/changelog.json` entry, which is still absent. |
| 07 preflight verification | The event-eve go/no-go sweep | Retired: ran 2026-08-08, recorded NO-GO with per-stage evidence in [PROGRESS.md](event-PROGRESS.md) and `docs/event-readiness/LIVE-OPS.md` |
| 08 event closeout | What ran, what was granted, recap, retire the pack | Retired 2026-09-02. The closeout is the 2026-09-02 entry in [PROGRESS.md](event-PROGRESS.md); no community recap was written and that is deliberate, since nothing was granted and attendance is unknowable. Its two blocked cloud reads are OWNER-ACTIONS rows 13 and 15, and the live defect it found (`MULTIPLAYER_INTERNAL_URL` unset, so the live headcount shows no number) is row 18. |

Run order now: 02 and 06 in either order, though 06 has an agent on it. **When both retire, the pack retires with them:** delete this directory and record it in [../README.md](../README.md) the way retired campaigns are recorded there. Nothing else in the pack is waiting on anyone.
