# What the site's load numbers are, and the four rules that keep them there

`/play` has [its own boot-cost document](./play-boot-performance.md) because a coin world is a special case: a WebGL renderer, a physics solver and a multiplayer room all have to start before anything is playable. This document covers everything else. Every ordinary page on three.ws is a static HTML document plus a module graph, and the cost of opening one is almost entirely decided by four questions:

1. How many bytes of JavaScript run before the page is usable?
2. How much of the DOM does the browser lay out that nobody can see?
3. What is on the critical path that has no business being there?
4. How large is the media, and when is it decoded?

Each section below is an invariant with the measurement that produced it. Every number in this file came from a Lighthouse run against the live site, not from reading the source.

## How to measure

Lighthouse CLI, one page at a time, performance category only:

```bash
export CHROME_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome"
npx lighthouse https://three.ws/marketplace \
  --preset=desktop \
  --only-categories=performance \
  --output=json --output-path=./marketplace.json \
  --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu" \
  --quiet --max-wait-for-load=90000
```

Drop `--preset=desktop` for the mobile form factor, which is Lighthouse's default and applies a 4x CPU slowdown plus a throttled connection. The same page always scores far lower on mobile; compare a page against its own history, never against another page or another form factor.

Two things to know before reading a report:

- **The score is not the byte count.** Performance is weighted Total Blocking Time 30%, Largest Contentful Paint 25%, Cumulative Layout Shift 25%, First Contentful Paint 10%, Speed Index 10%. A page can ship 4 MB and score well if none of it blocks; a page can ship 900 KB and score badly if all of it runs at once.
- **Lighthouse 13 removed the audits everyone quotes.** `offscreen-images`, `uses-responsive-images`, `modern-image-formats` and `dom-size` are gone, replaced by the insight family: `image-delivery-insight`, `render-blocking-insight`, `cache-insight`, `legacy-javascript-insight`, `cls-culprits-insight`. A script that reads the old audit names throws on `undefined`.

---

## 1. A grid never lays out what nobody can see

**Invariant: any grid that renders a whole catalogue in one pass gives its cards `content-visibility: auto` and a `contain-intrinsic-size` hint.**

`/marketplace` renders the entire catalogue into `#market-grid` on first paint. A desktop trace measured that element at **31,196px tall**, of which one 940px screenful is visible. The browser styled, laid out and painted all of it. In the sweep of 2026-08-14 that page spent **21,203ms in Style & Layout and 19,634ms in Rendering**, roughly forty seconds of work for thirty screenfuls nobody had scrolled to, and it is why `/marketplace` is the worst-scoring page on the site (23 desktop, 51,400ms total blocking time). `/discover` has the same shape at smaller scale.

`content-visibility: auto` makes the browser skip that work for an element until it nears the viewport, and hand it back when the element leaves again. The rules live in [public/marketplace.css](../public/marketplace.css) and the `.explore-card` block of [public/style.css](../public/style.css).

Two things make it safe rather than clever:

- **Paint containment has to already be true.** `content-visibility` implies `contain: layout style paint`, and paint containment clips to the padding box. Every card it is applied to was already clipping its own contents, so nothing on screen changed. Applying it to a card with an overflowing badge or a hover glow that escapes its bounds would visibly cut that decoration off.
- **The size hint starts with `auto`.** `contain-intrinsic-size: auto 250px auto 370px` tells the browser to assume that size for a card it has not rendered, and to *replace the assumption with the real measurement* once it has. Without the leading `auto` keyword, a card that renders taller than the hint leaves a gap and jumps the scrollbar under the user's cursor.

**If you add a new catalogue grid, add the rule with it.** The cost of not doing it does not show up until the catalogue has a few hundred rows, which is exactly when nobody is looking for it.

## 2. Analytics never competes with the page

**Invariant: the PostHog library loads at idle. The stub that queues events loads synchronously.**

PostHog's stock snippet calls `posthog.init(...)` inline in `<head>`, and `init()` is the function that injects the `<script src=".../static/array.js">` tag. That put the analytics library into the page-load window of every route on the site. A desktop trace of `/` measured **1,110ms of script evaluation and a 907ms long task** for `array.js`; `/create` paid **837ms of its 5,400ms total blocking time** for the same file. Nothing a visitor can see depends on it.

The snippet in [vite.config.js](../vite.config.js) is now the stock loader with one change: the trailing `init()` call is wrapped in a `requestIdleCallback` with a 2s timeout, falling back to a plain timer where the API is missing.

Nothing is dropped by moving it. The snippet's IIFE still runs synchronously, so `window.posthog` and every capture method exist from the first line of `<head>`; calls made before the real library arrives queue on the stub array and replay when it loads. That queueing is the entire purpose of PostHog's stub, and the init arguments ride along in `posthog._i`.

The 2s bound is the deliberate part. Waiting for the `load` event instead would have meant a **12s** delay on the heaviest page, so a visitor who bounced early would be invisible. Two seconds costs the load window nothing and caps the blind spot.

**Any third-party script you add follows the same rule.** If a visitor cannot see it, it does not get to run while the page is still becoming usable.

## 3. The CDN bundle is minified, whatever Vite thinks

**Invariant: `dist-lib/agent-3d.js` ships minified, via the `threews-lib-minify-whitespace` plugin in [vite.config.js](../vite.config.js).**

Vite hard-codes `minifyWhitespace: false` for every ES library build (`resolveEsbuildTranspileOptions` in `vite/dist/node`). The reasoning is sound for the usual case: a library output gets re-bundled by whoever installs it, and keeping the whitespace preserves `/*#__PURE__*/` annotations for their tree-shaker.

Our lib output is not an npm dependency. It is the file a browser downloads from `/agent-3d/latest/agent-3d.js` when a third-party page drops in an `<agent-3d>` tag, and the homepage loads it too. Because the option is forced rather than defaulted, no `build.minify` or `esbuild` setting in the config can turn it back on.

A `renderChunk` pass that runs esbuild with `minifyWhitespace: true` (and identifiers and syntax left alone, since Vite's own pass already handled those) took the shipped bundle from **4,244,387 bytes to 3,433,103** raw, and from **1,031,741 to 853,007** gzipped at `gzip -9`. That is 811,284 fewer bytes, 19.1%. On the homepage, `agent-3d.js` was 2,293ms of script evaluation and two long tasks of 1,299ms and 526ms.

Measure the right file. `dist-lib/` also holds `agent-3d.umd.cjs`, which is naturally smaller (2,761,457 bytes) because it is a different format, and quoting it makes the win look better than it is. [scripts/publish-lib.mjs](../scripts/publish-lib.mjs) mirrors the **ES** build, `dist-lib/agent-3d.js`, to `/agent-3d/<version>/`, so that is the file a browser downloads.

**Do not "simplify" this away by trusting `build.minify`.** Check the byte count of `dist-lib/agent-3d.js` after any change to the lib config; a jump back over 4 MB means the plugin stopped running.

## 4. Below-the-fold sections load below the fold

**Invariant: a heavy section is loaded by an `IntersectionObserver` on the section itself, not by a tag in `<head>`.**

The homepage is 14,825px tall. Three of its sections are expensive enough that loading them eagerly dominated the whole page:

| Section | Offset | Cost when loaded eagerly |
|---|---|---|
| Dragon backdrop | 3,775px | 2,742ms script evaluation, 1,498ms long task |
| Mini forge | 1,246px | pulls `model-viewer` on first job |
| Pose demo | 8,724px | pulls Three.js, OrbitControls, the mannequin rig |

All three are gated in [pages/home.html](../pages/home.html) with a `rootMargin: '200px'` observer, so none of them costs anything until the visitor has scrolled to them. The gates are measurably honest: at `DOMContentLoaded` the dragon sits at 3,753px against a trigger threshold of viewport + 200px = 1,140px, so it does not fire on load.

**The exception that proves the rule is the `<agent-3d>` loader.** It stays eager in `<head>` on the homepage, and that is correct: `bootHeroAvatar()` in [src/home-live-agents.js](../src/home-live-agents.js) runs at module top level and the hero stage is the above-the-fold LCP element. Deferring the custom-element definition would not remove the work, it would move it behind the largest paint. Rule 3 is what makes that eager load affordable.

The same rule covers 3D viewers, and it needs its own mechanism because the platform default does not work. **`loading="lazy"` on a `<model-viewer>` is not enough on a page that renders many of them.** Slides in a carousel occupy one box and are hidden with opacity rather than `display`, so every one of them intersects the viewport at once and model-viewer's own lazy loading holds nothing back; a grid card is a different shape but the cost is the same once the cards are on screen.

So [src/marketplace.js](../src/marketplace.js) uses a `data-src` contract instead. A viewer ships `data-src` rather than `src`, and `observeCardModelViewers()` promotes it to `src` on first intersect at a 200px margin, adds `auto-rotate` there, and *removes* `auto-rotate` when the element leaves so an offscreen viewer is not running a raf loop. The grid cards and the hero carousel already worked this way. The themed-picks strip did not, and that made it the last eager viewer on the page. On `/marketplace`, `model-viewer` was the single most expensive script in the trace at **7,924ms of evaluation**.

**A new `<model-viewer>` on a multi-viewer page ships `data-src`, or it is eager.** There is no third option, and the attribute that looks like it should handle this does not.

**Before you gate something, check where it actually is.** Paste this into DevTools:

```js
['dragon-canvas-wrap', 'home-forge', 'home-pose'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) console.log(id, Math.round(el.getBoundingClientRect().top + scrollY),
    'trigger at', innerHeight + 200);
});
```

## 5. Media is lazy, sized by CSS, and decoded off the main thread

**Invariant: every grid thumbnail carries `loading="lazy"` and `decoding="async"`, and its container reserves the box in CSS.**

Directory thumbnails are stored at 768x768 and painted into a 293px box; showcase thumbnails are full-size renders painted into a 200px-tall box. `loading="lazy"` keeps them off the wire, and `decoding="async"` keeps the decode of a grid's worth of them off the critical rendering path. Both are set in [public/discover/discover.js](../public/discover/discover.js) and [src/forge-showcase.js](../src/forge-showcase.js).

The box is reserved by CSS rather than by `width`/`height` attributes, because these thumbnails are square-cropped with `object-fit: cover` at a size the markup does not know: `.explore-card-thumb` is `aspect-ratio: 1 / 1` and `#showcase .creation .thumb` is a fixed height. That is why the layout-shift numbers on both pages are near zero even though the images arrive late.

**A reserved box is not optional.** If you add a thumbnail whose container has no `aspect-ratio` and no fixed height, add one, or the late image will shift everything under it.

---

## Open: directory thumbnails are served with no cache headers at all

This one is measured, understood, and deliberately not fixed yet, because the safe fix is larger than it looks.

`/discover` downloads **28 images totalling 9,360 KiB**, of which 27 are avatar thumbnails at roughly 280 KB each. Every one of them comes from the Cloudflare `pub-*.r2.dev` public endpoint, which answers with **no `Cache-Control` header at all**: Lighthouse's `cache-insight` reports a cache lifetime of 0 for 29 resources, so a returning visitor re-downloads all of it.

The repository already has the fix. `/cdn/<key>` ([api/cdn-object.js](../api/cdn-object.js)) proxies the same bucket and answers `public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800` for `thumb/` keys. Verified against a live key from the feed, both routes return the identical 289,539-byte PNG and only the first-party one carries the header.

What makes it non-trivial is that `thumbnailUrl()` in [api/\_lib/r2.js](../api/_lib/r2.js) is deliberately the single resolver for a stored thumbnail key, and its output goes to more places than a page:

- `GET /api/explore` is a **documented public endpoint** (see [the API reference](./api-reference.md)), so its `image` field has third-party consumers and cannot become a site-relative path.
- The same helper feeds the image baked into on-chain token metadata via `api/_lib/draft-mint.js`, which is written once and cannot be corrected afterwards.

The shape of the fix is therefore a second helper, absolute rather than relative, applied only to first-party page feeds and never to the metadata writer, plus an addition to [tests/thumbnail-url-guard.test.js](../tests/thumbnail-url-guard.test.js) so the split stays honest. Sizing the thumbnails is worth doing in the same pass: they are stored at 768x768 and painted into a 293px box.

## Known costs that are not bugs

Two things in the numbers above are real and are not being fixed by tuning:

- **`model-viewer` is a 1,587ms third-party evaluation** loaded from `ajax.googleapis.com`. It is preconnected and loaded lazily (measured arriving at 12.2s on the homepage, long after first paint), but the evaluation itself is the vendor's. Self-hosting it would move the bytes onto our CDN and change nothing about the parse cost.
- **The homepage is a long page with a lot on it.** 14,825px of content with live 3D in the hero is a product decision, not an oversight. The rules above are what keep the parts a visitor has not reached from being charged to the parts they have.
