# rembg — background removal service

FastAPI service that **strips the background from an image and returns a
transparent PNG**. It wraps the [`rembg`](https://github.com/danielgatis/rembg)
library (MIT) and its ONNX salient-object-detection models — `u2net`,
`isnet-general-use`, `u2net_human_seg`, and `silueta`. The default model is
`isnet-general-use`; the legacy aliases `rmbg2` and `isnet` resolve to it, so
older callers keep working. Every mesh backend reconstructs better geometry from
a cleanly cut-out subject, so this runs ahead of the image→3D models (except
[model-triposg](../model-triposg/), which removes backgrounds in-process).

**No GPU required** — on CPU a 1024px image takes ~1–2 s; a GPU cuts that to
~0.2 s. Only the default model is warmed at startup; the others load lazily on
first use, so cold starts stay fast.

Work is asynchronous: `POST /remove` returns `202` with a `task_id`; poll
`GET /tasks/{id}` until the PNG is written to
`gs://$GCS_BUCKET/rembg/{task_id}.png` and served back as an
`https://storage.googleapis.com/…` URL.

## Endpoints

`POST /remove` and `GET /tasks/{id}` require `Authorization: Bearer $API_KEY`.
`GET /health` is unauthenticated.

### `POST /remove` → `202`

Request (`RemoveRequest`):

```json
{
	"image": "https://example.com/portrait.jpg",
	"model": "rmbg2"
}
```

- `image` — a single `data:image/…;base64,…` URI or an `https://` URL (**required**).
  `https` sources go through the SSRF guard in
  [`worker_security.py`](./worker_security.py) (https-only; private, loopback,
  link-local, and cloud-metadata IPs rejected on every redirect hop; response
  capped at 16 MiB).
- `model` — optional, default `"rmbg2"`. One of `u2net`, `isnet-general-use`,
  `u2net_human_seg`, `silueta`, or the aliases `rmbg2` / `isnet`
  (→ `isnet-general-use`). Unknown names fall back to the default model. Pick
  `u2net_human_seg` for people — it is trained on human matting.

Response (the returned `model` is the resolved canonical name):

```json
{ "task_id": "3f2c…", "status": "queued", "model": "isnet-general-use" }
```

### `GET /tasks/{task_id}`

`status` is one of `queued` → `running` → `done`, or `failed`.

```json
{
	"task_id": "3f2c…",
	"status": "done",
	"model": "isnet-general-use",
	"result_url": "https://storage.googleapis.com/three-ws-avatar-reconstructions/rembg/3f2c….png",
	"width": 1024,
	"height": 1024,
	"elapsed_ms": 1180
}
```

Failures carry a sanitized `error` string; unknown ids return `404`. Task state is
in-memory and does not survive a restart or scale-to-zero.

### `GET /health`

```json
{
	"ok": true,
	"service": "rembg",
	"gpu_available": false,
	"models_loaded": ["isnet-general-use"],
	"models_available": ["u2net", "isnet-general-use", "u2net_human_seg", "silueta"],
	"default_model": "isnet-general-use"
}
```

`models_loaded` vs `models_available` shows the lazy-load state.

## Environment

| Var | Required | Default | Purpose |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret (Secret Manager `avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | — | Cloud Storage bucket for output PNGs (`three-ws-avatar-reconstructions`) |
| `MODEL` | no | `isnet-general-use` | Startup default model, resolved through the alias table (prod sets `rmbg2` → `isnet-general-use`) |
| `MAX_CONCURRENT` | no | `4` | In-flight removals allowed at once (CPU-bound, so several fit) |

Model weights are **baked into the image** at build time (the Dockerfile pre-caches
`u2net` and `isnet-general-use` into `/root/.u2net/`), so no GCS weights volume is
mounted and cold starts do not hit the network.

## Run locally

`rembg` is pip-installable and runs on CPU, so no GPU is needed:

```bash
cd workers/rembg
pip install -r requirements.txt
API_KEY=dev-secret GCS_BUCKET=your-dev-bucket \
	uvicorn main:app --host 0.0.0.0 --port 8080
```

Or the exact production image:

```bash
cd workers/rembg
docker build -t rembg-service .

docker run --rm -p 8080:8080 \
	-e API_KEY=dev-secret \
	-e GCS_BUCKET=your-dev-bucket \
	-e GOOGLE_APPLICATION_CREDENTIALS=/gcp/sa.json \
	-v /path/to/sa.json:/gcp/sa.json:ro \
	rembg-service
```

## Deploy

Submit from the **repo root** — the build step declares `dir: workers/rembg`, so
the upload source is the whole repo:

```bash
gcloud builds submit --config workers/rembg/cloudbuild.yaml .
```

Deploys Cloud Run service **`rembg-service`** in `us-central1`: **CPU only** (no
GPU), 4 vCPU, 8 GiB, 60 s request timeout, `min-instances=0`, `max-instances=4`.
Env is set to `MODEL=rmbg2`, `MAX_CONCURRENT=4`; `API_KEY` comes from the
`avatar-reconstruction-key` secret.

## Example — submit, poll, fetch

```bash
BASE=https://rembg-service-xxxxxxxx-uc.a.run.app
KEY=your-api-key

TASK=$(curl -s -X POST "$BASE/remove" \
	-H "Authorization: Bearer $KEY" \
	-H 'Content-Type: application/json' \
	-d '{"image":"https://storage.googleapis.com/three-ws-public/samples/portrait.jpg","model":"u2net_human_seg"}' \
	| python3 -c 'import sys,json; print(json.load(sys.stdin)["task_id"])')

while :; do
	STATE=$(curl -s "$BASE/tasks/$TASK" -H "Authorization: Bearer $KEY")
	echo "$STATE"
	echo "$STATE" | grep -q '"status": *"done"' && break
	echo "$STATE" | grep -q '"status": *"failed"' && exit 1
	sleep 2
done

curl -s "$BASE/tasks/$TASK" -H "Authorization: Bearer $KEY" \
	| python3 -c 'import sys,json; print(json.load(sys.stdin)["result_url"])'
```

## How three.ws calls it

The platform points **`GCP_REMBG_URL`** at this service. It is wired in
[`api/_providers/gcp.js`](../../api/_providers/gcp.js) as the `rembg` mode and
invoked by [`api/forge-rembg.js`](../../api/forge-rembg.js), the `/forge`
background-removal feature (which errors clearly when `GCP_REMBG_URL` +
`GCP_RECONSTRUCTION_KEY` are unset). It shares the platform-side bearer secret
`GCP_RECONSTRUCTION_KEY`, which must equal this service's `API_KEY`.
