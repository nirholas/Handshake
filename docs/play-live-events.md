# Live events in `/play`

A live event turns the `$THREE` home town from a world you can visit into a
place something is *happening* in: a countdown you can see from anywhere in the
plaza, an agenda that tells you what is on right now and what is next, a banner
when each segment starts, and a synchronized fireworks show everyone watches
together.

Everything below is driven by one file, `public/event.json`.
Create it, redeploy, and the event exists. Delete it and the world goes back to
normal with no code change and no dead pixels.

**The repo ships without that file, and that is the resting state.** No event is
scheduled right now, so `/event.json` answers 404, every surface below mounts
nothing, and the world runs as a plain world. Scheduling an event means writing
the file; ending one means deleting it again. Nothing in this document is live
until that file exists.

- **Surface:** `/play`, in the `$THREE` home town only (`isHomeTown()`).
- **Modules:** [`src/game/meetup-event.js`](../src/game/meetup-event.js) (the view),
  [`src/game/meetup-schedule.js`](../src/game/meetup-schedule.js) (pure schedule
  math), [`src/game/fireworks.js`](../src/game/fireworks.js) (the particle show),
  [`src/game/meetup-event.css`](../src/game/meetup-event.css) (styles).
- **Tests:** [`tests/meetup-schedule.test.js`](../tests/meetup-schedule.test.js),
  [`tests/meetup-event-ui.test.js`](../tests/meetup-event-ui.test.js).
- **Browser audit:** `npm run audit:meetup`.

---

## Configuring an event

`public/event.json` is the single source of truth. The same file feeds the lobby
banner and wayfinding pill ([`src/game/event-countdown.js`](../src/game/event-countdown.js)),
this in-world layer, and the server-side souvenir grant, so those three can never
disagree about when the event is.

Write it to schedule an event. There is no file in the repo to edit, so start
from the shape below:

```json
{
  "id": "three-first-meetup",
  "name": "$THREE First Holders Meetup",
  "tagline": "The first live gathering in the three.ws world.",
  "startsAt": "2026-08-09T17:00:00Z",
  "endsAt": "2026-08-09T19:30:00Z",
  "link": "/play?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&name=three.ws&symbol=three",
  "linkLabel": "Join the $THREE world",
  "souvenir": { "cosmeticId": "laurel-meetup" },
  "agenda": [
    { "atMin": 0,   "title": "Doors open in the plaza", "detail": "Say hi in chat", "icon": "👋" },
    { "atMin": 20,  "title": "King of the Totem showdown", "detail": "Hold the gold ring", "icon": "👑" },
    { "atMin": 105, "title": "Fireworks finale", "detail": "Look up", "icon": "🎆" }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Seeds the deterministic fireworks show. Change it and every client gets a different (but still shared) sky. |
| `name` / `tagline` | Shown on the chip, the agenda drawer, and the photo stamp. |
| `startsAt` / `endsAt` | ISO-8601 UTC. A missing or inverted `endsAt` defaults to six hours after the start. |
| `agenda[].atMin` | Minutes after `startsAt`. Order does not matter; segments are sorted. Invalid or untitled entries are dropped rather than breaking the event. |
| `agenda[].icon` | One emoji. Used on the segment row and its moment banner. |
| `souvenir.cosmeticId` | Optional. A free commemorative wearable granted once to everyone who joins the world named by `link` while the event is live, kept forever, never granted again after `endsAt`. Must be a `tier: 'event'` cosmetic; anything else grants nothing. See [Event souvenirs](event-souvenirs.md). |

`id`, `agenda`, and `tagline` are optional: an event with none of them still runs
its countdown, its go-live moment, and its fireworks.

## What a player sees

The layer walks six phases, all derived from the wall clock by
`eventState()` so two people standing in the plaza always agree on which one
they are in.

| Phase | When | What shows |
|---|---|---|
| `far` | more than 24 h out | nothing |
| `upcoming` | within 24 h | chip: "Starts in 6h 12m", tappable for the agenda |
| `preshow` | final 30 min | chip glows gold; a toast tells the player to stick around |
| `live` | between start and end | chip reads LIVE with the next segment's countdown; agenda marks the running segment; moment banners fire; fireworks run |
| `afterglow` | 20 min after the end | chip invites a commemorative photo |
| `ended` | after that | the layer tears itself down completely |

The chip docks itself under the King of the Totem card when that card is up, so
the two never overlap, and it hides under zen mode (`Z`) with every other
overlay. While it is mounted, the generic countdown pill stands down: one
countdown on screen at a time.

## The fireworks show

Fireworks are **deterministic, not networked**. Time is cut into four-second
buckets; each bucket is hashed with the event `id` into the same launch plan on
every machine (`fireworkPlan()`), so the whole plaza watches one synchronized
sky without a single packet. This is the same trick the shared day/night clock
([`src/shared/world-clock.js`](../src/shared/world-clock.js)) uses for the sun.

Density scales with the moment: sparse through the event, ramping into a
barrage over the closing fifteen minutes, plus one-off volleys on the go-live
moment and each segment change. Power-saver mode halves it, no more than 14
shells are ever alive at once, and a backgrounded tab never replays the backlog
it missed while `requestAnimationFrame` was paused.

## The agenda drawer

Tapping the chip opens a right-docked drawer with the full agenda (past segments
dimmed, the running one highlighted, future ones counting down in local time),
a live `$THREE` pulse row (price, 24 h change, market cap from
`/api/three-signal`, hidden entirely if that data is unavailable), a
commemorative photo action, and a Buy `$THREE` button that opens `/play`'s
existing on-chain trade widget. `Escape` closes it.

## Previewing without waiting

Add `?meetup=now` to the `/play` URL to shift the configured event to start
twenty seconds from load, keeping its duration and agenda. `?meetup=<ISO>`
shifts it to a specific instant instead. This runs through
`applyPreviewOverride()`, which every surface that reads the event shares, so a
preview never drifts from the real thing.

It shifts a configured event; it does not invent one. With no `public/event.json`
present, `?meetup=now` has nothing to move and the world loads as usual, so write
the file first.

```
http://localhost:3000/play?coin=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&name=three.ws&symbol=three&meetup=now
```

## Verifying before an event

The audit drives the real layer through a real browser, so it needs a
`public/event.json` in place before you run it (see the note under Previewing).

```bash
npm run dev            # terminal 1: vite on :3000
npm run dev:walk-all   # terminal 2: the Colyseus world server on :2567
npm run audit:meetup   # terminal 3: drives a real browser through the whole layer
```

The audit enters the home town with `?meetup=now` and asserts the chip mounts
and counts down, the generic pill stands down, the chip clears the totem card,
the agenda opens with every segment, `Escape` closes it, the chip flips to LIVE
at the start instant, the go-live banner fires, fireworks reach the scene, zen
mode hides everything, the photo action opens photo mode, and the chip still
fits at 390 px. Screenshots land in `.meetup-audit/` (gitignored). Exit code 0
means every check passed.

Point it at another origin with `--base https://three.ws`.

## Extending it

- **A different world.** The home-town gate is one call (`isHomeTown()`) in
  `meetup-event.js`'s frame loop. Widen it to run an event in any coin world.
- **More agenda segments.** Config only; no code change.
- **A new moment type.** `_moment(icon, title, sub)` paints the gold banner;
  call it from wherever the new trigger lives.
- **Reusing the schedule elsewhere.** `meetup-schedule.js` imports neither the
  DOM nor three.js, so a landing page or jumbotron can render the same countdown
  from the same config.
