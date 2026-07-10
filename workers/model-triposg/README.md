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
decimated to `target_polycount` (quadric edge-collapse) before export.

Work is asynchronous: `POST /infer` returns `202` with a `task_id`; poll
`GET /tasks/{id}` until the GLB is written to
`gs://$GCS_BUCKET/raw-meshes/triposg/{task_id}.glb`.

## Endpoints

`POST /infer` and `GET /tasks/{id}` require `Authorization: Bearer $API_KEY`.
`GET /health` is unauthenticated.

### `POST /infer` → `202`

Request (`InferRequest`):

```json
{
	"images": ["https://example.com/owl.png"],
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

Response:

```json
{ "task_id": "3f2c…", "status": "queued", "model": "triposg", "mode": "image" }
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
	"elapsed_ms": 38110
}
```

Failures carry a sanitized `error`; unknown ids return `404`.

### `GET /health`

```json
{
	"ok": true,
	"model": "triposg",
	"gpu_available": true,
	"gpu_name": "NVIDIA L4",
	"model_loaded": true,
	"scribble_loaded": false
}
```

## Environment

| Var | Required | Default | Purpose |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret (Secret Manager `avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | — | Output bucket (`three-ws-avatar-reconstructions`) |
| `WEIGHTS_DIR` | no | `/weights/triposg` | Image-mode weights |
| `SCRIBBLE_WEIGHTS_DIR` | no | `/weights/triposg-scribble` | Scribble-mode weights |
| `RMBG_WEIGHTS_DIR` | no | `/weights/rmbg-1.4` | In-process background remover |
| `MAX_CONCURRENT` | no | `1` | One L4 fits one inference |

All three weight sets live in the `three-ws-model-weights` bucket, mounted at
`/weights` (see [`workers/deploy/stage-weights.sh`](../deploy/stage-weights.sh)):
`VAST-AI/TripoSG`, `VAST-AI/TripoSG-scribble`, and `briaai/RMBG-1.4`.

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

## Deploy

Submit from the **repo root** — the build step declares `dir: workers/model-triposg`,
so the upload source is the whole repo:

```bash
gcloud builds submit --config workers/model-triposg/cloudbuild.yaml .
```

Or provision it alongside the fleet (idempotent; prints the URLs to set on the
`three-ws-api` env):

```bash
PROJECT_ID=<gcp-project> SERVICES="hunyuan3d trellis triposg unirig" \
	workers/deploy/deploy-all.sh
```

Deploys Cloud Run service **`model-triposg`** in `us-central1`: **1× `nvidia-l4`
GPU**, 8 vCPU, 32 GiB, 900 s request timeout, `min-instances=0`, `max-instances=2`.
Build `timeout` is `3600s` (the `diso` CUDA compile). Weights bucket mounted at
`/weights`; `API_KEY` from the `avatar-reconstruction-key` secret.

## Example — sketch → 3D, submit, poll, fetch

```bash
BASE=https://model-triposg-xxxxxxxx-uc.a.run.app
KEY=your-api-key

TASK=$(curl -s -X POST "$BASE/infer" \
	-H "Authorization: Bearer $KEY" \
	-H 'Content-Type: application/json' \
	-d '{"images":["https://storage.googleapis.com/three-ws-public/samples/owl-sketch.png"],"mode":"scribble","prompt":"a brass steampunk owl"}' \
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
