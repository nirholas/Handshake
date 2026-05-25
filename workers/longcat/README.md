# LongCat Video Avatar Worker

FastAPI service running LongCat-Video-Avatar-1.5 on Cloud Run (NVIDIA L4 GPU).
Accepts a reference image + audio URL, generates a lip-synced talking avatar video,
and stores the MP4 in Cloud Storage.

Model: [meituan-longcat/LongCat-Video-Avatar-1.5](https://huggingface.co/meituan-longcat/LongCat-Video-Avatar-1.5) — MIT license.

## API

```
POST /generate  { image_url, audio_url, prompt?, job_id? }
             →  202 { job_id, status: "queued" }

GET  /jobs/:id  → { job_id, status, video_url?, error?, updated_at }

GET  /health    → { ok, model_loaded, resolution }
```

Auth: `Authorization: Bearer <API_KEY>` on every request.

## Prerequisites

```bash
# 1. Enable GCP APIs
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com

# 2. Artifact Registry repo
gcloud artifacts repositories create longcat-video-avatar \
  --repository-format=docker \
  --location=us-central1

# 3. GCS bucket for output MP4s
gcloud storage buckets create gs://three-ws-avatar-videos \
  --location=us-central1 \
  --uniform-bucket-level-access

# Make videos publicly readable
gcloud storage buckets add-iam-policy-binding gs://three-ws-avatar-videos \
  --member=allUsers \
  --role=roles/storage.objectViewer

# 4. GCS bucket for model weights (mounted as a volume at /weights)
gcloud storage buckets create gs://three-ws-longcat-weights \
  --location=us-central1 \
  --uniform-bucket-level-access

# 5. Firestore (native mode, if not already created)
gcloud firestore databases create --location=us-central1

# 6. API key secret
echo -n "$(openssl rand -hex 32)" | \
  gcloud secrets create longcat-video-avatar-key \
    --data-file=-

# 7. Pre-download model weights into the weights bucket (one-time, ~14 GB INT8)
#    Run from a machine with Python + huggingface_hub installed:
python - <<'EOF'
from huggingface_hub import snapshot_download
import subprocess, pathlib

local = pathlib.Path("/tmp/longcat-weights/LongCat-Video-Avatar")
snapshot_download(
    "meituan-longcat/LongCat-Video-Avatar-1.5",
    local_dir=str(local),
    ignore_patterns=["*.pt"],
)
EOF
gcloud storage cp -r /tmp/longcat-weights/LongCat-Video-Avatar \
  gs://three-ws-longcat-weights/LongCat-Video-Avatar
```

## Deploying

```bash
# From repo root
gcloud builds submit \
  --config workers/longcat/cloudbuild.yaml \
  --substitutions _GCS_BUCKET=three-ws-avatar-videos,_WEIGHTS_BUCKET=three-ws-longcat-weights
```

After deploy, copy the Cloud Run service URL and API key to Vercel:

```bash
# Get the service URL
gcloud run services describe longcat-video-avatar \
  --region=us-central1 \
  --format='value(status.url)'

# Get the API key value
gcloud secrets versions access latest --secret=longcat-video-avatar-key

# Set in Vercel
vercel env add LONGCAT_WORKER_URL production
vercel env add LONGCAT_WORKER_KEY production
```

## Cost estimate (us-central1 L4 GPU)

| SKU                   | Rate       | 30-day idle (min=1) |
|-----------------------|------------|---------------------|
| L4 GPU                | ~$0.70/hr  | ~$504/month         |
| 8 vCPU                | ~$0.24/hr  | ~$173/month         |
| 32 GB RAM             | ~$0.08/hr  | ~$58/month          |
| GCS egress (videos)   | $0.12/GB   | depends on volume   |

With $100k credits this runs for ~130 months at idle. Inference per video
(720p, 8-step distilled): ~2–4 minutes on L4.
