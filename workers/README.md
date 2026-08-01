# Workers

Out-of-process compute for three.ws — the heavy and edge work that does not belong in a Vercel function. Two kinds live here:

- **Cloud Run services** — Python FastAPI apps (GPU or CPU) with a `Dockerfile` + `cloudbuild.yaml`, deployed to Google Cloud Run. These run the avatar reconstruction / rigging models and the talking-avatar video model.
- **Cloudflare Worker** — one JavaScript worker (`wrangler.toml`) deployed with `wrangler deploy`: the remote MCP server.

## Avatar pipeline (Cloud Run)

The avatar pipeline turns a photo into a rigged, blendshape-ready 3D GLB by fanning out to single-purpose GPU services, coordinated by a CPU controller. The controller keeps the same HTTP contract as the original reconstruction service so `api/_providers/gcp.js` needs no changes.

### `avatar-pipeline-controller/` (CPU)
The orchestrator (`main.py`). Exposes `POST /reconstruct` (`{ images: [...], body_type? }` -> `202 { job_id, status }`), `GET /jobs/:id` (`{ status, glb_url?, error?, model }`), and `GET /health`. It picks a mesh backend (Hunyuan3D / TRELLIS / TripoSR / TripoSG) via weighted random, runs reconstruction, then auto-rigs the result through UniRig and uploads the final GLB.

### `model-hunyuan3d/` (GPU L4)
Hunyuan3D-2.1: single image -> textured 3D mesh. `POST /infer` -> `202 { task_id }`, `GET /tasks/:id` -> `{ status, result_gcs_url?, error? }`.

### `model-trellis/` (GPU L4)
Microsoft TRELLIS (MIT): single image -> textured 3D mesh via structured latent representations. Same `/infer` + `/tasks/:id` contract.

### `model-triposr/` (GPU L4)
TripoSR (VAST-AI, MIT): fast single-image -> 3D mesh (~5–15 s, baked single texture). Used as a fast-path / fallback. Same `/infer` contract.

### `model-triposg/` (GPU L4)
TripoSG (VAST-AI Research, MIT): 1.5B rectified-flow transformer, single image or sketch -> high-fidelity 3D shape (geometry only — no textures; pair with `texture/`). Two modes on the same `/infer` contract: `mode: "image"` (RMBG-1.4 background removal + recenter, 50 steps — the quality successor to TripoSR in the avatar pipeline pool) and `mode: "scribble"` (drawing + required prompt via the CFG-distilled TripoSG-scribble pipeline, 16 steps — powers the `/forge` sketch→3D path). Decimates to `target_polycount` via pymeshlab when supplied. Weights: `VAST-AI/TripoSG` + `VAST-AI/TripoSG-scribble` + `briaai/RMBG-1.4` (staged by `deploy/stage-weights.sh`, service key `triposg`). Routed two ways: through the controller (`MODEL_TRIPOSG_URL`) for avatar reconstruction, and directly via `api/_providers/gcp.js` (`sketch` mode, `GCP_TRIPOSG_URL`) for forge sketch→3D.

### `unirig/` (GPU L4)
UniRig (VAST-AI-Research, MIT): takes a raw generated mesh and adds a humanoid skeleton, per-vertex skinning weights, and ARKit-52 blendshapes — turning a static mesh into a riggable avatar.

### `avatar-reconstruction/` (GPU L4)
Standalone face-to-avatar service running InstantMesh: accepts 1–6 face photos, synthesizes 6 multi-view renders via Zero123++, reconstructs a textured GLB, and stores it in Cloud Storage. Predates the split pipeline above; see `avatar-reconstruction/README.md`.

## Talking-avatar video (Cloud Run)

### `longcat/` (GPU L4)
FastAPI service running LongCat-Video-Avatar-1.5 (MIT). Takes a reference image + audio URL and renders a lip-synced talking-avatar MP4 to Cloud Storage. API: `POST /generate` -> `202 { job_id }`, `GET /jobs/:id`, `GET /health`; bearer-auth on every request. Full deploy + cost guide in `longcat/README.md`.

## Mesh stylization (Cloud Run, CPU)

### `stylize/` (CPU)
One-click geometric stylization filters — turns any mesh into a stylized variant with pure geometry processing (trimesh + numpy + scipy; no GPU, no model inference). Filters: `voxel` (blocky cubes on a grid), `brick` (voxels + studs, LEGO-like), `voronoi` (open strut-and-node lattice shell), `lowpoly` (decimated + hard flat-shaded facets). Source color is preserved per output element where the style allows. API: `POST /process` (`{ mesh, style, resolution?, output_format? }`) -> `202 { task_id }`, `GET /tasks/:id`, `GET /styles` (filter catalog for the UI), `GET /health`; bearer-auth on `/process` + `/tasks`. Routed via `api/_providers/gcp.js` (`stylize` mode, `GCP_STYLIZE_URL`); exposed to the web at `/api/forge-stylize` and to agents over MCP as `stylize_model`.

## Part segmentation (Cloud Run, CPU)

### `segment/` (CPU)
Splits a 3D model into meaningful, separable parts with clean boundaries (head/torso/limbs on a character; body/wheels/glass on a vehicle) using pure geometry — trimesh + numpy + scipy, no GPU, no model inference. The engine combines connected-component splitting (physically disjoint shells become parts immediately) with the **minima rule** — region growing that cuts the face-adjacency graph at concave creases, where human perception sees part seams — then merges shards and caps the part count to a meaningful handful. Each part is named by its spatial region, tinted a distinct colour, and emitted as a separate named node in the output GLB so it can be hidden, recoloured, replaced, or exported individually. `POST /segment` (`{ mesh, method?, max_parts?, min_part_faces?, crease_angle?, only_part? }`) -> `202 { task_id }`, `GET /tasks/:id` -> `{ status, result_url?, manifest_url?, parts?, part_count?, source_faces?, method?, error? }` (the parts manifest carries each part's id, name, region, bbox, centroid, face/vertex counts, and colour), `GET /health`; bearer-auth on `/segment` + `/tasks`. Routed via `api/_providers/gcp.js` (`segment` mode, `GCP_SEGMENT_URL`); exposed to the web at `/api/forge-segment` (and the `/segment` Parts Studio viewer) and to agents over MCP as the x402-priced `segment_model`.

## Text-guided texturing (Cloud Run, GPU L4)

### `texture/`
Two capabilities on one model server. **Full retexture** (`POST /texture`): takes an untextured or poorly-textured GLB plus a text prompt, renders depth maps from 8 canonical viewpoints (pyrender), generates coherent texture views with SDXL Img2Img + ControlNet-Depth, back-projects them onto the UV map (pytorch3d), blends overlaps by distance-weighted confidence, and bakes a final textured GLB. **Magic-brush region retexture** (`POST /retexture_region`): SDXL inpainting of only a UV-space masked region of an existing atlas, feathering the seam so untouched texels stay bit-identical across repeated passes. API: `POST /texture` (`{ mesh, prompt, negative_prompt?, num_views?, texture_size? }`) and `POST /retexture_region` (`{ mesh, prompt, mask_b64?|mask?, color?, strength?, feather?, seed? }`) -> `202 { task_id }`, `GET /tasks/:id`, `GET /health`; bearer-auth via `API_KEY`. Env: `API_KEY`, `GCS_BUCKET` (required), `SDXL_MODEL`, `CONTROLNET_MODEL`. Routed via `api/_providers/gcp.js` (`retex` / `retex_region` modes, `GCP_TEXTURE_URL`); exposed to the web at `/api/studio/retexture-region`, to agents over MCP as the studio retexture tool, and x402-priced in `api/_lib/pump-pricing.js`.

## Mesh processing (Cloud Run, CPU)

### `remesh/`
Mesh processing — remesh, simplify, repair, retopologize, and convert 3D files. Wraps trimesh + open3d + QuadriFlow + xatlas, with headless Blender (`bpy`) for FBX export. Handles format conversion (GLB ↔ OBJ ↔ FBX ↔ STL ↔ PLY ↔ USDZ ↔ 3MF); a `convert` of a rigged GLB keeps its bone hierarchy, skin weights, and blendshapes (Blender path — trimesh has no FBX writer). No GPU. `GET /tasks/:id`, `GET /health`; routed via `api/_providers/gcp.js` (`remesh` mode, `GCP_REMESH_URL`).

## Image preprocessing (Cloud Run, CPU)

### `rembg/`
Background removal — strips backgrounds from images using BRIA RMBG-2.0 (Apache-2.0) with rembg's U2Net as a fast CPU fallback. `POST /remove` (`{ image: data-uri|url, model?: "rmbg2"|"u2net"|"isnet" }`) -> `202 { task_id, status }`, `GET /tasks/:id`, `GET /health`. Routed via `api/_providers/gcp.js` (`rembg` mode, `GCP_REMBG_URL`); used to clean source photos before reconstruction.

## Cloudflare Worker

### `pump-fun-mcp/`
Remote Model Context Protocol server (a mirror of `/api/pump-fun-mcp`) deployed as a Cloudflare Worker — `worker.js` + `wrangler.toml`, named `pump-fun-mcp`, with `nodejs_compat`. Exposes pump.fun token tools to MCP clients; configurable via `wrangler secret put` (`SOLANA_RPC_URL`, `PUMPFUN_BOT_URL`, `PUMPFUN_BOT_TOKEN`, ...). Deploy with `wrangler deploy`.

## Always-on Node workers

Long-lived Node processes rather than request-scoped services. They hold feeds,
sessions, or daemons open, so a scheduled cron cannot replace them. Each one
carries its own README with its env contract and failure modes.

### `okx-chat-bot/`
Durable host for the OKX.AI marketplace chat bot (agent #2632). Supervises the
`okx-a2a` XMTP daemon and the `onchainos` wallet session that marketplace chat is
delivered through, restores that identity from GCS on boot, and rebuilds the AI
subsession's briefing and skills from the image every time. Readiness is strict:
a bot that cannot receive a buyer's message reports 503 on `/readyz` even though
the process is alive, because the outage this worker exists to kill is silent.
Must run `--min-instances=1 --max-instances=1` (single snapshot writer). Run
locally with `npm run worker:okx-bot`. See [okx-chat-bot/README.md](okx-chat-bot/README.md).

## Loose scripts

### `strategy-executor.js`
A Node script that loads stored agent strategies and calls `executeAgentAction` (from `src/agent-actions.js`) for each one whose conditions are met. Imports `api/_lib/db.js` for storage.

## Deploy

- Cloud Run services: `gcloud builds submit --config workers/<name>/cloudbuild.yaml` (see each service's README for substitutions and secrets).
- Cloudflare Worker: `cd workers/pump-fun-mcp && wrangler deploy`.
