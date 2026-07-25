# Spatial MCP — 3D as a native conversational response type

**Version 0.1** · Open specification · License: CC0 / public domain (adopt freely)

> Reference implementation: [three.ws](https://three.ws). Validator: `public/spatial-mcp/spatial-validator.js`, published at `https://three.ws/spatial-mcp/spatial-validator.js`. Reference renderer + live conformance checker: [`/spatial-mcp`](https://three.ws/spatial-mcp). Adoption guide: [`docs/spatial-mcp.md`](../docs/spatial-mcp.md).

## The problem

MCP tool results are text or JSON today. A tool that produces a 3D model can only hand back a URL and hope the host does something useful with it. There is no shared shape that says "this result **is** an interactive 3D scene — render it, let the user orbit it, animate it, place it in AR."

**Spatial MCP** defines that shape: a structured-content artifact a tool returns so any conformant host can render a live scene inline instead of printing a link. It aligns with the MCP Apps / Apps SDK component-embedding model — a tool emits the artifact in `structuredContent`, and a host renders it with an embedded component (three.ws ships one; the shape is renderer-agnostic).

The shape carries **zero** payment, wallet, coin, or token fields, so it is safe to adopt in any context, including crypto-free app stores.

## The artifact

A Spatial MCP artifact is a JSON object placed in a tool result's `structuredContent` (three.ws nests it under the key `spatial`, but the object stands alone). Only `spatialMcpVersion`, `kind`, and `scene.glbUrl` are required; every other field is optional and a renderer applies sensible defaults for anything absent.

```jsonc
{
  "spatialMcpVersion": "0.1",       // required — the shape version a host reads to pick a renderer
  "kind": "model",                   // required — model | mesh | avatar | rigged-model | scene
  "scene": {                          // required
    "glbUrl": "https://…/model.glb",  // required — an https URL to a .glb asset
    "format": "glb",                  // recommended — only "glb" in v0.1
    "poster": "https://…/prev.jpg",   // optional — a preview image shown while loading
    "alt": "a battle-worn helmet"     // optional — accessibility text
  },
  "camera": {                         // optional
    "autoRotate": true,               // default true
    "orbit": "0deg 80deg 2m",         // optional — model-viewer camera-orbit string
    "fieldOfView": "30deg"            // optional
  },
  "environment": {                    // optional
    "image": "neutral",               // "neutral" or an https .hdr URL
    "exposure": 1.0,                  // default 1.0
    "shadowIntensity": 1.0            // default 1.0
  },
  "animation": {                      // optional — present when the asset is animated
    "autoplay": true,                 // default true
    "clips": ["idle", "wave"]         // optional — named clips; renderer plays the first
  },
  "persona": {                        // optional — an embodied, speakable body (see three.ws prompt 07)
    "id": "psn_…",
    "speakable": true
  },
  "ar": {                             // optional — AR handoff (see prompt 21)
    "supported": true,                // true requires at least one asset/link below
    "usdzUrl": "https://…/m.usdz",    // iOS Quick Look
    "glbUrl": "https://…/m.glb",      // Android Scene Viewer source
    "launchUrl": "https://…/ar?…"     // a device-aware AR launch page
  },
  "affordances": {                    // optional — what the host should allow
    "orbit": true, "zoom": true, "fullscreen": true, "download": true
  },
  "meta": {                           // optional — human-facing, NO internal identifiers
    "title": "Damaged helmet",
    "prompt": "a battle-worn sci-fi helmet",
    "viewerUrl": "https://…/viewer?src=…"
  }
}
```

### Field rules

| Field | Required | Rule |
|---|---|---|
| `spatialMcpVersion` | ✅ | string; must be a known version (`0.1`). |
| `kind` | ✅ | one of `model`, `mesh`, `avatar`, `rigged-model`, `scene`. Drives labelling/affordances only — an unknown kind still renders `scene.glbUrl`. |
| `scene` | ✅ | object with a required `glbUrl`. |
| `scene.glbUrl` | ✅ | **https** URL to a `.glb`. Non-https is rejected — a host feeds this to a renderer `src`. |
| `scene.format` | recommended | `"glb"` only in v0.1. |
| `scene.poster` | optional | https URL when present. |
| `camera`,`environment`,`animation`,`persona`,`affordances`,`meta` | optional | objects; validated for type/shape only when present. |
| `ar.*Url` | optional | https URLs; `ar.supported: true` requires at least one of `usdzUrl`/`glbUrl`/`launchUrl`. |

**Data minimization.** `meta` is human-facing only. Never place session ids, job/creation/prediction ids, trace ids, wallet addresses, prices, or any auth/coin field anywhere in the artifact. The reference validator does not police this (it can't know your internal names), but conformant emitters MUST strip them — this is what keeps the shape reusable in crypto-free stores.

**Forward compatibility.** Unknown top-level fields are ignored by conformant renderers (a warning, not an error), so a host may carry extra data without breaking older renderers.

## Conformance

Validate an artifact three ways, all the same implementation:

- **Import it** from `https://three.ws/spatial-mcp/spatial-validator.js` (source: `public/spatial-mcp/spatial-validator.js`; server-side code re-exports it via `api/_lib/spatial-mcp.js`). Dependency-free, runs in a browser or in Node.
- **Call the MCP tool** `validate_spatial_response({ artifact })` on the three.ws 3D Studio server.
- **Paste it** into the checker on [`/spatial-mcp`](https://three.ws/spatial-mcp), which validates as you type and renders whatever passes.

All three return actionable diagnostics:

```js
{ valid: false, version: "0.1",
  errors:   [{ path: "scene.glbUrl", message: "required — must be an https URL to a .glb asset" }],
  warnings: [{ path: "camera", message: "recommended — include { autoRotate: true } so hosts frame the model" }] }
```

A payload is **conformant** iff `errors` is empty. Emit the artifact from your tool, pass it through the validator in CI, and any Spatial-MCP renderer can display it.

## Rendering

A conformant renderer:
1. Loads `scene.glbUrl` into a WebGL/`<model-viewer>` scene.
2. Applies `camera`/`environment`/`affordances`, defaulting anything absent.
3. Plays `animation` when present; offers AR when `ar` (or the GLB) supports it.
4. Degrades gracefully — a missing optional never breaks the render; an unusable payload shows a designed fallback, not a blank frame.

The reference renderer is `public/spatial-mcp/spatial-renderer.js` (`renderSpatialArtifact(mount, artifact)`), demoed at [`/spatial-mcp`](https://three.ws/spatial-mcp). It is framework-free and reusable independent of the three.ws product.

## Adopters (three.ws)

Tools that emit conformant artifacts today: `forge_free`, `text_to_avatar`, `mesh_forge`, `rig_mesh`, `forge_avatar`, and `refine_model` (free 3D Studio — under `structuredContent.spatial`); `preview_3d` (paid 3D Studio). The validator tool `validate_spatial_response` is the public conformance gate.

## Versioning

`spatialMcpVersion` is the contract. `0.1` is the initial shape. Additive fields ship in a new minor version; a breaking change bumps the major. Renderers read the version to select behavior. This spec is CC0 — reimplement, extend, and ship it anywhere.
