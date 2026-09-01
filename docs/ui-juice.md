# ui-juice — the shared game-feel library

`src/ui-juice.js` (+ `src/ui-juice.css`) is the one place the platform keeps its
**interaction primitives**: count-ups, directional flashes, live-feed row enters,
sparklines, ring gauges, FLIP reorders, SSE status dots, and the single "it
shipped" ripple. The vocabulary was proven on the `/swarms` page and extracted so
every surface animates the same way instead of reinventing it.

**See it run:** [`/ui-juice`](https://three.ws/ui-juice) is a live kitchen-sink that
exercises every primitive on real, user-driven values (source: `pages/ui-juice.html`
+ `src/ui-juice-demo.js`). It's the fastest way to feel each helper and to verify the
reduced-motion behaviour — emulate `prefers-reduced-motion: reduce` in DevTools and
drive any control; everything lands on its static end state with no motion.

Three guarantees hold for every export:

- **Token-driven.** Durations and easings come from the motion ladder in
  `public/tokens.css` (`--duration-*`, `--ease-*`). No raw millisecond literals.
- **Reduced-motion-safe.** That token file zeroes every `--duration-*` under
  `@media (prefers-reduced-motion: reduce)`. `reducedMotion()` reads the computed
  token, so each primitive lands on its correct final state with no animation,
  automatically, with an explicit JS fallback path as belt-and-braces. The same
  media block also floors every animation and transition on the page to 1ms,
  whether or not it was authored through a token; only elements marked
  `data-motion="essential"` (or `.motion-keep`), `aria-busy` regions, progress
  bars, spinners and loaders keep their motion, because a frozen spinner reads as
  a hung page.
- **Real values only.** These are transition helpers over real numbers/series.
  They never fabricate or sample inputs.

## Install / use

Pull the styles into a surface's CSS and the helpers into its JS:

```css
/* src/<surface>.css — first line */
@import './ui-juice.css';
```

```js
// src/<surface>.js
import { countUp, flashValue, sparkline, rippleOnce } from './ui-juice.js';
```

No build step or HTML change is required — Vite resolves both the CSS `@import`
and the ES module import. The classes the helpers attach all live under the
`juice-*` namespace.

## Exports

### `countUp(el, from, to, opts?)`
Animate a number between two real values via `requestAnimationFrame`, preserving
the caller's formatting. Cancels any in-flight count-up on the same element.
Reduced motion → final value instantly. Stashes the target on `el.dataset.juiceVal`.
The clock starts from the first frame's own timestamp and progress is clamped to
`[0, 1]`, so no frame ever paints a value outside `[from, to]` (a `rAF` timestamp
behind `performance.now()` used to drive the easing negative and flash garbage
like "-42797%").

```js
countUp(volEl, 1200, 1875, { format: (n) => '$' + Math.round(n).toLocaleString() });
```

`opts`: `format` (fn), `duration` (ms), `ease` (fn), `token` (duration token name).

### `updateValue(el, to, format, opts?)`
Count from the element's last tracked value to a new one **and** flash in the
direction of change — the swarms tile-update pattern. `opts.flash` defaults true.

```js
updateValue(balEl, newBalance, (n) => n.toFixed(4) + ' SOL'); // counts + tints up/down
```

### `flashValue(el, direction?)`
Directional tint pulse, then settle. `'up'` → success, `'down'` → danger,
`'neutral'` → surface. No-op under reduced motion.

```js
flashValue(priceEl, newPrice > oldPrice ? 'up' : 'down');
```

### `enterRow(el)` / `enterStagger(els, opts?)`
Slide+fade a freshly-inserted row in from the top (live logs/feeds). `enterStagger`
applies an index-based, capped delay across a list. Reduced motion → no-op.

```js
list.prepend(row); enterRow(row);
enterStagger(grid.children, { step: 28, max: 320 });
```

### `sparkline(values, opts?)` / `sparklinePath(values, w, h, pad?)`
`sparkline` returns an inline SVG string for a real numeric series — net-positive
vs net-negative coloring via tokens, optional animated draw and final-point dot.
`sparklinePath` is the pure geometry core (unit-tested).

```js
metaEl.innerHTML = sparkline(priceHistory, { width: 140, height: 36, fill: true, animate: true });
```

`opts`: `width`, `height`, `fill`, `dot` (default true), `animate`, `stroke`.

### `ring(pct, opts?)` / `ringGeometry(pct, size, stroke)` / `playRings(scope)`
`ring` renders an SVG arc gauge filling to a real percentage with a centered
label. Render with `animate:true`, insert, then call `playRings(container)` to
sweep the fill from empty to its real offset. `ringGeometry` is the pure core.

```js
el.innerHTML = ring(progressPct, { size: 64, label: progressPct + '%' });
playRings(el);
```

`opts`: `size`, `stroke`, `label`, `color`, `track`, `animate`.

### `flipReorder(container, keyFn)` / `reorderedKeys(before, after)`
FLIP-animate a list to new positions after a re-sort. Capture before the DOM
mutation, play after. `reorderedKeys` is the pure "which keys moved" diff.

```js
const flip = flipReorder(list, (el) => el.dataset.id);
flip.capture();
list.replaceChildren(...sorted); // re-render
flip.play();
```

### `liveDot(state?, opts?)` / `setLiveDot(el, state, label?)`
Markup + in-place updater for an SSE status indicator mirroring the swarms
`.sw-live` vocabulary. States: `live` | `connecting` | `idle` | `error`.
`setLiveDot` also keeps the state pinned: when the badge sits inside a
`data-i18n-html` line, the async translation pass rewrites that line from a
frozen snapshot of the original markup (badge included), so the helper watches
the container's child list and re-stamps the last requested state and label
whenever the markup around the badge is replaced.

```js
header.insertAdjacentHTML('beforeend', liveDot('connecting'));
es.addEventListener('hello', () => setLiveDot(header, 'live'));
```

### `rippleOnce(el)`
A single restrained accent ripple along an element's edge — the "it shipped" beat
for a real success (a launch confirmed, an event fired). No confetti, no-op under
reduced motion.

```js
rippleOnce(launchCard); // after the deploy request resolves ok
```

## Helpers

- `durationMs(token, fallback?)` — resolve a `--duration-*` token to ms from live
  computed styles.
- `reducedMotion()` — true when motion should be suppressed (token is 0, or the
  reduced-motion media query matches).

## Tested

`tests/ui-juice.test.js` covers the pure cores in the default `node` vitest env:
count-up interpolation/formatting and the instant path, `sparklinePath` geometry,
`ringGeometry` arc math, `reorderedKeys` diffing, and `liveDot` markup/escaping.

```
npx vitest run tests/ui-juice.test.js
```

## First consumer

`/swarms` (`src/swarms.js`) is the reference consumer — its inline `flash()` now
delegates to `flashValue`, proving the API and removing duplication. New surfaces
should reach for these primitives rather than re-rolling RAF loops.
