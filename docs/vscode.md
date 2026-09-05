# three.ws in VS Code

Two extensions put the platform inside the editor. **three.ws 3D** makes model
files and 3D generation native to VS Code. **three.ws x402** does the same for
paid endpoints. This page covers the first; see [x402](./x402.md#open-source-packages) for
the second.

| | |
|---|---|
| **Extension** | three.ws 3D (`threews.vscode-3d`) |
| **Source** | [`packages/vscode-3d`](../packages/vscode-3d) |
| **Requires** | VS Code 1.85 or newer |
| **Auth** | None. Generation runs on the free lane. |

## What it does

VS Code has no idea what a `.glb` is. Every 3D asset in a repository is an opaque
binary you have to leave the editor to look at: upload it somewhere, open a
browser viewer, come back. This extension closes that loop.

**Model files render in an editor tab.** Double-click any `.glb` or `.gltf` and
it opens in a three.js viewer instead of the "binary file not shown" screen.
Orbit with the left mouse button, pan with the right, zoom with the wheel.
Animation clips get a picker, a play/pause button, and a scrub bar. There are
toggles for a wireframe, the skeleton, the ground grid, and a slow auto-orbit,
plus a **Snapshot** button that writes the current camera view as a PNG next to
the model.

Draco, KTX2/Basis, and meshopt assets decode locally: the decoders ship inside
the extension rather than loading from a CDN, so a meshopt-compressed three.ws
avatar (which is most of them) renders on a plane with no connection.

**Every model carries a report.** The panel behind the **Report** button lists
triangles, vertices, meshes, materials, textures and their weight, animations,
rig size, and the glTF extensions in use, followed by optimization notes:
oversized textures, non-indexed primitives, a mesh that would benefit from
compression. It is the same inspector that powers the
[`/validation`](https://three.ws/validation) page, running in the extension host,
so your model is never uploaded anywhere to be measured.

**Models can be generated in place.** `3D: Generate a Model from Text` describes
an object; `3D: Generate an Avatar from Text` describes a character. Both call
the free [3D Studio](./mcp-studio.md) lane, save the finished GLB into your
workspace, and open it in the viewer. `3D: Rig a Model for Animation` sends a
static model to the auto-rigger and brings back one with a humanoid skeleton.

**The embed snippet is generated correctly.** `3D: Insert <agent-3d> Embed
Snippet` reads the live release manifest, pins the current library version, adds
its subresource-integrity hash, and writes the whole thing at your cursor:

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

That is the snippet [Embedding](./embedding.md) documents, with the pin already
resolved. Set `threews3d.embedChannel` to `latest`, `1`, or `1.5` if you would
rather follow a moving channel than pin exact bytes.

**The sidebar has both halves of your library.** The three.ws icon in the
activity bar lists every model in the workspace (grouped by folder, with file
sizes) and, below it, recent public creations from the forge. Preview any of
those in the viewer, and import the ones you want with one click.

## Install

The extension is not on the Marketplace yet. Build and install it from the
repository:

```bash
cd packages/vscode-3d
npm install
npm run package
code --install-extension vscode-3d-0.1.0.vsix
```

For development, open `packages/vscode-3d` in VS Code and press <kbd>F5</kbd> to
launch an Extension Development Host with the extension loaded, or run
`npm run watch` to rebuild on every change.

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
| `threews3d.embedChannel` | `pinned` | `pinned` resolves the current release plus its SRI hash; or name a channel. |

## What talks to the network, and what does not

Three public, unauthenticated endpoints, and nothing else:

| Call | Endpoint | When |
|---|---|---|
| Generate, rig | `POST /api/mcp-studio` | Only when you run a generate or rig command. |
| Gallery feed | `GET /api/forge-gallery` | The first time you expand the gallery view. |
| Release pin | `GET /agent-3d/versions.json` | When you insert an embed snippet. |

The viewer itself is local. Its webview runs under a content security policy that
allows a single nonce-gated script and no remote origin, so the only thing that
crosses the network while you look at a model is the model file. Opening,
inspecting, animating, and snapshotting a `.glb` makes no requests at all.

## Embedding or rigging a local file

Both need a URL that a browser or the rigger can fetch. Models the extension
generated or imported remember where they came from, so those commands work
without asking. For a `.glb` that has only ever existed on your disk, the
extension asks for the https URL where it is hosted rather than handing you a
snippet that renders nothing. Upload it (any static host works, or generate it
through the extension in the first place) and paste the URL.

## Related

- [Embedding](./embedding.md) documents every `<agent-3d>` attribute.
- [3D Studio MCP](./mcp-studio.md) is the free generation lane the extension
  calls, and the same tools are available to any MCP client.
- [x402](./x402.md) covers the sibling extension for paid endpoints.
- [The 3D asset pipeline](./3d-asset-pipeline.md) explains what the optimization
  notes in the report are asking for.
