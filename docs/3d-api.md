# three.ws 3D API

Free, keyless 3D for AI agents. No key, no account, no wallet — an autonomous
agent can turn a text prompt into a real textured GLB model in one call. This is
the only text→3D lane in the x402 / agent-payments ecosystem that gives draft
generation away for free, and it funnels into the paid quality tiers when an
agent needs production output.

Base URL: `https://three.ws`

> This page documents the **free** 3D endpoints. Higher-quality generation and
> rigging are paid: **Forge Pro** (quality tiers) at [`/api/x402/forge`](https://three.ws/api/x402/forge)
> and **Rigged Avatars** (animation-ready skeletons) via [`/api/forge?action=rig`](https://three.ws/api/forge).

Prefer a browsable landing page? See [three.ws/3d](https://three.ws/3d) — hero,
live endpoint table, a runnable inspection console, an embedded 3D viewer, and the
free→paid ladder.

---

## Discovery — one URL for the whole API

Point one request at `GET /api/3d` and you get the entire free API: every
endpoint, its inputs/outputs, a live example, and the paid tiers it graduates to.
The list is assembled from the API catalog at request time, so a new endpoint
appears the moment it ships — nothing is hand-maintained.

```bash
curl https://three.ws/api/3d
```

```jsonc
{
  "name": "three.ws 3D API",
  "free": true,
  "keyless": true,
  "version": "1.0.0",
  "endpoints": [
    { "slug": "generate", "methods": ["POST"], "path": "/api/3d/generate", "title": "Text → 3D (free draft)", "…": "…" },
    { "slug": "inspect",  "methods": ["GET", "POST"], "path": "/api/3d/inspect", "title": "3D Model Inspect & Validate", "…": "…" }
  ],
  "count": 2,
  "paidTiers": [
    { "name": "Forge Pro", "path": "/api/x402/forge", "price": "from $0.05 USDC", "why": "…" },
    { "name": "Rigged Avatar", "path": "/api/forge?action=rig", "price": "from $0.05 USDC", "why": "…" }
  ],
  "openapi": "/api/3d/openapi.json",
  "docs": "/docs/3d-api",
  "ts": "2026-07-07T00:00:00.000Z"
}
```

Send `Accept: text/html` for a browsable version of the same data; anything else
(the agent path) returns JSON.

### OpenAPI 3.1

`GET /api/3d/openapi.json` is a real OpenAPI 3.1 document generated from the same
catalog — point any toolchain (LangChain's `OpenAPIToolkit`, `openapi-generator`,
Swagger UI) at it for typed clients and callable tools. No key, no account.

```bash
curl https://three.ws/api/3d/openapi.json
```

GET endpoints expose their inputs as query/path `parameters`; POST endpoints
expose them as a JSON `requestBody`. Because both the index and the spec derive
from one catalog, they can never drift.

---

## Text → 3D generation (free)

**`POST /api/3d/generate`** — turn a text prompt into a GLB model.
**`GET /api/3d/generate?job=<id>`** — poll a queued generation.

### Who uses this, and why

An agent building a **game**, a **scene**, an **NFT**, or any visual needs a 3D
model from a text prompt — instantly, with no signup and no key to manage. It
calls `POST /api/3d/generate`, gets back a GLB (or a job token to poll), drops the
model into its world, and keeps going. When it needs denser geometry, PBR
textures, or a rigged, animatable character, it upgrades to Forge Pro / Rigged
Avatars — same platform, same auth-free base.

### Free-tier limits (stated honestly)

The free lane is the **draft / NIM tier only**. Be realistic about what it is:

- **Draft fidelity.** Geometry is a fast draft (NVIDIA NIM TRELLIS), not a
  production, high-polygon, PBR-textured mesh. Good for prototyping, greyboxing,
  placeholders, and single objects.
- **One subject per prompt.** Describe a single object (`"a small ceramic robot
  figurine"`), not a whole scene. Prompts are 3–1000 characters.
- **GLB only.** The response is always a `.glb` model.
- **No rigging.** The mesh has no skeleton or skin weights. Rigging is paid
  (Rigged Avatars).
- **Generous per-IP rate limit**, protecting a shared GPU allocation. On a limit
  you get `429` with `Retry-After`; the paid Forge tiers have no per-IP cap.

For higher quality → **Forge Pro** (`/api/x402/forge`). For animation-ready
characters → **Rigged Avatars** (`/api/forge?action=rig`).

### Request

```json
POST /api/3d/generate
Content-Type: application/json

{
  "prompt": "a small ceramic robot figurine",
  "format": "glb"
}
```

| Field    | Type   | Required | Notes                                          |
|----------|--------|----------|------------------------------------------------|
| `prompt` | string | yes      | One subject, 3–1000 characters.                |
| `format` | string | no       | `"glb"` (the only supported value; default).   |

### Response — finished inline

The free draft lane often completes inside the request window. When it does, the
model comes straight back:

```json
{
  "status": "done",
  "glbUrl": "https://cdn.three.ws/forge/anon/a1b2c3d4.glb",
  "viewerUrl": "https://three.ws/viewer?src=https%3A%2F%2Fcdn.three.ws%2Fforge%2Fanon%2Fa1b2c3d4.glb",
  "arUrl": "https://three.ws/api/ar?src=https%3A%2F%2Fcdn.three.ws%2Fforge%2Fanon%2Fa1b2c3d4.glb&title=a%20small%20ceramic%20robot%20figurine",
  "format": "glb",
  "tier": "draft",
  "free": true,
  "upgrade": { "forgePro": "/api/x402/forge", "riggedAvatars": "/api/forge?action=rig", "docs": "/docs/3d-api" }
}
```

`arUrl` is the place-in-your-room link (`/api/ar`): opened on a phone it
launches AR directly — Scene Viewer on Android, Quick Look on iOS (GLB→USDZ
converted in-page) — and on desktop it falls back to the interactive viewer.
The prompt rides along as `title` so the AR page is labeled. Show it to end
users as "place it in your room".

### Response — queued (poll)

Otherwise you get a job token and a poll URL (the prompt is carried as
`title` so the finished AR page stays labeled):

```json
{
  "status": "pending",
  "job": "f1.eyJwIjoibnZpZGlh...",
  "poll": "/api/3d/generate?job=f1.eyJwIjoibnZpZGlh...&title=a%20small%20ceramic%20robot%20figurine",
  "format": "glb",
  "tier": "draft",
  "free": true
}
```

Poll the `poll` URL until the status is terminal:

```json
GET /api/3d/generate?job=f1.eyJwIjoibnZpZGlh...&title=a%20small%20ceramic%20robot%20figurine

// still working
{ "status": "pending", "job": "f1...", "poll": "/api/3d/generate?job=f1...&title=..." }

// ready
{ "status": "done", "job": "f1...", "glbUrl": "https://cdn.three.ws/forge/anon/done.glb",
  "viewerUrl": "https://three.ws/viewer?src=...", "arUrl": "https://three.ws/api/ar?src=...&title=...",
  "format": "glb", "tier": "draft", "free": true }

// upstream failed — free lane, so no charge; just retry
{ "status": "error", "job": "f1...", "error": "3D generation hit a snag upstream — no charge; try again.", "free": true }
```

### States & errors

| Situation                     | Response                                                        |
|-------------------------------|----------------------------------------------------------------|
| Empty / too-short / oversized prompt | `400 invalid_prompt`                                    |
| Unsupported `format`          | `400 unsupported_format`                                       |
| Queued                        | `200 { status: "pending", job, poll }`                        |
| Ready                         | `200 { status: "done", glbUrl, viewerUrl, arUrl }`            |
| Generation failed upstream    | `200 { status: "error", error }` — free, **no charge**        |
| GPU lane saturated / rate-limited | `429` with `Retry-After` + an upgrade pointer             |
| Lane not configured on this deployment | `503 not_configured`                                 |

A well-formed prompt never returns `500`.

### curl — end to end

```bash
# 1. Submit a prompt
curl -s -X POST https://three.ws/api/3d/generate \
  -H 'content-type: application/json' \
  -d '{"prompt":"a small ceramic robot figurine"}'

# → { "status": "pending", "job": "f1...", "poll": "/api/3d/generate?job=f1..." }
#   (or { "status": "done", "glbUrl": "..." } if it finished inline)

# 2. Poll until done, then download the GLB
curl -s 'https://three.ws/api/3d/generate?job=f1...'
# → { "status": "done", "glbUrl": "https://cdn.three.ws/forge/anon/....glb", ... }

curl -sL -o model.glb 'https://cdn.three.ws/forge/anon/....glb'
```

The `glbUrl` is a real, durable GLB — open `viewerUrl` in a browser to inspect it,
or load `model.glb` in any glTF-capable engine (three.js, Babylon, Unity, Godot,
Blender).

`viewerUrl` (`https://three.ws/viewer?src=<https GLB url>&title=<label>`) is more
than a preview. Its "Do more with this model" panel funnels the model into the
rest of the platform: Pose Studio (`/pose?src=`, shown when the GLB carries a
skeleton), material restyling (`/restyle?url=`), Scene Studio (`/scene?model=`),
Parts Studio (`/compose?glb=`), AR placement (`/ar?src=`), a pump.fun coin
launch pre-filled with a rendered snapshot of the model, and a copyable embed
iframe. The viewer page itself is embeddable on any site: it is served with
`frame-ancestors *`, so an `<iframe src="https://three.ws/viewer?src=...">` works
anywhere.

### Upgrade path

| Need                                   | Endpoint                              |
|----------------------------------------|---------------------------------------|
| Free draft geometry from a prompt      | `POST /api/3d/generate` (this page)   |
| Higher polygon budgets + PBR textures  | Forge Pro — `POST /api/x402/forge`    |
| Animation-ready rigged character       | Rigged Avatars — `POST /api/forge?action=rig` |

---

## Forge Pro — paid quality tiers (`/api/x402/forge`)

**`POST /api/x402/forge`** — the pay-per-call twin of the free draft lane. Same
inputs (a text prompt, or up to four reference photos of one object), but you pick
a **quality tier**, and you pay per generation in USDC over
[x402](https://x402.org) — no API key, no account, no signup. This is the only
real text→3D / image→3D generation on any agent marketplace, so it's built for
autonomous buyers: production **game assets**, **NFT collections**, **3D scenes**,
and **product visualization**.

### Who uses this, and why

An agent that has already proven the concept on the free draft lane, and now needs
a shippable asset. It calls `POST /api/x402/forge`, pays the tier price, and gets
back a job token it polls **for free** — the same poll path the free lane uses. It
picks us because there is no other keyless, pay-per-call 3D generator: no account
to create, no monthly plan, no key to provision — just one USDC payment per model.

### Quality tiers

| Tier       | Price (USDC) | Geometry            | Textures        | Best for                          |
|------------|--------------|---------------------|-----------------|-----------------------------------|
| `draft`    | **$0.05**    | ~12k tris, low-poly | none            | Blockout, iteration, previews     |
| `standard` | **$0.15**    | ~30k tris, balanced | none            | The default for most assets       |
| `high`     | **$0.50**    | ~200k tris, max     | **PBR + HD**    | Hero assets, product/NFT renders  |

Prices are the flat per-call retail price and are the single source of truth in
[`api/_lib/forge-tiers.js`](https://github.com/nirholas/three.ws/blob/main/api/_lib/forge-tiers.js);
the `402` challenge quotes the exact price for the tier you request. Ops can tune a
tier at deploy time without touching settlement.

### How to call it

1. **Discover the price (free, no payment).** `GET /api/x402/forge` returns the
   per-tier USDC catalog so an agent can budget before paying:

   ```bash
   curl -s https://three.ws/api/x402/forge
   # → { "route": "/api/x402/forge", "pricing_usdc": [
   #      { "tier": "draft", "price_usdc": "0.05" },
   #      { "tier": "standard", "price_usdc": "0.15" },
   #      { "tier": "high", "price_usdc": "0.50" } ], … }
   ```

2. **Request a generation.** `POST` the prompt (or `image_urls`) and the tier. With
   no `X-PAYMENT` header you get a `402` challenge quoting the Solana USDC price;
   pay it with any x402 client and retry with the payment header.

   ```bash
   # text → 3D
   curl -s -X POST https://three.ws/api/x402/forge \
     -H 'content-type: application/json' \
     -d '{"prompt":"a brass steampunk owl, full body","tier":"standard"}'

   # image → 3D — up to four public https views of ONE object (omit prompt)
   curl -s -X POST https://three.ws/api/x402/forge \
     -H 'content-type: application/json' \
     -d '{"image_urls":["https://example.com/owl-front.png","https://example.com/owl-side.png"],"tier":"high"}'
   ```

3. **Poll for free.** The paid call returns a job token; poll it on the free,
   provider-aware endpoint until the GLB is ready:

   ```json
   { "job_id": "f1.eyJ…", "status": "queued", "poll_url": "/api/forge?job=f1.eyJ…",
     "mode": "text_to_3d", "tier": "standard", "backend": "nvidia",
     "eta_seconds": 22, "price_usdc": "0.15" }
   ```

   ```bash
   curl -s 'https://three.ws/api/forge?job=f1.eyJ…'
   # → { "status": "done", "glb_url": "https://cdn.three.ws/forge/…/model.glb", … }
   ```

   A draft prompt often finishes inside the submit window and comes back inline with
   `status: "done"` and the `glb_url` already set — no polling needed.

### Payment & fairness

- **Solana mainnet USDC only.** Every quote on this route is a Solana `402`.
- **Submit before settle.** The generation job is submitted after payment is
  *verified* but before it *settles* — so if the generator can't accept the job,
  you are never charged.
- **Idempotent.** Retrying the same payment for the same body returns the same job
  token instead of generating (and charging) twice.

New here? Start on the **free** draft lane at
[`POST /api/3d/generate`](#text--3d-generation-free) — same prompt, zero cost — and
upgrade to a paid tier only when you need standard/high quality or image→3D.

---

## Inspect + validate + optimize (free)

**`GET /api/3d/inspect?url=<glb/gltf url>`** — inspect a model by URL.
**`POST /api/3d/inspect`** — `{ "url": "…" }` as JSON, **or** raw `.glb`/`.gltf`
bytes as the request body.

### Who uses this, and why

An autonomous agent handling a 3D asset — from a marketplace, a generation API,
or a user upload — needs to answer three questions before it commits to using
the file:

1. **Is it valid?** Is this actually a spec-compliant glTF/GLB, or a broken blob?
2. **How heavy is it?** Vertices, triangles, materials, textures, animations,
   extensions — the numbers that decide whether it's web/mobile-shippable.
3. **What should it fix first?** A prioritized, severity-ranked list of the
   fastest ways to make it smaller and faster.

One free call answers all three. It runs the official **Khronos glTF-Validator**
for the compliance verdict plus the same inspection core the platform's paid
pipelines use. Free on purpose: a validation utility drives trust and funnels
callers into the paid Forge Pro / Rigged Avatar / mesh-optimization tiers.

### Request

| Method | Input | Notes |
|--------|-------|-------|
| `GET`  | `?url=<https url>` | Public https URL of a `.glb`/`.gltf` model. |
| `POST` | `{ "url": "<https url>" }` (`application/json`) | Same, as a JSON body. |
| `POST` | raw `.glb`/`.gltf` bytes (`application/octet-stream`) | Upload a local model directly. |

Max size **32 MiB** (free tier) — larger files return `413`. URL fetches are
SSRF-hardened: only public hosts, no private/metadata addresses, redirects
re-validated per hop.

### Response

```json
{
  "url": "https://three.ws/avatars/cesium-man.glb",
  "valid": true,
  "sizeBytes": 495956,
  "stats": {
    "vertices": 3272,
    "triangles": 4672,
    "materials": 1,
    "textures": 1,
    "animations": 1,
    "extensions": [],
    "meshes": 1,
    "nodes": 22,
    "scenes": 1,
    "skins": 1,
    "joints": 19,
    "container": "glb",
    "generator": "COLLADA2GLTF"
  },
  "recommendations": [
    {
      "severity": "info",
      "issue": "Model looks well-optimized for web delivery — no suggestions flagged.",
      "fix": "No action needed — the model is already well-suited for web delivery."
    }
  ],
  "validation": { "valid": true, "numErrors": 0, "numWarnings": 0, "numInfos": 0, "numHints": 0 },
  "ts": "2026-07-07T00:00:00.000Z"
}
```

`recommendations` is ordered **most severe first** (`critical` → `warn` →
`info`); each item is a `{ severity, issue, fix }` triple — the problem and the
concrete action. `valid` reflects the glTF-Validator's error count.

### curl

```bash
# Inspect a remote model by URL
curl "https://three.ws/api/3d/inspect?url=https://three.ws/avatars/cesium-man.glb"

# Same, via JSON body
curl -X POST https://three.ws/api/3d/inspect \
  -H 'content-type: application/json' \
  -d '{"url":"https://three.ws/avatars/cesium-man.glb"}'

# Upload a local file directly
curl -X POST https://three.ws/api/3d/inspect \
  -H 'content-type: application/octet-stream' \
  --data-binary @my-model.glb
```

### States & errors

Every failure maps to a specific status — never `500` on a well-formed request.

| Situation | Response |
|-----------|----------|
| No `url` and no uploaded body | `400 missing_url` |
| Malformed URL / private/blocked host | `400 invalid_url` |
| Bytes are not a parseable glTF/GLB | `400 invalid_model` |
| Empty `POST` upload | `400 empty_body` |
| Model over the 32 MiB cap | `413 too_large` |
| Per-IP budget exhausted | `429 rate_limited` + `Retry-After` |
| Source URL didn't return the model | `502 fetch_failed` + retry hint |

### Upgrade path

When the report says "optimize," the paid pipelines do the work: **Forge Pro**
(higher-quality generation), **Rigged Avatars** (auto-rigging), and the x402
mesh-optimization routes. See
[`/.well-known/x402.json`](https://three.ws/.well-known/x402.json).
