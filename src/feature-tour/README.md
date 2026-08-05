# src/feature-tour

Site-native guided-tour engine for three.ws. A small always-on-top 3D avatar walks across the real page, spotlights the feature being discussed, points at it with a beam, and narrates a line about it, stop by stop, across the whole multi-page site. It drives the `/tour` experience ([../../pages/tour.html](../../pages/tour.html)) and the three tracks (full, quick, onboarding) defined by [../../public/tour/curriculum.json](../../public/tour/curriculum.json).

## Why this exists

This is a hardened, site-native fork of the publishable [../../tour-sdk](../../tour-sdk) engine (same curriculum schema: stops, sections, tracks, highlight, narration, targets). Keeping our own copy lets the platform tour evolve with the site (platform TTS lane, walk-sdk avatar roster, onboarding auto-offer) without forcing a package release, while the SDK stays a clean product for external sites. The curriculum itself is generated at deploy time by [../../scripts/build-tour.mjs](../../scripts/build-tour.mjs) from `data/pages.json`, so new pages join the tour automatically.

The engine survives full-page navigation: live state (active, stop index, paused, muted, voice, speed) lives in `sessionStorage` under `tws:tour:state`, so when the next stop is on another route the director persists progress, navigates, and the new page rehydrates exactly where it left off. Durable cross-session memory (resume point, preferences, completion) lives in `localStorage` under `tws:tour:resume`.

## How it loads (nobody pays for Three.js by default)

Nothing here is in the main bundle. The entry file [../feature-tour.js](../feature-tour.js) is emitted by Vite to the stable, unhashed path `/feature-tour.js`, and the `feature-tour-boot` plugin in [../../vite.config.js](../../vite.config.js) injects a tiny inline check into every page that only appends `<script type="module" src="/feature-tour.js">` when a tour is starting (`?tour=start` or `?tour=1`) or already active in `sessionStorage`. Pages that never tour load zero tour code.

Launch surfaces:

- `/tour` ([../../pages/tour.html](../../pages/tour.html)): track pickers that navigate to the first stop with `?tour=start` (plus `&track=quick`), and explore mode via `?tour=start&mode=explore` or `&mode=platformer`.
- Onboarding: auto-offered once to a signed-in account with zero creations (`GET /api/me` returns `show_onboarding_tour`), and always reachable via the "Replay guided tour" link in the getting-started checklist ([../../public/getting-started.js](../../public/getting-started.js)), which navigates to `/start?tour=start&track=onboarding`.
- Programmatic: anything on the page can call `window.__featureTour.start('quick')` once the module is loaded.

## Tracks

A track is a playlist: an ordered list of curriculum stop indices, derived by `buildPlaylist()` in [curriculum.js](./curriculum.js).

| Track | What it plays |
| --- | --- |
| `full` | Every general site stop (`section !== 'onboarding'`), chapter by chapter. |
| `quick` | The full track's `highlight: true` heroes only. |
| `onboarding` | The 6-stop hand-authored new-account walkthrough (`section === 'onboarding'`): `/start`, avatar, world, markets, optional coin launch, own profile. Its stops are excluded from `full`/`quick` so the curricula never bleed together. |

An unknown track or an empty filter falls back to the full non-onboarding list, so the tour can never strand itself with nothing to play.

## Layout

```
src/feature-tour/
├── index.js         createFeatureTour(): the public control surface + bootstrap()
├── director.js      TourDirector: sequencing brain; owns every stop, control, and cross-route hop
├── curriculum.js    Curriculum fetch + sessionStorage/localStorage state + pure playlist helpers
├── guide-avatar.js  GuideAvatar: the 3D guide (walk-sdk rig; walks, faces, gestures, speech bubble)
├── spotlight.js     Spotlight: dims the page and rings the element being discussed
├── narrator.js      Narrator: platform TTS (/api/tts/speak) with paced-caption fallback, iOS unlock
├── controls.js      TourControls: playback bar (prev / play-pause / next / speed / roam / mute / exit)
├── chapters.js      ChapterPanel: registry-style stop listing (title, narration summary, path) with search across all three, track/voice/speed/avatar settings; docked drawer or drag-to-float panel with a remembered position
├── free-roam.js     FreeRoam: paused mode where the visitor clicks/drags/keys the guide around
└── explore.js       ExploreMode: visitor-driven checkpoint quest on the real walk-sdk playground
```

The guide avatar and explore locomotion reuse [../../walk-sdk](../../walk-sdk) internals (same rigs and clips as the Walk Companion), so the guide can never freeze in a T-pose.

## Public API

The surface everything else relies on is the control object returned by `createFeatureTour()` ([index.js](./index.js)):

| Member | What it does |
| --- | --- |
| `start(track)` | Start (or restart) the guided tour on `'full'`, `'quick'`, or `'onboarding'`. |
| `startExplore(movement)` | Start the interactive checkpoint mode; `'stroll'` (default) or `'platformer'`. |
| `resume()` | Rehydrate an in-progress tour from `sessionStorage`. |
| `exit()` | Tear down whichever mode is active. |
| `isActive()` | True when a guided tour or explore session is live. |
| `bootstrap()` | Honor the `?tour=start|1|0` deep link and auto-resume; safe to call once on load; no-op inside iframes. |
| `director` / `explore` | The live `TourDirector` / `ExploreMode` instance, or `null` before first use. |

Importing is side-effect free: nothing mounts until `bootstrap()` or `start()` runs.

[curriculum.js](./curriculum.js) additionally exports the pure helpers the tests and director share: `loadCurriculum()`, `buildPlaylist(curriculum, track)`, `trackMeta(curriculum, track)`, `stopIndexForPath(curriculum, pathname, playlist)`, `sectionTitle(curriculum, id)`, `normalizePath(pathname)`, and the state accessors `readState()`, `writeState(patch)`, `clearState()`, `readResume()`, `writeResume(patch)`, `markCompleted()`.

## Usage

The platform wiring, verbatim from [../feature-tour.js](../feature-tour.js), is the canonical example:

```js
import { createFeatureTour } from './feature-tour/index.js';

const tour = createFeatureTour();

// nav.js (the "Take the tour" button) and the /tour page launch + resume the
// tour through this global. Keep the surface they rely on.
window.__featureTour = tour;

tour.bootstrap();
```

To see it run locally: `npm run dev`, then open `http://localhost:3000/?tour=start&track=quick` (the dev server rewrites `/feature-tour.js` to the entry file [../feature-tour.js](../feature-tour.js) and the boot plugin injects it because of the `?tour=start` param).

## Tests

- [../../tests/feature-tour-curriculum.test.js](../../tests/feature-tour-curriculum.test.js) covers the playlist/state helpers and the generated curriculum's shape.
- [../../tests/api-me-onboarding-tour.test.js](../../tests/api-me-onboarding-tour.test.js) covers the `show_onboarding_tour` auto-offer flag.

Run with `npm test`.

## Related

- [../../STRUCTURE.md](../../STRUCTURE.md): the row "three.ws's own guided tour + onboarding" maps this surface.
- [../../tour-sdk](../../tour-sdk): the publishable `@three-ws/tour` package this engine forked from.
- [../../scripts/build-tour.mjs](../../scripts/build-tour.mjs): regenerates [../../public/tour/curriculum.json](../../public/tour/curriculum.json) at deploy time.
