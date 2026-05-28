# JavaScript API Reference

Complete reference for all public classes, methods, and properties exported by the three.ws web component bundle (`agent-3d.js`).

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

Parses the following URL hash parameters via `query-string`:

| Hash Param       | Type      | Default             | Description                                       |
| ---------------- | --------- | ------------------- | ------------------------------------------------- |
| `model`          | `string`  | `'/avatars/cz.glb'` | URL of a glTF/GLB model to load                   |
| `kiosk`          | `boolean` | `false`             | Hides header; intended for iframe embedding       |
| `preset`         | `string`  | `''`                | `'assetgenerator'` activates asset generator mode |
| `cameraPosition` | `string`  | `null`              | Comma-separated `x,y,z` camera coordinates        |

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
4. Shows an alert if no `.gltf`/`.glb` file is found

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

Normalizes and displays an error message via `window.alert()`. Special case handling:

| Pattern                         | Displayed Message                 |
| ------------------------------- | --------------------------------- |
| Contains `ProgressEvent`        | "Unable to retrieve this file..." |
| Contains `Unexpected token`     | "Unable to parse file content..." |
| `error.target instanceof Image` | "Missing texture: {filename}"     |

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

The `this.state` object holds all GUI-controllable values:

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

    // Lighting
    punctualLights: true,                // App-provided lights enabled
    exposure: 0.0,                       // Exposure compensation (EV)
    toneMapping: LinearToneMapping,      // Tone mapping mode
    ambientIntensity: 0.3,               // Ambient light intensity
    ambientColor: '#FFFFFF',             // Ambient light color
    directIntensity: 0.8 * Math.PI,     // Directional light intensity
    directColor: '#FFFFFF',              // Directional light color
    bgColor: '#191919',                  // Background color

    pointSize: 1.0,                      // Point cloud vertex size
}
```

### Methods

#### `animate(time: number)`

Main render loop callback. Called every frame via `requestAnimationFrame`.

- Updates OrbitControls
- Updates stats.js
- Advances AnimationMixer by delta time
- Calls `this.render()`

#### `render()`

Renders the main scene and the axes helper mini-viewport.

#### `resize()`

Handles window resize. Updates camera aspect ratio, renderer size, and axes renderer size.

#### `load(url: string, rootPath: string, assetMap: Map<string, File>) → Promise<GLTF>`

Loads a glTF/GLB model.

| Parameter  | Type                | Description                                  |
| ---------- | ------------------- | -------------------------------------------- |
| `url`      | `string`            | URL to the model file (or blob URL)          |
| `rootPath` | `string`            | Directory prefix for resolving relative URIs |
| `assetMap` | `Map<string, File>` | Dropped files for local resource resolution  |

Returns a Promise that resolves with the parsed glTF object. The method:

1. Installs a URL modifier on the `LoadingManager` to intercept relative URIs and serve them from `assetMap` as blob URLs
2. Configures `GLTFLoader` with Draco, KTX2, and Meshopt decoders
3. On success, calls `setContent()` with the scene and animation clips
4. Exports the raw glTF JSON to `window.VIEWER.json`

#### `setContent(object: THREE.Object3D, clips: THREE.AnimationClip[])`

Adds a loaded model to the scene.

1. Calls `this.clear()` to remove any existing model
2. Computes bounding box and centers the model at origin
3. Configures camera near/far planes and position based on model size
4. Respects `options.cameraPosition` if provided
5. Saves initial OrbitControls state
6. Detects embedded lights (sets `state.punctualLights = false` if found)
7. Sets up animation clips via `setClips()`
8. Updates lighting, GUI, environment, and display
9. Prints the scene graph to the console
10. Exports the scene to `window.VIEWER.scene`

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

Creates and adds the ambient + directional light pair (or a single hemisphere light in asset generator mode).

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

- Disposes all geometries
- Disposes all textures (except `envMap`)
- Disposes all materials

#### `printGraph(node: THREE.Object3D)`

Recursively prints the scene graph to the console using nested `console.group()` calls. Each line shows `<NodeType> name`.

---

## Validator

**File:** `src/validator.js`

Integrates the [Khronos glTF-Validator](https://github.com/KhronosGroup/glTF-Validator) and renders validation results.

### Constructor

```javascript
new Validator(el: Element)
```

| Parameter | Type      | Description                                   |
| --------- | --------- | --------------------------------------------- |
| `el`      | `Element` | Root DOM element for appending the toggle bar |

### Properties

| Property   | Type             | Description                  |
| ---------- | ---------------- | ---------------------------- |
| `el`       | `Element`        | Root DOM element             |
| `report`   | `object \| null` | Last validation report       |
| `toggleEl` | `Element`        | Container for the toggle bar |

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

1. Fetches the model URL as an `ArrayBuffer`
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

Processes the raw validator report:

1. Extracts the generator string from `report.info.generator`
2. Determines `maxSeverity` (lowest severity index with > 0 messages)
3. Splits messages into `errors[]`, `warnings[]`, `infos[]`, `hints[]`
4. Aggregates high-frequency messages (`ACCESSOR_NON_UNIT`, `ACCESSOR_ANIMATION_INPUT_NON_INCREASING`)
5. Extracts `asset.extras` metadata (author, license, source, title) from the GLTF response
6. Renders `ValidatorToggle` HTML into the toggle element

#### `setResponse(response: object)`

Extracts metadata from the glTF `asset.extras` field:

| Extra     | Processing                  |
| --------- | --------------------------- |
| `author`  | HTML-escaped then linkified |
| `license` | HTML-escaped then linkified |
| `source`  | HTML-escaped then linkified |
| `title`   | Stored as-is                |

#### `setReportException(e: Error)`

Called when validation fails. Sets report to `null` and renders an error message in the toggle.

#### `bindListeners()`

Binds click event on the toggle bar to open the lightbox report, and the close button to dismiss it.

#### `showToggle()` / `hideToggle()`

Add/remove the `hidden` CSS class on the toggle element.

#### `showLightbox()`

Opens a new browser tab with the full validation report HTML (rendered via `ValidatorReport` component).

---

## Components

All components are pure functions that return HTML strings via [vhtml](https://github.com/developit/vhtml) JSX.

### `Footer()`

**File:** `src/components/footer.jsx`

Returns a `<footer>` with:

- X (Twitter) link to [@nichxbt](https://x.com/trythreews)
- "help & feedback" link to GitHub issues
- GitHub repository link
- Pipe separators

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

The WebGL renderer is also available at `window.renderer`.

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
