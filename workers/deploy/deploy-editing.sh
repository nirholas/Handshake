#!/usr/bin/env bash
#
# deploy-editing.sh — provision + deploy the three.ws mesh-editing workers
# (stylize / remesh / segment / rembg, optionally texture / text2motion)
# to Google Cloud Run, idempotently.
#
# These are the services behind /api/forge-stylize, /api/forge-remesh,
# /api/forge-segment, /api/forge-rembg, /api/studio/retexture-* and
# /api/forge-motion. The default set is CPU-only: no GPU quota, no staged
# weights — a clean project deploys in ~10 minutes.
#
# Fastest path: run this in Google Cloud Shell from a clone of the repo —
# it is pre-authenticated and has gcloud + docker. See README.md.
#
# Usage:
#   PROJECT_ID=my-proj ./workers/deploy/deploy-editing.sh
#   PROJECT_ID=my-proj SERVICES="stylize" ./workers/deploy/deploy-editing.sh
#
# Env:
#   PROJECT_ID        required: target GCP project
#   REGION            default us-central1
#   SERVICES          default "stylize remesh segment rembg" (all CPU).
#                     GPU extras (need L4 quota): texture text2motion.
#                     texture needs its SDXL checkpoints staged first with
#                     workers/texture/stage_weights.py; text2motion needs the MDM
#                     checkpoint staged by hand at gs://$WEIGHTS_BUCKET/mdm/
#                     (see stage-weights.sh's header).
#   OUTPUT_BUCKET     default three-ws-avatar-reconstructions
#   WEIGHTS_BUCKET    default three-ws-model-weights (GPU services only)
#   RUN_SA            default avatar-reconstruction-sa@$PROJECT_ID (created if
#                     missing; every deployed service runs as it)
#   BUILD_SA          default three-ws-build@$PROJECT_ID when that SA exists,
#                     else RUN_SA
#
# Optional site auto-wiring: set WIRE_SITE=1 and the script upserts the
# GCP_*_URL vars onto the site's Cloud Run service with --update-env-vars
# (a merge, never a replace). Off by default because that mutates a running
# production service:
#   WIRE_SITE         "1" to update SITE_SERVICE's env after a successful deploy
#   SITE_SERVICE      default three-ws-api

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID to your GCP project}"
REGION="${REGION:-us-central1}"
SERVICES="${SERVICES:-stylize remesh segment rembg}"
OUTPUT_BUCKET="${OUTPUT_BUCKET:-three-ws-avatar-reconstructions}"
WEIGHTS_BUCKET="${WEIGHTS_BUCKET:-three-ws-model-weights}"
SECRET_NAME="avatar-reconstruction-key"
SITE_SERVICE="${SITE_SERVICE:-three-ws-api}"
WIRE_SITE="${WIRE_SITE:-0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

log()  { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[deploy] ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy] ! \033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v gcloud >/dev/null 2>&1 || die "gcloud not found on PATH"
gcloud auth print-access-token >/dev/null 2>&1 || die "gcloud is not authenticated — run 'gcloud auth login'"

# service key -> worker dir | Cloud Run service name | site env var | needs GPU
svc_dir()    { case "$1" in stylize) echo stylize;; remesh) echo remesh;; segment) echo segment;; rembg) echo rembg;; texture) echo texture;; text2motion) echo model-text2motion;; *) echo "";; esac; }
svc_run()    { case "$1" in stylize) echo stylize-service;; remesh) echo remesh-service;; segment) echo segment-service;; rembg) echo rembg-service;; texture) echo texture-service;; text2motion) echo model-text2motion;; *) echo "";; esac; }
svc_envvar() { case "$1" in stylize) echo GCP_STYLIZE_URL;; remesh) echo GCP_REMESH_URL;; segment) echo GCP_SEGMENT_URL;; rembg) echo GCP_REMBG_URL;; texture) echo GCP_TEXTURE_URL;; text2motion) echo GCP_TEXT2MOTION_URL;; *) echo "";; esac; }
svc_gpu()    { case "$1" in texture|text2motion) echo yes;; *) echo no;; esac; }

for svc in $SERVICES; do
  [ -n "$(svc_dir "$svc")" ] || die "unknown service '$svc' (valid: stylize remesh segment rembg texture text2motion)"
  if [ "$(svc_gpu "$svc")" = yes ]; then
    warn "'$svc' needs Cloud Run L4 GPU quota in $REGION"
  fi
done
# Both GPU workers here read the weights bucket at runtime. text2motion reads
# MOTION_MODEL_DIR=/weights/mdm; texture stages gs://.../sdxl-texture to local
# disk on first load and only the depth ControlNet is baked into its image, so
# an unstaged prefix leaves it downloading SDXL inside the first request.
case " $SERVICES " in
  *" text2motion "*)
    warn "'text2motion' loads the MDM checkpoint from gs://${WEIGHTS_BUCKET}/mdm/ (model.pt + args.json); stage it before the first request or the service 503s on cold start" ;;
esac
case " $SERVICES " in
  *" texture "*)
    warn "'texture' loads SDXL from gs://${WEIGHTS_BUCKET}/sdxl-texture; run 'python3 workers/texture/stage_weights.py' first or its first request burns the 600s timeout downloading weights" ;;
esac

TAG="$(git rev-parse --short HEAD 2>/dev/null || echo manual)"

# ── 1. project + APIs ─────────────────────────────────────────────────────────
log "project: $PROJECT_ID   region: $REGION   services: $SERVICES"
gcloud config set project "$PROJECT_ID" >/dev/null
log "enabling required APIs (idempotent)…"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  storage.googleapis.com secretmanager.googleapis.com iam.googleapis.com \
  --project "$PROJECT_ID" >/dev/null
ok "APIs enabled"

RUN_SA="${RUN_SA:-avatar-reconstruction-sa@${PROJECT_ID}.iam.gserviceaccount.com}"
# Every workers/*/cloudbuild.yaml pins `serviceAccount:` to the canonical build
# SA, but that pin hardcodes THIS project's number, so a build run against any
# other project must re-point it; --service-account overrides the pin. Prefer
# the same name in the target project, and fall back to the runtime SA (which
# step 5 grants cloudbuild.builds.builder) when it is absent.
if [ -z "${BUILD_SA:-}" ]; then
  BUILD_SA="three-ws-build@${PROJECT_ID}.iam.gserviceaccount.com"
  gcloud iam service-accounts describe "$BUILD_SA" >/dev/null 2>&1 || BUILD_SA="$RUN_SA"
fi

# ── 2. build/runtime service account ──────────────────────────────────────────
if gcloud iam service-accounts describe "$RUN_SA" >/dev/null 2>&1; then
  ok "service account $RUN_SA exists"
else
  log "creating service account ${RUN_SA%%@*}…"
  gcloud iam service-accounts create "${RUN_SA%%@*}" \
    --display-name="three.ws avatar/editing workers (build + runtime)" >/dev/null
  ok "created $RUN_SA"
fi

# ── 3. output bucket ──────────────────────────────────────────────────────────
if gcloud storage buckets describe "gs://$OUTPUT_BUCKET" >/dev/null 2>&1; then
  ok "bucket gs://$OUTPUT_BUCKET exists"
else
  log "creating bucket gs://$OUTPUT_BUCKET…"
  gcloud storage buckets create "gs://$OUTPUT_BUCKET" --location="$REGION" --uniform-bucket-level-access >/dev/null
  ok "created gs://$OUTPUT_BUCKET"
fi
# Result meshes are fetched by URL from the browser and the site API, so public-read.
gcloud storage buckets add-iam-policy-binding "gs://$OUTPUT_BUCKET" \
  --member=allUsers --role=roles/storage.objectViewer >/dev/null 2>&1 || \
  warn "could not make $OUTPUT_BUCKET public-read (org policy may block allUsers) — result URLs will 403"

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
for role in roles/secretmanager.secretAccessor roles/storage.objectAdmin \
            roles/run.admin roles/artifactregistry.writer roles/logging.logWriter \
            roles/cloudbuild.builds.builder; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUN_SA}" --role="$role" --condition=None >/dev/null 2>&1 \
    || warn "could not grant $role to $RUN_SA (may already be bound or need an admin)"
done
gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" \
  --member="serviceAccount:${RUN_SA}" --role="roles/iam.serviceAccountUser" --condition=None >/dev/null 2>&1 \
  || warn "could not grant actAs-self to $RUN_SA"
ok "build + runtime IAM configured"

# ── 6. build + deploy each worker ─────────────────────────────────────────────
declare -A SERVICE_URL
for svc in $SERVICES; do
  dir="workers/$(svc_dir "$svc")"
  runname="$(svc_run "$svc")"
  repo="$runname"
  [ -d "$dir" ] || die "worker dir not found: $dir"

  if ! gcloud artifacts repositories describe "$repo" --location="$REGION" >/dev/null 2>&1; then
    log "creating Artifact Registry repo '$repo'…"
    gcloud artifacts repositories create "$repo" --repository-format=docker --location="$REGION" >/dev/null
  fi

  subs="SHORT_SHA=${TAG},_REGION=${REGION},_GCS_BUCKET=${OUTPUT_BUCKET},_RUN_SA=${RUN_SA}"
  [ "$(svc_gpu "$svc")" = yes ] && subs="${subs},_WEIGHTS_BUCKET=${WEIGHTS_BUCKET}"

  log "building + deploying '$runname' (several minutes)…"
  gcloud builds submit \
    --config "$dir/cloudbuild.yaml" \
    --region "$REGION" \
    --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" \
    --default-buckets-behavior=regional-user-owned-bucket \
    --substitutions="$subs" \
    . \
    || die "build/deploy failed for $runname — inspect the Cloud Build log above"

  url="$(gcloud run services describe "$runname" --region "$REGION" --format='value(status.url)')"
  [ -n "$url" ] || die "could not resolve URL for $runname after deploy"
  SERVICE_URL["$svc"]="$url"
  ok "$runname → $url"
done

# ── 7. health checks ──────────────────────────────────────────────────────────
for svc in $SERVICES; do
  url="${SERVICE_URL[$svc]}"
  if curl -fsS --max-time 60 "$url/health" >/dev/null 2>&1; then
    ok "$svc health OK"
  else
    warn "$svc /health not ready yet (cold start) — retry: curl $url/health"
  fi
done

# ── 8. site env wiring (Cloud Run) ────────────────────────────────────────────
# The site has run on Cloud Run since 2026-07-07. GCP_RECONSTRUCTION_KEY is not
# written here: the site mounts it straight from Secret Manager
# ($SECRET_NAME), which is the same secret these workers authenticate against.
SITE_ENV=""
for svc in $SERVICES; do
  SITE_ENV="${SITE_ENV:+$SITE_ENV,}$(svc_envvar "$svc")=${SERVICE_URL[$svc]}"
done

if [ "$WIRE_SITE" = "1" ]; then
  log "updating ${SITE_SERVICE} env (merge, not replace)…"
  # --update-env-vars MERGES; --set-env-vars would drop every other variable
  # the site needs. Never swap one for the other here.
  gcloud run services update "$SITE_SERVICE" --region "$REGION" --project "$PROJECT_ID" \
    --update-env-vars "$SITE_ENV" >/dev/null \
    && ok "${SITE_SERVICE} updated; the new revision serves the new URLs" \
    || warn "could not update ${SITE_SERVICE}, run the command printed below by hand"
else
  log "WIRE_SITE not set, printing the wiring command instead of running it"
fi

# ── 9. handoff ────────────────────────────────────────────────────────────────
cat <<EOF

────────────────────────────────────────────────────────────────────────
 DEPLOY COMPLETE. Deployed services:
────────────────────────────────────────────────────────────────────────
EOF
for svc in $SERVICES; do
  printf '  %-24s = %s\n' "$(svc_envvar "$svc")" "${SERVICE_URL[$svc]}"
done
cat <<EOF

 Wire them onto the site (Cloud Run ${SITE_SERVICE}):
   gcloud run services update ${SITE_SERVICE} --region ${REGION} \\
     --project ${PROJECT_ID} \\
     --update-env-vars ${SITE_ENV}

 Verify once the new revision is serving (expect 202 with a job_id, then a
 result GLB):
   curl -X POST https://three.ws/api/forge-stylize \\
     -H 'content-type: application/json' \\
     -d '{"mesh_url":"<your GLB url>","style":"voxel"}'
────────────────────────────────────────────────────────────────────────
EOF
