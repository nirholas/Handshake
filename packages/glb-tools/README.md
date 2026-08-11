<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/glb-tools</h1>

<p align="center"><strong>Inspect, re-theme, and bake GLB models from the shell or CI — the toolkit behind three.ws's 3D asset pipeline.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/glb-tools"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/glb-tools?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/glb-tools"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/glb-tools?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/glb-tools?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/glb-tools?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#pricing">Pricing</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/glb-tools` is the official client for the three.ws **GLB pipeline** —
> the same inspection, theming, and baking engine three.ws runs on every asset it
> serves. It wraps three live endpoints: structural model inspection
> (`/api/x402/model-check`), token-themed mesh synthesis
> (`/api/x402/mint-to-mesh`), and server-side appearance baking
> (`/api/avatars/:id`). One ergonomic call replaces a custom glTF parser, a
> `@gltf-transform` build chain, and the polling/billing plumbing around them. It
> pairs with [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge) —
> Forge *makes* the GLB, glb-tools *measures, themes, and optimizes* it.

## Why

A GLB looks like one file but hides a graph: scenes, nodes, meshes, materials,
textures, skins, animations, extensions. Answering "how heavy is this, is it
rigged, will it choke a phone, can I ship it" means either booting a headless
viewer or hand-writing a glTF-Transform pipeline — per asset, per CI run.
glb-tools does it as a function call:

- **Inspect without a viewer.** `inspect(url)` returns exact vertex/triangle
  counts, per-texture dimensions, per-material channel maps, extensions, and a
  prioritized list of optimization suggestions — no GPU, no browser, headless in
  CI.
- **Theme a token into a mesh.** `theme(mint)` returns a watertight, instantly
  renderable GLB cube colored from a stable hash of the mint, with the token
  image baked on as a `baseColor` texture when one exists.
- **Bake an appearance once.** `bake(avatarId, appearance)` flattens outfit
  morphs, color tints, bone-mounted accessories, and hidden layers into a single
  optimized GLB (weld → quantize → meshopt → WebP textures) that every viewer
  renders with zero runtime customization code.

This is the SDK twin of the inspection tools exposed on the
[3D Studio MCP server](https://three.ws/mcp) — the same engine, as plain
functions instead of MCP tools.

## Install

```bash
npm install @three-ws/glb-tools
```

Zero runtime dependencies. Works in Node 18+, modern browsers, and CI runners
(uses `fetch`). To *generate* the GLBs you inspect, add
[`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge).

## Quick start

Inspect any public GLB — exact stats, no viewer:

```js
import { inspect } from '@three-ws/glb-tools';

const report = await inspect('https://three.ws/avatars/cesium-man.glb');

console.log(report.model.counts.totalTriangles); // → 4672
console.log(report.model.counts.skins > 0);       // → true  (rigged)
report.suggestions.forEach((s) => console.log(`[${s.severity}] ${s.message}`));
```

Turn a Solana mint into a renderable GLB:

```js
import { theme } from '@three-ws/glb-tools';
import { writeFile } from 'node:fs/promises';

const out = await theme('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'); // $THREE
console.log(out.theme.color);   // → [0.92, 0.45, 0.18]  (hashed from the mint)
await writeFile('three.glb', out.bytes); // ready for three.js / model-viewer
```

Bake a customized appearance into one flat, optimized GLB:

```js
import { bake } from '@three-ws/glb-tools';

const baked = await bake('avatar_8f3a…', {
  outfit: 'streetwear-01',
  colors: { hair: '#1b1b1f', outfit: '#3b82f6' },
  accessories: ['glasses-aviator'],
}, { token: process.env.THREE_WS_TOKEN });

console.log(baked.bakedStorageKey, baked.sizeBytes);
```

## API

Public exports: `inspect`, `theme`, `bake`, `createGlbTools`, `ThreeWsError`,
`PaymentRequiredError`, and `DEFAULT_BASE_URL`. The three headline functions
use a shared zero-config client; `createGlbTools({ baseUrl, fetch, apiKey,
headers })` builds your own when you need a payment-aware fetch, an owner
token, or a custom origin reused across calls.

### `inspect(url, options?) → Promise<InspectReport>`

Fetch a public glTF/GLB by URL and return its structure plus optimization
advice. Wraps `GET /api/x402/model-check?url=<url>`. The model is parsed
server-side with `@gltf-transform`; **only the JSON/scene graph is analyzed** —
fast even on large meshes. Source URL must be public HTTPS; **max 16 MiB**.

**Options**

| Option | Type | Default | Notes |
|---|---|---|---|
| `payWith` | `'x402' \| 'credits'` | `'x402'` | Billing lane (see [Pricing](#pricing)). |
| `signal` | `AbortSignal` | — | Cancel an in-flight inspection. |

**Returns** `InspectReport`

| Field | Type | Notes |
|---|---|---|
| `url` | `string` | Canonicalized source URL. |
| `fetchedBytes` | `number` | Bytes downloaded for analysis. |
| `model` | `ModelInfo` | Structural summary (below). |
| `suggestions` | `Suggestion[]` | Prioritized optimization advice. |

`ModelInfo` carries `container` (`'glb' \| 'gltf'`), `generator`, `version`,
`copyright`, `extensionsUsed`, `extensionsRequired`, a `counts` object
(`scenes, nodes, meshes, materials, textures, animations, skins, totalVertices,
totalTriangles, indexedPrimitives, nonIndexedPrimitives`), `primitiveModes`, a
per-texture `textures[]` array (`name, mimeType, width, height, byteSize`), and a
per-material `materials[]` array (`name, alphaMode, doubleSided,
hasBaseColorTexture, hasNormalTexture, hasMetallicRoughnessTexture,
hasEmissiveTexture, hasOcclusionTexture`). A non-empty `counts.skins` means the
model is rigged.

Each `Suggestion` is `{ id, severity: 'info' | 'warn' | 'critical', message,
estimate? }` — e.g. `tri_budget` (decimate/LOD over 500k triangles), `draco`,
`meshopt`, `texture_size`.

### `theme(mint, options?) → Promise<ThemedMesh>`

Synthesize a themed GLB for a Solana fungible-token mint. Wraps
`GET /api/x402/mint-to-mesh?mint=<base58>`. The server reads on-chain Metaplex
metadata, colors a unit cube from a stable hash of the mint, and — when the
off-chain metadata exposes a PNG/JPEG — embeds the token image as a `baseColor`
texture on every face. The mint's name, symbol, and a timestamp are written to
`asset.extras` so downstream agents can introspect the model.

**Input** — `mint` is a base58 SPL address (32–44 chars).

**Returns** `ThemedMesh`

| Field | Type | Notes |
|---|---|---|
| `mint` | `string` | Echoed mint address. |
| `theme.name` | `string \| null` | On-chain token name. |
| `theme.symbol` | `string \| null` | On-chain symbol. |
| `theme.color` | `[number, number, number]` | RGB in `[0,1]`, the `baseColorFactor`. |
| `theme.imageUrl` | `string \| null` | Source image URL, when present. |
| `theme.hasImage` | `boolean` | `true` when an image was embedded as a texture. |
| `bytes` | `Uint8Array` | Decoded GLB bytes (from the response's base64). |
| `glb.mimeType` | `'model/gltf-binary'` | — |
| `glb.bytes` | `number` | GLB size in bytes. |

The raw endpoint returns the GLB base64-encoded under `glb.base64`; the SDK
decodes it for you into `bytes` and leaves `glb.bytes` as the size.

### `bake(avatarId, appearance, options?) → Promise<BakeResult>`

Bake an `appearance` into a three.ws avatar's GLB, server-side. Wraps
`PATCH /api/avatars/:id { appearance }`, which triggers the synchronous baker.
**Requires an authenticated owner token** (the avatar belongs to a signed-in
account).

`appearance` accepts any combination of:

| Field | Type | Effect |
|---|---|---|
| `outfit` | `string` | Outfit preset id — applies its morph bindings. |
| `accessories` | `string[]` | Bone-mounted accessory preset ids (hats, glasses…). |
| `colors` | `Record<slot, hex>` | Tint material slots (`skin`, `hair`, `outfit`, `glasses`). |
| `morphs` | `Record<name, 0..1>` | Raw morph-target overrides (win over preset bindings). |
| `hidden` | `string[]` | Slots to hide, exposing the base body. |

A bakeable appearance returns `BakeResult` `{ avatarId, bakedStorageKey,
appearanceHash, sizeBytes, cleared, bakeError }` (the endpoint's snake_case
avatar fields, shaped to camelCase). An **empty / cleared** appearance clears
the cached baked GLB (the base model is served again) and resolves with
`bakedStorageKey: null` and `cleared: true`.

## How it works

Three independent endpoints, one client. None of the heavy lifting happens in
your process:

```
inspect(url) ─────▶ GET /api/x402/model-check?url=…
                        │  fetch ≤16 MiB → @gltf-transform readJSON
                        ▼
                    counts · textures · materials · extensions
                        + suggestOptimizations() → InspectReport

theme(mint) ──────▶ GET /api/x402/mint-to-mesh?mint=…
                        │  Metaplex metadata → colorFromMint() (FNV-1a hash)
                        │  optional image → baseColor texture
                        ▼
                    createThemedGLB() → unit-cube GLB (base64) → ThemedMesh

bake(id, appr) ───▶ PATCH /api/avatars/:id { appearance }
                        │  applyMorphs · applyColors · merge accessories · applyHidden
                        │  unpartition → prune → dedup → weld → quantize
                        │  → meshopt → textureCompress (WebP, ≤1024px)
                        ▼
                    optimized GLB in R2 → BakeResult
```

- **Inspect** is read-only and deterministic: same URL in, same report out. It
  never executes shaders or rasterizes — it walks the scene graph.
- **Theme** is "mint to mesh": a fully conformant glTF 2.0 cube that any
  Three.js, Babylon.js, or `<model-viewer>` instance renders directly, with the
  full on-chain metadata in `asset.extras`.
- **Bake** is a one-shot flatten + compress. Bone-name matching tolerates the
  common `mixamorig:`, `CC_Base_`, and `rig_` prefixes, so accessories attach to
  any upstream rigger's skeleton without renaming.

## Pricing

The inspection and theming endpoints are pay-per-call x402 lanes settled in USDC
(6-decimal atomics):

| Capability | Endpoint | Lane | Price |
|---|---|---|---|
| `inspect()` | `/api/x402/model-check` | x402 / USDC on **Solana** | **$0.001** per call |
| `theme()` | `/api/x402/mint-to-mesh` | x402 / USDC on **Solana** | **$0.001** per call |
| `bake()` | `/api/avatars/:id` | authenticated owner | included with the avatar |

Set `payWith: 'x402'` (default) to pay per call with USDC, or `payWith:
'credits'` to draw from a signed-in prepaid balance. Pair with
[`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch) to
automate the 402 settlement. Internal/subscription/OAuth callers can be granted a
payment bypass (`x-payment-bypass` header on the response). Both x402 routes are
also exposed as MCP tools on the [3D Studio server](https://three.ws/mcp).

## Errors & edge cases

`inspect()`, `theme()`, and `bake()` reject with a typed `ThreeWsError`
carrying a `code` and `status`. A payment challenge (HTTP 402, or the
x402-over-401 envelope some transports use) rejects with its
`PaymentRequiredError` subclass, whose `accepts` field carries the x402
challenge. Client-side validation (a missing or malformed `url`, `mint`,
`avatarId`, or `appearance`) rejects with `code: 'invalid_input'` or
`'invalid_mint'` before any network call. Server-side codes mirror the
endpoint's error contract:

| `code` | HTTP | Meaning | Recovery |
|---|---|---|---|
| `missing_url` / `missing_mint` | 400 | Required input omitted. | Pass `url` / `mint`. |
| `invalid_url` | 400 | Not a fetchable HTTPS URL. | Use a public HTTPS GLB. |
| `invalid_mint` | 400 | Not a base58 SPL address (32–44 chars). | Pass a valid mint. |
| `payment_required` | 402 | x402 lane with no payment proof. | Provide an x402 payer or use credits. |
| `method_not_allowed` | 405 | Wrong HTTP verb. | The SDK uses the correct verb; surfaces only on raw calls. |
| `verify_failed` / `settle_failed` | 502 | Payment verification/settlement upstream failed. | Retry; check the payer balance. |
| `internal_error` | 500 | Upstream parse/build error. | Retry, or check the input asset. |

Inspection rejects oversized inputs before download (the **16 MiB** cap), so a
runaway URL fails fast rather than streaming forever. A bake of an empty
appearance is **not** an error — it intentionally clears the cached baked GLB.
Every state is designed: a missing key returns a `code`, not a crash.

## Examples

**CI asset gate** — fail the build when a model busts the triangle budget:

```js
import { inspect } from '@three-ws/glb-tools';

const { model, suggestions } = await inspect(process.env.MODEL_URL, {
  payWith: 'credits',
});
const critical = suggestions.filter((s) => s.severity === 'critical');
if (model.counts.totalTriangles > 250_000 || critical.length) {
  console.error('Model exceeds web budget:', model.counts.totalTriangles);
  process.exit(1);
}
```

**Forge → inspect** — generate, then verify it's rig-ready before shipping:

```js
import { forge } from '@three-ws/forge';
import { inspect } from '@three-ws/glb-tools';

const { glbUrl } = await forge('a cartoon astronaut, full body');
const { model } = await inspect(glbUrl);
console.log('rigged:', model.counts.skins > 0, '· tris:', model.counts.totalTriangles);
```

**Theme a token, render inline** in the browser:

```html
<script type="module">
  import { theme } from '@three-ws/glb-tools';

  const { bytes } = await theme('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'); // $THREE
  const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
  const el = Object.assign(document.createElement('model-viewer'), { src: url });
  document.body.append(el);
</script>
```

## Related

- [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge) — generate the textured, rig-ready GLB that glb-tools inspects and bakes.
- [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar) — render and animate the baked GLB.
- [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch) — auto-pay the x402 inspect/theme lanes.
- [`@three-ws/avatar-schema`](https://www.npmjs.com/package/@three-ws/avatar-schema) — validate on-chain avatar manifests.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
