# Avatar Reconstruction Service

FastAPI service on Cloud Run that turns 1-6 selfie photos into a rigged,
animation-ready GLB avatar and stores it in Cloud Storage. Same external contract
the three.ws backend (`api/_providers/gcp.js`, `reconstruct` mode) already speaks:
`POST /reconstruct` → `GET /jobs/:id`.

**CPU-only, no GPU.** It ran on an NVIDIA L4 until 2026-07-27. Measurement that
retired it, and the reason not to re-add one, are in
[`cloudbuild.yaml`](cloudbuild.yaml); the short version is that the CUDA provider
never engaged, so the GPU bought nothing and its slot was worth more to the rest
of the fleet. Production runs at 8 vCPU / 16 GiB, `--no-cpu-throttling`, one warm
instance. A job takes about 5 s end to end.

## Pipeline

The avatar is built on a fixed-topology Wolf3D/RPM template head+body that ships
pre-rigged with a humanoid skeleton and **52 ARKit blendshapes + 15 visemes**
(the same architecture Avaturn uses: fit a person onto a rigged template, don't
generate an arbitrary mesh). Three stages, all commercial-clean:

1. **Face texture transfer** (`face_pipeline.py`) - MediaPipe FaceLandmarker →
   TPS-warp the selfie into the template's skin UV → composite over the face
   oval → sample and tint skin / hair / eye colour.
2. **Face geometry morph** (`face_geometry.py`) - recover the person's actual 3D
   face shape (width, jaw, nose projection, brow, cheekbones) from the same 468
   MediaPipe landmarks and reshape the template head to match, so the avatar
   reads as *that person* instead of their texture on a generic head.
   Umeyama-aligns the landmarks to MediaPipe's neutral canonical face, carries
   the identity residual onto the head's corresponding vertices (precomputed
   nearest-vertex map), and interpolates it across the head with a thin-plate
   spline that passes through the control points, under a Gaussian mask that
   fades the field to zero off the face. Vertex count/order are preserved, so
   `glb_ops.set_head_geometry` writes it back **without disturbing skinning or
   any blendshape**. The `strength` / `max_displacement_frac` defaults are set by
   an ISE sweep over the reference set: see [`eval/`](eval/README.md).
3. **Projective texturing** (`face_projection.py`) - the face-oval warp only
   reaches about 10% of the head's texels. This solves a weak-perspective camera
   from the landmarks and paints the photo onto the ears, jawline, forehead and
   neck as well, lifting photographic coverage to roughly 37% (the figure the
   live service logs per job).

`precompute_uv.py` builds `face_uv_map.json` at image-build time: the canonical
face model, the landmark→head-vertex correspondence, and the skin UV mapping.

Each stage after the first is independently switchable and degrades instead of
failing: `GEOMETRY_MORPH=0` and `PROJECTIVE_TEXTURE=0` turn stages 2 and 3 off,
and if either raises, or the UV map lacks the fields it needs, the job still
returns a textured avatar. A refinement never fails a reconstruction.

Everything above is Apache-2.0 / MIT-clean (MediaPipe, numpy, scipy): no
non-commercial 3DMM (FLAME/BFM/SMPL) is used. See
[`docs/avatar-reconstruction.md`](../../docs/avatar-reconstruction.md) for the
fidelity roadmap (v2: dense MICA+FLAME identity via the model-agnostic
`register_head_to_target` primitive + Imagen texture inpaint; v3: an Anny/
MakeHuman CC0 body to drop the RPM-template dependency). FaceLift was evaluated
and rejected: non-commercial Adobe weights, splat output, not mesh.

### Templates

`templates/default.glb` is the only template the pipeline can use. It is
addressed by name throughout (a `Wolf3D_Head` mesh carrying the blendshapes, and
`Wolf3D_Skin` / `Wolf3D_Hair` / `Wolf3D_Eye` materials), and `face_uv_map.json`
is precomputed against that exact head topology. `body_type` therefore has no
effect yet: every value resolves to `default.glb`. Adding a male/female variant
means adding a GLB with the same head topology, or regenerating the UV map for
its own.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `API_KEY` | yes | Shared bearer secret. Production reads it from the `avatar-reconstruction-key` secret. |
| `GCS_BUCKET` | yes | Bucket for output GLBs (`three-ws-avatar-reconstructions`). |
| `FIRESTORE_PROJECT` | yes | Project hosting the Firestore job collection. |
| `MAX_CONCURRENT_JOBS` | no (2) | Jobs processed in parallel. |
| `GEOMETRY_MORPH` | no (`1`) | `0` skips the identity morph (texture only). |
| `MAX_MORPH_YAW_DEG` | no (35) | Above this head yaw the morph is skipped: a single view cannot constrain the occluded half of a turned face. |
| `PROJECTIVE_TEXTURE` | no (`1`) | `0` falls back to warp-only skin. |

The service reads no others. (Cloud Run also carries `DEVICE=cpu`, which predates
the GPU removal and is inert.)

## Prerequisites

1. GCP project with billing enabled and the Google for Startups Web3 credits
   applied: see [`docs/ops/gcp-credits-plan.md`](../../docs/ops/gcp-credits-plan.md).
2. APIs enabled: Cloud Run, Cloud Build, Artifact Registry, Cloud Storage, Firestore, Secret Manager
3. Artifact Registry repository created:
   ```
   gcloud artifacts repositories create avatar-reconstruction \
     --repository-format=docker \
     --location=us-central1
   ```
4. Cloud Storage bucket for output GLBs:
   ```
   gcloud storage buckets create gs://three-ws-avatar-reconstructions \
     --location=us-central1 \
     --uniform-bucket-level-access
   ```
5. Firestore database (native mode):
   ```
   gcloud firestore databases create --location=us-central1
   ```
6. API key secret in Secret Manager:
   ```
   echo -n "$(openssl rand -hex 32)" | \
     gcloud secrets create avatar-reconstruction-key \
       --data-file=-
   ```
7. The `avatar-reconstruction-sa@` service account, which both the build and the
   runtime pin (the project's default compute SA was deleted).

## Deploying

Owner-gated, like every production deploy in this repo (see `CLAUDE.md`).

```bash
# From this directory (the build context is the worker dir, not the repo root)
gcloud builds submit \
  --config cloudbuild.yaml \
  --region us-central1 \
  --project aerial-vehicle-466722-p5 \
  --substitutions _GCS_BUCKET=three-ws-avatar-reconstructions
```

The build runs the geometry, projection, texture and smoke tests as image-build
steps, so a regression fails the build instead of shipping. It also needs network
access: `precompute_uv.py` downloads the canonical face model (~200 KB from
GitHub) and the smoke test fetches one benchmark reference photo.

These are already set on the production `three-ws-api` service so the site
reaches this worker:

```
AVATAR_REGEN_PROVIDER=gcp
GCP_RECONSTRUCTION_URL=https://avatar-reconstruction-lp642k3kpa-uc.a.run.app
GCP_RECONSTRUCTION_KEY=<the avatar-reconstruction-key secret value>
```

To change them (note `--update-env-vars`, which merges: `--set-env-vars` would
replace the service's entire env):

```bash
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars AVATAR_REGEN_PROVIDER=gcp,GCP_RECONSTRUCTION_URL=<url>,GCP_RECONSTRUCTION_KEY=<key>
```

(For local development, put the same keys in your `.env`.) See the production
runbook: [`docs/ops/gcp-production.md`](../../docs/ops/gcp-production.md).

## API

Every route requires `Authorization: Bearer $API_KEY`, except `/health`.

### POST /reconstruct

Accepts 1-6 images as base64 data URIs or HTTPS URLs. Returns immediately; the
work runs in the background. HTTPS sources are fetched through the SSRF-hardened
client in `worker_security.py` (https-only, private/loopback/metadata addresses
rejected after DNS resolution, every redirect hop re-validated, response size
bounded).

```json
{
  "images": ["data:image/jpeg;base64,...", "https://..."],
  "body_type": "neutral",
  "job_id": "optional-caller-supplied-id"
}
```

`body_type` is `male` | `female` | `neutral` (default `neutral`); see
[Templates](#templates) for why it currently has no effect. `job_id` lets the
caller choose the id, which is how the platform correlates a reconstruction with
its own job row; omit it and the service generates a UUID.

Response `202 Accepted`:
```json
{ "job_id": "uuid", "status": "queued" }
```

### GET /jobs/{job_id}

Poll for status. `404` if the id is unknown.

```json
{
  "job_id": "...",
  "status": "done",
  "glb_url": "https://storage.googleapis.com/three-ws-avatar-reconstructions/avatars/....glb",
  "body_type": "neutral",
  "image_count": 1,
  "created_at": "2026-08-11T01:20:46.605950+00:00",
  "updated_at": "2026-08-11T01:20:53.044663+00:00"
}
```

`status` values: `queued` → `running` → `done` | `failed`

A `failed` job carries `error` plus `error_kind`, which says whose problem it is:

| `error_kind` | `error` | Meaning |
|---|---|---|
| `input` | the actual reason, e.g. `no face detected in any of the provided photos` | The photos were unusable. Safe to show the caller, and the site's job-error mapping reads this wording to tell the user what to change. |
| `internal` | `internal error (ref <id>)` | A service fault. The full traceback is in Cloud Logging under that correlation id, deliberately not in the response. |

### GET /health

Unauthenticated, and what the Cloud Run startup probe hits.

```json
{
  "ok": true,
  "pipeline": "face_texture_transfer_v2",
  "model_loaded": true,
  "uv_map_ready": true,
  "geometry_morph": true
}
```

`pipeline` is `face_texture_transfer_v2` when the geometry morph is live and
`face_texture_transfer_v1` when it is off or its map is missing.

## Tests

The image build runs all four, so a broken pipeline fails the build:

```bash
python3 test_face_geometry.py     # morph preserves the rig, blendshapes, mesh bounds
python3 test_face_projection.py   # camera fit, occlusion, UV rasterisation
python3 test_face_pipeline.py     # skin-tint masking (protects the photographic oval)
python3 smoke_test.py             # the whole core path on a real photo (needs network)
```

`smoke_test.py` is the one that catches what the others cannot: it runs
`face_pipeline.process` on a real reference photo and asserts the output GLB keeps
its head topology, all its morph targets and its skinning, that the photo reached
the texture, that the head actually moved, and that a faceless photo is rejected
as an input error rather than an internal one. Pass a URL or a local image path to
use a different photo. Fidelity measurement (a score, not a pass/fail) is a
separate suite: [`eval/`](eval/README.md).

## Local development (CPU only, no GPU)

```bash
docker build -t avatar-reconstruction .
docker run -p 8080:8080 \
  -e API_KEY=dev \
  -e GCS_BUCKET=three-ws-avatar-reconstructions \
  -e FIRESTORE_PROJECT=aerial-vehicle-466722-p5 \
  -v "$HOME/.config/gcloud:/root/.config/gcloud:ro" \
  -e GOOGLE_CLOUD_PROJECT=aerial-vehicle-466722-p5 \
  avatar-reconstruction
```

Startup opens real Firestore and Cloud Storage clients, so the container needs
credentials that can reach both (the mounted ADC above, or a service-account key).
To exercise the pipeline without them, run the smoke test in the container
instead: it calls `face_pipeline.process` directly and touches neither service.

```bash
docker run --rm avatar-reconstruction python /app/smoke_test.py
```
