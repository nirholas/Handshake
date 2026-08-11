# model-triposg — image / sketch → 3D shape (TripoSG)

FastAPI inference service producing **high-fidelity geometry from a single image
*or* a rough sketch**, using [TripoSG](https://github.com/VAST-AI-Research/TripoSG)
(VAST-AI, MIT) — a 1.5 B-parameter rectified-flow transformer. It is the quality
successor to [model-triposr](../model-triposr/): same input contract, markedly
better geometry. **Geometry only — no textures.** Pair it with
[texture](../texture/) to get a textured GLB.

Two modes share the one `/infer` endpoint:

| Mode | Input | Pipeline | Settings |
|---|---|---|---|
| `image` (default) | one photo | `TripoSGPipeline` | 50 steps, guidance 7.0; RMBG-1.4 background removal in-process |
| `scribble` | sketch + text prompt | `TripoSGScribblePipeline` | CFG-distilled, 16 steps, guidance 0; `scribble_confidence` sets the sketch-adherence cross-attention scale |

The scribble pipeline loads lazily on the first scribble request, so an
image-only instance pays for one model on cold start. Meshes are optionally
decimated to `target_polycount` (quadric edge-collapse) before export. Mode
routing, the prompt gate, and both sets of sampler settings live in
[`request_policy.py`](./request_policy.py), which imports no torch and no CUDA
so every one of those decisions is unit tested on any machine.

Work is asynchronous: `POST /infer` returns `202` with a `task_id`; poll
`GET /tasks/{id}` until the GLB is written to
`gs://$GCS_BUCKET/raw-meshes/triposg/{task_id}.glb`.

Task records are durable, not instance-local. Cloud Run runs this service across
up to `max-instances` containers with no session affinity, so a submit and a
later poll routinely land on different containers. Every state transition is
written to `gs://$GCS_BUCKET/tasks/{task_id}.json`, which is the source of truth
the poll reads; the in-process dict is only a cache that saves a round trip when
a poll happens to hit the container that ran the job.

## Endpoints

`POST /infer` and `GET /tasks/{id}` require `Authorization: Bearer $API_KEY`.
`GET /health` and `GET /` are unauthenticated.

### `POST /infer` → `202`

Request (`InferRequest`):

```json
{
	"images": ["https://three.ws/avatars/thumbs/default.png"],
	"mode": "image",
	"prompt": "",
	"scribble_confidence": 0.4,
	"target_polycount": null,
	"body_type": "neutral",
	"job_id": "abc123"
}
```

- `images` — 1 to 6 entries, `data:image/…;base64,…` URI or `https://` URL. **Only
  the first is used.** `https` sources go through the SSRF guard in
  [`worker_security.py`](./worker_security.py).
- `mode` — `"image"` (default) or `"scribble"`. Any other value falls back to `image`.
- `prompt` — text conditioning. **Required in scribble mode** — an empty prompt in
  scribble mode returns `422`. Ignored in image mode.
- `scribble_confidence` — `0.0`–`1.0` (default `0.4`); scribble mode only.
- `target_polycount` — optional `100`–`1000000` face budget for decimation.
- `body_type`, `job_id` — optional.

Image mode strips the photographic background in-process with RMBG-1.4, so callers
do not need to pre-run [rembg](../rembg/). Scribble mode flattens alpha onto white
(no background removal — a sketch has none).

Response (the persisted task record, `updated_at` in epoch seconds):

```json
{ "task_id": "3f2c…", "status": "queued", "model": "triposg", "mode": "image", "updated_at": 1786411000.42 }
```

### `GET /tasks/{task_id}`

`status` is one of `queued` → `running` → `done`, or `failed`.

```json
{
	"task_id": "3f2c…",
	"status": "done",
	"model": "triposg",
	"mode": "image",
	"result_gcs_url": "https://storage.googleapis.com/three-ws-avatar-reconstructions/raw-meshes/triposg/3f2c….glb",
	"elapsed_ms": 38110,
	"updated_at": 1786411038.55
}
```

Failures carry a sanitized `error`. An id with no record in memory and none in
GCS returns `404`; a GCS lookup that fails for any other reason returns `502`
(never a `404`, which a caller would read as "this task never existed"). A
`queued` or `running` record that has not advanced in 30 minutes is expired to
`failed` on the next poll: its runner container is gone, so the alternative is a
client that polls forever.

### `GET /health`

```json
{
	"ok": true,
	"model": "triposg",
	"gpu_available": true,
	"gpu_name": "NVIDIA L4",
	"model_loaded": true,
	"scribble_loaded": false,
	"ready": true,
	"load_error": null
}
```

`ok` is `false` once the background model load has failed. The container stays
up and listening in that state (Cloud Run has nothing to restart), so `ok` and
`load_error` are the only way to tell a warming instance from a broken one:
`ready: false, load_error: null` is still loading, `load_error: "…"` is broken
and every task submitted to it fails immediately with that reason.

### `GET /`

A service descriptor: `service`, `model`, `modes`, `ready`, `endpoints`.
Unauthenticated and free. This is the route the platform's liveness probes hit
([`api/_lib/forge-health.js`](../../api/_lib/forge-health.js),
[`api/_lib/forge-lane-health.js`](../../api/_lib/forge-lane-health.js), and
[`api/cron/gpu-keepwarm.js`](../../api/cron/gpu-keepwarm.js) all GET the worker
root and treat any status under 500 as "up").

## Environment

| Var | Required | Default | Purpose |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret (Secret Manager `avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | — | Output bucket (`three-ws-avatar-reconstructions`) |
| `WEIGHTS_DIR` | no | `/weights/triposg` | Image-mode weights |
| `SCRIBBLE_WEIGHTS_DIR` | no | `/weights/triposg-scribble` | Scribble-mode weights |
| `RMBG_WEIGHTS_DIR` | no | `/weights/rmbg-1.4` | In-process background remover |
| `MAX_CONCURRENT` | no | `1` | One L4 fits one inference |
| `WEIGHTS_GCS_URI` | no | unset | `gs://` prefix of the image-mode tree, staged to local disk before loading |
| `SCRIBBLE_WEIGHTS_GCS_URI` | no | unset | Same, for the scribble tree |
| `RMBG_WEIGHTS_GCS_URI` | no | unset | Same, for RMBG-1.4 |
| `WEIGHTS_LOCAL_ROOT` | no | `/tmp/triposg-weights` | Where the staged copies land |

All three weight sets live in the `three-ws-model-weights` bucket, mounted at
`/weights` (see [`workers/deploy/stage-weights.sh`](../deploy/stage-weights.sh)):
`VAST-AI/TripoSG`, `VAST-AI/TripoSG-scribble`, and `briaai/RMBG-1.4`.

**Weight staging.** Reading a multi-GiB tree through the GCS FUSE mount stalls a
cold instance for many minutes (revision 00006 sat in `from_pretrained` for over
10 minutes streaming 7.4 GiB), so when the three `*_GCS_URI` vars are set the
loader downloads each tree to `WEIGHTS_LOCAL_ROOT` with an 8-way parallel
storage client first and loads from there. Measured on the live service: 11.78
GiB in 208 s for the image tree, 0.78 GiB in 15 s for RMBG. Staging never fails a
boot; if it cannot run, loading falls back to the FUSE mount exactly as before.
The cloudbuild config sets all four vars, so a normal deploy gets the fast path.

## Run locally

Requires a CUDA GPU and the weights on disk. TripoSG is cloned into the image and
compiles the `diso` CUDA extension at build time, so the reproducible path is the
image:

```bash
cd workers/model-triposg
docker build -t model-triposg .

docker run --rm --gpus all -p 8080:8080 \
	-e API_KEY=dev-secret \
	-e GCS_BUCKET=your-dev-bucket \
	-e GOOGLE_APPLICATION_CREDENTIALS=/gcp/sa.json \
	-v /path/to/weights:/weights:ro \
	-v /path/to/sa.json:/gcp/sa.json:ro \
	model-triposg
```

With the TripoSG environment already on `PYTHONPATH` you can run the server directly:

```bash
API_KEY=dev-secret GCS_BUCKET=your-dev-bucket \
	WEIGHTS_DIR=/path/to/triposg SCRIBBLE_WEIGHTS_DIR=/path/to/triposg-scribble \
	RMBG_WEIGHTS_DIR=/path/to/rmbg-1.4 \
	uvicorn main:app --host 0.0.0.0 --port 8080
```

## Tests

Two layers, both free of GPU, weights, and credentials:

```bash
# Routing, the scribble prompt gate, sampler settings, decimation guard.
# Pure python, runs anywhere.
python3 workers/model-triposg/test_request_policy.py

# The served contract against the real dependency set. Ships in the image.
docker run --rm model-triposg python3 test_app_contract.py
```

The second one is the regression gate that matters most here: revisions 00001
and 00002 of this service died at import time on a bad transitive resolve of
`transformers` / `diffusers` / `peft`, before the container could bind `$PORT`,
which surfaces only as an opaque Cloud Run startup-probe failure. It imports
both pipelines and both preprocessing helpers, so that failure becomes a red
test instead of a dead revision.

## Deploy

Submit from the **repo root** (the build step declares `dir: workers/model-triposg`,
so the upload source is the whole repo). A manual submit has no `SHORT_SHA`, and
the config tags images with it, so pass one:

```bash
gcloud builds submit --config workers/model-triposg/cloudbuild.yaml \
	--region us-central1 --project aerial-vehicle-466722-p5 \
	--substitutions=SHORT_SHA=manual$(date +%s) .
```

Or provision it alongside the fleet (idempotent; prints the URLs to set on the
`three-ws-api` env). Valid `SERVICES` names are `hunyuan3d trellis triposr
triposg rig`:

```bash
PROJECT_ID=<gcp-project> SERVICES="hunyuan3d trellis triposg rig" \
	workers/deploy/deploy-all.sh
```

Deploys Cloud Run service **`model-triposg`** in `us-central1`: **1× `nvidia-l4`
GPU**, 8 vCPU, 32 GiB, 900 s request timeout, `min-instances=0`, `max-instances=2`.
Build `timeout` is `3600s` (the `diso` CUDA compile). Weights bucket mounted at
`/weights`; `API_KEY` from the `avatar-reconstruction-key` secret.

## Example: submit, poll, fetch

```bash
BASE=https://model-triposg-xxxxxxxx-uc.a.run.app
KEY=your-api-key

TASK=$(curl -s -X POST "$BASE/infer" \
	-H "Authorization: Bearer $KEY" \
	-H 'Content-Type: application/json' \
	-d '{"images":["https://three.ws/avatars/thumbs/default.png"],"mode":"image"}' \
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

For scribble mode, send your own drawing as a data URI and name what it depicts
(the prompt is required, and the request is otherwise identical):

```bash
SKETCH="data:image/png;base64,$(base64 -w0 owl-sketch.png)"
curl -s -X POST "$BASE/infer" \
	-H "Authorization: Bearer $KEY" \
	-H 'Content-Type: application/json' \
	-d "{\"images\":[\"$SKETCH\"],\"mode\":\"scribble\",\"prompt\":\"a brass steampunk owl\",\"scribble_confidence\":0.4}"
```

## How three.ws calls it

- **Forge sketch→3D** — [`api/_providers/gcp.js`](../../api/_providers/gcp.js) and
  [`api/forge.js`](../../api/forge.js) read **`GCP_TRIPOSG_URL`** and route the
  `sketch` mode here (scribble pipeline). It is the *sole* lane for that path — a
  failure returns a designed, retryable error rather than falling through to
  another lane. Declared in [`api/_lib/forge-tiers.js`](../../api/_lib/forge-tiers.js)
  with `requiresEnv: ['GCP_TRIPOSG_URL', 'GCP_RECONSTRUCTION_KEY']`.
- **[avatar-pipeline-controller](../avatar-pipeline-controller/)** reads
  **`MODEL_TRIPOSG_URL`** and uses image mode as one of its weighted mesh backends.

Both share the platform-side bearer secret `GCP_RECONSTRUCTION_KEY`, which must
equal this service's `API_KEY`.
