# @three-ws/spatial-mcp

Validator, builder, and conformance fixtures for **Spatial MCP**, the open (CC0) shape for returning a live, interactive 3D scene as a first-class MCP tool result instead of a URL in text.

- Spec: [`specs/SPATIAL_MCP.md`](https://github.com/nirholas/three.ws/blob/main/specs/SPATIAL_MCP.md)
- Live reference renderer + paste-in checker: [three.ws/spatial-mcp](https://three.ws/spatial-mcp)
- Same module, importable without npm: `https://three.ws/spatial-mcp/spatial-validator.js`

Dependency-free. Runs in Node 18+, any browser, and any bundler.

## Install

```bash
npm install @three-ws/spatial-mcp
```

## Emit a conformant artifact

Put the artifact in your MCP tool result's `structuredContent`. Only `spatialMcpVersion`, `kind`, and `scene.glbUrl` are required; `buildSpatialArtifact` fills the recommended blocks and omits anything you don't provide.

```js
import { buildSpatialArtifact } from '@three-ws/spatial-mcp';

const spatial = buildSpatialArtifact({
	glbUrl: 'https://three.ws/avatars/xbot.glb',
	kind: 'rigged-model',
	prompt: 'a sci-fi robot',
	title: 'Sci-fi robot',
});

return {
	content: [{ type: 'text', text: 'Here is your 3D model.' }],
	structuredContent: { glbUrl: spatial.scene.glbUrl, spatial },
};
```

## Validate before you ship

`validateSpatialArtifact` returns actionable diagnostics, never a bare boolean: every problem names the offending `path` and how to fix it.

```js
import { validateSpatialArtifact } from '@three-ws/spatial-mcp';

const { valid, errors, warnings } = validateSpatialArtifact(spatial);
// errors:   [{ path: 'scene.glbUrl', message: 'required — must be an https URL to a .glb asset' }]
// warnings: [{ path: 'camera', message: 'recommended — include `{ autoRotate: true }` …' }]
```

## Data-minimization lint

The spec requires emitters to strip internal identifiers, wallet addresses, prices, and auth material from the artifact; that is what keeps the shape safe in crypto-free app stores. `lintSpatialMeta` flags the common violations. Findings are advisory and never affect validity.

```js
import { lintSpatialMeta } from '@three-ws/spatial-mcp';

lintSpatialMeta(artifact);
// [{ path: 'meta.session_id', message: 'looks like an internal/auth/coin field — …' }]
```

## Conformance fixtures

`fixtures/` is the spec's test corpus: real artifacts a conformant validator must accept, reject, or lint, with the required verdicts in `fixtures/manifest.json`. Point your own implementation at it:

```js
import manifest from '@three-ws/spatial-mcp/fixtures/manifest' with { type: 'json' };

for (const { file, valid, mustFlag = [] } of manifest.fixtures) {
	const artifact = await loadFixture(file); // read from node_modules/@three-ws/spatial-mcp/fixtures/<file>
	const result = myValidator(artifact);
	assert.equal(result.valid, valid, file);
	for (const path of mustFlag) assert(result.errors.some((e) => e.path === path), `${file} must flag ${path}`);
}
```

If your validator disagrees with a required verdict or misses a `mustFlag` path, it is not conformant. Fixture asset URLs use the reserved `assets.example` host: they exercise the validator and are not fetchable.

## API

| Export | What it does |
|---|---|
| `SPATIAL_MCP_VERSION` | the shape version this module implements (`'0.1'`) |
| `buildSpatialArtifact(fields)` | assemble a conformant artifact from what a generation tool already has |
| `validateSpatialArtifact(payload)` | `{ valid, version, errors, warnings }` with per-path diagnostics |
| `isConformantSpatialArtifact(payload)` | boolean convenience over the validator |
| `lintSpatialMeta(payload)` | advisory data-minimization findings, `[{ path, message }]` |

## Rendering

This package is emit-and-validate only. The framework-free reference renderer lives at [`public/spatial-mcp/spatial-renderer.js`](https://github.com/nirholas/three.ws/blob/main/public/spatial-mcp/spatial-renderer.js) (importable at `https://three.ws/spatial-mcp/spatial-renderer.js`) and displays any conformant artifact, including one transformed from a foreign tool result.

## License

CC0-1.0. The spec and this implementation are public domain: reimplement, extend, and ship them anywhere.
