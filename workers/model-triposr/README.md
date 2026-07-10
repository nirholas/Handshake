# model-triposr — fast image → 3D mesh (TripoSR)

The lightest of the mesh backends. [TripoSR](https://github.com/VAST-AI-Research/TripoSR)
(VAST-AI / Stability AI, MIT) reconstructs a mesh from a single image in roughly
**5–15 seconds**.

It bakes vertex colors from one input view rather than producing PBR materials, so
fidelity trails the heavier backends [model-triposg](../model-triposg/) and
[model-trellis](../model-trellis/). Its job is to be the fast path and the fallback
for when those backends are cold, saturated, or failing.

## Role in the pipeline

`model-triposr` is one of the mesh backends the
[avatar-pipeline-controller](../avatar-pipeline-controller/) can dispatch to. The
controller registers it from the `MODEL_TRIPOSR_URL` env var, weight-selects a
backend per job (`MODEL_WEIGHTS`), POSTs the input images to `/infer`, then polls
`/tasks/:id` for the resulting GLB before handing it to the rigging stage. The
worker itself is a single FastAPI process (`main.py`) that loads TripoSR onto the
GPU at startup and serves the task API below.

## HTTP API

All routes require `Authorization: Bearer $API_KEY` except `/health`. Work is
asynchronous: `/infer` returns immediately with a `task_id`, and you poll
`/tasks/:id` until `status` is `done` or `failed`.

### `POST /infer` → `202`

```bash
curl -X POST "$SERVICE_URL/infer" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"images":["https://example.com/mug.png"],"job_id":"abc123"}'
# → { "task_id": "…", "status": "queued", "model": "triposr" }
```

Request body:

| Field | Type | Notes |
|---|---|---|
| `images` | string[] (1–6) | `https://` URLs or `data:image/…` URIs. Only the first is used. Remote URLs pass through the SSRF guard in [`worker_security.py`](./worker_security.py) (https-only; private/loopback/link-local/metadata IPs rejected after DNS; redirects re-validated per hop). |
| `body_type` | string | Optional, default `"neutral"`. |
| `job_id` | string | Optional caller correlation id. |

### `GET /tasks/{task_id}`

```json
{
  "task_id": "…",
  "status": "done",
  "model": "triposr",
  "result_gcs_url": "https://storage.googleapis.com/three-ws-avatar-reconstructions/raw-meshes/triposr/<task_id>.glb",
  "elapsed_ms": 9120
}
```

`status` moves `queued → running → done`, or `→ failed` with a sanitized `error`
string. On success `result_gcs_url` points at the uploaded GLB
(`raw-meshes/triposr/<task_id>.glb` in the output bucket). Tasks are held in
process memory, so an id is only resolvable for the lifetime of the instance that
created it. Unknown ids return `404`.

### `GET /health`

```json
{ "ok": true, "model": "triposr", "gpu_available": true, "gpu_name": "NVIDIA L4", "model_loaded": true }
```

Unauthenticated — this is the endpoint the controller's liveness probe hits.

## Environment

| Var | Required | Default | Notes |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret. In production from Secret Manager (`avatar-reconstruction-key`). |
| `GCS_BUCKET` | yes | — | Output bucket for meshes (`three-ws-avatar-reconstructions`). |
| `WEIGHTS_DIR` | no | `/weights/triposr` | TripoSR weights. In production this is the mounted `three-ws-model-weights` GCS volume. |
| `MAX_CONCURRENT` | no | `2` | Parallel inferences; the model is small enough to run two on one L4. |

## How it ships

Built by Cloud Build from [`cloudbuild.yaml`](./cloudbuild.yaml) and deployed as
the Cloud Run service **`model-triposr`** in **`us-central1`**: 1× `nvidia-l4`
GPU, 4 vCPU, 16 GiB, 900 s request timeout, `min-instances=0`, `max-instances=2`.
The `three-ws-model-weights` bucket is mounted at `/weights` as a Cloud Storage
volume; `API_KEY` comes from the `avatar-reconstruction-key` secret. GPU-backed
Cloud Run needs L4 quota in the region — see the model-worker ops runbook,
[`docs/ops/gcp-model-workers.md`](../../docs/ops/gcp-model-workers.md).

```bash
# from repo root
gcloud builds submit --config workers/model-triposr/cloudbuild.yaml workers/model-triposr
```

Or via the fleet helper (stages weights, then builds + deploys and writes the
controller's `MODEL_TRIPOSR_URL`):

```bash
HF_TOKEN=hf_xxx SERVICES="triposr" workers/deploy/stage-weights.sh
PROJECT_ID=<gcp-project> SERVICES="triposr" workers/deploy/deploy-all.sh
```

The container clones TripoSR at build time (it has no `setup.py`/`pyproject`, so
it is put on `PYTHONPATH` rather than pip-installed) and compiles its
`torchmcubes` CUDA extension for the L4 (`TORCH_CUDA_ARCH_LIST=8.9+PTX`), which is
why the build uses a CUDA `devel` base and a 3600 s Cloud Build timeout.

## Run locally

Requires a CUDA GPU and local weights.

```bash
cd workers/model-triposr
pip install -r requirements.txt
# fetch weights once (see the header of main.py):
#   huggingface-cli download stabilityai/TripoSR --local-dir /path/to/triposr
API_KEY=dev GCS_BUCKET=your-dev-bucket WEIGHTS_DIR=/path/to/triposr \
  uvicorn main:app --port 8080
```
