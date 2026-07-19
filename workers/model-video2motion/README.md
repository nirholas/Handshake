# model-video2motion

Video of a person → **retargetable animation clip + body-swap plates**. A
CPU-only FastAPI worker (no GPU, deploys like the segment/rembg lanes) that
powers the **Motion Swap** page (`/motion-swap`): upload a video of yourself,
get it back with your avatar performing your motion.

## What it produces

For one input video, four artifacts land in GCS under `motion-swap/<task_id>/`:

| Artifact | What it is |
|---|---|
| `clip.json` | three.js `AnimationClip.toJSON()` on the canonical Wolf3D skeleton — the SAME document shape the animation library and `model-text2motion` serve, so it retargets onto any rigged avatar via `src/animation-retarget.js` |
| `video.mp4` | the normalized source (≤720p-class, capped fps/duration, audio kept) |
| `mask.mp4` | grayscale per-frame person mask aligned with `video.mp4` |
| `meta.json` | fps, frame count, dimensions, and per-frame screen `anchors` (hip position + subject height + visibility) for pinning the avatar over the subject |

The browser compositor does the rest: original footage underneath, subject
pixelated via the mask, avatar retargeted onto the clip and pinned per frame.

## Models (all Apache-2.0, baked into the image)

- **MediaPipe PoseLandmarker (heavy)** — 33 world landmarks per frame, VIDEO
  mode with tracking.
- **MediaPipe HandLandmarker** — 21 landmarks per hand, up to 2 hands, VIDEO
  mode with tracking.
- **MediaPipe ImageSegmenter (selfie)** — per-frame person confidence mask.

The landmark → joint-rotation solve is ours: `pose_solver.py` builds global
orientations for pelvis/chest/head from body lines, solves each limb with its
bend-plane to fix twist, converts to locals against the parent chain, and emits
hemisphere-continuous quaternion tracks. Pure NumPy, unit-tested from synthetic
poses (`test_pose_solver.py`) without mediapipe installed.

When hands are visible, the solver also emits full hand articulation: detected
hands are assigned to the subject's left/right side by proximity to the pose
wrists (the model's handedness label is only a mirrored-convention fallback),
the wrist gets a palm-frame orientation (fixing twist the body-only solve
cannot see), and all 30 canonical finger bones (`LeftHandIndex1` …
`RightHandThumb3`) are solved as hinge rotations per frame. A frame that loses
hand tracking holds the previous finger pose instead of snapping to rest. This
is what makes fine-gesture and sign-language capture work: a video of a signer
comes back as a clip whose handshapes retarget onto any rigged avatar.

## API

```
POST /infer        { video_url, fps?=24, max_seconds?, job_id? }  → 202 { task_id }
GET  /tasks/:id    → { status, result_url?, meta_url?, video_url?, mask_url?, frames?, fps?, error? }
GET  /health       → { ok, models_loaded }
```

Bearer auth on `/infer` and `/tasks/:id` (`Authorization: Bearer $API_KEY`).
Input is fetched through the SSRF-hardened `worker_security.fetch_remote_bytes`
(https-only, private/loopback/metadata IPs rejected), capped at 256 MiB, and
processing is capped at `MAX_SECONDS` (default 90).

The platform reaches this worker through the GCP provider's `video2motion`
mode (`GCP_VIDEO2MOTION_URL`), exposed as `POST /api/motion-swap`
(+ `GET /api/motion-swap?job=<id>`).

## Deploy

```bash
gcloud builds submit --config workers/model-video2motion/cloudbuild.yaml \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s)
```

Then point the API at it:

```bash
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars GCP_VIDEO2MOTION_URL=<service url>
```

Shares the `avatar-reconstruction-key` bearer secret (`GCP_RECONSTRUCTION_KEY`
on the API side) with the other reconstruction-family workers.

## Tests

```bash
cd workers/model-video2motion && python -m pytest test_pose_solver.py -q
```
