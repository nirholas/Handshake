#!/usr/bin/env bash
# One-shot ship for the sniper experiment stack (worker + site) after a gcloud
# reauth. Safe to re-run; each step is idempotent. Run from the repo root.
set -euo pipefail

PROJECT=aerial-vehicle-466722-p5
REGION=us-central1
WT=/workspaces/.deploy-wt

# 0. sanity: auth is back
gcloud run services list --region "$REGION" --project "$PROJECT" --format="value(metadata.name)" >/dev/null

# 1. clean worktree at current origin/main
git fetch origin main
if [ ! -d "$WT" ]; then git worktree add --detach "$WT" origin/main; fi
git -C "$WT" checkout -q --detach origin/main
[ -d "$WT/node_modules" ] || cp -al "$(pwd)/node_modules" "$WT/node_modules"

# 2. worker image (judgment ledger + any newer worker changes) + roll the service
(cd "$WT" && gcloud builds submit --config workers/agent-sniper/cloudbuild.yaml --region "$REGION" --project "$PROJECT")
gcloud run services update agent-sniper --region "$REGION" --project "$PROJECT" \
	--image "us-central1-docker.pkg.dev/$PROJECT/workers/agent-sniper:latest"

# 3. site (scoreboard judgment section + API aggregate)
(cd "$WT" && npm run build:gcp && gcloud builds submit --config server/cloudbuild.yaml --region "$REGION" --project "$PROJECT" && npm run deploy:gcp:purge-cdn)

# 4. verify
curl -s https://three.ws/api/version | head -c 160; echo
curl -s "https://three.ws/api/sniper/experiments?window=all" | head -c 200; echo
echo "ship complete"
