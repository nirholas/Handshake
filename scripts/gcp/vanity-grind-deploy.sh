#!/usr/bin/env bash
#
# vanity-grind-deploy.sh — build the batch vanity grinder image and run it on
# cheap GCP SPOT CPU to grind premium inventory.
#
# Two runners:
#   (default) Cloud Run Job  — simplest; one spot-billed job, scale --tasks for
#                              parallel shards, --cpu for cores per task.
#   --mig                    — GCE spot managed instance group; max cores/$ for
#                              very large runs. Each VM takes a SHARD_INDEX.
#
# Durable output: pass WRITE_DB=1 (+ DATABASE_URL secret) to write sealed keys
# straight into vanity_inventory. Otherwise the job writes an encrypted JSONL to
# /tmp (ephemeral) — fine for a smoke run, not for real inventory.
#
# Idempotent. Prereqs: prompt 01 (project + billing), and for real inventory,
# scripts/gcp/vanity-kms-setup.sh (KMS) — set VANITY_KMS_KEY below.
#
# Usage:
#   PROJECT_ID=my-proj ./scripts/gcp/vanity-grind-deploy.sh
#   PROJECT_ID=my-proj TASKS=8 CPU=8 ./scripts/gcp/vanity-grind-deploy.sh --run
#   PROJECT_ID=my-proj ./scripts/gcp/vanity-grind-deploy.sh --mig --instances 20
#
# Env:
#   PROJECT_ID   required
#   REGION       default us-central1
#   REPO         default containers          (Artifact Registry repo)
#   IMAGE        default vanity-grinder
#   JOB          default vanity-grinder
#   TASKS        default 4                    (Cloud Run Job parallel shards)
#   CPU          default 4                    (vCPU per task; MEM scales with it)
#   INSTANCES    default 10                   (--mig VM count)
#   MACHINE      default c2d-highcpu-8        (--mig machine type)
#   Secrets expected in Secret Manager: WALLET_ENCRYPTION_KEY, JWT_SECRET, and
#   (if WRITE_DB=1) DATABASE_URL. VANITY_KMS_KEY passed as a plain env.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID to your GCP project}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-containers}"
IMAGE="${IMAGE:-vanity-grinder}"
JOB="${JOB:-vanity-grinder}"
TASKS="${TASKS:-4}"
CPU="${CPU:-4}"
INSTANCES="${INSTANCES:-10}"
MACHINE="${MACHINE:-c2d-highcpu-8}"
GRINDER_SA="${GRINDER_SA:-vanity-grinder@${PROJECT_ID}.iam.gserviceaccount.com}"
# This project has no legacy Cloud Build SA (new GCP projects don't auto-create
# <projectNumber>@cloudbuild.gserviceaccount.com), so `gcloud builds submit` must
# name a build identity or it fails with "Unknown service account". Reuse the
# dedicated build SA the other images use (deploy/world/apply-hardening.sh).
BUILD_SA="${BUILD_SERVICE_ACCOUNT:-three-ws-build@${PROJECT_ID}.iam.gserviceaccount.com}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

MODE="run-job"
DO_RUN=0
INSTANCE_COUNT="$INSTANCES"
for arg in "$@"; do
	case "$arg" in
		--mig) MODE="mig" ;;
		--run) DO_RUN=1 ;;
		--instances) shift; INSTANCE_COUNT="${1:-$INSTANCES}" ;;
	esac
done

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:latest"

echo "▸ Enabling APIs (run, compute, artifactregistry, cloudbuild)…"
gcloud services enable run.googleapis.com compute.googleapis.com \
	artifactregistry.googleapis.com cloudbuild.googleapis.com --project "$PROJECT_ID"

echo "▸ Artifact Registry repo $REPO…"
gcloud artifacts repositories create "$REPO" --repository-format docker \
	--location "$REGION" --project "$PROJECT_ID" 2>/dev/null || echo "  (repo exists)"

echo "▸ Grinder service account $GRINDER_SA…"
gcloud iam service-accounts create vanity-grinder --display-name "Vanity batch grinder" \
	--project "$PROJECT_ID" 2>/dev/null || echo "  (SA exists)"

echo "▸ Building + pushing image (build context = repo root)…"
# The image uses a non-default Dockerfile path (workers/vanity-grinder/Dockerfile)
# with the repo root as context, so we drive the build via a cloudbuild config
# (--config) — NOT --tag, which assumes ./Dockerfile and is mutually exclusive with
# --config. The repo's .gcloudignore allowlist already keeps the multi-GB asset dirs
# (animation-sources/dist/public/…) and node_modules out of the upload.
BUILD_CFG="$(mktemp --suffix=.cloudbuild.yaml)"
trap 'rm -f "$BUILD_CFG"' EXIT
cat > "$BUILD_CFG" <<YAML
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build','-f','workers/vanity-grinder/Dockerfile','-t','${IMAGE_URI}','.']
images: ['${IMAGE_URI}']
options:
  # A user-specified build SA cannot write to the default (legacy) GCS logs bucket.
  logging: CLOUD_LOGGING_ONLY
YAML
gcloud builds submit --project "$PROJECT_ID" --region "$REGION" \
	--service-account "projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" \
	--config "$BUILD_CFG" .

# Common env for the grinder. WRITE_DB/VANITY_KMS_KEY flow through from the shell.
# TASK_TIMEOUT is the platform's hard kill. MAX_RUNTIME_SEC is the grinder's own,
# deliberately shorter, budget: it winds the run down, writes its summary and exits
# 0 before the kill lands. Without it a shard that needs longer than the timeout is
# reported as a FAILED execution even though every sealed key reached the DB
# (execution vanity-grinder-jx97w, 2026-07-07: 2/4 tasks "The configured timeout
# was reached"), and Cloud Run then burns the retry budget re-running it.
TASK_TIMEOUT="${TASK_TIMEOUT:-3600}"
MAX_RUNTIME_SEC="${MAX_RUNTIME_SEC:-$(( TASK_TIMEOUT - 300 ))}"
JOB_ENV="RUNNER=cloud-run-job,INCLUDE_5=${INCLUDE_5:-0},IGNORE_CASE=${IGNORE_CASE:-0},WRITE_DB=${WRITE_DB:-1},MAX_RUNTIME_SEC=${MAX_RUNTIME_SEC},VANITY_KMS_KEY=${VANITY_KMS_KEY:-}"
JOB_SECRETS="WALLET_ENCRYPTION_KEY=WALLET_ENCRYPTION_KEY:latest,JWT_SECRET=JWT_SECRET:latest,DATABASE_URL=DATABASE_URL:latest"

if [[ "$MODE" == "run-job" ]]; then
	echo "▸ Creating/updating Cloud Run Job $JOB (spot, ${TASKS} tasks × ${CPU} vCPU)…"
	MEM="$(( CPU * 512 ))Mi"
	gcloud run jobs deploy "$JOB" \
		--image "$IMAGE_URI" --region "$REGION" --project "$PROJECT_ID" \
		--service-account "$GRINDER_SA" \
		--cpu "$CPU" --memory "$MEM" \
		--tasks "$TASKS" --parallelism "$TASKS" \
		--max-retries 3 --task-timeout "$TASK_TIMEOUT" \
		--set-env-vars "$JOB_ENV,SHARD_COUNT=${TASKS}" \
		--update-secrets "$JOB_SECRETS" \
		--execution-environment gen2 \
		--labels "workload=vanity-grinder,billing=spot"
	# Cloud Run Jobs are spot-eligible via the tasks' preemptible scheduling; each
	# task derives SHARD_INDEX from CLOUD_RUN_TASK_INDEX at runtime (see note below).
	echo "  ✅ Job deployed: $JOB"
	if [[ "$DO_RUN" == "1" ]]; then
		echo "▸ Executing job…"
		gcloud run jobs execute "$JOB" --region "$REGION" --project "$PROJECT_ID" --wait
	else
		echo "  Run it:  gcloud run jobs execute $JOB --region $REGION"
	fi
else
	# The grinder resolves its SHARD_INDEX by listing its own instance group
	# (workers/vanity-grinder/gce-shard.mjs), because a MIG gives its VMs identical
	# container-env and randomly-suffixed names. Without this role every VM falls
	# back to a name hash; without the role AND the resolver they all ground shard 0.
	echo "▸ Granting the grinder SA compute.viewer (MIG shard-index resolution)…"
	gcloud projects add-iam-policy-binding "$PROJECT_ID" \
		--member "serviceAccount:${GRINDER_SA}" --role roles/compute.viewer \
		--condition None >/dev/null

	echo "▸ Creating spot MIG template + group (${INSTANCE_COUNT} × ${MACHINE})…"
	TEMPLATE="${JOB}-tmpl"
	gcloud compute instance-templates create-with-container "$TEMPLATE" \
		--project "$PROJECT_ID" --machine-type "$MACHINE" \
		--provisioning-model SPOT --instance-termination-action DELETE \
		--container-image "$IMAGE_URI" \
		--container-env "RUNNER=gce-spot-mig,SHARD_COUNT=${INSTANCE_COUNT},WRITE_DB=${WRITE_DB:-1},VANITY_KMS_KEY=${VANITY_KMS_KEY:-}" \
		--service-account "$GRINDER_SA" \
		--scopes cloud-platform 2>/dev/null || echo "  (template exists)"
	gcloud compute instance-groups managed create "$JOB" \
		--project "$PROJECT_ID" --zone "${REGION}-a" \
		--template "$TEMPLATE" --size "$INSTANCE_COUNT" 2>/dev/null || echo "  (MIG exists)"
	echo "  ✅ Spot MIG up. Each VM resolves its own SHARD_INDEX from the group listing."
	echo "  Tear down when done:  gcloud compute instance-groups managed delete $JOB --zone ${REGION}-a"
fi

cat <<EOF

Notes:
  • Cloud Run Jobs: each task auto-shards — the grinder reads CLOUD_RUN_TASK_INDEX
    as its SHARD_INDEX, so TASKS parallel tasks split the target list evenly.
  • Cost: c2d spot ≈ \$0.01–0.02 / vCPU-hour. At ~25k keys/sec/vCPU a 4‑char
    address (~11.3M expected) is ~450 vCPU-seconds ≈ \$0.002. Even 5‑char (~656M)
    is a few cents. See docs/ops/gcp-credits.md for the measured \$/address table.
  • Each task stops itself after MAX_RUNTIME_SEC (${MAX_RUNTIME_SEC}s) and exits 0.
    Re-run the job to continue: with WRITE_DB=1 it resumes from vanity_inventory
    and skips every pattern already in stock.
  • Always run scripts/gcp/vanity-kms-setup.sh first for production inventory so
    keys are sealed under KMS, not just secret-box.
EOF
