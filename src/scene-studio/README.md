# src/scene-studio

Scene Studio, the full 3D scene editor served at [`/scene`](../../pages/scene.html).
Import GLB models, arrange them with transform gizmos, edit materials and lights,
script objects, play the scene, and export the result as GLB, USDZ, or a
publishable app zip.

## Why this exists

Building a scene editor from scratch is a solved problem: the three.js project
ships one. Instead of reinventing it, this directory vendors the upstream
`editor/` from three.js r184 (MIT, see [vendor/LICENSE](vendor/LICENSE)) and
wraps it with three thin sibling modules that adapt it to three.ws. The wrappers
never modify `vendor/**`; every local change to upstream files is documented in
[vendor/README.md](vendor/README.md) so re-vendoring on a three upgrade stays
mechanical.

The wrappers are what make it a three.ws surface rather than a mirror of the
upstream demo: models forged on `/forge` or `/parts` deep-link straight into the
scene, animations baked on `/pose` hand off through IndexedDB, and any composed
scene can be exported with one click or uploaded and embedded on another site.

## Layout

```
src/scene-studio/
├── main.js       Boot: mounts the vendored editor into #studio-app, wires
│                 autosave, drag-and-drop import, and the deep-link importers
├── loader.js     Shared GLB loader: Draco/KTX2/Meshopt-wired GLTFLoader that
│                 adds a parsed GLB through the undo-able AddObjectCommand path
├── actions.js    Layered action bar: Import from Forge, Export presets, Share
├── studio.css    three.ws chrome overrides (vendor css/main.css is untouched)
└── vendor/       three.js r184 editor source (see vendor/README.md)
```

Static runtime assets (Draco/Basis decoders, toolbar icons, CodeMirror and the
other classic-script libs, the publish-zip template) live under
[public/scene-studio/](../../public/scene-studio) and are documented in
[vendor/README.md](vendor/README.md). The classic-script libs load as plain
`<script>` tags in [pages/scene.html](../../pages/scene.html), exactly as
upstream's `index.html` does.

## Usage

There is nothing to install. The page is part of the main Vite app:

```bash
npm run dev        # then open http://localhost:3000/scene
```

[pages/scene.html](../../pages/scene.html) loads `/src/scene-studio/main.js` as
a module; `main.js` mounts the editor into the `#studio-app` container under the
site nav. The surface is dark-locked: the entry module re-pins
`data-theme="dark"` because the editor chrome only ships dark.

Scenes autosave to IndexedDB through the vendored `editor.storage` on every
geometry, material, script, or scene-graph change, so a reload restores the last
state. For debugging, `main.js` exposes `window.editor` and `window.THREE` in
the browser console.

### Deep links

- `/scene?model=<glb_url>&name=<label>` adds the GLB at that URL to the scene
  through the normal undo-able import path, then strips the query from the
  address bar so a reload does not import a duplicate. This is the "Open in
  Scene Studio" hand-off used by Forge and Parts Studio results. Only `https://`
  and same-origin `/` URLs are accepted.
- `/scene?handoff=1` pulls a baked GLB (mesh plus embedded animation clip) that
  the Animation Studio at `/pose` stashed in IndexedDB via
  [src/shared/scene-handoff.js](../shared/scene-handoff.js), adds it to the
  scene, and attaches a player script that drives an `AnimationMixer` so the
  clip plays in the timeline and records through Render, Video.
- `/scene#file=<url>` (upstream behavior) loads a serialized editor JSON scene
  after a confirmation prompt.

### Action bar

`actions.js` mounts a toolbar layered over the vendored chrome with three
affordances the stock File and Export menus do not offer on their own:

- **Import from Forge**: paste a GLB URL from a Forge or Parts Studio result and
  drop it straight into the scene.
- **Export presets**: one click for a Web GLB (binary, with cloned and optimized
  animation clips, identical to File, Export, GLB) or an AR bundle (.usdz for
  iOS Quick Look).
- **Share**: exports the scene as a GLB, uploads it via
  [api/scene-glb-upload.js](../../api/scene-glb-upload.js) (presigned PUT), and
  opens the platform's "Embed this model" panel from
  [src/forge-embed-panel.js](../forge-embed-panel.js), the same modal Forge
  results use.

## Exports

The wrappers export two functions; `main.js` is entry-only and exports nothing.

| Module | Export | What it does |
| --- | --- | --- |
| `loader.js` | `addGltfBufferToScene(editor, contents, label?)` | Parses a GLB `ArrayBuffer` with the Draco/KTX2/Meshopt-wired loader and adds it via `AddObjectCommand` (undo-able, autosave-triggering, outliner-visible). Resolves to the added `THREE.Object3D`. |
| `actions.js` | `mountStudioActions(editor, container)` | Mounts the Import from Forge / Export / Share bar into the studio container. Returns the bar element. |

## Example

This is how `actions.js` imports a Forge result into the scene, using the shared
loader (trimmed from `importFromForge` in [actions.js](actions.js)):

```js
import { addGltfBufferToScene } from './loader.js';

// `editor` is the vendored Editor instance (window.editor on /scene).
const url = window.prompt('Paste the GLB URL from a Forge result.');
const trimmed = url.trim();
const res = await fetch(trimmed);
if (!res.ok) throw new Error('HTTP ' + res.status);
const contents = await res.arrayBuffer();
const base = decodeURIComponent(trimmed.split('?')[0].split('/').pop() || '');
const label = (base.replace(/\.(glb|gltf)$/i, '') || 'Forge model').slice(0, 64);
await addGltfBufferToScene(editor, contents, label);
```

Both callers of the loader (the `?model=` deep link in `main.js` and the action
bar above) go through this one function, so a GLB added either way decodes and
behaves identically to a manual drag-and-drop import.

## Related surfaces

- [STRUCTURE.md](../../STRUCTURE.md) row: Scene Studio (3D scene editor).
- `/forge` and `/parts` produce the GLBs that deep-link here; `/pose` hands off
  baked animations; the Share flow reuses the Forge embed panel.
- The page entry in [data/pages.json](../../data/pages.json) (`path: "/scene"`)
  feeds the sitemap, `llms.txt`, and the changelog.
