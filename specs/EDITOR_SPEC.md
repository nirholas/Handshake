# Editor Spec v0.1 — `<agent-3d editor>` & `src/editor/`

> **Format ID:** `agent-editor/0.1` > **Stability:** draft — breaking changes may occur before 1.0
> **Relationship to EMBED_SPEC:** EMBED*SPEC defines how a finished agent is played back. This spec defines the surface for \_authoring* one. The `editor` attribute switches the same `<agent-3d>` element from playback mode into editing mode. The "Copy Embed" output of the editor is a plain `<agent-3d>` element with no `editor` attribute — a clean embed the user pastes anywhere.

---

## 1. Identity

The editor layer lives in [`src/editor/`](../src/editor/) and is orchestrated by [`src/editor/index.js`](../src/editor/index.js) (`Editor` class). It is activated in the Studio/viewer via a dat.gui `Editor` folder; the intended web-component activation path uses the `editor` boolean attribute on `<agent-3d>`.

### Pre-1.0 rough edge #1 — `editor` attribute not yet wired

[`EMBED_SPEC.md` §Dev/debug](./EMBED_SPEC.md) documents `<agent-3d editor>` and says it "mounts the embed editor instead of the live agent." However, [`src/element.js`](../src/element.js) does not include `editor` in `observedAttributes()` (line 211–226) and `_boot()` has no branch for it. The embed editor module ([`src/editor/embed-editor.js`](../src/editor/embed-editor.js)) must be imported and mounted manually today. Downstream hosts must not rely on the attribute-driven path until this is wired.

---

## 2. Attached editor contract

### `editor` attribute (boolean)

**Documented contract** (see EMBED_SPEC.md line 109):

```html
<agent-3d editor src="agent://base/42"></agent-3d>
```

Replaces the live agent runtime with the embed editor. Intended to be a boolean presence attribute — no value required.

**Current state:** not handled by `observedAttributes` in [`src/element.js:211`](../src/element.js#L211). Manual integration required (see §6).

### Other attributes used by editor flows

These are standard embed attributes that the editor reads or writes to its output snippet. They are fully handled by [`src/element.js`](../src/element.js):

| Attribute    | Type                                          | Role in editor context                                                |
| ------------ | --------------------------------------------- | --------------------------------------------------------------------- |
| `src`        | URI                                           | Source agent URI; echoed into "Copy Embed" snippet                    |
| `agent-id`   | string                                        | Backend UUID or on-chain ref; echoed into snippet                     |
| `manifest`   | URL                                           | Manifest URL; echoed into snippet                                     |
| `body`       | URL                                           | Bare GLB URI; the editor's primary input when no manifest exists      |
| `mode`       | `inline`\|`floating`\|`section`\|`fullscreen` | Layout mode selector in embed-editor UI                               |
| `position`   | string                                        | Floating mode anchor — `bottom-right`, etc.                           |
| `width`      | CSS length                                    | Configurable in embed-editor                                          |
| `height`     | CSS length                                    | Configurable in embed-editor                                          |
| `responsive` | boolean                                       | Toggleable in embed-editor                                            |
| `kiosk`      | boolean                                       | Suppresses chat chrome — not editor-specific but affects embed output |

---

## 3. Editor panels

### 3.1 `EditorSession` — [`src/editor/session.js`](../src/editor/session.js)

The central shared state object. All panels read from and write to it.

**State owned:**

| Field             | Type                             | Description                                          |
| ----------------- | -------------------------------- | ---------------------------------------------------- |
| `sourceURL`       | `string\|null`                   | URL of the loaded model                              |
| `sourceFile`      | `File\|null`                     | Dropped File object                                  |
| `sourceBuffer`    | `ArrayBuffer\|null`              | Lazily cached bytes (fetched or read from File)      |
| `sourceName`      | `string`                         | Display name, derived from URL basename or File.name |
| `materialEdits`   | `{ [uuid]: MaterialEditPatch }`  | Keyed by Three.js `material.uuid`                    |
| `transformEdits`  | `{ [uuid]: TransformEditPatch }` | Keyed by Three.js `Object3D.uuid`                    |
| `visibilityEdits` | `{ [uuid]: { name, visible } }`  | Keyed by Three.js `Object3D.uuid`                    |

**Patch shapes:**

```js
// MaterialEditPatch
{
  name: string,          // material.name — used for GLB export name-matching
  uuid: string,
  baseColor?: [r, g, b], // 0–1 floats
  metalness?: number,
  roughness?: number,
  emissive?: [r, g, b],
  opacity?: number,
  alphaMode?: 'OPAQUE'|'BLEND'|'MASK',
  alphaCutoff?: number,
  doubleSided?: boolean
}

// TransformEditPatch
{
  name: string,           // node.name — used for GLB export name-matching
  uuid: string,
  position: [x, y, z],
  rotation: [x, y, z],   // Euler, radians, XYZ order
  scale: [x, y, z]
}
```

**Methods:**

| Method                                | Returns                | Description                                  |
| ------------------------------------- | ---------------------- | -------------------------------------------- |
| `reset({ url, file, name })`          | void                   | Clears all edits; sets new source            |
| `isExportReady()`                     | boolean                | True when any source is set                  |
| `isDirty()`                           | boolean                | True when any edit map is non-empty          |
| `onChange(fn)`                        | unsubscribe fn         | Fires after any edit or reset                |
| `recordMaterialEdit(material, patch)` | void                   | Merges patch into materialEdits              |
| `clearMaterialEdit(material)`         | void                   | Removes entry from materialEdits             |
| `recordTransformEdit(node)`           | void                   | Writes current position/rotation/scale       |
| `recordVisibilityEdit(node, visible)` | void                   | Writes visibility state                      |
| `restoreEdits(edits)`                 | void                   | Re-applies a saved edit set by name-matching |
| `getSourceBuffer()`                   | `Promise<ArrayBuffer>` | Fetches or reads bytes; caches result        |

**Failure modes:** `getSourceBuffer()` throws if no source is set. `reset()` with no source logs a warning but does not throw.

---

### 3.2 `MaterialEditor` — [`src/editor/material-editor.js`](../src/editor/material-editor.js)

**What it edits:** PBR properties on every `MeshStandardMaterial` and `MeshPhysicalMaterial` in the loaded scene. One dat.gui subfolder per material, opened under a top-level `Materials` folder.

**Editable properties per material:**

| Property           | Range             | Notes                                                |
| ------------------ | ----------------- | ---------------------------------------------------- |
| base color         | hex color         | `mat.color`                                          |
| metalness          | 0–1               |                                                      |
| roughness          | 0–1               |                                                      |
| emissive color     | hex color         | `mat.emissive`                                       |
| emissive intensity | 0–4               | **Not recorded to session** (pre-1.0 rough edge #2)  |
| opacity            | 0–1               | Sets `mat.transparent` automatically when < 1        |
| transparent        | boolean           |                                                      |
| alpha test         | 0–1               |                                                      |
| wireframe          | boolean           | Not recorded to session (viewport-only preview)      |
| flat shading       | boolean           | Not recorded to session (viewport-only preview)      |
| env map intensity  | 0–4               | If present on material; not recorded to session      |
| side               | Front/Back/Double | Maps to three.js `FrontSide`/`BackSide`/`DoubleSide` |

**Inputs:** `viewer.content` (Three.js scene graph), `viewer.gui` (dat.GUI instance), `EditorSession`.

**Outputs:** mutates Three.js material in place for live preview; records to `session.materialEdits` on every change via `recordMaterialEdit()`.

**Events:** none. Internal only via `session.onChange`.

**Reset:** `↺ reset` button per subfolder restores the snapshot captured at `rebuild()` time and calls `session.clearMaterialEdit(mat)`.

**Failure modes:**

- If `viewer.gui` is null, no UI is built (silent no-op).
- If the scene has no standard/physical materials, the `Materials` folder is not created.

### Pre-1.0 rough edge #2 — emissive intensity not persisted

`emissiveIntensity` changes call `mat.needsUpdate = true` and `viewer.invalidate()` but do **not** call `record()` ([`src/editor/material-editor.js:100–103`](../src/editor/material-editor.js#L100)). The value is visible in the viewport but will not appear in an exported GLB.

---

### 3.3 `SceneExplorer` — [`src/editor/scene-explorer.js`](../src/editor/scene-explorer.js)

**What it is:** A side panel appended to `viewer.el` showing the full Three.js scene tree, a node inspector, and a TransformControls gizmo.

**Tree shape:** Recursive DOM tree mirroring `viewer.content` hierarchy. Root is auto-expanded. Each node row shows:

- Expand/collapse arrow (if children present)
- Type icon (mesh, skinned mesh, group, bone, light, camera, etc.)
- Node name or type
- Visibility toggle (● visible / ○ hidden)

Nodes are identified in the tree DOM by `data-uuid` attribute.

**Selection semantics:**

- Click on a row selects the node → `this.selectedNode`, highlights the row with `.selected` class, attaches TransformControls.
- Double-click frames the node in the camera.
- Left-click on the canvas raycasts against `viewer.content`; hit object is selected (walks up to the nearest Mesh/Light/Camera ancestor).
- `Escape` key detaches TransformControls and clears selection.

**Visibility toggle:**

- Per-row ● button sets `node.visible` and calls `session.recordVisibilityEdit(node, visible)`.
- Inspector "Hide"/"Show" button does the same.

**Transform editing:**

- Gizmo keys: `W` translate, `E` rotate, `R` scale.
- Inspector shows editable numeric inputs for pos/rot°/scale; changes call `session.recordTransformEdit(node)`.
- TransformControls `objectChange` event also calls `session.recordTransformEdit`.

**Search:** Text input filters tree rows by label; matching rows expand their ancestors.

**Keyboard shortcuts** (when not in an input):

| Key      | Action                      |
| -------- | --------------------------- |
| `T`      | Toggle panel open/closed    |
| `W`      | Switch gizmo to translate   |
| `E`      | Switch gizmo to rotate      |
| `R`      | Switch gizmo to scale       |
| `Escape` | Detach gizmo, deselect node |

**Inputs:** `viewer` (Viewer instance), `EditorSession`.

**Outputs:** mutates Three.js scene graph in place for live preview; records to `session.transformEdits` / `session.visibilityEdits`.

**Events:** none emitted. `dragging-changed` on TransformControls disables `viewer.controls` while dragging.

**Failure modes:** If `viewer.renderer.domElement` is unavailable at `attach()` time, pointer-down raycasting silently skips. Panel remains in the DOM on error.

---

### 3.4 `TextureInspector` — [`src/editor/texture-inspector.js`](../src/editor/texture-inspector.js)

**What it does:** Catalogs every texture referenced by the loaded model, renders a thumbnail grid panel, and provides a full-screen lightbox with per-channel extraction, zoom/pan, and UV wireframe overlay.

**Read-only:** The TextureInspector does **not** record edits to the session. It is a diagnostic/inspection tool only. No texture modifications are persisted to the exported GLB.

**Texture catalog:** Collected by traversing `viewer.content` via `traverseMaterials()`. For each unique texture UUID, tracks: material slot labels, material names, and mesh nodes (for UV overlay). Covered slots: base color, normal, metallic, roughness, occlusion, emissive, bump, alpha, displacement, clearcoat (and variants), sheen (and variants), specular (and variants), transmission, thickness, light map — 19 slots total.

**Thumbnail grid panel** (`.texture-inspector`): Opens appended to `document.body`. Close button or `X` key toggles.

**Lightbox** (`.texture-lightbox`): Opens on card click. Provides:

- RGB / R / G / B / A channel extraction (requires same-origin or CORS-readable image for channel modes)
- Alpha-over-checkerboard mode
- UV wireframe overlay (renders triangle edges from mesh UV attributes)
- Zoom (mouse wheel) and pan (mouse drag) with cursor-centered zoom
- Fit/reset button

**Keyboard shortcut:** `X` — toggle the texture grid panel open/closed.

**Inputs:** `viewer.content`, `viewer.gui`.

**Outputs:** none to session. DOM panels appended to `document.body`.

**Events:** none emitted.

**Failure modes:**

- Channel extraction calls `ctx.getImageData()` — this will throw (CORS) for cross-origin textures. The lightbox shows "channel extraction blocked (CORS)" in place of extracted data.
- If no textures are found, the `Textures` dat.gui folder is not created.

---

### 3.5 `exportEditedGLB` / `downloadGLB` — [`src/editor/glb-export.js`](../src/editor/glb-export.js)

**Export format:** GLB (`model/gltf-binary`) via `@gltf-transform/core` `WebIO` + all extensions (`@gltf-transform/extensions`).

**What is included:** The full original GLB/GLTF content, with the following edits applied:

- Material properties: base color factor, metallic factor, roughness factor, emissive factor, alpha mode, alpha cutoff, double-sided.
- Node transforms: translation, rotation (converted from Euler XYZ to quaternion), scale.
- Node visibility: hidden nodes are written with `scale = [0, 0, 0]` (no glTF `extras.hidden` — see rough edge #3).

**What is stripped:** Nothing — all geometry, animations, extensions, and accessories in the source file are preserved.

**Name matching:** Materials and nodes are matched to glTF-Transform entities by **name**, not UUID. Three.js UUIDs do not cross the serialization boundary. The first material/node with a matching name receives the edit. Duplicate names silently affect only the first match.

**`downloadGLB(bytes, filename)`:** Creates a `Blob` URL, triggers an `<a download>` click, removes the element, and revokes the URL after 1 second.

**Output filename:** `<sourceName>.edited.glb` where `sourceName` strips query strings and `.glb`/`.gltf` extensions.

**Failure modes:**

- `exportEditedGLB(session)` throws `Error('No source buffer for export')` if `session.getSourceBuffer()` returns nothing.
- `getSourceBuffer()` throws if no source URL or File is set.
- Caller in `Editor._exportGLB()` catches and shows `window.alert`.

### Pre-1.0 rough edge #3 — visibility via scale hack

Hidden nodes are written as `scale = [0, 0, 0]` rather than using a `KHR_node_visibility` extension or `extras.hidden`. This works visually but destroys the scale edit for those nodes and is not spec-compliant glTF visibility. ([`src/editor/glb-export.js:106–109`](../src/editor/glb-export.js#L106))

### Pre-1.0 rough edge #4 — duplicate name collision

Both material edits and transform/visibility edits match by the first occurrence of each name in the glTF root. If a model has two materials both named `"Material"`, only the first is patched. The GUI shows both under different folder labels but they share the name key. ([`src/editor/glb-export.js:53–58`](../src/editor/glb-export.js#L53))

---

### 3.6 `publishEditedGLB` — [`src/editor/publish.js`](../src/editor/publish.js)

Turns an in-progress `EditorSession` into a live shareable widget. Five sequential steps:

| Step       | Operation                                 | Endpoint                    |
| ---------- | ----------------------------------------- | --------------------------- |
| `export`   | `exportEditedGLB(session)` → `Uint8Array` | (client-side)               |
| `presign`  | POST metadata, get signed PUT URL         | `POST /api/avatars/presign` |
| `upload`   | PUT raw bytes to presigned URL            | R2 (presigned URL)          |
| `register` | Create avatar metadata record             | `POST /api/avatars`         |
| `widget`   | Create turntable widget                   | `POST /api/widgets`         |

**Progress callback:** `onStep({ step, pct })` fired at each step boundary. Steps: `'export'`, `'presign'`, `'upload'`, `'register'`, `'widget'`.

**Return value on success:**

```js
{
  widget: { id, ... },
  avatar: { id, ... },
  urls: {
    page: 'https://…/w/<widgetId>',
    iframe: '<iframe src="…" …></iframe>',
    element: '<script …></script>\n<agent-3d src="…" …></agent-3d>'
  }
}
```

**Error classes exported** (importable from `./publish.js`):

| Class               | When thrown                                      |
| ------------------- | ------------------------------------------------ |
| `AuthRequiredError` | 401 from any fetch step                          |
| `SizeTooLargeError` | Client-side size check or 413 from register step |
| `ExportFailedError` | `exportEditedGLB` throws                         |
| `PublishError`      | Any non-401/non-413 non-2xx response             |

**Client-side size limit:** `MAX_BYTES = 25 * 1024 * 1024` (25 MB) — enforced before upload. Server-side schema allows up to 500 MB ([`api/_lib/validate.js:58`](../api/_lib/validate.js#L58)); the client is the stricter limit here.

**Auth requirements:** Session cookie (`credentials: 'include'`) or bearer token with `avatars:write` scope. No anonymous publishing.

**Failure on 401:** throws `AuthRequiredError`. Callers (e.g. `PublishModal`) redirect to `/login?next=<url>` and stash session state in `sessionStorage`/IndexedDB via [`src/editor/edit-persistence.js`](../src/editor/edit-persistence.js) for round-trip restore.

---

### 3.7 `PublishModal` — [`src/editor/publish-modal.js`](../src/editor/publish-modal.js)

UI wrapper over `publishEditedGLB`. Manages three states: **working** (step progress list), **result** (shareable snippets), **error** / **auth-required**. Appended to `containerEl` (default: `document.body`) as a modal overlay.

**Auth-required state:** Stashes session via `edit-persistence.stashSession()`, then redirects to `/login?next=<url with ?resume=<token>&publish=1>`.

**Output shown to user on success:** share link, iframe snippet, web component snippet. Each copyable. Share link also has an "Open" button.

**Accessibility:** `role="dialog"`, `aria-modal="true"`, focus trap, `Escape` closes, `aria-live="polite"` on step list.

---

### 3.8 `EmbedEditor` — [`src/editor/embed-editor.js`](../src/editor/embed-editor.js)

A separate "place, scale, preview, copy" UX. Mounted by calling `mountEmbedEditor(rootEl, { src, defaults })`. Renders a split view: a live iframe preview on the left, a control panel on the right.

Controls exposed:

- Mode selector (floating, inline, section, fullscreen)
- Position selector for floating mode (6 anchors)
- Width/height inputs
- Responsive preset (fixed, mobile-first, desktop-first)
- Device preview switcher (desktop 1440×900, tablet 768×1024, mobile 390×844)
- "Copy Embed" — generates and copies the `<agent-3d>` snippet

**Output:** a complete `<script type="module">` + `<agent-3d>` snippet with no `editor` attribute.

**Note:** This module is self-contained and not wired through the `Editor` orchestrator in `index.js`. It imports `../element.js` directly.

---

### 3.9 `Editor` orchestrator — [`src/editor/index.js`](../src/editor/index.js)

Wires MaterialEditor, TextureInspector, SceneExplorer, and GLB export/publish into the Viewer via dat.gui.

**Entry point:**

```js
const editor = new Editor(viewer);
editor.attach(); // once, after viewer constructed
editor.onContentChanged({ url, file, name }); // every time a new model loads
```

**dat.gui folder added:** `Editor` — contains:

- `💾 download GLB` (count badge when edits exist; disabled when no source)
- `📤 publish as embed`
- `🗂 scene panel [T]`
- `↺ revert all edits`

**`dispose()`:** removes all sub-panels, gui folder, and detaches SceneExplorer.

---

## 4. Permission model

### Who can edit

| Actor              | Can view model | Can edit materials/transforms | Can export GLB      | Can publish                       |
| ------------------ | -------------- | ----------------------------- | ------------------- | --------------------------------- |
| Anonymous visitor  | Yes            | Yes (viewport only)           | Yes (download only) | No — 401 → login redirect         |
| Authenticated user | Yes            | Yes                           | Yes                 | Yes — creates under their account |
| Owner of the agent | Yes            | Yes                           | Yes                 | Yes                               |

The editor itself is entirely client-side; there is no server-side ownership gate on the _editing_ phase. Ownership is enforced only at **publish time** (API).

### Ownership check at publish

1. `POST /api/avatars/presign` — requires valid session or bearer with `avatars:write`. Returns 401 if missing. The presign action is dispatched from [`api/avatars/[id].js`](../api/avatars/[id].js) into the `handlePresign` handler in [`api/avatars/_actions.js`](../api/avatars/_actions.js).
2. `POST /api/avatars` — same auth requirement. Additionally verifies that `storage_key` starts with `u/{auth.userId}/` to prevent cross-user key claiming. ([`api/avatars/index.js:50–53`](../api/avatars/index.js#L50))

### How the editor checks identity

Client-side auth hint via `readAuthHint()` from [`src/account.js:43`](../src/account.js#L43) (localStorage, 7-day TTL). This is optimistic and non-authoritative — used only to gate first-paint UI. Authoritative check is `getMe()` → `GET /api/auth/me` ([`src/account.js:63`](../src/account.js#L63)). Both session cookie and bearer token are accepted.

### Unauthed user save path

When `publishEditedGLB` catches `AuthRequiredError`, `PublishModal.showAuthRequired()` is called. The user clicks "Sign in" — `_signInAndReturn()`:

1. Serializes current `EditorSession` edits + source to `sessionStorage`/IndexedDB via `stashSession()` ([`src/editor/edit-persistence.js`](../src/editor/edit-persistence.js)).
2. Redirects to `/login?next=<current URL with ?resume=<token>&publish=1>`.
3. Post-login, the caller is expected to detect `?resume` and call `restoreEdits()` on a fresh session.

([`src/editor/publish-modal.js:155–163`](../src/editor/publish-modal.js#L155))

---

## 5. Events

### Session internal events

`EditorSession` uses a listener set, not DOM events. Subscribe via `session.onChange(fn)`.

| Trigger                          | When fired                   |
| -------------------------------- | ---------------------------- |
| `session.reset()`                | New model loaded             |
| `session.recordMaterialEdit()`   | Any material property change |
| `session.clearMaterialEdit()`    | Material reset               |
| `session.recordTransformEdit()`  | Any node transform change    |
| `session.recordVisibilityEdit()` | Visibility toggle            |
| `session.restoreEdits()`         | Edits restored from stash    |

### Publish progress events

Passed to `publishEditedGLB({ onStep })` as a callback, not DOM events.

| `step` value | `pct` range | When                           |
| ------------ | ----------- | ------------------------------ |
| `'export'`   | 0 → 1       | GLB serialization start → done |
| `'presign'`  | — → 1       | Presign response received      |
| `'upload'`   | 0 → 1       | XHR upload progress            |
| `'register'` | — → 1       | Avatar record created          |
| `'widget'`   | — → 1       | Widget record created          |

(`PublishModal.onStep` maps `'presign'` → `'upload'` bucket for UI display.)

### Pre-1.0 rough edge #5 — no DOM CustomEvents from the Editor

The `Editor` class and all panels communicate via `session.onChange()` callbacks and direct method calls. No `CustomEvent` is dispatched on any DOM node. External hosts integrating the editor cannot listen to edit events on the element without accessing `editor.session.onChange()` directly. This is an integration gap for the `<agent-3d editor>` web-component path.

---

## 6. Extension points

### Adding a custom panel

There is no formal plugin API. The pattern followed by existing panels:

1. Class takes `(viewer, session)` in its constructor.
2. Exposes `rebuild()` called by `Editor.onContentChanged()`.
3. Exposes `dispose()` for cleanup.
4. Optionally adds a dat.gui folder via `viewer.gui`.
5. Calls `session.onChange()` to react to upstream changes, returns the unsubscribe function for cleanup.

To wire a custom panel into the orchestrator, modify `Editor` in [`src/editor/index.js`](../src/editor/index.js) — there is no registration mechanism today.

### Adding a custom exporter

`exportEditedGLB` in [`src/editor/glb-export.js`](../src/editor/glb-export.js) is a standalone async function:

```js
async function exportEditedGLB(session: EditorSession): Promise<Uint8Array>
```

A custom exporter can be dropped in by:

1. Reading `await session.getSourceBuffer()` for the original bytes.
2. Reading `session.materialEdits`, `session.transformEdits`, `session.visibilityEdits` for the accumulated changes.
3. Returning a `Uint8Array` of any desired format.

No formal exporter plugin contract exists; the `Editor._exportGLB()` method ([`src/editor/index.js:108`](../src/editor/index.js#L108)) hardcodes the import. Replacing the exporter requires editing the orchestrator.

**Recommendation:** Do not invest in a custom exporter plugin seam until the `editor` attribute is wired in `element.js` — the integration surface is too unstable before that.

---

## 7. Security

### What is sanitized before upload

**Content-type allowlist:** Only `model/gltf-binary` and `model/gltf+json` are accepted by the presign and avatar-create endpoints. This is enforced by the Zod schema `avatarContentType` at [`api/_lib/validate.js:20–23`](../api/_lib/validate.js#L20). An upload of any other MIME type (HTML, SVG, JS, etc.) is rejected with `400 validation_error` before a presigned URL is issued — preventing XSS via CDN-hosted file.

**Storage key ownership:** `POST /api/avatars` verifies that the submitted `storage_key` starts with `u/{auth.userId}/` and does not contain `..` ([`api/avatars/index.js:50–53`](../api/avatars/index.js#L50)). Users cannot register objects uploaded by other users.

**R2 object existence:** `headObject(storage_key)` is called before writing the `avatars` record ([`api/avatars/index.js:56–57`](../api/avatars/index.js#L57)). If the object is not in R2 or the `size_bytes` does not match, the request is rejected. This blocks attempts to register a fake record without performing the upload.

**Optional checksum:** If the browser includes a `checksum_sha256` in the presign or register body, it is stored. If not provided, the server attempts to read it from the R2 object metadata ([`api/avatars/index.js:63–79`](../api/avatars/index.js#L63)). Not enforced as required today.

### Size limits

| Limit                     | Value                | Enforced by                                                            |
| ------------------------- | -------------------- | ---------------------------------------------------------------------- |
| Client-side publish limit | 25 MB                | [`src/editor/publish.js:17`](../src/editor/publish.js#L17) `MAX_BYTES` |
| Server-side schema max    | 500 MB               | [`api/_lib/validate.js:58,63`](../api/_lib/validate.js#L58)            |
| Rate limit (uploads)      | 60 per hour per user | `limits.upload(userId)` in presign                                     |

The client enforces 25 MB; the server allows up to 500 MB. A caller bypassing the client library can upload up to 500 MB.

### Allowed MIME types

`model/gltf-binary` and `model/gltf+json` only. Enforced at both presign and register endpoints.

### SSRF

The presign flow issues a PUT URL for direct browser-to-R2 upload; the server never fetches the uploaded content. No SSRF surface in the publish path.

`EditorSession.getSourceBuffer()` does `fetch(this.sourceURL)` ([`src/editor/session.js:179`](../src/editor/session.js#L179)) to retrieve the source model bytes. This runs in the **browser**, not the server, so there is no server-side SSRF. However, any URL the user can set as `sourceURL` is fetched. This is intentional: users can load GLBs from arbitrary HTTPS origins (subject to browser CORS policy).

---

## 8. Versioning

### Spec version

This document covers `agent-editor/0.1`. Breaking changes bump the minor until 1.0; after 1.0 they bump the major.

A **breaking change** is:

- Removing or renaming a published export from any `src/editor/*.js` module.
- Changing the shape of `materialEdits`, `transformEdits`, or `visibilityEdits` in a way that breaks `restoreEdits()` round-trips.
- Changing the publish API endpoints or their response shapes.
- Removing an attribute that the embed editor reads or writes.

A **non-breaking change** is:

- Adding new optional fields to patch objects.
- Adding new dat.gui controls.
- New `onStep` step names (callers should ignore unknown steps).
- CSS/layout changes inside panels.

### Detecting the editor version at runtime

No version attribute or event exists today. To check which spec version an editor host speaks:

**Recommended (not yet implemented):** Add a `data-editor-version="agent-editor/0.1"` attribute to the root element mounted by `mountEmbedEditor`, and/or dispatch a `editor:ready` CustomEvent with `{ version: 'agent-editor/0.1' }` on the host element at mount time. This attribute/event should be added before the `editor` attribute is wired in `element.js`.

Until then, feature-detect by checking whether the `Editor` class is exported from [`src/editor/index.js`](../src/editor/index.js).

---

## Pre-1.0 rough edges — summary

| #   | Location                                                                     | Issue                                                                                                                      |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | [`src/element.js:211`](../src/element.js#L211)                               | `editor` boolean attribute not wired — `<agent-3d editor>` does not activate the editor                                    |
| 2   | [`src/editor/material-editor.js:100`](../src/editor/material-editor.js#L100) | `emissiveIntensity` changes are not recorded to session — lost on export                                                   |
| 3   | [`src/editor/glb-export.js:106`](../src/editor/glb-export.js#L106)           | Hidden nodes written as `scale=[0,0,0]` instead of `KHR_node_visibility`                                                   |
| 4   | [`src/editor/glb-export.js:53`](../src/editor/glb-export.js#L53)             | Duplicate material/node names resolve to first match only — no warning                                                     |
| 5   | [`src/editor/index.js`](../src/editor/index.js)                              | No DOM `CustomEvent` emitted — external hosts cannot observe edit activity without accessing `session.onChange()` directly |

---

## See also

- [EMBED_SPEC.md](./EMBED_SPEC.md) — full attribute reference for `<agent-3d>`
- [AGENT_MANIFEST.md](./AGENT_MANIFEST.md) — manifest format
- [`src/editor/`](../src/editor/) — source of truth for all claims above
- [`api/avatars/`](../api/avatars/) — presign and register endpoints
- [`api/_lib/validate.js`](../api/_lib/validate.js) — content-type allowlist and size limits
