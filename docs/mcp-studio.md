# three.ws 3D Studio — free MCP endpoint

A free, non-crypto MCP server that turns a text prompt or an image into an
interactive, downloadable 3D model (GLB). It exposes **only** 3D-generation
tools — no account, no payment, no API key, no wallet, no token. Built for the
OpenAI ChatGPT App Directory and any MCP client.

> The paid, crypto-enabled studio (per-call USDC via x402) is a separate server
> at `/api/mcp-3d`. This endpoint shares none of that surface.

## Connect

| | |
|---|---|
| **URL** | `https://three.ws/api/mcp-studio` |
| **Transport** | Streamable HTTP (JSON-RPC over `POST`) |
| **Auth** | None — open and free |
| **Protocol** | MCP `2025-06-18` |
| **Manifest** | [`server-studio.json`](../server-studio.json) |

`GET` is intentionally not offered (no server-initiated stream); the server
answers every request synchronously over `POST`. `OPTIONS` is handled for CORS.

### ChatGPT (Apps SDK)

Add the connector with the URL above and **No authentication**. Each generation
tool renders its result inline in an interactive 3D viewer widget
(`ui://widget/three-studio-model.html`); the persona tools render a living agent
body in their own widget (`ui://widget/three-studio-persona.html`). Both widgets
declare an `openai/widgetCSP` whose allowlist includes the GLB storage origin,
so models load inside real ChatGPT (which enforces the CSP), not just in
permissive test harnesses.

### Any MCP client

```bash
curl -s https://three.ws/api/mcp-studio \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### ChatGPT custom GPT (Actions)

The same free lane also ships as a REST Actions surface for the **"three.ws 3D
Studio"** custom GPT: `POST /api/3d/studio` submits a prompt and
`GET /api/3d/studio?job=<id>` polls it, with an age-13+ safety gate and
store-clean responses (model URLs and job state only). The machine-readable
contract is the OpenAPI schema the platform serves at
[`https://three.ws/.well-known/3d-studio-openapi.yaml`](../public/.well-known/3d-studio-openapi.yaml),
which is what the custom GPT imports; the same endpoint is written up in prose in
the [API reference](./api-reference.md). Use the MCP connector above when you
want inline 3D widgets; the custom GPT covers plans without connector support.

How AR rides both ChatGPT surfaces (the `arUrl` contract, the device-aware
launcher, living avatars, link unfurls) is documented end to end in
[AR in ChatGPT](./chatgpt-ar.md).

## Tools

`tools/list` returns exactly **eleven** tools, and they split four ways:

- **Six generation tools** (`forge_free`, `text_to_avatar`, `mesh_forge`,
  `rig_mesh`, `forge_avatar`, `refine_model`), in the table below.
- **One collector**, `check_job`, also in the table below.
- **One inspector**, `look_at_model`, also in the table below.
- **Three persona/embodiment tools** (`create_agent_persona`,
  `get_agent_persona`, `persona_say`), in the **Embodiment** section further down.

All eleven are free and keyless.

The six generation tools run operator-funded on the platform's own generation
pipeline. Annotations: `readOnlyHint:false`, `destructiveHint:false`,
`idempotentHint:false`, `openWorldHint:true` (work runs against external model
APIs; nothing is ever modified or deleted). `check_job` is the exception: it is a
pure status probe (`readOnlyHint:true`, `idempotentHint:true`) and never counts
against the generation quota. `look_at_model` is read-only and idempotent too,
but it renders frames server-side, so it rides the same per-IP generation
quota as the six generators.

| Tool | Title | Input | Returns |
|---|---|---|---|
| `forge_free` | Generate a 3D model from text | `prompt`, `tier?` | GLB model |
| `text_to_avatar` | Generate a 3D avatar | `prompt?` / `image_url?` | GLB avatar |
| `mesh_forge` | Generate a 3D mesh (art-directed) | `prompt?` / `image_url?` | GLB mesh |
| `rig_mesh` | Rig a 3D model for animation | `glb_url` | rigged GLB |
| `forge_avatar` | Generate a rigged, animation-ready avatar | `prompt?` / `image_url?`, `allow_non_humanoid?` | rigged GLB avatar |
| `refine_model` | Refine a 3D model by describing a change | `glb_url`, `instruction`, `parent_prompt?`, `parent_lineage?`, `parent_index?` | refined GLB + version lineage |
| `check_job` | Check a pending 3D generation and collect it | `job_id` | GLB model, or an updated pending state |
| `look_at_model` | Look at a 3D model | `glb_url`, `views?` (up to 6 of `front`, `three-quarter`, `side`, `back`, `top`, `bottom`; default three-quarter, front, side, back), `size?` (128 to 1024 px, default 512) | rendered frames as images, plus geometry stats (triangles, materials, textures) and a plain reading of them |

### Quality tiers

`forge_free` takes an optional `tier` of `draft`, `standard`, or `high`.
**`standard` is the default**, and it is what you get when you omit the
argument. It is the balanced free lane: reliably textured, and served by
whichever free engine the router picks for the prompt (typically the
self-hosted TRELLIS worker).

`high` is a real option, not a placeholder. Ask for it by name and the
generation runs on our own self-hosted Hunyuan3D GPU worker for denser geometry.
It stays opt-in rather than becoming the default for two reasons. That worker is
scale-to-zero, so a cold container pays a spin-up on top of the generation. And
the high lane is platform-funded behind an internal access gate: if the gate
refuses (402) or the submit times out, the call degrades to standard rather than
failing the conversation, so a default of `high` would sometimes mean serving
standard while the docs promised more.

Nothing here is ever billed to you. The high tier is platform-funded, so the
caller stays anonymous and keyless at every tier. A generation can outlive one
tool call at any tier; see [Pending generations](#pending-generations-check_job)
for how it is collected rather than lost.

One naming collision worth knowing: the npm package `@three-ws/mcp-server`
([docs](./mcp.md)) also ships a tool called `forge_free`. That is a different
server with its own default (`draft`, stated in its own tool schema). The
default described here is the one for `https://three.ws/api/mcp-studio`.

### Response shape

Each successful call returns `structuredContent` carrying only what a client
needs to display the model — no internal identifiers:

```json
{
  "kind": "model",
  "glbUrl": "https://three.ws/cdn/creations/…/model.glb",
  "viewerUrl": "https://three.ws/viewer?src=…",
  "arUrl": "https://three.ws/api/ar?src=…&title=…",
  "format": "glb",
  "prompt": "a friendly round robot mascot, glossy white plastic",
  "referenceImageUrl": "https://three.ws/cdn/creations/…/model-ref.png"
}
```

`referenceImageUrl` is the concept image the generator paints first and then
sculpts into 3D (the forge's image-generation step). The inline widget uses it
as the model-viewer poster so the painted view shows while the GLB streams in,
and the result narration links it for non-widget clients.

`arUrl` is the one-tap place-in-your-room link (see [AR in ChatGPT](./chatgpt-ar.md)).
Rigged avatars additionally carry `irlUrl`, the living-agent handoff into
[IRL](./irl.md), and the inline widget's AR button becomes **Bring it to life**.
Every result also includes a `spatial` field, the open Spatial MCP artifact
(`specs/SPATIAL_MCP.md`) so any Spatial-MCP renderer can display the model.

### Pending generations (`check_job`)

A detailed model can take longer than a single tool call should block for. When
that happens the generating tool does **not** fail: it returns a success result
carrying a pollable handle, and the job keeps running server-side.

```json
{
  "status": "pending",
  "jobId": "f1.eyJwIjoiZ2NwIiw…",
  "pollUrl": "https://three.ws/api/gpt-forge?job=f1.eyJwIjoiZ2NwIiw…",
  "stage": "mesh",
  "etaRemainingSeconds": 42,
  "prompt": "a friendly round robot mascot, glossy white plastic"
}
```

`stage` names which half of the pipeline is still running, `mesh` or `rig`, so a
client that collects the job knows whether the GLB it gets back is a bare mesh
still to be rigged or the finished rig. It carries no identifier, so it costs the
data-minimization rule nothing.

`etaRemainingSeconds` is the live estimate for the lane actually running the job
(its typical duration minus time already elapsed), so the assistant knows how
long to wait rather than retrying blind. Call `check_job` with that `jobId` to
collect the result:

- **done**: returns the ordinary success envelope (`glbUrl`, `viewerUrl`,
  `arUrl`, …) and the model renders inline in the widget, exactly as if the
  original call had finished in time.
- **still rendering**: returns a fresh `pending` envelope with updated
  `etaRemainingSeconds`. Call again after the suggested wait.
- **failed**: returns a clean, actionable error.

`check_job` is read-only and idempotent, and it does not consume generation
quota, so collecting a model can never be rate-limited by the generation that
created it. The inline widget renders the pending state as a designed
"still rendering" panel with the live countdown, not an empty state.

Any HTTP client can poll `pollUrl` directly instead; it is the same public,
auth-free job handle the [3D API](/docs/3d-api) hands anonymous callers.

### Conversational refinement (`refine_model`)

Iterate on a model by describing the change in words — *"make it metallic"*,
*"bigger helmet"*, *"add wings"*. It's a REAL anchored re-generation, never a fake
diff: the prior prompt is carried forward and folded with your change
(`composeRefinement`), and an optional `reference_image_url` of the current model
anchors the regeneration as image→3D. Text-guided refinement needs only
`glb_url` + `instruction`; passing `parent_prompt` lets the change build on the
original spec instead of starting over.

Every refinement is appended to an immutable **version lineage** returned in
`structuredContent.lineage`. The client passes that array back as `parent_lineage`
on the next call to extend the same thread, or targets an earlier version with
`parent_index` to **branch**. Reverting is a pointer move over the array — no
mutation. The inline viewer renders the lineage as a version strip you can click
to cross-fade between versions.

```json
{
  "kind": "refined model",
  "glbUrl": "https://three.ws/cdn/creations/…/v1.glb",
  "viewerUrl": "https://three.ws/viewer?src=…",
  "format": "glb",
  "prompt": "a friendly round robot mascot, glossy white plastic, metallic and gold",
  "instruction": "make it metallic and gold",
  "activeIndex": 1,
  "lineage": [
    { "index": 0, "parentIndex": null, "glbUrl": "…/origin.glb", "label": "Original", "active": false },
    { "index": 1, "parentIndex": 0, "glbUrl": "…/v1.glb", "label": "make it metallic and gold", "instruction": "make it metallic and gold", "active": true }
  ]
}
```

The same `refine_model` capability is available on the paid stdio MCP server
(`3d-agent-local`, $0.25 USDC per call) via the shared lineage core, so iteration
behaves identically on both tracks.

## Embodiment — a living agent body

Three additional free tools turn a generated avatar into a **persistent, living
agent body** that renders inline in the chat: it lip-syncs each reply, shows the
matching expression and gesture, idles between turns, and returns as the same body
across sessions. A persona is a name and a 3D body — nothing about tokens, wallets,
or payments.

| Tool | Title | Input | Returns |
|---|---|---|---|
| `create_agent_persona` | Save a rigged model as a living, persistent agent body | `glb_url`, `name`, `voice?`, `source_prompt?` | `persona_id` + inline living body (idle) |
| `get_agent_persona` | Reload a persona by id (continuity across sessions) | `persona_id` | the same body + turn count |
| `persona_say` | Speak a reply through a persona: lip-sync + emotion + gesture | `persona_id`, `text`, `emotion?` | the body performing the reply |

Annotations: `create_agent_persona` and `persona_say` are writes
(`readOnlyHint:false`); `get_agent_persona` is a pure read (`readOnlyHint:true`,
`idempotentHint:true`). `create_agent_persona` carries `openWorldHint:true`
because it fetches the GLB you hand it from wherever it lives before taking a
durable copy; `get_agent_persona` and `persona_say` touch only three.ws's own
store, so both are `openWorldHint:false`.

**How it renders.** In ChatGPT (Apps SDK), each persona tool points its tool-level
`_meta["openai/outputTemplate"]` at the registered
`ui://widget/three-studio-persona.html` widget, which reads the tool's
`structuredContent` and mounts the hosted embodiment page (a result-level template
on an inline artifact is ignored by the Apps SDK, so the tool-level link is what
makes the body appear). In every other MCP host the tool result carries an inline
`text/html` resource that frames the same hosted page,
`https://three.ws/embodiment/embed`, with the
persona id and the turn's speak/emotion payload as query params. That page mounts
`EmbodimentStage` (Three.js), which rides the platform's universal
canonicalize/retarget pipeline so the baked idle + gesture clip library drives any
humanoid rig. Emotion is detected from the reply text (or set explicitly via
`emotion`) and blended onto the face **and** an upper-body gesture; lip-sync is
best-first — an Audio2Face viseme track synced to TTS audio when present, else a
deterministic text-timed mouth envelope.

**Graceful states, never a frozen pose.** A rig with no facial morphs still
animates its mouth from the jaw (or head) bone. A model that can't be
skeleton-driven — no skin, or a non-humanoid prop — is detected up front
(`decideRigMode` / `AnimationManager.supportsCanonicalClips()`) and falls back to a
gentle alive-idle with a designed note, never a bind-pose T-pose.

**Continuity.** The persona is persisted (durable GLB copy + a small identity
record) and addressed by an unguessable `persona_id` — that id is the whole
capability, so a fresh session reloads the exact same body with no sign-in. When
the embed is opened with only an id (no inline `glb`), it resolves the durable body
via `GET /api/mcp3d/persona?id=persona_…`, which returns the public projection
(name, GLB, turn count) — never storage keys or owner ids.

```json
{
  "persona_id": "persona_9f3aK2…",
  "name": "Nova",
  "glb_url": "https://three.ws/…/nova.glb",
  "emotion": "joy",
  "intensity": 0.7,
  "gesture": "av-celebrating",
  "turn_count": 3,
  "status": "spoken"
}
```

The same three tools ship on the paid stdio MCP server (`3d-agent-local`) so
embodiment behaves identically on both tracks; both drive the one hosted embed.

## Funding & limits

Generation is **operator-funded**: the platform's server-side keys cover provider
cost, so the ChatGPT user pays nothing, at any tier. Routing is **free-first**: no
backend is pinned, and the health-aware router in `api/gpt-forge.js` prefers the
free lanes (self-hosted TRELLIS, NVIDIA NIM text→3D, Hugging Face Spaces
image→3D), so in the normal case the platform's marginal cost per generation is
zero. The platform-keyed Replicate lane stays in the chain as a failover rung
rather than being excluded, so a free-lane outage degrades to a slower or
costlier engine instead of failing the user's request. Either way the cost lands
on the platform and never on the caller: no key, no account, no payment surface.

The endpoint still enforces real per-IP abuse protection (`api/_lib/rate-limit.js`):

- **Burst:** 4 generations / minute / IP
- **Hourly:** 30 generations / hour / IP
- **Persona writes:** 20 / minute / IP (`create_agent_persona`, `persona_say`;
  `get_agent_persona` is a read and rides the transport cap)
- **Transport:** 300 requests / minute / IP (discovery, never throttled by the
  generation quota)
- **Platform-wide breaker:** a global cap across every free-studio caller,
  backstopping the shared GPU budget when many distinct IPs, each individually
  under the hourly cap, would collectively drain it

The generation quota is charged only when a request actually calls a generation
tool, so `initialize`, `tools/list`, `resources/list`, and `check_job` are never
throttled by it.

Because the lanes are zero-cost, the **per-IP** caps **fail open** if the
rate-limiter backend has an outage: a Redis blip must never dead-end a free
feature (the same posture as the paid server's own free lane). The platform-wide
breaker is the deliberate exception and **fails closed** in production, since a
limiter outage is exactly when an unbounded global spend would do real damage.
Any accidental paid-lane spend is still fail-closed one layer further down in
`/api/gpt-forge` (the ChatGPT-dedicated clone of `/api/forge`; see the note under
Environment).

## Safety

Generation prompts are screened for age-13+ appropriateness before any provider
work (`api/_mcp-studio/safety.js`): sexual/adult, child-sexual, graphically
violent, hateful/extremist, and real-weapon/drug prompts are refused with a
clear message. Stylized fantasy props (a sword, a wand) are allowed.

## Environment

All optional — sensible production defaults:

| Var | Default | Purpose |
|---|---|---|
| `STUDIO_API_BASE` | request origin → `PUBLIC_APP_ORIGIN` → `https://three.ws` | Origin to call `/api/gpt-forge` on |
| `STUDIO_FORGE_TIMEOUT_MS` | `180000` | Generation poll budget |
| `STUDIO_RIG_TIMEOUT_MS` | `180000` | Rig poll budget |
| `STUDIO_REFINE_TIMEOUT_MS` | `180000` | `refine_model` poll budget |
| `STUDIO_POLL_MS` | `3000` | Starting poll interval |
| `STUDIO_POLL_MAX_MS` | `10000` | Ceiling the poll interval backs off to |

Generation runs on `/api/gpt-forge` (`api/gpt-forge.js`), the ChatGPT-dedicated
exact clone of `/api/forge`: same lanes, tiers, job tokens, and `forge_creations`
rows, cloned so the ChatGPT pipeline can be tuned without touching the forge or
any surface that rides it. The agent-facing REST endpoints (`/api/3d/generate`,
`/api/v1/ai/text-to-3d`) stay on `/api/forge`.

The inline widget loads Google's `<model-viewer>` from one pinned URL in
[`api/_lib/model-viewer-cdn.js`](../api/_lib/model-viewer-cdn.js), which is also
the origin the widget's `openai/widgetCSP` allowlists, so the script tag and its
CSP entry cannot drift apart. That module pins the one build every three.ws
surface loads, so a host page that already has a three.ws embed reuses the same
module instead of registering a second, conflicting custom element. The
standalone [`/viewer`](../public/viewer.html) page and the Vite-bundled
first-party pages ship the same version and differ only in how they fetch it:
a top-level document can carry an SRI hash, a template-interpolated embed and a
runtime CDN failover chain cannot. The header comment in
`api/_lib/model-viewer-cdn.js` names all three delivery rungs, and
`npm run check:model-viewer` fails the build if one of them drifts off the
shared version. The `/api/ar` launcher no longer inlines a
`<model-viewer>` of its own: Android gets a Scene Viewer intent, and every other
device (and every live avatar) is sent on to `/ar/view`, a Vite-bundled page
that generates a real USDZ from the GLB on the device so iPhone gets genuine
Quick Look rather than a camera overlay (`api/_lib/ar-launch.js`).

## Related

- [MCP overview](/docs/mcp) - every three.ws MCP surface, paid and free
- [AR in ChatGPT](/docs/chatgpt-ar) - how `arUrl` and the AR launcher work on ChatGPT surfaces
- [3D API](/docs/3d-api) - the free REST lane the studio tools run on
- [API Reference](/docs/api-reference) - the `/api/3d/studio` custom GPT Actions contract
