# @three-ws/glb-diff

**Structural diff for glTF/GLB.** Tells you what actually changed between two 3D
models: geometry, materials, textures, skeletons, and animations, with git-style
rename and move detection.

A binary diff of two GLB files tells you the bytes differ, which you already
knew. This tells you the thing you need to know before you ship: whether a
consumer of that model is about to break.

## Install

```bash
npm install @three-ws/glb-diff
```

## Library

```js
import { readFile } from 'node:fs/promises';
import { diffModels, formatText } from '@three-ws/glb-diff';

const before = await readFile('avatar.v1.glb');
const after = await readFile('avatar.v2.glb');

const changes = await diffModels(before, after, { nameA: 'v1', nameB: 'v2' });
console.log(formatText(changes));

if (changes.severity === 'breaking') process.exit(1);
```

Isomorphic: it takes bytes, so the same call works in Node, in a worker, in a
serverless handler, or in a browser.

## CLI

```bash
glb-diff before.glb after.glb
glb-diff before.glb https://example.com/after.glb --markdown
glb-diff base.glb candidate.glb --fail-on major
```

| Option | Meaning |
| --- | --- |
| `--json` | The full change set as JSON |
| `--markdown` | A Markdown report, sized for a pull-request comment |
| `--fail-on <level>` | Exit 1 once severity reaches this level |
| `--verbose` | Include unchanged totals in the table |

Exit codes are the contract a CI job depends on, so they are deliberate:

| Code | Meaning |
| --- | --- |
| `0` | The diff ran and stayed below `--fail-on` |
| `1` | The diff ran and the severity reached `--fail-on` |
| `2` | The tool could not run: bad arguments, unreadable input, unparseable model |

A tool that returns `1` for both "your model regressed" and "I could not open the
file" is useless in a pipeline, which is why `2` exists.

## Severity

Every change set carries one severity, the worst of everything it found:

| Level | Meaning |
| --- | --- |
| `none` | The two models are structurally identical. |
| `cosmetic` | Only metadata changed. Nothing a renderer or a clip can observe. |
| `minor` | Appearance changed. The model still loads, animates, and keeps its shape. |
| `major` | Geometry or hierarchy changed. Anything positioned against this model should be re-checked. |
| `breaking` | Something a consumer references by name is gone. Clips, attachments, or materials bound to it will fail. |

That ladder is what makes `--fail-on` useful. A texture swap should not fail a
build; a deleted bone that every animation clip targets should.

## API

| Export | What it does |
| --- | --- |
| `diffModels(bytesA, bytesB, opts?)` | Bytes in, change set out. The one call most callers need. |
| `describeModel(bytes)` / `describeDocument(doc)` | The structural description a diff is computed from. |
| `diffDescriptions(a, b)` | Diff two descriptions you already have, skipping the parse. |
| `formatText(changes)` / `formatMarkdown(changes)` | Render a change set for a terminal or a PR comment. |
| `readDocument(bytes)` / `isGLB(bytes)` | Parse helpers over `@gltf-transform/core`. |
| `SEVERITIES`, `SEVERITY_MEANING`, `atLeast()`, `maxSeverity()`, `severityRank()` | The severity ladder as data. |
| `matchEntries()`, `jaccard()`, `ratio()` | The similarity matcher behind rename and move detection. |

`DESCRIPTION_VERSION` and `CHANGESET_VERSION` are exported so a cache or a stored
report can tell whether it was produced by a compatible version.

## Related

- [`@three-ws/render`](../render): rasterize a GLB to PNG with no GPU, for a
  visual check alongside the structural one.
- [`STRUCTURE.md`](../../STRUCTURE.md): where every three.ws surface lives.

## License

Apache-2.0
