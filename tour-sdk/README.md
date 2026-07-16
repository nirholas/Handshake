# @three-ws/tour

> A **3D guide that walks your live site and narrates it.** A small avatar walks across the real page, spotlights each feature, points at it with a beam, and speaks a line about it — a guided product tour that runs on your actual DOM, not a slideshow. Powered by [Three.js](https://threejs.org) and [@three-ws/walk](https://www.npmjs.com/package/@three-ws/walk).

The guide walks from feature to feature across your real pages. At each stop it
dims the page, rings the element it's talking about, walks over and gestures at
it, and narrates a line — with synthesized voice if you wire a TTS endpoint, or
paced captions if you don't. It **survives full-page navigation** (state lives in
`sessionStorage`), so a tour can span your whole multi-page app and pick up
exactly where it left off on the next route. Visitors get a playback bar
(prev / play / next / speed / mute), a searchable **chapter map**, **Quick** vs
**Full** tracks, and a **free-roam** mode to drive the guide themselves.

This is the engine behind the guided tour on [three.ws](https://three.ws).

---

## One-tag install (CDN)

No bundler, no import map — one script tag on any site you can edit
(including a Shopify `theme.liquid`, a WordPress theme, or plain HTML):

```html
<script src="https://unpkg.com/@three-ws/tour/dist/tour.global.js"
        data-tour
        data-curriculum="https://your-cdn.example.com/tour/curriculum.json"
        defer></script>
```

`tour.global.js` is a self-contained IIFE (Three.js and `@three-ws/walk`
inlined) exposed as `window.ThreeWsTour`. With `data-tour` it auto-creates a
tour from the tag's attributes, exposes it as `window.__featureTour`, calls
`bootstrap()` (so `?tour=start` deep links work), and turns every
`[data-tour-start]` element on the page into a start button
(`data-tour-start="quick"` for the Quick track) — including elements added
after load.

| Attribute | Default | Maps to |
| --- | --- | --- |
| `data-curriculum` | — (required) | `curriculum` URL |
| `data-avatar` | `realistic-female` | `guideAvatarId` |
| `data-asset-base` | `https://three.ws` | `assetBase` |
| `data-manifest-url` | `https://three.ws/animations/manifest.json` | `manifestUrl` |
| `data-tts-endpoint` | off (paced captions) | `ttsEndpoint` |
| `data-mode` | `guided` | `guided` (avatar walks itself), `explore` (visitor drives it to checkpoints), or `platformer` (explore with gravity + jumping) |
| `data-autostart` | off | `full` \| `quick` — start on load |

**Explore mode** (`data-mode="explore"`, or `{ mode: 'explore' }`): instead of
the avatar walking itself, the visitor drives it with arrow keys / WASD (or an
on-screen joystick on touch) to glowing GTA-style checkpoints anchored to each
stop's section. Walking into the active checkpoint stops the guide to spotlight
and narrate that section, then the next lights up. Same curriculum, same
`targets`, same avatars. It runs on the stops resolvable on the current page;
reduced-motion visitors get the checkpoints auto-walked.

**Platformer mode** (`data-mode="platformer"`, or `{ mode: 'platformer' }`): the
same checkpoint experience with the @three-ws/walk platformer physics — the
page's real DOM (headings, cards, buttons, images) becomes solid ground, and the
visitor runs and **jumps** (Space) from element to element to reach each
checkpoint. In either interactive mode the visitor can flip between the two
movement models mid-tour with the **M** key or the on-screen mode pill;
checkpoints and progress carry across the switch.

Asset defaults point at the three.ws CDN, so the tag works with zero
configuration. Building a store tour? See the step-by-step Shopify guide:
[three.ws/tutorials/shopify-store-guide](https://three.ws/tutorials/shopify-store-guide).
A complete runnable storefront demo ships with the package —
[`examples/shopify-storefront.html`](./examples/shopify-storefront.html)
(`npx serve tour-sdk`, then open `/examples/shopify-storefront.html`).

---

## Install (npm)

```bash
npm install @three-ws/tour @three-ws/walk three
```

`three` and `@three-ws/walk` are **peer dependencies** — bring your own copies
(`three` >= 0.150, `@three-ws/walk` >= 0.1). You also need to serve the avatar
assets `@three-ws/walk` needs (avatar GLBs + the shared animation manifest) — see
that package's README. Point the tour at them with `assetBase` / `manifestUrl`.

---

## Quick start

```js
import { createFeatureTour } from '@three-ws/tour';

const tour = createFeatureTour({
  curriculum: '/tour/curriculum.json', // what to visit + say (see below)
  ttsEndpoint: '/api/tts/speak',       // optional — omit for silent captions
});

// Let a "Take the tour" button anywhere on the site start it:
document.querySelector('#take-the-tour')?.addEventListener('click', () => tour.start());

// Honour deep-links (?tour=start / ?tour=1) and rehydrate an in-progress tour
// on every page load. Call once, early.
tour.bootstrap();
```

Because the tour spans pages, load this module on **every** page (or lazy-load it
when a tour starts / is in progress) and call `bootstrap()` so it re-hydrates
after each navigation. Expose the controller globally if your nav button lives in
a different bundle:

```js
window.__featureTour = tour;
```

### Deep links

With the default `deepLinkParam: 'tour'`:

| URL | Effect |
| --- | --- |
| `?tour=start` | Begin the Full tour (`&track=quick` for the Quick track) |
| `?tour=1` | Resume an in-progress tour |
| `?tour=0` | Exit the tour |

---

## The curriculum

A tour is driven by a **curriculum** — a JSON document describing what the guide
visits and what it says. Each stop is a route plus a line of narration, grouped
into chapters and split into tracks. The full schema is in
[`curriculum.schema.json`](./curriculum.schema.json); a minimal one:

```json
{
  "tracks": [
    { "id": "full",  "title": "Full tour" },
    { "id": "quick", "title": "Quick highlights" }
  ],
  "sections": [
    { "id": "main", "title": "Overview", "intro": "Welcome — let me show you around." }
  ],
  "stops": [
    {
      "path": "/",
      "section": "main",
      "title": "Home",
      "narration": "Here's the front door — start a project right from here.",
      "highlight": true,
      "targets": ["a.cta", ".hero a.button"]
    }
  ]
}
```

- **`path`** — the route the stop lives on. The tour navigates there when needed.
- **`narration`** — what the guide says.
- **`targets`** — ordered CSS selectors for the element to spotlight; the first
  visible match wins. If none match, the guide falls back to the page heading /
  primary call-to-action. You can also tag an element with `data-tour-target` in
  your HTML instead of listing selectors.
- **`highlight`** — include this stop in the **Quick** track.
- **`sectionIntro`** — a spoken chapter bridge (usually on the first stop of a
  section).

Pass it as a URL (`curriculum: '/tour/curriculum.json'`) or inline
(`curriculum: { stops: [...] }`).

### Generating a curriculum from your pages

If you already maintain a sitemap / pages manifest, generate the curriculum
instead of hand-writing it. `buildCurriculum()` turns a pages document into a
curriculum; narration comes from each page's own description, so it stays
truthful as your site changes.

```js
import { buildCurriculum } from '@three-ws/tour';

const curriculum = buildCurriculum(pagesDoc, {
  sectionOrder: ['main', 'build', 'learn'],
  sectionIntros: { main: "Welcome — let's start at the front door." },
  sectionHeroes: { main: ['/', '/pricing'] },   // shown first + seed the Quick track
  targets: { '/': ['a.cta'] },
  deny: ['/login', '/legal'],                    // skip these paths
  quickPerSection: 3,
  title: 'Acme Guided Tour',
});
```

Or from the command line in a build step / CI:

```bash
# generate
tour-build-curriculum --pages pages.json --config tour.config.json --out public/tour/curriculum.json

# fail the build if the committed curriculum is stale
tour-build-curriculum --pages pages.json --config tour.config.json --out public/tour/curriculum.json --check
```

The input `pagesDoc` is `{ sections: [{ id, title, pages: [{ path, title, description, added, auth }] }] }`.

---

## Narration (TTS)

Set `ttsEndpoint` to a URL that accepts `POST { text, voice, speed, format }` and
returns an audio response (e.g. `audio/mpeg`). The narrator plays it and advances
the tour when it ends. The voice picker in the chapter panel sends the chosen
`voice` id; customise the list with the `voices` option.

**No endpoint?** The tour still runs — narration becomes captions paced to the
reading time of each line. The same graceful fallback kicks in if a request
fails, so a flaky TTS service never breaks the tour.

---

## Options

| Option | Default | Description |
| --- | --- | --- |
| `curriculum` | `'/tour/curriculum.json'` | URL to fetch, or an inline curriculum object. |
| `ttsEndpoint` | `null` | `POST { text, voice, speed, format }` → audio. Omit for silent captions. |
| `defaultVoice` | `'nova'` | Default narration voice id. |
| `voices` | built-in set | `[{ id, name }]` shown in the voice picker. |
| `guideAvatarId` | `'realistic-female'` | Avatar the guide loads (a `@three-ws/walk` roster id, or your own). |
| `assetBase` | `''` | Base URL for avatar GLB assets. |
| `apiBase` | `''` | Base URL for the avatar GLB proxy (user-generated avatars). |
| `manifestUrl` | `'/animations/manifest.json'` | Shared-animation manifest URL. |
| `avatarStorageKey` | `'walk:companion:avatar'` | localStorage key for the visitor's chosen avatar, so the guide matches their Walk Companion. |
| `navigate` | `location.assign` | How to move between routes — override for an SPA router. |
| `deepLinkParam` | `'tour'` | Query param `bootstrap()` reads. |
| `companion` | `{ global: '__walkCompanion', changeEvent: 'walk-companion:change' }` | De-dupes the on-screen avatar by standing down a `@three-ws/walk` companion during the tour. Set `false` to disable. |
| `storagePrefix` | `'tws:tour'` | Prefix for the tour's sessionStorage/localStorage keys. |
| `copy` | neutral defaults | Override the outro, off-route message, and completion card (`title`, `body`, `primary: { label, href }`, `restartLabel`, `closeLabel`). |

### SPA routers

`location.assign` triggers a real navigation. If your app is a client-side SPA,
pass `navigate` so stop-to-stop transitions use your router:

```js
createFeatureTour({
  curriculum,
  navigate: (path) => router.push(path),
});
```

The tour re-hydrates from storage after each navigation, so your router just
needs to land on the new path — `bootstrap()` (or a `resume()` call on route
change) does the rest.

---

## API

```js
const tour = createFeatureTour(options);

tour.start('quick' | 'full'); // begin a tour
tour.resume();                // re-hydrate an in-progress tour after navigation
tour.exit();                  // tear everything down
tour.isActive();              // boolean — is a tour running?
tour.bootstrap();             // honour the deep-link param + rehydrate
tour.director;                // the live TourDirector (once one exists)
tour.config;                  // the fully-resolved config
```

Also exported for advanced/standalone use: `TourDirector`, `resolveTourConfig`,
`buildCurriculum`, `buildPlaylist`, `trackMeta`, `loadCurriculum`,
`createTourState`, `stopIndexForPath`, `sectionTitle`, `normalizePath`,
`DEFAULT_VOICES`, `DEFAULT_COPY`, `VERSION`.

---

## Keyboard & accessibility

- **Space / K** play-pause · **← / →** prev / next · **M** mute · **C** chapter
  map · **R** free roam · **Esc** close menu / exit.
- The playback bar, chapter map, and completion card use semantic roles, ARIA
  labels, focus-visible rings, and a live progress slider.
- Honours `prefers-reduced-motion` throughout (no walk glide, no pulse, instant
  spotlight).
- Degrades gracefully: if WebGL or the avatar GLB fails to load, captions, the
  spotlight, and the pointer beam still work — the guide just loses its body.

---

## How it works

`createFeatureTour()` resolves your options and returns a thin controller. The
`TourDirector` walks a **playlist** (the stop indices for the chosen track),
resolving each stop's on-page target, spotlighting it (`spotlight.js`), walking
the `GuideAvatar` over to point at it, drawing the pointer beam, and speaking via
the `Narrator`. Cross-page state lives in `sessionStorage` (live sequencing) and
`localStorage` (durable resume + preferences). The chapter map, playback bar, and
free-roam are independent UI modules the director coordinates.

The guide avatar reuses `@three-ws/walk`'s loader and animation retargeting, so
any humanoid rig animates correctly and never freezes in a T-pose.

---

## License

All rights reserved. See [LICENSE](./LICENSE).
