# Scene Studio: the full three.js editor, in your browser

Scene Studio is the complete [mrdoob/three.js](https://github.com/mrdoob/three.js) editor (release r184, MIT-licensed), vendored into three.ws and wrapped in the site chrome. It is the heavyweight scene tool: import GLBs and other assets, move and rotate and scale them with transform gizmos, edit materials and lights and cameras through a full property sidebar, script objects with live JavaScript, play the scene, and export it. Where [Scene Composer](./compose.md) is a focused avatar-plus-props arranger and [Animation Studio](./animation-studio.md) is a posing and keyframing tool, Scene Studio is the general-purpose 3D authoring surface underneath them.

Page: [/scene](https://three.ws/scene)

## Why it exists

Most of the three.ws studios are purpose-built: one does avatars, one does poses, one does materials. That focus is a feature, but it leaves a gap for the times you want to just open a real 3D editor and build a scene with no rails. Rather than reinvent that, three.ws vendors the canonical three.js editor, the same tool the three.js project itself ships, and mounts it inside the platform so it inherits the nav, the theme, and the handoff plumbing. You get a mature, battle-tested editor with an object hierarchy, a scripting console, undo/redo, and glTF export, and it speaks the same GLB format every other three.ws surface produces and consumes.

## How it works

The editor is ported from the upstream `editor/index.html` with a small set of local changes: it mounts into a container under the site nav instead of taking over `document.body`, it drops the service worker, and it applies three.ws chrome overrides. It is dark-locked, because the vendored editor CSS only ships a dark theme. The core is the upstream `Editor` object driving the standard panels: `Viewport`, `Toolbar`, `Sidebar`, `Menubar`, `Player`, and the `Animation` timeline, all wired through the editor's signal bus.

- **Import.** Drag assets into the viewport or use the menubar's import. GLB/glTF load through the shared loader (`loader.js`), which decodes meshopt- and Draco-compressed buffers, so three.ws models load without extra steps. The editor also handles the other formats the upstream editor supports.
- **Transform.** Select an object in the hierarchy or viewport and use the translate/rotate/scale gizmos. The sidebar exposes exact numeric transforms.
- **Materials, lights, cameras.** The Object, Geometry, and Material tabs in the sidebar edit every property the three.js material and light models expose: color, metalness, roughness, maps, intensity, shadows, fog, background, and environment.
- **Scripting.** The editor bundles CodeMirror (with JavaScript and GLSL modes) and a Tern.js autocomplete engine seeded with three.js type definitions, so you can attach live scripts to objects and write shaders with completion.
- **Play and export.** The Player runs the scene (scripts included). The menubar exports the scene or selected objects to glTF/GLB, and the Draco encoder is bundled for compressed export.

### The three.ws layer

Four sibling modules sit on top of the vendored editor without touching `vendor/**`. They are the difference between a mirror of the upstream demo and a surface that belongs to this platform:

- **A quick-action bar** (top right, clear of the sidebar): **Import from Forge** takes a GLB URL from a [Forge](./forge.md) or Forge Max result and adds it through the same undo-able path as a drag-and-drop import; **Export** writes a Web GLB or an AR bundle (`.usdz` for iOS Quick Look) in one click; **Share** uploads the scene and opens the platform's "Embed this model" panel with an iframe, web-component, and `<agent-3d>` snippet.
- **An empty state.** A brand-new scene holds nothing but the default camera, which renders as a bare grid. The overlay on that grid says what a starting point looks like (drag a `.glb` in, pick a primitive from **Add**, or import a model you already generated) and retires itself the moment the scene has content, including a scene restored from autosave.
- **Designed failures.** A dead link, a private URL, a blocked cross-origin fetch, or a failed upload each surface in the platform's toast with the likely cause named and a fallback to try, rather than in a native `alert()` box.
- **Accessible transform buttons.** The vendored translate/rotate/scale controls are icon-only `<button>`s; the studio gives them names read from the editor's own string table and mirrors the active mode into `aria-pressed`, so the gizmo mode is both announced and reachable by keyboard.

### Handoff from Animation Studio

Scene Studio is the render target for animations built in [Animation Studio](./animation-studio.md). When you click "Open in Scene Studio" there, the studio bakes your keyframed animation into a GLB, stashes it in IndexedDB, and navigates to `/scene?handoff=1`. Scene Studio picks the model up on boot (`takeSceneHandoff`), drops it into the scene with its animation track ready, and you record it to video from the editor's render menu. The GLB is passed through browser storage, not the network, so nothing large is uploaded to move a model between the two tools.

## Walkthrough

1. Open [/scene](https://three.ws/scene). The empty editor loads with an object hierarchy on one side and the property sidebar on the other, and a card over the empty grid offering the three ways to start.
2. Drag a `.glb` into the viewport (or use Menubar ▸ import, or **Import from Forge** in the quick-action bar). It appears in the hierarchy, and the empty-state card retires.
3. Click it to select. Use the toolbar gizmos, or the keyboard, to move, rotate, and scale it. Fine-tune exact values in the sidebar.
4. Open the Material tab to change its color, metalness, roughness, or maps. Add a light from the Add menu and set its intensity and shadows.
5. Add more objects to compose the scene. Adjust the scene background, fog, and environment in the sidebar's Scene tab.
6. Attach a script to an object if you want runtime behavior, and press Play to run it.
7. Export the finished scene to GLB from the menubar.

## Examples

Scene Studio is an interactive editor, not an HTTP API, so the concrete examples are its entry points:

- **Open it empty:** [https://three.ws/scene](https://three.ws/scene)
- **Receive a handoff:** `https://three.ws/scene?handoff=1`: used by Animation Studio's "Open in Scene Studio" button; the model to load is read from IndexedDB, not the URL.

A typical round trip from another studio:

1. Build a walk cycle in [Animation Studio](./animation-studio.md) on a rigged avatar.
2. Click "Open in Scene Studio". The baked animated GLB is stashed and `/scene?handoff=1` opens.
3. In Scene Studio, add a ground plane, a key light, and a camera, position the avatar, and use Render ▸ Video to capture the loop.

## States & limits

- **Dark theme only.** The vendored editor chrome ships a single dark skin; the studio locks the page to dark so the panels render correctly, regardless of your site theme preference.
- **Desktop-class tool.** This is the full three.js editor with dense panels and gizmo interactions. It expects a pointer and a reasonably sized viewport; it is not tuned for small touch screens the way the other studios are. It does stay usable down to 320px: below 600px the sidebar docks along the bottom instead of the right, the menubar keeps its six items on one row, and the quick-action bar reclaims the right edge.
- **Scenes live in this browser.** Autosave writes to IndexedDB on the machine you are using, so a scene does not follow you to another device or another browser. **Share** (which uploads a GLB) and **Export** are how a scene leaves the machine.
- **Vendored, MIT-licensed.** The editor is a vendored copy of three.js r184 under MIT. Attribution and the upstream license live in [src/scene-studio/vendor/](../src/scene-studio/vendor) (see the vendor `README`/`LICENSE`). Local changes are limited to the container mount, theme lock, and chrome overrides.
- **Handoff is browser-local.** The Animation Studio handoff moves the GLB through IndexedDB in the same browser. Opening `/scene?handoff=1` directly, with nothing stashed, just gives you an empty editor.
- **Export format.** Scenes export to glTF/GLB (Draco available). That is the same format Restyle Studio, Scene Composer, and the viewer all read, so a scene authored here flows back into the rest of the platform.

## Related

- [Scene Composer](./compose.md): the lighter avatar-plus-props arranger with Forge integration.
- [Animation Studio](./animation-studio.md): builds the animated GLBs Scene Studio records to video.
- [Restyle Studio](./restyle.md): re-skin the models before or after composing them.
- [3D asset pipeline](./3d-asset-pipeline.md): how GLB, glTF, and clip formats relate across the platform.
- [src/scene-studio/README.md](../src/scene-studio/README.md): the module layout, the exported wrapper API, and how re-vendoring a three.js upgrade stays mechanical.
