# Development Guide

Everything you need to know to work on three.ws locally.

---

## Table of Contents

- [Setup](#setup)
- [Project Layout](#project-layout)
- [Dev Server](#dev-server)
- [Code Style](#code-style)
- [How Things Work](#how-things-work)
- [Common Tasks](#common-tasks)
- [Debugging](#debugging)
- [Browser Compatibility](#browser-compatibility)
- [Performance Notes](#performance-notes)
- [Testing](#testing)

---

## Setup

```bash
git clone https://github.com/nirholas/three.ws.git
cd 3D-Agent
npm install
```

**Requirements:**

- Node.js 24.x
- A browser with WebGL 2.0 support (Chrome, Firefox, Edge)

---

## Project Layout

```
3D/
├── index.html              # SPA entry point (loaded by the browser)
├── style.css               # Single stylesheet (dark theme, responsive)
├── package.json            # Dependencies, scripts, metadata
├── vercel.json             # Vercel deploy config + routing
├── cors.json               # CORS allowed origins
├── LICENSE                 # MIT
│
├── public/
│   └── avatars/
│       └── cz.glb          # Default model
│
├── src/
│   ├── app.js              # App class — entry point, dropzone, URL params
│   ├── viewer.js           # Viewer class — Three.js scene, camera, GUI
│   ├── validator.js        # Validator class — glTF-Validator integration
│   ├── environments.js     # HDR environment map definitions
│   └── components/
│       ├── footer.jsx          # Footer component
│       ├── validator-report.jsx # Full validation report
│       ├── validator-table.jsx  # Issue table
│       └── validator-toggle.jsx # Status toggle bar
│
└── docs/                   # Documentation
    ├── ARCHITECTURE.md
    ├── API.md
    ├── DEPLOYMENT.md
    └── DEVELOPMENT.md      # (this file)
```

---

## Dev Server

```bash
npm run dev
```

Starts Vite on **port 3000** with hot module replacement (HMR). Changes to any source file will instantly reflect in the browser without a full reload.

Open [http://localhost:3000](http://localhost:3000).

### Available Scripts

| Script        | Command                          | Description                  |
| ------------- | -------------------------------- | ---------------------------- |
| `dev`         | `vite --port 3000`               | Dev server with HMR          |
| `build`       | `vite build`                     | Production build to `dist/`  |
| `clean`       | `rm -rf dist/* \|\| true`        | Remove build output          |
| `test`        | `node test/gen_test.js`          | Run test suite               |
| `deploy`      | `npm run build && vercel --prod` | Build and deploy             |
| `postversion` | `git push && git push --tags`    | Auto-push after version bump |

---

## Code Style

- **Formatter:** [Prettier](https://prettier.io/) (installed as devDependency)
- **Indentation:** Tabs
- **Quotes:** Single quotes
- **Semicolons:** Yes
- **Trailing commas:** ES5

Format all files:

```bash
npx prettier --write .
```

Check formatting without writing:

```bash
npx prettier --check .
```

---

## How Things Work

### Entry Point

`index.html` loads `src/app.js` as a deferred ES module:

```html
<script defer type="module" src="src/app.js"></script>
```

On `DOMContentLoaded`, `app.js` instantiates the `App` class, which:

1. Parses URL hash parameters
2. Sets up drag-and-drop
3. Loads the default or specified model

### JSX Components

Components use [vhtml](https://github.com/developit/vhtml), which compiles JSX into plain HTML strings. There is no virtual DOM, no re-rendering, and no component lifecycle.

Each `.jsx` file must include the pragma:

```javascript
import vhtml from 'vhtml';
/** @jsx vhtml */
```

Vite handles the JSX transformation automatically.

**Important:** Since vhtml outputs strings, you insert them with `element.innerHTML = Component(props)`. There's no diffing or patching — a full re-render replaces the previous HTML.

### Three.js Integration

The `Viewer` class encapsulates all Three.js code:

- **Renderer:** `WebGLRenderer` with antialiasing, attached to the `#viewer-container`
- **Camera:** `PerspectiveCamera` with `OrbitControls` for orbit/pan/zoom
- **Loaders:** `GLTFLoader` is the core loader. Draco, KTX2, and Meshopt decoders are configured as plugins via singleton instances
- **Environment maps:** Loaded as `.exr` files via `EXRLoader`, processed into prefiltered cubemaps via `PMREMGenerator`
- **GUI:** `dat.gui` is constructed programmatically in `addGUI()` with folders for each control category

### dat.gui Pattern

Controls follow a consistent pattern:

```javascript
// 1. Define state with default value
this.state = { myOption: false };

// 2. Add control in addGUI()
const ctrl = folder.add(this.state, 'myOption');

// 3. Wire up change handler
ctrl.onChange(() => this.updateMyFeature());

// 4. Implement the update method
updateMyFeature() {
    // Apply this.state.myOption to the scene
}
```

For controls that need to reflect external changes, add `.listen()`:

```javascript
folder.add(this.state, 'punctualLights').listen();
```

### Validation

The `Validator` class runs independently of the viewer. When a model loads:

1. The model URL is fetched again as an `ArrayBuffer`
2. `gltf-validator`'s `validateBytes()` runs in the main thread
3. Results are rendered as HTML into the toggle bar
4. Clicking the bar opens a full report in a new tab

> **Note:** The model is fetched twice — once by GLTFLoader and once by the Validator. This is a known inefficiency (see TODO in `validator.js`). The Three.js cache (`Cache.enabled = true`) may mitigate this for URL-based loads.

---

## Common Tasks

### Add a New Environment Map

1. Find or create an equirectangular HDR image in `.exr` format (1K or 2K resolution)
2. Host it on a CDN with CORS headers
3. Add an entry to `src/environments.js`:

```javascript
{
    id: 'my-env',
    name: 'My Environment',
    path: 'https://cdn.example.com/my_env_1k.exr',
    format: '.exr',
}
```

4. The Viewer automatically picks it up in the GUI dropdown

### Add a New GUI Control

**Example: Adding an "opacity" slider**

1. Add state in `src/viewer.js` constructor:

```javascript
this.state = {
	// ... existing state
	opacity: 1.0,
};
```

2. Add the control in `addGUI()`:

```javascript
const opacityCtrl = dispFolder.add(this.state, 'opacity', 0, 1, 0.01);
opacityCtrl.onChange(() => this.updateDisplay());
```

3. Apply the value in `updateDisplay()`:

```javascript
traverseMaterials(this.content, (material) => {
	material.opacity = this.state.opacity;
	material.transparent = this.state.opacity < 1;
});
```

### Add a New Component

1. Create `src/components/my-component.jsx`:

```jsx
import vhtml from 'vhtml';
/** @jsx vhtml */

export function MyComponent({ title, items }) {
	return (
		<div class="my-component">
			<h2>{title}</h2>
			<ul>
				{items.map((item) => (
					<li>{item}</li>
				))}
			</ul>
		</div>
	);
}
```

2. Import and use in the consuming module:

```javascript
import { MyComponent } from './components/my-component';
element.innerHTML = MyComponent({ title: 'Hello', items: ['a', 'b'] });
```

3. Add styles in `style.css`.

### Change the Default Model

Edit the fallback in `src/app.js`:

```javascript
const model = options.model || '/avatars/cz.glb';
```

Replace `/avatars/cz.glb` with the path to your model. Place the file in `public/`.

### Add a New URL Parameter

1. Parse it in the `App` constructor (`src/app.js`):

```javascript
const hash = location.hash ? queryString.parse(location.hash) : {};
this.options = {
	// ... existing options
	myParam: hash.myParam || 'default',
};
```

2. Use it where needed (e.g., in `Viewer` via `this.options.myParam`).

---

## Debugging

### window.VIEWER

The app exports state to `window.VIEWER` for console debugging:

```javascript
window.VIEWER.app; // App instance (access viewer, validator, options)
window.VIEWER.scene; // Current THREE.Object3D scene graph
window.VIEWER.json; // Raw glTF JSON from GLTFLoader
```

### Scene Graph Logging

Every model load prints the scene graph to the console:

```
▼ <Scene>
  ▼ <Group> MyModel
    ▼ <Mesh> Body
    ▼ <Mesh> Head
    ▼ <SkinnedMesh> Arm_L
```

### Renderer Info

```javascript
// Draw calls, triangles, geometries, textures in memory
console.table(window.VIEWER.app.viewer.renderer.info.render);
console.table(window.VIEWER.app.viewer.renderer.info.memory);
```

### Animation Debugging

```javascript
const v = window.VIEWER.app.viewer;

// List all clips
v.clips.forEach((c) => console.log(c.name, c.duration + 's'));

// Play a specific clip
v.mixer.clipAction(v.clips[0]).play();

// Set time
v.mixer.setTime(1.5);
```

### Morph Target Debugging

```javascript
window.VIEWER.scene.traverse((node) => {
	if (node.morphTargetInfluences) {
		console.log(node.name, node.morphTargetDictionary);
	}
});
```

### Material Inspection

```javascript
window.VIEWER.scene.traverse((node) => {
	if (node.isMesh) {
		const mat = node.material;
		console.log(node.name, {
			type: mat.type,
			color: mat.color?.getHexString(),
			roughness: mat.roughness,
			metalness: mat.metalness,
			map: mat.map?.name,
		});
	}
});
```

---

## Browser Compatibility

### Requirements

| Feature     | Minimum                                             |
| ----------- | --------------------------------------------------- |
| WebGL 2.0   | Required                                            |
| File API    | Required (`File`, `FileReader`, `FileList`, `Blob`) |
| ES Modules  | Required (`<script type="module">`)                 |
| CSS `env()` | Needed for safe-area support (graceful degradation) |

### Tested Browsers

| Browser                 | Status                                              |
| ----------------------- | --------------------------------------------------- |
| Chrome 90+              | Fully supported                                     |
| Firefox 90+             | Fully supported                                     |
| Edge (Chromium) 90+     | Fully supported                                     |
| Safari 15+              | Mostly works; drag-and-drop has known limitations   |
| Mobile Chrome (Android) | Works; GUI auto-collapses                           |
| Mobile Safari (iOS)     | Works with limitations; iOS detection via `isIOS()` |

### Known Limitations

- **Safari drag-and-drop:** Limited support for multi-file drops
- **iOS WebGL:** Performance may be lower; some HDR environments may not load
- **Older browsers:** No WebGL 2.0 → app will not render (error logged to console)

---

## Performance Notes

### Memory Management

The `Viewer.clear()` method properly disposes:

- All geometries (`geometry.dispose()`)
- All textures (`texture.dispose()`, except `envMap`)
- All materials (`material.dispose()`)

Blob URLs created for dropped files are revoked after loading completes.

### Decoder Loading

Draco and KTX2 decoders are loaded on-demand from CDN. The first model using Draco will incur a ~200ms penalty for decoder initialization. Subsequent models reuse the initialized decoders (singleton instances).

### Environment Maps

`PMREMGenerator` pre-filters environment maps into mipmapped cubemaps. The generator is compiled once at viewer creation. The neutral environment is pre-computed at startup.

### Render Loop

The render loop runs at display refresh rate (typically 60 FPS or 120 FPS on ProMotion displays). There is no throttling — the loop runs continuously even when idle. The `stats.js` panel shows real-time FPS/MS/MB metrics.

---

## Testing

```bash
npm run test
```

This runs `node test/gen_test.js`. Tests are script-based and validate model generation and processing.
