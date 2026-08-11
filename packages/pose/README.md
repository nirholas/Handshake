<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/pose</h1>

<p align="center"><strong>Turn a phrase into a pose — a deterministic seed plus the full joint-rotation map for a rigged 3D avatar.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/pose"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/pose?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/pose"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/pose?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/pose?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/pose?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#api">API</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="https://three.ws/pose">three.ws</a>
</p>

---

> `@three-ws/pose` is the official client for the three.ws **Pose Studio** — the
> engine behind [three.ws/pose](https://three.ws/pose). It maps a natural-language
> pose description (`"warrior stance"`, `"wave hello"`, `"sitting cross-legged"`)
> to a **deterministic seed** and the **complete Euler joint-rotation map** for the
> three.ws humanoid mannequin, picked from an in-repo library of named preset poses.
> The same prompt always yields the same pose, so it is a perfect way to *seed* or
> *initialize* a rigged character before you hand off to keyframes or live control.
> It runs the `pose_model` algorithm **locally** over the bundled preset library
> (pure, deterministic compute, no model inference, no network), and can optionally
> call the hosted tool on `/api/mcp-3d` instead. It pairs with
> [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge) (which *makes & rigs*
> the avatar) and [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar)
> (which *renders* it).

## Why

You have a rigged humanoid GLB and you want it to *do* something — not a baked clip,
just a single, named static pose to start from. Hand-authoring Euler rotations per
joint is tedious and error-prone: which axis bends the elbow, how far does the
shoulder open, where does the root drop for a crouch? Pose Studio answers that once,
for a curated library of real poses, and exposes it as a single call:

- **A phrase in, a pose out.** `poseSeed('warrior stance')` resolves to a full
  `jointName → { x, y, z }` rotation map in radians, ready to apply to your rig.
- **Deterministic by design.** The result is keyed by `sha256(prompt|presetId)`.
  Same prompt, same machine, same pose — every time. Reproducible across runs, CI,
  and clients. No randomness, no drift.
- **Always a real pose.** Selection scores your prompt against preset labels, ids,
  and groups; on no match it falls back to a deterministic pick. There is no synthetic
  or empty-pose codepath — you always get a usable, hand-tuned pose back.
- **Free and offline.** The algorithm is pure local computation (token scoring +
  sha256, no GPU, no inference), so the zero-config path runs entirely in-process:
  no network, no key, no wallet. It works on a plane.

This is the SDK twin of the [3D Studio MCP server](https://three.ws/mcp): the same
preset engine, exposed as plain functions instead of an MCP tool.

## Install

```bash
npm install @three-ws/pose
```

Zero runtime dependencies. Works in Node 18+ and the browser (uses WebCrypto,
and `fetch` only on the optional hosted lane).
To render or rig the avatar you pose, add
[`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar) and
[`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge).

## Quick start

No key, no wallet, no network:

```js
import { poseSeed } from '@three-ws/pose';

const pose = await poseSeed('wave hello');

console.log(pose.presetId);   // → 'wave'
console.log(pose.seed);       // → '8c12…e0f9' (stable sha256-derived)
console.log(pose.parameters); // → { shoulderR: { x: 0, y: 0, z: -2.45 }, elbowR: { x: -1.2, … }, … }
console.log(pose.previewUrl); // → https://three.ws/pose?seed=8c12…&preset=wave
```

Apply the rotations straight to a Three.js skeleton:

```js
import { poseSeed } from '@three-ws/pose';

const { parameters } = await poseSeed('the thinker');

for (const [jointName, euler] of Object.entries(parameters)) {
  if (jointName === 'rootPosition') {
    rig.position.set(euler.x, euler.y, euler.z); // optional whole-figure offset
    continue;
  }
  const bone = rig.getObjectByName(jointName);
  if (bone) bone.rotation.set(euler.x, euler.y, euler.z); // radians
}
```

Same prompt, same pose — useful as a fixed initialization seed:

```js
const a = await poseSeed('crouch');
const b = await poseSeed('crouch');
console.log(a.seed === b.seed); // → true, always
```

## API

### `poseSeed(prompt, options?) → Promise<PoseResult>`

Resolve a natural-language pose description to a deterministic seed and the full
joint-rotation map. `prompt` is a string, 1–500 characters. Runs locally.

**Per-call options**

| Option | Type | Default | Notes |
|---|---|---|---|
| `signal` | `AbortSignal` | none | Cancel the call. |
| `headers` | `Record<string,string>` | none | Extra headers (hosted lane only). |

### `createPose(options?) → PoseClient`

Build a client with fixed configuration. With no transport option the client
resolves poses **locally**, exactly like the top-level `poseSeed`. Passing any
of `baseUrl`, `apiKey`, or `fetch` switches it to the **hosted** `pose_model`
tool on `POST /api/mcp-3d` (one JSON-RPC `tools/call` per pose):

| Option | Type | Default | Notes |
|---|---|---|---|
| `baseUrl` | `string` | `https://three.ws` | API origin. Selects the hosted lane. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | E.g. a payment-aware x402 fetch. Selects the hosted lane. |
| `apiKey` | `string` | none | OAuth bearer; hosted calls run operator-funded. Selects the hosted lane. |
| `previewBase` | `string` | `https://three.ws/pose` | Base URL for the returned `previewUrl` (both lanes). |
| `headers` | `Record<string,string>` | none | Default headers on every hosted-lane request. |

On the hosted lane a keyless call is x402-priced per call: the server answers
`401/402` with a payment challenge, surfaced as `PaymentRequiredError` with the
`accepts` array. Settle it with a payment-aware `fetch` (e.g.
[`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch)) or
pass an `apiKey` to run operator-funded. The local lane never charges anything.

**Returns** `PoseResult`

| Field | Type | Notes |
|---|---|---|
| `seed` | `string` | 16-hex stable id, `sha256(prompt\|presetId).slice(0,16)`. |
| `presetId` | `string` | The picked preset's id, e.g. `'wave'`, `'warrior2'`, `'crouch'`. |
| `presetLabel` | `string` | Human label, e.g. `'Wave hello'`, `'Warrior II (yoga)'`. |
| `group` | `string` | One of `Standing`, `Action`, `Sitting & Floor`, `Expressive`. |
| `parameters` | `Record<string, { x, y, z }>` | Joint → Euler rotation **in radians**. May include `rootPosition` (a translation, not a rotation). |
| `previewUrl` | `string` | Open the result on `three.ws/pose` with `seed` + `preset` params. |
| `match` | `{ score: number, reason: string }` | `reason` is `token-match` or `no-match-deterministic-pick`. |
| `groups` | `string[]` | All four preset groups, for building a picker. |

`parameters` follows the mannequin convention: in rest pose every rotation is `0`,
arms at the sides. `shoulder.z` opens an arm outward, `shoulder.x` is forward(−)/
back(+), `elbow.x` bends (negative bends the forearm up). Joints not present in a
pose are at rest (`0`).

### `presetPose(presetId, options?) → Promise<PoseResult>`

Skip selection and resolve a specific preset by id — handy once a user has chosen one
from a picker. Internally seeds with the preset id as the prompt, so the same preset
always returns the same seed.

### `listPresetGroups() → string[]`

The four pose groups, returned synchronously for menu scaffolding:
`['Standing', 'Action', 'Sitting & Floor', 'Expressive']`.

## How it works

`poseSeed()` runs the `pose_model` algorithm in-process, over the preset library
bundled with the package (the same library the hosted tool serves). It is **pure
deterministic computation**: it scores your prompt against the named presets, picks
one, derives a seed, and returns the preset's pre-authored rotation map. No image
model, no GPU, no state, no network.

```
prompt ("warrior stance")
        │
        ▼
  tokenize → score every preset by token overlap
  (preset id + label + group all contribute vocabulary)
        │
        ├─ best score > 0 ──▶ token-match  ─────────┐
        └─ no overlap ──────▶ sha256(prompt) % N ───┤  (deterministic fallback)
                                                     ▼
                         picked preset { id, label, group, pose }
                                                     │
        seed = sha256(prompt | presetId).slice(0,16) ▼
                          { seed, presetId, parameters, previewUrl, … }
```

The preset library spans four groups: **Standing** (T-pose, A-pose, relaxed,
contrapposto, arms-up, wave, hands-on-hips, salute), **Action** (walk-step, run,
jump, punch, archery, superhero-landing, fighting-stance), **Sitting & Floor**
(chair, floor, kneel, crouch, thinker), and **Expressive** (praying, meditate,
warrior II, arabesque, flex, point, facepalm, bow). It is the same data the public
[/pose](https://three.ws/pose) page renders; enumerate it at runtime from the
exported `PRESETS` array rather than hardcoding.

### The hosted lane: the raw HTTP

The same engine is hosted as the `pose_model` tool on the 3D Studio MCP server.
The SDK calls it only when you configure a transport (see `createPose` above);
the wire call is a standard MCP `tools/call`, x402-priced for keyless callers:

```js
const res = await fetch('https://three.ws/api/mcp-3d', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'pose_model', arguments: { prompt: 'warrior stance' } },
  }),
});

const { result } = await res.json();
const pose = result.structuredContent;
// → { seed, preset_id, preset_label, group, parameters, preview_url, match, groups }
```

The HTTP tool returns **snake_case** keys (`preset_id`, `preview_url`); the SDK
normalizes them to the camelCase `PoseResult` shape above (both lanes go through
the same normalization, so results are interchangeable).

## Pricing

The default local lane is **free**: pure in-process compute, no payment, no key,
no wallet, nothing to meter.

The hosted `pose_model` tool on `POST /api/mcp-3d` is priced per call over
[x402](https://x402.org) for keyless callers, alongside the rest of the 3D Studio
tools. The authoritative price is the one in the server's `402` payment challenge
(surfaced by this SDK as `PaymentRequiredError.accepts`); read it at runtime
rather than hardcoding. Calls authenticated with a three.ws OAuth `apiKey` run
operator-funded instead of paying x402.

## Errors & edge cases

`poseSeed()` rejects with a typed `PoseError` carrying a `code`:

| `code` | Meaning | Recovery |
|---|---|---|
| `invalid_prompt` | Prompt empty or over 500 chars (the tool requires 1–500). | Trim to a short phrase. |
| `network_error` | Hosted lane only: the endpoint was unreachable. | Retry; honour the `signal`. |
| `tool_error` | Hosted lane only: the MCP server returned a JSON-RPC error. | Inspect `error.data`; retry. |
| `payment_required` | Hosted lane only, keyless: the x402 challenge (a `PaymentRequiredError`). | Pay via `accepts`, pass an `apiKey`, or use the free local lane. |

Designed states, not crashes:

- **No keyword match** is not an error. The tool falls back to a deterministic pick
  (`match.reason === 'no-match-deterministic-pick'`) and still returns a real pose.
  Inspect `match.score === 0` if you want to flag a weak match in your UI.
- **`rootPosition`** appears in `parameters` for poses that drop or lift the whole
  figure (crouch, sit, jump). Treat it as a position offset, **not** a bone rotation.
- **Determinism is per-prompt-string.** `"Wave"` and `"wave hello"` may resolve to
  the same preset but produce **different seeds** (the seed hashes the exact prompt).
  Reuse the exact prompt string for a stable seed.

## Examples

**Build a pose picker** from the live groups, then resolve a chosen preset:

```js
import { poseSeed, listPresetGroups } from '@three-ws/pose';

for (const group of listPresetGroups()) renderGroupHeader(group);

button.onclick = async () => {
  const pose = await poseSeed(input.value || 'relaxed stand');
  applyToRig(pose.parameters);
  shareLink.href = pose.previewUrl;
};
```

**Seed a freshly forged avatar** — generate, rig, then drop into a starting pose:

```js
import { forge, rig } from '@three-ws/forge';
import { poseSeed } from '@three-ws/pose';

const base = await forge('a cartoon astronaut, full body');
const rigged = await rig(base.glbUrl);          // animation-ready humanoid
const start = await poseSeed('superhero landing'); // initial pose
// load rigged.glbUrl, then apply start.parameters to its skeleton
```

**Agent / MCP**: the same capability is the `pose_model` tool on the hosted 3D
Studio MCP server. An agent that already holds an MCP session can call it with
`{ prompt: 'kneeling' }` and receive the identical preset + seed this package
computes locally.

## Related

- [`@three-ws/forge`](https://www.npmjs.com/package/@three-ws/forge) — generate and auto-rig the humanoid GLB you pose.
- [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar) — render and animate the rigged, posed avatar.
- [`@three-ws/mocap`](https://www.npmjs.com/package/@three-ws/mocap) — go beyond static poses: capture full pose/face/hand clips from webcam or video.
- [`@three-ws/x402-fetch`](https://www.npmjs.com/package/@three-ws/x402-fetch) — a payment-aware fetch that auto-settles the hosted x402 lane.

---

<p align="center">Built by <a href="https://three.ws">three.ws</a> · The only coin is <a href="https://three.ws">$THREE</a></p>
