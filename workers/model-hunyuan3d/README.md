# model-hunyuan3d — single image → textured 3D mesh (Hunyuan3D-2.1)

FastAPI inference service that turns **one image into a textured GLB** using
Tencent [Hunyuan3D-2.1](https://github.com/Tencent/Hunyuan3D-2). It runs the
model in two stages: a shape pipeline (`Hunyuan3DDiTFlowMatchingPipeline`,
subfolder `hunyuan3d-dit-v2-1`, 30 steps, guidance 5.5, octree resolution 256)
produces the mesh, then a texture pipeline (`Hunyuan3DPaintPipeline`, subfolder
`hunyuan3d-paint-v2-1`, 20 steps, guidance 7.5) paints it. Both load in `float16`
on one NVIDIA L4 on Cloud Run. This is the highest-fidelity mesh backend in the
platform's own GPU fleet — heavier and slower than
[`model-trellis`](../model-trellis/), chosen when geometry quality matters more
than latency.

Work is asynchronous: `POST /infer` returns `202` with a `task_id`, and the
caller polls `GET /tasks/{id}` until the GLB is written to
`gs://$GCS_BUCKET/raw-meshes/hunyuan3d/{task_id}.glb` and served back as an
`https://storage.googleapis.com/…` URL. Task state is in-memory, so it does not
survive a restart or scale-to-zero — poll promptly, don't treat it as durable.

## Endpoints

`POST /infer` and `GET /tasks/{id}` require `Authorization: Bearer $API_KEY`.
`GET /health` is unauthenticated.

### `POST /infer` → `202`

Request:

```json
{
	"images": ["https://example.com/statue.png"],
	"body_type": "neutral",
	"job_id": "abc123"
}
```

- `images` — 1 to 6 entries, each a `data:image/…;base64,…` URI or an `https://`
  URL. **Only the first is used.** `https` sources go through the SSRF guard in
  [`worker_security.py`](./worker_security.py) (https-only; private, loopback,
  link-local, and cloud-metadata IPs rejected on every redirect hop).
- `body_type` — optional, default `"neutral"` (accepted, not used by the model).
- `job_id` — optional correlation string.

Response:

```json
{ "task_id": "3f2c…", "status": "queued" }
```

### `GET /tasks/{task_id}`

`status` is one of `queued` → `running` → `done`, or `failed`.

```json
{
	"task_id": "3f2c…",
	"status": "done",
	"model": "hunyuan3d-2.1",
	"result_gcs_url": "https://storage.googleapis.com/three-ws-avatar-reconstructions/raw-meshes/hunyuan3d/3f2c….glb",
	"elapsed_ms": 92140
}
```

Failures carry a sanitized `error` string; unknown ids return `404`.

### `GET /health`

```json
{
	"ok": true,
	"model": "hunyuan3d-2.1",
	"gpu_available": true,
	"gpu_name": "NVIDIA L4",
	"pipeline_loaded": true
}
```

Both pipelines (~10 GB) load **synchronously** during ASGI startup, so the
instance only becomes ready — and only answers the probe — after the load
completes.

## Environment

| Var | Required | Default | Purpose |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret (Secret Manager `avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | — | Cloud Storage bucket for output meshes (`three-ws-avatar-reconstructions`) |
| `WEIGHTS_DIR` | no | `/weights/hunyuan3d-2.1` | Local path to weights (mounted GCS volume in prod) |
| `MAX_CONCURRENT` | no | `1` | In-flight inferences; one L4 fits exactly one |

Weights are **not** baked into the image — the `three-ws-model-weights` bucket is
mounted read-only at `/weights`. Pre-populate once with:

```bash
pip install huggingface_hub
huggingface-cli download tencent/Hunyuan3D-2.1 --local-dir /tmp/hunyuan3d-2.1
gsutil -m cp -r /tmp/hunyuan3d-2.1 gs://three-ws-model-weights/hunyuan3d-2.1/
```

## Run locally

Requires a CUDA GPU and the Hunyuan3D-2.1 weights on disk. The `hy3dgen` texture
pipeline compiles CUDA extensions (`custom_rasterizer`, `differentiable_renderer`)
at install time, so the reproducible way to run it is the image:

```bash
cd workers/model-hunyuan3d
docker build -t model-hunyuan3d .

docker run --rm --gpus all -p 8080:8080 \
	-e API_KEY=dev-secret \
	-e GCS_BUCKET=your-dev-bucket \
	-e WEIGHTS_DIR=/weights/hunyuan3d-2.1 \
	-e GOOGLE_APPLICATION_CREDENTIALS=/gcp/sa.json \
	-v /path/to/hunyuan3d-2.1:/weights/hunyuan3d-2.1:ro \
	-v /path/to/sa.json:/gcp/sa.json:ro \
	model-hunyuan3d
```

With the `hy3dgen` environment already installed you can run the server directly:

```bash
API_KEY=dev-secret GCS_BUCKET=your-dev-bucket WEIGHTS_DIR=/path/to/hunyuan3d-2.1 \
	uvicorn main:app --host 0.0.0.0 --port 8080
```

## Deploy

Submit from the **repo root** — the build step declares `dir: workers/model-hunyuan3d`,
so the upload source is the whole repo:

```bash
gcloud builds submit --config workers/model-hunyuan3d/cloudbuild.yaml .
```

Or provision it alongside the rest of the fleet (idempotent; prints the URLs to
set on the `three-ws-api` service env):

```bash
PROJECT_ID=<gcp-project> SERVICES="hunyuan3d trellis triposg unirig" \
	workers/deploy/deploy-all.sh
```

Deploys Cloud Run service **`model-hunyuan3d`** in `us-central1`: **1× `nvidia-l4`
GPU** (no zonal redundancy), 8 vCPU, 32 GiB, 900 s request timeout,
`min-instances=0` (scales to zero — the first request after idle pays a real cold
start), `max-instances=3`. The build `timeout` is `3600s` because the texture
pipeline's CUDA extensions compile for the L4 (`TORCH_CUDA_ARCH_LIST=8.9+PTX`).
Weights bucket mounted at `/weights`; `API_KEY` from the `avatar-reconstruction-key`
secret.

## Example — submit, poll, fetch

```bash
BASE=https://model-hunyuan3d-xxxxxxxx-uc.a.run.app
KEY=your-api-key

TASK=$(curl -s -X POST "$BASE/infer" \
	-H "Authorization: Bearer $KEY" \
	-H 'Content-Type: application/json' \
	-d '{"images":["https://storage.googleapis.com/three-ws-public/samples/statue.png"]}' \
	| python3 -c 'import sys,json; print(json.load(sys.stdin)["task_id"])')

while :; do
	STATE=$(curl -s "$BASE/tasks/$TASK" -H "Authorization: Bearer $KEY")
	echo "$STATE"
	echo "$STATE" | grep -q '"status": *"done"' && break
	echo "$STATE" | grep -q '"status": *"failed"' && exit 1
	sleep 5
done

curl -s "$BASE/tasks/$TASK" -H "Authorization: Bearer $KEY" \
	| python3 -c 'import sys,json; print(json.load(sys.stdin)["result_gcs_url"])'
```

## How three.ws calls it

The platform points **`GCP_HUNYUAN3D_URL`** at this service. It runs on its own
Cloud Run worker (never the avatar pipeline) and is invoked directly by
[`api/forge.js`](../../api/forge.js) for the Hunyuan3D `/forge` tier, which
[`api/_lib/forge-tiers.js`](../../api/_lib/forge-tiers.js) declares with
`requiresEnv: ['GCP_HUNYUAN3D_URL', 'GCP_RECONSTRUCTION_KEY']`. Health is probed
in [`api/_lib/forge-health.js`](../../api/_lib/forge-health.js), and the
[avatar-pipeline-controller](../avatar-pipeline-controller/) also selects it as a
mesh backend via its own `MODEL_HUNYUAN3D_URL`. All workers share the platform-side
bearer secret `GCP_RECONSTRUCTION_KEY`, which must equal this service's `API_KEY`.
