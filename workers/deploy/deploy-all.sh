#!/usr/bin/env bash
#
# deploy-all.sh — provision + deploy the three.ws avatar reconstruction pipeline
# to Google Cloud Run, in the correct order, idempotently.
#
# Pipeline shape:
#   selfie photos → controller → mesh model (Hunyuan3D/TRELLIS/TripoSR, L4 GPU)
#                              → rig worker (L4 GPU) → rigged GLB in GCS
#
# The Vercel function api/_providers/gcp.js talks ONLY to the controller, so the
# last thing this prints is the controller URL + API key to put in Vercel env.
#
# Prerequisites (see README.md):
#   • gcloud authed to a project that has the $THREE GCP credits / billing linked
#   • Cloud Run L4 GPU quota in $REGION  (request early — approval can take hours)
#   • Weights already staged:  ./stage-weights.sh   (services won't boot without them)
#
# Usage:
#   PROJECT_ID=my-proj ./deploy-all.sh
#   PROJECT_ID=my-proj SERVICES="hunyuan3d trellis triposr rig" ./deploy-all.sh
#
# Env:
#   PROJECT_ID      required — target GCP project
#   REGION          default us-central1   (must offer Cloud Run nvidia-l4)
#   SERVICES        default "hunyuan3d rig"  (mesh model(s) + rigging)
#   OUTPUT_BUCKET   default three-ws-avatar-reconstructions
#   WEIGHTS_BUCKET  default three-ws-model-weights

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID to your GCP project}"
REGION="${REGION:-us-central1}"
SERVICES="${SERVICES:-hunyuan3d rig}"
OUTPUT_BUCKET="${OUTPUT_BUCKET:-three-ws-avatar-reconstructions}"
WEIGHTS_BUCKET="${WEIGHTS_BUCKET:-three-ws-model-weights}"
SECRET_NAME="avatar-reconstruction-key"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[deploy] ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy] ! \033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v gcloud >/dev/null 2>&1 || die "gcloud not found on PATH"
gcloud auth print-access-token >/dev/null 2>&1 || die "gcloud is not authenticated — run 'gcloud auth login'"

# service key -> "worker_dir|cloud_run_service|controller_env_var"
# The `rig` key deploys workers/rig as Cloud Run service `model-rig`. Its
# controller env var is still named UNIRIG_URL: the name predates the engine
# swap and is live on the running services, so it is deliberately not renamed.
svc_dir()      { case "$1" in hunyuan3d) echo model-hunyuan3d;; trellis) echo model-trellis;; triposr) echo model-triposr;; triposg) echo model-triposg;; rig) echo rig;; *) echo "";; esac; }
svc_runname()  { case "$1" in hunyuan3d) echo model-hunyuan3d;; trellis) echo model-trellis;; triposr) echo model-triposr;; triposg) echo model-triposg;; rig) echo model-rig;; *) echo "";; esac; }
svc_ctrlenv()  { case "$1" in hunyuan3d) echo MODEL_HUNYUAN3D_URL;; trellis) echo MODEL_TRELLIS_URL;; triposr) echo MODEL_TRIPOSR_URL;; triposg) echo MODEL_TRIPOSG_URL;; rig) echo UNIRIG_URL;; *) echo "";; esac; }

TAG="$(git rev-parse --short HEAD 2>/dev/null || echo manual)"

# ── 1. project + APIs ─────────────────────────────────────────────────────────
log "project: $PROJECT_ID   region: $REGION   services: $SERVICES"
gcloud config set project "$PROJECT_ID" >/dev/null
log "enabling required APIs (idempotent)…"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  storage.googleapis.com firestore.googleapis.com secretmanager.googleapis.com \
  --project "$PROJECT_ID" >/dev/null
ok "APIs enabled"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
# Build + runtime identity. Hardened orgs (like this project) have NO default
# compute service account, so we use one explicit SA for both building and
# running. Override via RUN_SA / BUILD_SA if your project differs.
RUN_SA="${RUN_SA:-avatar-reconstruction-sa@${PROJECT_ID}.iam.gserviceaccount.com}"
BUILD_SA="${BUILD_SA:-$RUN_SA}"

# ── 2. buckets ────────────────────────────────────────────────────────────────
for b in "$OUTPUT_BUCKET" "$WEIGHTS_BUCKET"; do
  if gcloud storage buckets describe "gs://$b" >/dev/null 2>&1; then
    ok "bucket gs://$b exists"
  else
    log "creating bucket gs://$b…"
    gcloud storage buckets create "gs://$b" --location="$REGION" --uniform-bucket-level-access >/dev/null
    ok "created gs://$b"
  fi
done
# Output GLBs are served publicly (the avatar materializer fetches them by URL).
gcloud storage buckets add-iam-policy-binding "gs://$OUTPUT_BUCKET" \
  --member=allUsers --role=roles/storage.objectViewer >/dev/null 2>&1 || \
  warn "could not make $OUTPUT_BUCKET public-read (org policy may block allUsers) — check materializer fetch"

# ── 3. Firestore (controller job state) ───────────────────────────────────────
if gcloud firestore databases describe --database="(default)" >/dev/null 2>&1; then
  ok "Firestore (default) database exists"
else
  log "creating Firestore native database in $REGION…"
  gcloud firestore databases create --location="$REGION" --type=firestore-native >/dev/null \
    || warn "Firestore create failed — create a native-mode DB manually if the controller errors"
fi

# ── 4. shared API key secret ──────────────────────────────────────────────────
if gcloud secrets describe "$SECRET_NAME" >/dev/null 2>&1; then
  ok "secret $SECRET_NAME exists"
else
  log "creating secret $SECRET_NAME with a fresh random key…"
  openssl rand -hex 32 | gcloud secrets create "$SECRET_NAME" --data-file=- >/dev/null
  ok "created secret $SECRET_NAME"
fi

# ── 5. IAM for the build + runtime service account ────────────────────────────
log "ensuring $RUN_SA has the needed build + runtime roles…"
for role in roles/secretmanager.secretAccessor roles/datastore.user roles/storage.objectAdmin \
            roles/run.admin roles/artifactregistry.writer roles/logging.logWriter \
            roles/cloudbuild.builds.builder; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUN_SA}" --role="$role" --condition=None >/dev/null 2>&1 \
    || warn "could not grant $role to $RUN_SA (may already be bound or need an admin)"
done
# The build runs AS this SA and deploys Cloud Run with it as the runtime SA, so
# it must be permitted to actAs itself.
gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" \
  --member="serviceAccount:${RUN_SA}" --role="roles/iam.serviceAccountUser" --condition=None >/dev/null 2>&1 \
  || warn "could not grant actAs-self to $RUN_SA"
ok "build + runtime IAM configured"

# ── 6. Artifact Registry repos + build/deploy each GPU service ────────────────
declare -A SERVICE_URL
build_and_deploy() {
  local key="$1" dir runname repo
  dir="workers/$(svc_dir "$key")"
  runname="$(svc_runname "$key")"
  repo="$runname"
  [ -d "$dir" ] || die "worker dir not found: $dir"

  if ! gcloud artifacts repositories describe "$repo" --location="$REGION" >/dev/null 2>&1; then
    log "creating Artifact Registry repo '$repo'…"
    gcloud artifacts repositories create "$repo" --repository-format=docker --location="$REGION" >/dev/null
  fi

  log "building + deploying '$runname' (this builds a CUDA GPU image — several minutes)…"
  gcloud builds submit \
    --config "$dir/cloudbuild.yaml" \
    --region "$REGION" \
    --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" \
    --default-buckets-behavior=regional-user-owned-bucket \
    --substitutions="SHORT_SHA=${TAG},_REGION=${REGION},_GCS_BUCKET=${OUTPUT_BUCKET},_WEIGHTS_BUCKET=${WEIGHTS_BUCKET},_RUN_SA=${RUN_SA}" \
    . \
    || die "build/deploy failed for $runname — inspect the Cloud Build log above"

  local url
  url="$(gcloud run services describe "$runname" --region "$REGION" --format='value(status.url)')"
  [ -n "$url" ] || die "could not resolve URL for $runname after deploy"
  SERVICE_URL["$key"]="$url"
  ok "$runname → $url"
}

for svc in $SERVICES; do
  [ -n "$(svc_dir "$svc")" ] || die "unknown service '$svc' (valid: hunyuan3d trellis triposr triposg rig)"
  build_and_deploy "$svc"
done

# ── 7. controller — deploy, then wire to the backend URLs it must call ────────
log "building + deploying controller (avatar-pipeline-controller, CPU)…"
gcloud builds submit \
  --config "workers/avatar-pipeline-controller/cloudbuild.yaml" \
  --region "$REGION" \
  --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" \
  --default-buckets-behavior=regional-user-owned-bucket \
  --substitutions="SHORT_SHA=${TAG},_REGION=${REGION},_GCS_BUCKET=${OUTPUT_BUCKET},_RUN_SA=${RUN_SA}" \
  . \
  || die "controller build/deploy failed"

# The controller's cloudbuild does NOT know the backend URLs (they don't exist
# until the services above are deployed). Wire them in now.
CTRL_ENV=""
for svc in $SERVICES; do
  envvar="$(svc_ctrlenv "$svc")"
  url="${SERVICE_URL[$svc]:-}"
  [ -n "$envvar" ] && [ -n "$url" ] && CTRL_ENV="${CTRL_ENV:+$CTRL_ENV,}${envvar}=${url}"
done
if [ -n "$CTRL_ENV" ]; then
  log "wiring controller → backends: $CTRL_ENV"
  gcloud run services update avatar-pipeline-controller --region "$REGION" \
    --update-env-vars "$CTRL_ENV" >/dev/null
fi
CONTROLLER_URL="$(gcloud run services describe avatar-pipeline-controller --region "$REGION" --format='value(status.url)')"
API_KEY_VALUE="$(gcloud secrets versions access latest --secret="$SECRET_NAME")"

ok "controller → $CONTROLLER_URL"

# ── 8. smoke test + handoff ───────────────────────────────────────────────────
log "controller health:"
curl -fsS -H "authorization: Bearer ${API_KEY_VALUE}" "${CONTROLLER_URL}/health" || warn "health check did not return 200 yet (cold start) — retry in a minute"
echo

# The forge sketch→3D lane talks to the TripoSG worker directly (not through
# the controller), so its URL is a separate Vercel env var.
TRIPOSG_HANDOFF=""
if [ -n "${SERVICE_URL[triposg]:-}" ]; then
  TRIPOSG_HANDOFF="  GCP_TRIPOSG_URL         = ${SERVICE_URL[triposg]}

  vercel env add GCP_TRIPOSG_URL production         # paste the TripoSG URL (forge sketch→3D)
"
fi

cat <<EOF

────────────────────────────────────────────────────────────────────────
 DEPLOY COMPLETE. Set these in Vercel (Production), then redeploy the site:
────────────────────────────────────────────────────────────────────────
  AVATAR_REGEN_PROVIDER   = gcp
  GCP_RECONSTRUCTION_URL  = ${CONTROLLER_URL}
  GCP_RECONSTRUCTION_KEY  = ${API_KEY_VALUE}
${TRIPOSG_HANDOFF}
  vercel env add AVATAR_REGEN_PROVIDER production   # paste: gcp
  vercel env add GCP_RECONSTRUCTION_URL production  # paste the URL above
  vercel env add GCP_RECONSTRUCTION_KEY production  # paste the key above

 Then verify: open /scan, capture a selfie, expect a rigged GLB in ~1–2 min.
────────────────────────────────────────────────────────────────────────
EOF
