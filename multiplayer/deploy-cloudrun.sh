#!/usr/bin/env bash
#
# Deploy the three.ws multiplayer (Colyseus) server to Google Cloud Run.
#
# Cloud Run builds the local Dockerfile via Cloud Build (no local docker push),
# terminates TLS, and hands back a stable https URL. The client connects to the
# wss:// form of that URL — wire it into pages/play.html's <meta name="game-server">.
#
# Prereqs (one time):
#   gcloud auth login
#   gcloud config set project YOUR_PROJECT_ID
#   gcloud services enable run.googleapis.com cloudbuild.googleapis.com
#
# Then from this directory:
#   ./deploy-cloudrun.sh
#
# Override any of these via env, e.g.  REGION=europe-west1 ./deploy-cloudrun.sh
set -euo pipefail

SERVICE="${SERVICE:-three-ws-multiplayer}"
REGION="${REGION:-us-central1}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://three.ws,https://www.three.ws}"
PROJECT="$(gcloud config get-value project 2>/dev/null)"

# ── Capacity tunables ──────────────────────────────────────────────────────
# CONCURRENCY is the # of simultaneous connections Cloud Run routes to ONE
# instance. The platform default is 80 — for a WebSocket server that is a hard
# ~80-player ceiling, so we raise it well above the per-instance comfort limit.
CONCURRENCY="${CONCURRENCY:-1000}"
CPU="${CPU:-2}"
MEMORY="${MEMORY:-2Gi}"
MIN_INSTANCES="${MIN_INSTANCES:-1}"

# Horizontal scaling: a Colyseus fleet only works when the room registry +
# presence are shared via Redis (REDIS_URI, e.g. a Memorystore instance). Until
# that is set we MUST stay single-instance, or players for the same coin land on
# different instances and can't see each other. Set REDIS_URI to scale out.
REDIS_URI="${REDIS_URI:-}"
if [[ -n "${REDIS_URI}" ]]; then
	MAX_INSTANCES="${MAX_INSTANCES:-10}"
else
	MAX_INSTANCES="${MAX_INSTANCES:-1}"
fi

if [[ -z "${PROJECT}" || "${PROJECT}" == "(unset)" ]]; then
	echo "No GCP project set. Run: gcloud config set project YOUR_PROJECT_ID" >&2
	exit 1
fi

# Durable build storage (Upstash Redis REST). This is SEPARATE from REDIS_URI
# above: REDIS_URI is Colyseus's room-registry/presence Redis for horizontal
# scaling; these two power block-store.js so each coin world's voxel build
# survives a redeploy/restart. They must be set on THIS Cloud Run service — the
# same vars on Vercel only reach the Vercel API functions, never this process.
# Pass them through when present in the deploy shell (export them, or source an
# env file, before running this script). For the token, Secret Manager via
# --set-secrets is preferable to plaintext env in a hardened setup.
UPSTASH_REDIS_REST_URL="${UPSTASH_REDIS_REST_URL:-}"
UPSTASH_REDIS_REST_TOKEN="${UPSTASH_REDIS_REST_TOKEN:-}"

# Assemble env vars (@-delimited so values containing commas are safe). Redis +
# monitor creds are only passed when provided.
ENV_VARS="NODE_ENV=production@ALLOWED_ORIGINS=${ALLOWED_ORIGINS}"
[[ -n "${REDIS_URI}" ]] && ENV_VARS="${ENV_VARS}@REDIS_URI=${REDIS_URI}"
[[ -n "${UPSTASH_REDIS_REST_URL}" ]] && ENV_VARS="${ENV_VARS}@UPSTASH_REDIS_REST_URL=${UPSTASH_REDIS_REST_URL}"
[[ -n "${UPSTASH_REDIS_REST_TOKEN}" ]] && ENV_VARS="${ENV_VARS}@UPSTASH_REDIS_REST_TOKEN=${UPSTASH_REDIS_REST_TOKEN}"
[[ -n "${MONITOR_USER:-}" ]] && ENV_VARS="${ENV_VARS}@MONITOR_USER=${MONITOR_USER}"
[[ -n "${MONITOR_PASS:-}" ]] && ENV_VARS="${ENV_VARS}@MONITOR_PASS=${MONITOR_PASS}"

# Warn loudly if durable build storage isn't configured — without it, every coin
# world's build is memory-only and a redeploy wipes it.
if [[ -z "${UPSTASH_REDIS_REST_URL}" || -z "${UPSTASH_REDIS_REST_TOKEN}" ]]; then
	echo "  ⚠ UPSTASH_REDIS_REST_URL/_TOKEN not set — builds will be MEMORY-ONLY (lost on redeploy)." >&2
fi

echo "Deploying '${SERVICE}' to Cloud Run (project=${PROJECT}, region=${REGION})..."
echo "  cpu=${CPU} memory=${MEMORY} concurrency=${CONCURRENCY} instances=${MIN_INSTANCES}..${MAX_INSTANCES} redis=$([[ -n "${REDIS_URI}" ]] && echo on || echo off) builds=$([[ -n "${UPSTASH_REDIS_REST_URL}" && -n "${UPSTASH_REDIS_REST_TOKEN}" ]] && echo durable || echo memory-only)"

# Flags that matter for a long-lived Colyseus game server on Cloud Run:
#   --no-cpu-throttling : keep CPU allocated between requests so the room
#                         simulation/patch loop never stalls (the #1 gotcha).
#   --concurrency       : connections routed per instance. The default 80 is a
#                         hard WS-connection ceiling — raised here.
#   --min-instances     : rooms live in-memory; keep ≥1 warm so they never
#                         cold-start away.
#   --max-instances     : >1 ONLY with REDIS_URI (shared room registry/presence);
#                         otherwise players for the same coin split across boxes.
#   --session-affinity  : sticky sessions so a client's HTTP matchmake + WS land
#                         on the same instance.
#   --timeout 3600      : Cloud Run's max WS lifetime (60 min); client reconnects.
#   --port 2567         : container listens here (matches Dockerfile/fly.toml).
# A fresh project's default compute service account can take minutes to appear
# (and some org policies block its auto-creation), so builds use a dedicated SA.
BUILD_SA="${BUILD_SA:-projects/${PROJECT}/serviceAccounts/three-ws-build@${PROJECT}.iam.gserviceaccount.com}"

gcloud run deploy "${SERVICE}" \
	--source . \
	--quiet \
	--build-service-account "${BUILD_SA}" \
	--service-account "three-ws-build@${PROJECT}.iam.gserviceaccount.com" \
	--region "${REGION}" \
	--platform managed \
	--allow-unauthenticated \
	--port 2567 \
	--no-cpu-throttling \
	--concurrency "${CONCURRENCY}" \
	--min-instances "${MIN_INSTANCES}" \
	--max-instances "${MAX_INSTANCES}" \
	--memory "${MEMORY}" \
	--cpu "${CPU}" \
	--timeout 3600 \
	--session-affinity \
	--set-env-vars "^@^${ENV_VARS}"

URL="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --format 'value(status.url)')"
WSS="${URL/https:/wss:}"

echo
echo "Deployed: ${URL}"
echo "Health:   ${URL}/health"
echo
echo "Wire the client by setting this in pages/play.html:"
echo "  <meta name=\"game-server\" content=\"${WSS}\">"
