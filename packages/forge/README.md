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
> (Meshy, Tripo, Rodin). It pairs with [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar)
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

This is the SDK twin of the [3D Studio MCP server](https://three.ws/docs/mcp-3d-studio),
the same engine, exposed as plain functions instead of MCP tools.

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

const model = await forge('a chrome robot with neon trim', { tier: 'draft' });

console.log(model.glbUrl);  // → durable https://…/forge/…​.glb
console.log(model.backend); // → which engine actually produced it
```

`glbUrl` is a durable CDN URL you can hand straight to a viewer. `viewerUrl` is
the shareable three.ws link, and it is `null` unless the API attached a creation
id (the anonymous free lane usually does not).

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
| `path` | `'image' \| 'geometry' \| 'sketch'` | `'image'` | How geometry is produced, see [How it works](#how-it-works). |
| `tier` | `'draft' \| 'standard' \| 'high'` | `'standard'` | Polygon budget + texture richness. |
| `backend` | `string` | auto | Force a generation backend. Read the live ids from `catalog()`. |
| `providerKey` | `string` | — | BYOK key for the `geometry` path (Meshy/Tripo/Rodin). Overrides the client-level key, and is resent on every poll. |
| `payWith` | `'credits' \| 'x402'` | `'credits'` | Billing lane, see [Pricing](#pricing). `'x402'` switches endpoints. |
| `pollIntervalMs` | `number` | `2500` | Gap between job polls. |
| `timeoutMs` | `number` | `180000` | Give up on a job that never finishes. |
| `headers` | `object` | — | Extra headers merged into every request for this call. |
| `signal` | `AbortSignal` | — | Cancel an in-flight generation. |
| `onProgress` | `(job) => void` | — | Called on each poll tick with the latest job state. |

**Returns** `ForgeResult`

| Field | Type | Notes |
|---|---|---|
| `glbUrl` | `string` | Durable hosted GLB URL. |
| `viewerUrl` | `string \| null` | Shareable three.ws viewer link. `null` when the response carried no creation id. |
| `jobId` | `string \| null` | `null` when the backend returned synchronously. |
| `creationId` | `string \| null` | Gallery/creation id, when the lane records one. |
| `status` | `'done'` | Resolved jobs are always `done`; failures throw. |
| `path` / `tier` / `backend` | `string \| null` | What actually produced the mesh. |
| `etaSeconds` | `number \| null` | Backend ETA at submit time. |
| `estimatedCredits` | `number \| null` | BYOK vendor spend estimate, where the backend reports one. |
| `durable` | `boolean` | `true` once the GLB has been copied to three.ws storage. |
| `raw` | `object` | The untouched API response, for anything not mapped above. |

`forge()` submits to `POST /api/forge`, then polls `GET /api/forge?job=<id>`
until the job is `done` (the free NVIDIA lane often returns synchronously, with
no polling). Failures reject with a typed
[`ThreeWsError`](#errors--edge-cases).

### `rig(glbUrl, options?) → Promise<ForgeResult>`

Auto-rig an existing GLB into an animation-ready humanoid. Wraps
`POST /api/forge?action=rig { glb_url }`. Returns the same `ForgeResult` shape
with a rigged `glbUrl`.

### `catalog() → Promise<Catalog>`

Fetch the live tier / backend / cost matrix (`GET /api/forge?catalog=1`), the
single source of truth for prices, ETAs, which backends are configured, and
which paths each serves. Use it to render a picker before the user commits.

### `getJob(jobId, options?) → Promise<ForgeResult>`

Read one job's current state without waiting for it to finish, so you can drive
your own progress UI, resume after a restart, or poll from a different process
than the one that submitted. Wraps `GET /api/forge?job=<id>` and returns the
same shape `forge()` resolves to, at whatever status the job is in right now.
Pass `providerKey` if the job was submitted with a BYOK key: the API re-resolves
the key on every poll and cannot report on the job without it.

```js
const job = await getJob('job_abc', { providerKey: process.env.MESHY_KEY });
console.log(job.status); // 'queued' | 'running' | 'done' | 'failed'
```

### `createForge(clientOptions?) → ForgeClient`

Bind a base URL, `fetch`, and credentials once and reuse them. The bare
`forge` / `rig` / `catalog` / `getJob` exports are a shared default client with
no options; reach for `createForge` when you need any of these:

| Client option | Type | Notes |
|---|---|---|
| `baseUrl` | `string` | API origin. Defaults to `THREE_WS_BASE_URL`, then `https://three.ws`. |
| `fetch` | `typeof fetch` | Bring your own, e.g. a payment-aware fetch that settles 402s. |
| `apiKey` | `string` | Sent as `Authorization: Bearer …`, for the credits lane. |
| `providerKey` | `string` | Default BYOK key. A per-call `providerKey` wins. |
| `headers` | `object` | Default headers on every request. |

It returns `{ forge, rig, catalog, getJob }` with identical signatures:

```js
import { createForge } from '@three-ws/forge';
import { x402Client } from '@x402/core/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import bs58 from 'bs58';

const signer = await createKeyPairSignerFromBytes(bs58.decode(process.env.SOLANA_SECRET_KEY));
const payer = new x402Client();
payer.register('solana:*', new ExactSvmScheme(signer));

const client = createForge({ fetch: wrapFetchWithPayment(globalThis.fetch, payer) });
const paid = await client.forge('a marble bust', { tier: 'high', payWith: 'x402' });
```

## How it works

Two orthogonal axes describe every request — `path` (how geometry is produced)
and `tier` (how much budget to spend):

```
prompt / image / sketch
        │
        ▼
   ┌──────────┐   image     ┌───────────────────────────────┐
   │  path =  ├────────────▶ FLUX/Imagen → TRELLIS·Hunyuan3D │  fast default, free lane
   │          ├─ geometry ─▶ Meshy/Tripo/Rodin native text→mesh│  BYOK, higher detail ceiling
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
  isn't capped by a single synthesized view. Bring your own Meshy, Tripo, or Rodin key.
- **`sketch`** — a drawing plus a prompt naming it drives TripoSG-scribble to
  raw geometry (no textures).

Backends declare which paths they serve and whether they need a key. If a
selected backend isn't configured, Forge returns a clean error state — it never
fabricates a model.

## Pricing

The browser-facing lane on `/api/forge` is free where the free engines can serve
the request, and asks for an account (credits) where they cannot. There is also
a pay-per-call twin at `POST /api/x402/forge` for agents with a wallet and no
account: one USDC payment, one generation, no signup. `payWith` picks between
them.

| Tier | Polygons (target) | PBR | Pay-per-call price |
|---|---|---|---|
| **draft** | ~12k | no | **$0.05** |
| **standard** | ~30k | no | **$0.15** |
| **high** | ~200k | yes | **$0.50** |

Prices are flat per call, quoted in USDC (6-decimal atomics) and settled on
Solana. They are authoritative in `catalog()`, so read them at runtime rather
than hardcoding.

```js
// Pay-per-call: no account, no key, just a wallet.
const model = await forge('a marble bust', { tier: 'high', payWith: 'x402' });
```

Because the x402 endpoint picks its own generation lane, it does not accept
`path`, `backend`, or `providerKey`; passing one throws `invalid_input` before
any request is sent. Without a payment-aware `fetch` the first call rejects with
`PaymentRequiredError`, whose `accepts` carries the challenge (asset, amount,
network, payTo) so you can settle it yourself. The live route quotes **Solana
USDC**, so the payment-aware fetch shown under
[`createForge`](#createforgeclientoptions--forgeclient) is the one to reach for.
Once paid, the job token is polled for free on the shared
`GET /api/forge?job=<id>` endpoint, which is what this SDK does for you.

## Errors & edge cases

`forge()`, `rig()`, and `getJob()` reject with a typed `ThreeWsError` carrying a
`code`, an HTTP `status`, and the parsed `body`. HTTP 402 rejects with the
`PaymentRequiredError` subclass, which adds `accepts`. Both are exported.

| `code` | HTTP | Meaning | Recovery |
|---|---|---|---|
| `invalid_input` | — | Rejected client-side before any request: unknown `tier`/`path`/`payWith`, no prompt and no image, or an x402 call carrying `path`/`backend`/`providerKey`. | Fix the call. |
| `needs_key` | 501 | The selected BYOK backend needs your own provider key. | Pass `providerKey`. |
| `backend_unconfigured` | 501 | That backend has no credential on the server. | Omit `backend` to auto-route, or pick another. |
| `unconfigured` | 503 | No generation backend is configured at all. | Retry later, or self-host. |
| `generation_unavailable` | 503 | Every eligible backend failed or is down. | Retry, or change `path`/`tier`. |
| `payment_required` | 402 | The x402 lane wants payment. `accepts` carries the challenge. | Settle it, or use a payment-aware `fetch`. |
| `three_hold_required` | 402 | The paid gate wants a $THREE hold or a per-use payment. | Hold $THREE, or pay the quoted amount. |
| `insufficient_credits` | 402 | The account's credit balance is too low. | Top up, or use `payWith: 'x402'`. |
| `unauthorized` | 401 | The credits lane needs a signed-in account. | Authenticate, or use `payWith: 'x402'`. |
| `rate_limited` | 429 | Too many submissions from this IP. | Honour `retryAfter` on the error. |
| `timeout` | — | The job did not finish within `timeoutMs`. | Raise `timeoutMs`, or resume with `getJob(jobId)`. |
| `network_error` | — | The request never reached the API. | Check connectivity / `baseUrl`. |
| `generation_failed` | — | The backend produced no usable mesh. | Retry, or change `path`/`backend`. |

Every state is designed: a missing key returns `needs_key` (not a crash), an
unconfigured backend returns a `501`/`503` state (not a fake model). Mirror that
in your UI.

```js
import { forge, ThreeWsError, PaymentRequiredError } from '@three-ws/forge';

try {
  await forge('a marble bust', { tier: 'high', payWith: 'x402' });
} catch (err) {
  if (err instanceof PaymentRequiredError) console.log(err.accepts);
  else if (err instanceof ThreeWsError) console.log(err.code, err.status);
  else throw err;
}
```

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
- [`@three-ws/x402-mcp`](https://www.npmjs.com/package/@three-ws/x402-mcp) — pay any x402 endpoint from a Solana keypair.
- [`@three-ws/avatar-schema`](https://www.npmjs.com/package/@three-ws/avatar-schema) — validate on-chain avatar manifests.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
