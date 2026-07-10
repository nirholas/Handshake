# unirig — auto-rigging (skeleton, skin weights, blendshapes)

Takes a raw mesh from one of the 3D generation models and makes it animation-ready.
Wraps [UniRig](https://github.com/VAST-AI-Research/UniRig) (VAST-AI, MIT,
SIGGRAPH 2025), which predicts:

- humanoid skeleton joint placement,
- per-vertex skinning weights,
- ARKit-52 blendshapes, transferred from a template head mesh.

The output GLB drops straight into the three.ws animation library — bone names are
canonicalized on import by [`src/glb-canonicalize.js`](../../src/glb-canonicalize.js),
so the pre-baked clips retarget onto it, legs included.

## API

All routes require `Authorization: Bearer $API_KEY`, except `/health`.

### `POST /rig` → `202`

```bash
curl -X POST https://$SERVICE_URL/rig \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"mesh_gcs_url":"https://storage.googleapis.com/…/mesh.glb","blendshapes":true}'
# → { "task_id": "…", "status": "queued" }
```

| Field | Required | Notes |
|---|---|---|
| `mesh_gcs_url` | yes | The unrigged mesh to rig |
| `template` | no | Template head mesh used for blendshape transfer |
| `blendshapes` | no | Set `false` to skip ARKit-52 transfer and rig faster |
| `job_id` | no | Echoed back for correlation |

The URL is fetched through the SSRF guard in [`worker_security.py`](./worker_security.py).

### `GET /tasks/{task_id}`

```json
{ "task_id": "…", "status": "succeeded", "rigged_gcs_url": "https://storage.googleapis.com/…/rigged.glb" }
```

Note the field is `rigged_gcs_url`, not the `result_gcs_url` the mesh workers return.

### `GET /health`

```json
{ "ok": true, "model": "unirig", "gpu_available": true }
```

## Env

| Var | Required | Default | Notes |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret (Secret Manager: `avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | — | Output bucket (`three-ws-avatar-reconstructions`) |
| `WEIGHTS_DIR` | no | `/weights/unirig` | Weights, from the mounted GCS volume |
| `MAX_CONCURRENT` | no | `1` | One L4 fits one rig |

## Deploy

```bash
gcloud builds submit --config workers/unirig/cloudbuild.yaml workers/unirig
```

Cloud Run service `unirig` in `us-central1`: 1× `nvidia-l4`, 4 vCPU, 16 GiB, 900 s
timeout, `min-instances=1` (kept warm — it is on the critical path of every avatar
generation), `max-instances=2`.

> **Deploy trap:** point `GCP_UNIRIG_URL` at *this* service. Sending rig calls to
> the `three-ws-avatar-reconstructions` service instead returns a 404 — the two
> are separate Cloud Run services that share only a GCS bucket name.

## Callers

`GCP_UNIRIG_URL`, called by the [avatar-pipeline-controller](../avatar-pipeline-controller/)
after a mesh backend returns. Set `SKIP_RIGGING=true` on the controller to bypass it.

## Tests

`rig_glb.py` holds the rigging logic; `test_rig_glb.py` covers it.

```bash
cd workers/unirig && python -m pytest test_rig_glb.py
```

## Local

```bash
cd workers/unirig
pip install -r requirements.txt
API_KEY=dev GCS_BUCKET=your-dev-bucket WEIGHTS_DIR=/path/to/unirig \
  uvicorn main:app --port 8080
```

Requires a CUDA GPU and local weights.
