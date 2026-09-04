# Spatial MCP — return 3D as a native MCP response

Spatial MCP is an open shape for returning a **live, interactive 3D scene** as an MCP tool result instead of a URL in text. A conformant host renders it inline — orbit, animate, place in AR — with an embedded component. three.ws is the reference implementation; the shape is renderer-agnostic and carries **no** payment, wallet, or coin surface, so it drops into crypto-free app stores unchanged.

- **Spec:** [`specs/SPATIAL_MCP.md`](https://github.com/nirholas/three.ws/blob/main/specs/SPATIAL_MCP.md) (v0.1, CC0)
- **Validator (package):** [`packages/spatial-mcp`](https://github.com/nirholas/three.ws/tree/main/packages/spatial-mcp) — `@three-ws/spatial-mcp`: `validateSpatialArtifact()`, `buildSpatialArtifact()`, `lintSpatialMeta()`, plus the conformance fixture corpus. Dependency-free; the npm registry publish is queued, and the import-by-URL below works today.
- **Validator (import by URL, no npm):** `https://three.ws/spatial-mcp/spatial-validator.js` — the same module, served directly. Source: [`public/spatial-mcp/spatial-validator.js`](https://github.com/nirholas/three.ws/blob/main/public/spatial-mcp/spatial-validator.js); server-side code imports it via `api/_lib/spatial-mcp.js`, and a CI drift guard keeps the npm copy byte-identical.
- **Validator (MCP tool):** `validate_spatial_response({ artifact })` on the three.ws 3D Studio server
- **Validator (no code at all):** paste a payload into the checker on [`/spatial-mcp`](https://three.ws/spatial-mcp) and read the diagnostics, conformance and data-minimization lint both
- **Reference renderer:** [`/spatial-mcp`](https://three.ws/spatial-mcp) — `public/spatial-mcp/spatial-renderer.js`

## Quick start — emit a conformant artifact

Put the artifact in your tool result's `structuredContent`. Only `spatialMcpVersion`, `kind`, and `scene.glbUrl` are required:

```js
import { buildSpatialArtifact } from './spatial-mcp.js';

const spatial = buildSpatialArtifact({
  glbUrl: 'https://three.ws/avatars/xbot.glb',  // https .glb (required)
  kind: 'rigged-model',                          // model | mesh | avatar | rigged-model | scene
  viewerUrl: 'https://three.ws/app#model=https://three.ws/avatars/xbot.glb',
  prompt: 'a sci-fi robot',
});

return {
  content: [{ type: 'text', text: 'Here is your 3D model.' }],
  structuredContent: { glbUrl: spatial.scene.glbUrl, spatial },
};
```

`buildSpatialArtifact` always returns a valid artifact and omits any field you don't provide — no empty scaffolding.

## Validate before you ship

```js
import { validateSpatialArtifact } from 'https://three.ws/spatial-mcp/spatial-validator.js';

const { valid, errors, warnings } = validateSpatialArtifact(spatial);
if (!valid) throw new Error('non-conformant: ' + errors.map(e => `${e.path}: ${e.message}`).join('; '));
```

`errors` and `warnings` each name the offending `path` and the fix, so you can correct output rather than guess. Wire it into CI as an invariant over every 3D tool's real output (three.ws does — see `tests/spatial-mcp.test.js`).

The validator is dependency-free and runs anywhere: a browser, a Node tool, a CI step. It is the same module the reference page loads, so what the page reports about a payload is what your build will report.

**Or validate nothing yourself.** The checker on [`/spatial-mcp`](https://three.ws/spatial-mcp) runs that module in your browser against whatever you paste, as you type, and lists every `path` with its fix. It also ships a deliberately broken example so you can see the diagnostics before you have a payload of your own. Conformant payloads render in place; unusable ones show the renderer's designed fallback, which is what a host would show a user.

Agents can validate over MCP without importing anything:

```jsonc
// tools/call → validate_spatial_response
{ "artifact": { "spatialMcpVersion": "0.1", "kind": "model",
                "scene": { "glbUrl": "https://three.ws/avatars/xbot.glb", "format": "glb" } } }
// → structuredContent: { valid: true, errors: [], warnings: [...] }
```

## Adopt from a foreign tool result

If your existing 3D tool returns some other shape, a tiny adapter makes it conformant — no change to your generation pipeline:

```js
// Your tool already returns something like this:
const foreign = { model_url: 'https://three.ws/avatars/xbot.glb', thumbnail: null, name: 'A robot' };

// A 6-line adapter → conformant artifact:
function toSpatialArtifact(f) {
  return {
    spatialMcpVersion: '0.1',
    kind: 'model',
    scene: { glbUrl: f.model_url, format: 'glb', ...(f.thumbnail ? { poster: f.thumbnail } : {}) },
    camera: { autoRotate: true },
    affordances: { orbit: true, zoom: true },
    meta: { title: f.name },
  };
}
```

The live demo at [`/spatial-mcp`](https://three.ws/spatial-mcp) renders exactly this transform beside a native three.ws artifact — the same renderer displays both, proving portability. Both frames carry the validator's verdict underneath, so the conformance claim on that page is demonstrated rather than asserted.

## Render it yourself

The reference renderer is framework-free and reusable independent of three.ws:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@google/model-viewer@4.0.0/dist/model-viewer.min.js"></script>
<div id="mount" style="height:360px"></div>
<script type="module">
  import { renderSpatialArtifact } from 'https://three.ws/spatial-mcp/spatial-renderer.js';
  renderSpatialArtifact(document.getElementById('mount'), artifact);
</script>
```

It applies `camera`/`environment`/`affordances`, plays `animation` when present, offers AR when `ar` (or the GLB) supports it, and never shows a blank frame: an unusable payload gets a designed fallback (`.spatial-empty`), a downloading GLB gets a skeleton under the viewer (`.spatial-loading`), and a GLB that cannot be fetched or decoded gets an error message that names the host, says what to check (reachable, https, `Access-Control-Allow-Origin`, a valid `.glb`), and offers a `.spatial-retry` button that re-renders in place (`.spatial-error`). The mount carries `data-spatial-state` (`empty`, `loading`, `ready`, `error`) so a host can style each state; the renderer ships no CSS of its own, so style those classes the way [`/spatial-mcp`](https://three.ws/spatial-mcp) does or the way your host already styles its own empty and error cards.

## Data minimization (required for store-safe adoption)

`meta` is human-facing only. Never place session/job/creation/prediction/trace ids, wallet addresses, prices, or any auth/coin field anywhere in the artifact. Strip them at emit time — this is what keeps the shape reusable across the Claude and OpenAI tracks.

The reference lint flags the common violations:

```js
import { lintSpatialMeta } from 'https://three.ws/spatial-mcp/spatial-validator.js';

lintSpatialMeta(artifact);
// [{ path: 'meta.session_id', message: 'looks like an internal/auth/coin field — the spec requires emitters to strip these (data minimization)' }]
```

Findings are advisory and never affect validity: the lint cannot know your internal field names, so a clean result is evidence, not proof. The checker on [`/spatial-mcp`](https://three.ws/spatial-mcp) runs it on every pasted payload.

## Prove your implementation conformant

`@three-ws/spatial-mcp` ships the fixture corpus (`fixtures/manifest.json` plus the artifacts it names): payloads a conformant validator must accept, reject with specific error paths, or lint. Run your implementation over every entry; disagreeing with a required verdict or missing a `mustFlag` path means non-conformance. The package's own test suite does exactly this, so the corpus and the reference validator can never drift apart.

## Who emits it on three.ws

Free 3D Studio (`structuredContent.spatial`): `forge_free`, `text_to_avatar`, `mesh_forge`, `rig_mesh`, `forge_avatar`, `refine_model`. Paid 3D Studio: `preview_3d`. Conformance gate: `validate_spatial_response`.

## Related

- [`specs/SPATIAL_MCP.md`](https://github.com/nirholas/three.ws/blob/main/specs/SPATIAL_MCP.md) — the normative spec
- [3D Studio MCP (free)](/docs/mcp-studio): the free 3D Studio MCP server that emits these artifacts
- [MCP Tools Catalog](/docs/mcp-tools): which server hosts which tool, free vs. paid
- [AR & WebXR](/docs/ar): the AR handoff the artifact's `ar` block ties into (`export_ar`)
