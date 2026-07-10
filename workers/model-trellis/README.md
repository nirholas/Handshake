# model-trellis — image → textured 3D mesh (TRELLIS)

Turns a single image into a textured 3D mesh using [Microsoft TRELLIS](https://github.com/microsoft/TRELLIS)
(MIT), which represents shape and appearance as structured latents before decoding
to a GLB. This is the default mesh backend for the avatar pipeline and the free
text→3D lane behind `forge_free`.

A FastAPI service on Cloud Run with one NVIDIA L4. Jobs are accepted immediately
(`202`) and polled — inference takes tens of seconds, far longer than a request
should be held open.

## API

All routes require `Authorization: Bearer $API_KEY`.

### `POST /infer` → `202`

```bash
curl -X POST https://$SERVICE_URL/infer \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"images":["https://example.com/chair.png"],"job_id":"abc123"}'
# → { "task_id": "…", "status": "queued" }
```

`images` accepts `https://` URLs or `data:` URIs. Only the first image is used.
`body_type` and `job_id` are optional; `job_id` is echoed back for correlation.

URLs are fetched through the shared SSRF guard in [`worker_security.py`](./worker_security.py) —
https-only, with private, loopback, link-local, and cloud-metadata addresses
rejected on every redirect hop.

### `GET /tasks/{task_id}`

```json
{ "task_id": "…", "status": "succeeded", "result_gcs_url": "https://storage.googleapis.com/…/mesh.glb" }
```

`status` is `queued` | `running` | `succeeded` | `failed`. On failure the response
carries a sanitized `error` string; the full traceback stays in the server log.

### `GET /health`

```json
{ "ok": true, "model": "trellis-large", "gpu_available": true }
```

Unauthenticated, so Cloud Run's startup probe can reach it.

## Env

| Var | Required | Default | Notes |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret; from Secret Manager (`avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | — | Bucket for output meshes (`three-ws-avatar-reconstructions`) |
| `WEIGHTS_DIR` | no | `/weights/trellis-large` | Weights, read from the mounted GCS volume |
| `MAX_CONCURRENT` | no | `1` | In-flight inferences; one L4 fits exactly one |

Weights are **not** baked into the image. The `three-ws-model-weights` bucket is
mounted at `/weights`, so a weight refresh needs no rebuild.

## Deploy

```bash
gcloud builds submit --config workers/model-trellis/cloudbuild.yaml workers/model-trellis
```

Deploys Cloud Run service `model-trellis` in `us-central1`: 1× `nvidia-l4`, 8 vCPU,
32 GiB, 900 s timeout, `min-instances=1` (a cold start pays a multi-minute weight
load, so one instance stays warm), `max-instances=2`.

## Callers

Reached via `GCP_RECONSTRUCTION_URL` through the
[avatar-pipeline-controller](../avatar-pipeline-controller/), which routes mesh
generation and then hands the result to [unirig](../unirig/) for rigging.

## Local

```bash
cd workers/model-trellis
pip install -r requirements.txt
API_KEY=dev GCS_BUCKET=your-dev-bucket WEIGHTS_DIR=/path/to/trellis-large \
  uvicorn main:app --port 8080
```

Needs a CUDA GPU and the TRELLIS weights on disk. `GET /health` reports
`gpu_available: false` on a CPU-only box, and inference will fail there.
