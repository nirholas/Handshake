#!/usr/bin/env bash
# One-shot production ship: clean worktree build of main HEAD -> Cloud Build -> deploy -> CDN purge.
# Preconditions: gcloud auth is live (run `gcloud auth login` first if the session expired),
# and main is test-green (`npm test`). Env vars on the service persist across this image-only deploy.
set -euo pipefail
ROOT=/workspaces/three.ws
WT=/workspaces/.deploy-wt
PROJECT=aerial-vehicle-466722-p5
REGION=us-central1

cd "$ROOT"
echo "== gcloud auth preflight =="
gcloud run services describe three-ws-api --region "$REGION" --project "$PROJECT" \
  --format='value(status.latestReadyRevisionName)' >/dev/null

echo "== fresh clean worktree at $(git rev-parse --short HEAD) =="
git worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"
git worktree prune
git worktree add --detach "$WT" HEAD
# integrity guard: fail loudly if the checkout is incomplete (concurrent-agent git race)
for f in scripts/write-build-info.mjs package.json server/cloudbuild.yaml; do
  test -f "$WT/$f" || { echo "FATAL: worktree missing $f (checkout raced); retry"; exit 3; }
done
cp -al "$ROOT/node_modules" "$WT/node_modules"

cd "$WT"
echo "== build:gcp =="
npm run build:gcp
echo "== submit + deploy =="
gcloud builds submit --config server/cloudbuild.yaml --region "$REGION" --project "$PROJECT"
echo "== purge CDN =="
npm run deploy:gcp:purge-cdn
echo "== verify live commit =="
sleep 15
curl -s https://three.ws/api/version | python3 -c "import json,sys; d=json.load(sys.stdin); print('LIVE commit:', d['commitShort'], 'revision:', d['runtime']['revision'])"
