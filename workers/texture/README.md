# texture — text-guided texturing & magic-brush region retexture

Paints materials onto meshes. One GPU model server hosts two capabilities that
together back the platform's post-generation texturing tools:

- **Full retexture** (`/texture`) — takes an untextured (or poorly-textured) GLB
  plus a text prompt, renders the mesh from 4 or 8 canonical viewpoints, generates
  coherent per-view textures with **SDXL + ControlNet-Depth**, back-projects each
  view onto the UV atlas (confidence-weighted by face normal · view direction),
  fills gaps by nearest-neighbour, and bakes a textured GLB.
- **Magic-brush region retexture** (`/retexture_region`) — repaints **only** a
  masked UV region of an existing texture from a prompt and/or a target colour,
  keeping the rest of the atlas bit-identical and feathering the seam so the edit
  is invisible. Runs real **SDXL inpainting** in UV space; safe to run repeatedly
  because each pass composites over the latest atlas through a feathered alpha, so
  there is no global quality drift.

Geometry comes from the generation lanes ([model-triposg](../model-triposg/),
[model-trellis](../model-trellis/), etc.); this worker is the *surface* stage that
turns bare geometry into a finished, material-clad GLB.

## How it runs

Ships as the Cloud Run service **`texture-service`** in **`us-central1`**, built
by Cloud Build from [`cloudbuild.yaml`](./cloudbuild.yaml). It is a GPU service:
1× `nvidia-l4`, 8 vCPU, 32 GiB, 600 s request timeout, `min-instances=0`,
`max-instances=2` (scale-to-zero — the first request after idle pays a one-time
SDXL + ControlNet model load). CI/deploy is Cloud Build only; there are no GitHub
Actions.

Deploy from the repo root (the build step declares `dir: workers/texture`, so the
upload source is the whole repo):

```bash
gcloud builds submit --config workers/texture/cloudbuild.yaml .
```

Or provision it alongside the other mesh-editing workers with the deploy helper
(idempotent — `texture` is a GPU extra that needs L4 quota and staged weights):

```bash
PROJECT_ID=<gcp-project> SERVICES="texture" workers/deploy/deploy-editing.sh
```

The SDXL/ControlNet weights live in the `three-ws-model-weights` bucket, mounted
read-only at `/weights`; output GLBs are written to
`three-ws-avatar-reconstructions` under `textured/<task_id>.glb`. See
[`docs/ops/gcp-model-workers.md`](../../docs/ops/gcp-model-workers.md) for the
lane-routing and operations runbook.

### Local

Requires a CUDA GPU and access to a GCS bucket for output:

```bash
cd workers/texture
pip install -r requirements.txt
API_KEY=dev GCS_BUCKET=your-dev-bucket WEIGHTS_DIR=/tmp/weights \
  uvicorn main:app --host 0.0.0.0 --port 8080
```

## API

Async task shape. Every route except `/health` requires
`Authorization: Bearer $API_KEY`. Submit returns `202` with a `task_id`; poll
`GET /tasks/:id` until `status` is `done` (with `result_url`) or `failed` (with
`error`). Remote mesh and mask URLs are fetched through the SSRF guard in
[`worker_security.py`](./worker_security.py).

### `POST /texture` → `202`

```bash
curl -X POST https://$SERVICE_URL/texture \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "mesh": "https://storage.googleapis.com/three-ws-avatar-reconstructions/mesh.glb",
    "prompt": "worn leather, dark brown, stitched seams",
    "num_views": 8,
    "texture_size": 1024
  }'
# → { "task_id": "…", "status": "queued" }
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `mesh` | yes | — | https URL to the input GLB |
| `prompt` | yes | — | 3–500 chars, texture description |
| `negative_prompt` | no | `blurry, low quality, distorted, watermark` | |
| `num_views` | no | `8` | `4` or `8` render viewpoints |
| `texture_size` | no | `1024` | `512`, `1024`, or `2048` |

### `POST /retexture_region` → `202`

Repaints only the masked region. The mask is a UV-space PNG (white = repaint,
black = keep) — either inline base64 (from a browser canvas `toDataURL()`, a
`data:` prefix is tolerated) via `mask_b64`, **or** a public URL via `mask`. Pass
a `prompt` and/or a `color`.

```bash
curl -X POST https://$SERVICE_URL/retexture_region \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "mesh": "https://storage.googleapis.com/three-ws-avatar-reconstructions/textured/abc.glb",
    "prompt": "cracked red enamel",
    "color": "#b02020",
    "mask_b64": "iVBORw0KGgo…",
    "strength": 0.85,
    "feather": 24
  }'
# → { "task_id": "…", "status": "queued" }
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `mesh` | yes | — | https URL to a textured GLB |
| `prompt` | prompt and/or color | `""` | ≤500 chars, what to paint into the region |
| `mask_b64` | mask_b64 or mask | — | UV mask PNG, base64 (white = edit) |
| `mask` | mask_b64 or mask | — | public https URL to the UV mask PNG |
| `color` | — | — | `"#rrggbb"` hint that primes the region hue |
| `negative_prompt` | no | `blurry, low quality, distorted, watermark, seam` | |
| `texture_size` | no | `1024` | `512`, `1024`, or `2048` working/output atlas |
| `strength` | no | `0.85` | inpaint denoise strength, `0.2`–`1.0` |
| `feather` | no | `24` | seam feather radius in atlas px, `1`–`128` |
| `seed` | no | `0` | ≥0, reproducible output |

The inpaint pipeline is loaded lazily on the first region request, so the
`/texture` path pays no extra startup cost or VRAM until a magic-brush edit runs.

### `GET /tasks/{task_id}`

```json
{
  "task_id": "…",
  "status": "done",
  "result_url": "https://storage.googleapis.com/three-ws-avatar-reconstructions/textured/….glb",
  "bytes": 4185302,
  "elapsed_ms": 41230
}
```

`status` is one of `queued`, `running`, `done`, `failed`. On failure the object
carries a sanitized `error` string instead of `result_url`.

### `GET /health`

```json
{ "ok": true, "service": "texture", "gpu_available": true, "model_loaded": true, "inpaint_loaded": false }
```

## Env

| Var | Required | Default | Notes |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret (Secret Manager: `avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | — | Output bucket (`three-ws-avatar-reconstructions`) |
| `WEIGHTS_DIR` | no | `/weights` | Model weight cache (GCS volume on Cloud Run) |
| `SDXL_MODEL` | no | `stabilityai/stable-diffusion-xl-base-1.0` | Base SDXL checkpoint |
| `CONTROLNET_MODEL` | no | `diffusers/controlnet-depth-sdxl-1.0` | Depth ControlNet for full retexture |
| `SDXL_INPAINT_MODEL` | no | `diffusers/stable-diffusion-xl-1.0-inpainting-0.1` | Magic-brush inpainting checkpoint |
| `MAX_CONCURRENT` | no | `1` | One L4 fits one inference at a time |

## Callers

Routed through `api/_providers/gcp.js`, which reads **`GCP_TEXTURE_URL`** (the
worker base URL) and **`GCP_RECONSTRUCTION_KEY`** (the shared bearer secret,
Secret Manager `avatar-reconstruction-key`). Both the `retex` (full) and
`retex_region` (magic brush) modes resolve to this one service:

- **MCP `retexture_model`** (`api/_mcp3d/tools/studio.js`) → mode `retex` →
  `POST /texture`.
- **MCP `retexture_region`** and the HTTP gateway
  **`POST /api/studio/retexture-region`** (`api/studio/retexture-region.js`) →
  mode `retex_region` → `POST /retexture_region`. The gateway is the thin,
  authenticated, SSRF-guarded front door: it packs the worker task handle into an
  opaque `job` token and re-validates that token targets the configured worker
  before polling, so a forged token can never steer the server's fetch.

If `GCP_TEXTURE_URL` (or the key) is unset, these callers return a designed
`501`/`503` — the lane simply drops out; nothing is faked. Production env vars for
`three.ws` live on the `three-ws-api` Cloud Run service (`gcloud run services
describe three-ws-api --region us-central1`), not in a `.env` file.
