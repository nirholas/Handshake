# JavaScript API Reference

This page documents the internal JavaScript classes behind the three.ws viewer: the `App` controller, the Three.js `Viewer`, the glTF `Validator`, and the small components that render around them. It is aimed at developers reading or extending the source (`src/`), and at anyone driving the viewer from the browser console via `window.VIEWER`. If you just want a 3D agent on your page, use the [`<agent-3d>` element](./web-component.md) instead.

> For the HTTP/REST surface, see [api-reference.md](./api-reference.md). For the high-level npm SDK, see [sdk.md](./sdk.md). For the `<agent-3d>` element attributes, see [web-component.md](./web-component.md).

---

## Table of Contents

- [App](#app)
- [Viewer](#viewer)
- [Validator](#validator)
- [Components](#components)
- [Environments](#environments)
- [Global State](#global-state)

---

## App

**File:** `src/app.js`

The top-level application controller. Manages user interaction (drag-and-drop, file upload), URL parameter parsing, and orchestrates the `Viewer` and `Validator`.

### Constructor

```javascript
new App(el: Element, location: Location)
```

| Parameter  | Type       | Description                                        |
| ---------- | ---------- | -------------------------------------------------- |
| `el`       | `Element`  | Root DOM element (typically `document.body`)       |
| `location` | `Location` | Browser location object for hash parameter parsing |

Parses the URL hash with `URLSearchParams`. The load-bearing parameters:

| Hash Param       | Type      | Default             | Description                                       |
| ---------------- | --------- | ------------------- | ------------------------------------------------- |
| `model`          | `string`  | `'/avatars/cz.glb'` | URL of a glTF/GLB model to load                   |
| `kiosk`          | `boolean` | `false`             | Hides header; intended for iframe embedding       |
| `preset`         | `string`  | `''`                | `'assetgenerator'` activates asset generator mode |
| `cameraPosition` | `string`  | `null`              | Comma-separated `x,y,z` camera coordinates        |
| `brain`          | `string`  | `'none'`            | Brain/model id for the in-page agent              |
| `proxyURL`       | `string`  | `''`                | Key-proxy endpoint the brain calls through        |
| `agent`          | `string`  | `''`                | Agent id to load (legacy hash embed mode)         |
| `widget`         | `string`  | `''`                | Widget id to render instead of the editor         |

`src/app.js` reads more (embed overrides such as `noChat`, `noControls`,
`accent`, `bg`); read the `this.options` block there for the full set.

### Properties

| Property            | Type              | Description                                   |
| ------------------- | ----------------- | --------------------------------------------- |
| `el`                | `Element`         | Root DOM element                              |
| `viewer`            | `Viewer \| null`  | Viewer instance (created on first model load) |
| `viewerEl`          | `Element \| null` | Viewer container element                      |
| `spinnerEl`         | `Element`         | Loading spinner element                       |
| `dropEl`            | `Element`         | Drop target element (`.wrap`)                 |
| `inputEl`           | `Element`         | Hidden file input element                     |
| `viewerContainerEl` | `Element`         | Container for the 3D viewport                 |
| `validator`         | `Validator`       | Validator instance                            |
| `options`           | `object`          | Parsed URL hash options                       |

### Methods

#### `createDropzone()`

Sets up the [simple-dropzone](https://github.com/donmccurdy/simple-dropzone) controller on the `.wrap` element. Listens for:

- `drop` → calls `this.load(files)`
- `dropstart` → shows spinner
- `droperror` → hides spinner

#### `createViewer() → Viewer`

Instantiates a new `Viewer` on the `#viewer-container` element. Called once on first model load; subsequent loads reuse the same viewer.

#### `load(fileMap: Map<string, File>)`

Processes a fileset from a drag-and-drop or file input event.

1. Iterates the `fileMap` to find the root `.gltf` or `.glb` file
2. Extracts the `rootPath` (directory portion of the file path)
3. Calls `this.view(rootFile, rootPath, fileMap)`
4. If no `.gltf`/`.glb` file is found, hides the spinner, logs a warning, and shows the viewer-status overlay ("No .gltf or .glb file in that drop. Pick a model file to view it.") with a **Choose a file** action that re-opens the file picker

#### `view(rootFile: File | string, rootPath: string, fileMap: Map<string, File>)`

Loads a model into the viewer and runs validation.

| Parameter  | Type                | Description                                   |
| ---------- | ------------------- | --------------------------------------------- |
| `rootFile` | `File \| string`    | The root glTF/GLB file object or URL string   |
| `rootPath` | `string`            | Directory prefix for resolving relative URIs  |
| `fileMap`  | `Map<string, File>` | All files from the drop (for multi-file glTF) |

Flow:

1. Clears any existing scene from the viewer
2. Creates a blob URL if `rootFile` is a `File` object
3. Calls `Viewer.load()` to render the model
4. Calls `Validator.validate()` (unless in kiosk mode)
5. Revokes the blob URL in the cleanup callback

#### `onError(error: Error | string)`

Console-only diagnostic logging. The user-facing error surface is the
viewer-status overlay driven by the `LOAD_END` protocol payload (see
`_classifyLoadError` in `src/app.js`), which turns a failed load into a readable
message with a recovery action instead of a browser dialog. The overlay is
rendered by `_showViewerError(label, onAction, opts)`; `opts.actionLabel` and
`opts.busyLabel` reword the button for recoveries that are not a plain retry,
and `opts.keepOpenUntilLoad` clears the overlay instead of showing a busy state.
A failed `view()` keeps a replay handle (`_retryLastView`), so the Retry button
works for anonymous visitors on `/app` who have no agent to re-fetch.

#### `showSpinner()` / `hideSpinner()`

Toggle the loading spinner's `display` style.

---

## Viewer

**File:** `src/viewer.js`

The Three.js rendering engine. Manages the WebGL scene, camera, renderer, controls, lighting, environment maps, animations, morph targets, and the dat.gui panel.

### Constructor

```javascript
new Viewer(el: Element, options: object)
```

| Parameter | Type      | Description                                        |
| --------- | --------- | -------------------------------------------------- |
| `el`      | `Element` | Container element for the WebGL canvas             |
| `options` | `object`  | Options from `App` (kiosk, preset, cameraPosition) |

The constructor:

1. Creates `WebGLRenderer`, `PerspectiveCamera`, `Scene`, `OrbitControls`
2. Initializes `PMREMGenerator` for environment map processing
3. Creates the neutral environment from `THREE.RoomEnvironment`
4. Sets up the axes helper (mini viewport in bottom-left)
5. Builds the dat.gui panel
6. Starts the render loop via `requestAnimationFrame`
7. Binds the `resize` event

### Properties

| Property             | Type                           | Description                                                 |
| -------------------- | ------------------------------ | ----------------------------------------------------------- |
| `el`                 | `Element`                      | Container element                                           |
| `options`            | `object`                       | Configuration options                                       |
| `scene`              | `THREE.Scene`                  | The Three.js scene                                          |
| `defaultCamera`      | `THREE.PerspectiveCamera`      | Default orbit camera                                        |
| `activeCamera`       | `THREE.Camera`                 | Currently active camera (default or embedded)               |
| `renderer`           | `THREE.WebGLRenderer`          | WebGL renderer (also on `window.renderer`)                  |
| `controls`           | `OrbitControls`                | Orbit controls instance                                     |
| `content`            | `THREE.Object3D \| null`       | Currently loaded model root                                 |
| `mixer`              | `THREE.AnimationMixer \| null` | Animation mixer                                             |
| `clips`              | `THREE.AnimationClip[]`        | Animation clips from the loaded model                       |
| `lights`             | `THREE.Light[]`                | App-provided lights (ambient + directional)                 |
| `gui`                | `GUI`                          | dat.gui instance                                            |
| `state`              | `object`                       | Current GUI state (see [State Object](#state-object) below) |
| `stats`              | `Stats`                        | stats.js performance monitor                                |
| `backgroundColor`    | `THREE.Color`                  | Current background color                                    |
| `pmremGenerator`     | `THREE.PMREMGenerator`         | Environment map processor                                   |
| `neutralEnvironment` | `THREE.Texture`                | Pre-computed neutral environment                            |
| `skeletonHelpers`    | `THREE.SkeletonHelper[]`       | Active skeleton overlays                                    |
| `gridHelper`         | `THREE.GridHelper \| null`     | Grid overlay                                                |
| `axesHelper`         | `THREE.AxesHelper \| null`     | Axes overlay in main scene                                  |
| `axesScene`          | `THREE.Scene`                  | Mini axes viewport scene                                    |
| `axesCamera`         | `THREE.PerspectiveCamera`      | Mini axes viewport camera                                   |
| `axesRenderer`       | `THREE.WebGLRenderer`          | Mini axes viewport renderer                                 |
| `axesCorner`         | `THREE.AxesHelper`             | Axes object in mini viewport                                |

### State Object

The `this.state` object holds all GUI-controllable values. The core fields:

```javascript
{
    environment: 'Neutral',              // Environment map name
    background: false,                   // Show environment as background
    playbackSpeed: 1.0,                  // Animation playback speed (0–1)
    actionStates: {},                    // Per-clip play state { clipName: bool }
    camera: '[default]',                 // Active camera name
    wireframe: false,                    // Wireframe rendering
    skeleton: false,                     // Skeleton helper visibility
    grid: false,                         // Grid + axes visibility
    autoRotate: false,                   // Auto-rotate orbit

    // Lighting: studio three-point rig (key + fill + rim) with the
    // Khronos PBR-Neutral tone mapper
    punctualLights: true,                // App-provided lights enabled
    exposure: 0.0,                       // Exposure compensation (EV)
    toneMapping: NeutralToneMapping,     // Tone mapping mode
    ambientIntensity: 0.45,              // Ambient light intensity
    ambientColor: '#FFFFFF',             // Ambient light color
    directIntensity: 0.8 * Math.PI,     // Key light intensity
    directColor: '#FFFFFF',              // Key light color
    fillRatio: 0.4,                      // Fill light, relative to directIntensity
    rimRatio: 0.55,                      // Rim light, relative to directIntensity
    environmentIntensity: 1.15,          // IBL strength
    bgColor: '#000000',                  // Background color
    transparentBg: false,                // Transparent canvas background

    pointSize: 1.0,                      // Point cloud vertex size
}
```

Additional fields (info overlay, follow mode, cinematic presets) live in the same object; see `src/viewer.js` for the full set.

### Methods

#### `animate(time: number)`

Main render loop callback. Called every frame via `requestAnimationFrame`.

- Updates OrbitControls
- Updates stats.js
- Advances AnimationMixer by delta time
- Calls `this.render()`

#### `render(deltaTime: number = 0)`

Renders the main scene and the axes helper mini-viewport.

#### `resize()`

Handles window resize. Updates camera aspect ratio, renderer size, and axes renderer size.

#### `load(url: string, rootPath: string, assetMap: Map<string, File>, onProgress?: (xhr: ProgressEvent) => void) → Promise<GLTF>`

Loads a glTF/GLB model.

| Parameter    | Type                | Description                                  |
| ------------ | ------------------- | -------------------------------------------- |
| `url`        | `string`            | URL to the model file (or blob URL)          |
| `rootPath`   | `string`            | Directory prefix for resolving relative URIs |
| `assetMap`   | `Map<string, File>` | Dropped files for local resource resolution  |
| `onProgress` | `function`          | Optional XHR progress callback (`xhr.total` only when the server sends `Content-Length`) |

Returns a Promise that resolves with the parsed glTF object. The method:

1. Installs a URL modifier on the `LoadingManager` to intercept relative URIs and serve them from `assetMap` as blob URLs
2. Configures `GLTFLoader` with Draco, KTX2, and Meshopt decoders
3. On success, calls `setContent()` with the scene and animation clips
4. Exports the raw glTF JSON to `window.VIEWER.json`

#### `setContent(object: THREE.Object3D, clips: THREE.AnimationClip[])`

Adds a loaded model to the scene.

1. Calls `this.clear()` to remove any existing model
2. Computes bounding box and centers the model at origin
3. Configures camera near/far planes and position based on model size; the seat is placed in front of the rig's face by reading its facing yaw (`estimateFacingYaw` in `src/viewer/facing.js`), so an avatar authored facing -Z or +X still opens front-on, and the historical +Z seat is used when no rig is readable
4. Respects `options.cameraPosition` if provided
5. Saves initial OrbitControls state
6. Detects embedded lights (sets `state.punctualLights = false` if found)
7. Sets up animation clips via `setClips()`
8. Updates lighting, the shadow catcher, GUI, environment, display, model info, and annotations
9. Exports the scene to `window.VIEWER.scene`
10. Dispatches a `viewer:model-loaded` `CustomEvent` on `window` so overlays can re-read the new rig

#### `setClips(clips: THREE.AnimationClip[])`

Replaces the current animation clips. Stops and disposes the existing `AnimationMixer` if one exists, then creates a new one.

#### `playAllClips()`

Plays all animation clips simultaneously by calling `mixer.clipAction(clip).reset().play()` on each.

#### `setCamera(name: string)`

Switches the active camera.

| Value            | Behavior                                                                           |
| ---------------- | ---------------------------------------------------------------------------------- |
| `'[default]'`    | Activates the orbit camera; enables OrbitControls                                  |
| Any other string | Traverses the scene for a camera with `node.name === name`; disables OrbitControls |

#### `updateLights()`

Synchronizes light state with the GUI:

- Adds or removes punctual lights based on `state.punctualLights`
- Sets `renderer.toneMapping` and `renderer.toneMappingExposure`
- Updates ambient/directional light intensity and color

#### `addLights()`

Creates and adds the studio light rig: an ambient light plus a three-point directional setup (key, fill, rim) and a shadow-casting sun (or a single hemisphere light in asset generator mode). Implemented in `src/viewer/lights.js`.

#### `removeLights()`

Removes all app-provided lights from the scene and empties the `lights` array.

#### `updateEnvironment()`

Loads the selected environment map and applies it to `scene.environment`. If `state.background` is true, also sets it as `scene.background`.

#### `getCubeMapTexture(environment: object) → Promise<{envMap: THREE.Texture}>`

Processes an environment definition into a usable environment map:

| Environment ID | Processing                                                       |
| -------------- | ---------------------------------------------------------------- |
| `'neutral'`    | Returns pre-computed `RoomEnvironment` texture                   |
| `''`           | Returns `null` (no environment)                                  |
| Any other      | Loads `.exr` via `EXRLoader`, processes through `PMREMGenerator` |

#### `updateDisplay()`

Applies display state changes:

- Wireframe mode on all materials
- Point size for `PointsMaterial`
- Skeleton helpers on skinned meshes
- Grid + axes helpers
- Auto-rotate on OrbitControls

#### `updateBackground()`

Updates `backgroundColor` from `state.bgColor`.

#### `addAxesHelper()`

Creates the mini axes viewport:

- 100×100 px `<div>` in the bottom-left corner
- Separate `WebGLRenderer` with transparent background
- `AxesHelper(5)` scaled to match the loaded model

#### `addGUI()`

Builds the entire dat.gui panel. On mobile (≤ 700 px), uses 220 px width and starts closed; on desktop, 260 px width and starts open.

See [Architecture overview](./architecture.md) for the full folder tree.

#### `updateGUI()`

Rebuilds the dynamic GUI folders (Animation, Morph Targets, Cameras) based on the currently loaded model. Called by `setContent()`.

- Removes all previous dynamic controls
- Traverses the model to discover morph target meshes and embedded cameras
- Auto-plays the first animation clip
- Creates per-clip checkboxes and per-morph-target sliders

#### `clear()`

Removes the current model from the scene and disposes all resources:

- Detaches the animation manager and removes the animation panel, model-info
  overlay, and annotation elements
- Disposes BVH bounds trees, then all geometries
- Disposes all textures (except `envMap`)
- Disposes all materials

---

## Validator

**File:** `src/validator.js`

Integrates the [Khronos glTF-Validator](https://github.com/KhronosGroup/glTF-Validator) and normalizes its report into the shape the report UI renders.

### Constructor

```javascript
new Validator(el: Element | null)
```

| Parameter | Type               | Description                                        |
| --------- | ------------------ | -------------------------------------------------- |
| `el`      | `Element \| null`  | Root DOM element (`null` on the `/validation` page) |

### Properties

| Property | Type             | Description            |
| -------- | ---------------- | ---------------------- |
| `el`     | `Element`        | Root DOM element       |
| `report` | `object \| null` | Last validation report |

### Methods

#### `validate(rootFile: string, rootPath: string, assetMap: Map<string, File>, response: object) → Promise`

Runs the glTF validator against a loaded model.

| Parameter  | Type                | Description                                  |
| ---------- | ------------------- | -------------------------------------------- |
| `rootFile` | `string`            | URL of the model file                        |
| `rootPath` | `string`            | Directory prefix for resolving relative URIs |
| `assetMap` | `Map<string, File>` | Dropped files for local resource resolution  |
| `response` | `object`            | The parsed GLTF object from GLTFLoader       |

Flow:

1. Reuses the `ArrayBuffer` `GLTFLoader` already cached for that URL, or fetches it
2. Calls `validateBytes()` from `gltf-validator`
3. Provides `externalResourceFunction` for resolving external resources
4. Passes the result to `setReport()`

#### `resolveExternalResource(uri: string, rootFile: string, rootPath: string, assetMap: Map<string, File>) → Promise<Uint8Array>`

Resolves an external resource (texture, bin) referenced by the glTF during validation.

1. Normalizes the URI by decoding and removing the base URL
2. Checks `assetMap` for a local match → creates blob URL
3. Falls back to a network fetch
4. Returns the resource as a `Uint8Array`

#### `setReport(report: object, response: object)`

Normalizes the raw validator report and stores it on `this.report`. Via the
internal `_processReport()`:

1. Extracts the generator string from `report.info.generator`
2. Determines `maxSeverity` (lowest severity index with > 0 messages)
3. Splits messages into `errors[]`, `warnings[]`, `infos[]`, `hints[]`
4. Aggregates high-frequency messages (`ACCESSOR_NON_UNIT`, `ACCESSOR_ANIMATION_INPUT_NON_INCREASING`)

Then `setResponse()` extracts `asset.extras` metadata (author, license, source,
title) from the GLTF response. Rendering is the caller's job: `App` watches the
resulting `.validator-toggle` node and re-emits the counts as a `VALIDATE`
protocol action.

#### `setResponse(response: object)`

Extracts metadata from the glTF `asset.extras` field:

| Extra     | Processing                  |
| --------- | --------------------------- |
| `author`  | HTML-escaped then linkified |
| `license` | HTML-escaped then linkified |
| `source`  | HTML-escaped then linkified |
| `title`   | HTML-escaped                |

#### `setReportException(e: Error)`

Called when validation fails. Clears `this.report` so no stale report can be
shown for the new model.

#### `showLightbox()`

Opens a new browser tab with the full validation report HTML (rendered via the
`ValidatorReport` component), including a downloadable JSON copy of the report.

---

## Components

All components are pure functions that return HTML strings via [vhtml](https://github.com/developit/vhtml) JSX.

### `Footer()`

**File:** `src/components/footer.jsx`

Returns a `<footer>` with:

- X link to [@trythreews](https://x.com/trythreews)
- "showcase" link to `/showcase`
- "validation" link to `/validation`
- "reputation" link to `/reputation`
- "help & feedback" link to the GitHub issue form (`nirholas/three.ws/issues/new`)
- GitHub repository link (`nirholas/three.ws`); every external link carries `rel="noopener noreferrer"`
- Pipe separators between items

**No props.**

### `ValidatorToggle({ issues, reportError })`

**File:** `src/components/validator-toggle.jsx`

Renders the validation status bar.

| Prop          | Type                  | Description                       |
| ------------- | --------------------- | --------------------------------- |
| `issues`      | `object \| undefined` | Validation issues summary         |
| `reportError` | `Error \| undefined`  | Error if validation failed to run |

Message logic:

- `numErrors > 0` → "X errors."
- `numWarnings > 0` → "X warnings."
- `numHints > 0` → "X hints."
- `numInfos > 0` → "X notes."
- Otherwise → "Model details"

CSS class `level-{maxSeverity}` controls the color (0 = red, 1 = yellow).

### `ValidatorReport({ info, validatorVersion, issues, errors, warnings, hints, infos })`

**File:** `src/components/validator-report.jsx`

Renders the full validation report.

| Prop               | Type     | Description                                                 |
| ------------------ | -------- | ----------------------------------------------------------- |
| `info`             | `object` | Model info (version, generator, counts, extensions, extras) |
| `validatorVersion` | `string` | glTF-Validator version                                      |
| `issues`           | `object` | Issues summary with counts                                  |
| `errors`           | `array`  | Error messages                                              |
| `warnings`         | `array`  | Warning messages                                            |
| `hints`            | `array`  | Hint messages                                               |
| `infos`            | `array`  | Info messages                                               |

Displays:

- Format version and generator
- Metadata from `asset.extras` (title, author, license, source)
- Stats: draw calls, animations, materials, vertices, triangles
- Extensions used
- Issue tables (one `ValidatorTable` per severity level with messages)

### `ValidatorTable({ title, color, messages })`

**File:** `src/components/validator-table.jsx`

Renders a color-coded table of validation issues.

| Prop       | Type     | Description                                         |
| ---------- | -------- | --------------------------------------------------- |
| `title`    | `string` | Severity title ("Error", "Warning", "Hint", "Info") |
| `color`    | `string` | Header background color (CSS color string)          |
| `messages` | `array`  | Array of `{ code, message, pointer }` objects       |

Columns: Code, Message, Pointer (JSON pointer into the glTF).

---

## Environments

**File:** `src/environments.js`

Exports `environments` — an array of environment map definitions.

### Schema

```typescript
interface Environment {
	id: string; // Unique identifier ('' for none, 'neutral' for RoomEnvironment)
	name: string; // Display name in the GUI dropdown
	path: string | null; // URL to the EXR file (null for procedural/none)
	format?: string; // File format (e.g., '.exr')
}
```

### Default Environments

| ID                | Name                       | Source                               |
| ----------------- | -------------------------- | ------------------------------------ |
| `''`              | None                       | No environment map                   |
| `neutral`         | Neutral                    | `THREE.RoomEnvironment` (procedural) |
| `venice-sunset`   | Venice Sunset              | `venice_sunset_1k.exr` from GCS      |
| `footprint-court` | Footprint Court (HDR Labs) | `footprint_court_2k.exr` from GCS    |

### Adding Custom Environments

Append to the `environments` array in `src/environments.js`:

```javascript
{
    id: 'my-studio',
    name: 'My Studio',
    path: 'https://your-cdn.com/studio_1k.exr',
    format: '.exr',
}
```

Requirements:

- Must be an equirectangular HDR image in `.exr` format
- 1K resolution (1024×512) is recommended for web delivery
- Must be served with CORS headers allowing the app's origin

---

## Global State

The app exports debugging state to `window.VIEWER`:

| Property              | Type             | Set By                       | Description                            |
| --------------------- | ---------------- | ---------------------------- | -------------------------------------- |
| `window.VIEWER.app`   | `App`            | `app.js` at DOMContentLoaded | Full App instance                      |
| `window.VIEWER.scene` | `THREE.Object3D` | `Viewer.setContent()`        | Current model scene graph              |
| `window.VIEWER.json`  | `GLTF`           | `Viewer.load()`              | Raw parsed glTF object from GLTFLoader |

When the agent layer is mounted, `App` also publishes `agent_protocol`,
`agent_identity`, `agent_skills`, and `agent_runtime` on the same object.

The WebGL renderer is also available at `window.renderer` (nulled on viewer
dispose).

### Console Usage Examples

```javascript
// List all meshes
window.VIEWER.scene.traverse((n) => n.isMesh && console.log(n.name, n));

// Get renderer stats
window.VIEWER.app.viewer.renderer.info;

// Get current camera position
window.VIEWER.app.viewer.defaultCamera.position.toArray();

// Force play animation clip by index
window.VIEWER.app.viewer.mixer.clipAction(window.VIEWER.app.viewer.clips[0]).play();

// Change background color programmatically
window.VIEWER.app.viewer.state.bgColor = '#ff0000';
window.VIEWER.app.viewer.updateBackground();

// Toggle wireframe
window.VIEWER.app.viewer.state.wireframe = true;
window.VIEWER.app.viewer.updateDisplay();
```

---

## Related

- [Web Component](/docs/web-component): the `<agent-3d>` element built on these classes
- [SDK & Library](/docs/sdk): importing `Viewer`, `Runtime`, and friends from the lib build
- [Widget API](/docs/widget-api): driving the embeddable widget shell over JSON-RPC
- [Architecture overview](/docs/architecture): how the folders fit together
