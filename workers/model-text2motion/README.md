# model-text2motion

Text → animation. A GPU Cloud Run worker that samples a motion-diffusion model
from a natural-language prompt and returns a **retargetable three.js
AnimationClip JSON** on the canonical Wolf3D skeleton, the same format the
curated animation library serves, so a generated motion retargets onto any
rigged avatar with the existing engine (`src/animation-retarget.js`), identical
to a preset.

This is the capability Tripo (and the rest of the field) lacks: it generates
motion that does not pre-exist, rather than only applying preset clips.

## Model

[MDM, Motion Diffusion Model](https://github.com/GuyTevet/motion-diffusion-model)
(GuyTevet), **MIT-licensed** → commercial-safe. Chosen over MoMask / T2M-GPT
specifically for the unambiguous commercial license. Swapping models touches only
`mdm_sampler.py`; the contract and the SMPL→clip conversion are model-agnostic.

The deployed checkpoint is the HumanML3D text-to-motion model: `arch=trans_enc`,
`diffusion_steps=50`, `guidance_param=2.5` (read from the checkpoint's own
`args.json` at load, not hardcoded).

## Contract

Identical shape to the other `model-*` workers. Every route except `/health`
requires `Authorization: Bearer $API_KEY`.

```
POST /infer   { prompt, duration_seconds?=4, fps?=30, job_id? } → 202 { task_id, status }
GET  /tasks/:id → { task_id, status, model, result_url?, frames?, fps?, elapsed_ms?, error? }
GET  /health    → { ok, model_loaded, status: loading|ready|failed, load_error }
GET  /          → { service, model, health, endpoints }   (identity, no auth)
```

`prompt` is 3 to 1000 characters, `fps` is 8 to 60, and `duration_seconds` is
clamped to `MAX_DURATION_SEC` (default 10). `result_url` is a three.js
`AnimationClip.toJSON()` document in GCS. Task state is in-process memory, so a
`task_id` does not survive an instance restart; the platform polls within a
single job's lifetime and treats a missing task as a failed job.

The platform reaches this worker through the GCP provider's `text2motion` mode
(`GCP_TEXT2MOTION_URL`, key `GCP_RECONSTRUCTION_KEY`), exposed as:

- REST: `POST /api/forge-motion` (+ `GET /api/forge-motion?job=<id>`)
- MCP: `text_to_animation` (generates + retargets onto a model_url in one call)

## Pipeline

1. `mdm_sampler.MdmSampler.sample(prompt, n_frames)` samples the diffusion model,
   denormalizes with the HumanML3D dataset stats, and calls upstream's
   `recover_from_ric` to get global joint **positions** `(T,22,3)`.
2. `mdm_sampler._positions_to_local_quats` recovers each joint's **local
   rotation** from where its own children landed (Kabsch fit against the rest
   directions), then `_quat_to_axis_angle` + `_resample` produce SMPL-indexed
   axis-angle `(T,22,3)` plus root translation `(T,3)` at the requested frame
   count.
3. `smpl_to_clip.smpl_motion_to_clip(poses, trans, fps)` emits the AnimationClip
   JSON: 22 quaternion tracks with canonical Wolf3D bone names
   (`Hips.quaternion`, …) plus `Hips.position`.
4. Upload to `gs://$GCS_BUCKET/motion-clips/mdm/<task_id>.json`; return the URL.

## Environment

| Var | Required | Purpose |
|---|---|---|
| `API_KEY` | yes | Bearer secret; mounted from Secret Manager (`avatar-reconstruction-key`) |
| `GCS_BUCKET` | yes | Output bucket (`three-ws-avatar-reconstructions`) |
| `MOTION_MODEL_DIR` | no | Checkpoint dir, default `/weights/mdm` |
| `MAX_CONCURRENT` | no | In-instance job semaphore, default 2 |
| `MAX_DURATION_SEC` | no | Hard cap on requested clip length, default 10 |

## Weights

`gs://three-ws-model-weights/mdm/` holds exactly two objects, mounted at
`/weights/mdm` by the Cloud Run GCS volume: `model.pt` (78 MiB checkpoint) and
`args.json` (the checkpoint's own hyperparameters).

The real SMPL body model (`SMPL_NEUTRAL.pkl`) is deliberately **not** staged: it
is gated behind SMPL's own registration license, and this worker never needs it.
`model.mdm.MDM` eagerly constructs a `Rotation2xyz`/`SMPL` submodule that would
load it, so `mdm_sampler` patches in a real (license-file-free) `nn.Module`
stand-in purely so `.to(device)` / `.eval()` have something to walk into. That
submodule's output is never consumed: motion is decoded from the HumanML3D
feature vectors instead. See the Dockerfile comment for the full reasoning.

## Where it runs

| Region | Role | minScale / maxScale |
|---|---|---|
| **us-east4** | **production lane**: `GCP_TEXT2MOTION_URL` and the `model-text2motion-warm` scheduler probe both point here | 0 / 2 |
| us-central1 | dormant failback copy, same image | 0 / 2 |

L4 GPU quota is **per region** and us-east4's grant is 3, shared with the idle
`model-trellis` and `model-triposr` standbys pinned there. This lane runs at
minScale 0, so a warm pin held by an idle service in the same region is what
starves it: that happened twice (us-central1 2026-07-26, us-east4 2026-08-11),
both times showing up as `exceeded its quota limit for
run.googleapis.com/nvidia_l4_gpu_allocation_no_zonal_redundancy` on the
10-minute keep-warm probe. Fix is to unpin the idle holder, not to wait on a
quota raise. Full history and the measurement procedure:
[docs/ops/gcp-credits-plan.md](../../docs/ops/gcp-credits-plan.md).

`api/cron/gpu-keepwarm.js` pings the lane root every 10 minutes during peak
hours to absorb the cold start, counting any response under 500 as warm. `GET /`
answers with the service identity and endpoint map, matching the other `model-*`
workers; it used to 404, which the probe accepted but which wrote 90 WARNING
lines a day into the triage sweep.

## Tests

Pure NumPy, no torch, no GPU, no checkpoint. From this directory:

```bash
python3 -m unittest discover -p 'test_*.py'
```

Both modules import sibling files directly, so they must be run with this
directory as the working directory (running them by path from the repo root
fails on `ModuleNotFoundError: smpl_to_clip`).

- `test_smpl_to_clip.py` (16 cases): axis-angle → quaternion correctness and
  unit-norm, the SMPL→Wolf3D bone mapping, clip JSON shape (track names, value
  lengths, monotonic times, duration), rest-offset calibration, flattened-pose
  input, single-frame/static, and input validation.
- `test_mdm_decode.py` (21 cases): the decode path this worker owns. The
  kinematic-chain flattening, the Kabsch solve, `_quat_to_axis_angle` as the
  exact inverse of `axis_angle_to_quaternion`, `_resample`, and a
  forward-kinematics → `_positions_to_local_quats` → forward-kinematics round
  trip that must reproduce the input positions (asserted on positions rather
  than rotations, because single-child joints carry no twist signal in position
  data). Two smoke cases run the whole owned chain end to end: joint positions
  in, a valid AnimationClip out.

The JS provider mode + REST endpoint are covered by
`tests/api/forge-motion.test.js` (`npm test`).

What only a deploy can validate is the pair of upstream calls in
`_decode_to_smpl` (`recover_from_ric` and the sampler itself), which need the
GPU image and the checkpoint. Those are exercised in production: verified
2026-08-11 against the us-east4 lane, a 3-second 30 fps prompt returning 90
frames in 2.7 s warm, with all 22 quaternion tracks unit-norm, 17 of 22 bones
actually animating, and `Hips.position` carrying real travel.

`smpl_to_clip`'s `rest_offsets` parameter defaults to identity, which emits the
raw SMPL local rotations. That is the correct baseline for SMPL-rest targets;
the retarget engine already aligns bone names and hip scale, and any residual
SMPL-rest vs Wolf3D-rest orientation offset is what that parameter exists to
calibrate.

## Build / deploy

```bash
gcloud builds submit --config workers/model-text2motion/cloudbuild.yaml . \
  --substitutions=SHORT_SHA=manual$(date +%s)
```

One build, two deploys: the image is built and stored in the us-central1
Artifact Registry, then rolled out to **us-east4 first (production)** and
us-central1 second (failback), so the standby can never be newer than the lane
users hit. L4 GPU, 4 CPU / 16 Gi, max 2 instances. Deploys are owner-gated per
CLAUDE.md; the build itself is safe to run.

Verify a deploy landed:

```bash
KEY=$(gcloud secrets versions access latest --secret=avatar-reconstruction-key \
  --project aerial-vehicle-466722-p5)
URL=https://model-text2motion-93741856042.us-east4.run.app
curl -s "$URL/health" -H "authorization: Bearer $KEY"
curl -s -X POST "$URL/infer" -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"prompt":"a person waves hello with the right hand","duration_seconds":3,"fps":30}'
curl -s "$URL/tasks/<task_id>" -H "authorization: Bearer $KEY"
```
