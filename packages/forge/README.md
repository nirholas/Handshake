<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/forge</h1>

<p align="center"><strong>Text, image, or sketch → a textured, rig-ready 3D <code>.glb</code> in one call.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/forge"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/forge?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/forge"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/forge?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/forge?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/forge?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#pricing">Pricing</a> ·
  <a href="https://three.ws/forge">three.ws</a>
</p>

---

> `@three-ws/forge` is the official client for the three.ws **Forge** — the
> generation engine behind [three.ws/forge](https://three.ws/forge). It turns a
> prompt, a photo, or a sketch into a watertight, textured GLB, and can
> auto-rig that GLB into an animation-ready humanoid. It wraps the public,
> auth-free `/api/forge` endpoint: a free [TRELLIS](https://github.com/microsoft/TRELLIS)
> lane on NVIDIA NIM, paid high-detail tiers billed in USDC over
> [x402](https://x402.org), and bring-your-own-key geometry backends
> (Meshy, Tripo). It pairs with [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar)
> — Forge *makes* the model, `@three-ws/avatar` *renders* it.

## Why

Every "text-to-3D" you find is either a closed playground with no API, or a raw
model endpoint that hands you an untextured mesh and leaves rigging, polygon
budgets, provider fallback, job polling, and billing to you. Forge is the whole
pipeline, done once:

- **One call, a real GLB.** `forge('a chrome robot')` resolves to a hosted,
  durable `.glb` URL plus a [three.ws viewer](https://three.ws/forge) link.
- **Free first.** Text prompts default to the free NVIDIA NIM / TRELLIS lane —
  no key, no wallet, no card.
- **Scales with the asset.** Three quality tiers (draft → standard → high) map
  to real polygon budgets and PBR texturing. Pay per call in USDC only when you
  reach for the paid tiers.
- **Rig-ready.** One flag chains generation into auto-rigging, so the output
  drops straight into the three.ws animation runtime — idle, walk, emotes.

This is the SDK twin of the [3D Studio MCP server](https://three.ws/mcp) — the
same engine, exposed as plain functions instead of MCP tools.

## Install

```bash
npm install @three-ws/forge
```

Zero runtime dependencies. Works in Node 18+ and the browser (uses `fetch`).
For rendering the result, add [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar).

## Quick start

The free lane needs no key:

```js
import { forge } from '@three-ws/forge';

const model = await forge('a chrome robot with neon trim');

console.log(model.glbUrl);    // → https://three.ws/cdn/forge/…​.glb (durable)
console.log(model.viewerUrl); // → https://three.ws/forge?share=…​
```

A fuller run — high tier, geometry-first, then auto-rig:

```js
import { forge, rig } from '@three-ws/forge';

const model = await forge('a stylized fox, full body, T-pose', {
  tier: 'high',        // draft | standard | high
  path: 'geometry',    // image | geometry | sketch
  providerKey: process.env.MESHY_KEY, // BYOK for the geometry path
});

const rigged = await rig(model.glbUrl); // animation-ready humanoid GLB
console.log(rigged.glbUrl);
```

From an image or a sketch:

```js
// Photo → 3D
await forge({ images: ['https://three.ws/avatars/thumbs/default.png'], prompt: 'a 3D character' });

// Drawing + a name → geometry (no textures)
await forge({ images: ['data:image/png;base64,…'], prompt: 'a sword', path: 'sketch' });
```

## API

### `forge(promptOrInput, options?) → Promise<ForgeResult>`

Generate a GLB from text, image(s), or a sketch. Accepts a bare prompt string,
or an input object.

**Input**

| Field | Type | Notes |
|---|---|---|
| `prompt` | `string` | Text description. Required for text + sketch paths. |
| `images` | `string[]` | One or more image URLs / data URIs. Switches to image→3D. |
| `aspectRatio` | `string` | Reference-image aspect for the `image` path, e.g. `"1:1"`. |

**Options**

| Option | Type | Default | Notes |
|---|---|---|---|
| `path` | `'image' \| 'geometry' \| 'sketch'` | `'image'` | How geometry is produced — see [How it works](#how-it-works). |
| `tier` | `'draft' \| 'standard' \| 'high'` | `'standard'` | Polygon budget + texture richness. |
| `backend` | `string` | auto | Force a generation backend (`nvidia`, `huggingface`, `meshy`, `tripo`). |
| `providerKey` | `string` | — | BYOK key for the `geometry` path (Meshy/Tripo). |
| `payWith` | `'x402' \| 'credits'` | `'x402'` | Billing lane for paid tiers (see [Pricing](#pricing)). |
| `signal` | `AbortSignal` | — | Cancel an in-flight generation. |
| `onProgress` | `(job) => void` | — | Called on each poll tick with the latest job state. |

**Returns** `ForgeResult`

| Field | Type | Notes |
|---|---|---|
| `glbUrl` | `string` | Durable hosted GLB URL. |
| `viewerUrl` | `string` | Shareable three.ws viewer link. |
| `jobId` | `string \| null` | `null` when the backend returned synchronously. |
| `status` | `'done'` | Resolved jobs are always `done`; failures throw. |
| `path` / `tier` / `backend` | `string` | What actually produced the mesh. |
| `etaSeconds` | `number` | Backend ETA at submit time. |

`forge()` submits to `POST /api/forge`, then polls `GET /api/forge?job=<id>`
until the job is `done` (the free NVIDIA lane often returns synchronously, with
no polling). Failures reject with a typed [`ForgeError`](#errors--edge-cases).

### `rig(glbUrl, options?) → Promise<ForgeResult>`

Auto-rig an existing GLB into an animation-ready humanoid. Wraps
`POST /api/forge?action=rig { glb_url }`. Returns the same `ForgeResult` shape
with a rigged `glbUrl`.

### `catalog() → Promise<Catalog>`

Fetch the live tier / backend / cost matrix (`GET /api/forge?catalog`) — the
single source of truth for prices, ETAs, which backends are configured, and
which paths each serves. Use it to render a picker before the user commits.

## How it works

Two orthogonal axes describe every request — `path` (how geometry is produced)
and `tier` (how much budget to spend):

```
prompt / image / sketch
        │
        ▼
   ┌──────────┐   image     ┌───────────────────────────────┐
   │  path =  ├────────────▶ FLUX/Imagen → TRELLIS·Hunyuan3D │  fast default, free lane
   │          ├─ geometry ─▶ Meshy / Tripo native text→mesh  │  BYOK, higher detail ceiling
   │          ├─ sketch ───▶ TripoSG-scribble                │  drawing + name → raw geometry
   └──────────┘             └───────────────┬───────────────┘
                                            ▼
                                   textured / untextured GLB
                                            │ (action=rig)
                                            ▼
                                   rigged humanoid GLB
```

- **`image`** (default) — text is painted into a reference image, then
  reconstructed to a mesh. Fast, and the free lane lives here.
- **`geometry`** — a native 3D model emits mesh geometry directly, so detail
  isn't capped by a single synthesized view. Bring your own Meshy/Tripo key.
- **`sketch`** — a drawing plus a prompt naming it drives TripoSG-scribble to
  raw geometry (no textures).

Backends declare which paths they serve and whether they need a key. If a
selected backend isn't configured, Forge returns a clean error state — it never
fabricates a model.

## Pricing

The free lane is genuinely free. Paid tiers are flat per-call prices, quoted in
USDC (6-decimal atomics) and settled over [x402](https://x402.org) or from a
prepaid credit balance:

| Tier | Polygons (target) | PBR | Price | Lane |
|---|---|---|---|---|
| **draft** | ~12k | — | **free** on NVIDIA NIM (text) | TRELLIS |
| **standard** | ~30k | — | **$0.15** (free on the NIM text lane) | TRELLIS / paid |
| **high** | ~200k | yes | **$0.50** | paid |

Set `payWith: 'x402'` (default) to pay per call with USDC, or `payWith:
'credits'` to draw from a signed-in prepaid balance. Pair with
[`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch) to
automate the 402 settlement. Prices are authoritative in `catalog()` — read
them at runtime rather than hardcoding.

## Errors & edge cases

`forge()` and `rig()` reject with a typed `ForgeError` carrying a `code`:

| `code` | HTTP | Meaning | Recovery |
|---|---|---|---|
| `needs_key` | 501 | The `geometry` path needs a BYOK Meshy/Tripo key. | Pass `providerKey`. |
| `backend_unavailable` | 503 | The selected backend isn't configured. | Omit `backend` to auto-route, or pick another. |
| `payment_required` | 402 | Paid tier with no payment. | Provide an x402 payer or top up credits. |
| `insufficient_credits` | 402 | `payWith: 'credits'` balance too low. | Top up at `/credits`. |
| `unauthorized` | 401 | Credit lane needs a signed-in account. | Authenticate, or use `payWith: 'x402'`. |
| `rate_limited` | 429 | Too many submissions. | Honour `retryAfter` on the error. |
| `generation_failed` | — | The backend produced no usable mesh. | Retry, or change `path`/`backend`. |

Every state is designed: a missing key returns `needs_key` (not a crash), an
unconfigured backend returns `503` (not a fake model). Mirror that in your UI.

## Examples

**Agent tool (free, zero-config)** — the same capability is exposed as the
`forge_free` MCP tool, so an agent can generate 3D with no wallet:

```js
const { glbUrl } = await forge('a low-poly treasure chest', { tier: 'draft' });
```

**Browser → render inline** with the sibling viewer:

```html
<script type="module">
  import { forge } from '@three-ws/forge';
  import '@three-ws/avatar/viewer';

  const { glbUrl } = await forge('a friendly robot');
  const el = document.createElement('three-ws-viewer');
  el.setAttribute('src', glbUrl);
  document.body.append(el);
</script>
```

**Generate → rig → animate** in one chain, ready for the walk companion:

```js
const base = await forge('a cartoon astronaut, full body', { tier: 'standard' });
const rigged = await rig(base.glbUrl);
// drop rigged.glbUrl into @three-ws/walk or @three-ws/avatar
```

## Related

- [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar) — render and animate the GLB Forge produces.
- [`@three-ws/walk`](https://www.npmjs.com/package/@three-ws/walk) — a rigged Forge model as a page companion.
- [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch) — auto-pay the paid tiers.
- [`@three-ws/avatar-schema`](https://www.npmjs.com/package/@three-ws/avatar-schema) — validate on-chain avatar manifests.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
