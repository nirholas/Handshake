# event/ · $THREE Community Day (2026-08-08)

Work-order pack for the live community event held in the `/play` world on 2026-08-08. Each numbered file is a self-contained paste-and-run prompt per the [prompts/ standard](../README.md); [00-CONTEXT.md](00-CONTEXT.md) carries the shared facts and MUST be read first by every order.

| Order | What it ships | Status source |
|---|---|---|
| [01-event-countdown.md](01-event-countdown.md) | Real event times in `public/event.json`, countdown verified on `/play` (lobby banner + in-world pill), extended to the home page | Step 0 of the order |
| [02-play-polish-sweep.md](02-play-polish-sweep.md) | Full UI/UX defect sweep of the `/play` journey: states, a11y, mobile, copy, perceived speed | Step 0 of the order |
| [03-event-landing-page.md](03-event-landing-page.md) | `/event` public landing page: countdown, newcomer guide, local-time schedule + .ics, live section | Step 0 of the order |
| [04-event-quests-leaderboard.md](04-event-quests-leaderboard.md) | Server-authoritative event quest line on the jobs board + live leaderboard (in-world panel + API) | Step 0 of the order |
| [05-event-cosmetic-drop.md](05-event-cosmetic-drop.md) | Free commemorative wearable auto-granted to every attendee during the window | Step 0 of the order |
| [06-photo-mode-share.md](06-photo-mode-share.md) | Photo mode with a branded share card: capture, preview, download, copy | Step 0 of the order |
| [07-preflight-verification.md](07-preflight-verification.md) | The event-eve go/no-go sweep: tests, gates, local + production audits, deploy staged to one owner command. Run LAST | Step 0 of the order |

Run order: 01 first (the times feed everything), 02 through 06 in any order as time allows (listed by value), 07 strictly last. Status lives in each order's step 0 and in [PROGRESS.md](PROGRESS.md), never in this table.

Already shipped before this pack existed: the countdown feature itself ([src/game/event-countdown.js](../../src/game/event-countdown.js) reading [public/event.json](../../public/event.json), wired into [pages/play.html](../../pages/play.html)); order 01 verifies it against the real event window rather than building it.
