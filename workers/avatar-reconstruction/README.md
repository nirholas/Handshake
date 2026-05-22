# Avatar Reconstruction Service

FastAPI service running InstantMesh on a Cloud Run GPU instance (NVIDIA L4). Accepts 1–6 face photos, synthesizes 6 multi-view renders via Zero123++, reconstructs a textured GLB mesh via InstantMesh, and stores the result in Cloud Storage.

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

After deploy, Cloud Build prints the service URL. Copy it into your Vercel / `.env` file:

```
AVATAR_REGEN_PROVIDER=gcp
GCP_RECONSTRUCTION_URL=https://avatar-reconstruction-<hash>-uc.a.run.app
GCP_RECONSTRUCTION_KEY=<the secret value from step 6>
```

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

Returns `{ "ok": true, "device": "cuda", "model_loaded": true }`.

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
