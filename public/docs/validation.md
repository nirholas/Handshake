# glTF Validation

three.ws integrates the official [Khronos glTF-Validator](https://github.com/KhronosGroup/glTF-Validator) (compiled to WebAssembly) to check every GLB or glTF 2.0 file against the specification before it is presented or registered. Validation runs automatically after a model loads, and its result drives both the UI and the agent's emotional response.

---

## What validation checks

The validator measures conformance against the glTF 2.0 specification and reports four severity levels:

| Severity | Code | Meaning |
|----------|------|---------|
| Error | 0 | Spec violation. Fix before publishing — some renderers will refuse to load the file. |
| Warning | 1 | Non-conformant but likely to load. Behavior in different renderers may differ. |
| Hint | 2 | Best-practice suggestion. Not a problem, but worth addressing. |
| Info | 3 | Informational only. No action needed. |

A model passes validation when `numErrors === 0`. Warnings, hints, and infos are allowed for a pass verdict.

---

## Reading a validation report

Every validation produces a structured report. Here is what each field means.

### Summary counts

```json
{
  "issues": {
    "numErrors": 1,
    "numWarnings": 2,
    "numHints": 5,
    "numInfos": 1,
    "maxSeverity": 0
  }
}
```

`maxSeverity` is the code of the most severe non-empty bucket (`0` = errors present, `1` = warnings only, `3` = hints only, `-1` = completely clean).

### Individual messages

Each message in `issues.messages` has three fields:

- **`code`** — machine-readable issue identifier (e.g. `ACCESSOR_NON_UNIT`)
- **`message`** — human-readable description
- **`pointer`** — JSON Pointer to the offending node (e.g. `/meshes/0/primitives/0`)

When many instances of the same error appear on the same node (for example hundreds of `ACCESSOR_NON_UNIT` entries on one mesh), the viewer aggregates them into a single `[AGGREGATED]` entry so the report stays readable.

### Model info

Alongside the issue list, the validator also extracts metadata from the asset:

- glTF version and generator (e.g. `"Blender 4.1"`)
- Draw call count, vertex count, triangle count
- Animation, material, and texture counts
- Extensions used
- `asset.extras` fields: `title`, `author`, `license`, `source`

This information appears in the **Model Info** overlay and is used by the `present-model` agent skill.

---

## Common errors and how to fix them

| Code | What it means | Fix |
|------|---------------|-----|
| `ACCESSOR_NON_UNIT` | Normal or tangent vectors are not unit-length | Re-export with **Normalize Normals** checked in your exporter |
| `ACCESSOR_INDEX_TRIANGLE_DEGENERATE` | Triangle has zero area | Remove degenerate faces in your 3D editor before exporting |
| `ACCESSOR_ANIMATION_INPUT_NON_INCREASING` | Animation keyframe times are not monotonically increasing | Re-bake animations; check for duplicate or reversed keyframes |
| `MESH_PRIMITIVE_TANGENT_SPACE_INVALID` | Tangent vectors are malformed | Regenerate normals and tangents in Blender (`Object Data → Geometry Data → Clear Custom Split Normals Data`, then re-export) |
| `BUFFER_VIEW_TOO_SHORT` | The binary chunk is truncated or corrupt | Re-export the file from scratch |
| `TEXTURE_INVALID_IMAGE` | An embedded texture cannot be decoded | Re-export with valid PNG or JPG textures; avoid WebP if broad viewer support matters |
| `UNUSED_OBJECT` | The file contains materials, textures, or animations that nothing references | Remove unused data-blocks before exporting |

### Common warnings

- `NODE_SKINNED_MESH_NON_ROOT` — a skinned mesh is not a direct child of the scene root. Most renderers handle this, but moving the root armature to scene level is safer.
- `MESH_PRIMITIVE_JOINTS_WEIGHTS_MISMATCH` — the number of joint indices does not match the number of weight values. Re-export the skinned mesh after verifying vertex group assignments.

---

## Running validation

### In the viewer

Validation runs automatically after every model load. The result appears in the **validator toggle bar** at the bottom of the screen:

- `N errors.` — errors found; click to expand the full report
- `N warnings.` — warnings only
- `N hints.` — hints only
- `Model details` — clean; no issues

Clicking the bar opens the full **ValidatorReport** panel, which shows the model metadata, a summary banner, and per-severity tables of messages.

### Via the agent

Ask the agent in natural language:

> "Validate this model."  
> "Are there any issues with this GLB?"  
> "Does this file have errors?"

The agent runs the `validate-model` skill, reads the current validation state, and responds conversationally — explaining any major errors and their likely causes.

The agent's emotional state also reflects the result:

- **Clean model** (0 errors) → `celebration` emotion (slight smile, head nod)
- **Errors found** → `concern` + `empathy` emotions

### Programmatically

The `Validator` class is used internally by the viewer. It accepts a file URL and a Three.js asset map for multi-file glTF scenes:

```js
import { Validator } from './src/validator.js';

const validator = new Validator(containerElement);
await validator.validate(rootFileURL, rootPath, assetMap, loaderResponse);

const { issues, errors, warnings, hints, infos, info } = validator.report;
console.log(issues.numErrors); // 0 = clean
```

`errors`, `warnings`, `hints`, and `infos` are pre-filtered arrays of messages, with repeated high-volume errors already aggregated.

---

## Model stats overlay

Separate from validation, the **Model Info** overlay (rendered via `createModelInfo`) displays live geometry stats computed from the loaded Three.js scene:

| Stat | Source |
|------|--------|
| Meshes | Count of `Mesh`, `Points`, and `Line` nodes |
| Vertices | `geometry.attributes.position.count` per mesh |
| Triangles | Index count ÷ 3 (or position count ÷ 3 for unindexed geometry) |
| Materials | Unique material UUIDs across all meshes |
| Textures | Unique texture UUIDs found on all materials |
| Animations | Animation clip count passed from the loader |

Feature chips — `Skinned`, `Morph`, `Animated`, plus material type names — appear below the stats.

---

## On-chain validation attestation

Validation results can be attested on-chain through two complementary mechanisms.

### ValidationRegistry (ERC-8004)

For registered agents, a validation record can be written to the `ValidationRegistry` smart contract on Base (chain ID 8453):

```js
import { recordValidation, hashReport, reportPassed } from './src/erc8004/validation-recorder.js';

// Determine pass/fail
const passed = reportPassed(validationReport); // true if numErrors === 0

// Optionally pin the full report to IPFS first
const { txHash, proofHash, proofURI } = await recordValidation({
  agentId: 42,
  report: validationReport,
  signer: connectedWallet,   // must be an allow-listed validator address
  chainId: 8453,
  apiToken: IPFS_API_TOKEN,  // for pinning
  pin: true,
});
```

The hash stored on-chain is `keccak256(JSON.stringify(report))`. Anyone can recompute it:

1. Re-run the validator on the same GLB file.
2. `hashReport(report)` → produces the same hash if the input is identical.
3. Query `ValidationRegistry.getLatestByKind(agentId, 'glb-schema')` → compare hashes.

Only **allow-listed validator addresses** may call `recordValidation`. The allow-list is maintained in [`public/.well-known/validators.json`](../public/.well-known/validators.json) and mirrored on-chain. See [`specs/VALIDATORS.md`](../specs/VALIDATORS.md) for how to apply to become a validator.

The minimum check suite for a `pass` verdict includes:

- `glb-schema` — file parses as valid GLB with all required chunks
- `gltf-validator` — Khronos validator reports zero errors
- `manifest-integrity` — the agent card's `model.sha256` matches the actual bytes
- `card-schema` — the card validates against the three.ws Card v1 spec

### Signed attestation (off-chain)

For lighter-weight use cases, `src/attestations/gltf.js` provides a wallet-signed JSON attestation that does not require a blockchain transaction:

```js
import { createGlTFAttestation, verifyGlTFAttestation } from './src/attestations/gltf.js';

// Create
const attestation = await createGlTFAttestation({
  glbBlob,           // raw GLB as a Blob
  validatorReport,   // gltf-validator result
  signer,            // ethers Signer
  agentId: '42',
});

// Verify (no wallet required)
const { valid, issuer, reasons } = await verifyGlTFAttestation({
  attestation,
  glbBlob,
  trustedIssuers: ['0xabc...'], // optional allowlist
});
```

The signing message binds together the agent ID, a SHA-256 hash of the GLB bytes, and a hash of the validator summary `{ errors, warnings, severityMax }`. Tampering with any of these breaks signature recovery. Store the attestation JSON alongside the GLB (for example as `attestations/gltf-validator.json`) and reference it from the agent manifest's `attestations` array.

### Checking past records

```js
import { getLatestValidation } from './src/erc8004/validation-recorder.js';
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const record = await getLatestValidation({
  agentId: 42,
  runner: provider,
  chainId: 8453,
  kind: 'glb-schema',
});

console.log(record.passed);     // boolean
console.log(record.proofHash);  // 0x-prefixed keccak256
console.log(record.proofURI);   // ipfs://... link to the full report
```

The **ValidationDashboard** UI (`src/validation-ui.js`) wraps these calls with a drag-and-drop file picker for submitting new records.

---

## Best practices for clean GLBs

Following these guidelines before exporting will avoid the most common validation errors:

**Geometry**
- Apply all modifiers before exporting (Blender: enable *Apply Modifiers* in the glTF exporter).
- Delete loose vertices and zero-area faces.
- Avoid non-manifold geometry if the model will be used for physics or fabrication.

**Normals and tangents**
- Enable *Normals* in the Blender glTF exporter.
- If you see `ACCESSOR_NON_UNIT` or `MESH_PRIMITIVE_TANGENT_SPACE_INVALID`, clear custom split normals data and re-export.

**Textures**
- Use **PNG** for maps that need transparency (albedo with alpha).
- Use **JPEG** for fully opaque maps (roughness, metallic, AO) to save space.
- For GPU-compressed textures, use **KTX2** (exported via Blender's *KHR_texture_basisu* extension).
- Avoid embedding textures larger than 4096×4096; prefer 2048×2048 for real-time use.

**Animations**
- Name every clip descriptively — `"idle"`, `"wave"`, `"run"` — because the `play_clip` agent tool finds clips by name.
- Keep keyframe times strictly ascending; duplicate or reversed timestamps cause `ACCESSOR_ANIMATION_INPUT_NON_INCREASING`.

**Housekeeping**
- Remove unused materials, textures, and shape keys before the final export. These inflate file size and produce `UNUSED_OBJECT` warnings.
- Use **Draco** mesh compression for geometry-heavy models (reduces GLB size 5–10× with negligible visual loss).

**Cross-viewer testing**
Check your file in at least two other viewers before registering it:
- [model-viewer.dev](https://modelviewer.dev/) — good baseline for web use
- [Babylon.js sandbox](https://sandbox.babylonjs.com/) — strict PBR interpretation
- three.ws itself — run validation and read the report

---

## Validation UI components

Three components render validation state in the browser:

| Component | File | Purpose |
|-----------|------|---------|
| `ValidatorToggle` | `src/components/validator-toggle.jsx` | Compact status bar; shows issue counts and severity class. Clicking opens the full report. |
| `ValidatorReport` | `src/components/validator-report.jsx` | Full report panel: model metadata, summary banner, per-severity message tables, and a JSON download link. |
| `ValidatorTable` | `src/components/validator-table.jsx` | Tabular view of messages for one severity level (Code / Message / Pointer columns). |

The toggle's CSS class reflects the highest severity: `level-0` (errors), `level-1` (warnings), `level-2` (infos), `level-3` (hints), or no class (clean). Style these classes to match your embedding context.
