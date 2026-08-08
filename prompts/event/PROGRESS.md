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

## 2026-08-08 · Order 04 · Event quest line + live leaderboard shipped

**Shipped.** Four event-only jobs on the /play jobs board, gated server-side on the same `public/event.json` window every countdown surface reads, and a durable ranking of who runs the most of them.

- **The gate.** `multiplayer/src/event-window.js` reads `/event.json` over HTTP (the game container ships without `public/`), parses it with the client's own shape and its "missing end means six hours" default, caches it for a minute, and **fails closed**: a missing, unreachable or malformed config means there is no event. `multiplayer/src/quests.js` applies the gate inside `canAccept` / `boardOffers` / `acceptMission`, and `pruneClosedEventRuns` drops a run left over when the window shuts so no tracker holds a job that can never finish or pay. The context defaults to closed, so a caller that forgets to pass it gets the safe answer.
- **The quest line** (all repeatable, so the standing is a real race): `event-plaza-catch` (land 8 fish), `event-supply-run` (drive North Depot to East Depot, both legs vehicle-gated), `event-wilds-patrol` (defeat 4 foes in the Southern Wilds), `event-landmark-tour` (the totem, the wheel, the trading screen). The tour's three zones were added to `quest-zones.js` sited on the landmarks the event agenda already sends people to.
- **A new objective type, `defeat`.** Emitted by the real combat handler on a mob kill (`multiplayer/src/combat-handlers.js`), carrying the danger zone derived from the MOB's authoritative position, so a zone-pinned bounty can only be filled where it was posted.
- **The leaderboard.** Ranking math is pure and shared (`multiplayer/src/event-leaderboard.js`): completions, then event gold, then the earlier finisher, then a stable id. Storage is a Redis hash per event with an in-memory fallback and a one-week TTL (`api/_lib/event-leaderboard-store.js`), written only by the game server through `POST /api/internal/event-score` (world-service token, refuses any run reported outside the configured window) and read by `GET /api/play/event-leaderboard`. Account keys never cross the wire, only rank, name and score.
- **Two surfaces, one ranking.** The in-world panel is a third tab on the jobs board (`src/game/quests-ui.js`), which proxies the same public read through the room (`eventBoardReq`) so the client never has to know an identity. The tab only appears while the event is live or a standing still exists, and it has four designed states: skeleton rows while the first read is in flight, "no event runs yet, be the first", the ranking with your own row pinned, and an error state whose Retry actually re-requests.
- **No prize is ever paid by code.** The panel and the endpoint both say the winners are announced from the board and settled by the team afterwards. Nothing in the diff touches a wallet or a chain.

**Evidence.**

- **Window closed:** joined the real WalkRoom over the wire with the shipped config. Server reported `eventLive: false`, the board carried no event jobs, and accepting one was refused with "That job only runs during the live event."
- **Window live** (`public/event.json` temporarily moved to now, restored byte-identical afterwards, sha256 `da152b1b…` before and after): the board offered all four event jobs; walking the Grand Tour's three landmarks completed it server-side and paid `{"reward":{"gold":220},"event":true}`; the room pushed `{"runs":1,"cash":220,"eventId":"three-first-meetup"}`; and the in-world board read came back with the player's own row pinned at rank 1.
- **Two runners ranked.** `curl -s 'http://localhost:8080/api/play/event-leaderboard'` returned Alpha at rank 1 and Bravo at rank 2 on identical runs and cash, ordered by the earlier `lastAt` exactly as the tiebreak specifies.
- **A real bug the live run caught:** every row came back `lastAt: 0`, because `| 0` truncates to 32 bits and an epoch-millisecond stamp is far past 2^31, silently killing the tiebreak. Fixed with a `nonNegInt` helper and pinned by a regression case using a real `Date.UTC` stamp.
- **Panel states in Chromium** against the real dev server, fed the exact payloads the live stack produced: event tab appears while live and hides when the window closes, EVENT badges only on event rows, 5 skeleton rows while loading, the empty-state copy, 10 ranked rows with `#17 You · 2 runs · 440` pinned below them, the prize note present, and Retry re-requesting the board (2 to 3 requests) and returning to the loading state. No console errors from this code (only Vite's HMR websocket, a Codespaces dev artifact).
- `npm run check:rules -- --paths <the 16 files>` passes. `tests/event-quests.test.js` (24 cases) and `tests/event-leaderboard.test.js` (18 cases) pass.

**Remains.** The gate and the payouts run on the multiplayer server, so the quest line only appears once that server and the API are redeployed; both deploys are owner-gated. Until then `/api/play/event-leaderboard` answers with an empty board, which is its designed empty state.

**Not mine, observed in passing.** The full /play world would not boot headless on this box (the 3D join hangs before any panel code runs, with four agents and a restarting Vite on one machine), which is why the panel was verified as a real-browser render against the live payloads rather than by driving the 3D client. Every file above was swept into other agents' commits (`57c8bc1c4`, `015a08513`, and later) by their `git add -A` runs before I could stage them; content verified intact at HEAD. A repo-wide em-dash removal pass by another agent rewrote comments in these files mid-session and left one heist comment parsing as commented-out code, which `check:rules` flagged and I reworded.
