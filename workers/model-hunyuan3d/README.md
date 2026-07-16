# model-hunyuan3d — single image → textured 3D mesh (Hunyuan3D)

FastAPI inference workers that turn **one image into a textured GLB** with
Tencent's Hunyuan3D. Two model generations run side by side as **two separate
Cloud Run services**, because their Python stacks are mutually incompatible
(torch 2.3 / cu121 + `hy3dgen` for 2.0 vs torch 2.5 / cu124 +
`hy3dshape` / `hy3dpaint` for 2.1):

| Service | Model | Entry point | Dockerfile | Output material |
|---|---|---|---|---|
| `model-hunyuan3d` | Hunyuan3D-2.0 | [`main.py`](./main.py) | [`Dockerfile`](./Dockerfile) | single baked diffuse texture |
| `model-hunyuan3d-21` | **Hunyuan3D-2.1** | [`app21.py`](./app21.py) | [`Dockerfile.hunyuan21`](./Dockerfile.hunyuan21) | **PBR: baseColor + metallicRoughness + normal** |

**2.1 is the realism lane.** It runs the `hy3dshape` shape DiT, then the
`hy3dpaint` PBR paint pass (multiview PBR diffusion → RealESRGAN super-res →
texture bake → inpaint), and exports a GLB with a true physically-based material
set. PBR maps are what make a render read as a real photographed object under
real lighting instead of a flat plastic toy — the single biggest realism lever
in the platform's own GPU fleet. 2.0 remains deployed and untouched as the
instant fallback lane: to roll back, repoint `GCP_HUNYUAN3D_URL` at the
`model-hunyuan3d` service URL — no rebuild.

Both services speak the **same wire contract**, so either URL drops straight
into the platform's `GCP_HUNYUAN3D_URL` env.

## License

Hunyuan3D-2.1 is released under the **TENCENT HUNYUAN NON-COMMERCIAL LICENSE
AGREEMENT** (the full text ships in the weights bucket at
`gs://three-ws-model-weights/hunyuan3d-2.1/LICENSE` and in the cloned repo). This
worker performs **self-hosted inference on our own GPU infrastructure**, exactly
as the 2.0 lane already runs in production. The RealESRGAN super-res checkpoint
and DINOv2 reference encoder carry their own upstream licenses (BSD-3 and Apache
2.0 respectively). No weights or model code are redistributed by the platform;
only generated GLBs are returned to callers.

## Endpoints

`POST /infer`, `POST /reconstruct`, `GET /tasks/{id}`, `GET /jobs/{id}` require
`Authorization: Bearer $API_KEY`. `GET /health` is unauthenticated.

### `POST /infer` → `202`

```json
{
	"images": ["https://example.com/portrait.png"],
	"tier": "high",
	"job_id": "abc123"
}
```

- `images` — 1 to 6 entries, each a `data:image/…;base64,…` URI or an `https://`
  URL. **Only the first is used.** `https` sources go through the SSRF guard in
  [`worker_security.py`](./worker_security.py) (https-only; private, loopback,
  link-local, and cloud-metadata IPs rejected on every redirect hop).
- `tier` — `draft` | `standard` | `high` (default `high`). Selects the
  generation budget (see below).
- `job_id` — optional correlation string.

Response: `{ "task_id": "3f2c…", "status": "queued" }`.

`POST /reconstruct` accepts the same body and additionally echoes `job_id`, for
the avatar controller's `/reconstruct` + `/jobs/:id` wire shape.

### `GET /tasks/{task_id}`

`status` is one of `queued` → `running` → `done`, or `failed`.

```json
{
	"task_id": "3f2c…",
	"status": "done",
	"model": "hunyuan3d-2.1",
	"result_gcs_url": "https://storage.googleapis.com/three-ws-avatar-reconstructions/raw-meshes/hunyuan3d/3f2c….glb",
	"elapsed_ms": 224140
}
```

Task state is persisted to a durable `tasks/{id}.json` GCS blob on every
transition, so a `POST /infer` and a later `GET /tasks/:id` that land on
different Cloud Run instances still resolve the same record. Failures carry a
sanitized `error` string; unknown ids return `404`.

### `GET /health`

```json
{ "ok": true, "model": "hunyuan3d-2.1", "gpu_available": true, "gpu_name": "NVIDIA L4",
  "pipeline_loaded": true, "ready": true, "load_error": null }
```

The pipeline loads in the **background** after the HTTP port opens, so the
instance answers `/health` immediately; `ready` flips to `true` once the shape +
paint models finish loading, and `load_error` carries a sanitized string if the
load failed.

## Quality tiers (2.1)

Quality over speed — GPU time is cheap against the platform's GCP credit budget.
The budget splits across the shape DiT (inference steps + marching-cubes octree
resolution) and the PBR paint pass (multiview count + per-view diffusion
resolution). The paint texture atlas is fixed high at load (render 2048, texture
4096).

| Tier | shape steps | octree | paint views | paint resolution |
|---|---|---|---|---|
| `draft` | 30 | 256 | 6 | 512 |
| `standard` | 50 | 384 | 6 | 512 |
| `high` (default) | 50 | 512 | 6 | 768 |

`high` holds the multiview count at 6 so the paint pass fits the L4's 24 GiB
VRAM alongside the shape DiT, DINOv2, and RealESRGAN, while pushing the shape
octree and per-view diffusion resolution up for sharper geometry and PBR maps.

## Environment (2.1)

| Var | Required | Default | Purpose |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret (Secret Manager `avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | — | Output-mesh bucket (`three-ws-avatar-reconstructions`) |
| `HUNYUAN3D_MODEL` | no | `2.1` | Pins the image's lane |
| `WEIGHTS_GCS_URI` | no | — | `gs://` prefix of the 2.1 weight tree to stage locally |
| `WEIGHTS_LOCAL_DIR` | no | `/tmp/hunyuan3d-2.1` | Local staging dir for the 2.1 weights |
| `WEIGHTS_DIR` | no | `/weights/hunyuan3d-2.1` | FUSE-mount fallback for the 2.1 weights |
| `DINO_GCS_URI` | no | — | `gs://` prefix of `facebook/dinov2-giant` to stage locally |
| `DINO_LOCAL_DIR` | no | `/tmp/dinov2-giant` | Local staging dir for DINOv2 |
| `DINO_DIR` | no | `/weights/dinov2-giant` | FUSE-mount fallback for DINOv2 |
| `MAX_CONCURRENT` | no | `1` | In-flight inferences; one L4 fits one |

**Weight staging.** The 2.1 shape DiT is a single 6.9 GiB `.ckpt` and the paint
UNet a single 3.7 GiB `.bin`. Reading files that large over the Cloud Storage
FUSE mount stalls indefinitely (the failure the 2.0 lane already hit and fixed),
so the worker streams the needed subtrees to local disk with the storage client
(a plain sequential GET, which does not stall) and loads from there. Staging is
gated on `WEIGHTS_GCS_URI` / `DINO_GCS_URI` and degrades to the FUSE mount on any
failure — it never crashes the loader.

## Stage the weights (one-time)

The `three-ws-model-weights` bucket already holds both trees. To (re)populate:

```bash
pip install "huggingface_hub[cli]"

# 2.1 shape + PBR paint + VAE weights (~14 GiB)
hf download tencent/Hunyuan3D-2.1 --local-dir /tmp/hunyuan3d-2.1
gcloud storage rsync --recursive /tmp/hunyuan3d-2.1 gs://three-ws-model-weights/hunyuan3d-2.1

# DINOv2 reference encoder for the paint pass (~4.4 GiB)
hf download facebook/dinov2-giant --local-dir /tmp/dinov2-giant
gcloud storage rsync --recursive /tmp/dinov2-giant gs://three-ws-model-weights/dinov2-giant
```

The RealESRGAN super-res checkpoint is fetched into the image at build time
(`hy3dpaint/ckpt/RealESRGAN_x4plus.pth`).

## Deploy

Submit from the **repo root** (the build step declares
`dir: workers/model-hunyuan3d`, so the upload source is the whole repo). Pass
`SHORT_SHA` explicitly — `gcloud builds submit` does not auto-populate it:

```bash
# 2.1 (model-hunyuan3d-21)
gcloud builds submit --config workers/model-hunyuan3d/cloudbuild.hunyuan21.yaml \
	--substitutions=SHORT_SHA=21-$(git rev-parse --short HEAD) .

# 2.0 (model-hunyuan3d) — legacy fallback lane
gcloud builds submit --config workers/model-hunyuan3d/cloudbuild.yaml \
	--substitutions=SHORT_SHA=$(git rev-parse --short HEAD) .
```

The 2.1 service deploys in `us-central1`: **1× `nvidia-l4` GPU** (no zonal
redundancy), 8 vCPU, 32 GiB, 900 s request timeout, `min-instances=1` (kept warm
so no request pays the multi-GiB weight load), `max-instances=1`. Build/runtime
service accounts are pinned (`three-ws-build@` / `avatar-reconstruction-sa@`) —
the project's default compute SA was deleted. The custom_rasterizer CUDA compile
plus the bpy/torch install push the build past the default timeout, so
`timeout: 3600s`.

## Wire it into the platform

The platform points **`GCP_HUNYUAN3D_URL`** at whichever service should serve
the Hunyuan3D `/forge` tier. After verifying the 2.1 service end to end:

```bash
gcloud run services update three-ws-api --region us-central1 \
	--update-env-vars GCP_HUNYUAN3D_URL=https://model-hunyuan3d-21-XXXXXXX-uc.a.run.app
```

**Always `--update-env-vars`, never `--set-env-vars`** — the latter wipes every
other env var on the shared `three-ws-api` service. To fall back to 2.0, repoint
the same var at the `model-hunyuan3d` service URL. The tier is declared in
[`api/_lib/forge-tiers.js`](../../api/_lib/forge-tiers.js)
(`requiresEnv: ['GCP_HUNYUAN3D_URL', 'GCP_RECONSTRUCTION_KEY']`), routed by
[`api/forge.js`](../../api/forge.js), health-probed by
[`api/_lib/forge-health.js`](../../api/_lib/forge-health.js), and the
[avatar-pipeline-controller](../avatar-pipeline-controller/) also selects it as a
mesh backend via `MODEL_HUNYUAN3D_URL`. All workers share the platform-side
bearer secret `GCP_RECONSTRUCTION_KEY`, which must equal each service's
`API_KEY`.

## Example — submit, poll, fetch

```bash
BASE=https://model-hunyuan3d-21-XXXXXXX-uc.a.run.app
KEY=your-api-key

TASK=$(curl -s -X POST "$BASE/infer" \
	-H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
	-d '{"images":["https://example.com/portrait.png"],"tier":"high"}' \
	| python3 -c 'import sys,json; print(json.load(sys.stdin)["task_id"])')

while :; do
	STATE=$(curl -s "$BASE/tasks/$TASK" -H "Authorization: Bearer $KEY")
	echo "$STATE"
	echo "$STATE" | grep -q '"status": *"done"' && break
	echo "$STATE" | grep -q '"status": *"failed"' && exit 1
	sleep 10
done
```
