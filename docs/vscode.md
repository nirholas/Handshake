# three.ws in VS Code

Two extensions put the platform inside the editor. **three.ws 3D** makes model
files, 3D generation, animation, and embedding native to VS Code. **three.ws
x402** does the same for paid endpoints. This page covers the first; see
[x402](./x402.md#open-source-packages) for the second.

| | |
|---|---|
| **Extension** | three.ws 3D (`threews.vscode-3d`), version 0.2.0 |
| **Source** | [`packages/vscode-3d`](../packages/vscode-3d) |
| **Requires** | VS Code 1.85 or newer |
| **Auth** | None. Generation, refinement, the motion library, and the quality check all run on free lanes. |

## What it does

VS Code has no idea what a `.glb` is. Every 3D asset in a repository is an opaque
binary you have to leave the editor to look at: upload it somewhere, open a
browser viewer, come back. And once you can see it, the next questions (does it
animate, is it too heavy, what changed since the last commit, is the embed on
my page correct) each need another tool. This extension closes the whole loop.

### See it

**Model files render in an editor tab.** Double-click any `.glb` or `.gltf` and
it opens in a three.js viewer instead of the "binary file not shown" screen.
Orbit with the left mouse button, pan with the right, zoom with the wheel.
Animation clips get a picker, a play/pause button, and a scrub bar. There are
toggles for a wireframe, the skeleton, the ground grid, and a slow auto-orbit.
**Snapshot** writes the current camera view as a PNG next to the model;
**Turntable** writes a looping GIF of one full orbit, with the playing animation
stepped in sync, sized by `threews3d.turntableFrames` and `turntableSize`.

Draco, KTX2/Basis, and meshopt assets decode locally: the decoders ship inside
the extension rather than loading from a CDN, so a meshopt-compressed three.ws
avatar (which is most of them) renders on a plane with no connection.

**Every model carries a report.** The panel behind the **Report** button lists
triangles, vertices, meshes, materials, textures and their weight, animations,
rig size, and the glTF extensions in use, followed by optimization notes. It is
the same inspector that powers the [`/validation`](https://three.ws/validation)
page, running in the extension host, so your model is never uploaded anywhere
to be measured. The status bar repeats the headline numbers (triangles, size,
bones, clips) while a model is open; click it to toggle the report.

### Move it

**Any rig plays the library.** Press **Animate** (or run `3D: Try a Library
Animation on this Model`) and a searchable picker lists the three.ws motion
library: 2,800 clips, the same ones the `/animations` gallery and the
`<agent-3d>` embed play. Pick one and it plays on the open model immediately.
Behind that, the clip (authored on the platform's canonical humanoid skeleton)
is retargeted onto the model's own bones inside the viewer by
[`src/animation-retarget.js`](../src/animation-retarget.js), the retargeter
that runs on three.ws itself, so Mixamo, Avaturn, VRM/VRoid, Unreal, Daz,
MakeHuman, Blender `.L/.R`, and simple `shoulderL` rigs all work. A rig it
cannot drive gets a message with how many bones matched and an offer to rig it.

**Bake it into the file.** While a library clip is playing, **Bake clip**
writes it into a copy of the model (`astronaut-waving.glb`) as real glTF
animation samplers and channels on the model's nodes, so the clip plays in
Unity, Unreal, Blender, `<model-viewer>`, or `<agent-3d>`, not only in this
viewer. Meshopt-compressed models are re-encoded rather than inflated.

**Or describe the motion.** `3D: Animate this Model from a Text Prompt` sends
"waving confidently with the right hand" or "a slow tai-chi sweep" to the
text-to-motion worker on the three.ws GPU fleet, which samples a clip in the
same format, and retargets it the same way. The picker offers this as its
first entry, so a search that finds nothing turns into a generation.

### Make it

**Models can be generated in place.** `3D: Generate a Model from Text`
describes an object; `3D: Generate an Avatar from Text` describes a character.
Both call the free [3D Studio](./mcp-studio.md) lane, save the finished GLB
into your workspace, and open it in the viewer.

**Refine by describing a change.** **Refine** (or `3D: Refine this Model by
Describing a Change`) asks for the change in words: "make it metallic", "bigger
helmet", "add a cape". The studio generates a new version anchored to the
current one, folding the original prompt into the new one so form and subject
carry forward, and records it in a version lineage. The new file saves as
`name-v2.glb`, then `-v3`, and the extension remembers the lineage per file, so
refining a refinement extends one history instead of forking a new one. After
each refinement you can jump straight to a structural comparison with the
previous version.

**Rig a static model.** `3D: Rig a Model for Animation` sends it to the
auto-rigger and brings back one with a humanoid skeleton, then offers to try an
animation on it.

**Ask a vision model what is wrong.** **Check quality** renders the current
view, sends the PNG to the quality gate that scores every three.ws generation,
and opens the verdict as a Markdown review: realism and completeness scores,
the subject it recognised, the defects it can see ("fused fingers", "back is
unfinished"), and a concrete fix. One click feeds that fix into **Refine**.
Because the render is what travels, this works on a file that has never left
your disk.

### Ship it

**Optimize for the web, locally.** `3D: Optimize a Copy for the Web` runs the
asset pipeline's passes in the extension host: dedup, prune, weld, resample
animations, and meshopt compression, with a **Compact** preset that adds vertex
quantization. It writes `name.web.glb` next to the original and reports the
savings ("12.0 MB → 3.1 MB (−74%), 210k → 98k vertices"). Nothing is uploaded.
Textures are left as they are; texture resizing stays in the server pipeline.

**Compare with the committed version.** `3D: Compare with the Committed
Version` reads the model at `HEAD` straight out of git (no checkout), opens it
in a second viewer beside your working copy, and writes a structural diff as a
Markdown review using [`@three-ws/glb-diff`](../packages/glb-diff): what changed
in geometry, materials, textures, skeleton, and animations, with a severity that
says whether a consumer of the model breaks. It is the review a binary blob in a
pull request cannot give you. The same comparison is offered after a refinement
(against the previous version) and after an optimization (against the original).

**`<agent-3d>` embeds are checked as you type.** In HTML, JSX/TSX, Vue, Svelte,
Astro, Markdown, and PHP files the extension runs the rules from the
[Embedding guide](./embedding.md) as diagnostics:

| Finding | Severity | Quick fix |
|---|---|---|
| Element has no `src`, `agent-id`, `avatar-id`, `manifest`, or `body` | error | |
| Element has no width and height (it collapses to 0×0) | warning | Add an inline 400×500 size |
| Library `<script>` on the `latest` channel | warning | Pin to the current release with its integrity hash |
| Library `<script>` on a minor channel (`1`, `1.5`) | hint | Pin to the current release |
| Pinned `<script>` with no `integrity` | hint | Add the published hash |
| Pinned `<script>` whose `integrity` does not match the release (the browser refuses it) | error | Use the published hash |
| A newer release exists than the one pinned | hint | Upgrade and re-pin |
| Unknown or misspelt attribute (`modee`) | information | Rename to the closest attribute |
| Invalid value for an enumerated attribute (`mode="popup"`) | warning | |
| An `api-key` written into HTML | warning | |

Hover any attribute for its documentation, get completions for attribute names
(sources first) and enumerated values, and use the CodeLens above an embed to
preview the referenced model in the viewer. The release and hash come from the
live manifest at `/agent-3d/versions.json`, cached for ten minutes; offline,
the rules that need it are skipped rather than guessed.

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

Set `threews3d.embedChannel` to `latest`, `1`, or `1.5` if you would rather
follow a moving channel than pin exact bytes (the diagnostics will then remind
you what that costs).

**The sidebar has both halves of your library.** The three.ws icon in the
activity bar lists every model in the workspace (grouped by folder, with file
sizes; right-click for Animate, Refine, Optimize, Compare) and, below it,
recent public creations from the forge. Preview any of those in the viewer, and
import the ones you want with one click.

## Install

The extension is not on the Marketplace yet. Build and install it from the
repository:

```bash
cd packages/vscode-3d
npm install
npm run package
code --install-extension vscode-3d-0.2.0.vsix
```

For development, open `packages/vscode-3d` in VS Code and press <kbd>F5</kbd> to
launch an Extension Development Host with the extension loaded, or run
`npm run watch` to rebuild on every change.

## Commands

| Command | What it does |
|---|---|
| `3D: Generate a Model from Text` | Free text to 3D. Saves the GLB and opens it. |
| `3D: Generate an Avatar from Text` | Same, tuned for characters. |
| `3D: Refine this Model by Describing a Change` | New version anchored to this one; lineage kept. |
| `3D: Try a Library Animation on this Model` | Search 2,800 clips; retarget and play in the viewer. |
| `3D: Animate this Model from a Text Prompt` | Text to motion, retargeted onto the rig. |
| `3D: Rig a Model for Animation` | Adds a humanoid skeleton to a static model. |
| `3D: Optimize a Copy for the Web` | Local dedup, weld, resample, meshopt (and quantize). |
| `3D: Compare with the Committed Version` | Structural diff against `HEAD`, viewers side by side. |
| `3D: Check Quality with a Vision Model` | Realism and completeness score, defects, fix hint. |
| `3D: Insert <agent-3d> Embed Snippet` | Writes a pinned, SRI-checked embed at the cursor. |
| `3D: Preview a Model URL` | Opens any hosted `.glb` in the viewer. |
| `3D: Open in the three.ws Viewer` | Opens the model in the browser viewer. |
| `3D: Copy the Model's three.ws URL` | Copies the hosted URL to the clipboard. |
| `3D: Save a PNG Snapshot of the View` | Writes the current view beside the model. |
| `3D: Save a Turntable GIF of the Model` | Writes a looping orbit beside the model. |
| `3D: Toggle the Model Report` | Shows or hides the report panel. |

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `threews3d.origin` | `https://three.ws` | Host of the studio API, gallery, motion library, and quality check. |
| `threews3d.downloadFolder` | `models` | Workspace folder generated models are saved into. |
| `threews3d.tier` | `draft` | Detail level for text to 3D: `draft`, `standard`, or `high`. All free. |
| `threews3d.environment` | `studio` | Image-based lighting: `studio`, `neutral`, or `none`. |
| `threews3d.showGrid` | `true` | Show the ground grid when a model opens. |
| `threews3d.autoRotate` | `false` | Orbit the camera automatically when a model opens. |
| `threews3d.embedChannel` | `pinned` | `pinned` resolves the current release plus its SRI hash; or name a channel. |
| `threews3d.turntableFrames` | `36` | Frames in a turntable GIF (one full orbit). |
| `threews3d.turntableSize` | `480` | Pixel size of each square turntable frame. |
| `threews3d.embedDiagnostics` | `true` | Check `<agent-3d>` and library `<script>` tags in supported files. |

## What talks to the network, and what does not

Public, unauthenticated endpoints, and nothing else:

| Call | Endpoint | When |
|---|---|---|
| Generate, rig, refine, collect a slow job | `POST /api/mcp-studio` | Only when you run one of those commands. |
| Motion library | `GET /api/animations/library`, then the clip's CDN URL | The first time you open the Animate picker; one clip per pick. |
| Text to motion | `POST /api/forge-motion`, `GET ?job=` | Only when you animate from a prompt. |
| Quality check | `POST /api/forge-quality-check` | Only when you run the check; carries the render, never the model. |
| Gallery feed | `GET /api/forge-gallery` | The first time you expand the gallery view. |
| Release pin | `GET /agent-3d/versions.json` | When you insert an embed snippet, and every ten minutes while a file with an embed is open. |

The viewer itself is local. Its webview runs under a content security policy that
allows a single nonce-gated script and no remote origin, so the only things that
cross the network while you look at a model are the model file and, when you
pick one, a clip. Retargeting runs in the webview. Baking, optimizing,
inspecting, and the structural diff run in the extension host with
glTF-Transform. Opening, inspecting, animating with the file's own clips,
optimizing, comparing, and snapshotting a `.glb` make no requests at all.

## Embedding, rigging, or refining a local file

Those three need a URL that a browser or the studio can fetch. Models the
extension generated or imported remember where they came from, so those
commands work without asking. For a `.glb` that has only ever existed on your
disk, the extension asks for the https URL where it is hosted rather than
handing you a snippet that renders nothing. Animating, baking, optimizing,
comparing, and the quality check work on a purely local file.

## Related

- [Embedding](./embedding.md) documents every `<agent-3d>` attribute the
  diagnostics and completions know.
- [3D Studio MCP](./mcp-studio.md) is the free generation lane the extension
  calls, and the same tools are available to any MCP client.
- [Animations](./animations.md) covers the motion library the Animate picker
  searches.
- [x402](./x402.md) covers the sibling extension for paid endpoints.
- [The 3D asset pipeline](./3d-asset-pipeline.md) explains what the optimization
  notes in the report are asking for, and what Optimize does about them.
