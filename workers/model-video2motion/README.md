# model-video2motion

Video of a person to a **retargetable animation clip + body-swap plates**. A
CPU-only FastAPI worker (no GPU, deploys like the segment/rembg lanes) that
powers the **Motion Swap** page (`/motion-swap`): upload a video of yourself,
get it back with your avatar performing your motion. The same capture path
produces the lexical clips behind sign-language playback (`src/sign-speech.js`),
which is why hand articulation is solved as carefully as the body.

## What it produces

For one input video, four artifacts land in GCS under `motion-swap/<task_id>/`:

| Artifact | What it is |
|---|---|
| `clip.json` | three.js `AnimationClip.toJSON()` on the canonical Wolf3D skeleton, the SAME document shape the animation library and `model-text2motion` serve, so it retargets onto any rigged avatar via `src/animation-retarget.js` |
| `video.mp4` | the normalized source (long edge capped to 1280, capped fps/duration, audio kept, source metadata stripped) |
| `mask.mp4` | grayscale per-frame person mask aligned with `video.mp4` |
| `meta.json` | `version`, `fps`, `frames`, `width`, `height`, and per-frame screen `anchors` (hip position `x`/`y`, subject height `h`, visibility `v`) for pinning the avatar over the subject |

The browser compositor does the rest: original footage underneath, subject
pixelated via the mask, avatar retargeted onto the clip and pinned per frame.

## Models (all Apache-2.0, baked into the image)

- **MediaPipe PoseLandmarker (heavy)**: 33 world landmarks per frame, VIDEO
  mode with tracking.
- **MediaPipe HandLandmarker**: 21 landmarks per hand, up to 2 hands, VIDEO
  mode with tracking.
- **MediaPipe ImageSegmenter (selfie multiclass 256x256)**: the person mask is
  `1 - background confidence`, which holds up far better than the single-class
  selfie model on wide framing (house tours, rooms).

The landmark to joint-rotation solve is ours: `pose_solver.py` builds global
orientations for pelvis/chest/head from body lines, solves each limb with its
bend-plane to fix twist, converts to locals against the parent chain via
hierarchical FK in the canonical rig convention, and emits
hemisphere-continuous quaternion tracks. Pure NumPy, unit-tested from synthetic
poses (`test_pose_solver.py`) without mediapipe installed.

When hands are visible, the solver also emits full hand articulation: detected
hands are assigned to the subject's left/right side by proximity to the pose
wrists (the model's handedness label is only a mirrored-convention fallback),
the wrist gets a palm-frame orientation (fixing twist the body-only solve
cannot see), and all 30 canonical finger bones (`LeftHandIndex1` through
`RightHandThumb3`) are solved as hinge rotations per frame. A frame that loses
hand tracking holds the previous finger pose instead of snapping to rest. This
is what makes fine-gesture and sign-language capture work: a video of a signer
comes back as a clip whose handshapes retarget onto any rigged avatar.

## API

```
POST /infer        { video_url, fps?=24, max_seconds?, job_id? }  → 202 { task_id, status }
GET  /tasks/:id    → { status, result_url?, meta_url?, video_url?, mask_url?, frames?, fps?, error? }
GET  /health       → { ok, models_loaded }
```

`fps` is clamped to 8..30 by request validation; `max_seconds` is clamped down
to `MAX_SECONDS`. `job_id`, when supplied, becomes the task id (the platform
passes its own job id so a poll needs no id mapping). `status` moves
`queued` → `running` → `done` | `failed`; a failure carries an opaque
`error` string with a correlation id that matches the server log line.

Bearer auth on `/infer` and `/tasks/:id` (`Authorization: Bearer $API_KEY`);
`/health` is open so the Cloud Run probe can reach it. Input is fetched through
the SSRF-hardened `worker_security.fetch_remote_bytes` (https-only,
private/loopback/metadata IPs rejected, redirect hops re-validated), capped at
256 MiB, and processing is capped at `MAX_SECONDS` (default 90).

The platform reaches this worker through the GCP provider's `video2motion`
mode (`GCP_VIDEO2MOTION_URL`), exposed as `POST /api/motion-swap`
(+ `GET /api/motion-swap?job=<id>`).

### Environment

| Var | Default | Purpose |
|---|---|---|
| `API_KEY` | required | bearer secret for `/infer` and `/tasks/:id` |
| `GCS_BUCKET` | required | output bucket for the four artifacts |
| `MAX_CONCURRENT` | `2` | in-flight captures per instance |
| `MAX_SECONDS` | `90` | hard cap on processed duration |
| `MODELS_DIR` | `/models` | directory holding the three model bundles |

Startup fails fast if any bundle is missing from `MODELS_DIR`.

## Deploy

```bash
gcloud builds submit --config workers/model-video2motion/cloudbuild.yaml \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s)
```

Then point the API at it:

```bash
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars GCP_VIDEO2MOTION_URL=$(gcloud run services describe \
    model-video2motion --region us-central1 --format='value(status.url)')
```

Shares the `avatar-reconstruction-key` bearer secret (`GCP_RECONSTRUCTION_KEY`
on the API side) with the other reconstruction-family workers.

**The instance count is load-bearing, not a cost setting.** The service runs
`--min-instances=1 --max-instances=1 --no-cpu-throttling`. Capture happens in a
FastAPI background task after the 202 returns, so request-based billing starves
it (a 30 s clip took 3.5 h wall in production versus 3 min unthrottled, measured
2026-07-19); `min 1` stops the instance being reaped between polls, and `max 1`
keeps the in-memory task store authoritative, so a poll always lands on the
instance running the job. Raising `max-instances` would make `/tasks/:id`
return 404 for live jobs.

## Tests

The solver tests need only NumPy. The service tests additionally need ffmpeg
and the worker's own requirements:

```bash
cd workers/model-video2motion
python -m pytest test_pose_solver.py test_service.py -q
```

`test_service.py` covers the paths around the solver with real ffmpeg and real
MediaPipe: the HTTP auth/validation contract, video normalization (fps,
duration, long-edge and metadata handling), mask-video encoding and decode
round-trip, the SSRF guard on the caller-supplied URL, the queue to
task-store failure path, and a real three-model pass over a generated video.
The MediaPipe test skips unless the bundles are staged; point `MODELS_DIR` at a
directory holding all three, or run the suite inside the image, which already
has them:

```bash
docker build -t model-video2motion:local workers/model-video2motion
docker run --rm -v "$PWD/workers/model-video2motion:/src" -w /src \
  -e API_KEY=test -e GCS_BUCKET=test model-video2motion:local \
  sh -c 'pip install -q pytest && python -m pytest test_pose_solver.py test_service.py -q'
```

## Local development

`local_solve.py` runs the same pose and hand pipeline as the server (minus
segmentation, GCS and HTTP) straight to a `clip.json`, which is the fast loop
for changing `pose_solver.py`:

```bash
python local_solve.py input.mp4 out_clip.json --fps=24 --dump-landmarks=lm.npz
```

It reads bundles from `$MODELS_DIR` (default `./.models`, where the pose and
hand bundles are checked in). Stage any missing bundle from the same public
URLs the Dockerfile uses:

```bash
curl -fsSL -o .models/selfie_multiclass_256x256.tflite \
  https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite
```

### Verify a real capture

The pytest suite deliberately stops short of GCS uploads and real human
footage. To prove the whole path, run the image against a live video URL with
credentials mounted (any public https video of a person works; a previous
capture's normalized `video.mp4` is a convenient one):

```bash
docker run --rm -p 8080:8080 \
  -e API_KEY=local-key -e GCS_BUCKET=three-ws-avatar-reconstructions \
  -e GOOGLE_APPLICATION_CREDENTIALS=/adc.json \
  -v "$HOME/.config/gcloud/application_default_credentials.json:/adc.json:ro" \
  model-video2motion:local

curl -s localhost:8080/infer -H 'Authorization: Bearer local-key' \
  -H 'content-type: application/json' \
  -d '{"video_url":"https://storage.googleapis.com/.../video.mp4","fps":12,"max_seconds":6}'
curl -s localhost:8080/tasks/<task_id> -H 'Authorization: Bearer local-key'
```

`status: "done"` carries the four artifact URLs. Capture is CPU-bound and runs
roughly 4x the clip's wall time on 8 cores.
