# rembg: background removal service

FastAPI service that **strips the background from an image and returns a
transparent PNG**. It wraps the [`rembg`](https://github.com/danielgatis/rembg)
library (MIT) and its ONNX salient-object-detection models: `u2net`,
`isnet-general-use`, `u2net_human_seg`, and `silueta`. The default model is
`isnet-general-use`; the legacy aliases `rmbg2` and `isnet` resolve to it, so
older callers keep working. Every mesh backend reconstructs better geometry from
a cleanly cut-out subject, so this runs ahead of the image-to-3D models (except
[model-triposg](../model-triposg/), which removes backgrounds in-process).

**No GPU required.** Inference runs on ONNX Runtime's CPU provider: about 1 s
per removal with `u2net` and 2 s with `isnet-general-use` at 640px, and about
2.3 s for `isnet-general-use` on a 12 MP photo (measured on 2 cores; the
deployed service has 4). Only the default model is warmed at startup; the others
load lazily on first use, so cold starts stay fast.

Work is asynchronous: `POST /remove` returns `202` with a `task_id`; poll
`GET /tasks/{id}` until the PNG is written to
`gs://$GCS_BUCKET/rembg/{task_id}.png` and served back as an
`https://storage.googleapis.com/…` URL.

## Endpoints

`POST /remove` and `GET /tasks/{id}` require `Authorization: Bearer $API_KEY`;
a missing or wrong one is a `401`. `GET /health` is unauthenticated.

### `POST /remove` → `202`

Request (`RemoveRequest`):

```json
{
	"image": "https://three.ws/avatars/thumbs/default.png",
	"model": "rmbg2"
}
```

- `image`: a single `data:image/…;base64,…` URI or an `https://` URL (**required**).
  `https` sources go through the SSRF guard in
  [`worker_security.py`](./worker_security.py) (https-only; private, loopback,
  link-local, and cloud-metadata IPs rejected on every redirect hop; response
  capped at 16 MiB). The fetch identifies itself as
  `three.ws-rembg/1.0 (background removal worker; +https://three.ws)`, which is
  what hosts like Wikimedia require before they will serve a bot.
- `model`: optional, default `"rmbg2"`. One of `u2net`, `isnet-general-use`,
  `u2net_human_seg`, `silueta`, or the aliases `rmbg2` / `isnet`
  (which resolve to `isnet-general-use`). Unknown names fall back to the default
  model. Pick `u2net_human_seg` for people: it is trained on human matting.

Response (the returned `model` is the resolved canonical name):

```json
{ "task_id": "3f2c…", "status": "queued", "model": "isnet-general-use" }
```

EXIF orientation is honored, so a phone photo comes back the way up its owner
took it rather than on its side.

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
	"elapsed_ms": 2480
}
```

Unknown ids return `404`. A failure carries an `error` string: when the fault is
in the submitted image (a URL that 404s or 403s, a file that is not an image, a
data URI that is not valid base64) the message says exactly that, so the caller
can fix their input. Anything else returns an opaque
`internal error (ref <id>)`, with the full traceback and matching id in this
service's logs.

Task state is in-memory: it does not survive a restart or scale-to-zero, a
finished task stays pollable for an hour, and the map is capped at 2000 entries
(oldest finished evicted first, never one still queued or running).

### `GET /health`

```json
{
	"ok": true,
	"service": "rembg",
	"gpu_available": false,
	"execution_providers": ["AzureExecutionProvider", "CPUExecutionProvider"],
	"models_loaded": ["isnet-general-use"],
	"models_available": ["u2net", "isnet-general-use", "u2net_human_seg", "silueta"],
	"default_model": "isnet-general-use",
	"tasks_tracked": 0,
	"task_retention_s": 3600.0,
	"max_tasks": 2000
}
```

`models_loaded` vs `models_available` shows the lazy-load state.
`execution_providers` is what ONNX Runtime offers in this build, and
`gpu_available` is true only when one of them is an accelerator.

## Environment

| Var | Required | Default | Purpose |
|---|---|---|---|
| `API_KEY` | yes | none | Shared bearer secret (Secret Manager `avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | none | Cloud Storage bucket for output PNGs (`three-ws-avatar-reconstructions`) |
| `MODEL` | no | `isnet-general-use` | Startup default model, resolved through the alias table (prod sets `rmbg2`, which resolves to `isnet-general-use`) |
| `MAX_CONCURRENT` | no | `4` | In-flight removals allowed at once (CPU-bound, so several fit) |

Weights for the two startup-capable models are **baked into the image** at build
time (the Dockerfile pre-caches `u2net` and `isnet-general-use` into
`/root/.u2net/`), so no GCS weights volume is mounted and cold starts do not hit
the network. `u2net_human_seg` and `silueta` download on first request.

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
docker build -t rembg-service workers/rembg
docker run --rm -p 8080:8080 \
	-e API_KEY=dev-secret \
	-e GCS_BUCKET=your-dev-bucket \
	-e GOOGLE_APPLICATION_CREDENTIALS=/gcp/sa.json \
	-v /path/to/sa.json:/gcp/sa.json:ro \
	rembg-service
```

## Tests

```bash
python3 workers/rembg/test_rembg_policy.py    # request policy, stdlib only
API_KEY=x GCS_BUCKET=x python3 workers/rembg/test_rembg_smoke.py   # real cutout
```

[`test_rembg_policy.py`](test_rembg_policy.py) covers the pure rules in
[`rembg_policy.py`](rembg_policy.py): model-alias resolution and the task
retention policy. It needs nothing but the standard library.
[`test_rembg_smoke.py`](test_rembg_smoke.py) is the core-path test: it cuts a
subject out with both baked-in models and asserts the corners came back
transparent and the subject opaque, plus that bad input is rejected with a
caller-readable reason. It needs `requirements.txt` and the weights, but no GPU,
no network and no GCP credentials.

Both run inside `docker build` as a gate, so an image that cannot remove a
background does not get pushed.

## Deploy

Submit from the **repo root**: the build step declares `dir: workers/rembg`, so
the upload source is the whole repo.

```bash
gcloud builds submit --config workers/rembg/cloudbuild.yaml . \
	--region us-central1 --project aerial-vehicle-466722-p5 \
	--substitutions=SHORT_SHA=manual$(date +%s)
```

Deploys Cloud Run service **`rembg-service`** in `us-central1`: **CPU only** (no
GPU), 4 vCPU, 8 GiB, 60 s request timeout, `min-instances=1` (kept warm, see the
rationale in [`cloudbuild.yaml`](cloudbuild.yaml)), `max-instances=4`. Env is set
to `MODEL=rmbg2`, `MAX_CONCURRENT=4`; `API_KEY` comes from the
`avatar-reconstruction-key` secret. `SHORT_SHA` is only substituted automatically
for trigger builds, hence the explicit value on a manual submit.

## Example: submit, poll, fetch

```bash
BASE=https://rembg-service-93741856042.us-central1.run.app
KEY=$(gcloud secrets versions access latest --secret=avatar-reconstruction-key \
	--project aerial-vehicle-466722-p5)

TASK=$(curl -s -X POST "$BASE/remove" \
	-H "Authorization: Bearer $KEY" \
	-H 'Content-Type: application/json' \
	-d '{"image":"https://three.ws/brand/three-ws-mark.png","model":"u2net_human_seg"}' \
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
