# Model Diff

**[Model Diff](https://three.ws/diff) answers the question a checksum cannot: not "are these two models different" but "what changed, and did anything just break".**

Drop a `.glb` on each side and you get a change set: every mesh, material, texture, node, skeleton, and animation clip classified as added, removed, renamed, moved, or modified, with renames detected by content rather than by name, and a severity you can gate a build on. Both models render in the same 3D scene so you can overlay them, wipe between them, or set them side by side, and clicking any node in the report frames that object in the viewport.

Files you drop are read with the browser File API and compared in your tab. Nothing is uploaded. A model given as a URL is fetched through the site's own GLB proxy (`/api/glb`), because an arbitrary CDN will not send the CORS header a browser needs to read it directly.

**On this page:** [The problem](#the-problem-a-model-that-loads-and-never-moves) · [Reading the report](#reading-the-report) · [Severity](#severity) · [How matching works](#how-matching-works) · [What counts as a change](#what-counts-as-a-change) · [The viewer](#the-viewer) · [The API](#the-api) · [The CLI](#the-cli) · [The MCP tool](#the-mcp-tool) · [The library](#the-library)

Related: [Rig Doctor](./rig-doctor.md) answers whether a single rig will animate at all; Model Diff answers whether the rig you already shipped still will. [Asset pipeline](./3d-asset-pipeline.md) covers the conversion and optimization steps whose output this is built to check. The free [3D API](https://three.ws/api/3d) lists this endpoint alongside inspect and generate.

---

## The problem: a model that loads and never moves

Animation clips address joints **by name**. So do attachment points, wardrobe anchors, and every retargeter in the pipeline.

That means the most expensive change a 3D asset can undergo is also the quietest one. Rename a bone, drop a joint, re-export through a tool that renumbers `Mesh.001`, and the file still parses, still renders, and the mixer still runs at 60fps against tracks that now address nothing. There is no exception, no console error, nothing to grep for. You find out when someone says the character is standing in a T-pose.

Every tool that could have caught it fails at exactly this point:

- **A byte comparison** flags every re-export, including the ones that changed nothing observable. It is right too often to be useful.
- **File size** moves for both a texture recompression and a deleted limb.
- **A visual check** in a viewer catches missing geometry and misses a missing joint entirely, because a broken rig looks perfect in bind pose.

Model Diff is the check that separates them.

---

## Reading the report

### The verdict

The banner carries the overall severity, the counts, and one plain-language sentence about what that severity means. Below it sit the highlights: three to eight sentences, worst first, written to be the only part you read when you are in a hurry.

```
BREAKING   98 changes: +6 / -13 / ~70 / renamed 4 / moved 1

Skeleton "Character" lost 2 joints: mixamorig:LeftEye, mixamorig:RightEye. Clips that target them will not play.
Skeleton "Armature" was removed. The model is no longer rigged.
5 animations were removed ("agree", "idle", "run" and 2 more). Anything that plays them by name will fail.
Triangle count is down 21,006 (-42.8%).
```

### Totals

Only the metrics that moved: vertices, triangles, joints, nodes, meshes, materials, textures, animations, skeletons, texture bytes, and file size, each with before, after, delta, and percent. A row that did not change is not printed, because a wall of zeroes is what makes people stop reading diff output.

### Sections

One collapsible block per object kind, ordered by how much a change there costs you: skeletons, animations, meshes, nodes, materials, textures. Blocks whose severity is `major` or `breaking` open by themselves.

Each row is marked the way a diff is:

| Mark | Meaning |
| --- | --- |
| `-` | Removed: present in the baseline, gone from the candidate |
| `+` | Added: new in the candidate |
| `R` | Renamed: same content, different name |
| `M` | Moved: same node, different parent |
| `~` | Modified, with the changed fields listed underneath |

Node rows are clickable. Selecting one frames that object in the 3D viewer, which is the fastest way to answer "where is `mixamorig:LeftHandIndex1` and what happened to it".

---

## Severity

| Level | Meaning |
| --- | --- |
| `none` | The two models are structurally identical |
| `cosmetic` | Only metadata changed. Nothing a renderer or a clip can observe |
| `minor` | Appearance changed. The model still loads, animates, and keeps its shape |
| `major` | Geometry or hierarchy changed. Anything positioned against this model should be re-checked |
| `breaking` | Something a consumer references by name is gone. Clips, attachments, or materials bound to it will fail |

The ladder is defined by what a downstream consumer notices, not by how large the byte delta is. A 40 MB texture swap is `minor`, because everything still loads and plays. Deleting one joint is `breaking`, because every clip that addressed it silently stops moving.

---

## How matching works

A diff is only as good as its matching. Compare by name alone and every exporter that renumbers `Mesh.001` reports the whole file as rewritten. Compare by content alone and a rename looks like a deletion plus an unrelated addition.

So objects are paired in three passes, the same strategy `git` uses for file renames:

1. **By key.** The names agree, so the objects correspond.
2. **By fingerprint.** The names disagree but the content hashes identically, so it is a rename.
3. **By similarity.** Neither agrees, but one candidate scores close enough that "the same object, edited and renamed" is more honest than reporting an add and a remove.

Anything still unpaired after all three really is an addition or a removal.

Nodes carry a fourth distinction. A node that kept its name and changed parent is reported as **moved**, not as a rename, because reparenting changes where anything attached to that node ends up in world space even when nothing about the node itself changed.

Objects the file never named are labelled `(unnamed mesh 3)` and keyed to their slot, so they only ever pair with the same slot on the other side. Inventing a name like `mesh.3` would read as a real name in the report and, worse, would match an unrelated object that happened to come fourth in the other file.

If one section has so many unpaired candidates that the similarity pass would be quadratic beyond a sane bound, that pass is skipped and the report **says so** on that section rather than quietly downgrading renames into add-and-remove noise.

---

## What counts as a change

### Geometry

Vertex data is hashed at a quantum of `1e-4` units, roughly a tenth of a millimetre at human scale. A re-export through Blender, a `gltfpack` round trip, or a Draco decode perturbs positions in the `1e-6` range and does not register. A genuine edit moves vertices by orders of magnitude more and does.

Positions are not the only thing hashed. Normals, tangents, UV sets, vertex colors, and **skin joints and weights** all participate, because a re-skin that leaves every vertex exactly where it was still changes how the model deforms. A positions-only hash would call that unchanged, which is the wrong answer for the exact case this tool exists to catch.

The report distinguishes two kinds of geometry edit, because they mean different things:

- *same vertex and triangle count, different vertex data*: usually a re-bake, a re-skin, or a transform applied in place
- *vertex data rewritten*: a decimation, a remesh, or a different asset entirely

### Skeletons

Joint lists are compared by name. A removed joint is `breaking` and the report names it. A changed inverse-bind matrix set is `major` and says why: the bind pose moved, so existing clips will deform differently even though every joint is still present.

### Animations

Clips are compared on duration, channel count, keyframe count, interpolation modes, and the full list of `node.path` targets they drive. A target that disappears is `breaking` and is listed individually, because that is the precise mechanism by which a clip stops animating part of a character while still playing.

### Materials and textures

Every PBR factor, every texture slot assignment, alpha mode and cutoff, double-sidedness, and the material extension list. Textures are compared on dimensions, MIME type, byte size, and a hash of the encoded image, so a re-encode is distinguished from a repaint.

### Extensions

`extensionsUsed` and `extensionsRequired` are diffed separately. A newly **required** extension is `major` on its own: a viewer without support for it will refuse the file outright, which is not a rendering difference but a load failure.

---

## The viewer

Three modes, switchable with the keyboard (`O`, `W`, `S`; `H` toggles highlighting, `F` re-frames):

- **Overlay.** The baseline renders as a translucent blue ghost with the candidate solid on top. Best for spotting a shifted limb or a changed silhouette.
- **Wipe.** One screen-aligned clipping plane, dragged across the view. The plane is rebuilt from the camera basis every frame, so the seam stays vertical on screen no matter where you orbit.
- **Side by side.** Both models placed apart and orbiting together.

Changed objects are marked by cloning the authored material and pushing its emissive toward the marker colour (amber for edited, green for added, red for removed), rather than replacing it with a flat fill. The model still looks like itself; the changed parts glow.

---

## The API

`GET /api/3d/diff` is free and keyless, part of the [3D API bundle](https://three.ws/api/3d).

```bash
curl "https://three.ws/api/3d/diff?a=https://three.ws/avatars/cesium-man.glb&b=https://three.ws/avatars/michelle.glb"
```

```jsonc
{
  "version": 1,
  "identical": false,
  "severity": "breaking",
  "a": { "name": "cesium-man.glb", "url": "https://three.ws/avatars/cesium-man.glb", "sizeBytes": 438044 },
  "b": { "name": "michelle.glb", "url": "https://three.ws/avatars/michelle.glb", "sizeBytes": 849756 },
  "summary": { "changed": 111, "added": 75, "removed": 26, "modified": 1, "renamed": 1, "moved": 0 },
  "totals": { "triangles": { "a": 4672, "b": 28106, "delta": 23434, "pct": 501.6 } },
  "sections": { "skins": { "removed": [{ "name": "Armature", "severity": "breaking", "detail": "19 joints gone" }] } },
  "highlights": [{ "severity": "breaking", "text": "Skeleton \"Armature\" was removed. The model is no longer rigged." }],
  "ts": "2026-08-28T00:00:00.000Z"
}
```

`POST` the same two fields as JSON when the URLs are long. Add `format=markdown` for a pull-request-ready report, or `format=text` for the terminal rendering:

```bash
curl "https://three.ws/api/3d/diff?a=$BASE&b=$HEAD&format=markdown" >> "$GITHUB_STEP_SUMMARY"
```

Both models are fetched through the SSRF-hardened, size-capped fetcher: public `http(s)` only, private address ranges refused, 32 MiB per side. Errors are specific and never a 500: a bad URL is a `400` naming which side failed, an oversize model is a `413`, an upstream that would not serve the bytes is a `502` with a retry hint, and bytes that are not a glTF are a `400 invalid_model`.

---

## The CLI

```bash
npx @three-ws/glb-diff before.glb after.glb
```

Either side may be a file path or an `http(s)` URL, so comparing a local build against the copy already live on your CDN is one command. Exit codes are the contract a pipeline depends on:

| Code | Meaning |
| --- | --- |
| `0` | The diff ran and stayed below `--fail-on` |
| `1` | The diff ran and the severity reached `--fail-on` |
| `2` | The tool could not run: bad arguments, unreadable input, unparseable model |

A tool that returns `1` for both "your model regressed" and "I could not open the file" is useless in a pipeline, which is why `2` exists.

```bash
# Fail the build if the optimization pass broke the rig.
npx @three-ws/glb-diff src/avatar.glb dist/avatar.glb --fail-on breaking
```

---

## The MCP tool

`diff_models` is available on the three.ws MCP server, so an agent that just optimized, rigged, restyled, or re-exported a model can ask whether the result is still safe to ship before it publishes anything.

```jsonc
{
  "name": "diff_models",
  "arguments": {
    "before": "https://cdn.example.com/avatar.glb",
    "after": "https://cdn.example.com/avatar.optimized.glb"
  }
}
```

The tool returns the rendered text report as content and the full change set as `structuredContent`, so the agent can branch on `severity` without parsing prose. See [MCP integration](./mcp.md) for connecting the server.

---

## The library

The engine is published as [`@three-ws/glb-diff`](https://www.npmjs.com/package/@three-ws/glb-diff). This page, the CLI, the API, and the MCP tool all run that one package, so a verdict in CI can never disagree with what the page shows.

```js
import { readFile } from 'node:fs/promises';
import { diffModels, formatText, atLeast } from '@three-ws/glb-diff';

const changes = await diffModels(await readFile('a.glb'), await readFile('b.glb'), {
  nameA: 'a.glb',
  nameB: 'b.glb',
});

console.log(formatText(changes, { color: false }));
if (atLeast(changes.severity, 'major')) process.exit(1);
```

`describeModel()` and `diffDescriptions()` are exported separately. A **description** is a small JSON summary of a model with no geometry buffers in it, which is how you keep a per-release baseline in CI without storing every historical `.glb`:

```js
import { describeModel, diffDescriptions } from '@three-ws/glb-diff';

// In the release job:
await writeFile('v4.description.json', JSON.stringify(await describeModel(await readFile('avatar.glb'))));

// In the next release job, with v4's .glb long since pruned:
const changes = diffDescriptions(
  JSON.parse(await readFile('v4.description.json', 'utf8')),
  await describeModel(await readFile('avatar.glb')),
);
```

The full package reference, including the change-set shape and every export, is in the [package README](https://www.npmjs.com/package/@three-ws/glb-diff).

---

## Determinism

The same two files always produce the same change set, byte for byte, on any machine, in any of the four surfaces above. That is what makes the output worth committing, posting on a pull request, and diffing against yesterday's.
