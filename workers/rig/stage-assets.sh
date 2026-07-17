#!/usr/bin/env bash
# Stage everything the rig worker needs into the model-weights bucket.
# Run once (from any machine with gcloud + git-lfs + python3) before the first
# deploy, and again only when bumping the MIA commit or template.
#
#   bash workers/rig/stage-assets.sh
#
# Layout produced under gs://three-ws-model-weights/make-it-animatable/:
#   output/best/new/*.pth      Make-It-Animatable checkpoints (HF, MIT)
#   data/Mixamo/bones.fbx      Mixamo skeleton template (HF dataset)
#   data/Mixamo/bones_vroid.fbx
#   arkit_template.npz         baked ICT-FaceKit ARKit-52 template (MIT)
set -euo pipefail

BUCKET="${BUCKET:-gs://three-ws-model-weights/make-it-animatable}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> Make-It-Animatable checkpoints (HF: jasongzy/Make-It-Animatable)"
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 \
  https://huggingface.co/jasongzy/Make-It-Animatable "$WORK/hf-mia"
git -C "$WORK/hf-mia" lfs pull -I output/best/new

echo "==> Mixamo bone templates (HF dataset: jasongzy/Mixamo, gated: auto)"
# The dataset is gated (auto-approve). Needs an HF token; the platform one
# lives on the three-ws-api Cloud Run service. First use of a token must
# accept the gate, which the ask-access POST does for auto-gated repos.
if [ -z "${HF_TOKEN:-}" ]; then
  HF_TOKEN=$(gcloud run services describe three-ws-api --region us-central1 \
    --format=json | python3 -c "
import json, sys
envs = json.load(sys.stdin)['spec']['template']['spec']['containers'][0].get('env', [])
print(next(e['value'] for e in envs if e['name'] == 'HF_TOKEN'))")
fi
curl -sf -X POST -H "Authorization: Bearer $HF_TOKEN" \
  https://huggingface.co/datasets/jasongzy/Mixamo/ask-access >/dev/null || true
mkdir -p "$WORK/hf-mixamo"
for f in bones.fbx bones_vroid.fbx; do
  curl -sfL -H "Authorization: Bearer $HF_TOKEN" \
    "https://huggingface.co/datasets/jasongzy/Mixamo/resolve/main/$f" \
    -o "$WORK/hf-mixamo/$f"
done

echo "==> ICT-FaceKit ARKit template bake"
git clone --depth 1 https://github.com/ICT-VGL/ICT-FaceKit "$WORK/ict"
python3 "$HERE/build_arkit_template.py" \
  --facekit "$WORK/ict" --out "$WORK/arkit_template.npz"

echo "==> Upload to $BUCKET"
gcloud storage cp -r "$WORK/hf-mia/output/best/new" "$BUCKET/output/best/new"
gcloud storage cp "$WORK/hf-mixamo/bones.fbx" "$WORK/hf-mixamo/bones_vroid.fbx" \
  "$BUCKET/data/Mixamo/"
gcloud storage cp "$WORK/arkit_template.npz" "$BUCKET/arkit_template.npz"

echo "==> Staged. Verify:"
gcloud storage ls -r "$BUCKET" | sed 's/^/    /'
