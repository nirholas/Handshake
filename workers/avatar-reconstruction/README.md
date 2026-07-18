# Avatar Reconstruction Service

FastAPI service on a Cloud Run GPU instance (NVIDIA L4) that turns 1–6 selfie
photos into a rigged, animation-ready GLB avatar and stores it in Cloud Storage.
Same external contract the three.ws backend (`api/_providers/gcp.js`) already
speaks — `POST /reconstruct` → `GET /jobs/:id`.

## Pipeline

The avatar is built on a fixed-topology Wolf3D/RPM template head+body that ships
pre-rigged with a humanoid skeleton and **52 ARKit blendshapes + 15 visemes**
(the same architecture Avaturn uses: fit a person onto a rigged template, don't
generate an arbitrary mesh). Two phases, both commercial-clean:

1. **Face texture transfer** (`face_pipeline.py`) — MediaPipe FaceLandmarker →
   TPS-warp the selfie into the template's skin UV → composite over the face
   oval → sample and tint skin / hair / eye colour.
2. **Face geometry morph** (`face_geometry.py`, Phase 2) — recover the person's
   actual 3D face shape (width, jaw, nose projection, brow, cheekbones) from the
   same 468 MediaPipe landmarks and reshape the template head to match, so the
   avatar reads as *that person* instead of their texture on a generic head.
   Umeyama-aligns the landmarks to MediaPipe's neutral canonical face, carries
   the identity residual onto the head's corresponding vertices (precomputed
   nearest-vertex map), and diffuses it with a normalised-Gaussian RBF that fades
   to zero off the face. Vertex count/order are preserved, so `glb_ops.set_head_geometry`
   writes it back **without disturbing skinning or any blendshape**.

`precompute_uv.py` builds `face_uv_map.json` at image-build time: the canonical
face model, the landmark→head-vertex correspondence, and the skin UV mapping.

Toggle Phase 2 with `GEOMETRY_MORPH` (default `1`; set `0` for texture-only). If
the map lacks geometry fields or the morph raises, the job degrades cleanly to
texture-only — the shape refinement never fails a reconstruction.

Everything above is Apache-2.0 / MIT-clean (MediaPipe, numpy, scipy) — no
non-commercial 3DMM (FLAME/BFM/SMPL) is used. See
[`docs/avatar-reconstruction.md`](../../docs/avatar-reconstruction.md) for the
fidelity roadmap (v2: dense MICA+FLAME identity via the model-agnostic
`register_head_to_target` primitive + Imagen texture inpaint; v3: an Anny/
MakeHuman CC0 body to drop the RPM-template dependency). FaceLift was evaluated
and rejected — non-commercial Adobe weights, splat output, not mesh.

## Prerequisites

1. GCP project with billing enabled and the $110k credits applied
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

## Deploying

```bash
# From repo root
gcloud builds submit \
  --config workers/avatar-reconstruction/cloudbuild.yaml \
  --substitutions _GCS_BUCKET=three-ws-avatar-reconstructions
```

After deploy, Cloud Build prints the service URL. Set these on the three.ws
production service (Cloud Run `three-ws-api`) so the site can reach this worker:

```
AVATAR_REGEN_PROVIDER=gcp
GCP_RECONSTRUCTION_URL=https://avatar-reconstruction-<hash>-uc.a.run.app
GCP_RECONSTRUCTION_KEY=<the secret value from step 6>
```

```bash
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars AVATAR_REGEN_PROVIDER=gcp,GCP_RECONSTRUCTION_URL=https://avatar-reconstruction-<hash>-uc.a.run.app,GCP_RECONSTRUCTION_KEY=<key>
```

(For local development, put the same keys in your `.env`.) See the production
runbook: [`docs/ops/gcp-production.md`](../../docs/ops/gcp-production.md).

## API

### POST /reconstruct

Accepts 1–6 images (base64 data URIs or HTTPS URLs). Returns immediately with a `job_id`.

```json
{
  "images": ["data:image/jpeg;base64,...", "https://..."]
}
```

Response `202 Accepted`:
```json
{ "job_id": "uuid", "status": "queued" }
```

### GET /jobs/{job_id}

Poll for status.

```json
{ "job_id": "...", "status": "done", "glb_url": "https://storage.googleapis.com/..." }
```

`status` values: `queued` → `running` → `done` | `failed`

### GET /health

Returns `{ "ok": true, "pipeline": "face_texture_transfer_v2", "model_loaded": true, "geometry_morph": true }`.

## Local development (CPU only, no GPU)

```bash
docker build -t avatar-reconstruction .
docker run -p 8080:8080 \
  -e API_KEY=dev \
  -e GCS_BUCKET=my-bucket \
  -e FIRESTORE_PROJECT=my-project \
  -e DEVICE=cpu \
  avatar-reconstruction
```
