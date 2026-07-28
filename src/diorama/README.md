# src/diorama

Frontend for `/diorama`: one sentence becomes a tiny explorable 3D world. The
user types "a cozy autumn campsite by a lake at dusk", Claude decomposes it
into a placed scene plan (mood, palette, ground, island shape, and a handful of
single-object forge prompts), each object is forged into a real GLB on the free
text to 3D lane, and the world materializes progressively on a floating island
the user can orbit, save, share, and remix. Saved worlds land on a public
gallery wall with permalinks.

Entry page: [pages/diorama.html](../../pages/diorama.html) (served at
`/diorama`, wired in `vite.config.js`). Backend:
[api/diorama.js](../../api/diorama.js) (compose + save + list + load) over
[api/_lib/diorama-store.js](../../api/_lib/diorama-store.js). Product doc:
[docs/diorama.md](../../docs/diorama.md). Surface row:
[STRUCTURE.md](../../STRUCTURE.md).

## Why this exists

Forging a single model (`/forge`) is a transaction; a diorama is a place. This
module set turns the existing forge lane into a scene-level creative tool
without any new generation backend: the only new server work is the LLM compose
call and gallery persistence. The design constraint that shapes everything here
is progressive materialization: a plan is renderable before any mesh exists
(objects show as luminous "forming" seeds), a failed object never sinks the
world, and partial worlds are real and shareable.

## Layout

```
src/diorama/
├── schema.js      The shared data contract: shapes, bounds, validators, sample world (pure, no DOM/Three)
├── compose.js     Orchestration: compose plan via /api/diorama, forge each object via /api/forge
├── renderer.js    Three.js stage: island, sky, mood lighting, seeds, GLB materialization, thumbnails
├── gallery.js     Public wall of saved worlds (GET /api/diorama?list=recent)
├── share.js       Share sheet: permalink copy, X intent, iframe embed snippet
├── main.js        Page controller (the only script entry); wires the DOM contract in pages/diorama.html
└── diorama.css    Page styles
```

`schema.js` is the single source of truth for the `Diorama` shape. Every other
module (and the API) imports its constants and validators so they cannot drift.
A `Diorama` is a plan first (objects with prompts and placement, no meshes) and
a populated world second (each object gains a `glbUrl` once forged).

## Exports

`schema.js` (pure data, safe to import server-side):

| Export | What it is |
| --- | --- |
| `MOODS`, `GROUNDS`, `ISLANDS` | Allowed values for `mood`, `ground`, `island` |
| `MAX_OBJECTS`, `MIN_OBJECTS`, `MAX_PROMPT_LEN`, `ISLAND_RADIUS` | Bounds; a diorama is a miniature, 3 to 8 objects on a 6.2 m island |
| `MOOD_LIGHT` | Per-mood sun/ambient/fog presets the renderer reads |
| `normalizeDiorama(input)` | Validate + normalize untrusted input; returns `{ ok, diorama, errors }`, never throws |
| `defaultPalette(mood)`, `coercePalette(p, mood)` | Palette fallbacks and coercion |
| `titleFromPrompt(prompt)` | Derive a short Title Case title |
| `isComplete(diorama)`, `forgeProgress(diorama)` | Forge completion checks (progress 0..1) |
| `SAMPLE_DIORAMA` | Frozen hand-authored sample world for local dev and empty-state previews |

`compose.js`:

| Export | What it is |
| --- | --- |
| `composeWorld(prompt, { onPlan, onObject, signal })` | Compose the plan, then forge every object with bounded concurrency (3 at a time); resolves to the populated diorama |
| `forgeObject(object, { signal, onObject })` | Forge one object's mesh; resolves `{ status, glbUrl }`, never throws on forge failure (used for per-object retry) |
| `CLIENT_ID` | Stable per-browser id sent as `x-forge-client` to scope forge jobs |

`renderer.js`:

| Export | What it is |
| --- | --- |
| `createDioramaRenderer(container, opts)` | Bind the WebGL stage to a container. Returns `{ setDiorama, materializeObject, markFailed, frame, startAutoOrbit, getActiveGlbUrls, resize, dispose }` plus `scene`/`camera`/`renderer` getters as escape hatches |
| `renderThumbnail(canvas, diorama)` | One-shot preview render (island + mood sky + first forged GLBs); resolves to a dispose function |

`gallery.js`:

| Export | What it is |
| --- | --- |
| `mountGallery({ listEl, emptyEl, onOpen, limit })` | Wire the gallery grid to `GET /api/diorama?list=recent`; returns `{ reload }` |

`share.js`:

| Export | What it is |
| --- | --- |
| `openShare({ diorama, url })` | Populate the share sheet (`#share-panel` in the page) with the saved permalink; wires copy, X intent, and iframe-embed actions. Idempotent |

`main.js` exports nothing; it is the page entry that wires all of the above to
the DOM contract documented in [pages/diorama.html](../../pages/diorama.html).

## Usage

There is nothing to install; these are plain ES modules bundled by the repo's
Vite build. Run the page locally with `npm run dev` and open
`http://localhost:3000/diorama`.

The core loop, exactly as `main.js` drives it: create the renderer, hand the
plan to the stage the moment it exists, then materialize each mesh as its forge
settles.

```js
import { createDioramaRenderer } from './renderer.js';
import { composeWorld } from './compose.js';

const renderer = createDioramaRenderer(document.querySelector('#diorama-stage'), {});

const diorama = await composeWorld('a cozy autumn campsite by a lake at dusk', {
  // Called once the plan returns, before any mesh exists: the island, sky,
  // and per-object seeds render immediately.
  onPlan: (plan) => renderer.setDiorama(plan),
  // Called as each object moves through forging, then ready or failed.
  onObject: (objectId, patch) => {
    if (patch.status === 'ready') renderer.materializeObject(objectId, patch.glbUrl);
    if (patch.status === 'failed') renderer.markFailed(objectId);
  },
});
// diorama.objects now carry status + glbUrl; a partial world is still valid.
```

Pass an `AbortController`'s signal as `opts.signal` to cancel the compose and
all in-flight forges cleanly (`composeWorld` and `forgeObject` propagate
`AbortError`; every other forge failure is absorbed into `status:'failed'`).

## Backend contract

All calls go through two endpoints; this directory owns no server code:

- `POST /api/diorama` with `{ action:'compose', prompt }` returns the
  LLM-planned `{ diorama }`. The same handler serves `?list=recent` for the
  gallery, `?id=<uuid>` for permalinks, and save. See
  [api/diorama.js](../../api/diorama.js).
- `POST /api/forge` with `{ prompt, tier:'draft', path:'image' }` forges one
  object on the free lane; queued jobs are polled via `GET /api/forge?job=<id>`
  every 2.5 s with a 3 minute per-object deadline.

Responses are untrusted until they pass `normalizeDiorama`; the renderer only
ever sees a guaranteed-renderable object.

## Rendering notes

- Forged GLBs may be Draco or meshopt compressed. The Draco decoder path is
  `/three/draco/`, staged by the repo postinstall
  ([scripts/copy-three-decoders.mjs](../../scripts/copy-three-decoders.mjs));
  the meshopt decoder is awaited before the first GLB load.
- Objects normalize to about 1.4 m so a handful read as a cohesive miniature;
  placement is clamped to the island disc (`ISLAND_RADIUS`) by the schema.
- `prefers-reduced-motion` is respected (no auto-orbit, calmer materialization).
- `renderThumbnail` owns its own renderer and returns a dispose function; call
  it when the preview leaves the DOM or you leak WebGL contexts.
