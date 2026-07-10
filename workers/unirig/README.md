# unirig — auto-rigging (skeleton, skin weights, blendshapes)

Takes a raw, unrigged mesh from one of the 3D generation models and makes it
animation-ready. Wraps [UniRig](https://github.com/VAST-AI-Research/UniRig)
(VAST-AI, MIT, SIGGRAPH 2025), which predicts:

- humanoid skeleton joint placement,
- per-vertex skinning weights,
- ARKit-named blendshapes, transferred from a template head mesh.

It is the rigging stage of the avatar pipeline: the
[avatar-pipeline-controller](../avatar-pipeline-controller/) generates a mesh
(TRELLIS / Hunyuan3D / TripoSG / …) and then hands that mesh to this service to
get a rigged GLB back. The output drops straight into the three.ws animation
library — bone names are canonicalized on import by
[`src/glb-canonicalize.js`](../../src/glb-canonicalize.js), so the pre-baked
idle/walk clips retarget onto it, legs included.

The GPU inference (`main.py` → `_model.rig(...)`) is separated from the pure
glTF skin authoring (`rig_glb.py` → `build_rigged_glb`), which uses only
numpy/scipy/pygltflib/trimesh so it can be unit-tested with no GPU.

## API

FastAPI service on port `8080`. All routes require
`Authorization: Bearer $API_KEY` except `/health`. Jobs run in the background;
poll `/tasks/{id}` for the result.

### `POST /rig` → `202`

```bash
curl -X POST https://$SERVICE_URL/rig \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"mesh_gcs_url":"https://storage.googleapis.com/three-ws-avatar-reconstructions/…/mesh.glb","blendshapes":true}'
# → { "task_id": "…", "status": "queued" }
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `mesh_gcs_url` | yes | — | The unrigged mesh to rig |
| `template` | no | `wolf3d_neutral` | Template head mesh used for blendshape transfer |
| `blendshapes` | no | `true` | Set `false` to skip ARKit blendshape transfer and rig faster |
| `job_id` | no | — | Accepted for request-shape compatibility with the controller; not stored or echoed |

`mesh_gcs_url` is fetched through the SSRF guard in
[`worker_security.py`](./worker_security.py): https-only, private/loopback/
link-local/metadata IPs rejected after DNS resolution, redirects re-validated
per hop, response size bounded.

### `GET /tasks/{task_id}`

```json
{ "task_id": "…", "status": "done", "rigged_gcs_url": "https://storage.googleapis.com/three-ws-avatar-reconstructions/rigged-meshes/….glb", "elapsed_ms": 41200 }
```

`status` is `queued` | `running` | `done` | `failed`. On `failed` the object
carries a sanitized `error` string instead of `rigged_gcs_url`. Note the success
field is `rigged_gcs_url`, not the `result_gcs_url` the mesh workers return — the
controller reads either. Tasks are held in memory, so a `404` after a restart is
expected.

### `GET /health`

```json
{ "ok": true, "model": "unirig", "gpu_available": true, "gpu_name": "NVIDIA L4", "model_loaded": true }
```

## Env

| Var | Required | Default | Notes |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret (Secret Manager: `avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | — | Output bucket for rigged GLBs (`three-ws-avatar-reconstructions`) |
| `WEIGHTS_DIR` | no | `/weights/unirig` | UniRig weights, served from the mounted `three-ws-model-weights` GCS volume |
| `TEMPLATES_DIR` | no | `/app/templates` | Skeleton/blendshape templates |
| `MAX_CONCURRENT` | no | `1` | Parallel rig jobs — one L4 fits one rig |

## Deploy

Cloud Run service **`unirig`** in **`us-central1`**, built by Cloud Build from
[`cloudbuild.yaml`](./cloudbuild.yaml):

Submit from the **repo root** — the build step declares `dir: workers/unirig`, so
the upload source is the whole repo:

```bash
gcloud builds submit --config workers/unirig/cloudbuild.yaml .
```

The build compiles UniRig's CUDA ops (spconv / torch-scatter) from a
`cuda:12.1.1-cudnn8-devel` base, so it uses a 3600 s build timeout. The deployed
service runs 1× `nvidia-l4`, 4 vCPU, 16 GiB, 900 s request timeout,
`min-instances=1` (kept warm — it is on the critical path of every avatar
generation), `max-instances=2`, no CPU throttling. Model weights are populated
once into `gs://three-ws-model-weights/unirig/`:

```bash
pip install huggingface_hub
huggingface-cli download VAST-AI/UniRig --local-dir /tmp/unirig
gsutil -m cp -r /tmp/unirig gs://three-ws-model-weights/unirig/
```

> **Deploy trap:** point the caller env vars at *this* `unirig` service. The
> `three-ws-avatar-reconstructions` service exposes no `/rig`, so pointing a rig
> caller there returns 404 — the two are separate Cloud Run services that only
> share a GCS bucket name. See
> [`docs/ops/gcp-model-workers.md`](../../docs/ops/gcp-model-workers.md) and the
> production runbook [`docs/ops/gcp-production.md`](../../docs/ops/gcp-production.md).

## Callers

Two upstreams call `POST /rig` + `GET /tasks/{id}`:

- **[avatar-pipeline-controller](../avatar-pipeline-controller/)** via its
  `UNIRIG_URL` env var, after a mesh backend returns. Set `SKIP_RIGGING=true` on
  the controller to return the raw mesh and bypass this stage.
- **The platform API** rig provider ([`api/_providers/gcp.js`](../../api/_providers/gcp.js))
  via `GCP_UNIRIG_URL`, which powers the `rerig` path. Without it, `rerig` falls
  back to `GCP_RECONSTRUCTION_URL` (which has no `/rig`) and every rig submit
  404s.

Both authenticate with the shared `avatar-reconstruction-key` secret.

## Example — rig a mesh, poll, fetch

Feeds the GLB from a mesh worker (e.g. [model-trellis](../model-trellis/)) straight
into `/rig`:

```bash
BASE=https://unirig-xxxxxxxx-uc.a.run.app
KEY=your-api-key
MESH=https://storage.googleapis.com/three-ws-avatar-reconstructions/raw-meshes/trellis/3f2c….glb

TASK=$(curl -s -X POST "$BASE/rig" \
	-H "Authorization: Bearer $KEY" \
	-H 'Content-Type: application/json' \
	-d "{\"mesh_gcs_url\":\"$MESH\",\"blendshapes\":true}" \
	| python3 -c 'import sys,json; print(json.load(sys.stdin)["task_id"])')

while :; do
	STATE=$(curl -s "$BASE/tasks/$TASK" -H "Authorization: Bearer $KEY")
	echo "$STATE"
	echo "$STATE" | grep -q '"status": *"done"' && break
	echo "$STATE" | grep -q '"status": *"failed"' && exit 1
	sleep 5
done

curl -s "$BASE/tasks/$TASK" -H "Authorization: Bearer $KEY" \
	| python3 -c 'import sys,json; print(json.load(sys.stdin)["rigged_gcs_url"])'
```

## Tests

`rig_glb.py` holds the GPU-free glTF authoring; `test_rig_glb.py` covers it.

```bash
cd workers/unirig && python -m pytest test_rig_glb.py
```

## Run locally

Requires a CUDA GPU and local UniRig weights. UniRig compiles CUDA ops at install
time, so the reproducible path is the image:

```bash
cd workers/unirig
docker build -t unirig .

docker run --rm --gpus all -p 8080:8080 \
	-e API_KEY=dev-secret \
	-e GCS_BUCKET=your-dev-bucket \
	-e WEIGHTS_DIR=/weights/unirig \
	-e GOOGLE_APPLICATION_CREDENTIALS=/gcp/sa.json \
	-v /path/to/unirig:/weights/unirig:ro \
	-v /path/to/sa.json:/gcp/sa.json:ro \
	unirig
```

With the UniRig environment already installed you can run the server directly:

```bash
API_KEY=dev-secret GCS_BUCKET=your-dev-bucket WEIGHTS_DIR=/path/to/unirig \
	uvicorn main:app --host 0.0.0.0 --port 8080
```
