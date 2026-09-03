# model-trellis — single image → textured 3D mesh (TRELLIS)

FastAPI inference service that turns **one image into a textured GLB** using
[Microsoft TRELLIS](https://github.com/microsoft/TRELLIS) (`TRELLIS-image-large`,
MIT license). TRELLIS represents shape and appearance as *structured latents*,
decodes them to both a Gaussian appearance field and a mesh, then fuses the two
into a single textured GLB (`postprocessing_utils.to_glb`). Quality is tiered
(`draft` → `max`); the default bakes a 4096px texture and keeps most geometry,
and the `max` tier pushes the samplers to their ceiling and mattes the subject
first. It runs on one NVIDIA L4 (24 GB) on Cloud Run and is the self-hosted
TRELLIS mesh backend for the `/forge` image→3D lane.

Work is asynchronous: `POST /infer` returns `202` with a `task_id`, and the
caller polls `GET /tasks/{id}` until the mesh is written to Cloud Storage. The
finished GLB lands at `gs://$GCS_BUCKET/raw-meshes/trellis/{task_id}.glb` and is
served back as an `https://storage.googleapis.com/…` URL.

## Endpoints

`POST /infer` and `GET /tasks/{id}` require `Authorization: Bearer $API_KEY`.
`GET /health` and `GET /` are unauthenticated: they carry no secrets, and the
platform reads them to decide whether this lane can take work. Routing
([`api/_lib/forge-lane-health.js`](../../api/_lib/forge-lane-health.js),
[`api/_lib/forge-health.js`](../../api/_lib/forge-health.js)) reads `/health`,
because a worker whose weight load failed is reachable but unusable; the
keep-warm cron ([`api/cron/gpu-keepwarm.js`](../../api/cron/gpu-keepwarm.js))
pings the root. Cloud Run's own startup probe is a TCP check on port 8080, not
an HTTP one.

### `POST /infer` → `202`

Request:

```json
{
	"images": ["https://three.ws/avatars/thumbs/default.png"],
	"body_type": "neutral",
	"job_id": "abc123",
	"tier": "max",
	"matte": true,
	"rembg_model": "u2net_human_seg",
	"quality": { "texture_size": 4096 },
	"seed": 42
}
```

- `images` — 1 to 6 entries, each a `data:image/…;base64,…` URI or an `https://`
  URL. A single image reconstructs one asset; multiple entries are FUSED as
  turnaround views (front/side/back) of the **same** subject via
  `run_multi_image`. `https` sources are pulled through the SSRF guard in
  [`worker_security.py`](./worker_security.py) (https-only; private, loopback,
  link-local, and cloud-metadata IPs rejected on every redirect hop). Each fetch
  is retried up to 3 times with exponential backoff on a timeout, a connection
  failure, or a retryable upstream status (408/425/429/5xx); a 404 or 403 fails
  immediately because it will never succeed. When a source is genuinely
  unusable the task's `error` names the reason and the host instead of an
  opaque error ref, so the caller can fix the URL.
- `body_type` — optional, default `"neutral"` (accepted, not used by TRELLIS).
- `job_id` — optional correlation string.
- `tier` — optional named quality preset: `draft` | `standard` | `high` | `max`
  (see table below). Omitted keeps the historical default (equivalent to
  `high`). A `quality` dict still overrides individual fields on top of a tier.
- `matte` — optional. Run the subject through the sibling
  [`rembg-service`](../rembg/) before reconstruction so the background stops
  bleeding into the mesh. Defaults **on** for `tier: "max"`, **off** otherwise.
  Requires `REMBG_SERVICE_URL` to be set; if unset or the call fails, TRELLIS's
  own internal background removal still runs, so matting only ever improves the
  result, never gates it.
- `rembg_model` — optional model for the pre-matte: `isnet-general-use`
  (default), `u2net`, `u2net_human_seg` (best for people/portraits), `silueta`.
- `quality` — optional per-field override of the resolved tier (`ss_steps`,
  `slat_steps`, `ss_cfg`, `slat_cfg`, `simplify`, `texture_size`), each clamped
  to a safe L4 envelope.
- `seed` — optional deterministic sampling seed (default `42`).

### Quality tiers

| tier | ss/slat steps | ss/slat cfg | simplify (tris removed) | texture | matte default | use |
|---|---|---|---|---|---|---|
| `draft` | 12 / 12 | 7.5 / 3.0 | 0.95 | 1024 | off | fast previews / latency lane |
| `standard` | 25 / 25 | 7.5 / 3.0 | 0.90 | 2048 | off | balanced |
| `high` *(default)* | 40 / 40 | 7.5 / 3.0 | 0.75 | 4096 | off | production quality bar |
| `max` | 50 / 50 | 8.5 / 4.5 | 0.50 | 4096 | on | maximum realism (photo → 3D) |

`simplify` is the **fraction of triangles removed** by `to_glb`'s decimation, so
a lower value keeps more geometry: `max` keeps ~all of it. Steps drive both
diffusion stages (structure + structured-latent) and cost scales roughly
linearly with them; `max` runs both at the sampler ceiling. Cost is not the
constraint here (the L4 runs one job at a time against the platform's GCP credit
budget) — realism is.

### Image → 3D from a real user photo

The MAX tier is built for turning a real photo of an object or a person into a
textured 3D asset. For a clean reconstruction, matte the subject first: `matte:
true` sends the image to the sibling `rembg-service`, which returns an RGBA
cutout that TRELLIS uses directly as the subject mask (its alpha channel is
respected, bypassing a second internal rembg pass). For people, pass
`rembg_model: "u2net_human_seg"`. Send a single clear, front-facing photo; add
side/back views of the same subject to the `images` array to fill in geometry
the front view cannot see.

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

On failure the record carries an `error` string. A bad image source reports the
actual reason (`image source cdn.example.com unreachable after 3 attempts
(ReadTimeout); check the URL is publicly readable`) because the fault is in the
request; anything internal is reduced to a correlation-id ref with the full
traceback kept in the container log. A `queued` or `running` record that makes
no progress for 30 minutes is expired to `failed` so a client cannot poll
forever behind a dead runner. Unknown ids return `404`.

### `GET /health`

```json
{
	"ok": true,
	"model": "trellis-image-large",
	"gpu_available": true,
	"gpu_name": "NVIDIA L4",
	"pipeline_loaded": true,
	"ready": true,
	"load_error": null,
	"load_attempts": 1,
	"tiers": ["draft", "standard", "high", "max"],
	"default_quality": { "ss_steps": 40, "slat_steps": 40, "ss_cfg": 7.5, "slat_cfg": 3.0, "simplify": 0.75, "texture_size": 4096 },
	"rembg_matte": true
}
```

The ~3 GB pipeline loads in the background after the port opens, so a cold
instance reports `ready: false` briefly; `/infer` tasks submitted during that
window wait for `ready` (up to 600 s) rather than failing.

**A dead instance says so.** The load is retried (`MODEL_LOAD_ATTEMPTS`) before
its error is treated as terminal, because the failures that reach it are
transient upstream ones rather than code faults. While retries remain,
`load_error` stays `null` and jobs keep waiting on `ready`. Once the budget is
spent, `load_error` latches and this endpoint answers **`503` with
`"ok": false`**, `/infer` refuses new work with `503`, and the Cloud Run
liveness probe recycles the container.

That behaviour is the fix for the 2026-09-02 outage: a single transient
`HTTP Error 403: rate limit exceeded` during the load latched forever, `/health`
went on answering `ok: true`, `/infer` went on accepting jobs it could never
run, and `min-instances=1` kept the dead instance resident. The default free
image lane failed 70 of 219 generations over 12 hours while every status surface
read green. Callers rely on the `503` from `/infer`: it is what trips the lane
failover in `api/forge.js`, which reroutes the request to another backend
instead of letting it die at poll time.

### `GET /`

Unauthenticated service descriptor. It exists so a root ping stops recording a
404 in this service's log: there were 257 of those in the 24 h to 2026-08-11
against two real error events, which is how a genuine failure goes unnoticed.

```json
{
	"service": "model-trellis",
	"model": "trellis-image-large",
	"ready": true,
	"endpoints": ["POST /infer", "GET /tasks/{task_id}", "GET /health"]
}
```

## Environment

| Var | Required | Default | Purpose |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret (Secret Manager `avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | — | Cloud Storage bucket for output meshes |
| `WEIGHTS_DIR` | no | `/weights/trellis-large` | Local path to TRELLIS weights (a mounted GCS volume in prod) |
| `MAX_CONCURRENT` | no | `1` | In-flight inferences; one L4 fits exactly one |
| `ATTN_BACKEND` | no | `xformers` | TRELLIS attention backend, read at import time |
| `SPCONV_ALGO` | no | `native` | Sparse-conv algorithm, read at import time |
| `REMBG_SERVICE_URL` | no | — | Sibling [`rembg-service`](../rembg/) base URL for the `matte` pre-step. Unset disables matting (TRELLIS still removes the background internally). |
| `REMBG_MODEL` | no | `isnet-general-use` | Default rembg model for the pre-matte |
| `REMBG_TIMEOUT_S` | no | `90` | Max seconds to wait on the rembg-service round-trip before falling back to the un-matted image |
| `WEIGHTS_GCS_URI` | no | - | `gs://` weight tree staged to local disk at startup with the storage client. Set in production; see the note below |
| `WEIGHTS_LOCAL_DIR` | no | `/tmp/trellis-weights` | Where that staging lands, and what the pipeline then loads from |
| `IMAGE_FETCH_TIMEOUT_S` | no | `30` | Per-attempt timeout for fetching a caller-supplied `https://` image (3 attempts) |
| `MODEL_LOAD_ATTEMPTS` | no | `4` | Model-load attempts before `load_error` latches and the instance reports itself dead |
| `MODEL_LOAD_RETRY_BASE_S` | no | `15` | First load-retry backoff, doubling per attempt |
| `MODEL_LOAD_RETRY_CAP_S` | no | `120` | Ceiling on that backoff |
| `DINOV2_LOCAL_DIR` | no | `/opt/dinov2` | Image-baked dinov2 checkout used for TRELLIS's image conditioner, so the load never calls GitHub |
| `TORCH_HOME` | no | `/opt/torch` | Set in the image; holds the pre-baked `dinov2_vitl14_reg` checkpoint so `torch.hub` finds it cached |

Weights are **not** baked into the image — the `three-ws-model-weights` bucket
is mounted at `/weights`, so refreshing weights needs no rebuild.

At startup the loader **stages** that tree to local disk (`WEIGHTS_GCS_URI` →
`WEIGHTS_LOCAL_DIR`) with the storage client and loads from there. The GCS FUSE
mount serves the model's random-access reads over the network, and a cold load
routinely stalled on it (`stalled read-req cancelled`, `context deadline
exceeded`), turning a ~50 s load into 15+ minutes or a hard timeout; a plain
sequential GET per object does not. If `WEIGHTS_GCS_URI` is unset, or staging
fails for any reason, the loader falls back to reading `WEIGHTS_DIR` off the
mount, so this can only add reliability. Already-staged objects whose size
matches are reused, so a same-instance reload does not re-pull 3 GB.

Pre-populate the bucket once with:

```bash
pip install huggingface_hub
huggingface-cli download microsoft/TRELLIS-image-large --local-dir /tmp/trellis-large
gsutil -m cp -r /tmp/trellis-large gs://three-ws-model-weights/trellis-large/
```

## Tests

The request policy (quality tiers, the clamps that stop a caller value from
crashing the texture bake, the image-fetch retry) lives in
[`request_policy.py`](./request_policy.py), deliberately free of torch and CUDA
so it can be proven anywhere:

```bash
cd workers/model-trellis
python3 -m pip install pytest httpx
python3 -m pytest test_request_policy.py -q     # 18 tests
```

[`test_app_contract.py`](./test_app_contract.py) covers the served surface
instead, and needs the image's dependency set (torch, FastAPI, the cloned
TRELLIS tree), so it runs inside the container rather than on your machine:

```bash
docker run --rm model-trellis python3 test_app_contract.py
```

It asserts the TRELLIS import chain resolves (FlexiCubes submodule included, the
packaging bug that only ever surfaced minutes into a doomed revision), the auth
boundary rejects a wrong bearer, `/` and `/health` answer, `images` arrays
outside 1 to 6 entries are refused, and the SSRF guard rejects cleartext,
loopback, and metadata-server sources. No GPU, no weights, no credentials: the
ASGI lifespan is not started.

**Both suites run inside `docker build`** (see the `RUN` gate in the Dockerfile),
so a broken tier table, a bad dependency resolve, or a hole in the auth boundary
fails the build instead of a user's generation. The GPU-bound half of the
service is covered by the platform-side integration tests in
[`tests/api/forge-trellis-selfhost.test.js`](../../tests/api/forge-trellis-selfhost.test.js).

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
gcloud builds submit --config workers/model-trellis/cloudbuild.yaml . \
	--region us-central1 --project aerial-vehicle-466722-p5 \
	--substitutions=SHORT_SHA=manual$(date +%s)
```

`SHORT_SHA` is only populated automatically for trigger-driven builds; a manual
submit must pass it, because the config tags and deploys
`.../server:$SHORT_SHA`. The config also pins the `three-ws-build@` service
account (the project's default compute SA was deleted).

Or provision it alongside the rest of the fleet (idempotent; prints the URLs to
set on the `three-ws-api` service env). Valid service ids are exactly
`hunyuan3d trellis triposr triposg rig`:

```bash
PROJECT_ID=<gcp-project> SERVICES="hunyuan3d trellis triposg rig" \
	workers/deploy/deploy-all.sh
```

Builds the image (CUDA extension compiles push the build past an hour — the
config sets `timeout: 3600s`) and deploys Cloud Run service **`model-trellis`**
in `us-central1`: **1× `nvidia-l4` GPU**, 8 vCPU, 32 GiB, 900 s request timeout,
`min-instances=1` (one instance stays warm because a cold start pays a
multi-minute weight load), `max-instances=3`. Each instance serializes its own
GPU at `MAX_CONCURRENT=1`, so the instance count *is* the concurrent-generation
count. The weights bucket (`three-ws-model-weights`) is mounted at `/weights`
and `API_KEY` comes from the `avatar-reconstruction-key` secret.

## Example — submit, poll, fetch

```bash
BASE=https://model-trellis-xxxxxxxx-uc.a.run.app
KEY=your-api-key

# 1. Submit
TASK=$(curl -s -X POST "$BASE/infer" \
	-H "Authorization: Bearer $KEY" \
	-H 'Content-Type: application/json' \
	-d '{"images":["https://three.ws/avatars/thumbs/default.png"]}' \
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
