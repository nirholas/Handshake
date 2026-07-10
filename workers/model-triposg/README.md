# model-triposg — image / sketch → 3D shape (TripoSG)

High-fidelity geometry from a single image *or* a rough sketch, using
[TripoSG](https://github.com/VAST-AI-Research/TripoSG) (VAST-AI, MIT) — a 1.5 B
parameter rectified-flow transformer. It is the quality successor to
[model-triposr](../model-triposr/): same input contract, markedly better geometry.

**Geometry only — no textures.** Pair it with [texture](../texture/) to get a
textured GLB.

Two modes share one endpoint:

| Mode | Input | Pipeline | Used by |
|---|---|---|---|
| `image` | one image | `TripoSGPipeline` | avatar pipeline mesh backend |
| `scribble` | sketch + text prompt | `TripoSGScribblePipeline` (CFG-distilled, 16 steps) | the `/forge` sketch→3D path |

## API

All routes require `Authorization: Bearer $API_KEY`, except `/health`.

### `POST /infer` → `202`

Image mode:

```bash
curl -X POST https://$SERVICE_URL/infer \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"images":["https://example.com/owl.png"]}'
```

Scribble mode — pass a sketch plus the prompt that describes it:

```bash
curl -X POST https://$SERVICE_URL/infer \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"images":["data:image/png;base64,…"],"mode":"scribble","prompt":"a brass steampunk owl"}'
```

Both return `{ "task_id": "…", "status": "queued" }`. Remote URLs are fetched
through the SSRF guard in [`worker_security.py`](./worker_security.py).

Input images are background-removed in-process with RMBG-1.4 before inference, so
callers do not need to pre-strip backgrounds via [rembg](../rembg/).

### `GET /tasks/{task_id}`

```json
{ "task_id": "…", "status": "succeeded", "result_gcs_url": "https://storage.googleapis.com/…/mesh.glb" }
```

### `GET /health`

```json
{ "ok": true, "model": "triposg", "gpu_available": true }
```

## Env

| Var | Required | Default | Notes |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret (Secret Manager: `avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | — | Output bucket (`three-ws-avatar-reconstructions`) |
| `WEIGHTS_DIR` | no | `/weights/triposg` | Image-mode weights |
| `SCRIBBLE_WEIGHTS_DIR` | no | `/weights/triposg-scribble` | Scribble-mode weights |
| `RMBG_WEIGHTS_DIR` | no | `/weights/rmbg-1.4` | In-process background remover |
| `MAX_CONCURRENT` | no | `1` | One L4 fits one inference |

All three weight sets live in the `three-ws-model-weights` bucket, mounted at
`/weights`.

## Deploy

Ships as the Cloud Run service **`model-triposg`** in **`us-central1`**, built by
Cloud Build from [`cloudbuild.yaml`](./cloudbuild.yaml). Submit from the repo root
(the build step declares `dir: workers/model-triposg`, so the upload source is the
whole repo):

```bash
gcloud builds submit --config workers/model-triposg/cloudbuild.yaml .
```

Or provision it alongside the rest of the pipeline (idempotent; prints the URLs to
set on the `three-ws-api` service env):

```bash
PROJECT_ID=<gcp-project> SERVICES="hunyuan3d trellis triposg unirig" \
  workers/deploy/deploy-all.sh
```

The deployed service is 1× `nvidia-l4`, 8 vCPU, 32 GiB, 900 s timeout,
`min-instances=0`, `max-instances=2` (scale-to-zero — the first request after
idle pays a one-time model load). There are no GitHub Actions; the build runs on
Cloud Build only. See [`docs/ops/gcp-model-workers.md`](../../docs/ops/gcp-model-workers.md)
for the full lane-routing and operations runbook.

## Callers

- **Forge sketch→3D** (`api/_providers/gcp.js`, `api/forge.js`) reads
  **`GCP_TRIPOSG_URL`** — this is the sole lane for the `sketch` path, so a
  TripoSG failure returns a designed, retryable `503` rather than falling through
  to another lane.
- **[avatar-pipeline-controller](../avatar-pipeline-controller/)** reads
  **`MODEL_TRIPOSG_URL`** and uses image mode as one of its weighted mesh backends.

Both share the bearer secret `avatar-reconstruction-key` (Secret Manager),
surfaced to callers as `GCP_RECONSTRUCTION_KEY`.

## Local

```bash
cd workers/model-triposg
pip install -r requirements.txt
API_KEY=dev GCS_BUCKET=your-dev-bucket \
  WEIGHTS_DIR=/path/to/triposg SCRIBBLE_WEIGHTS_DIR=/path/to/triposg-scribble \
  RMBG_WEIGHTS_DIR=/path/to/rmbg-1.4 uvicorn main:app --port 8080
```

Requires a CUDA GPU and local weights.
