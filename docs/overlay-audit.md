# The overlay audit

`npm run audit:overlays` drives a real browser over real pages and proves that no
floating widget covers another.

## Why this exists

three.ws has a lot of persistent, viewport-anchored UI. The Walk Companion. The
corner stack, with its "Getting started" pill, feature-discovery prompt and
language switcher. Sticky headers, CTA rails, chat launchers, the command
palette. Every one of them is correct on its own.

They are only wrong together, and only sometimes. A collision needs the right
page, the right viewport, and the right combination of widgets to be switched on
at the same time. That is a state no unit test reaches and neither widget's
author ever sees. So these bugs shipped, were found by a person squinting at a
screenshot, and were fixed with a magic offset that the next widget then broke.

The audit replaces the squinting. It finds every painted `position: fixed` or
`position: sticky` overlay on a page, intersects them pairwise, and reports the
ones that hide each other, with a screenshot of the offence.

## Running it

```bash
npm run audit:overlays                                   # curated routes, 3 viewports
npm run audit:overlays -- --all                          # every public HTML route
npm run audit:overlays -- --routes /,/examples,/docs
npm run audit:overlays -- --base https://three.ws        # audit production
npm run audit:overlays -- --viewport mobile
npm run audit:overlays -- --json                         # machine-readable findings
```

It targets `http://localhost:3000` (`npm run dev`) by default, so a run reflects
your working tree. It exits `1` if it finds a collision or fails to render a
route, which makes it usable as a release gate.

Results land in `reports/overlays/` (gitignored):

| File | What it is |
| --- | --- |
| `index.html` | The browsable report: one card per failing route with the annotated screenshot |
| `report.json` | Every finding, with boxes and overlap areas, for tooling |
| `shots/` | The annotated PNGs |

In the screenshots, dashed boxes are the two offenders and the filled box is the
region one hides of the other.

## What counts as a collision

Precision matters more than recall here. A report with one false positive in it
is a report nobody reads, so the rules are deliberately narrow:

- **Both parties paint something.** A transparent positioning wrapper hides
  nothing. Backgrounds, borders, shadows, backdrop filters, and any
  `canvas`/`img`/`video`/`svg` inside all count as painting.
- **The party underneath is interactive or carries text.** The defect is losing
  something you could have clicked or read. The Walk Companion is drawn over its
  own footprint-trail canvas on purpose, and calling that a bug would train
  everyone to ignore the report.
- **The overlap clears both thresholds:** `--min-area` (default 900 px²) *and*
  `--min-ratio` of the smaller party's area (default 6%). Ratio alone flags
  hairline seams between two full-width bars; area alone flags a 1% clip of two
  huge rails.
- **Neither party contains the other.** A widget's own dropdown is allowed to sit
  on the widget.
- **Neither is a dialog.** A modal is supposed to cover things while it is open.

Full-viewport layers (90% or more of the viewport) are not treated as collisions.
They are classified separately: a modal backdrop covering the page is correct, a
stray one that survived its modal is a serious bug, and neither is an
overlay-versus-overlay problem.

## The part that is easy to get wrong

The audit does **not** just collect fixed and sticky elements. That was the first
version, and it found almost nothing.

The corner stack is a transparent, `pointer-events: none` flex column. It paints
nothing, and its members are `position: relative` inside it. An audit that only
looked at fixed and sticky boxes would have declared that entire family
invisible, and missed the exact bug it was written to catch.

So a viewport anchor that paints nothing is treated as a positioning shell rather
than an overlay, and is replaced by its outermost painted descendants, each
audited in its own right. That is what makes "the companion covers the Getting
started pill" a finding instead of a blind spot.

## First-visit state

Persistent widgets are off by default for a returning visitor who dismissed them,
and a page with every widget off has no collisions to find. So each context is
seeded with the state a **first-time** visitor gets: the Walk Companion enabled,
the getting-started checklist not dismissed, feature discovery unseen. Pass
`--no-widgets` to audit only a page's own chrome.

Because the companion is a lazily-injected Three.js module that can take ten
seconds to appear on an unbundled dev server, the audit waits for it to finish
animating in before measuring, rather than guessing a settle time.

## Fixing what it finds

Corner widgets belong in the shared corner stack
([`public/corner-stack.js`](../public/corner-stack.js)), which flows its members
vertically by priority so they cannot overlap each other:

```js
window.twsCornerStack.mount(el, { priority: 60 }); // higher = nearer the corner
```

A widget that genuinely cannot join the flow, because it is a fixed-size canvas
the visitor interacts with directly, declares the corner height it occupies
instead, and the stack lifts clear of it:

```js
window.twsCornerStack.reserve('walk-companion', bottom + height);
window.twsCornerStack.release('walk-companion'); // on unmount
```

Reservations are keyed and independent, and the tallest wins, so two of them
never fight. Measure from `getComputedStyle`, not `getBoundingClientRect`: a
widget that animates in with a transform reports a short box mid-transition, and
the stack would settle into it.

If the corner stack has not booted yet when your widget mounts, listen once for
`tws-corner-stack:ready` and claim then. Load order between these modules is not
guaranteed.

### The page's own bottom chrome

Reservations only cover widgets that know the stack exists. They do nothing for
the chrome a *page* owns: the `/app` chat composer and its action row, a
viewer's toolbar, an editor's dock. Nobody declares those, and on a phone the
helper widgets used to sit right on them, so the language control rendered
inside the "Ask the agent…" field and the Getting started pill covered the save
button.

The stack measures those instead of waiting to be told. On every resize, DOM
change and orientation change (throttled), it probes the bottom band of the
viewport with `elementsFromPoint`, keeps the hits that resolve to a
bottom-anchored `fixed`/`sticky` box which is not part of the stack, and lifts
itself above the tallest one via `--tws-corner-dock`. Docks that stack (a bar
under a composer) are climbed one band at a time, and the lift is capped at 45%
of the viewport height so a misdetection can never park the stack mid-screen.

Nothing to wire up: a page that grows a bottom dock is handled the moment it
renders one. A fixed element that should be ignored (a decorative bar the stack
may sit over) opts out with `data-corner-ignore`.

```html
<div class="my-decorative-bar" data-corner-ignore>…</div>
```

`window.twsCornerStack.remeasure()` forces the measurement immediately, which is
only worth calling from a test.

## Related

- [`public/corner-stack.js`](../public/corner-stack.js): the shared container and the reservation API
- [`tests/corner-stack.test.js`](../tests/corner-stack.test.js): the contract, exercised in JSDOM
- [`tests/e2e/mobile-helper-overlays.spec.js`](../tests/e2e/mobile-helper-overlays.spec.js): the phone-width geometry, measured in a real browser
- `npm run audit:mobile-touch`: touch-target sizes, the other half of "can I actually hit this"
- `npm run audit:a11y`: keyboard and screen-reader coverage on the top pages
- `npm run snapshot`: the daily full-page visual record of every public route (`--authed` replays the `audit:web:login` session and widens it to the signed-in pages, writing to `reports/ui-shots/` instead of `snapshots/`)
