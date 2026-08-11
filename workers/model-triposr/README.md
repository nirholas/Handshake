# model-triposr: fast image to 3D mesh (TripoSR)

The lightest of the mesh backends. [TripoSR](https://github.com/VAST-AI-Research/TripoSR)
(VAST-AI / Stability AI, MIT) reconstructs a mesh from a single image in about
**3 seconds** of GPU work on a warm instance.

It bakes vertex colors from one input view rather than producing PBR materials, so
fidelity trails the heavier backends [model-triposg](../model-triposg/) and
[model-trellis](../model-trellis/). Its job is to be the fast path and the fallback
for when those backends are cold, saturated, or failing.

Measured against the deployed service on 2026-08-11, one 194 KB PNG in:

| Step | Time |
|---|---|
| Scale-from-zero cold start until `/health` answers | about 95 s |
| `/infer` end to end, warm instance | 3.2 s, a 755 KB GLB (18,865 vertices, `COLOR_0` baked) |

`min-instances=0`, so a request that arrives with no instance resident pays the
cold start on top of the inference. Callers that care about that keep the lane
warm (see [keep-warm](#keep-warm) below) or dispatch to it as a fallback only.

## Role in the pipeline

`model-triposr` is one of the mesh backends the
[avatar-pipeline-controller](../avatar-pipeline-controller/) can dispatch to. The
controller registers it from the `MODEL_TRIPOSR_URL` env var, weight-selects a
backend per job (`MODEL_WEIGHTS`), POSTs the input images to `/infer`, then polls
`/tasks/:id` for the resulting GLB before handing it to the rigging stage. The
worker itself is a single FastAPI process (`main.py`) that loads TripoSR onto the
GPU at startup and serves the task API below.

**Today that controller is not deployed**: there is no `avatar-pipeline-controller`
Cloud Run service, and the platform's `GCP_RECONSTRUCTION_URL` points at the
[avatar-reconstruction](../avatar-reconstruction/) worker instead. So nothing on
three.ws routes user jobs here right now; this service is reached directly at its
own URL with the shared bearer key, which is how the numbers above were measured.
Deploying the controller with `MODEL_TRIPOSR_URL` set is what re-opens the lane.

## HTTP API

All routes require `Authorization: Bearer $API_KEY` except `/health`. Work is
asynchronous: `/infer` returns immediately with a `task_id`, and you poll
`/tasks/:id` until `status` is `done` or `failed`.

### `POST /infer` → `202`

```bash
curl -X POST "$SERVICE_URL/infer" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"images":["https://three.ws/avatars/thumbs/default.png"],"job_id":"abc123"}'
# → { "task_id": "…", "status": "queued", "model": "triposr" }
```

Request body:

| Field | Type | Notes |
|---|---|---|
| `images` | string[] (1–6) | `https://` URLs or `data:image/…` URIs. Only the first is used. Remote URLs pass through the SSRF guard in [`worker_security.py`](./worker_security.py) (https-only; private/loopback/link-local/metadata IPs rejected after DNS; redirects re-validated per hop). |
| `body_type` | string | Optional, default `"neutral"`. |
| `job_id` | string | Optional caller correlation id. |

### `GET /tasks/{task_id}`

```json
{
  "task_id": "…",
  "status": "done",
  "model": "triposr",
  "result_gcs_url": "https://storage.googleapis.com/three-ws-avatar-reconstructions/raw-meshes/triposr/<task_id>.glb",
  "elapsed_ms": 9120
}
```

`status` moves `queued → running → done`, or `→ failed` with a sanitized `error`
string. On success `result_gcs_url` points at the uploaded GLB
(`raw-meshes/triposr/<task_id>.glb` in the output bucket). Tasks are held in
process memory, so an id is only resolvable for the lifetime of the instance that
created it. Unknown ids return `404`.

### `GET /health`

```json
{ "ok": true, "model": "triposr", "gpu_available": true, "gpu_name": "NVIDIA L4", "model_loaded": true }
```

Unauthenticated — this is the endpoint the controller's liveness probe hits.

## Environment

| Var | Required | Default | Notes |
|---|---|---|---|
| `API_KEY` | yes | — | Shared bearer secret. In production from Secret Manager (`avatar-reconstruction-key`). |
| `GCS_BUCKET` | yes | — | Output bucket for meshes (`three-ws-avatar-reconstructions`). |
| `WEIGHTS_DIR` | no | `/weights/triposr` | TripoSR weights. In production this is the mounted `three-ws-model-weights` GCS volume. |
| `MAX_CONCURRENT` | no | `2` | Parallel inferences; the model is small enough to run two on one L4. |
| `HF_HOME` | production | (unset) | `/weights/hf-cache`. TripoSR's image tokenizer is `facebook/dino-vitb16`, which transformers otherwise pulls from huggingface.co while the model loads. Set with `HF_HUB_OFFLINE` below. |
| `HF_HUB_OFFLINE` | production | (unset) | `1`. On 2026-07-28 the live pull was rate-limited on the shared Cloud Run egress IP and the revision crash looped; the files are staged in the weights bucket, so the worker reads them offline. |
| `U2NET_HOME` | no | `/opt/u2net` | Where rembg looks for its matting model. Baked into the image at build time; unset it only if you have staged the model elsewhere. |

`cloudbuild.yaml` passes `--set-env-vars`, which **replaces the whole env set**
rather than merging. Every var this worker needs therefore has to be in that one
flag, `HF_HOME` and `HF_HUB_OFFLINE` included. To change a single var on the
running service without a rebuild, use `gcloud run services update model-triposr
--region us-central1 --update-env-vars KEY=value`.

## How it ships

Built by Cloud Build from [`cloudbuild.yaml`](./cloudbuild.yaml) and deployed as
the Cloud Run service **`model-triposr`** in **`us-central1`**: 1× `nvidia-l4`
GPU, 4 vCPU, 16 GiB, 900 s request timeout, `min-instances=0`, `max-instances=2`.
The `three-ws-model-weights` bucket is mounted at `/weights` as a Cloud Storage
volume; `API_KEY` comes from the `avatar-reconstruction-key` secret. GPU-backed
Cloud Run needs L4 quota in the region, so see the model-worker ops runbook,
[`docs/ops/gcp-model-workers.md`](../../docs/ops/gcp-model-workers.md).

A second deployment of the same image runs in **`us-east4`** as a standby
(`https://model-triposr-93741856042.us-east4.run.app`). `cloudbuild.yaml` does
not manage it: it was deployed by hand from the `us-central1` image, so a rebuild
updates `us-central1` only and the standby has to be pointed at the new tag
explicitly with `gcloud run deploy model-triposr --region us-east4 --image ...`.

Submit from the **repo root** — the build step declares `dir: workers/model-triposr`,
so the upload source is the whole repo:

```bash
gcloud builds submit --config workers/model-triposr/cloudbuild.yaml .
```

Or via the fleet helper (stages weights, then builds + deploys and writes the
controller's `MODEL_TRIPOSR_URL`):

```bash
HF_TOKEN=hf_xxx SERVICES="triposr" workers/deploy/stage-weights.sh
PROJECT_ID=<gcp-project> SERVICES="triposr" workers/deploy/deploy-all.sh
```

The container clones TripoSR at build time (it has no `setup.py`/`pyproject`, so
it is put on `PYTHONPATH` rather than pip-installed) and compiles its
`torchmcubes` CUDA extension for the L4 (`TORCH_CUDA_ARCH_LIST=8.9+PTX`), which is
why the build uses a CUDA `devel` base and a 3600 s Cloud Build timeout.

## Run locally

Requires a CUDA GPU and local weights. TripoSR is cloned into the image and
compiles the `torchmcubes` CUDA extension at build time, so the reproducible path
is the image:

```bash
cd workers/model-triposr
docker build -t model-triposr .

docker run --rm --gpus all -p 8080:8080 \
	-e API_KEY=dev-secret \
	-e GCS_BUCKET=your-dev-bucket \
	-e WEIGHTS_DIR=/weights/triposr \
	-e GOOGLE_APPLICATION_CREDENTIALS=/gcp/sa.json \
	-v /path/to/triposr:/weights/triposr:ro \
	-v /path/to/sa.json:/gcp/sa.json:ro \
	model-triposr
```

With the TripoSR environment already on `PYTHONPATH`:

```bash
# fetch weights once (see the header of main.py):
#   huggingface-cli download stabilityai/TripoSR --local-dir /path/to/triposr
API_KEY=dev-secret GCS_BUCKET=your-dev-bucket WEIGHTS_DIR=/path/to/triposr \
	uvicorn main:app --host 0.0.0.0 --port 8080
```

## Tests

The pre-inference path (decode, matte to 3-channel RGB, output naming) and the
auth + SSRF guards run without a GPU, a model, or network egress, so they are a
plain unit suite. It needs only Pillow and httpx:

```bash
python3 workers/model-triposr/test_image_prep.py
# → 36 checks passed
```

The Dockerfile runs the same file as a build gate, so a regression in the matte
step (which broke every job in 2026-07 by handing TripoSR a 4-channel tensor)
fails the build instead of the next user's generation.

## Keep-warm: this lane stays cold on purpose

Both deployments run cold (`min-instances=0`) and that is deliberate. L4 quota is
granted per region (3 concurrent instances in each of `us-central1` and
`us-east4`), so anything held warm here is taken from a lane that has traffic.

The allowlist in [`api/cron/gpu-keepwarm.js`](../../api/cron/gpu-keepwarm.js)
spells out the same rule for `us-central1`: the `model-trellis` and `model-rig`
floors already hold 2 of the 3, so pinning a third would cap the workhorse lane
at its floor. Two leftovers that broke that rule were undone on 2026-08-11:

- The `model-triposr-warm` Cloud Scheduler job pinged `us-central1` `/health`
  every 10 minutes in peak hours. With no instance resident, each ping booted an
  L4 for a 95 s cold start and let it be reclaimed minutes later: about 144 GPU
  boots a day for a lane that had served no job in 30 days. The job is now
  **paused** (`gcloud scheduler jobs resume model-triposr-warm --location
  us-central1` brings it back if the lane ever carries traffic).
- The `us-east4` standby ran at `min-instances=1`, holding an L4 there around the
  clock. With `model-trellis` also pinned at 1, that left a single slot for
  `model-text2motion`, which is the region's actual production lane. The standby
  is now `min-instances=0`.

Re-pin either one only together with a quota increase, and say which lane is
giving up the slot.

## Example: submit, poll, fetch

```bash
BASE=https://model-triposr-xxxxxxxx-uc.a.run.app
KEY=your-api-key

TASK=$(curl -s -X POST "$BASE/infer" \
	-H "Authorization: Bearer $KEY" \
	-H 'Content-Type: application/json' \
	-d '{"images":["https://three.ws/avatars/thumbs/default.png"]}' \
	| python3 -c 'import sys,json; print(json.load(sys.stdin)["task_id"])')

while :; do
	STATE=$(curl -s "$BASE/tasks/$TASK" -H "Authorization: Bearer $KEY")
	echo "$STATE"
	echo "$STATE" | grep -q '"status": *"done"' && break
	echo "$STATE" | grep -q '"status": *"failed"' && exit 1
	sleep 3
done

curl -s "$BASE/tasks/$TASK" -H "Authorization: Bearer $KEY" \
	| python3 -c 'import sys,json; print(json.load(sys.stdin)["result_gcs_url"])'
```

## How three.ws calls it

TripoSR has no direct `/forge` lane of its own. It is dispatched through the
[avatar-pipeline-controller](../avatar-pipeline-controller/), which registers it
from **`MODEL_TRIPOSR_URL`** (see [`workers/avatar-pipeline-controller/main.py`](../avatar-pipeline-controller/main.py))
and weight-selects it as a mesh backend per job. The controller is reached from
the platform via `GCP_RECONSTRUCTION_URL` in
[`api/_providers/gcp.js`](../../api/_providers/gcp.js). This worker shares the
platform-side bearer secret `GCP_RECONSTRUCTION_KEY`, which must equal its `API_KEY`.

That is the wiring, not the current state: as noted under
[Role in the pipeline](#role-in-the-pipeline), the controller is not deployed and
`GCP_RECONSTRUCTION_URL` currently resolves to the `avatar-reconstruction`
service, so no platform request reaches this worker today. Anything calling it
now does so directly with the same bearer key.
