# three.ws 3D for VS Code

Preview 3D models where you already are. This extension makes `.glb` and `.gltf`
files first-class in VS Code: double-click one and it renders, animates, and
reports on itself in an editor tab, next to the code that ships it. When you need
a model that does not exist yet, generate it from a text prompt on the free
[three.ws](https://three.ws) lane without leaving the window.

Nothing here is a preview stub. The viewer is three.js with the same lighting and
decoders the three.ws site uses, the report is the platform's own inspector, and
generation calls the live studio API.

## Features

- **A real viewer, as the default editor for model files.** Orbit, pan, and zoom
  with the mouse. Animation clips get a picker, a play/pause button, and a scrub
  bar. Toggle a wireframe, the skeleton, the ground grid, or a slow auto-orbit.
  Draco, KTX2/Basis, and meshopt assets decode locally from decoders shipped
  inside the extension, so a compressed three.ws avatar renders offline.
- **Model report.** Triangles, vertices, meshes, materials, texture count and
  weight, animations, rig size, and glTF extensions, plus optimization notes
  ("3 textures at 4K", "re-indexing typically halves the vertex count"). It is
  the same inspector that powers the three.ws `/validation` page, running in the
  extension host: your model is never uploaded anywhere to be measured.
- **Text to 3D.** `3D: Generate a Model from Text` for an object or prop,
  `3D: Generate an Avatar from Text` for a character. Both run on the free lane
  (no key, no account), save the GLB into your workspace, and open it.
- **Auto-rigging.** `3D: Rig a Model for Animation` sends a static model to the
  three.ws rigger and brings back one with a humanoid skeleton and skin weights.
- **Embed snippet, correctly pinned.** `3D: Insert <agent-3d> Embed Snippet`
  resolves the current library version and its subresource-integrity hash from
  the live release manifest and writes a ready-to-paste snippet at your cursor.
- **Forge gallery.** Browse recent public three.ws creations in the sidebar,
  preview any of them in the viewer, and import the ones you want.
- **PNG snapshots.** `Snapshot` in the viewer toolbar writes the current camera
  view as a PNG beside the model, sized to the panel. Useful for a README, a PR,
  or a design review.

## Install

From the workspace root:

```bash
cd packages/vscode-3d
npm install
npm run build
```

Then press <kbd>F5</kbd> in VS Code with `packages/vscode-3d` open to launch an
Extension Development Host, or build a `.vsix` and install it:

```bash
npm run package
code --install-extension vscode-3d-0.1.0.vsix
```

## Use it

Open any `.glb` or `.gltf` in the explorer. That is the whole setup: the viewer
is the default editor for those files, and the **three.ws 3D** icon in the
activity bar lists every model in the workspace alongside the public gallery.

To make something new, run **3D: Generate a Model from Text** from the command
palette, describe one subject ("a friendly round robot mascot, glossy white
plastic, big blue eyes"), and the finished GLB lands in your `models/` folder and
opens. Then either **Rig for animation** to make it posable, or **Insert embed**
to put it on a page:

```html
<script
  type="module"
  src="https://three.ws/agent-3d/1.5.2/agent-3d.js"
  integrity="sha384-…"
  crossorigin="anonymous"
></script>

<agent-3d
  body="https://three.ws/cdn/creations/…/mesh.glb"
  style="width: 400px; height: 500px; display: block;"
></agent-3d>
```

## Commands

| Command | What it does |
|---|---|
| `3D: Generate a Model from Text` | Free text to 3D. Saves the GLB and opens it. |
| `3D: Generate an Avatar from Text` | Same, tuned for characters. |
| `3D: Rig a Model for Animation` | Adds a humanoid skeleton to a static model. |
| `3D: Insert <agent-3d> Embed Snippet` | Writes a pinned, SRI-checked embed at the cursor. |
| `3D: Preview a Model URL` | Opens any hosted `.glb` in the viewer. |
| `3D: Open in the three.ws Viewer` | Opens the model in the browser viewer. |
| `3D: Copy the Model's three.ws URL` | Copies the hosted URL to the clipboard. |
| `3D: Save a PNG Snapshot of the View` | Writes the current view beside the model. |

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `threews3d.origin` | `https://three.ws` | Host of the studio API and the gallery. |
| `threews3d.downloadFolder` | `models` | Workspace folder generated models are saved into. |
| `threews3d.tier` | `draft` | Detail level for text to 3D: `draft`, `standard`, or `high`. All free. |
| `threews3d.environment` | `studio` | Image-based lighting: `studio`, `neutral`, or `none`. |
| `threews3d.showGrid` | `true` | Show the ground grid when a model opens. |
| `threews3d.autoRotate` | `false` | Orbit the camera automatically when a model opens. |
| `threews3d.embedChannel` | `pinned` | `pinned` resolves the current release plus its SRI hash; or name a channel such as `latest`, `1`, or `1.5`. |

## How it works

Generation, rigging, and the gallery go through public, unauthenticated three.ws
endpoints:

- `POST /api/mcp-studio` is the JSON-RPC studio. The extension calls the
  `forge_free`, `text_to_avatar`, and `rig_mesh` tools. No key, no account, no
  payment: the platform's server-side keys cover provider cost.
- `GET /api/forge-gallery` is the public feed of recent creations.
- `GET /agent-3d/versions.json` is the library release manifest the embed snippet
  pins against.

Everything else is local. The viewer runs three.js inside a webview whose content
security policy allows exactly one nonce-gated script and no remote origin, so
the only thing that crosses the network is the model file itself. The Draco and
Basis decoders are copied out of three.js at build time and served from the
extension, never from a CDN.

## Which model can be embedded or rigged

Both need a URL the browser (or the rigger) can fetch. Models this extension
generated or imported carry their three.ws URL, so those commands just work. For
a local file that has never been uploaded, the extension asks for the https URL
where it is hosted rather than handing you a snippet that renders nothing.

## Develop

```bash
npm run watch   # rebuild the host bundle and the webview on change
npm test        # builds, then runs the suite
```

`npm test` activates the bundled extension against a stand-in extension host and
asserts that every command, view, and custom editor the manifest promises really
registers, that the viewer webview is nonce-gated and CDN-free, and that the
model reaches it. The studio, gallery, embed, and naming modules are unit tested
against local HTTP servers.

## Related

- [`docs/vscode.md`](../../docs/vscode.md) walks through the whole workflow.
- [`@three-ws/vscode-x402`](../vscode-x402) is the sibling extension for paying
  x402 endpoints from the editor.
- [`docs/embedding.md`](../../docs/embedding.md) documents every `<agent-3d>`
  attribute the inserted snippet can take.
- [`@three-ws/glb-tools`](../glb-tools) does inspection and baking from the shell
  and CI.

Apache-2.0. Built by [three.ws](https://three.ws).
