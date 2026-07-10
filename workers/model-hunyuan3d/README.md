# model-hunyuan3d — image → textured 3D mesh (Hunyuan3D-2.1)

Single-image to textured 3D mesh, using Tencent's
[Hunyuan3D-2.1](https://github.com/Tencent/Hunyuan3D-2). This is the
highest-fidelity mesh backend in the platform's own GPU model fleet — heavier and
slower than [`model-trellis`](../model-trellis/), and chosen when geometry quality
matters more than latency. It exists so three.ws can serve `image` → 3D on its own
Cloud Run L4s (free, no BYOK, no external quota) instead of paying an external lane.

A FastAPI service on Cloud Run with one NVIDIA L4. It speaks the same task shape as
every other worker in the fleet (`POST /infer → { task_id }`, `GET /tasks/:id`), so
the [avatar-pipeline-controller](../avatar-pipeline-controller/) can poll it. Jobs
are accepted immediately (`202`) and run in the background — one at a time, since a
single L4 fits exactly one inference.

## Role in the pipeline

Two things call this worker, both by its Cloud Run URL:

- **[avatar-pipeline-controller](../avatar-pipeline-controller/)** picks it as the
  mesh-generation backend via `MODEL_HUNYUAN3D_URL`, POSTs the source image(s) to
  `/infer`, polls `/tasks/:id` until `done`, then hands the resulting mesh to
  rigging.
- **The forge `gcp` provider** (`api/_providers/gcp.js`) reaches it directly as a
  self-host lane via `GCP_HUNYUAN3D_URL`. In the lane ordering the platform's own
  GPU workers lead — a healthy `trellis_selfhost` then `hunyuan3d` win before any
  external free lane (see [`docs/ops/gcp-model-workers.md`](../../docs/ops/gcp-model-workers.md)).

## API

All routes require `Authorization: Bearer $API_KEY` except `/health`.

### `POST /infer` → `202`

```bash
curl -X POST "$SERVICE_URL/infer" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"images":["https://example.com/statue.png"],"job_id":"abc123"}'
# → { "task_id": "…", "status": "queued" }
```

Request body (`InferRequest`):

| Field | Type | Notes |
|---|---|---|
| `images` | `string[]` (1–6) | `https://` URL or `data:image/…` URI. **Only the first is used.** |
| `body_type` | `string` | Optional, default `"neutral"`. |
| `job_id` | `string` | Optional caller-side correlation id. |

`https://` sources are fetched through the SSRF-hardened guard in
[`worker_security.py`](./worker_security.py): https-only, private/loopback/link-local/
metadata IPs rejected after DNS resolution, redirects re-validated per hop.

### `GET /tasks/{task_id}`

```json
{
  "task_id": "…",
  "status": "done",
  "model": "hunyuan3d-2.1",
  "result_gcs_url": "https://storage.googleapis.com/three-ws-avatar-reconstructions/raw-meshes/hunyuan3d/<task_id>.glb",
  "elapsed_ms": 48213
}
```

`status` is `queued` | `running` | `done` | `failed`. On `done` the output GLB is at
`result_gcs_url` (uploaded to `gs://$GCS_BUCKET/raw-meshes/hunyuan3d/<task_id>.glb`).
A `failed` task carries a sanitized `error` string. Unknown ids return `404`. Task
state is in-memory, so it does not survive a restart or scale-to-zero — the caller
polls promptly and does not rely on it as durable storage.

### `GET /health`

```json
{ "ok": true, "model": "hunyuan3d-2.1", "gpu_available": true, "gpu_name": "NVIDIA L4", "pipeline_loaded": true }
```

## Environment

| Var | Required | Default | Notes |
|---|---|---|---|
| `API_KEY` | ✅ | — | Shared bearer secret. From Secret Manager `avatar-reconstruction-key`. |
| `GCS_BUCKET` | ✅ | — | Output bucket for meshes (`three-ws-avatar-reconstructions`). |
| `WEIGHTS_DIR` | | `/weights/hunyuan3d-2.1` | Weights path on the mounted GCS volume. |
| `MAX_CONCURRENT` | | `1` | Parallel inferences; one L4 fits exactly one. |

Weights are **not** baked into the image (~10 GB). They load from the
`three-ws-model-weights` bucket, mounted read-only at `/weights`. Populate it once:

```bash
pip install huggingface_hub
huggingface-cli download tencent/Hunyuan3D-2.1 --local-dir /tmp/hunyuan3d-2.1
gsutil -m cp -r /tmp/hunyuan3d-2.1 gs://three-ws-model-weights/hunyuan3d-2.1/
```

## How it ships

Built and deployed by **Google Cloud Build** to **Cloud Run** — service
`model-hunyuan3d`, region `us-central1`, service account
`avatar-reconstruction-sa@aerial-vehicle-466722-p5.iam.gserviceaccount.com`:

```bash
gcloud builds submit --config workers/model-hunyuan3d/cloudbuild.yaml workers/model-hunyuan3d
```

The Cloud Run service is 1× `nvidia-l4` (no zonal redundancy), 8 vCPU, 32 GiB, port
8080, 900 s request timeout, `min-instances=0` (scales to zero — the first request
after idle pays a real cold start while the container spins up and loads weights) and
`max-instances=3`. GPU-backed Cloud Run requires NVIDIA L4 quota in `us-central1`; a
worker with no quota grant does not schedule (see
[`docs/ops/gcp-model-workers.md`](../../docs/ops/gcp-model-workers.md) for quota,
warm-instance, and lane-ordering ops). The base image is `nvidia/cuda:12.1.1-...-devel`
because the texture pipeline compiles CUDA extensions (`custom_rasterizer`,
`differentiable_renderer`) at install time for the L4 (`TORCH_CUDA_ARCH_LIST=8.9+PTX`),
so the build timeout is raised to 3600 s.

## Local

Needs a CUDA GPU and local weights:

```bash
cd workers/model-hunyuan3d
pip install -r requirements.txt
API_KEY=dev GCS_BUCKET=your-dev-bucket WEIGHTS_DIR=/path/to/hunyuan3d-2.1 \
  uvicorn main:app --port 8080
```
