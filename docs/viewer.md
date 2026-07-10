# 3D Viewer

The viewer is the rendering layer of three.ws — a full-featured three.js WebGL scene manager. It handles model loading, camera control, animation playback, lighting, and more. You interact with it directly via the `<agent-3d>` web component or programmatically through the `Viewer` class.

## Overview

Core capabilities:

- **Model loading** — glTF 2.0 and GLB files, including Draco-compressed meshes and KTX2 textures
- **Interactive camera** — orbit, pan, zoom, reset, named camera support
- **Animation playback** — per-clip play/pause, speed control, loop toggle, blend via AnimationMixer
- **HDR environments** — three built-in environments for realistic image-based lighting
- **Material inspection** — per-mesh metalness, roughness, texture maps via dat.gui
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
<agent-3d src="https://example.com/avatar.glb"></agent-3d>
```

For a standalone viewer page, pass the model via URL hash:

```
https://your-app.com/viewer#model=https://example.com/avatar.glb
```

### Programmatically

```js
const el = document.querySelector('agent-3d');
await el.loadGLB('https://example.com/new-model.glb');
```

The `load(url, rootPath, assetMap)` method on the underlying `Viewer` instance accepts HTTPS URLs, blob URLs, and data URIs.

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
| **Reset / Frame** | Double-click on model | Double-tap |

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

Enable continuous rotation via `viewer.state.autoRotate = true` (or toggle in the **Display** GUI folder). Rotation pauses on user interaction and resumes after a short idle.

---

## Animation Playback

### GUI controls

When a GLB contains animation clips, the **Animation** folder appears in the dat.gui panel with:

- A list of all clips — each has a play/pause toggle
- **Play All** — sequences all clips in order
- **Speed** slider — 0.1× to 3×
- **Loop** toggle per clip

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

For agent-controlled playback, the `SceneController` bridge (`src/runtime/scene.js`) exposes `play_clip` as an agent tool.

### External animation panel

When the viewer is embedded inside `<agent-3d>` with animation definitions registered, an external animation panel (`.anim-panel`) renders above the chat UI with buttons for each animation. Buttons cycle through states: default → loading → active. Keyboard shortcuts 1–9 trigger the first nine animations in order.

---

## Environment and Lighting

### Built-in HDR environments

| Name | Description |
|---|---|
| `venice-sunset` | Warm golden-hour outdoor lighting |
| `footprint-court` | Neutral studio lighting |
| `neutral` | Soft indoor room environment (RoomEnvironment) |

Switch via the **Lighting** GUI folder or set `viewer.state.environment` programmatically, then call `viewer.updateEnvironment()`.

### Lighting controls (GUI → Lighting folder)

| Control | State key | Range |
|---|---|---|
| Environment | `environment` | dropdown |
| Exposure | `exposure` | −10 to 10 |
| Tone mapping | `toneMapping` | Linear / ACES Filmic |
| Punctual lights | `punctualLights` | boolean |
| Ambient intensity | `ambientIntensity` | 0–2 |
| Ambient color | `ambientColor` | hex color |
| Directional intensity | `directIntensity` | 0–4 |
| Directional color | `directColor` | hex color |

### Background

Toggle `viewer.state.background` to show or hide the HDR environment as the scene background. Use `viewer.state.bgColor` to set a solid background color and `viewer.state.transparentBg` to make the canvas background transparent (useful for embedding over custom page backgrounds).

Call `viewer.updateBackground()` after changing these values programmatically.

---

## Material and Texture Inspection

The dat.gui panel exposes per-material properties for every mesh in the scene:

- **Metalness** and **roughness** sliders
- **Base color** picker
- Texture map listing: baseColor, normal, metalness/roughness, emissive, occlusion
- **Transparency** and **double-sided** toggles
- **Wireframe** toggle (also available at the top-level in Display folder)

Material traversal is deduplicated by UUID (via `traverseMaterials` in `src/viewer/internal.js`), so shared materials are only listed once.

**Note:** The GUI panel is read-only in viewer mode. Editing material properties in a persistent way requires the Editor workflow. Changes made via the GUI are lost on model reload.

---

## Morph Targets (Blend Shapes)

If the loaded GLB includes morph targets, the **Morph Targets** folder appears in the GUI with a 0.0–1.0 slider per target per mesh.

### Avatar expression targets

The built-in avatar uses morph targets to drive facial expressions. The emotion system sets these targets automatically during speech and in response to conversation context. The targets available on the default avatar are:

| Target | Effect |
|---|---|
| `mouthSmile` | Corners of mouth up |
| `mouthFrown` | Corners of mouth down |
| `mouthOpen` | Jaw open |
| `cheekPuff` | Cheek inflation |
| `browInnerUp` | Inner brow raise |
| `browOuterUp` | Outer brow raise |
| `noseSneer` | Nostril flare |
| `eyeSquint` | Eye squint |
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

Toggle the performance overlay with the `S` key or via the **Performance** folder in the dat.gui panel.

The overlay shows three panels (provided by `stats.js`):

| Panel | Metric |
|---|---|
| FPS | Frames per second |
| MS | Milliseconds per frame |
| MB | Heap memory allocated |

The stats panel updates every frame. Keep it disabled in production embeds — it adds a small continuous DOM mutation cost.

---

## URL Hash Routing

The viewer page reads hash parameters on load to pre-configure the scene:

| Parameter | Effect |
|---|---|
| `#model=<url>` | Auto-load this GLB on page load |
| `#preset=<name>` | Apply environment/lighting preset (`assetgenerator`) |
| `#cameraPosition=x,y,z` | Set initial camera position |
| `#register=1` | Open registration modal immediately |
| `#kiosk=true` | Hide GUI, chat, and input |
| `#agent=<id>` | Load agent by ID (embed mode) |

Example — load a specific model with a fixed camera position:

```
https://your-app.com/viewer#model=https://cdn.example.com/robot.glb&cameraPosition=0,1.2,2.5
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
- **Use LOD** if targeting mobile WebXR. three.js `LOD` objects are supported in the glTF 2.0 extension `MSFT_lod`.
- **Transparent backgrounds** (`viewer.state.transparentBg = true`) disable some GPU optimizations. Only use when compositing the canvas over page content.
- **Auto-rotate** triggers a continuous `requestAnimationFrame` loop even when nothing is changing. Disable it for idle embeds to reduce CPU/battery usage.

---

## Viewer State Reference

The `viewer.state` object is the source of truth for all viewer settings. Reading and writing it directly (followed by the appropriate `update*()` call) is the lowest-level integration path.

| Key | Type | Default | Update method |
|---|---|---|---|
| `environment` | string | `'venice-sunset'` | `updateEnvironment()` |
| `background` | boolean | `false` | `updateBackground()` |
| `bgColor` | hex string | `'#000000'` | `updateBackground()` |
| `transparentBg` | boolean | `false` | `updateBackground()` |
| `playbackSpeed` | number | `1.0` | — (applied per frame) |
| `actionStates` | object | `{}` | `setClips()` |
| `wireframe` | boolean | `false` | `updateDisplay()` |
| `skeleton` | boolean | `false` | `updateDisplay()` |
| `grid` | boolean | `false` | `updateDisplay()` |
| `autoRotate` | boolean | `false` | `updateDisplay()` |
| `exposure` | number | `0` | `updateLights()` |
| `ambientIntensity` | number | `0.3` | `updateLights()` |
| `ambientColor` | hex string | `'#FFFFFF'` | `updateLights()` |
| `directIntensity` | number | `0.8` | `updateLights()` |
| `directColor` | hex string | `'#FFFFFF'` | `updateLights()` |
| `punctualLights` | boolean | `true` | `updateLights()` |
| `camera` | string | `'[default]'` | `setCamera()` |
| `followMode` | string | `'none'` | — |

State is persisted to `localStorage` per agent ID when `attachScenePrefs(agentId)` is called. Changes are broadcast via `notifyScenePrefChange()`.
