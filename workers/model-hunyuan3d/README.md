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
| `model-hunyuan3d-21-rtx` | **Hunyuan3D-2.1** | [`app21.py`](./app21.py) | [`Dockerfile.hunyuan21rtx`](./Dockerfile.hunyuan21rtx) | same PBR set, on **RTX PRO 6000 (Blackwell)** |

**2.1 is the realism lane.** It runs the `hy3dshape` shape DiT, then the
`hy3dpaint` PBR paint pass (multiview PBR diffusion → RealESRGAN super-res →
texture bake → inpaint), and exports a GLB with a true physically-based material
set. PBR maps are what make a render read as a real photographed object under
real lighting instead of a flat plastic toy — the single biggest realism lever
in the platform's own GPU fleet. 2.0 remains deployed and untouched as the
instant fallback lane: to roll back, repoint `GCP_HUNYUAN3D_URL` at the
`model-hunyuan3d` service URL — no rebuild.

All three services speak the **same wire contract**, so any URL drops straight
into the platform's `GCP_HUNYUAN3D_URL` env.

**Which one is live right now:** `model-hunyuan3d-21-rtx`. That is what
`GCP_HUNYUAN3D_URL` on the `three-ws-api` service points at, and it is the only
one of the three that runs warm (`min-instances=1`); the two L4 services scale
to zero and take a multi-minute weight load on their first request. Confirm
before you assume:

```bash
gcloud run services describe three-ws-api --region us-central1 \
	--format='value(spec.template.spec.containers[0].env)' | tr ',' '\n' | grep HUNYUAN
```

**Why an RTX build exists.** Two hard walls, found live on 2026-07-17:

1. **The L4 2.1 service cannot finish loading at all.** app21 stages ~18 GiB
   of weights into `/tmp`, which on Cloud Run is memory-backed, then loads the
   ~14 GiB model on top; the L4 tier's 32 Gi memory ceiling SIGKILLs the
   instance every time (`Container terminated on signal 9` mid-load). The port
   binds and `/health` answers, but no 2.1 job can complete on an L4 with the
   current staging design.
2. **L4 quota.** All L4 services in us-central1 share one quota of 3 GPUs and
   the fleet is permanently at that ceiling; the RTX PRO 6000 quota in the
   same region is granted at 1000.

`Dockerfile.hunyuan21rtx` is the same app21.py on a CUDA 12.8 / torch 2.7.1
(cu128) stack, because Blackwell is compute capability 12.0 and the cu124
wheels in the L4 image ship no sm_120 kernels. Its extensions compile for both
8.9 and 12.0, so the image also boots on an L4 (though wall 1 above still
applies there). Deploy with
[`cloudbuild.hunyuan21rtx.yaml`](./cloudbuild.hunyuan21rtx.yaml) (BuildKit,
inline layer cache); platform minimums for the GPU type are 20 CPU / 80 Gi,
which also clears wall 1 with room to spare. The RTX service runs warm (min 1,
max 1: the quota preference reads granted 1000, but live deploy enforcement
allows exactly 1 RTX GPU in us-central1) as the 2.1 primary. Making the L4 build genuinely loadable (stage one
weight subtree at a time and delete each after its `from_pretrained`) is the
open follow-up if an L4 fallback for 2.1 is ever needed; until then the 2.0
lane is the fallback.

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
`Authorization: Bearer $API_KEY`. `GET /` and `GET /health` are unauthenticated.

### `POST /infer` → `202`

```json
{
	"images": ["https://three.ws/avatars/thumbs/default.png"],
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
{ "ok": true, "model": "hunyuan3d-2.1", "gpu_available": true,
  "gpu_name": "NVIDIA RTX PRO 6000 Blackwell Server Edition",
  "pipeline_loaded": true, "ready": true, "load_error": null }
```

The pipeline loads in the **background** after the HTTP port opens, so the
instance answers `/health` immediately; `ready` flips to `true` once the shape +
paint models finish loading, and `load_error` carries a sanitized string if the
load failed.

**These three fields are a wire contract, not diagnostics.** The platform reads
them in both directions: [`api/_lib/forge-health.js`](../../api/_lib/forge-health.js)
for the status dashboard and [`api/_lib/forge-lane-health.js`](../../api/_lib/forge-lane-health.js)
on the generation hot path. A populated `load_error` marks the lane **down**
(routing skips it); `ready: false` marks it up but never warm (a submit queues
until the weights land, so the caller widens its ETA). Renaming or dropping one
silently turns a dead worker back into a green backend. Both probes hit
`/health` for exactly this reason; before 2026-08-11 they hit the service root
and read the 404 as healthy.

### `GET /`

```json
{ "service": "model-hunyuan3d-21", "model": "hunyuan3d-2.1", "health": "/health",
  "endpoints": ["POST /infer", "POST /reconstruct", "GET /tasks/{id}", "GET /jobs/{id}", "GET /health"] }
```

Service identity for a bare-root GET. It serves no inference; it exists so a
probe or an operator landing on the root gets pointed at `/health` instead of a
404. (Two platform probes did exactly that, at one 404 per minute per service,
until the readiness fix above.)

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
# 2.1 on RTX PRO 6000 (model-hunyuan3d-21-rtx): THE PRODUCTION LANE
gcloud builds submit --config workers/model-hunyuan3d/cloudbuild.hunyuan21rtx.yaml \
	--substitutions=SHORT_SHA=$(git rev-parse --short HEAD) .

# 2.1 on L4 (model-hunyuan3d-21): cannot finish a job today, see wall 1 above
gcloud builds submit --config workers/model-hunyuan3d/cloudbuild.hunyuan21.yaml \
	--substitutions=SHORT_SHA=21-$(git rev-parse --short HEAD) .

# 2.0 (model-hunyuan3d) — legacy fallback lane
gcloud builds submit --config workers/model-hunyuan3d/cloudbuild.yaml \
	--substitutions=SHORT_SHA=$(git rev-parse --short HEAD) .
```

Every submit deploys as well as builds, so all three are owner-gated production
deploys, not build checks.

What each config asks Cloud Run for, all in `us-central1`, all with no GPU zonal
redundancy, a 900 s request timeout, and the `three-ws-build@` /
`avatar-reconstruction-sa@` service accounts pinned (the project's default
compute SA was deleted, so an unpinned submit fails outright):

| Config | GPU | CPU / memory | min / max | Build timeout |
|---|---|---|---|---|
| `cloudbuild.hunyuan21rtx.yaml` | 1× `nvidia-rtx-pro-6000` | 20 / 80 Gi | 1 / 1 | 7200 s |
| `cloudbuild.hunyuan21.yaml` | 1× `nvidia-l4` | 8 / 32 Gi | 0 / 1 | 3600 s |
| `cloudbuild.yaml` | 1× `nvidia-l4` | 8 / 32 Gi | 0 / 1 | 3600 s |

### The fourth service: a us-east4 standby

A second deployment of the **2.0** image runs in `us-east4` as a standby
(`https://model-hunyuan3d-93741856042.us-east4.run.app`), alongside the
equivalent standbys for trellis and triposr (see the GPU-fleet row in
[`STRUCTURE.md`](../../STRUCTURE.md)). The L4 quota is granted **per region**,
so a second region is extra capacity that costs nothing while idle.

`cloudbuild.yaml` does not manage it. It was deployed by hand from the
`us-central1` image, so a rebuild updates `us-central1` only and the standby
keeps serving the old tag until it is pointed at the new one explicitly:

```bash
gcloud run deploy model-hunyuan3d --region us-east4 \
	--image us-central1-docker.pkg.dev/aerial-vehicle-466722-p5/model-hunyuan3d/server:<tag>
```

Nothing routes to it today (`GCP_HUNYUAN3D_URL` is the RTX service), so it is a
capacity reserve, not a lane. Scale-to-zero, `max-instances=1`, same env and
same `avatar-reconstruction-sa@` runtime SA as the us-central1 2.0 service.

**Known benign log entry.** A retiring instance of this standby can log
`malloc_consolidate(): unaligned fastbin chunk detected` followed by `Container
terminated on signal 11`. That fires during interpreter teardown, AFTER uvicorn
has logged a clean `Application shutdown complete`, when the native CUDA and
mesh libraries unload in an order glibc dislikes. No request is in flight and no
task is affected; it is an exit-path artifact of a container that is already
going away, not a crash of a serving instance.

**Only the RTX lane is kept warm.** The L4 GPU allocation in this region is
scarce and shared with the other model workers, so neither L4 Hunyuan3D service
pins an instance: the RTX service is the primary and the 2.0 service is a
fallback that pays its weight load on the first request after an idle period.
The CUDA compiles (custom_rasterizer plus the mesh-processor pybind extension,
and on the RTX image both the 8.9 and 12.0 CUDA archs) are what push the build
timeouts far past the 10-minute default.

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
[`api/_lib/forge-health.js`](../../api/_lib/forge-health.js) and
[`api/_lib/forge-lane-health.js`](../../api/_lib/forge-lane-health.js) (both
against `/health`, see the readiness contract above), and the
[avatar-pipeline-controller](../avatar-pipeline-controller/) also selects it as a
mesh backend via `MODEL_HUNYUAN3D_URL`. All workers share the platform-side
bearer secret `GCP_RECONSTRUCTION_KEY`, which must equal each service's
`API_KEY`.

## Tests

[`test_worker_api.py`](./test_worker_api.py) covers the 2.1 worker's whole
caller-facing surface with no GPU, no weights, and no network. It can do that
because `app21.py` defers its `import torch` into the loader thread, so the HTTP
app imports on a plain CPU box:

```bash
pip install pytest fastapi httpx pillow pydantic google-cloud-storage
python3 workers/model-hunyuan3d/test_worker_api.py             # standalone runner
python3 -m pytest -q workers/model-hunyuan3d/test_worker_api.py # 9 tests
```

It pins the `/health` readiness contract the platform probes depend on, the
`/` identity route, bearer auth on every inference and task route, the tier
budget table above, the SSRF refusals in the image decoder, and the durable
`tasks/{id}.json` round trip that lets a submit and a later poll land on
different instances and still agree.

The GPU inference itself is not covered here (it needs the built CUDA image and
real weights); exercise it with the submit-poll-fetch loop below against a
deployed service. The 2.0 worker (`main.py`) imports torch at module scope, so
it is only importable inside its own image.

## Example — submit, poll, fetch

```bash
BASE=https://model-hunyuan3d-21-XXXXXXX-uc.a.run.app
KEY=your-api-key

TASK=$(curl -s -X POST "$BASE/infer" \
	-H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
	-d '{"images":["https://three.ws/avatars/thumbs/default.png"],"tier":"high"}' \
	| python3 -c 'import sys,json; print(json.load(sys.stdin)["task_id"])')

while :; do
	STATE=$(curl -s "$BASE/tasks/$TASK" -H "Authorization: Bearer $KEY")
	echo "$STATE"
	echo "$STATE" | grep -q '"status": *"done"' && break
	echo "$STATE" | grep -q '"status": *"failed"' && exit 1
	sleep 10
done
```
