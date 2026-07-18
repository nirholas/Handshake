# Editor Guide

The three.ws editor lets you inspect and modify an agent's 3D model, adjust materials and textures, build the agent manifest, and publish the result to the platform. It runs entirely in the browser: open a GLB, edit, and publish or download. This guide covers the full workflow from opening a file through publishing.

---

## Accessing the Editor

### Edit an existing agent

If you own an agent and are authenticated:

```
https://three.ws/agent/<agent-id>/edit
```

This opens the agent edit page pre-loaded with your agent's GLB and configuration. You must be signed in. The platform checks ownership server-side when you attempt to save or publish.

Two more entry points:

```
https://three.ws/agent/new           starts a new agent from scratch
https://three.ws/app?agent=<id>      the viewer app shell in editing mode with save-back
```

### Open any GLB file (no account required)

Navigate to:

```
https://three.ws/app
```

Then drag and drop any `.glb` file onto the viewport. The editor loads the file locally — nothing is uploaded until you explicitly publish. Unauthenticated users can freely inspect and modify the model in the viewport; publishing requires signing in.

---

## Editor Layout

The editor is organized into four regions:

| Region | What it contains |
|---|---|
| **Scene Explorer panel** | The full object tree, with an inspector below it showing the selected object's properties |
| **Center** | 3D viewport (three.js canvas with editing enabled) |
| **Animation panel** | Clip buttons rendered by the viewer for rigged models |
| **dat.GUI "Editor" folder** | Quick-access actions: download GLB, publish as embed, scene panel, save edits, revert all edits |

The dat.GUI panel (behind the Controls toggle, top-right corner) is the primary way to trigger editor actions. The Scene Explorer is toggled with the `T` key or the "scene panel [T]" button.

---

## Scene Explorer

The Scene Explorer (`scene-explorer.js`) mirrors the Three.js scene graph as an interactive tree. Open it with `T` or the "Scene Panel" button.

### Reading the tree

Each node shows a type icon, its name, and a visibility toggle:

| Icon | Type |
|---|---|
| 📦 | Mesh |
| 🧍 | Skinned mesh |
| 🎯 | Group |
| 🦴 | Bone |
| 💡 | Light |
| 📷 | Camera |
| 🌳 | Scene root |

The **●/○ toggle** on each row shows or hides that node. Hidden nodes are written into the export (scaled to zero — see [Known Limitations](#known-limitations)).

### Selecting objects

- **Click a row** to select the object. It highlights in the viewport.
- **Double-click** to frame the camera on the selection.
- **Click in the viewport** to ray-cast and select the object under the cursor.

Once an object is selected, the inspector panel below the tree shows its position, rotation, scale, geometry stats, and (for lights/cameras) their specific properties.

### Transform gizmo

With an object selected, a transform gizmo appears in the viewport. Switch modes with keyboard shortcuts:

| Key | Mode |
|---|---|
| `W` | Translate |
| `E` | Rotate |
| `R` | Scale |
| `Escape` | Deselect |

Transform changes are recorded as overrides in the editor session and included in the exported GLB.

### Filtering the tree

Use the search box at the top of the Scene Explorer to filter nodes by name. Useful for scenes with hundreds of bones.

---

## Material Editor

The Material Editor (`material-editor.js`) appears as a set of dat.GUI folders — one per material found in the scene. It handles `MeshStandardMaterial` and `MeshPhysicalMaterial` (the two material types used in glTF files).

### Editable properties

| Property | What it controls |
|---|---|
| **Base color** | Albedo color (RGB) |
| **Metalness** | 0 = plastic/dielectric, 1 = metallic |
| **Roughness** | 0 = mirror-smooth, 1 = fully matte |
| **Emissive color** | Self-illumination color |
| **Emissive intensity** | Multiplier on the emissive color |
| **Opacity** | Overall transparency (requires alpha mode) |
| **Alpha test** | Cutoff threshold for Mask mode |
| **Wireframe** | Preview only — not written to export |
| **Flat shading** | Disables smooth normals |
| **Env map intensity** | Strength of environment reflections |
| **Side** | Front / Back / Double |

Each material folder has a **Reset** button that reverts it to the original glTF values.

### How edits are stored

Material edits are recorded in the session as patches keyed by material name. The original GLB on disk is never touched. When you export or publish, the patch is applied to the source bytes via [gltf-transform](https://gltf-transform.donmccurdy.com/) before writing the output file.

> **Why patches instead of saving the whole file?** This keeps edits small and reversible. The "Revert" button in the dat.GUI discards all patches and reloads the original.

---

## Texture Inspector

The Texture Inspector (`texture-inspector.js`) opens a panel (toggle with `X`) showing a thumbnail grid of every texture in the loaded GLB.

### What it shows

For each texture:

- **Thumbnail** — rendered at native resolution
- **Format** — PNG, JPEG, KTX2, WebP, or video
- **Dimensions** — width × height in pixels
- **Estimated memory** — uncompressed VRAM footprint
- **Wrap and filter modes** — repeat, clamp, mip settings
- **Which material slots reference it** — base color, normal, roughness/metallic, emissive, etc.
- **Which mesh nodes use those materials** — useful for finding UV problems

### Lightbox viewer

Click any thumbnail to open a full-screen lightbox with advanced inspection tools:

- **Per-channel extraction** — view R, G, B, or A channel as grayscale
- **Alpha over checkerboard** — verify transparent areas
- **UV wireframe overlay** — draw UV seams from mesh attributes over the texture
- **Zoom and pan** — mouse wheel to zoom, drag to pan, Fit button to reset

The Texture Inspector is read-only. Texture replacement (upload a new image to replace an existing slot) is on the roadmap but is not yet available in the current release.

---

## Morph Targets

If the loaded model contains morph targets (also called blend shapes), sliders appear in the inspector panel when a mesh is selected.

- Range: **0.0** (rest pose) to **1.0** (full deformation)
- Changes are applied in real-time in the viewport
- The emotion system drives ARKit-style blendshape names (`mouthSmile`, `browInnerUp`, `eyesClosed`, and similar); if your model's targets use those names, expressions work automatically

Use these sliders to verify expressions look correct before connecting them to the emotion system. Morph target influences are not currently written to the export.

---

## Animation Controls

The animation panel (rendered by the viewer, `src/viewer.js` `.anim-panel`) lists the clip library available to the loaded rig.

- **Play** per clip: click the clip button to crossfade to it
- **Stop all** (⏹) — halts all running clips
- **Active state** — the currently playing clip is highlighted
- **1-9 keys**: trigger the first nine clips

Animations continue running while you adjust materials. This is intentional: it lets you preview how the avatar looks in motion while tweaking a roughness value, rather than evaluating a static pose.

Clips embedded in the GLB itself get per-clip toggles and a playback-speed slider in the dat.GUI **Animation** folder.

---

## Manifest Builder

The Manifest Builder (`manifest-builder.js`) generates the `agent-manifest/0.1` JSON bundle that defines the agent's full configuration. Access it from the dat.GUI or the agent-edit page.

It is organized into sections:

### Identity
- Agent name and description
- Profile image
- Tags

### Body
- GLB file (upload a file or provide a URL)
- Format: `gltf-binary`, `gltf`, or `vrm`
- Rig type: Mixamo, VRM, or custom
- Bounding box override

### Brain
- AI provider: Anthropic, OpenAI, local, or none
- Model selection
- System instructions (text area)
- Temperature, max tokens, thinking mode

### Voice
- TTS provider and voice ID
- Speech rate and pitch
- STT provider, language, continuous listening toggle

### Skills
- Add or remove skill URIs
- Toggle built-in skills (wave, validate, remember, etc.)

### Memory
- Mode: `local`, `ipfs`, `encrypted-ipfs`, or `none`
- IPFS provider and index settings
- Max tokens for memory context

The manifest is validated against a Zod schema before export. Draft state is auto-saved to `localStorage` under the key `manifest-builder-draft` so your work survives a page reload.

Clicking **Generate** produces either a ZIP bundle (manifest.json + assets) or a raw JSON string you can copy directly.

---

## Save and Publish Flow

### Auto-save (local, no account required)

The editor session (`session.js`) tracks a dirty flag whenever you make a change. Edits are also persisted to `sessionStorage` (JSON) and `IndexedDB` (file bytes) by `edit-persistence.js`. If you navigate away and come back, or if the page redirects to login and returns, your edits are restored automatically.

A "Unsaved changes" warning appears in the browser's beforeunload dialog if you try to close the tab with unsaved edits.

### Save to account

The **Save to Account** button triggers `save-back.js`, which runs a four-step pipeline:

1. Export the modified GLB from the session
2. Request a signed upload URL from `/api/avatars/presign`
3. PUT the GLB bytes directly to cloud storage (R2)
4. PATCH the avatar record with the new GLB URL and storage key

Requires authentication. The platform validates storage key ownership server-side.

### Publish

The **Publish** button in dat.GUI opens the publish modal (`publish-modal.js`), which shows step-by-step progress:

| Step | What happens |
|---|---|
| **Export** | Session edits applied to source GLB via gltf-transform |
| **Upload** | Bytes sent to cloud storage (25 MB limit enforced client-side) |
| **Register** | Avatar metadata written to `/api/avatars` |
| **Widget** | Turntable widget config created at `/api/widgets` |

On success, the modal shows three ready-to-use snippets:

- **Share link** — direct URL to the agent page
- **Iframe snippet** — embed in any webpage
- **Web component snippet** — `<agent-3d>` element

If you are not signed in, the modal stashes the current session (bytes + edits) and redirects to `/login?next=<url>`. After login, the editor resumes exactly where you left off.

### Export GLB (download only)

The **Download** button in dat.GUI runs the export without publishing. Your edits are applied to the source GLB and a `.glb` file is downloaded to your machine. The original file is unchanged.

---

## The Override System

The editor never modifies the source GLB in memory. Instead, it maintains a set of named patches:

- `materialEdits` — PBR property values keyed by material name
- `transformEdits` — position, rotation, scale keyed by node name
- `visibilityEdits` — visibility flag keyed by node name

When exporting, `glb-export.js` loads the original source bytes, applies all patches by name-matching against the gltf-transform document, and writes the result. This means:

- **The original is always recoverable** — hit Revert at any time
- **Edits are portable** — the same override set can be applied to an updated version of the base model (`apply-overrides.js`)
- **Round-trips work** — if you publish, edit the server copy, and re-open, the patches from the server are applied on load

> Name-based matching means that if a material or node is renamed in the source GLB, the patch won't apply. Keep names stable when iterating on your model.

---

## Programmatic Editing (Advanced)

The viewer exposes the Three.js scene directly. You can access it from the browser console or from a script running on the page:

```js
const viewer = document.querySelector('agent-3d').viewer;

// Change a material's base color
const mesh = viewer.content.getObjectByName('Body');
mesh.material.color.setHex(0xff6600);
viewer.invalidate(); // trigger re-render

// Set a morph target influence
mesh.morphTargetInfluences[0] = 0.5;

// Export the modified GLB (returns Uint8Array)
import { exportEditedGLB } from '/src/editor/glb-export.js';
const session = editor.session;
const bytes = await exportEditedGLB(session);
```

To hook into the editor session change events:

```js
const editor = viewer._editor; // set when editor mode is active
editor.session.onChange(() => {
  console.log('edits changed:', editor.session.materialEdits);
});
```

The `onChange` callback fires on any material, transform, or visibility edit, and also on session reset (new file loaded).

---

## Known Limitations

The editor is at format version `agent-editor/0.1`. The following rough edges are documented in the spec and will be addressed before 1.0:

1. **`editor` attribute not wired** — the `<agent-3d editor>` attribute is parsed but does not auto-mount the editor panels. Use the JS `Editor` class directly.
2. **Emissive intensity not persisted** — emissive intensity changes are visible in the viewport but are not written to the exported GLB.
3. **Visibility via scale hack** — hidden nodes are exported with `scale=[0,0,0]` rather than being removed or flagged. This is not spec-compliant and may cause issues in downstream tools.
4. **Duplicate material names** — if the GLB contains two materials with the same name, only the first match is patched during export.
5. **No DOM events** — the editor does not fire DOM events on session changes. External code must call `session.onChange()` directly.

The full contract lives in [specs/EDITOR_SPEC.md](https://github.com/nirholas/three.ws/blob/main/specs/EDITOR_SPEC.md).

## Related

- [3D Viewer](/docs/viewer): the rendering layer the editor sits on
- [Agent Manifest](/docs/agent-manifest): the manifest format the builder produces
- [Avatar creation](/docs/avatar-creation): generate an avatar to edit
- [Embedding](/docs/embedding): what the published embed snippet gives you
