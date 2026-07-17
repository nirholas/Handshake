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

echo "==> Mixamo bone templates (HF dataset: jasongzy/Mixamo)"
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 \
  https://huggingface.co/datasets/jasongzy/Mixamo "$WORK/hf-mixamo"
git -C "$WORK/hf-mixamo" lfs pull -I 'bones*.fbx'

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
