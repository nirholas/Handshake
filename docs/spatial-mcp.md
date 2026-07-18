# Spatial MCP — return 3D as a native MCP response

Spatial MCP is an open shape for returning a **live, interactive 3D scene** as an MCP tool result instead of a URL in text. A conformant host renders it inline — orbit, animate, place in AR — with an embedded component. three.ws is the reference implementation; the shape is renderer-agnostic and carries **no** payment, wallet, or coin surface, so it drops into crypto-free app stores unchanged.

- **Spec:** [`specs/SPATIAL_MCP.md`](https://github.com/nirholas/three.ws/blob/main/specs/SPATIAL_MCP.md) (v0.1, CC0)
- **Validator (code):** [`api/_lib/spatial-mcp.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/spatial-mcp.js) — `validateSpatialArtifact()`, `buildSpatialArtifact()`
- **Validator (MCP tool):** `validate_spatial_response({ artifact })` on the three.ws 3D Studio server
- **Reference renderer:** [`/spatial-mcp`](https://three.ws/spatial-mcp) — `public/spatial-mcp/spatial-renderer.js`

## Quick start — emit a conformant artifact

Put the artifact in your tool result's `structuredContent`. Only `spatialMcpVersion`, `kind`, and `scene.glbUrl` are required:

```js
import { buildSpatialArtifact } from './spatial-mcp.js';

const spatial = buildSpatialArtifact({
  glbUrl: 'https://cdn.example.com/model.glb', // https .glb — required
  kind: 'model',                                // model | mesh | avatar | rigged-model | scene
  viewerUrl: 'https://example.com/viewer?src=…',
  prompt: 'a battle-worn sci-fi helmet',
});

return {
  content: [{ type: 'text', text: 'Here is your 3D model.' }],
  structuredContent: { glbUrl: spatial.scene.glbUrl, spatial },
};
```

`buildSpatialArtifact` always returns a valid artifact and omits any field you don't provide — no empty scaffolding.

## Validate before you ship

```js
import { validateSpatialArtifact } from './spatial-mcp.js';

const { valid, errors, warnings } = validateSpatialArtifact(spatial);
if (!valid) throw new Error('non-conformant: ' + errors.map(e => `${e.path}: ${e.message}`).join('; '));
```

`errors` and `warnings` each name the offending `path` and the fix, so you can correct output rather than guess. Wire it into CI as an invariant over every 3D tool's real output (three.ws does — see `tests/spatial-mcp.test.js`).

Agents can validate over MCP without importing anything:

```jsonc
// tools/call → validate_spatial_response
{ "artifact": { "spatialMcpVersion": "0.1", "kind": "model",
                "scene": { "glbUrl": "https://cdn.example.com/model.glb", "format": "glb" } } }
// → structuredContent: { valid: true, errors: [], warnings: [...] }
```

## Adopt from a foreign tool result

If your existing 3D tool returns some other shape, a tiny adapter makes it conformant — no change to your generation pipeline:

```js
// Your tool already returns something like this:
const foreign = { model_url: 'https://cdn.example.com/model.glb', thumbnail: null, name: 'A helmet' };

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

The live demo at [`/spatial-mcp`](https://three.ws/spatial-mcp) renders exactly this transform beside a native three.ws artifact — the same renderer displays both, proving portability.

## Render it yourself

The reference renderer is framework-free and reusable independent of three.ws:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js"></script>
<div id="mount" style="height:360px"></div>
<script type="module">
  import { renderSpatialArtifact } from 'https://three.ws/spatial-mcp/spatial-renderer.js';
  renderSpatialArtifact(document.getElementById('mount'), artifact);
</script>
```

It applies `camera`/`environment`/`affordances`, plays `animation` when present, offers AR when `ar` (or the GLB) supports it, and shows a designed fallback for an unusable payload — never a blank frame.

## Data minimization (required for store-safe adoption)

`meta` is human-facing only. Never place session/job/creation/prediction/trace ids, wallet addresses, prices, or any auth/coin field anywhere in the artifact. Strip them at emit time — this is what keeps the shape reusable across the Claude and OpenAI tracks.

## Who emits it on three.ws

Free 3D Studio (`structuredContent.spatial`): `forge_free`, `text_to_avatar`, `mesh_forge`, `rig_mesh`, `forge_avatar`, `refine_model`. Paid 3D Studio: `preview_3d`. Conformance gate: `validate_spatial_response`.

## Related

- [`specs/SPATIAL_MCP.md`](https://github.com/nirholas/three.ws/blob/main/specs/SPATIAL_MCP.md) — the normative spec
- [3D Studio MCP (free)](/docs/mcp-studio): the free 3D Studio MCP server that emits these artifacts
- [MCP Tools Catalog](/docs/mcp-tools): which server hosts which tool, free vs. paid
- [AR & WebXR](/docs/ar): the AR handoff the artifact's `ar` block ties into (`export_ar`)
