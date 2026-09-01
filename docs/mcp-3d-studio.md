# three.ws 3D Studio — MCP server

Turn text or an image into an interactive, **animation-ready** 3D model — and rig,
animate, pose, edit, retexture, and analyze it — directly from Claude, Cursor,
watsonx Orchestrate, or any MCP client. A focused companion to the main three.ws
MCP server, registered separately as **`io.github.nirholas/threews-3d-studio`**.

- **Endpoint:** `https://three.ws/api/mcp-3d`
- **Transport:** Streamable HTTP (MCP `2025-06-18`, JSON-RPC 2.0)
- **Auth:** OAuth 2.1 (same three.ws authorization server as `/api/mcp`) or x402
- **Backends:** Microsoft TRELLIS image→3D + FLUX text→image (Replicate, platform-keyed); Meshy / Tripo native geometry (BYOK); Make-It-Animatable auto-rig (self-hosted GPU worker); IBM Granite (watsonx.ai) for prompt direction + material generation

## The pipeline

The tools compose into one flow — each step's output feeds the next:

```
direct_prompt ─▶ text_to_3d ─┐
                image_to_3d ─┴▶ generation_status ─▶ auto_rig_model ─▶ apply_animation
                                                                   └─▶ pose_model
mesh ops: remesh_model · stylize_model · segment_model · retexture_model · retexture_region · generate_material
analyze:  inspect_model · optimize_model        preview:  preview_3d
```

> "Optimize this idea, generate it, rig it, and make it wave." → `direct_prompt`
> → `text_to_3d` → poll `generation_status` → `auto_rig_model` → poll →
> `apply_animation(animation: "wave")`.

## Tools

### Generate

| Tool                                                                      | What it does                                                                                                                                                    |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text_to_3d(prompt, aspect_ratio?, tier?, path?, backend?)`               | Text → reference image → reconstructed GLB. Returns a `job_id` + the intermediate preview image.                                                                |
| `image_to_3d(image_url \| image_urls[], prompt?, tier?, path?, backend?)` | Reconstruct a GLB from 1–4 reference views (multi-view removes back-of-object hallucination). Returns a `job_id`.                                               |
| `generation_status(job_id)`                                               | Poll any job. When done, returns the GLB URL **and** an inline `<model-viewer>` artifact. Provider-aware: routes geometry/self-host jobs to the right upstream. |

### Rig, animate & pose

| Tool                                                     | What it does                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `auto_rig_model(glb_url)`                                | Add a Mixamo-named humanoid skeleton, per-vertex skin weights, and ARKit expression blendshapes to a static GLB (Make-It-Animatable). Returns a `job_id`; poll for the rigged GLB. |
| `list_animations(category?)`                             | The curated, retargetable animation-clip catalogue (names, categories, loop flags).                                                  |
| `animation_signature(clip, slot?)`                       | A clip's measured motion: energy, tempo, leading region, loop seam, travel. Pass `slot` for an ok/warn fit verdict against a runtime slot. |
| `find_similar_animations(clip, limit?)`                  | The library ranked by measured-motion distance from a reference clip: "more like this" for animations.                              |
| `apply_animation(model_url, animation, format?, speed?)` | Retarget a preset clip onto a rigged GLB — returns the retargeted `AnimationClip` JSON (or a baked animated GLB).                    |
| `pose_model(prompt)`                                     | Map a pose description to a deterministic seed + full Euler joint-rotation map from the in-repo preset library. Deterministic: the same prompt always returns the same seed. Priced at $0.01 (see the table below). |

### Edit & process the mesh

| Tool                                                                | What it does                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `remesh_model(mesh_url, operation?, target_faces?, output_format?)` | Repair, simplify (quadric decimation), or convert format (incl. FBX with skeleton for Unity/Unreal). |
| `stylize_model(mesh_url, style?, resolution?, output_format?)`      | One-pass geometric restyle: `voxel`, `brick` (LEGO-like), `voronoi` lattice, `lowpoly`.              |
| `segment_model(mesh_url, method?, max_parts?, …)`                   | Split into named, separable parts (each a node) + a parts manifest.                                  |
| `retexture_model(mesh_url, prompt, num_views?, texture_size?)`      | Paint a fresh texture from a prompt (SDXL + ControlNet depth, multi-view back-projection).           |
| `retexture_region(mesh_url, mask_url, prompt?, color?, …)`          | Magic-brush: repaint only a masked UV region, feathering the seam.                                   |
| `generate_material(description, name?)`                             | IBM Granite → a glTF 2.0 PBR material (base color, metallic, roughness, emissive).                   |

### Assist, analyze & preview

| Tool                          | What it does                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `direct_prompt(idea, style?)` | IBM Granite rewrites a vague/multi-subject idea into one optimized single-subject `text_to_3d` prompt + structured directives. |
| `inspect_model(url)`          | Structural stats: meshes, triangles, materials, textures, animations, extensions.                                              |
| `optimize_model(url)`         | Actionable size/perf suggestions: Draco/Meshopt, KTX2, triangle budget.                                                        |
| `preview_3d(glb_url, …)`      | Render any public GLB as an interactive `<model-viewer>` artifact (orbit, AR, auto-rotate).                                    |
| `export_ar(glb_url, title?, kind?)` | Read-only: turn any public GLB into the device-aware AR link set (`arLaunchUrl`, `sceneViewerUrl`, `viewerUrl`, plus `irlUrl` when `kind: "avatar"`) and a [Spatial MCP](./spatial-mcp.md) artifact. Free. See [AR & WebXR](./ar.md#one-tap-ar-for-any-glb--get-apiar--export_ar). |
| `x402_preflight(origin, network?)` | Read-only, free: fetch an x402 seller's signed payability attestation from `<origin>/.well-known/x402-preflight`, verify its ed25519 signature, expiry, and subject, and answer whether that seller can actually settle before you pay it. An attestation that does not verify is reported as unverified, never as health. Spec: [`specs/x402-preflight.md`](../specs/x402-preflight.md). |

Generation, rigging, and most mesh ops are **asynchronous**: the tool returns a
`job_id` immediately, then you poll `generation_status` (reconstruction is
typically 30–90s; rigging 30–90s; texture jobs 2–5 min). When a job finishes,
`generation_status` returns a `text/html` resource — display it as an inline 3D
artifact.

## Embodied on-chain identity

Every persona minted with `create_agent_persona` (see the
[free studio's embodiment tools](./mcp-studio.md#embodiment--a-living-agent-body)
— the persona lifecycle is shared, only the identity layer below is paid-track)
carries a real, deterministic Solana wallet: the **avatar IS the wallet**. The
same `persona_id` always re-derives the same address — no private key is ever
stored anywhere, and none is ever returned in a tool response or written to a
log (see [`api/_lib/persona-wallet.js`](../api/_lib/persona-wallet.js) for the
derivation scheme).

| Tool                                              | What it does                                                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persona_identity(persona_id, network?)`           | Read-only: wallet address, live SOL/USDC balance, ERC-8004-style reputation, token holdings, a resolved SNS nameplate, and the visual tiers below.    |
| `persona_tip(persona_id, to, usdc, session_id?, memo?, network?, confirm?)`  | Send a small USDC tip from the persona's own wallet. Real, irreversible on-chain settlement.                                       |
| `persona_send(persona_id, to, usdc, session_id?, memo?, network?, confirm?)` | The general-purpose USDC send from the persona's own wallet. Same guardrails as `persona_tip`.                                     |

**Guardrails** (env-tunable — `PERSONA_MAX_TIP_USDC`, `PERSONA_MAX_SESSION_USDC`, `PERSONA_CONFIRM_ABOVE_USDC`):

- **Per-call cap** — $1 USDC by default. An amount over the cap is rejected
  with `over_call_cap` before any signature is built.
- **Per-session cap** — $5 USDC cumulative by default, tracked durably
  (Postgres in production, a local JSON ledger in dev) against the caller's
  `session_id` (or a persona+UTC-day bucket when omitted).
- **Confirmation threshold** — $0.25 USDC by default. Above it, the call must
  carry `confirm: true` or it returns `confirmation_required`.

Settlement rides the same MEV-aware execution engine every other outbound
transfer on the platform uses — no mocked transfer, ever. USDC is the only
settlement asset; any other mint is out of scope for these tools.

**Visual binding.** `persona_identity`'s response (and the live
`GET /api/mcp3d/persona-identity?id=…` feed the embodiment embed polls when
opened with `?wallet=1`) includes a `visual` block —
`reputation_tier`, `holdings_tier`, `muted`, `verified_name` — that the shared
`EmbodimentStage` (`apps-sdk/embodiment/chain-visuals.js`) maps onto the body:
an aura ring colored + intensity-scaled by reputation tier, a cosmetic badge
for the holdings tier, a dimmed "muted" look under a low/zero balance, and a
nameplate for a verified `.sol` name. Every tier — including unranked / none /
unmuted — has a designed mapping, so a fresh, unfunded persona still renders a
real (not blank) identity.

**Identity card.** `persona_identity` also returns an `identity_card` block
(`api/_lib/persona-identity-card.js`) — a pure, verifiable projection of the
same data, in the same spirit as `agent_hire`'s provenance block
(`mcp-server/src/lib/agent-commerce.js#buildProvenance`): wallet, balance,
reputation tier, holdings tier, verified name, muted flag, and a fetch
timestamp.

## Quality tiers & generation paths

`text_to_3d` / `image_to_3d` take three optional axes (see
[`api/_lib/forge-tiers.js`](../api/_lib/forge-tiers.js)):

- **`tier`** — `draft` (~12k poly, fast), `standard` (~30k, default), `high`
  (~200k + PBR, slower). Honoured by poly-aware backends; on the TRELLIS default
  it's recorded as provenance.
- **`path`** — `image` (FLUX→TRELLIS reference-image reconstruction, the
  platform-keyed default) or `geometry` (native text/image→mesh, cleaner
  topology).
- **`backend`** — force a specific engine; defaults to the best for the path.

| Backend     | Path(s)         | Key       | Notes                                |
| ----------- | --------------- | --------- | ------------------------------------ |
| `trellis`   | image           | platform  | Fast default. No poly target.        |
| `meshy`     | geometry, image | **BYOK**  | Native text→geometry, quad topology. |
| `tripo`     | geometry, image | **BYOK**  | Cleanest quad topology.              |
| `hunyuan3d` | image           | self-host | High-poly, image-conditioned (GCP).  |

When no `backend` is named, the resolver walks the free lanes first: the tier's named free engine (the self-hosted TRELLIS worker at `draft` and `standard`, the self-hosted Hunyuan3D worker at `high`), then the per-path fallback chain (self-host TRELLIS, self-host Hunyuan3D, the free HuggingFace Spaces lane, and last the free NVIDIA NIM TRELLIS lane, which is text-only). The paid Replicate `trellis` lane is the standing default only when no free lane is live on the deployment. Lane health is consulted, so a cold or down free worker is skipped for the next healthy one before submit.

**BYOK note:** the geometry backends (Meshy/Tripo) have no platform key. Supply
your own via the `x-forge-provider-key` request header (or a key stored on your
three.ws account). Without one, the geometry path returns a designed `needs_key`
result and the **image path still works keyless**. The job handle for a geometry
job is an opaque forge token; `generation_status` decodes it and re-resolves the
key per poll.

## Access & pricing

Discovery is free for everyone: `initialize`, `tools/list`, `ping`, and the
`getting_started` tool answer with no credentials, so any agent or crawler can
read the catalog before deciding to pay.

For tool calls there are two lanes:

- **OAuth (three.ws account)** — operator-funded. Sign in once and every studio
  tool runs at no per-call charge, bounded by rate limits.
- **x402 (pay per call, no account)** — send a USDC payment (Base or Solana
  mainnet) with the request. The 402 challenge quotes the exact price of the
  tools you're calling; batches are priced as the sum of their calls. Same
  numbers as `POST /api/x402/forge`, single source: `api/_mcp3d/pricing.js`.

| Tool                                       | Price (USDC)                              |
| ------------------------------------------ | ----------------------------------------- |
| `text_to_3d` / `image_to_3d`               | by tier — $0.05 draft / $0.15 standard / $0.50 high |
| `auto_rig_model`, `retexture_model`, `retexture_region` | $0.05                       |
| `stylize_model`, `remesh_model`, `segment_model`         | $0.02                       |
| `capture_scene`, `anchor_provenance`                    | $0.05                                     |
| `remove_background`, `pose_model`, `apply_animation`, `direct_prompt`, `generate_material` | $0.01 |
| `generation_status`, `preview_3d`, `list_animations`, `animation_signature`, `find_similar_animations`, `text_to_animation`, `inspect_model`, `optimize_model`, `save_avatar`, `export_ar`, `verify_provenance`, `x402_preflight`, the persona tools, `validate_spatial_response`, `getting_started` | free |

Payment settles only after the work succeeds — a wholesale failure costs
nothing, and the same signed payment cannot be replayed.

## IBM Granite tools

`direct_prompt` and `generate_material` call IBM Granite foundation models via
watsonx.ai. They're **operator-funded**: set `WATSONX_API_KEY` and
`WATSONX_PROJECT_ID` on the server and end users pay nothing extra for them — no
IBM Cloud account required on the caller side. If watsonx isn't configured, both
return a clear "not configured" error rather than failing mid-call.

## Use on claude.ai / watsonx Orchestrate

Add the connector with URL `https://three.ws/api/mcp-3d` and complete the OAuth
flow (or connect it from the watsonx Orchestrate MCP catalog). Then:

> "Make a 3D model of a low-poly red fox sitting upright, rig it, and make it idle."

The assistant calls `text_to_3d`, polls `generation_status`, renders the result
as a live orbitable artifact, then `auto_rig_model` → `apply_animation(animation:
"idle")` for a moving character.

## Configuration

| Env                                                 | Purpose                                                                               | Default                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------- |
| `REPLICATE_API_TOKEN`                               | Required. Powers reconstruction, rigging, remesh, retexture.                          | —                                |
| `REPLICATE_RECONSTRUCT_MODEL`                       | image→3D model.                                                                       | `firtoz/trellis`                 |
| `REPLICATE_TXT2IMG_MODEL`                           | text→image model for `text_to_3d`.                                                    | `black-forest-labs/flux-schnell` |
| `REPLICATE_RERIG_MODEL`                             | Auto-rig model. Without it, `auto_rig_model` reports "not configured".                | —                                |
| `GCP_RECONSTRUCTION_URL` / `GCP_RECONSTRUCTION_KEY` | Optional self-host backend (Hunyuan3D, masked region retexture).                      | —                                |
| `WATSONX_API_KEY` / `WATSONX_PROJECT_ID`            | Enable `direct_prompt` + `generate_material`.                                         | —                                |
| `APP_ORIGIN`                                        | Origin used to load the animation manifest for `list_animations` / `apply_animation`. | request host                     |
| `MCP_POSE_PREVIEW_BASE`                             | Base URL for `pose_model` preview links.                                              | `https://three.ws/pose`          |

Geometry backends (Meshy/Tripo) take a **per-request** key via the
`x-forge-provider-key` header — never an env var.

Rate limits: generation/rig/mesh jobs are capped per principal (real GPU spend);
status polling is capped per minute. `pose_model`, `list_animations`,
`inspect_model`, and `optimize_model` are lightweight.

## Publishing to the MCP Registry

The manifest is [`server-3d.json`](../server-3d.json). Publish with the
`mcp-publisher` CLI (the GitHub-namespace ownership flow proves control of the
`io.github.nirholas/*` namespace):

```bash
mcp-publisher login github
mcp-publisher publish --file server-3d.json
```

## Local development

```bash
npm run dev
npx @modelcontextprotocol/inspector http://localhost:3000/api/mcp-3d
```
