<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/glb-diff</h1>

<p align="center"><strong>git diff for 3D. Tell what actually changed between two glTF/GLB models, and whether it breaks anything.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/glb-diff"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/glb-diff?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/glb-diff?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/glb-diff?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> &middot;
  <a href="#quick-start">Quick start</a> &middot;
  <a href="#the-cli">CLI</a> &middot;
  <a href="#api">API</a> &middot;
  <a href="#how-it-decides">How it decides</a> &middot;
  <a href="https://three.ws/diff">Try it in the browser</a>
</p>

---

## Why

A checksum tells you two `.glb` files differ. It cannot tell a lossless
recompression from a rig that quietly lost three finger joints, and only one of
those takes your avatar off the screen.

That failure is specific and expensive: animation clips address joints **by
name**. Drop a joint, rename a bone, re-export through a tool that renumbers
`Mesh.001`, and the model still loads, still renders, and never moves. Nothing
throws. There is no error to grep for. You find out when someone tells you the
character is standing in a T-pose.

`glb-diff` is the check that catches it before the deploy. It reads both models,
matches their objects the way `git` matches renamed files, and reports every
difference with a severity you can gate a build on.

```
glb-diff  avatar.v3.glb -> avatar.v4.glb
  BREAKING  12 change(s): +0 -3 ~6 renamed 3 moved 0
  Something a consumer references by name is gone. Clips, attachments, or materials bound to it will fail.

  !! Skeleton "Character" lost 2 joint(s): mixamorig:LeftEye, mixamorig:RightEye. Clips that target them will not play.
   ! 1 mesh(es) have different vertex data: "Body".
   ! Triangle count is down 21,006 (-42.8%).
     3 object(s) kept their content and changed name.
```

## Install

```bash
npm install @three-ws/glb-diff
```

Node 18+. Works in the browser too (the [/diff](https://three.ws/diff) page runs
this exact package client side, and nothing is uploaded).

`meshoptimizer` is an optional peer dependency. Install it if your models ship
with `EXT_meshopt_compression`, which most web-optimized assets do:

```bash
npm install meshoptimizer
```

## Quick start

```js
import { readFile } from 'node:fs/promises';
import { diffModels, formatText } from '@three-ws/glb-diff';

const before = await readFile('avatar.v1.glb');
const after = await readFile('avatar.v2.glb');

const changes = await diffModels(before, after, { nameA: 'v1', nameB: 'v2' });

console.log(formatText(changes));
if (changes.severity === 'breaking') process.exit(1);
```

## The CLI

```bash
npx @three-ws/glb-diff before.glb after.glb
```

Either side may be a file path or an `http(s)` URL, so comparing a local build
against the copy already live on your CDN takes one command:

```bash
npx @three-ws/glb-diff dist/avatar.glb https://cdn.example.com/avatar.glb
```

| Flag | What it does |
| --- | --- |
| `--json` | Print the full change set as JSON |
| `--markdown` | Print a Markdown report, sized for a pull-request comment |
| `--fail-on <level>` | Exit 1 when severity reaches `cosmetic`/`minor`/`major`/`breaking` |
| `--verbose` | Include unchanged rows in the totals table |
| `--no-color` | Disable ANSI colour |

Exit codes are the contract a pipeline depends on, so they are deliberate:

| Code | Meaning |
| --- | --- |
| `0` | The diff ran and stayed below `--fail-on` |
| `1` | The diff ran and the severity reached `--fail-on` |
| `2` | The tool could not run: bad arguments, unreadable input, unparseable model |

A tool that returns `1` for both "your model regressed" and "I could not open the
file" is useless in a pipeline, which is why `2` exists.

### In a build

```bash
# Fail the build if an optimization pass broke the rig.
npx @three-ws/glb-diff src/avatar.glb dist/avatar.glb --fail-on breaking

# Post the report on the pull request.
npx @three-ws/glb-diff base.glb head.glb --markdown > diff.md
```

## API

### `diffModels(bytesA, bytesB, opts?)`

Read two models and diff them. Returns a `ChangeSet`.

```js
const changes = await diffModels(beforeBytes, afterBytes, { nameA: 'before.glb', nameB: 'after.glb' });
```

### `describeModel(bytes, meta?)` and `diffDescriptions(a, b)`

The two halves of `diffModels`, exposed separately because the interesting uses
are not always end to end. A **description** is a small, JSON-safe summary of a
model: hashes, counts, names, and structure, with no geometry buffers in it.

```js
const baseline = await describeModel(await readFile('base.glb'), { name: 'base.glb' });
await writeFile('base.description.json', JSON.stringify(baseline));

// Later, in another job, with the model itself long gone:
const candidate = await describeModel(await readFile('build.glb'), { name: 'build.glb' });
const changes = diffDescriptions(baseline, candidate);
```

That is how you keep a per-release baseline in CI without storing every
historical `.glb`, and how a browser can describe one file once and compare it
against many candidates without re-parsing.

### `formatText(changeset, opts?)` and `formatMarkdown(changeset)`

Render a change set. `formatText` takes `{ color, verbose }`; pass
`color: false` for a log file.

### `atLeast(severity, threshold)`

The severity comparison the CLI gates on, exported so your own gate matches:

```js
import { atLeast } from '@three-ws/glb-diff';
if (atLeast(changes.severity, 'major')) throw new Error('model regressed');
```

### The change set

```jsonc
{
  "version": 1,
  "identical": false,
  "severity": "breaking",
  "a": { "name": "before.glb", "sizeBytes": 780912, "generator": "glTF-Transform v4.4.0" },
  "b": { "name": "after.glb", "sizeBytes": 829780, "generator": "glTF-Transform v4.4.0" },
  "summary": { "changed": 98, "added": 6, "removed": 13, "modified": 70, "renamed": 4, "moved": 1 },
  "totals": {
    "triangles": { "a": 49112, "b": 28106, "delta": -21006, "pct": -42.8 }
    // ... vertices, joints, nodes, meshes, materials, textures, animations, skins, textureBytes, sizeBytes
  },
  "sections": {
    "skins":      { "added": [], "removed": [], "renamed": [], "modified": [], "unchanged": 0, "changed": 3, "severity": "breaking" },
    "animations": { "...": "same shape" },
    "meshes":     { "...": "same shape" },
    "nodes":      { "...": "same shape, plus a `moved` list for reparented nodes" },
    "materials":  { "...": "same shape" },
    "textures":   { "...": "same shape" }
  },
  "extensions": { "used": { "added": [], "removed": [] }, "required": { "added": [], "removed": [] } },
  "asset": [],
  "highlights": [
    { "severity": "breaking", "text": "Skeleton \"Character\" lost 2 joint(s): mixamorig:LeftEye, mixamorig:RightEye. Clips that target them will not play." }
  ]
}
```

`highlights` is the layer you print when you only have room for three lines. The
sections are the layer you open when one of them is worth investigating.

## How it decides

### Matching: renames, not churn

Objects are paired in three passes, the same strategy `git` uses for file
renames:

1. **by key** the names agree, so the objects correspond
2. **by fingerprint** the names disagree but the content hashes identically, so
   it is a rename
3. **by similarity** neither agrees, but one candidate scores close enough that
   "the same object, edited and renamed" is more honest than an add plus a remove

Anything still unpaired really is an addition or a removal. Nodes get a fourth
distinction: a node that kept its name and changed parent is reported as
**moved**, because that changes where anything attached to it ends up.

Objects with no name in the file are labelled `(unnamed mesh 3)` and keyed to
their slot, so they only ever pair with the same slot on the other side rather
than accidentally matching an unrelated object that happened to come third.

### Tolerance: strict on edits, quiet on noise

Vertex data is hashed at a quantum of `1e-4` units. A re-export through Blender,
a `gltfpack` round trip, or a Draco decode perturbs positions in the `1e-6`
range and does **not** register. A genuine edit moves vertices by orders of
magnitude more and does.

Positions are not the only thing hashed. Normals, tangents, UVs, colors, and
**skin joints and weights** all participate, because a re-skin that leaves every
vertex exactly where it was still changes how the model deforms, and a
positions-only hash would call that unchanged.

### Severity

| Level | Meaning |
| --- | --- |
| `none` | Structurally identical |
| `cosmetic` | Only metadata changed. Nothing a renderer or a clip can observe |
| `minor` | Appearance changed. Still loads, animates, keeps its shape |
| `major` | Geometry or hierarchy changed. Re-check anything positioned against it |
| `breaking` | Something a consumer references by name is gone. Clips, attachments, or materials bound to it will fail |

The ladder is defined by what a downstream consumer notices, not by how large
the byte delta is. A 40 MB texture swap is `minor`. Deleting one joint is
`breaking`.

## Determinism

The same two files always produce the same change set, byte for byte, on any
machine. That is what makes the output worth committing, posting on a pull
request, and diffing against yesterday's.

## Also available as

- **A page.** [three.ws/diff](https://three.ws/diff) runs this package in your
  browser, overlays both models in 3D, and lets you wipe between them.
- **A free API.** `GET https://three.ws/api/3d/diff?a=<url>&b=<url>` returns the
  same change set. Keyless, no account. Add `&format=markdown` for a report.
- **An MCP tool.** `diff_models` on the three.ws MCP server, so an agent can ask
  whether the model it just optimized is still safe to ship.

## License

Apache-2.0. Built by [three.ws](https://three.ws).
