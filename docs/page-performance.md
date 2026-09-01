# Page performance: the rules a three.ws page plays by

This platform puts real 3D on ordinary marketing pages. That is the product, and
it is also the thing most likely to make a page feel slow, so the rules below
exist to keep both true at once: the 3D stays, and the page stays quick.

Every number here was measured with Lighthouse against the production build.
Where a rule names a page and a cost, that cost is what the rule was written to
remove. Re-measure before changing one.

---

## 1. A model preview runs only while someone is looking at it

`<model-viewer auto-rotate>` never stops. model-viewer renders every element on
one shared WebGL canvas and blits the result into each element's own canvas
every frame (its `copyPixels`), so a card that rotates forever keeps the main
thread busy for as long as the tab is open. Measured cost of leaving it alone:

| Page | What was rotating | Main-thread cost |
|---|---|---|
| `/discover` | 4 directory cards | 31 s of scripting in a 40 s run |
| `/marketplace` | a screenful of grid cards | 27 s of scripting in a 40 s run |
| `/create` | 1 decorative card in the hero | 2.4 s per 35 s |

[`src/shared/attended-rotation.js`](../src/shared/attended-rotation.js) is the
one policy: a viewer turns when it scrolls into view, settles once it has turned
far enough to read as 3D (12 s), and turns again on hover or focus. Under
`prefers-reduced-motion` it never turns at all.

```js
import { attendRotation, attendRotationIn } from './shared/attended-rotation.js';

attendRotation(viewerEl);                       // one viewer
attendRotation(viewerEl, { attention: card });  // hovering the card wakes it
attendRotationIn(document);                     // every [data-attended-rotate]
```

Declarative form, for a viewer that ships in the markup:

```html
<model-viewer src="/avatars/default.glb" auto-rotate data-attended-rotate=".hero-card"></model-viewer>
```

The attribute's value, when present, is a selector for the element that owns the
viewer's attention. It matters because a visitor aims at the card, not at the
canvas, and a viewer without `camera-controls` cannot take keyboard focus
itself.

Only elements authored with `auto-rotate` are touched, so marking a viewer is
opt-in and reversible. `public/discover/discover.js` ships from `public/`
verbatim and cannot import the module, so it carries the same policy inline;
keep the two in step.

## 2. A model loads when it is wanted, not when the page opens

Decoding a GLB is one long, unbreakable main-thread task. `/create`'s hero card
spent **852 ms** on the 748 KB base avatar during page load, which was that
page's entire Total Blocking Time. Deferring the task does not help: Lighthouse
counts blocking time up to Time to Interactive, so a long task at four seconds
counts exactly as much as one at one second. The work has to not happen.

So a card that may never be looked at ships a poster and loads its model on
first attention:

```html
<model-viewer
  data-src="/avatars/default.glb"
  poster="/avatars/default-poster.webp"
  auto-rotate
  data-attended-rotate=".hero-card"
></model-viewer>
```

`attendRotation` promotes `data-src` to `src` the first time the card is
hovered, focused or tapped. The poster carries the finished frame in the
meantime, so nothing looks unfinished.

Render the poster with
[`scripts/render-glb-poster.mjs`](../scripts/render-glb-poster.mjs), which
reuses the same headless model-viewer harness the asset pipelines render their
thumbnails with. Pass the viewer's own camera and lighting so the live model
does not visibly jump when it loads over the poster:

```bash
node scripts/render-glb-poster.mjs public/avatars/default.glb public/avatars/default-poster.webp \
  --size=768 --orbit="15deg 80deg auto" --exposure=0.95 --shadow=0.4 --shadow-softness=0.8 --environment=neutral
```

That poster is 15 KB against a 748 KB model.

The same reasoning applies to the model-viewer bundle itself. It is 955 KB, and
a page whose landing state has no 3D on screen should not parse it on arrival:
that alone was `/forge`'s 1.5 s First Contentful Paint. Use
[`src/shared/model-viewer-loader.js`](../src/shared/model-viewer-loader.js)
(`ensureModelViewer` / `ensureModelViewerOrFallback`, with CDN failover) at the
moment the page actually needs a viewer. Keep `/model-viewer-meshopt.js` as a
plain deferred script: it has to register the Meshopt decoder before any viewer
starts loading, and nearly every three.ws GLB is meshopt-compressed.

## 3. Anything that arrives late needs its box reserved first

A block that appears after the first paint pushes everything under it down, and
that is a layout shift for every pixel it moves.

- **The shared header.** `nav.js` renders into an empty `<div id="nav-container">`
  and injects `nav.css` at the same moment, so nav.css can never reserve
  anything on a page that does not also link it in `<head>`. The reservation
  lives in [`public/tokens.css`](../public/tokens.css) instead, which both
  `style.css` and `nav.css` import, so it is render-blocking everywhere.
  `#nav-container:empty` stops matching the moment the header lands. Missing
  this was one 0.83 shift on `/forge` — that page's entire CLS.
- **Async sections.** Ship the skeleton in the HTML, not `hidden`. `/marketplace`
  revealed its hero and its weekly theme strip from the bundle and moved
  everything below them across five shifts (0.60 CLS). Both now ship in place
  with `aria-busy`, which they drop when they hold real content, and collapse
  outright only when there is genuinely nothing to show. The Top Performers
  podium had it right all along: a real skeleton card lays out at exactly the
  height the loaded card will.
- **Web fonts.** [`public/fonts/fonts.css`](../public/fonts/fonts.css) declares a
  metric-compatible fallback face per family (`size-adjust` plus ascent, descent
  and line-gap overrides derived from `@capsizecss/metrics`), and
  `public/tokens.css` names it in the stack right after the real family. Text
  then renders at the webfont's metrics before the webfont arrives, so the swap
  changes glyph shapes without moving a single line. Preload the two primary
  faces in `<head>`; a page that reaches `fonts.css` through two `@import` hops
  discovers them far too late otherwise.

## 4. Fetch an image at the size it is shown

Stored art is whatever size its creator uploaded. `/api/img` resizes and
re-encodes to WebP against a fixed width ladder, cached immutably at the edge
(see the Image proxy API section of [api-reference.md](./api-reference.md)).

```js
import { resizedImageUrl } from './shared/image-url.js';   // remote artwork in the DOM
resizedImageUrl(url, 480);

import { proxiedImageURL } from './ipfs.js';               // token art, IPFS/Arweave included
proxiedImageURL(url, mint, { width: 512 });
```

Ask for the width the box paints at, doubled for retina. Measured savings: a
Forge gallery card went from a 1 MB PNG to a 13 KB WebP tile, and the `/play`
world stopped pulling 2.7 MB of full-size token art for textures a few hundred
pixels tall (smaller textures are also less GPU memory).

Same-origin, relative, `data:` and `blob:` sources are returned untouched by
both helpers; there is nothing to gain by proxying them.

## 5. Nothing animates off screen

A `requestAnimationFrame` loop that runs while its canvas is scrolled away, or
while the tab is in the background, is pure waste. Gate every loop on an
`IntersectionObserver` plus `document.visibilityState`. The home page's visitor
arena (`src/home-bento.js`) redrew its grid and every dot from page load until
the tab closed, on a section most visitors never scroll to.

## 6. Do not re-probe the document on every mutation

`public/theme-switcher.js` decides whether a page supports the light palette by
flipping `data-theme` and reading a computed style — a full style recalc, twice
per probe. It used to re-probe on any DOM mutation, which on a JS-rendered page
became a recalc storm: 8.7 s of main-thread time on `/marketplace` alone, enough
that Lighthouse gave up on the page. Only a stylesheet can change that verdict,
so only a stylesheet landing or leaving re-probes, coalesced to one probe per
frame.

---

## Measuring

Build the production bundle and serve `dist/` — never measure the dev server,
which ships unbundled modules:

```bash
npm run build && npm run publish:lib && npm run build:chat
npx lighthouse https://three.ws/ --preset=desktop --only-categories=performance --view
```

Two things will mislead you if you let them:

- **A loaded machine.** Every report carries `environment.benchmarkIndex`.
  Compare it across runs before believing a regression; a busy box has swung the
  same page between 88 and 52. Take a median of three.
- **Live data.** `/` mounts whichever avatar the API is featuring right now, and
  its size varies by megabytes. Two runs of that page are not the same page.

## Related

- [Avatar thumbnails](./avatar-thumbnails.md): where a preview image comes from and the rule every path obeys
- [3D asset pipeline](./3d-asset-pipeline.md): baking models and clips, including why clip JSON is written at float32 precision
- [API reference](./api-reference.md): the image proxy endpoint and its width ladder
