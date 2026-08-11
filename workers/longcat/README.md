# LongCat Video Avatar Worker

FastAPI service that turns a reference image plus an audio clip into a
lip-synced talking-avatar MP4, using
[meituan-longcat/LongCat-Video-Avatar-1.5](https://huggingface.co/meituan-longcat/LongCat-Video-Avatar-1.5)
(MIT license). Output videos land in Cloud Storage; job state lives in Firestore.

**Status: built and tested, not deployed.** No `longcat-video-avatar` Cloud Run
service exists, `LONGCAT_WORKER_URL` is not set on `three-ws-api`, and the
weights are not staged. The site handles that cleanly: `/api/avatar/video-generate`
answers `503 worker_unconfigured` and burns no free-trial quota
([api/avatar/video-generate.js](../../api/avatar/video-generate.js)). See
[Why this is not on Cloud Run](#why-this-is-not-on-cloud-run) for the blocker
and [Running it](#running-it) for the hardware that does work.

## API

```
POST /generate  { image_url, audio_url, prompt?, job_id? }
             →  202 { job_id, status: "queued" }
             →  503 when the model weights are not staged on the instance

GET  /jobs/:id  → { job_id, status, progress, segments, audio_seconds,
                    video_url?, error?, created_at, updated_at }
             →  404 when the job id is unknown

GET  /health    → { ok, pipeline, model_loaded, missing_weights, weights_dir,
                    checkpoint_dir, base_model_dir, resolution, max_segments }
```

`/generate` and `/jobs/:id` require `Authorization: Bearer <API_KEY>` and answer
`401` without it. `/health` is unauthenticated so a load balancer can probe it;
it reports `model_loaded: false` and lists the absent files in
`missing_weights` when the staging is incomplete.

`status` moves `queued` → `running` → `done` | `failed`. `progress` is a 0-1
fraction that only ever moves forward, even across segments. `error` is an
opaque `internal error (ref <id>)` string; the matching correlation id is in the
service log with the full traceback.

`image_url` and `audio_url` may be `https://` URLs or inline `data:` URIs. HTTPS
fetches are SSRF-hardened by [worker_security.py](worker_security.py): https
only, DNS-resolved addresses in private, loopback, link-local or metadata ranges
are refused, every redirect hop is re-validated, and the body is size-capped.

### Example

```bash
KEY=$(gcloud secrets versions access latest --secret=longcat-video-avatar-key)
BASE=http://localhost:8080

JOB=$(curl -sS -X POST "$BASE/generate" \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"image_url":"https://three.ws/avatars/render/example.png",
       "audio_url":"https://three.ws/audio/example.wav",
       "prompt":"A person talking naturally."}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["job_id"])')

curl -sS "$BASE/jobs/$JOB" -H "authorization: Bearer $KEY"
```

## How generation works

One inference pass produces a fixed 93-frame clip at 25 fps, which is 3.72 s of
video. Longer audio needs continuation segments, and each one re-generates 13
frames of overlap with the previous segment, so it adds 3.2 s of new video:

    covered_seconds(n) = 3.72 + (n - 1) * 3.2

The service probes the real audio duration with `ffprobe` and asks upstream for
enough segments to cover it, capped by `MAX_SEGMENTS`. A 10-second voice clip
runs 3 segments; the default cap of 8 covers 26.12 s. Upstream pads the audio
with silence up to the generated length, so overshooting by part of a segment is
harmless, while undershooting would drop the tail of the speech.

Each continuation save re-encodes every frame generated so far, so the final
artifact is the highest-numbered `video_continue_N.mp4`, not a concatenation
step. `save_video_ffmpeg` also leaves two audio-less intermediates next to it
(`-temp.mp4` and `-cropvideo.mp4`); the service skips those explicitly. The
rules live in [inference_plan.py](inference_plan.py) and are covered by
[test_inference_plan.py](test_inference_plan.py).

The command the service runs, per job:

```
torchrun --nproc_per_node=1 run_demo_avatar_single_audio_to_video.py \
  --input_json <job config> --output_dir <job output> \
  --checkpoint_dir $WEIGHTS_DIR/LongCat-Video-Avatar-1.5 \
  --resolution $RESOLUTION --model_type avatar-v1.5 --stage_1 ai2v \
  --num_segments <computed> --use_distill --use_int8
```

`--stage_1 ai2v` is audio-image-to-video: it consumes the reference image. The
`at2v` alternative ignores the image entirely, which is never what this service
wants.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `API_KEY` | yes | | shared bearer secret |
| `GCS_BUCKET` | yes | | bucket for output MP4s (`avatar-videos/<job_id>.mp4`) |
| `FIRESTORE_PROJECT` | yes | | project hosting the `longcat_video_jobs` collection |
| `WEIGHTS_DIR` | no | `/weights/longcat` | root holding both model repos |
| `LONGCAT_REPO_DIR` | no | `/longcat` | the cloned upstream repo |
| `MAX_CONCURRENT` | no | `1` | parallel jobs; keep it at 1 (see below) |
| `MAX_SEGMENTS` | no | `8` | segment cap, so one long upload cannot monopolise the GPU |
| `RESOLUTION` | no | `720p` | `480p` (480x832) or `720p` (768x1280); anything else fails at boot |

Leave `MAX_CONCURRENT` at `1`. Beyond the obvious point that one GPU cannot run
two of these jobs, upstream writes its vocal-separation scratch files to a fixed
`./audio_temp_file` relative to the repo, so two concurrent runs would race on
the same path. Scale with more hosts, not more workers per host.

## Model weights

Two HuggingFace repos must be staged side by side, because upstream loads the
tokenizer, UMT5 text encoder and VAE from `<checkpoint_dir>/../LongCat-Video`:

```
$WEIGHTS_DIR/
  LongCat-Video/              tokenizer/  text_encoder/  vae/
  LongCat-Video-Avatar-1.5/   base_model_int8/  lora/  scheduler/
                              whisper-large-v3/  vocal_separator/
```

Only the files this worker's flags dereference are needed: 44.81 GB, against
158 GB for both repos in full. [stage-weights.sh](stage-weights.sh) fetches
exactly that set, verifies the layout, and uploads it to the shared bucket:

```bash
workers/longcat/stage-weights.sh --dry-run     # list files and sizes, download nothing
workers/longcat/stage-weights.sh --local-only  # download to $LOCAL_DIR, no upload
workers/longcat/stage-weights.sh               # download, verify, upload to GCS
```

The dry run resolves its include patterns against the live HuggingFace file
listing, so the size it prints is current rather than remembered:

```
meituan-longcat/LongCat-Video: 15 file(s), 23.25 GB
meituan-longcat/LongCat-Video-Avatar-1.5: 26 file(s), 21.56 GB
TOTAL: 44.81 GB
```

Excluded on purpose: `base_model/` (31.7 GB bf16 DiT, superseded by
`base_model_int8` under `--use_int8`), the base repo's `dit/` (54 GB, that is the
text-to-video model, not the avatar one), whisper's flax / `.bin` / fp32
duplicates (19.5 GB of the same weights), and `chinese-wav2vec2-base` (the
avatar-v1.0 audio encoder; v1.5 uses whisper-large-v3).

[model_weights.py](model_weights.py) holds the authoritative required-file list.
The service checks it at startup and on every `/generate`, so an incomplete
staging surfaces as a `503` and a log line naming the missing paths, not as a
CUDA error two minutes into a job.

## Why this is not on Cloud Run

Upstream's `LongCatVideoAvatarPipeline.to(device)` moves the DiT, the text
encoder and the VAE onto one GPU, and the audio encoder is moved there
separately. Nothing is CPU-offloaded, so the resident weight set is the sum:

| Component | Source | Resident |
|---|---|---|
| UMT5 text encoder (bf16) | `LongCat-Video/text_encoder` | 22.72 GB |
| DiT, INT8 quantized | `Avatar-1.5/base_model_int8` | 15.88 GB |
| Distillation LoRA | `Avatar-1.5/lora/dmd_lora.safetensors` | 2.52 GB |
| whisper-large-v3 audio encoder | `Avatar-1.5/whisper-large-v3` | 3.09 GB |
| VAE | `LongCat-Video/vae` | 0.51 GB |
| **Total** | | **44.72 GB** |

Activations for 93 frames at 768x1280 sit on top of that. Cloud Run offers two
GPUs and neither works:

- **NVIDIA L4, 24 GB.** Less than half the weight set. `--use_int8` is already
  applied; there is nothing left to quantize away. Upstream's multi-GPU examples
  use context parallelism, which splits activations but replicates weights on
  every rank, so 2 x L4 does not help either.
- **NVIDIA RTX PRO 6000 Blackwell, 96 GB.** Enough memory, wrong architecture:
  it is compute capability sm_120, and the `torch==2.6.0+cu124` and
  `flash-attn==2.7.4.post1` wheels this stack pins ship kernels only up to
  sm_90. The shipped `base_model_int8/config.json` sets
  `enable_flashattn2: true`, so flash-attn is a hard runtime import, not an
  optimisation that can be dropped.

So [cloudbuild.yaml](cloudbuild.yaml) builds and publishes the image but does
not deploy it. Running it needs one 80 GB GPU at sm_80 or sm_90, which means
Compute Engine rather than Cloud Run.

## Running it

Build and publish the image:

```bash
gcloud builds submit --config workers/longcat/cloudbuild.yaml \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s)
```

Run it on a GPU host (an `a2-ultragpu-1g` with one A100-80GB, or an `a3-highgpu-1g`
with one H100-80GB), with the weights on a local disk or a mounted bucket:

```bash
docker run --rm --gpus all -p 8080:8080 \
  -e API_KEY="$(gcloud secrets versions access latest --secret=longcat-video-avatar-key)" \
  -e GCS_BUCKET=three-ws-avatar-reconstructions \
  -e FIRESTORE_PROJECT=aerial-vehicle-466722-p5 \
  -e WEIGHTS_DIR=/weights/longcat \
  -v /mnt/weights:/weights \
  us-central1-docker.pkg.dev/aerial-vehicle-466722-p5/longcat-video-avatar/server:latest

curl -s localhost:8080/health   # model_loaded must be true before generating
```

GPU quota is the gate on the first real run. Read the live numbers rather than
trusting this paragraph:

```bash
gcloud compute regions describe us-central1 --project aerial-vehicle-466722-p5 \
  --format=json | python3 -c '
import json,sys
for q in json.load(sys.stdin)["quotas"]:
    if "A100" in q["metric"] or "H100" in q["metric"]:
        print(q["metric"], q["limit"], "used", q["usage"])'
```

As of 2026-08-11 that prints `NVIDIA_A100_80GB_GPUS 0.0` and
`NVIDIA_A100_GPUS 1.0` (the 40 GB part, itself too small for a 45 GB weight
set), with no H100 metric present. So one 80 GB device has to be requested
first: filter for `NVIDIA_A100_80GB_GPUS` on the
[quotas page](https://console.cloud.google.com/iam-admin/quotas?project=aerial-vehicle-466722-p5)
and raise the `us-central1` limit to 1. Credits policy and the fleet's GPU
budget: [docs/ops/gcp-credits-plan.md](../../docs/ops/gcp-credits-plan.md).

Once a host is serving, point the site at it and the `503` path turns into real
generation:

```bash
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars LONGCAT_WORKER_URL=<worker-url>,LONGCAT_WORKER_KEY=<api-key>
```

Use `--update-env-vars`, never `--set-env-vars`: the latter replaces the whole
environment. Full env and rollback runbook:
[docs/ops/gcp-production.md](../../docs/ops/gcp-production.md).

## Prerequisites for a first deploy

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com storage.googleapis.com \
  firestore.googleapis.com secretmanager.googleapis.com

# API key secret (the service compares bearer tokens against it in constant time)
openssl rand -hex 32 | tr -d '\n' | \
  gcloud secrets create longcat-video-avatar-key --data-file=-

# Firestore, native mode, if the project has none yet
gcloud firestore databases create --location=us-central1
```

The Artifact Registry repository is created by the build itself. Output MP4s go
to `three-ws-avatar-reconstructions`, the bucket the other model workers already
use, under the `avatar-videos/` prefix; no new bucket is needed. Weights go to
`three-ws-model-weights` under `longcat/`, which is the same shared bucket the
rig, text2motion and TripoSG workers mount.

## Tests

```bash
python3 workers/longcat/test_inference_plan.py   # segment math, output choice, progress
python3 workers/longcat/test_model_weights.py    # the two-repo layout upstream requires
python3 workers/longcat/test_app_smoke.py        # imports, routes, auth, the 503 gate
```

The first two are stdlib-only. The third imports the app, so it needs
[requirements.txt](requirements.txt) installed; it drives the handlers directly
and never contacts GCP. All three run inside `docker build` as gates, so a
regression fails the image rather than shipping.

## Cost and capacity

The GPU host is the dominant line item, so this worker should not sit warm. Both
candidate shapes exist in `us-central1-a` today (verified with
`gcloud compute machine-types describe`):

| Machine type | GPU | vCPU | RAM |
|---|---|---|---|
| `a2-ultragpu-1g` | 1x A100-80GB (sm_80) | 12 | 170 GB |
| `a3-highgpu-1g` | 1x H100-80GB (sm_90) | 26 | 234 GB |

Price them from the Compute Engine pricing page before leaving one running; an
always-on 80 GB GPU dwarfs every other cost in this worker. Keeping the 44.81 GB
of weights in `three-ws-model-weights` costs cents per month by comparison and
saves a 45 GB re-download on every new host, so stage once and leave them.

Per-job latency has not been measured on our hardware, and upstream publishes no
per-segment number for the distilled 8-step avatar path, so do not hardcode a
client timeout from a guess. Take it from the first real run: `/jobs/:id` exposes
`segments` and a monotonic `progress`, which is enough to drive a real progress
bar rather than a spinner. `/generate` is asynchronous precisely because a
multi-segment 720p job is minutes, not seconds.
