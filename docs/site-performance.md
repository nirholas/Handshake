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
- **Keep `--disable-gpu`. Do not "improve" it to software WebGL.** Swapping it for `--use-gl=angle --use-angle=swiftshader` looks more faithful, since the 3D pages then really run their renderers, and it does not survive contact with this site: in the 2026-08-15 sweep that flag set made `/` and `/marketplace` abort with `PAGE_HUNG`, `/play` report `NO_FCP`, and `/marketplace` still fail with `PROTOCOL_TIMEOUT` at a 90s `--max-wait-for-load` on a completely idle machine. The same pages complete in about two minutes each with `--disable-gpu`. Software rasterization of our own WebGL is slower than the throttling Lighthouse is trying to apply, so the run measures the rasterizer rather than the page.
- **Check `environment.benchmarkIndex` in every report before quoting its score.** A shared build machine swings it wildly: the 2026-08-15 sweep saw 108 on one `/create` run and 2,398 on a `/` run twenty minutes later, and the low reading inflates every CPU-bound metric in that report. A run under roughly 800 is worth repeating on an idle machine rather than recording.

## Where the numbers are

Two sweeps, same eight pages, same tool (Lighthouse 13.4.1), same flags, three weeks apart in build terms. The first is the problem statement the rules below were written against; the second is what the deployed rules are worth.

**2026-08-14**, against commit `0496089f0` (stamped `2026-08-14T01:24:52Z`), which predates rules 1, 2, 3 and the model-viewer half of rule 4.

**2026-08-15**, against commit `7505b83ca` (stamped `2026-08-15T07:08:00Z`), which contains all of them.

| Page | Desktop 08-14 | Desktop 08-15 | Mobile 08-14 | Mobile 08-15 | Desktop TBT 08-14 | Desktop TBT 08-15 |
|---|---|---|---|---|---|---|
| `/` | 33 | **91** | 25 | 48 | 19,340ms | 134ms |
| `/create` | 38 | **94** | 25 | 51 | 6,940ms | 0ms |
| `/forge` | 32 | **75** | 20 | 31 | 12,560ms | 55ms |
| `/marketplace` | 23 | **58** | 17 | 20 | 51,400ms | 168ms |
| `/play` | 31 | **83** | 25 | 41 | 5,870ms | 101ms |
| `/docs` | 39 | **93** | 35 | 47 | 4,490ms | 107ms |
| `/discover` | 54 | **88** | 44 | 58 | 11,010ms | 266ms |
| `/chat` | 28 | **60** | 25 | 55 | 6,390ms | 0ms |

Total blocking time was what held every score in the first column down, and it is 30% of the weighting on its own. It is now effectively gone from all eight pages. **Read a Lighthouse report by which metric is losing the points, not by the score**, because the answer changes once you fix something: on the three pages still under 80, blocking time now costs 4.2 points at worst and the loss has moved somewhere else entirely.

| Page still under 80 | Losing | To |
|---|---|---|
| `/forge` 75 | 13.3 pts | CLS 0.260, of which 0.190 is one shift on the example-prompt row (rule 6) |
| `/marketplace` 58 | 19.8 pts + 13.0 pts | LCP 3,649ms, and CLS 0.257 of which 0.178 is one shift on the podium (rule 5) |
| `/chat` 60 | 21.0 + 9.9 + 9.0 pts | LCP, FCP and Speed Index, all of them one 4,277 KiB chunk (see the open items) |

Full desktop detail for the 2026-08-15 run: CLS `/` 0.002, `/create` 0.014, `/forge` 0.260, `/marketplace` 0.257, `/play` 0.000, `/docs` 0.043, `/discover` 0.044, `/chat` 0.001. Transferred bytes `/` 3,272 KiB, `/create` 1,804 KiB, `/forge` 8,254 KiB, `/marketplace` 3,987 KiB, `/play` 2,265 KiB, `/docs` 706 KiB, `/discover` 4,885 KiB, `/chat` 4,627 KiB.

Both sweeps were taken on a shared build machine, so single-page scores move a few points between runs; see the `benchmarkIndex` note above before quoting one.

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

So [src/marketplace.js](../src/marketplace.js) uses a `data-src` contract instead. A viewer ships `data-src` rather than `src`, and `observeCardModelViewers()` promotes it to `src` on first intersect at a 200px margin, adds `auto-rotate` there, and *removes* `auto-rotate` when the element leaves so an offscreen viewer is not running a raf loop. The grid cards and the hero carousel already worked this way. The themed-picks strip did not, and that made it the last eager viewer on the page. On `/marketplace`, `model-viewer` is the single most expensive script in the trace at **7,924ms of evaluation**, across the grid, the hero and the strip together.

Measured honestly, that last one is the smallest of the three: at 1350x940 the strip sits at y=137, above the fold, so the observer promotes all six viewers immediately and a desktop first load is unchanged. It pays on a narrow viewport that pushes the strip down, on a filtered view that moves it, and on the rotation that used to keep running after the visitor scrolled past. **Report a fix by what you measured it doing, not by the size of the number next to it.**

**A new `<model-viewer>` on a multi-viewer page ships `data-src`, or it is eager.** There is no third option, and the attribute that looks like it should handle this does not.

### The element bundle is part of that cost, not just the model

The rule above defers the *model*. The 253 KiB module that defines `<model-viewer>` is a separate download and a separate parse, and on 2026-09-04 two pages were still paying it on every visit from a tag in `<head>`.

`/discover` is the clearer case. It renders a directory of 48 cards, and only the handful that carry a GLB become a viewer at all: measured against production, four of them, the first at **y=4991px** on a 940px viewport. The other 44 are static R2 thumbnails. The bundle was fetched and evaluated on every visit regardless, and a Lighthouse desktop trace attributed **28,971ms of bootup time** to it. The same page measured with the bundle absent scored **81 against 47** for the page as shipped (and did so on a *slower* sample of the shared machine, `benchmarkIndex` 709 against 958, so the gap is a floor rather than a ceiling).

`/create` is the smaller case and the more embarrassing one. It has exactly one viewer, in the hero card, and that viewer already deferred its model with `data-src` per the rule above. The bundle was still fetched and evaluated on load, **8,246ms of bootup**, to build a WebGL renderer for a card most visitors never touch.

Both now load the element on demand, through the CDN failover chain in [src/shared/model-viewer-loader.js](../src/shared/model-viewer-loader.js) that the hardcoded `<script>` tags never had:

- `/create` asks for it from `promoteSource()` in [src/shared/attended-rotation.js](../src/shared/attended-rotation.js), the same first attention that promotes `data-src`. Every `data-src` viewer on the platform inherits this.
- `/discover` asks for it when a card that actually carries a GLB comes within a screen of the viewport, in [public/discover/discover.js](../public/discover/discover.js).

**An undefined custom element paints nothing, so the box has to be dressed for that window.** `<model-viewer>` cannot show its own `poster` before it upgrades, so a `:not(:defined)` rule keeps each box the exact size the upgraded viewer will occupy and fills it: `/create` paints the same poster image as a background, `/discover` paints the card's surface tone. Verified in a browser at 1350x940: the `/create` viewer measures 278x238 before the hover and 278x238 after, and the bundle count goes 0 before, 1 after. On `/discover`, 0 at rest with the first 3D card at y=4991, 1 once it is scrolled into view, and the element upgrades and loads its GLB.

The meshopt shim stays eager on both pages, and has to. `public/model-viewer-meshopt.js` is a 2 KiB classic script that intercepts `customElements.define()`, so it registers its decoder whenever the bundle turns up; every server-baked GLB needs that decoder set before the first load starts.

**A page that renders no viewer downloads no viewer.** Check what a page actually mounts before you put a 3D engine in its `<head>`.

## 5. Media is lazy, sized by CSS, and decoded off the main thread

**Invariant: every grid thumbnail carries `loading="lazy"` and `decoding="async"`, and its container reserves the box in CSS.**

Directory thumbnails are stored at 768x768 and painted into a 293px box; showcase thumbnails are full-size renders painted into a 200px-tall box. `loading="lazy"` keeps them off the wire, and `decoding="async"` keeps the decode of a grid's worth of them off the critical rendering path. Both are set in [public/discover/discover.js](../public/discover/discover.js) and [src/forge-showcase.js](../src/forge-showcase.js).

The box is reserved by CSS rather than by `width`/`height` attributes, because these thumbnails are square-cropped with `object-fit: cover` at a size the markup does not know: `.explore-card-thumb` is `aspect-ratio: 1 / 1` and `#showcase .creation .thumb` is a fixed height. That is why the layout-shift numbers on both pages are near zero even though the images arrive late.

**A reserved box is not optional.** If you add a thumbnail whose container has no `aspect-ratio` and no fixed height, add one, or the late image will shift everything under it.

### A skeleton only reserves the box if it is the same size as the thing it replaces

`/marketplace` had a skeleton, a comment saying it existed "so there's no layout jump when data arrives", and the largest layout shift on the page. Both halves of it were wrong, and each is worth recognising on sight.

**A section that JavaScript reveals reserves nothing.** `#mkt-top-section` shipped `hidden`, and `loadTopPerformers()` in [src/marketplace.js](../src/marketplace.js) cleared that only once it ran. `hidden` is `display: none`, so until the page bundle executed, the section occupied zero pixels; then the whole 271px of it appeared and pushed the grid, the pulse strip and everything below them down. That single reveal measured **0.178 of the page's 0.257 desktop CLS**. The skeleton could not help, because the skeleton was inside the thing that did not exist yet.

**A placeholder that is not the size of the real card is a second shift, not a fix.** Measured on production at six viewport widths, the skeleton podium was **190px against a loaded podium of 235px** on desktop, so the swap moved the page again by 45px.

Both are fixed in the markup rather than the module. The section ships visible with its three placeholder cards in [pages/marketplace.html](../pages/marketplace.html), so the box exists in the first frame; `.mkt-top-card` carries a `min-height` (235px, and 72px in the 640px query) that the placeholder and the loaded card both obey, so the swap is a no-op for layout. `loadTopPerformers()` now only replaces the podium's contents, clears the `aria-busy` it ships with, or hides the section when the feed is empty.

Below 640px the podium is a single column, which makes the placeholder *count* decide its height rather than just the card size, so the 640px query hides every placeholder after the first. Three placeholders there would have reserved three rows for a feed that currently returns one agent, and over-reserving shifts the page exactly as surely as under-reserving; that was a regression introduced and caught inside this change, not a pre-existing one.

Two residuals are measured and left, both smaller than what they replace. If the leaderboard starts returning three agents, the mobile column grows from one row to three (a 160px shift, against the 268px the same load costs today). And a name long enough to wrap grows a loaded card past the 72px floor at 390px and narrower, by 14px to 32px. Reserving for a count you do not know yet is not solvable in CSS; reserving for the card you do know is.

**A loading state is a size before it is a shimmer.** Build it out of the same element as the real thing, ship it in the HTML, and check both heights in the browser rather than assuming they match.

## 6. Whoever writes a node's text owns it, and i18n has to be told

**Invariant: JavaScript that replaces the text of an element carrying `data-i18n` removes the attribute in the same statement.**

`/forge` measured a CLS of 0.232 on desktop, and **0.1785 of it was a single shift**. A probe of the live page found the cause: at `DOMContentLoaded` the example-prompt chips held their randomized prompts and the row was 168px tall, and about a second later they had reverted to the static English labels from the HTML at 99px. That 69px collapse moved the quality tiles, the composer row, the Generate button and everything below them.

The mechanism is ownership. The static chips carry `data-i18n` keys so a visitor with no JavaScript still gets translated copy. `applyCatalog` in `src/i18n.js` walks every `[data-i18n]` node whenever a catalog loads or the locale changes, and writes the keyed string back. Once the randomizer has replaced a chip's label, the key no longer describes that node, so i18n was faithfully undoing the rotation on every single load. The layout shift was the visible half of a functional bug: the "fresh set every visit" promise silently did not hold.

The fix is one line next to the write, in `setChipPrompt()` in [src/forge-prompt-studio.js](../src/forge-prompt-studio.js):

```js
function setChipPrompt(chip, text) {
	chip.textContent = text;
	chip.removeAttribute('data-i18n');
}
```

**Any node whose text becomes dynamic loses its `data-i18n` at the point it becomes dynamic.** Not later, not in a cleanup pass. `src/i18n.js` uses the same guard for `data-auth-name` in the nav.

### That fixed the revert. It did not fix the growth.

The 2026-08-15 sweep ran against a build that already contained the fix above, and `/forge` still measured **CLS 0.256 desktop, 0.263 mobile, with `<div class="chips" id="examples">` still named as the largest single shift at 0.190**. Removing the revert removed one direction of a shift that had two.

The remaining direction was the first one: static labels to seeded labels. The static markup shipped five short examples ("a potted monstera plant") totalling 132 characters, and `seedChips()` replaced them on every JS visit with generated prompts capped at 64 characters each. The generator's own distribution is the whole story: a prompt averages 53.5 characters and cannot go below 29, so the seeded row averaged 268 characters and could reach 320. **The row a visitor sees was always more than twice as wide as the row first paint reserved for it**, and `.chips` is `flex-wrap`, so the difference arrived as extra lines that pushed the composer and everything under it down.

There is no way to generate a row narrow enough to fit the old markup. Only **three distinct prompts in the entire grammar** are 37 characters or shorter, so a per-label cap tight enough to match the static copy would leave the row with duplicates. The reservation has to move to meet the content, not the other way round:

- The labels in [pages/forge.html](../pages/forge.html) are now written at the 64-character cap, so first paint reserves the row's worst case. Both rows carry `data-no-i18n`, which keeps `scripts/i18n-annotate.mjs` from re-adding the attribute the section above exists to remove. The generated replacements are English at every locale, so a translated label was only ever visible for the instant before it was overwritten.
- `generateForgeChipSet()` in [src/forge-prompt-gen.js](../src/forge-prompt-gen.js) fits a rotation inside the character budget of the labels it replaces, so it can never exceed the reservation. It walks the candidate pool in generated order to keep the row varied, accepting a prompt only while the shortest remaining candidates could still fill the leftover slots.
- `pinRowHeight()` holds the row at its measured height across the swap, so a rotation that wraps onto *fewer* lines cannot shift the page upward either. The pin is released on the first resize, which relayouts the page anyway.

[tests/forge-prompt-gen.test.js](../tests/forge-prompt-gen.test.js) reads the labels out of `pages/forge.html` rather than copying them, so shortening the shipped copy fails the suite instead of silently restoring the shift.

Verified against the live page's own CSS by replacing the row's contents and measuring its height, six viewport widths, sixty random rotations each. The growth column is what the page shifts by:

| Viewport | Reserved, before | Seeded, before | Growth | Reserved, after | Seeded, after | Growth |
|---|---|---|---|---|---|---|
| 1440px | 99px | 202px | **103px** | 202px | 202px | **0px** |
| 1350px | 99px | 202px | **103px** | 202px | 202px | **0px** |
| 1024px | 63px | 99px | **36px** | 99px | 99px | **0px** |
| 768px | 64px | 167px | **103px** | 133px | 133px | **0px** |
| 390px | 194px | 295px | **101px** | 295px | 295px | **0px** |
| 320px | 244px | 295px | **51px** | 295px | 295px | **0px** |

**A static placeholder is a space reservation before it is copy.** If JavaScript is going to replace it, size the placeholder like the thing that replaces it, and make the replacement fit.

## 7. The hero's model is chosen inside a byte budget

**Invariant: code that picks a GLB for a fixed slot picks it by size, not by whatever the feed returns first.**

The homepage hero calls `/api/avatars/featured` and rendered the first entry that resolved. That list is curated by editorial flag and view count, and its members range from a **90 KB prop to a 10.7 MB scan**. On 2026-09-04 the first entry was a 4.6 MB model, which is 4.6 MB of download, parse and GPU upload landing on the critical path of every homepage visit, while the page is still trying to become interactive. A Lighthouse desktop trace measured **29,660ms of total blocking time**, against **9,649ms** for the same page with only `*.glb` withheld. The hero was two thirds of the page's blocking time and 4.6 MB of its 6.9 MB.

Nothing about that was a scheduling problem. The hero is the above-the-fold LCP element and is correctly eager (see rule 4's exception); the defect was that no one chose how heavy it was allowed to be.

[api/avatars/featured.js](../api/avatars/featured.js) now reports each candidate's `size_bytes`, the column the detail endpoint already returned, so the choice is made from one response instead of a detail fetch per candidate. `resolveFeaturedGlb()` in [src/home-live-agents.js](../src/home-live-agents.js) takes the **largest** candidate inside a 2.5 MB budget, which is the richest model the page can afford, and falls back to the smallest when nothing fits, because an over-budget hero that renders beats an empty stage. Candidates the API reports no size for keep their curated order behind the sized ones; over-budget candidates stay in the list as fallbacks, so an outage of the affordable ones still fills the stage.

Verified against the live featured list: the old code took a 3.71 MB model, the new code takes a 2.06 MB rigged, textured, animated humanoid, and every one of the twelve candidates is still reachable in order with no duplicates.

**The budget is a product lever, not just a performance one.** It is `HERO_GLB_BUDGET_BYTES`, one named constant, and raising it is a decision about how much of the first visit the hero is allowed to spend. Curating a heavier avatar into the featured list no longer silently makes that decision for everyone.

## 8. Deferred work waits for a quiet main thread, not for a deadline

**Invariant: a feature deferred for performance reasons resumes when the thread is actually free. `requestIdleCallback(fn, { timeout })` is a deadline, and it fires whether or not the thread ever went idle.**

The walk companion auto-summons for a first-time visitor: it loads Three.js core and addons (616 KiB), an avatar GLB, the shared clip library (`idle.json` alone is 421 KiB) and starts a WebGL render loop. It was scheduled `setTimeout(2000)` after `load`, then `requestIdleCallback(summon, { timeout: 4000 })`. The timeout is the bug. On a page that is still executing its own long tasks the callback fires anyway, so the companion's boot does not run *instead* of the page's work, it runs *on top of* it and both get slower. A Lighthouse desktop trace attributed **25,468ms of bootup on `/forge`** to `walk-companion.js`, the single largest entry on that page, and the same page measured with the companion off scored **71 against 43**.

[public/nav.js](../public/nav.js) now waits for real quiet: a `PerformanceObserver` on `longtask` entries, and the summon runs on the first idle callback after 1.2s with no long task. If the page never goes quiet within 20s the companion is simply not summoned there, and that is the intended outcome rather than a failure. The visitor's choice stays unrecorded, so the next page they open (or the nav's Walk button) summons it then. The promise is that their agent turns up on its own, not that it turns up while the page is still loading. Browsers without the `longtask` entry type (Safari) keep the old single deferred callback, because there is no way for them to tell busy from idle.

Verified in a browser against the dev server: `/create` and `/forge` still auto-summon (`walk:companion:enabled` becomes `1`, `walk-companion.js` is fetched, `window.__walkCompanion` exists), and a measurement of the same pages puts the first 1.2s quiet gap at **1,386ms after `load` on `/forge`**, so the wait costs a healthy page almost nothing and only bites the pages that were being hurt.

**The same shape is worth auditing wherever it appears.** Rule 2's PostHog snippet uses a 2s deadline for the same reason, and it is a defensible trade there: analytics has a blind spot to cap, and 89 KiB is an order of magnitude less than a 3D engine. The rule is not "never use a timeout", it is "know which one you are writing, and size the deadline against what fires when it expires."

### The site footer is the lowest thing on every page, so its 3D bot loads last

The rule above was written about sections. The most expensive violation of it was not a section at all: it was the decorative robot in the site footer, and it was costing more than everything the rule had already caught.

[public/footer.js](../public/footer.js) injects `/footer.html` into any page holding `<div id="footer-container">`, which is roughly 175 pages. That markup contains `#footer-bot-canvas`, and the injector booted its renderer immediately, at `DOMContentLoaded`, down one of two branches:

- A page carrying `<meta name="has-three-bundle">` (every Vite-built page) loaded `/footer-bot.js`, which builds a `WebGLRenderer`, claims a context off the shared budget in [src/webgl-budget.js](../src/webgl-budget.js), and loads `robotexpressive.glb`.
- A plain HTML page (login, register, the dashboard, `/docs`, `/discover`) instead pulled **`model-viewer` from `ajax.googleapis.com`, a second complete 3D engine**, plus the meshopt shim and the same GLB.

Measured against production on 2026-08-15, that decoration was the single largest main-thread consumer on the page it landed on:

| Page | Branch | Cost, eager |
|---|---|---|
| `/forge` | `footer-bot.js` | **19,654ms** of bootup, more than the page's own bundle (1,473ms) |
| `/docs` | `model-viewer` | 839ms of bootup and 253 KiB transferred, on a 701 KiB page |
| `/create` | `footer-bot.js` | 107 KiB GLB plus a WebGL context, on a page already running Three.js |

`loading="lazy"` on the `<model-viewer>` element did not help, and could not: it defers the *model*, while the 253 KiB module that defines the element had already been fetched and evaluated.

Both branches now sit behind `whenNearViewport()` in the same file, an `IntersectionObserver` on `.h-footer-avatar` at `rootMargin: '600px 0px'`, so the bot loads a screenful before the footer arrives and is rendered by the time it is on screen. Browsers without `IntersectionObserver` load it on the first scroll instead, so it still appears on the way down rather than never.

Verified by loading the real production pages twice in the same browser, the second time with only `/footer.js` swapped for the working-tree file, then scrolling to the footer to confirm the bot still arrives:

| Page | Transferred, before | after | Long tasks, before | after | Footer bot loaded on open | after scrolling |
|---|---|---|---|---|---|---|
| `/docs` | 675 KiB | **426 KiB** | 62ms | **17ms** | yes | yes |
| `/forge` | 7,379 KiB | 7,283 KiB | 426ms | **138ms** | yes | yes |
| `/create` | 2,215 KiB | **1,528 KiB** | 8,422ms | **2,510ms** | yes | yes |

Deferring it also fixes an ordering bug nobody had filed. The footer bot reserved a WebGL context at `DOMContentLoaded`, ahead of the `<agent-3d>` instances the visitor came to look at; on a page near the browser's context limit the decoration could win and a real avatar lose. Now the content claims contexts first and the footer takes what is left, which is what `reserveWebGLContext()` was always for. The bot's own failure path already degrades to an empty canvas, so losing that race is silent and harmless.

**Anything injected into a shared chrome partial follows this rule too.** A cost paid in the footer is a cost paid on every page on the site, which makes it the most expensive place on the platform to be careless.

**Before you gate something, check where it actually is.** Paste this into DevTools:

```js
['dragon-canvas-wrap', 'home-forge', 'home-pose'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) console.log(id, Math.round(el.getBoundingClientRect().top + scrollY),
    'trigger at', innerHeight + 200);
});
```

---

## Open: three costs the 2026-08-15 sweep measured and did not fix

Each of these is the largest remaining number on the page it belongs to, and each one lands in a surface the sweep that found it had no business rewriting. They are recorded here with the measurement so the next pass starts from a number rather than a hunch.

**`/chat` is one 4,277 KiB JavaScript chunk.** The page makes 23 requests and `chat/assets/index-*.js` is 4,277 KiB of them; nothing renders until it has parsed, which is the entire story of its FCP (3,901ms desktop, 23,105ms mobile) and of an LCP that lands 140ms later. Blocking time is *one millisecond*, so no amount of deferring helps: the work is a single parse of a single chunk. [chat/vite.config.js](../chat/vite.config.js) sets no `manualChunks` and no `inlineDynamicImports`; the app simply imports everything statically from its entry, so Vite has nothing to split on. The fix is dynamic imports at the route and feature boundaries inside `chat/src`, which is a refactor of the sub-app rather than a build-config change.

**`/forge` showcase thumbnails are full-size renders.** Twelve images from `pub-*.r2.dev` account for **6,273 KiB of the page's 8,339 KiB**, averaging 520 KB each. They are the 768x768 PNGs that [api/\_lib/forge-thumbs.js](../api/_lib/forge-thumbs.js) generates (`THUMB_SIZE = 768`), painted into a 200px-tall box. `loading="lazy"` and `decoding="async"` are already set per rule 5, so this is not a scheduling problem, it is a format and size problem: the same renders as WebP at a display-appropriate size are roughly a tenth of the bytes. The fix has to change the generator, re-run the backfill cron over existing rows, and handle the `forge/thumb/<id>.png` key extension that `forgeThumbKeyFor()` and the stored `preview_image_url` values both encode. One outlier in the same trace is a data-freshness artifact rather than a bug: a 2,358 KiB `forge/<clientKey>/<id>.png` is the untouched original for a row the backfill has not reached yet.

**The brand mark is an 85 KB SVG rendered at 22 pixels.** `public/three.svg` and the byte-identical `public/favicon.svg` are 85,257-byte SVGs wrapping two 800x436 PNGs behind `feColorMatrix` filters. They are referenced from 171 files, cost 62 KiB over the wire per page, and no call site in the repo renders the mark above 64 CSS px. Re-encoding the embedded rasters at exactly half resolution (800 to 400, lanczos3, no palette quantization) takes the file to 36,913 bytes and is visually indistinguishable at every size the site uses, with a maximum channel delta of 4 at 22px and 10 at 64px. It is not free above that: at 192px, which some platforms use for an SVG favicon, the delta reaches 105. Fractional downscales are much worse than the exact half (320px wide measured a delta of 78 at 22px), so this is a brand-asset decision with a measured cost attached, not a mechanical resize, and it needs the owner rather than a sweep.

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
