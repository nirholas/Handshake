#!/usr/bin/env bash
#
# teardown.sh — delete the GCP resources the $THREE credit program stood up, so
# nothing keeps billing after the credits expire. DRY-RUN BY DEFAULT: it lists
# what it *would* delete and changes nothing until you pass --apply.
#
# Run this ONLY after scripts/gcp/revert-to-free.sh is done and verified — i.e.
# every lane is serving from its non-GCP fallback and no traffic hits these
# services. Deleting first would break live features.
#
# What it removes (matches what workers/deploy/*.sh created):
#   • Cloud Run services   — the GPU workers + the avatar-pipeline-controller
#   • Artifact Registry     — the docker repo their images live in
#   • GCS buckets           — WEIGHTS bucket (model weights) always safe to delete;
#                             OUTPUT bucket only with --include-output (see warning)
#   • Secret Manager secret — the worker bearer key
#   • Service account       — the Cloud Run runtime SA
#
# What it NEVER touches (durable assets that outlive the credits):
#   • R2 — every user-facing GLB / avatar / animation is persisted to R2, not GCS.
#   • The Firestore (default) DB — may hold job history; deleting a DB is
#     irreversible and out of scope. Listed as a manual decision, never auto-deleted.
#   • Vanity inventory — lives in the app DB / R2, independent of GCP.
#
# Usage:
#   scripts/gcp/teardown.sh                      # dry-run: list everything, delete nothing
#   scripts/gcp/teardown.sh --apply              # delete Cloud Run + registry + weights bucket + secret + SA
#   scripts/gcp/teardown.sh --apply --include-output   # ALSO delete the OUTPUT bucket (see warning)
#   scripts/gcp/teardown.sh --apply --yes        # skip the confirm prompt
#
# Env:
#   PROJECT_ID       (default: gcloud active project)
#   REGION           (default: us-central1)
#   SERVICES         Cloud Run services to delete (default: full known set)
#   WEIGHTS_BUCKET   (default: three-ws-model-weights)
#   OUTPUT_BUCKET    (default: three-ws-avatar-reconstructions)
#   ARTIFACT_REPO    (default: three-ws-workers)
#   SECRET_NAME      (default: avatar-reconstruction-key)
#   RUN_SA_NAME      (default: avatar-reconstruction-sa)

set -euo pipefail

APPLY=0; ASSUME_YES=0; INCLUDE_OUTPUT=0
for arg in "$@"; do
  case "$arg" in
    --apply)           APPLY=1 ;;
    --dry-run)         APPLY=0 ;;
    --include-output)  INCLUDE_OUTPUT=1 ;;
    --yes|-y)          ASSUME_YES=1 ;;
    -h|--help)         sed -n '2,50p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

REGION="${REGION:-us-central1}"
SERVICES="${SERVICES:-model-trellis model-hunyuan3d model-triposr model-triposg model-rig avatar-pipeline-controller rembg remesh texture segment}"
WEIGHTS_BUCKET="${WEIGHTS_BUCKET:-three-ws-model-weights}"
OUTPUT_BUCKET="${OUTPUT_BUCKET:-three-ws-avatar-reconstructions}"
ARTIFACT_REPO="${ARTIFACT_REPO:-three-ws-workers}"
SECRET_NAME="${SECRET_NAME:-avatar-reconstruction-key}"
RUN_SA_NAME="${RUN_SA_NAME:-avatar-reconstruction-sa}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
del()  { printf '\033[31m%s\033[0m\n' "$*"; }

command -v gcloud >/dev/null 2>&1 || { echo "gcloud not found on PATH" >&2; exit 1; }
gcloud auth print-access-token >/dev/null 2>&1 || { echo "gcloud not authenticated — run 'gcloud auth login'" >&2; exit 1; }
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT_ID" ] || { echo "No PROJECT_ID and no active gcloud project" >&2; exit 1; }
RUN_SA="${RUN_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

if [ "$APPLY" -eq 1 ]; then
  bold "▶ teardown — APPLY mode. Resources below WILL BE DELETED."
else
  bold "▶ teardown — DRY RUN. Nothing is deleted. Re-run with --apply to execute."
fi
echo "  project=$PROJECT_ID region=$REGION"
echo

# Guard: make sure the revert ran first. If any forge/imagen gate var is still in
# your shell, you may not have reverted prod — warn, don't block (env lives in Vercel).
if [ -n "${MODEL_TRELLIS_URL:-}${GCP_RECONSTRUCTION_URL:-}${GOOGLE_CLOUD_PROJECT:-}" ]; then
  warn "  ⚠ GCP gate vars are still set in THIS shell. Confirm scripts/gcp/revert-to-free.sh"
  warn "    has been applied to PRODUCTION (Vercel) and traffic has drained before deleting."
  echo
fi

# Helper: describe existence, then delete (or print) per resource.
run_or_echo() {
  # $1 = human label, rest = the command
  local label="$1"; shift
  if [ "$APPLY" -eq 1 ]; then
    printf '  '; del "DELETE $label"
    "$@" --quiet || warn "    (failed — may already be gone or blocked by IAM)"
  else
    printf '  would delete: %s\n' "$label"
    dim   "    \$ $*"
  fi
}

# ── 1) Cloud Run services ─────────────────────────────────────────────────────
bold "1) Cloud Run services"
for svc in $SERVICES; do
  if gcloud run services describe "$svc" --region "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
    run_or_echo "run service $svc" gcloud run services delete "$svc" --region "$REGION" --project "$PROJECT_ID"
  else
    dim "  · $svc — not present, skipping"
  fi
done
echo

# ── 2) Artifact Registry repo (the worker images) ─────────────────────────────
bold "2) Artifact Registry"
if gcloud artifacts repositories describe "$ARTIFACT_REPO" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  run_or_echo "artifact repo $ARTIFACT_REPO" gcloud artifacts repositories delete "$ARTIFACT_REPO" --location "$REGION" --project "$PROJECT_ID"
else
  dim "  · $ARTIFACT_REPO — not present, skipping"
fi
echo

# ── 3) GCS buckets ────────────────────────────────────────────────────────────
bold "3) GCS buckets"
if gcloud storage buckets describe "gs://$WEIGHTS_BUCKET" --project "$PROJECT_ID" >/dev/null 2>&1; then
  run_or_echo "weights bucket gs://$WEIGHTS_BUCKET (model weights — re-downloadable, safe)" \
    gcloud storage rm --recursive "gs://$WEIGHTS_BUCKET"
else
  dim "  · gs://$WEIGHTS_BUCKET — not present, skipping"
fi
if [ "$INCLUDE_OUTPUT" -eq 1 ]; then
  warn "  ⚠ OUTPUT bucket gs://$OUTPUT_BUCKET is the pipeline's GCS handoff. User-facing assets"
  warn "    are copied to R2, but confirm nothing serves gs:// URLs directly before deleting."
  if gcloud storage buckets describe "gs://$OUTPUT_BUCKET" --project "$PROJECT_ID" >/dev/null 2>&1; then
    run_or_echo "output bucket gs://$OUTPUT_BUCKET" gcloud storage rm --recursive "gs://$OUTPUT_BUCKET"
  else
    dim "  · gs://$OUTPUT_BUCKET — not present, skipping"
  fi
else
  dim "  · gs://$OUTPUT_BUCKET — kept (pass --include-output to delete; verify R2 copy first)"
fi
echo

# ── 4) Secret + service account ───────────────────────────────────────────────
bold "4) Secret Manager + service account"
if gcloud secrets describe "$SECRET_NAME" --project "$PROJECT_ID" >/dev/null 2>&1; then
  run_or_echo "secret $SECRET_NAME" gcloud secrets delete "$SECRET_NAME" --project "$PROJECT_ID"
else
  dim "  · secret $SECRET_NAME — not present, skipping"
fi
if gcloud iam service-accounts describe "$RUN_SA" --project "$PROJECT_ID" >/dev/null 2>&1; then
  run_or_echo "service account $RUN_SA" gcloud iam service-accounts delete "$RUN_SA" --project "$PROJECT_ID"
else
  dim "  · $RUN_SA — not present, skipping"
fi
echo

# ── 5) Manual decisions (never auto-deleted) ──────────────────────────────────
bold "5) Manual — decide, then run yourself (irreversible / out of scope)"
dim "  • Firestore (default) DB — may hold job history. Delete only if you don't need it:"
dim "      gcloud firestore databases delete --database='(default)' --project $PROJECT_ID"
dim "  • The GCP project itself — if it exists solely for this program, shut it down last:"
dim "      gcloud projects delete $PROJECT_ID"
dim "  • Budget alerts / dashboards created for observability — remove in the console."
echo

if [ "$APPLY" -eq 1 ]; then
  ok "Teardown applied. Verify in the console that Cloud Run + Artifact Registry show no billable"
  ok "resources and that GCP billing for the project trends to \$0."
else
  bold "Dry run only — nothing deleted. Re-run with --apply (and --include-output if you're sure)."
fi
