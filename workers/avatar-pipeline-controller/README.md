# avatar-pipeline-controller — mesh generation + auto-rigging orchestrator

The front door of the avatar pipeline. One call in, one rigged GLB out.

It routes a mesh job to whichever generation backend fits
([model-trellis](../model-trellis/), [model-hunyuan3d](../model-hunyuan3d/),
[model-triposg](../model-triposg/), [model-triposr](../model-triposr/)), then hands
the resulting mesh to [unirig](../unirig/) for skeleton, skinning weights, and
blendshapes — surfacing the whole thing as a single job the backend can poll.

It holds the same external API contract as the original `avatar-reconstruction`
service, so [`api/_providers/gcp.js`](../../api/_providers/gcp.js) needed no changes
when the pipeline was split into per-model services.

This is a **CPU-only orchestrator**: it holds no model weights and runs no
inference. All GPU work happens in the services it calls.

## API

All routes require `Authorization: Bearer $API_KEY`, except `/health`.

### `POST /reconstruct` → `202`

```bash
curl -X POST https://$SERVICE_URL/reconstruct \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"images":["https://example.com/person.png"],"body_type":"female"}'
# → { "job_id": "…", "status": "queued" }
```

`images` accepts `https://` URLs or `data:` URIs. `body_type` is optional.

### `GET /jobs/{job_id}`

```json
{
  "job_id": "…",
  "status": "succeeded",
  "glb_url": "https://storage.googleapis.com/…/rigged.glb",
  "updated_at": "2026-07-10T12:00:00Z",
  "model": "trellis"
}
```

`status` is `queued` | `running` | `succeeded` | `failed`; `model` names the backend
that produced the mesh, and `error` carries a sanitized message on failure.

Job state is persisted in Firestore, so a job survives an instance restart and any
instance can answer a poll.

### `GET /health`

```json
{ "ok": true, "models": { "trellis": true, "unirig": true }, "router": "…" }
```

Reports reachability of each downstream service — use it to tell "the pipeline is
down" apart from "one backend is cold".

## Env

| Var | Required | Default | Notes |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret (Secret Manager: `avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | — | Output bucket (`three-ws-avatar-reconstructions`) |
| `FIRESTORE_PROJECT` | yes | — | Project holding the job-state collection |
| `UNIRIG_URL` | yes | — | The [unirig](../unirig/) service (see its deploy trap) |
| `MODEL_WEIGHTS` | no | — | Backend routing weights |
| `SKIP_RIGGING` | no | `false` | `true` returns the raw mesh and skips [unirig](../unirig/) |

## Deploy

```bash
gcloud builds submit --config workers/avatar-pipeline-controller/cloudbuild.yaml \
  workers/avatar-pipeline-controller
```

Cloud Run service `avatar-pipeline-controller` in `us-central1`: no GPU, 2 vCPU,
2 GiB, 600 s timeout, `min-instances=1`, `max-instances=4`.

## Callers

`GCP_RECONSTRUCTION_URL` in [`api/_providers/gcp.js`](../../api/_providers/gcp.js).

## Local

```bash
cd workers/avatar-pipeline-controller
pip install -r requirements.txt
API_KEY=dev GCS_BUCKET=your-dev-bucket FIRESTORE_PROJECT=your-project \
  UNIRIG_URL=https://unirig-… uvicorn main:app --port 8080
```

No GPU needed. The downstream model services must be reachable, or `/health` will
report them down and `/reconstruct` jobs will fail.
