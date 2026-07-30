# The Story So Far: the 3D history timeline

`/timeline` tells three.ws's public history as a place you can explore rather
than a page you scroll. Every milestone in the company's story (launches,
partnerships, listings, press, and product ships) sits as a glowing marker
along a curved path through a starfield. You can orbit the whole scene in
360°, walk the path end to end behind an animated guide, or jump around from
a synced scrubber at the bottom. All of it is driven by one static data file,
[`data/timeline.json`](../data/timeline.json); beyond that single fetch,
everything runs client-side in [`src/timeline.js`](../src/timeline.js).

## What it shows

- **The path.** Milestones are laid out chronologically along a gentle
  S-curve (a Catmull-Rom spline, re-parametrized by arc length so marker
  spacing and walk speed stay even through the turns), 6.4 m apart, over a
  dim ground plane and a ~1,400-point starfield.
- **Markers.** Each event is a small faceted sphere colored by its category.
  Its size, and the height of the translucent light beam rising from it,
  scale with the event's `importance` (1 to 5), so the big moments read as
  big from across the scene. A floating label above each beam shows the
  event's title and date.
- **Categories.** The data file defines six (Launch, Partnership, Milestone,
  Listing, Press, Product), each with its own color. The colors carry through
  the markers, the scrubber ticks, the filter chips, and the detail panel
  badge.
- **The guide.** The site's default rigged avatar (`/avatars/default.glb`,
  served from [`public/avatars/`](../public/avatars)) stands on the path at
  tour-guide scale, playing the idle clip from the shared animation library
  ([`src/animation-manager.js`](../src/animation-manager.js) plus the
  manifest at [`public/animations/manifest.json`](../public/animations/manifest.json)).
  In Walk mode it leads the way. If the avatar or manifest fails to load, the
  timeline simply continues without a visible guide; it never breaks the
  scene.
- **The detail panel.** Selecting any milestone opens a side panel (a bottom
  sheet on mobile) with the category badge, date, title, plain-language
  summary, a "Read the source" link when the event has one, and a
  "Milestone i of N" counter.

## How to navigate

Two modes, switched from the pill bar at the top:

- **360° Orbit** (the default). Drag to look around; the camera orbits with
  damping, auto-rotating slowly until your first drag (auto-rotate is off
  entirely under `prefers-reduced-motion`). Zoom is clamped between 4 m and
  60 m and the camera cannot dip below the ground. Click or tap any marker to
  select it: the camera glides its orbit point over to that marker while
  preserving your current viewing angle, so you are never yanked out of a
  free look.
- **Walk the path.** A chase camera sits just above and behind the current
  point on the path, looking down the path ahead, and eases from milestone to
  milestone (about 0.95 s per move). The guide avatar walks the path in front
  of the camera, always facing forward along the curve.

Around both modes:

- **Scrubber** (bottom bar): one tick per milestone, colored by category.
  Click a tick to jump straight to that event; the active tick lifts,
  auto-scrolls into view, and the label above reads "n / N · date".
- **Prev / next** (the ‹ and › buttons) step through milestones. Stepping
  wraps around at either end and skips any category you have filtered out.
- **Auto-play** (▶) runs the tour: it switches to Walk mode and advances one
  milestone every 2.6 s (0.9 s under reduced motion), stopping on its own at
  the last visible milestone. Dragging the scene, clicking a tick, stepping,
  or pressing an arrow key pauses it.
- **Keyboard**: Arrow Right / Arrow Left step, Space toggles auto-play,
  Escape closes the detail panel.
- **Category filter chips** (top bar) toggle each category. Filtered-out
  categories dim to near-invisible in the scene and in the scrubber, their
  markers stop responding to clicks, and stepping and auto-play skip them.

## Fallbacks and states

- **No WebGL**: the exact same events render as a plain, accessible,
  chronological list (date, title, summary, source link), with a one-line
  note explaining why the 3D scene is not showing.
- **Reduced motion**: no auto-rotate, camera moves become effectively
  instant, and auto-play steps briskly instead of gliding.
- **Loading and errors**: a spinner while the data loads; a failed fetch
  shows a designed error state with a Retry button.

## Adding a milestone

Append an object to the `events` array in
[`data/timeline.json`](../data/timeline.json), keeping the array in
chronological order (markers are laid out in array order, not re-sorted).
There is no build step: the file is fetched at runtime from
`/data/timeline.json`.

```json
{
	"id": "2026-07-25-openai-select-partner",
	"date": "2026-07-25",
	"title": "Named an OpenAI Select Partner",
	"category": "partnership",
	"summary": "One or two plain-language sentences shown in the detail panel and the accessible fallback list.",
	"source_url": "https://three.ws/openai",
	"importance": 3
}
```

Field by field, as consumed by [`src/timeline.js`](../src/timeline.js):

| Field | Rules |
| --- | --- |
| `id` | Unique slug; the convention is date-prefixed (`YYYY-MM-DD-short-name`). |
| `date` | `YYYY-MM-DD`. Displayed verbatim in the label, the panel, the scrubber, and the fallback list. |
| `title` | Keep it short: the floating 3D label truncates past 42 characters. |
| `category` | Must be a key of the top-level `categories` map. It drives the marker color, the panel badge, and which filter chip controls the event. A key missing from the map renders permanently dimmed and unclickable, so if you introduce a new category, add it to `categories` (with a `label` and a `color`) in the same change; the chip appears automatically. |
| `summary` | Plain text, one or two sentences. Rendered escaped in the panel and fallback list. |
| `source_url` | A fetchable third-party URL, or `null` when the only source is the X post history. `null` hides the "Read the source" link. |
| `importance` | Integer 1 to 5. Scales the marker size and beam height; it has no other effect. |

## Code map

| Piece | Location |
| --- | --- |
| Page shell (header, boot spinner, fallback styles) | [`pages/timeline.html`](../pages/timeline.html) |
| Scene, controls, UI, fallback rendering | [`src/timeline.js`](../src/timeline.js) |
| Milestone data | [`data/timeline.json`](../data/timeline.json) |
| Guide avatar + animation runtime | [`public/avatars/default.glb`](../public/avatars/default.glb), [`src/animation-manager.js`](../src/animation-manager.js), [`public/animations/manifest.json`](../public/animations/manifest.json) |

Routing: `vercel.json` rewrites `/timeline` to the page in production (the
server reads that route table on boot).
