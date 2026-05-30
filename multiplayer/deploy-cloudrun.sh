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

if [[ -z "${PROJECT}" || "${PROJECT}" == "(unset)" ]]; then
	echo "No GCP project set. Run: gcloud config set project YOUR_PROJECT_ID" >&2
	exit 1
fi

echo "Deploying '${SERVICE}' to Cloud Run (project=${PROJECT}, region=${REGION})..."

# Flags that matter for a long-lived Colyseus game server on Cloud Run:
#   --no-cpu-throttling : keep CPU allocated between requests so the room
#                         simulation/patch loop never stalls (the #1 gotcha).
#   --min-instances 1   : rooms live in-memory; never cold-start them away.
#   --max-instances 1   : matchmaking is per-process. Stay single-instance until
#                         @colyseus/redis-presence is wired (see README scaling).
#   --session-affinity  : best-effort sticky sessions for WS reconnects.
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
	--min-instances 1 \
	--max-instances 1 \
	--memory 512Mi \
	--cpu 1 \
	--timeout 3600 \
	--session-affinity \
	--set-env-vars "^@^NODE_ENV=production@ALLOWED_ORIGINS=${ALLOWED_ORIGINS}"

URL="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --format 'value(status.url)')"
WSS="${URL/https:/wss:}"

echo
echo "Deployed: ${URL}"
echo "Health:   ${URL}/health"
echo
echo "Wire the client by setting this in pages/play.html:"
echo "  <meta name=\"game-server\" content=\"${WSS}\">"
