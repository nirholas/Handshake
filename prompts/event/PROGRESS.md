# event/ progress log

Cross-chat handoff log for the $THREE Community Day pack. Append an entry when you finish (or partially finish) an order: date, order, what shipped with commit SHAs, what remains, evidence (commands run, what they printed).

## 2026-08-07 · Pack created; countdown feature shipped

- Built and wired the countdown feature itself (outside any order, as the pack was authored): `src/game/event-countdown.js` self-attaching module + `public/event.json` config + script tag in `pages/play.html`. Lobby banner and in-world pill, three explicit states, dismissal persisted per event, reduced-motion respected, monochrome tokens.
- The configured window (2026-08-08 17:00 to 21:00 UTC) is an agent-chosen default, NOT owner-confirmed. Order 01 step 1 owns replacing it.
- All seven orders authored against the repo state of 2026-08-07; every order re-derives state in step 0, so later drift is survivable.

## 2026-08-08 · Order 03 · /event landing page shipped, with a real live headcount

**Shipped.** `https://three.ws/event` is live in the repo and builds into `dist/`.

- `pages/event.html` + `src/event-page.js`: hero countdown, one large CTA into the event world, a "what to expect" section written only from what `/play` actually does, the run of show in the visitor's own timezone, and an "Add to calendar" button that builds a real RFC 5545 `.ics` in the browser (no third-party calendar service). Four designed states: upcoming, live, ended, and no-config.
- **One source of truth for the times.** The page fetches `/event.json` at runtime and parses it with the same shape and the same six-hour end-time fallback as `src/game/event-countdown.js`. No date, time, or duration is written into `pages/event.html` or `src/event-page.js`. `grep -rn "2026-08" pages/event.html src/event-page.js` returns nothing.
- **The live panel is real, and it had to be built.** The lobby coin grid's `LIVE` chip is a static badge and the in-world `N online` figure comes off the Colyseus socket (`remotes.size`), so no presence endpoint existed to reuse. Added `GET /population` to the multiplayer server (`multiplayer/src/index.js`), reading `matchMaker.query()` so it counts every instance under horizontal scaling, and `GET /api/play/population` (`api/play/population.js`) which proxies it server-side. Only a count crosses the boundary. Documented in `docs/api-reference.md` under "Play Population API".
- **The number is real or absent.** When the multiplayer server is unreachable the panel keeps the live state and drops the count ("The doors are open") instead of inventing one.

**Evidence.**

- End-to-end live count, real Colyseus rooms: booted the multiplayer server locally, joined four `walk_world` clients on the $THREE mint, and read the chain through the real API handler. `GET /population` returned `{"ok":true,"coin":"FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump","rooms":1,"players":3}` with three joined and `{"rooms":0,"players":0}` after they left; a different mint returned `0`. Through `api/play/population.js`: `{"ok":true,"coin":"FeMb…pump","players":4,"rooms":1}`. In the browser the page rendered "4 people are in the world right now".
- Three states driven in Chromium at 1440, 375 and 320, dark and light: upcoming ticks `1 day 02:04:48`; live shows `LIVE` + `01:12:49 left to join` with the agenda row marked `now`; ended reads "This event has ended", relabels the agenda to "What happened", collapses the clock and keeps the CTA at "Enter the world anyway". No horizontal scroll at any width. The only console errors are Vite's HMR websocket (a Codespaces dev artifact) and `/api/auth/me` + `/api/three/access` 404s from the shared nav against the local API harness.
- `.ics` inspected byte for byte: CRLF line endings, RFC 5545 folding with a leading space on continuations, escaped commas, `DTSTART:20260808T114531Z` / `DTEND:20260808T134031Z`, `UID:three-first-meetup@three.ws`.
- Keyboard: the shared nav skip link resolves to this page's `<main>`, and one Tab after it lands on the CTA.
- `npm run build:pages` regenerated the feeds; `npm run build` emitted `dist/event.html`; `npm run check:pages` now passes `/event`.

**Remains.** `GET /population` only answers once the multiplayer server is redeployed; until then `/api/play/population` returns `{"ok":false,"reason":"unavailable"}` and the page degrades as designed. Multiplayer and production deploys are owner-gated.

**Not mine, observed in passing.** `npm run check:pages` still reports `/play/war` as unbuilt (declared in `data/pages.json`, no vite input yet), and every file listed above was swept into other agents' commits by their `git add -A` runs before I could stage them; content verified intact at HEAD.
