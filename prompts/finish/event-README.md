# event/ · $THREE Community Day (window 2026-08-09 17:00 to 19:30 UTC)

Work-order pack for the first live community event held in the `/play` world. Each numbered file is a self-contained paste-and-run prompt per the [prompts/ standard](../README.md); [00-CONTEXT.md](event-00-CONTEXT.md) carries the shared facts and MUST be read first by every order.

The event is over and `public/event.json` is back to its explicit no-event state. Five of the eight orders were verified shipped on 2026-09-01 and retired (their files remain readable in git history); what is left is the closeout and two polish orders that were never formally run.

| Order | What it ships | State (measured 2026-09-01) |
|---|---|---|
| 01 event countdown | Real event times, countdown on `/play` and the home page | Retired: `src/game/event-countdown.js`, `src/home-event-banner.js`, changelog 2026-08-07 |
| [02-play-polish-sweep.md](event-02-play-polish-sweep.md) | Full UI/UX defect sweep of the `/play` journey: states, a11y, mobile, copy, perceived speed | Open. The lobby half was verified by the preflight (0 focus rings missing at 130/91 tab stops); the in-world half (store, bank, wheel, jobs, friends, emotes) was never walked and no defect list was produced. |
| 03 event landing page | `/event` with countdown, schedule, .ics, live headcount | Retired: `pages/event.html`, `src/event-page.js`, `api/play/population.js`, changelog 2026-08-08 |
| 04 event quests + leaderboard | Server-authoritative event jobs and a live ranking | Retired: `multiplayer/src/event-window.js`, `event-leaderboard.js`, `api/play/event-leaderboard.js`, 42 tests, changelog 2026-08-08 |
| 05 event cosmetic drop | Free commemorative wearable granted during the window | Retired: `multiplayer/src/event-drop.js`, `public/accessories/laurel-meetup.glb`, `docs/event-souvenirs.md`, changelog 2026-08-08 |
| [06-photo-mode-share.md](event-06-photo-mode-share.md) | Photo mode with a branded share card: capture, preview, download, copy | Open. Built (`src/game/photo-mode.js`, HUD button, P key) but never verified on both render engines and never announced: no `data/changelog.json` entry exists. |
| 07 preflight verification | The event-eve go/no-go sweep | Retired: ran 2026-08-08, recorded NO-GO with per-stage evidence in [PROGRESS.md](event-PROGRESS.md) and `docs/event-readiness/LIVE-OPS.md` |
| [08-event-closeout.md](event-08-event-closeout.md) | The honest closeout: what ran, what was granted, recap, retire the pack | Open, rewritten to its remainder. The leaderboard's Redis record expired about 2026-08-16, so the standings can no longer be exported; the log-derived facts still can, until roughly 2026-09-08. |

Run order now: 08 first (its log reads have a deadline), then 02 and 06 in either order. When all three retire, the pack retires with them: delete this directory and record it in [../README.md](../README.md) the way retired campaigns are recorded there.
