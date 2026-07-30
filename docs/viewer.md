# 3D Viewer

The viewer is the rendering layer of three.ws: a full-featured three.js WebGL scene manager. It handles model loading, camera control, animation playback, lighting, and more. If you are new, the fastest way to see it is [three.ws/app](https://three.ws/app), where you can drag and drop any GLB file into the browser. Developers interact with the same engine via the `<agent-3d>` web component or programmatically through the `Viewer` class (`src/viewer.js`).

Note: [three.ws/viewer](https://three.ws/viewer) is a separate, lightweight share page built on `<model-viewer>` that opens a model from a `?src=<url>` query parameter. This document covers the full three.js viewer that powers `/app` and every `<agent-3d>` embed.

## Overview

Core capabilities:

- **Model loading** — glTF 2.0 and GLB files, including Draco-compressed meshes and KTX2 textures
- **Interactive camera**: orbit, pan, zoom, frame, named camera support
- **Animation playback**: per-clip play/pause, speed control, blend via AnimationMixer, plus an external clip-library panel for rigged avatars
- **HDR environments**: built-in environments for realistic image-based lighting
- **Material inspection and editing**: via the editor layer (see [Editor Guide](/docs/editor))
- **Morph targets** — per-target sliders, used by the avatar emotion system for facial animation
- **Skeleton visualization** — colored bone overlay for animation rig debugging
- **Screenshot capture** — PNG download via keyboard or API
- **Stats overlay** — FPS, frame time, memory usage
- **Wireframe and axes helpers** — grid plane and corner axis gizmo

---

## Loading a Model

### Via HTML attribute

The `src` attribute (or `body` for direct GLB URIs) on `<agent-3d>` loads a model on mount:

```html
<agent-3d src="https://three.ws/avatars/michelle.glb"></agent-3d>
```

For the standalone viewer page, pass the model via URL hash:

```
https://three.ws/app#model=https://three.ws/avatars/michelle.glb
```

### Programmatically

Set the `src` (or `body`) attribute on the element; a change to either triggers a reload:

```js
const el = document.querySelector('agent-3d');
el.setAttribute('src', 'https://three.ws/avatars/xbot.glb');
```

Or drive the underlying `Viewer` instance directly. Its `load(url, rootPath, assetMap, onProgress)` method accepts HTTPS URLs, blob URLs, and data URIs.

### Compressed assets

- **Draco** — mesh compression decoder is auto-loaded when the GLB contains compressed meshes. No configuration needed.
- **KTX2** — Basis Universal texture decoder is auto-loaded when compressed textures are detected.

Both decoders are fetched via `getDecoders()` in `src/viewer/internal.js` and wired into the GLTFLoader automatically.

### Load events

The element fires `CustomEvent` on the document:

| Event | Detail |
|---|---|
| `agent:load-progress` | `{ phase, pct }` |
| `agent:ready` | `{ agent, manifest }` |
| `agent:error` | `{ phase, error }` |

---

## Camera and Navigation

The viewer uses `OrbitControls` for interactive navigation:

| Action | Mouse | Touch |
|---|---|---|
| **Orbit** | Left drag | One-finger drag |
| **Pan** | Right drag | Two-finger drag |
| **Zoom** | Scroll wheel | Pinch |
| **Frame model (animated)** | Double-click | Double-tap |
| **Frame model (instant)** | `F` key | (keyboard only) |

Keyboard-only orbit is also supported when the canvas has focus: arrow keys rotate, `+`/`-` and PageUp/PageDown dolly.

### Camera state

The active camera is tracked in `viewer.state.camera` (default: `'[default]'`). If the loaded GLB defines named cameras, a **Cameras** dropdown appears in the GUI panel.

Switch programmatically:

```js
viewer.setCamera('[default]');    // three.js orbit camera
viewer.setCamera('CameraName');   // named camera from GLB
```

### URL hash overrides

Deep-link the viewer to a specific camera position:

```
#cameraPosition=0,1.5,3
```

Apply a named preset on load:

```
#preset=assetgenerator
```

The `assetgenerator` preset uses a hemisphere light instead of the default ambient + directional setup — useful for conformance testing.

### Auto-rotate

Enable continuous rotation via `viewer.state.autoRotate = true` followed by `viewer.updateDisplay()` (or toggle **autoRotate** in the **Display** GUI folder). Rotation pauses while you drag and resumes when you release (standard OrbitControls behavior).

---

## Animation Playback

### GUI controls

When a GLB contains animation clips, the **Animation** folder appears in the dat.gui panel with:

- A checkbox per clip that starts or stops that clip (the first clip autoplays on load)
- **playAll**: activates every clip at once
- **playbackSpeed** slider: 0 to 1, applied as the mixer's `timeScale`

### Keyboard shortcut

Press `Space` to toggle playback of all active clips.

### How blending works

The viewer creates a single `THREE.AnimationMixer` per loaded model. Each clip maps to an `AnimationAction`. When you call `playAllClips()`, all actions are activated and blended by the mixer's weight system. For most avatar GLBs, clips are non-overlapping so blending is not visible — but if you activate multiple overlapping clips, they add additively.

The mixer is updated every frame in the `animate()` loop using the clock delta.

### Programmatic control via the element API

```js
// play a named animation (web component method)
await el.play('wave');

// play with options
await el.play('dance', { loop: false });
```

For agent-controlled playback, the runtime tool layer (`src/runtime/tools.js`) exposes `play_clip` as an agent tool, executed through the `SceneController` bridge (`src/runtime/scene.js`).

### External animation panel

When the viewer is embedded inside `<agent-3d>` with animation definitions registered, an external animation panel (`.anim-panel`) renders above the chat UI with buttons for each animation. Buttons cycle through states: default → loading → active. Keyboard shortcuts 1–9 trigger the first nine animations in order.

---

## Environment and Lighting

### Built-in environments

Defined in `src/environments.js`:

| Name | Description |
|---|---|
| `None` | No environment map |
| `Neutral` | Soft indoor room environment (three.js RoomEnvironment). The default. |
| `Venice Sunset` | Warm golden-hour outdoor HDR |
| `Footprint Court (HDR Labs)` | Neutral studio HDR |

Switch via the **Lighting** GUI folder or set `viewer.state.environment` to one of the display names above, then call `viewer.updateEnvironment()`.

### Lighting controls (GUI → Lighting folder)

The default rig is a studio three-point setup (key + fill + rim) over an ambient base, tone-mapped with the Khronos PBR Neutral mapper.

| Control | State key | Range |
|---|---|---|
| Environment | `environment` | dropdown |
| Exposure | `exposure` | -10 to 10 |
| Tone mapping | `toneMapping` | Neutral / Linear / ACES Filmic |
| Punctual lights | `punctualLights` | boolean |
| IBL intensity | `environmentIntensity` | 0-3 |
| Ambient intensity | `ambientIntensity` | 0-2 |
| Ambient color | `ambientColor` | hex color |
| Directional intensity | `directIntensity` | 0-4 |
| Directional color | `directColor` | hex color |
| Fill ratio + color | `fillRatio`, `fillColor` | 0-1 |
| Rim ratio + color | `rimRatio`, `rimColor` | 0-1.5 |

### Background

Toggle `viewer.state.background` to show or hide the HDR environment as the scene background. Use `viewer.state.bgColor` to set a solid background color and `viewer.state.transparentBg` to make the canvas background transparent (useful for embedding over custom page backgrounds).

Call `viewer.updateBackground()` after changing these values programmatically.

---

## Material and Texture Inspection

The viewer itself exposes a scene-wide **wireframe** toggle (Display folder). Per-material inspection and editing (metalness, roughness, base color, emissive, texture maps) lives in the editor layer: when the `Editor` class is active, a dat.gui folder per material appears, plus the Texture Inspector panel. See the [Editor Guide](/docs/editor) for the full workflow.

Material traversal helpers are deduplicated by UUID (via `traverseMaterials` in `src/viewer/internal.js`), so shared materials are only processed once.

**Note:** Edits made in the plain viewer are session-only and lost on model reload. Persisting material changes requires the Editor's save or publish flow.

---

## Morph Targets (Blend Shapes)

If the loaded GLB includes morph targets, the **Morph Targets** folder appears in the GUI with a 0.0–1.0 slider per target per mesh.

### Avatar expression targets

The built-in avatar uses morph targets to drive facial expressions. The emotion system (`src/agent-avatar.js`) sets these targets automatically during speech and in response to conversation context. The target names it drives are ARKit-style blendshape identifiers (paired targets have `Left`/`Right` variants):

| Target | Effect |
|---|---|
| `mouthSmile` | Corners of mouth up |
| `mouthFrown` | Corners of mouth down |
| `mouthOpen`, `jawOpen` | Mouth and jaw open |
| `mouthPressLeft` / `mouthPressRight` | Lips pressed |
| `cheekPuff` | Cheek inflation |
| `cheekSquintLeft` / `cheekSquintRight` | Cheek raise |
| `browInnerUp` | Inner brow raise |
| `browOuterUpLeft` / `browOuterUpRight` | Outer brow raise |
| `noseSneerLeft` / `noseSneerRight` | Nostril flare |
| `eyeSquintLeft` / `eyeSquintRight` | Eye squint |
| `eyeWideLeft` / `eyeWideRight` | Eyes widen |
| `eyesClosed` | Eye close |

These are directly useful for facial animation preview or testing custom expressions before encoding them into an animation clip.

### Programmatic control

To trigger an emotion from the element API:

```js
el.expressEmotion('celebration', 0.8);
el.expressEmotion('concern', 1.0);
```

Supported emotion triggers: `celebration`, `concern`, `curiosity`, `empathy`, `patience`. Weight is 0–1.

---

## Skeleton Visualization

Enable the bone overlay via the **Display** GUI folder → **skeleton** toggle, or set `viewer.state.skeleton = true` and call `viewer.updateDisplay()`.

The overlay renders the armature as colored line segments connecting each bone's head and tail. This is purely additive — it renders on top of the mesh without affecting the model.

Practical uses:

- Verify bone hierarchy after import
- Debug animation rigs when clips don't behave as expected
- Identify which bones are available for procedural control (the avatar head-tilt system auto-detects Head/Neck bones by name)

---

## Screenshots

### Via keyboard

Press `P` to capture a screenshot. The viewer renders one frame off-screen and downloads a timestamped PNG:

```
3d-screenshot-1714000000000.png
```

A brief white flash overlay confirms the capture.

### Via the GUI

The **Display** folder includes a **Screenshot** button that triggers the same capture.

### Programmatically

```js
viewer.takeScreenshot();
```

The implementation in `src/viewer/screenshot.js` renders one frame, encodes the canvas with `canvas.toBlob(…, 'image/png')`, and triggers a browser download via a temporary anchor element.

---

## Stats Panel

The performance overlay lives in the **Performance** folder of the dat.gui panel (open the panel with the Controls toggle button in the viewer corner).

The overlay shows three panels (provided by `stats.js`):

| Panel | Metric |
|---|---|
| FPS | Frames per second |
| MS | Milliseconds per frame |
| MB | Heap memory allocated |

The stats panel updates every frame. Keep it disabled in production embeds — it adds a small continuous DOM mutation cost.

---

## URL Hash Routing

The `/app` viewer page reads hash parameters on load to pre-configure the scene (parsed in `src/app.js`):

| Parameter | Effect |
|---|---|
| `#model=<url>` | Auto-load this GLB on page load |
| `#preset=<name>` | Apply environment/lighting preset (`assetgenerator`) |
| `#cameraPosition=x,y,z` | Set initial camera position |
| `#kiosk=true` | Hide GUI, chat, and input |
| `#agent=<id>` | Load agent by ID (legacy embed mode) |
| `#noChat=1`, `#noControls=1`, `#noAnimations=1` | Hide individual UI surfaces |

A `?agent=<id>` query parameter (not hash) opens the same page in editing mode with save-back.

Example: load a specific model with a fixed camera position:

```
https://three.ws/app#model=https://three.ws/avatars/xbot.glb&cameraPosition=0,1.2,2.5
```

---

## Supported File Formats

| Format | Support |
|---|---|
| GLB (binary glTF 2.0) | Full |
| glTF 2.0 (JSON + external assets) | Full |
| Draco compressed meshes | Full (auto-decoded) |
| KTX2 compressed textures | Full (auto-decoded) |
| glTF 1.0 | Not supported |
| FBX | Convert to GLB first — see `scripts/convert-fbx-to-glb.py` |
| OBJ | Not supported directly |

For FBX conversion, the script at `scripts/convert-fbx-to-glb.py` uses Blender's Python API to batch-convert FBX files to GLB with textures embedded.

---

## Performance Tips

- **Draco-compress meshes** before deploying. Draco typically reduces mesh data 5–10× and the decoder runs on a worker thread, keeping the main thread free during load.
- **Use KTX2 textures** for GPU-native compressed formats (BC7, ETC2, ASTC). The browser uploads them directly to GPU without CPU decompression, saving memory and load time.
- **Keep polygon count under 100k** for smooth mobile performance. The default avatar is around 15k triangles.
- **Disable the stats panel** in production embeds — it triggers continuous layout reads.
- **Reduce detail for mobile WebXR.** Prefer a lower-poly export for embeds that target phones; the loader does not implement the `MSFT_lod` extension, so level-of-detail switching must be baked into the asset you ship.
- **Transparent backgrounds** (`viewer.state.transparentBg = true`) disable some GPU optimizations. Only use when compositing the canvas over page content.
- **Auto-rotate** triggers a continuous `requestAnimationFrame` loop even when nothing is changing. Disable it for idle embeds to reduce CPU/battery usage.

---

## Viewer State Reference

The `viewer.state` object is the source of truth for all viewer settings. Reading and writing it directly (followed by the appropriate `update*()` call) is the lowest-level integration path.

| Key | Type | Default | Update method |
|---|---|---|---|
| `environment` | string | `'Neutral'` (display name) | `updateEnvironment()` |
| `background` | boolean | `false` | `updateBackground()` |
| `bgColor` | hex string | `'#000000'` | `updateBackground()` |
| `transparentBg` | boolean | `false` | `updateBackground()` |
| `playbackSpeed` | number | `1.0` | applied to the mixer's `timeScale` |
| `actionStates` | object | `{}` | `setClips()` |
| `wireframe` | boolean | `false` | `updateDisplay()` |
| `skeleton` | boolean | `false` | `updateDisplay()` |
| `grid` | boolean | `false` | `updateDisplay()` |
| `autoRotate` | boolean | `false` | `updateDisplay()` |
| `exposure` | number | `0` | `updateLights()` |
| `environmentIntensity` | number | `1.15` | `updateEnvironment()` |
| `ambientIntensity` | number | `0.45` | `updateLights()` |
| `ambientColor` | hex string | `'#FFFFFF'` | `updateLights()` |
| `directIntensity` | number | `0.8 * Math.PI` (about 2.51) | `updateLights()` |
| `directColor` | hex string | `'#FFFFFF'` | `updateLights()` |
| `fillRatio` / `rimRatio` | number | `0.4` / `0.55` | `updateLights()` |
| `punctualLights` | boolean | `true` | `updateLights()` |
| `camera` | string | `'[default]'` | `setCamera()` |
| `followMode` | string | `'mouse'` | applied per frame |

This table covers the commonly used keys; see the `state` object in the `Viewer` constructor (`src/viewer.js`) for the full set, including cinematic FX and light-probe settings.

A subset of state (background, transparency, background color, auto-rotate, exposure, environment, cinematic preset) is persisted to `localStorage` per agent ID when `attachScenePrefs(agentId)` is called. Controllers call `notifyScenePrefChange()` after a state change to persist the latest values.

## Related

- [Editor Guide](/docs/editor): inspect and modify models, then publish
- [Animations](/docs/animations): the clip library and agent gesture slots
- [Embedding](/docs/embedding): put the `<agent-3d>` component on your own site
- [AR](/docs/ar): view the same models in augmented reality
