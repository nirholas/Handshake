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
store-clean responses (model URLs and job state only). Full contract in the
[API reference](./api-reference.md). Use the MCP connector above when you want
inline 3D widgets; the custom GPT covers plans without connector support.

How AR rides both ChatGPT surfaces (the `arUrl` contract, the device-aware
launcher, living avatars, link unfurls) is documented end to end in
[AR in ChatGPT](./chatgpt-ar.md).

## Tools

All six generation tools are free and run operator-funded on the platform's own
generation pipeline. Annotations: `readOnlyHint:false`, `destructiveHint:false`,
`idempotentHint:false`, `openWorldHint:true` (work runs against external model
APIs; nothing is ever modified or deleted).

| Tool | Title | Input | Returns |
|---|---|---|---|
| `forge_free` | Generate a 3D model from text | `prompt`, `tier?` | GLB model |
| `text_to_avatar` | Generate a 3D avatar | `prompt?` / `image_url?` | GLB avatar |
| `mesh_forge` | Generate a 3D mesh (art-directed) | `prompt?` / `image_url?` | GLB mesh |
| `rig_mesh` | Rig a 3D model for animation | `glb_url` | rigged GLB |
| `forge_avatar` | Generate a rigged, animation-ready avatar | `prompt?` / `image_url?`, `allow_non_humanoid?` | rigged GLB avatar |
| `refine_model` | Refine a 3D model by describing a change | `glb_url`, `instruction`, `parent_prompt?`, `parent_lineage?`, `parent_index?` | refined GLB + version lineage |

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
  "prompt": "a friendly round robot mascot, glossy white plastic"
}
```

`arUrl` is the one-tap place-in-your-room link (see [AR in ChatGPT](./chatgpt-ar.md)).
Rigged avatars additionally carry `irlUrl`, the living-agent handoff into
[IRL](./irl.md), and the inline widget's AR button becomes **Bring it to life**.
Every result also includes a `spatial` field, the open Spatial MCP artifact
(`specs/SPATIAL_MCP.md`) so any Spatial-MCP renderer can display the model.

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
| `persona_say` | Speak a reply — lip-sync + emotion + gesture | `persona_id`, `text`, `emotion?` | the body performing the reply |

Annotations: `create_agent_persona` and `persona_say` are writes
(`readOnlyHint:false`); `get_agent_persona` is a pure read (`readOnlyHint:true`).

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
cost, so the ChatGPT user pays nothing. Every tool routes through a **free lane**
(NVIDIA NIM text→3D, Hugging Face Spaces image→3D) — the studio never selects the
paid Replicate backend — so the platform's marginal cost per generation is zero.
The endpoint still enforces real per-IP abuse protection (`api/_lib/rate-limit.js`):

- **Burst:** 4 generations / minute / IP
- **Hourly:** 30 generations / hour / IP
- **Transport:** 300 requests / minute / IP (discovery, never throttled by the
  generation quota)

Because the lanes are zero-cost, these caps **fail open** if the rate-limiter
backend has an outage — a Redis blip must never dead-end a free feature (the same
posture as the paid server's own free lane). They enforce normally whenever the
backend is healthy, and any accidental paid-lane spend is still fail-closed one
layer down in `/api/forge`.

## Safety

Generation prompts are screened for age-13+ appropriateness before any provider
work (`api/_mcp-studio/safety.js`): sexual/adult, child-sexual, graphically
violent, hateful/extremist, and real-weapon/drug prompts are refused with a
clear message. Stylized fantasy props (a sword, a wand) are allowed.

## Environment

All optional — sensible production defaults:

| Var | Default | Purpose |
|---|---|---|
| `STUDIO_API_BASE` | request origin → `PUBLIC_APP_ORIGIN` → `https://three.ws` | Origin to call `/api/forge` on |
| `STUDIO_FORGE_TIMEOUT_MS` | `180000` | Generation poll budget |
| `STUDIO_RIG_TIMEOUT_MS` | `180000` | Rig poll budget |
| `STUDIO_POLL_MS` | `3000` | Poll interval |
