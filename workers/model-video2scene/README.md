# model-video2scene

Streaming **video → 3D point-cloud** reconstruction on Cloud Run GPU.

Wraps [LingBot-Map](https://github.com/Robbyant/lingbot-map) (Apache-2.0) — a
feed-forward "Geometric Context Transformer" that reconstructs a dense
world-space point cloud from a monocular video or image sequence at ~20 FPS over
sequences of 10,000+ frames, using paged-KV-cache attention (FlashInfer).

The worker runs the model's documented inference path, fuses the per-frame world
points + RGB into a single coloured cloud, writes a binary PLY, and uploads it to
Cloud Storage. The three.ws **Scene Capture** page (`/capture`) renders that PLY
directly in a WebGL point-cloud viewer.

## API

```
POST /infer        { video_url | images[], mode?, fps?, keyframe_interval?, ... }  → 202 { task_id }
GET  /tasks/:id    → { status, result_gcs_url?, num_points?, frames?, error? }
GET  /health       → { ok, gpu_available, model_loaded }
```

Bearer auth on `/infer` and `/tasks/:id` (`Authorization: Bearer $API_KEY`). The
three.ws API (`api/scene-capture.js`) holds the matching `GCP_RECONSTRUCTION_KEY`
and points at `GCP_VIDEO2SCENE_URL`.

See the module docstring in [`main.py`](main.py) for the full request schema.

## Model weights

Mounted read-only from the shared weights bucket at `WEIGHTS_DIR/MODEL_FILE`
(default `/weights/lingbot-map/lingbot-map-long.pt`). Pre-populate once:

```bash
huggingface-cli download robbyant/lingbot-map-long --local-dir /tmp/lm
gsutil -m cp -r /tmp/lm/* gs://three-ws-model-weights/lingbot-map/
```

## Deploy

```bash
gcloud builds submit --config workers/model-video2scene/cloudbuild.yaml .
```

Then set `GCP_VIDEO2SCENE_URL` (the Cloud Run service URL) on the three.ws
production service (Cloud Run `three-ws-api`, `gcloud run services update … --update-env-vars`)
and redeploy the site. `GCP_RECONSTRUCTION_KEY` is already shared across the model workers.

## Hardware

NVIDIA L4 (CUDA 12.8), 8 vCPU / 32 GiB. For very long clips, callers can lower
memory pressure with `mode: "windowed"` and a smaller `num_scale_frames`.
