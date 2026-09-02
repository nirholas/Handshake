# Agent Identity Studio: a brand brief becomes a 3D identity

Every AI agent deserves a face. The Agent Identity Studio takes an agent's name and a plain-language brand brief and returns a complete visual identity: a rigged, animation-ready GLB avatar, a square profile picture that stays legible at thumbnail size, and a set of posed, studio-lit full-body renders. No manual modelling, no touch-ups, no human in the loop.

Page: [/agent-identities](https://three.ws/agent-identities) (the showcase) · Endpoint: `https://three.ws/api/okx/3d/identity-studio`

> The buyer-facing contract for this service (price, the payment challenge and replay flow, the payment guarantees, the rails it settles on) lives in [OKX.AI Marketplace Services](./okx-marketplace.md#back-burner). This document is the other half: what the pipeline actually does between the brief and the deliverables, what the showcase page renders, and the shape of the job API. Read the marketplace doc first if you are buying; read this one if you are building on it or changing it.

## Why it exists

An agent on a marketplace is a row of text next to an empty avatar slot. Text-to-3D alone does not fix that: a raw generated mesh has no skeleton, so it cannot be posed or animated, and a marketplace avatar slot wants a square crop framed on the face, not a full-body shot shrunk to 128 pixels. The Identity Studio is the whole path in one call: prompt shaping, mesh generation, humanoid auto-rig, pose selection, rendering, cropping, and hosting. What comes back is usable everywhere at once, in the avatar slot, in a three.ws scene, in a game engine, in any glTF runtime.

## What gets generated

One completed job produces:

| Deliverable | Detail |
| --- | --- |
| `pfp.url` | Square PNG, 1024 px, head and shoulders, composited on a studio backdrop |
| `pfp.preview_128_url` | The same crop at 128 px, for thumbnail and avatar slots |
| `full_body[]` | Three 1024x1280 (4:5 portrait) renders, one per pose, same backdrop and lighting |
| `rigged_glb_url` | The avatar with a humanoid skeleton and skin weights |
| `mesh_glb_url` | The unrigged generated mesh, kept so a rig hiccup never loses the generation |
| `viewer_url` | Deep link into the three.ws [viewer](./viewer.md) for the rigged GLB |
| `pose_studio_url` | Deep link into the [Animation Studio](./animation-studio.md) for the rigged GLB |

Every render is persisted to object storage under `okx-identity/renders/<job>/` and served from a public URL, so the URLs in the response are permanent and hotlinkable.

## The brief-to-identity flow

The pipeline lives in [`api/_okx3d/identity.js`](../api/_okx3d/identity.js). Every heavy stage runs over the deployed three.ws HTTP surfaces rather than a provider SDK, so the module holds no provider keys and behaves identically inside the API function and in a local script run.

### 1. Shape the brief into a generation prompt

A brand brief is not a visual subject. "A meticulous on-chain accounting agent that reconciles wallets" describes behaviour; a text-to-3D encoder needs a body, an outfit, materials, and a colour palette. So the brief is first rewritten by an LLM art director over the platform's provider chain, instructed to describe a *single* full-body humanoid character in a standing neutral pose on a plain background, always in English regardless of the brief's language, with no scene, no held props, no text or logos.

The director is fail-soft. If no provider answers, or the completion comes back empty or out of range, the pipeline falls back to a deterministic template that leads with the style hints (the actual visual direction) and reduces the brief to its first sentence, handling both Latin and CJK sentence punctuation. It never fabricates a subject, and it never leaves a dangling comma or a half word at a cut. The response reports which path was taken as `directed: true | false`, and always returns the exact `prompt` that was sent.

Two hard limits, both visible in the response:

- A brief longer than 2000 characters is truncated, and every response carries `brief_truncated: true` plus a note.
- The final generation prompt is clamped to 300 characters at a word boundary. This is measured, not guessed: against production generation, prompts around 250 characters generate cleanly while prompts around 430 characters fail.

### 2. Generate the mesh

The shaped prompt goes to the generation lane at `/api/forge` with a 3:4 aspect ratio. A `reference_image_url`, when supplied, is passed as an image input so the look is guided by the picture. The free lane can complete synchronously and hand back the finished GLB in the submit response, in which case the job jumps straight to rigging; asynchronous backends return a job handle to poll.

### 3. Auto-rig to a humanoid skeleton

The generated GLB is submitted to `/api/forge?action=rig`, which adds a humanoid skeleton and skin weights. Unlike the generic avatar service, there is no humanoid gate here: the subject is humanoid by construction, because the prompt shaping forced it. That matters, because an identity brief ("a finance data agent") almost never names a humanoid subject on its own.

### 4. Plan the poses

The render plan is derived deterministically from the job id (a SHA-256 seed), so the same job always renders the same poses, while different jobs vary:

- **The PFP pose is pinned** to `contrapposto`, a neutral standing preset, at a 14 degree camera orbit. The head crop below assumes the top of the model's alpha bounding box is the head, which a raised-arm pose would break.
- **Three full-body poses** are drawn without replacement from a shortlist that reads well as a brand identity: `hands-on-hips`, `relaxed`, `wave`, `salute`, `point`, `fighting-stance`, `walk-step`, `flex`. Their camera orbits are 0, 24, and -18 degrees, so the three shots are visibly different framings rather than the same photo three times.

Every planned pose is validated against the live pose-preset catalogue when the plan is built, so a stale preset id fails loudly in tests instead of returning a 400 from the renderer mid job.

### 5. Render and composite

Each pose is rendered at 1600x1600 with a transparent background through `/api/render/avatar-clip`, then composited locally with `sharp`:

1. Trim the render to the model's alpha bounding box. Every crop calculation keys off those real dimensions, not the canvas.
2. **PFP:** take a square from the top of the trimmed body whose side is 36% of the body height (clamped to the body width so a narrow model is never over-cropped), centre it horizontally, and place it on the backdrop with 8% breathing room so the head does not kiss the frame. Output 1024 px, plus a 128 px resize.
3. **Full body:** scale the trimmed model to fit 82% of the frame width and 90% of its height, and centre it in a 1024x1280 portrait frame.

The backdrop is a brand-neutral dark radial gradient rasterized from inline SVG, so it matches the three.ws dark tokens and no binary asset ships with the code.

## The job model

Job state is a single JSON document in object storage (`okx-identity/jobs/<id>.json`). The lifecycle is deliberately poll-driven:

- `create_identity` validates the input, submits generation, and returns a signed job token. Validation, including fetching a supplied `reference_image_url`, happens **before** the transport settles the payment.
- Each free `identity_status` poll advances the job by exactly **one bounded step**: a single upstream poll, or one render. No request outlives its function budget, and polling is what drives the job forward. Poll roughly every 5 seconds; typical time to `done` is 3 to 6 minutes.
- Stages run in order: `generate`, `rig`, `render`, `done` (or `failed`).

Failure handling is built around one principle: the buyer pays for deliverables, not for transient upstream weather.

- A failed `generate` or `rig` stage clears its job handle and **retries free** on the next poll, up to 3 total attempts. A failed render re-runs the same render on the next poll (the cursor does not move).
- Backpressure is not failure. A rate-limited upstream consumes no retry attempt: the job parks until `retry_after` elapses (default 30 seconds, capped at 5 minutes) and a later poll resubmits.
- A `not_configured` error (the lane itself is down) is terminal, and so is an exhausted retry budget. Either way `status` becomes `failed` and `last_error` carries the last actionable message.

The reference image is fetched through the platform's SSRF guard with a pinned host and a byte cap, so a validated hostname cannot redirect to an internal address, and a host that ignores the range request cannot stream an unbounded body.

## The API

The endpoint is an A2MCP service: MCP Streamable HTTP, JSON-RPC `tools/call` over `POST`, with `GET` serving the discovery challenge and `DELETE` terminating a session. Three tools:

| Tool | Price | What it does |
| --- | --- | --- |
| `getting_started` | free | Server overview: tools, prices, access rules, links |
| `create_identity` | $1.50 | Accepts the job. Arguments: `agent_name` (required, up to 80 chars), `brief` (required), `style_hints`, `reference_image_url` |
| `identity_status` | free | Advances the job one step and reports progress or deliverables |

`create_identity` returns immediately with the job handle:

```json
{
  "ok": true,
  "job_id": "<signed job token>",
  "status": "running",
  "stage": "generate",
  "eta_seconds": 300,
  "poll_tool": "identity_status",
  "brief_truncated": false
}
```

`identity_status` is free, unauthenticated, and needs nothing but the job token (which is HMAC-signed, so it is the only capability required to read a job). The token carries no
expiry, and the job document lives in object storage, so a handle stays pollable. While
running:

```json
{
  "job_id": "<signed job token>",
  "status": "running",
  "stage": "render",
  "progress": { "steps": ["generate", "rig", "render", "done"], "renders_done": 2, "renders_total": 4 },
  "brief_truncated": false,
  "prompt": "<the exact prompt sent to the generator>",
  "directed": true
}
```

When `status` is `"done"`, the same body carries a `deliverables` object with the fields in the table above. When `status` is `"failed"`, it carries `last_error` as `{ stage, code, message, retrying }`.

Two free companion endpoints round out the surface: `GET /api/okx/3d/catalog` is the machine-readable service index, and `GET /api/okx/3d/health` probes every subsystem a paid identity job passes through (generation, renderer, storage, the animation clip lane, and the payment rail) with real requests rather than a static `ok`. Both are documented in [OKX.AI Marketplace Services](./okx-marketplace.md#free-discovery-lane).

### The showcase feed

`GET /api/agent-identities` ([`api/agent-identities.js`](../api/agent-identities.js)) is a third free, public, unauthenticated endpoint: the finished work, so a buyer can see what $1.50 actually returns before spending it. It merges the demo runs in `data/agent-identities.json` with the live catalog row for `identity-studio`, so the price it quotes is the price the paid endpoint charges.

```bash
curl -s https://three.ws/api/agent-identities | jq '.service.priceUsd, .count, .identities[0].agentName'
```

```json
{
  "service": {
    "id": "identity-studio",
    "name": "Agent Identity Studio",
    "priceUsd": "1.50",
    "currency": "USDC",
    "endpoint": "https://three.ws/api/okx/3d/identity-studio",
    "tool": "create_identity",
    "docs": "https://three.ws/docs/okx-marketplace",
    "catalog": "https://three.ws/api/okx/3d/catalog"
  },
  "count": 4,
  "ready": 4,
  "identities": [
    {
      "slug": "ledgerlynx",
      "agentName": "LedgerLynx",
      "kind": "finance data agent",
      "brief": "A meticulous on-chain accounting agent…",
      "styleHints": "deep navy and silver palette…",
      "status": "ready",
      "pfp": { "url": "…/pfp-1024.png", "previewUrl": "…/pfp-128.png", "pose": "contrapposto" },
      "fullBody": [{ "url": "…/fullbody-1-walk-step.png", "pose": "walk-step", "width": 1024, "height": 1280 }],
      "riggedGlbUrl": "…glb",
      "viewerUrl": "https://three.ws/viewer?src=…",
      "poseStudioUrl": "https://three.ws/pose?src=…",
      "backend": "trellis_selfhost",
      "rigged": true,
      "joints": 52,
      "durationSeconds": 501,
      "completedAt": "2026-07-09T23:45:26.807Z"
    }
  ]
}
```

`status` is `ready` or `pending`: an entry whose pipeline run has not completed carries the brief but no deliverables, and the showcase page renders it as such rather than guessing from a missing field. Responses are cached at the edge for 10 minutes.

Prices, descriptions, and input schemas are not written twice: [`api/_lib/okx-catalog.js`](../api/_lib/okx-catalog.js) is the single source of truth that the tool definitions, the catalog endpoint, and the marketplace listing all read.

## The showcase page

[/agent-identities](https://three.ws/agent-identities) renders the demo identities in [`data/agent-identities.json`](../data/agent-identities.json). Every entry there is a **real run of the production pipeline**, the same module the endpoint executes, driven locally by [`scripts/okx-identity-demo.mjs`](../scripts/okx-identity-demo.mjs), which writes the results back into the JSON file. Nothing on that page is a mock or a hand-picked asset.

The page reads that data over the network from `/api/agent-identities` (above) rather than inlining it at build time, which buys three things: a fresh demo run is live as soon as the data lands instead of at the next frontend build, the price chip in the hero comes from the catalog instead of page copy that can drift, and the grid has a real loading, error, and empty state to design for. While the feed is in flight the grid shows shimmering skeleton cards; a failed fetch renders an actionable panel with a working retry (the docs and catalog links stay reachable because they are static); an empty feed says so and points at the service instead of leaving a void.

The script does not take the pipeline's word for it either. It downloads the finished GLB, parses its JSON chunk, and asserts real rigging: at least one skin, at least 10 joints in total, and at least one mesh primitive carrying both `JOINTS_0` and `WEIGHTS_0`. A run that fails that check is recorded as failed rather than shipped as a success. The verified numbers (byte size, skins, joints, skinned primitives, glTF generator) are stored per identity alongside the wall-clock duration and completion timestamp.

Each card ([`src/agent-identities.js`](../src/agent-identities.js)) shows the full-body hero shot with the PFP crop pinned over it, thumbnail buttons to switch poses (with `aria-pressed` tracking the active one), a verified-rig line (joint count, pipeline duration, render count), and a "View in 3D" action that lazy-loads `model-viewer` and swaps the still for the orbitable rigged GLB. The 3D runtime is only fetched when someone asks for it, never on page load. "View in 3D" is a real toggle: it turns into "Back to renders" and restores the still, and switching poses closes the viewer too, so the button label and the stage can never disagree. The GLB is a large network fetch, so the viewer shows a spinner until `model-viewer` reports `load` and falls back to a link into the full viewer if it errors. An entry without a completed run renders an honest "still in the studio" state instead of a broken card, and a render whose object 404s is replaced by a labelled notice rather than a broken-image glyph.

To regenerate or add a demo identity, add the entry (slug, kind, agent name, brief, style hints) and run the script. It needs the object-storage credentials from your local env; generation, rigging, and rendering all run against the deployed surfaces.

```bash
# One identity by slug, or every entry with no result yet.
node --env-file=.env.local scripts/okx-identity-demo.mjs ledgerlynx

# Re-run an entry that already has a result.
node --env-file=.env.local scripts/okx-identity-demo.mjs ledgerlynx --force
```

Two environment overrides help a batch run outlast the rig lane's rate-limit backoff windows: `IDENTITY_DEMO_POLL_MS` (default 5000) and `IDENTITY_DEMO_TIMEOUT_MS` (default 15 minutes).

## Related

- [OKX.AI Marketplace Services](./okx-marketplace.md): the price, the payment challenge, the replay flow, the payment guarantees, and the decomposed single-capability 3D services that share these engines.
- [Forge](./forge.md): the text and image to GLB generation pipeline this studio calls for the mesh and the auto-rig.
- [Animation Studio](./animation-studio.md): the `/pose` surface the `pose_studio_url` deep link opens.
- [Viewer](./viewer.md): the `/viewer` surface the `viewer_url` deep link opens.
- [MCP servers](./mcp.md): the wider set of three.ws MCP endpoints this one follows the transport conventions of.
- [Avatar Engines Atlas](./avatar-engines.md): what engine families exist for building human avatars, and which of them are wired into the commercial pipeline.
- [Draft agent mint](./draft-agent-mint.md): the inactive on-chain identity minted for every finished reconstruction, Solana first with ERC-8004 alongside it.
