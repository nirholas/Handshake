# Motion Swap — replace yourself in a video with your avatar

**Page:** [/motion-swap](https://three.ws/motion-swap) · **API:** `POST /api/motion-swap` · **Worker:** `workers/model-video2motion`

Upload a video of yourself (a house tour, a product demo, a talking
walk-through) and get it back with your 3D avatar performing your exact motion
instead of you. You stay pixelated under the avatar; the motion, framing, and
audio stay yours. Built for creators who want to publish video without
publishing their face.

## How to use it

1. Open [/motion-swap](https://three.ws/motion-swap) and drop in a video
   (MP4, MOV, or WebM, up to 256 MB; the first 90 seconds are processed).
   One person, full body in frame, tracks best.
2. Wait for capture (about 2 minutes for a 30-second clip). The server tracks
   your pose in every frame and masks you out.
3. Pick an avatar: a stock one, or paste the GLB URL of any rigged humanoid —
   one you [generated](https://three.ws/create), captured from a selfie, or
   rigged from a mesh. Swap avatars any time; the motion re-binds instantly.
4. Press **Export video** to record the composite (with the original audio) to
   a downloadable `.webm`.

The "Pixelate me under the avatar" toggle controls the privacy treatment of
the original subject beneath the avatar.

## How it works

Three stages, split between one CPU worker and your browser:

1. **Track (server).** MediaPipe PoseLandmarker follows 33 body landmarks
   through every frame; MediaPipe ImageSegmenter produces a per-frame person
   mask. Both models are Apache-2.0 and run without a GPU.
2. **Solve (server).** An in-house solver
   (`workers/model-video2motion/pose_solver.py`) converts the landmark
   sequence into local joint rotations on the canonical Wolf3D skeleton and
   emits a standard three.js `AnimationClip` JSON — the same format the
   [animation library](https://three.ws/animations) serves, so the clip
   retargets onto any rigged avatar with the platform's existing engine.
3. **Composite (browser).** One WebGL scene: the normalized footage on a
   fullscreen quad (subject pixelated under the mask in the shader), the
   avatar driven by the clip and pinned to the subject's on-screen position
   and size each frame via the capture's anchor track, and a
   `MediaRecorder` export of canvas + source audio.

Privacy properties: the motion clip contains no imagery (skeleton rotations
only), and processing artifacts live under an unguessable job id.

## API

```
POST /api/motion-swap   { action: "upload", content_type, size_bytes }
  → { upload_url, public_url, ... }        # presigned direct-to-storage PUT

POST /api/motion-swap   { video_url, fps?, max_seconds? }
  → 202 { job_id, status, eta_seconds }

GET  /api/motion-swap?job=<id>
  → { status, clip_url, meta_url, video_url, mask_url, frames, fps }
```

`clip_url` is a three.js `AnimationClip.toJSON()` document you can use
anywhere the platform accepts a clip. `meta_url` carries `fps`, dimensions,
and per-frame `anchors` (`{x, y, h, v}`: hip centre in normalized image
coordinates, subject height as a fraction of frame height, visibility).

## Operations

Deploy and wiring: see
[workers/model-video2motion/README.md](../workers/model-video2motion/README.md).
The API routes through the GCP provider's `video2motion` mode; unset
`GCP_VIDEO2MOTION_URL` degrades the endpoint to a clean 503 and the page shows
its error state.

## Related

- [/capture](https://three.ws/capture) — video → 3D point cloud (scene, not person)
- [/animations](https://three.ws/animations) — the clip library the output format matches
- [docs/animations.md](animations.md) · [docs/avatar-reconstruction.md](avatar-reconstruction.md)
