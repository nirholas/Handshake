# model-trellis — single image → textured 3D mesh (TRELLIS)

FastAPI inference service that turns **one image into a textured GLB** using
[Microsoft TRELLIS](https://github.com/microsoft/TRELLIS) (`TRELLIS-image-large`,
MIT license). TRELLIS represents shape and appearance as *structured latents*,
decodes them to both a Gaussian appearance field and a mesh, then fuses the two
into a single textured GLB (`postprocessing_utils.to_glb`, `simplify=0.95`,
`texture_size=1024`, fixed `seed=42`). It runs on one NVIDIA L4 (24 GB) on Cloud
Run and is the self-hosted TRELLIS mesh backend for the `/forge` image→3D lane.

Work is asynchronous: `POST /infer` returns `202` with a `task_id`, and the
caller polls `GET /tasks/{id}` until the mesh is written to Cloud Storage. The
finished GLB lands at `gs://$GCS_BUCKET/raw-meshes/trellis/{task_id}.glb` and is
served back as an `https://storage.googleapis.com/…` URL.

## Endpoints

`POST /infer` and `GET /tasks/{id}` require `Authorization: Bearer $API_KEY`.
`GET /health` is unauthenticated so Cloud Run's startup probe can reach it.

### `POST /infer` → `202`

Request:

```json
{
	"images": ["https://example.com/chair.png"],
	"body_type": "neutral",
	"job_id": "abc123"
}
```

- `images` — 1 to 6 entries, each a `data:image/…;base64,…` URI or an `https://`
  URL. **Only the first is used.** `https` sources are pulled through the SSRF
  guard in [`worker_security.py`](./worker_security.py) (https-only; private,
  loopback, link-local, and cloud-metadata IPs rejected on every redirect hop).
- `body_type` — optional, default `"neutral"` (accepted, not used by TRELLIS).
- `job_id` — optional correlation string.

Response:

```json
{ "task_id": "3f2c…", "status": "queued" }
```

### `GET /tasks/{task_id}`

Returns the live task record. `status` is one of `queued` → `running` → `done`,
or `failed`.

```json
{
	"task_id": "3f2c…",
	"status": "done",
	"model": "trellis-large",
	"result_gcs_url": "https://storage.googleapis.com/three-ws-avatar-reconstructions/raw-meshes/trellis/3f2c….glb",
	"elapsed_ms": 41230
}
```

On failure the record carries a sanitized `error` string (the full traceback
stays in the container log). Unknown ids return `404`.

### `GET /health`

```json
{
	"ok": true,
	"model": "trellis-image-large",
	"gpu_available": true,
	"gpu_name": "NVIDIA L4",
	"pipeline_loaded": true,
	"ready": true,
	"load_error": null
}
```

The ~3 GB pipeline loads in the background after the port opens, so a cold
instance reports `ready: false` briefly; `/infer` tasks submitted during that
window wait for `ready` (up to 600 s) rather than failing.

## Environment

| Var | Required | Default | Purpose |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret (Secret Manager `avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | — | Cloud Storage bucket for output meshes |
| `WEIGHTS_DIR` | no | `/weights/trellis-large` | Local path to TRELLIS weights (a mounted GCS volume in prod) |
| `MAX_CONCURRENT` | no | `1` | In-flight inferences; one L4 fits exactly one |
| `ATTN_BACKEND` | no | `xformers` | TRELLIS attention backend, read at import time |
| `SPCONV_ALGO` | no | `native` | Sparse-conv algorithm, read at import time |

Weights are **not** baked into the image — the `three-ws-model-weights` bucket
is mounted at `/weights`, so refreshing weights needs no rebuild. Pre-populate
once with:

```bash
pip install huggingface_hub
huggingface-cli download microsoft/TRELLIS-image-large --local-dir /tmp/trellis-large
gsutil -m cp -r /tmp/trellis-large gs://three-ws-model-weights/trellis-large/
```

## Run locally

Requires a CUDA GPU and the TRELLIS weights on disk. Dependencies are installed
in layered order **by the Dockerfile** (torch → basic → xformers/spconv/kaolin →
compiled CUDA extensions → server → TRELLIS source cloned to `/app/TRELLIS`);
`requirements.txt` is only a pointer. The reproducible way to run it is the image:

```bash
cd workers/model-trellis
docker build -t model-trellis .

docker run --rm --gpus all -p 8080:8080 \
	-e API_KEY=dev-secret \
	-e GCS_BUCKET=your-dev-bucket \
	-e WEIGHTS_DIR=/weights/trellis-large \
	-e GOOGLE_APPLICATION_CREDENTIALS=/gcp/sa.json \
	-v /path/to/trellis-large:/weights/trellis-large:ro \
	-v /path/to/sa.json:/gcp/sa.json:ro \
	model-trellis
```

On a box that already has the TRELLIS environment on `PYTHONPATH` you can run the
server directly:

```bash
API_KEY=dev-secret GCS_BUCKET=your-dev-bucket WEIGHTS_DIR=/path/to/trellis-large \
	uvicorn main:app --host 0.0.0.0 --port 8080
```

`GET /health` reports `gpu_available: false` on a CPU-only box and inference will
fail there.

## Deploy

Submit from the **repo root** — the build step declares `dir: workers/model-trellis`,
so the upload source is the whole repo:

```bash
gcloud builds submit --config workers/model-trellis/cloudbuild.yaml .
```

Or provision it alongside the rest of the fleet (idempotent; prints the URLs to
set on the `three-ws-api` service env):

```bash
PROJECT_ID=<gcp-project> SERVICES="hunyuan3d trellis triposg unirig" \
	workers/deploy/deploy-all.sh
```

Builds the image (CUDA extension compiles push the build past an hour — the
config sets `timeout: 3600s`) and deploys Cloud Run service **`model-trellis`**
in `us-central1`: **1× `nvidia-l4` GPU**, 8 vCPU, 32 GiB, 900 s request timeout,
`min-instances=1` (one instance stays warm because a cold start pays a
multi-minute weight load), `max-instances=2`. The weights bucket
(`three-ws-model-weights`) is mounted at `/weights` and `API_KEY` comes from the
`avatar-reconstruction-key` secret.

## Example — submit, poll, fetch

```bash
BASE=https://model-trellis-xxxxxxxx-uc.a.run.app
KEY=your-api-key

# 1. Submit
TASK=$(curl -s -X POST "$BASE/infer" \
	-H "Authorization: Bearer $KEY" \
	-H 'Content-Type: application/json' \
	-d '{"images":["https://storage.googleapis.com/three-ws-public/samples/chair.png"]}' \
	| python3 -c 'import sys,json; print(json.load(sys.stdin)["task_id"])')

# 2. Poll until done
while :; do
	STATE=$(curl -s "$BASE/tasks/$TASK" -H "Authorization: Bearer $KEY")
	echo "$STATE"
	echo "$STATE" | grep -q '"status": *"done"' && break
	echo "$STATE" | grep -q '"status": *"failed"' && exit 1
	sleep 5
done

# 3. Read the result URL
curl -s "$BASE/tasks/$TASK" -H "Authorization: Bearer $KEY" \
	| python3 -c 'import sys,json; print(json.load(sys.stdin)["result_gcs_url"])'
```

## How three.ws calls it

The platform points **`MODEL_TRELLIS_URL`** at this service. It is wired in
[`api/_providers/gcp.js`](../../api/_providers/gcp.js) as the `trellis` mode
(native single-image reconstruction, standard `/infer` + `/tasks/:id` shape) and
surfaced as the self-hosted TRELLIS `/forge` tier in
[`api/_lib/forge-tiers.js`](../../api/_lib/forge-tiers.js) (`requiresEnv:
['MODEL_TRELLIS_URL', 'GCP_RECONSTRUCTION_KEY']`). The
[avatar-pipeline-controller](../avatar-pipeline-controller/) also lists it as a
mesh backend via its own `MODEL_TRELLIS_URL`. All workers share the platform-side
bearer secret `GCP_RECONSTRUCTION_KEY`, which must equal this service's `API_KEY`.
