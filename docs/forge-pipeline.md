# The Forge pipeline: architecture deep dive

This is the engineering guide to the Forge, the text/image/sketch to 3D generation system behind [/forge](https://three.ws/forge), the free MCP tools, and every agent-facing 3D endpoint. It maps the whole path a generation takes: entry points, the engine grid, free-first routing, the job lifecycle, failover, persistence, GPU workers, post-processing, and payments.

If you want the product-level overview, read [Forge](./forge.md). If you want the plain-language version, read [How the Forge works](./how-forge-works.md). This document is for people changing the pipeline.

## Bird's-eye view

```
  /forge page          MCP tools            x402 buyers        SDK / agents
  home mini-forge      (paid stdio +        /api/x402/forge    /api/3d/generate
  /forge-studio         free hosted)                           /api/v1/ai/text-to-3d
        │                    │                    │                  │
        └────────────────────┴──────────┬─────────┴──────────────────┘
                                        ▼
                          POST /api/forge  (api/forge.js, the orchestrator)
                                        │
                    resolve (path, tier, backend) via api/_lib/forge-tiers.js
                    health-aware free-first routing + circuit breakers
                                        │
              ┌─────────────┬───────────┼───────────────┬──────────────┐
              ▼             ▼           ▼               ▼              ▼
        NVIDIA NIM     HF Spaces   self-host GPU    BYOK vendors   Replicate
        (TRELLIS,      (Hunyuan3D  workers on       (Meshy, Tripo, (paid last
        text only)     chain)      Cloud Run        Rodin, ...)    resort)
              │             │           │               │              │
              └─────────────┴───────────┼───────────────┴──────────────┘
                                        ▼
              job handle (HMAC token) ── poll GET /api/forge?job=<id>
              poll-time failover (forge-failover.js) if a lane dies mid-job
                                        │
                                        ▼
              forge_creations row (Neon Postgres) + GLB mirrored to R2 CDN
                                        │
                                        ▼
              viewer / AR / rig / refine / restyle / remesh / gallery / remix
```

Three properties define the design:

1. **One orchestrator, many front doors.** Every entry point is a thin client over `POST /api/forge` and `GET /api/forge?job=<id>`. No generation logic is duplicated.
2. **Free-first routing over a declared engine grid.** Engines are data, not code paths: each is a registry entry declaring what it can do, what it costs, and what env it needs. Routing walks that registry.
3. **Failure is a routing event, not an error.** A rejected submit walks to the next lane at submit time; a lane that accepts and then dies is silently re-dispatched at poll time. The client sees the same job id throughout.

## 1. Entry points

| Surface | Route / tool | Notes |
| --- | --- | --- |
| Forge page | [/forge](https://three.ws/forge), `src/forge.js` | Text, photos (up to 6 views), sketch. One shared polling loop. `/forge-max` deep-links straight into the maximum-quality lane. |
| Homepage mini-forge | `src/home-forge.js` | Health-aware default lane, never pins a backend. |
| Forge Studio | [/forge-studio](https://three.ws/forge-studio), `src/forge-studio/` | Create, refine, stylize, Game-Ready export, remix. |
| Core API | `POST /api/forge` (`api/forge.js`) | The orchestrator. Auth-free. Text, image, and sketch bodies. |
| Job poll | `GET /api/forge?job=<id>` | Free to poll regardless of how the job was paid for. |
| Catalog | `GET /api/forge?catalog=1` | The tier/backend/cost matrix the UI renders. |
| Health | `GET /api/forge?health=1` | Live per-lane upstream status. |
| Rig | `POST /api/forge?action=rig` | Auto-rig a finished GLB (see post-processing). |
| Paid x402 twin | `POST /api/x402/forge` (`api/x402/forge.js`) | Pay-per-call USDC on Solana, no account. Prices come from the tier table. |
| Agent REST | `POST /api/3d/generate` (`api/3d/generate.js`) | Keyless agent shape wrapping the free draft lane. |
| Flagship free API | `POST /api/v1/ai/text-to-3d` (`api/v1/ai/text-to-3d.js`) | NVIDIA NIM TRELLIS draft lane, 10 generations per IP per day, 429 + x402 upsell above quota. |
| Refinement | `POST /api/forge-iterate` (`api/forge-iterate.js`) | Conversational refinement with version lineage for the signed-in Studio. |
| MCP (paid stdio) | `mesh_forge`, `forge_avatar`, `forge_free`, `text_to_avatar`, `rig_mesh`, `refine_model`, `restyle_material` (`mcp-server/src/tools/`) | Shared cores in `mcp-server/src/tools/_studio-core.js`; thin clients over `/api/forge`. |
| ChatGPT clone | `POST /api/gpt-forge` (`api/gpt-forge.js`) | Clone of the orchestrator dedicated to the ChatGPT surfaces (the Apps SDK MCP connector `api/mcp-studio` and the custom-GPT Actions endpoint `api/3d/studio`, via `api/_mcp-studio/gpt-forge-client.js`), so the ChatGPT pipeline can evolve without touching `/api/forge`. Same lanes, tiers, job tokens, and `forge_creations` rows. First divergence: its poll responses also carry `prompt`, `preview_image_url` (the painted concept view), and `text_to_image_model`, so the ChatGPT surfaces can show the concept image while the mesh generates. It also remembers a finished job's poll frame (`api/_lib/forge-done-cache.js`), so later polls of a done job answer in milliseconds without re-reading the provider. |
| MCP (hosted HTTP) | `text_to_3d`, `image_to_3d`, `auto_rig_model`, plus the wider studio toolset (`generation_status`, `preview_3d`, `remove_background`, `remesh_model`, `stylize_model`, `segment_model`, `retexture_model`, `pose_model`, `save_avatar`, persona tools; `api/mcp-3d.js`, tools in `api/_mcp3d/tools/studio.js`) | Streamable HTTP server registered as `io.github.nirholas/three-ws-3d-studio`. |
| DCC plugins | `integrations/blender/`, `integrations/comfyui/`, `integrations/_pyclient/` | First-party clients driving the same API. |

The rule when adding a surface: never talk to a provider directly. Submit through `/api/forge` (or the shared MCP cores) so routing, failover, persistence, and payments stay in one place.

## 2. The request axes: path and tier

Every request resolves to a `(path, tier, backend)` triple. `api/_lib/forge-tiers.js` is the single source of truth for all three; the endpoint, the catalog, the x402 pricing, and every provider param builder read from it.

**`path`** is how geometry is produced:

- `image`: image-intermediate, the default. Text is painted into a reference view (FLUX/Imagen) and reconstructed to a mesh, or the user's own photos are reconstructed directly.
- `geometry`: geometry-first. A native 3D model (Meshy, Tripo, Rodin) emits mesh directly from the prompt, so detail is not capped by what one synthesized image implies.
- `sketch`: sketch-conditioned. A drawing plus a prompt naming what it depicts drives TripoSG-scribble straight to geometry.

**`tier`** is how much budget to spend (`TIERS` in forge-tiers.js):

| Tier | Poly target | Textures | ETA multiplier | Price (USDC atomics) |
| --- | --- | --- | --- | --- |
| `draft` | 12,000 | none | 0.6 | 50,000 ($0.05) |
| `standard` | 30,000 | 2K | 1.0 | 150,000 ($0.15) |
| `high` | 200,000 | PBR + HD | 2.2 | 500,000 ($0.50) |

Prices live only here, as `priceUsdcAtomics`. `priceAtomicsForTier()` feeds the x402 402 challenge; `priceUsdcForTier()` feeds the catalog and docs. Never hardcode a second copy.

Self-hosted TRELLIS additionally maps tiers to sampler and texture budgets via `SELFHOST_TRELLIS_QUALITY` (draft: 12/12 steps, 1024px textures; standard: 35/35, 2048px; high: 50/50, 4096px). Texture sizes must be powers of two: nvdiffrast hard-fails on mip generation otherwise (live incident, 2026-07-16).

## 3. The engine grid

`BACKENDS` in `api/_lib/forge-tiers.js` declares every lane. Each entry names the `provider` client (`api/_providers/*.js`), which `paths` it serves, whether it is `free`, whether it needs a BYOK key, the env vars that must be present (`requiresEnv`), and its latency estimate (`baseEta`, plus `coldStart` for scale-to-zero workers).

| id | Engine | Hosting | Paths | Cost model | Env |
| --- | --- | --- | --- | --- | --- |
| `nvidia` | Microsoft TRELLIS | NVIDIA NIM (hosted) | image (text only, rejects user photos) | free | `NVIDIA_API_KEY` |
| `huggingface` | Hunyuan3D 2.1 → Hunyuan3D 2 → TRELLIS → TripoSR (internal chain) | HF Spaces | image | free, blocking submit | `HF_TOKEN` |
| `trellis_selfhost` | Microsoft TRELLIS | Our Cloud Run L4 worker (`workers/model-trellis/`) | image (native single-hop image to 3D) | free (our GPU) | `MODEL_TRELLIS_URL` + `GCP_RECONSTRUCTION_KEY` |
| `hunyuan3d` | Tencent Hunyuan3D-2.1 | Our Cloud Run L4 worker (`workers/model-hunyuan3d/`) | image | free (our GPU) | `GCP_HUNYUAN3D_URL` + key |
| `triposg` | VAST AI TripoSG-scribble | Our Cloud Run L4 worker (`workers/model-triposg/`) | sketch only | free (our GPU) | `GCP_TRIPOSG_URL` + key |
| `trellis` | Microsoft TRELLIS | Replicate | image | paid platform, last resort | `REPLICATE_API_TOKEN` |
| `meshy` | Meshy 6 | vendor API | geometry, image | BYOK, credits | user key |
| `tripo` | Tripo v3.1 | vendor API | geometry, image | BYOK | user key |
| `rodin` | Rodin (Hyper3D) | vendor API | geometry, image | BYOK | user key |
| `stability` | Stable Fast 3D | vendor API | image, synchronous | BYOK | user key |
| `replicate_byok` | Replicate models | caller's Replicate account | image | BYOK | user key |

Two lanes deserve a warning. `hunyuan3d` must point at the general Hunyuan3D worker URL, never at the avatar-pipeline controller: the controller fronts a face pipeline and rejects general object images. And `nvidia` is text-only; every routing list that might carry a user photo filters it out.

## 4. Routing: free-first, subject-aware, health-tempered

Routing answers one question: given `(path, tier, userImages, prompt)`, which configured lane runs first, and who is next when it fails.

**Static preference order.** `freeLaneCandidates()` builds the ordered list both resolvers walk:

1. The tier's named free default (`FREE_DEFAULT_FOR_TIERS`): draft/standard image requests name `trellis_selfhost`; high names `hunyuan3d`. Both are our own GPU workers; NVIDIA NIM is no longer a named default (its text-only, no-reference-image conditioning is the realism hole this table closes) but stays explicitly selectable and remains the final fallthrough in the per-path chain.
2. The per-path free fallback chain (`FREE_FALLBACK_FOR_PATH`). For `image` that is `trellis_selfhost`, `hunyuan3d`, `huggingface`, `nvidia`: our own GPU workers first (zero vendor cost), then external free lanes, with the text-only NIM lane trailing as a safety net.
3. The paid platform default (`DEFAULT_BACKEND_FOR_PATH`: image → `trellis` on Replicate, geometry → `meshy`, sketch → `triposg`) only when nothing free is configured and healthy.

**Subject-aware reorder (high tier).** `classifyForgeSubject()` regex-classifies the prompt as hard-surface or organic. Hard-surface prompts (vehicles, machines, architecture) hoist `trellis_selfhost` above `hunyuan3d`; organic subjects (people, creatures) keep Hunyuan3D first. This exists because the two engines genuinely differ on those subject classes at high fidelity.

**Operator levers.** `FORGE_PREFER_FREE` (default on) prefers free reconstruction before paid Replicate. `FORGE_SELFHOST_PRIMARY` (default off) hoists self-host GPU lanes above hosted free lanes across the board.

**Health tempering.** `resolveBackendIdWithHealth()` walks the candidate list against the snapshot from `api/_lib/forge-lane-health.js`: lanes reporting `ok` or `unknown` are preferred, lanes confirmed `down` are skipped, and paid lanes are considered only when every free lane is down. The UI consumes the same data via `GET /api/forge?health=1` and disables down lanes with the real upstream reason before the user clicks Generate.

**Circuit breakers.** A failing lane is sidelined, not retried in a loop: per-lane cooldowns (`forge-lane:<id>`, 90s) plus dedicated NIM cooldowns (120s model, 30s gateway) short-circuit routing away from a degraded upstream. Cooldowns are shared cross-instance via `api/_lib/provider-health.js` and expire on their own, so a recovered lane is retried promptly. Every entry is env-gated, so partial deployments degrade to a shorter list instead of erroring.

## 5. Job lifecycle

### Submit

`POST /api/forge` validates input, resolves the triple, runs the payment gate if the tier requires one (section 9), inserts a `forge_creations` row (`status: generating`), and submits to the resolved lane. Synchronous lanes (NVIDIA NIM, HF Spaces, BYOK-sync like Stability) complete inside the request and return `status: done` with the GLB URL directly. Async lanes return `status: queued` plus a `job_id`.

**Submit-time failover.** If a lane rejects the submit outright (down, quota, cooldown), `startJob` walks the free-first chain to the next candidate in the same request. The client never sees the rejected lane.

**Reference-image budget.** On the text path the reference-image step (the Vertex lane in `api/_lib/forge-reference-image.js`, its QA score and corrective retry, and the `textToImage` fallthrough ladder, Livepeer included) runs under one shared budget, `TEXT_TO_IMAGE_BUDGET_MS` (default 60 s). A stalled paint provider can no longer hold a submit open for minutes before a job exists; once the budget is spent the caller gets a fast, retryable failure instead.

### The job handle

Async jobs get an opaque HMAC-signed token (`f1.<payload>.<sig>`, `api/_lib/forge-job-token.js`) that records provider, kind, and upstream task id, signed with `JWT_SECRET`. The legacy Replicate path keeps the bare prediction id. Tokens make the poll endpoint stateless: any instance can decode the handle and ask the right upstream.

### Poll

`GET /api/forge?job=<id>` returns `status`: `queued`, `running`, `done` (with `glb_url`, `viewer_url`, and the `path`/`tier`/`backend` that actually produced it), or `failed`. Polling is free and unauthenticated. The in-flight job id is also written to `localStorage`, so an interrupted browser session resumes polling for up to 30 minutes; background completion persists the result to the user's gallery either way (see [Background generation](./forge-background-generation.md)).

**Poll-time failover** (`api/_lib/forge-failover.js`) closes the nastier gap: a self-host worker can accept a task and fail it minutes later, in a poll handled by a different instance that no longer holds the request. On a failed poll the module recovers the original inputs (prompt plus reference image) from the creation row, resubmits to the next configured lane, and binds old handle to new handle in Redis (2 hour TTL). The client keeps polling the same job id and simply sees `status: running` with a new `backend`. Hops are capped by `MAX_FAILOVER_HOPS = 3` (one primary plus up to three backups). The redispatch order is `trellis_selfhost`, `hunyuan3d`, `trellis`: HuggingFace is excluded because its provider blocks through the whole generation (cannot be ridden from a poll), and NVIDIA is excluded because poll-time redispatch always reconstructs from a stored reference image, which NIM rejects. Both failover paths (this attended one and the unattended finalizer sweep) link the failed attempt to its successor row (`forge_creations.superseded_by`, migration `20260814200000_forge_failover_supersede.sql`), so the outcome ledger, the forge health sensor and `npm run forge:errors` count a recovered attempt as a recovery, not a loss.

**Designed terminal failure.** When no successor is possible, the failed response carries `retryable: true` plus `retry_backends: [...]`, the ordered configured lanes a client can one-click resubmit to. A failure is never a bare string. The whole module is fail-open: no Redis disables automatic redispatch but keeps suggestions; no DB disables recovery but never turns a clean failure into a hang.

### Quality, caching, and scale

- **Quality gate + best-of retry.** `scoreQualityGate` flags degenerate results (near-empty geometry, texture failures); synchronous lanes retry once inline before returning.
- **Result cache** (`api/_lib/forge-cache.js`). Identical text prompts on platform-keyed non-high lanes are served from cache with `cached: true`. The key covers path, tier, backend, the normalized prompt, and the output-affecting options (seed included), with a 7-day TTL that a read never refreshes. `force_regenerate: true` in the request body skips the cache READ while still writing the fresh result back. Any caller that must prove the pipeline is alive rather than that a mesh exists has to send it: the daily smoke cron (`api/cron/forge-smoke.js`) submits a constant prompt with no seed, so without the flag its key never changes and it verifies a replay. Automation that seeds the gallery takes the other route and varies the seed per submit (`api/cron/forge-seed-cron.js`), so a repeated prompt yields a genuinely new asset instead of a second catalog entry pointing at one GLB.
- **Scale controls** (`api/_lib/forge-scale.js`). In-flight coalescing, blocking-lane slots, and daily paid caps keep a traffic spike from stampeding the GPU fleet or the paid last resort. Its circuit breaker (`circuitRecordFailure`) widens the open window linearly per consecutive failure but caps it at one hour (`CIRCUIT_MAX_OPEN_MS`), so a provider outage parks the seed cron for at most an hour before it re-probes the lane.

## 6. Persistence and storage

**`forge_creations`** (Neon Postgres, migration `api/_lib/migrations/20260604000000_forge_creations.sql`) is the ground truth for every generation. Key columns:

- Identity and attribution: `id` (uuid), `client_key` (sha256 of the anonymous browser id), `ip_hash`, `user_id`.
- Inputs: `prompt`, `aspect`, `preview_image_url` (the reference view), `text_to_image_model`, `views_requested`/`views_used`/`multiview`.
- Routing outcome: `backend`, `tier`, `path`, `replicate_job_id` (poll correlation for any provider, despite the name), `model_category` (avatar, accessory, item, scene, creature, vehicle, other).
- Result: `glb_key`, `glb_url`, `size_bytes`, `status` (`generating`, `done`, `failed`), `error`.
- Feedback flywheel: `outcome` (`generated`, `accepted`, `rejected`), `rating`, `note`, `downloaded`, `feedback_at`. The outcome partial index feeds training-signal export.
- Lineage and remix (migration `20260625000000_forge_refine_lineage.sql`): `parent_creation_id`, `refine_instruction`, `lineage_index`, `remixable`, `remix_royalty_bps` (0 to 2000, default 1000), `creator_wallet_solana`, `remix_settlement_ref`.
- Forge-Off (migration `20260625120000_forge_board.sql`): `vote_count`, plus the `forge_votes` and `forge_board_winners` tables.
- Failover and cleanup: `superseded_by` (migration `20260814200000_forge_failover_supersede.sql`, the successor row's id when this attempt was re-dispatched; a plain uuid, not a foreign key, so retention pruning stays free) and `source_image_keys` (migration `20260813160000_forge_source_image_keys.sql`, the storage key of every uploaded reference photo, so a delete can erase them).

`api/_lib/forge-store.js` owns all writes: `createCreation` on submit (also records the funnel `start` event), `materializeCreation` on completion, `markFailed`, `markSupersededBy` when a failed attempt is re-dispatched, verdict capture, and `deleteCreation` (behind `DELETE /api/forge-creation?id=`), which removes the mesh, preview and source uploads from storage before the row and is scoped to the owning client key. It is fail-soft: without a DB or storage config it no-ops rather than blocking generation.

**Storage is two-layer.** GPU workers write raw output to GCS (`gs://$GCS_BUCKET/raw-meshes/...`), and provider URLs generally expire within about an hour. `materializeCreation` therefore mirrors the mesh and reference image into Cloudflare R2 (`api/_lib/r2.js`) and stores the durable CDN URL in `glb_url`. Anything user-facing must reference the R2 URL, never the raw provider URL.

## 7. GPU workers

Workers are Python FastAPI services on Cloud Run (scale-to-zero L4 GPUs unless noted), documented worker-by-worker in `workers/README.md`. All share one contract: `POST /infer` returns `{task_id}`, `GET /tasks/:id` returns progress and finally a `result_gcs_url`, authenticated by the shared bearer `GCP_RECONSTRUCTION_KEY`. `api/_providers/gcp.js` maps modes to worker URLs.

| Worker | Role |
| --- | --- |
| `workers/model-trellis/` | Self-hosted TRELLIS, the `trellis_selfhost` lane. Quality-tiered up to 4096px textures. |
| `workers/model-hunyuan3d/` | Hunyuan3D-2.1 single image to textured mesh, the `hunyuan3d` lane. |
| `workers/model-triposg/` | TripoSG 1.5B. `mode: image` for the avatar pool, `mode: scribble` for the sketch path. |
| `workers/model-triposr/` | TripoSR fast path and fallback (5 to 15s). |
| `workers/rig/` | Make-It-Animatable rigging: 52-bone Mixamo skeleton, skin weights, ARKit-52 blendshapes, sub-second GPU predict, grafted into the original GLB bytes. Replaced the retired `workers/unirig/` (2026-07-17); cutover was the `GCP_UNIRIG_URL` env change. |
| `workers/avatar-pipeline-controller/` | CPU orchestrator for the avatar flow: `POST /reconstruct` picks a mesh backend by weighted random, then auto-rigs. |
| `workers/remesh/`, `workers/texture/`, `workers/segment/`, `workers/stylize/`, `workers/rembg/` | Post-processing: retopology and Game-Ready, SDXL retexture, part splitting, geometric stylize, background removal. |

Model weights are staged from `gs://three-ws-model-weights` via `workers/deploy/stage-weights.sh`. Each worker has its own `cloudbuild.yaml`; every config pins the `three-ws-build@` service account.

## 8. Post-processing

- **Rigging.** `POST /api/forge?action=rig` prefers the self-host rig worker and falls back to Replicate; unconfigured deployments return a clean 501. Auto-rig-on-create (`api/_lib/auto-rig.js`) mints a sibling creation row rather than mutating the original (provenance and attestation depend on the original bytes staying put), gated by the humanoid prompt classifier (`mcp-server/src/tools/_humanoid.js`) and `rigInfoIsRigged()` (already-skinned GLBs are skipped).
- **Skeleton canonicalization.** `src/glb-canonicalize.js` maps any humanoid rig's bone names (Mixamo, Avaturn, Unreal, VRM/VRoid, Daz, MakeHuman, MMD/MikuMikuDance with its Japanese bone names, Blender `.L`, and more) onto the canonical bone set, repacking the GLB in place. There is no rig allowlist; a new convention means a new bone-name mapping plus a test case in `tests/glb-canonicalize.test.js`.
- **Animation retargeting.** `src/animation-retarget.js` applies the pre-baked canonical clip library (`public/animations/clips/*.json`) to arbitrary rigs: rewrites track names, drops missing bones, rescales hip translation, and requires 50% bone coverage. Pure JS, shared between the browser and the Node MCP tool.
- **Refinement lineage.** `api/forge-iterate.js` and the MCP `refine_model` tool share one core (`mcp-server/src/tools/_lineage.js`) for composing refinements and maintaining the revertable, branchable version tree over `parent_creation_id` and `lineage_index`.
- **Restyle.** `api/material-studio.js` re-skins a GLB without regenerating the mesh: an LLM proposes PBR factors from an instruction, applied server-side. The paid MCP `restyle_material` is a thin client over it.
- **Mesh operations.** `forge-remesh`, `forge-gameready` (QuadriFlow retopology to a poly budget, GLB plus FBX, $0.10), `forge-stylize`, `forge-segment`, `forge-rembg`. Each is also sold as a standalone x402 stage; see [3D pipeline](./3d-pipeline.md).

## 9. Payments and gating

The pipeline separates what a generation costs us from what it costs the user. Draft and standard route to free lanes; we charge for quality, not to recover vendor bills.

- **Direct x402** (`api/x402/forge.js`): per-tier USDC prices from the tier table, exact-settle on Solana mainnet. The order is verify, submit, settle: a failed submit never charges. The returned job token polls free on the standard endpoint.
- **High-tier gate** (`api/_lib/forge-high-payment.js`): the high tier is $THREE hold-or-pay gated regardless of which free engine serves it. Non-holders pay per generation through the token rail in three phases: `assertForgePayment` validates at the gate, `redeemForgePayment` atomically claims single-use (primary-key race-safe), `releaseForgePayment` undoes the claim if dispatch fails. Settled consumption lands in `token_payments` with `ref_type: 'forge'`.
- **MCP pricing**: the `paid()` wrapper (`mcp-server/src/payments.js`) charges the `priceUsd` each tool module declares at its own call site (`mesh_forge` $0.25, `rig_mesh` $0.20, `forge_avatar` $0.45, `refine_model` $0.25, `text_to_avatar` $0.15, `restyle_material` $0.05, all under `mcp-server/src/tools/`); `forge_free` needs no payment. The hosted MCP server sums per-tool prices for batched x402 challenges.
- **Quota upsell**: the free flagship API allows 10 generations per IP per day, then returns 429 with the x402 endpoint as the paid path.
- **BYOK lanes** bill the caller's own vendor key and are never charged to a platform account.

## 10. Operator reference

The env vars that shape a deployment (production values live on the Cloud Run service, not in any Vercel export):

| Var | Effect |
| --- | --- |
| `NVIDIA_API_KEY` | Enables the free NIM TRELLIS text lane. |
| `HF_TOKEN` | Enables the HF Spaces lane. |
| `MODEL_TRELLIS_URL`, `GCP_HUNYUAN3D_URL`, `GCP_TRIPOSG_URL`, `GCP_UNIRIG_URL`, `GCP_RECONSTRUCTION_URL` | Self-host worker URLs (TRELLIS, Hunyuan3D, sketch, rig, avatar controller). |
| `GCP_RECONSTRUCTION_KEY` | Shared bearer for all self-host workers. |
| `REPLICATE_API_TOKEN` | Enables the paid Replicate last resort. |
| `FORGE_PREFER_FREE` | Default on; prefer free reconstruction before paid Replicate. |
| `FORGE_SELFHOST_PRIMARY` | Default off; hoist self-host lanes above hosted free lanes. |
| `JWT_SECRET` | Signs job handle tokens. |
| `DATABASE_URL`, R2 `S3_*` config | Persistence and durable storage; both fail soft. |
| `LIVEPEER_FEDERATION_ENABLED` | Default off; inserts the federated Livepeer text-to-image lane (`api/_providers/livepeer.js`) into the reference-image chain after the free lanes and before the paid Replicate backstop. See [ops/livepeer-federation.md](./ops/livepeer-federation.md) for the measured state before flipping it. |
| `LIVEPEER_API_KEY`, `LIVEPEER_GATEWAY_URL`, `LIVEPEER_T2I_MODEL` | Studio gateway key (absent today), gateway base-URL override, and pipeline model override (`ByteDance/SDXL-Lightning` default) for the federated lane. |

Fast diagnostics: `forge_creations` carries per-generation backend, status, error, and prompt, so it is the quickest ground truth for generation issues. `GET /api/forge?health=1` shows the live lane picture.

## 11. Extending the pipeline

**Adding a generation lane:**

1. Add a provider client in `api/_providers/<name>.js` (submit and poll, normalized errors).
2. Register the backend in `BACKENDS` (`api/_lib/forge-tiers.js`): paths, `free` or `byok`, `requiresEnv`, ETA, credits.
3. Place it in the routing lists it belongs in: `FREE_FALLBACK_FOR_PATH` and, if it should be a default, `FREE_DEFAULT_FOR_TIERS` or `DEFAULT_BACKEND_FOR_PATH`.
4. If it is async and can be re-dispatched from a poll, add it to `ASYNC_REDISPATCH_ORDER` and the suggestion orders in `api/_lib/forge-failover.js`.
5. Nothing else: the catalog, the UI engine picker, health checks, and x402 pricing all derive from the registry.

**Adding a rig convention:** add the bone-name mapping to `src/glb-canonicalize.js` and a case to `tests/glb-canonicalize.test.js`. Never introduce a curated rig allowlist.

**The invariants to preserve:**

- Free-first: a paid lane must never run while a healthy free lane can serve the request.
- One source of truth: prices, poly targets, and lane capabilities live only in `forge-tiers.js`.
- Fail-open persistence: the DB and storage layers may degrade, generation must not.
- Same job id across failover: the client never re-submits because a lane died.
- Durable URLs: user-facing results reference R2, never expiring provider URLs.

## Related

- [Forge](./forge.md), the product-level doc for the /forge surface.
- [How the Forge works](./how-forge-works.md), the plain-language explainer.
- [3D pipeline](./3d-pipeline.md), the pay-per-stage x402 pipeline (rig, remesh, gameready, stylize, rembg).
- [3D asset pipeline](./3d-asset-pipeline.md), formats and the animation/conversion flow.
- [Avatar pipeline](./avatar-pipeline.md), the selfie-to-avatar reconstruction flow.
- [Background generation](./forge-background-generation.md), job resume and gallery persistence.
- `workers/README.md`, the worker-by-worker operational reference.
