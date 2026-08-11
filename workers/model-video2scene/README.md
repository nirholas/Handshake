# model-video2scene

Streaming **video to 3D point-cloud** reconstruction on Cloud Run GPU.

Wraps [LingBot-Map](https://github.com/Robbyant/lingbot-map) (Apache-2.0), a
feed-forward "Geometric Context Transformer" that reconstructs a dense
world-space point cloud from a monocular video or image sequence using
paged-KV-cache attention (FlashInfer).

The worker drives the upstream repo's own entry points (`demo.load_images`,
`demo.load_model`, `demo.postprocess`), optionally removes sky pixels with
LingBot-Map's sky segmentation, fuses the per-frame world points + RGB into a
single coloured cloud, writes a binary PLY, and uploads it to Cloud Storage. The
three.ws **Scene Capture** page (`/capture`) renders that PLY directly in a
WebGL point-cloud viewer ([`src/pointcloud-viewer.js`](../../src/pointcloud-viewer.js)).

## API

```
POST /infer        { video_url | images[], mode?, fps?, keyframe_interval?, ... }  -> 202 { task_id }
GET  /tasks/:id    -> { status, result_gcs_url?, num_points?, frames?, bytes?, error? }
GET  /health       -> { ok, gpu_available, model_loaded, weights_present, max_frames }
```

Bearer auth on `/infer` and `/tasks/:id` (`Authorization: Bearer $API_KEY`). The
three.ws API ([`api/scene-capture.js`](../../api/scene-capture.js)) holds the
matching `GCP_RECONSTRUCTION_KEY` and points at `GCP_VIDEO2SCENE_URL`.

### Request fields

| Field | Default | Meaning |
|---|---|---|
| `video_url` | none | Public https URL to an `.mp4` / `.mov` / `.webm`. One of `video_url` or `images[]` is required. |
| `images[]` | none | Frames as https URLs or `data:image` URIs, in order. |
| `mode` | `streaming` | `streaming` (one pass, KV cache) or `windowed` (independent windows, aligned across overlaps). Each mode is a different upstream model class, so switching modes reloads the checkpoint. |
| `fps` | `8` | Frames per second sampled from the video. |
| `keyframe_interval` | `4` | Every N-th frame after the scale frames keeps its KV in cache. Higher means less memory, less detail. |
| `num_scale_frames` | `8` | Leading frames processed bidirectionally to fix scale. Baked into the model build, so changing it also reloads the checkpoint. |
| `window_size` / `overlap_size` | `128` / `16` | Windowed mode only. |
| `mask_sky` | `true` | Runs LingBot-Map sky segmentation and drops sky pixels. |
| `conf_percentile` | `30` | Drops the lowest N percent of surviving points by model confidence. |
| `max_points` | `1500000` | Hard cap after fusion (deterministic stride subsample). |
| `voxel_size` | `0` | World-unit voxel edge. Above 0, points sharing a cell are merged and colour-averaged before the cap, which de-duplicates re-observed surfaces. |
| `job_id` | none | Caller correlation id, echoed in logs. |

A finished task also reports `frames_truncated` and `sky_points_removed`.

### Frame budget

`MAX_FRAMES` (default 512) caps a single job. Fusion holds world points,
confidences and RGB for every pixel of every frame at once (about 12 MB per
518x518 frame), so 512 frames peaks near 10 GB of the instance's 32 GiB. At the
default `fps: 8` that is 64 seconds of video; longer clips should lower `fps`
rather than raise the cap. An input longer than the cap is truncated and the
task reports `frames_truncated: true`. `MAX_FRAME_NUM` (default 1024) is the
separate 3D RoPE budget the model is built with and bounds `MAX_FRAMES`.

## Model weights

Mounted read-only from the shared weights bucket at `WEIGHTS_DIR/MODEL_FILE`
(default `/weights/lingbot-map/lingbot-map-long.pt`), plus `skyseg.onnx` in the
same directory for sky masking. Both are already staged in
`gs://three-ws-model-weights/lingbot-map/`. To restage from scratch:

```bash
curl -L -o lingbot-map-long.pt https://huggingface.co/robbyant/lingbot-map/resolve/main/lingbot-map-long.pt
curl -L -o skyseg.onnx https://huggingface.co/JianyuanWang/skyseg/resolve/main/skyseg.onnx
gsutil -m cp lingbot-map-long.pt skyseg.onnx gs://three-ws-model-weights/lingbot-map/
```

The checkpoint is 4.6 GB and the sky model 168 MB. If `skyseg.onnx` is absent
from the mount the worker downloads it once into `SKYSEG_CACHE_DIR`
(`/tmp/skyseg`) so sky masking still works; the checkpoint has no such fallback
and `/infer` answers `503` until it is mounted.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `API_KEY` | required | Shared bearer secret (Cloud Run secret `avatar-reconstruction-key`). |
| `GCS_BUCKET` | required | Bucket for output point clouds (`three-ws-avatar-reconstructions`). |
| `WEIGHTS_DIR` | `/weights/lingbot-map` | Mounted weights directory. |
| `MODEL_FILE` | `lingbot-map-long.pt` | Checkpoint filename. |
| `SKYSEG_FILE` | `skyseg.onnx` | Sky-segmentation model filename. |
| `LINGBOT_DIR` | `/opt/lingbot-map` | Upstream checkout on `PYTHONPATH`. |
| `MAX_CONCURRENT` | `1` | Parallel reconstructions per instance. |
| `MAX_FRAMES` | `512` | Frame cap per job. |
| `MAX_FRAME_NUM` | `1024` | 3D RoPE frame budget used to build the model. |
| `USE_SDPA` | unset | Set to `1` to force PyTorch SDPA attention instead of FlashInfer. |

## Build and test

```bash
# Fusion + PLY core path, no GPU and no checkpoint needed.
cd workers/model-video2scene && python -m unittest test_scene_fusion

# The image the deploy ships. The build reruns those tests and imports the
# service module, so a broken fusion path or import fails the build.
docker build -t model-video2scene:local workers/model-video2scene
```

Run it locally against real weights (CPU works but is slow; FlashInfer needs a
GPU, so the worker falls back to SDPA attention automatically):

```bash
docker run --rm -p 8080:8080 \
  -e API_KEY=local -e GCS_BUCKET=three-ws-avatar-reconstructions \
  -v /path/to/weights:/weights/lingbot-map:ro \
  model-video2scene:local
curl -s localhost:8080/health
```

## Deploy

Not currently deployed as its own Cloud Run service. Deploying it is one
command, and it must be run by the repo owner:

```bash
gcloud builds submit --config workers/model-video2scene/cloudbuild.yaml . \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s)
```

The config builds, pushes, and deploys the `model-video2scene` service on an
NVIDIA L4 with the weights bucket mounted at `/weights`. Afterwards set
`GCP_VIDEO2SCENE_URL` to the service URL on the three.ws API service
(`gcloud run services update three-ws-api --region us-central1
--update-env-vars GCP_VIDEO2SCENE_URL=...`). `GCP_RECONSTRUCTION_KEY` is already
shared across the model workers. Until then `/capture` returns its designed
`503` unconfigured state and renders its built-in sample cloud.

## Hardware

NVIDIA L4 (CUDA 12.8), 8 vCPU / 32 GiB. Frames stay in host RAM and are moved to
the GPU one window at a time, so peak VRAM tracks the window, not the clip. For
long clips, lower `fps`, raise `keyframe_interval`, or use `mode: "windowed"`
with a smaller `window_size`.
