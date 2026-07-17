#!/bin/sh
# Wire the GCS-FUSE weights mount into the Make-It-Animatable checkout, then
# serve. The mount (see cloudbuild.yaml) exposes the bucket at /weights; MIA
# resolves its checkpoints and Mixamo templates relative to its own tree.
set -eu

WEIGHTS_ROOT="${WEIGHTS_ROOT:-/weights/make-it-animatable}"
MIA_DIR="${MIA_DIR:-/app/mia}"

for rel in output/best/new data/Mixamo; do
  src="$WEIGHTS_ROOT/$rel"
  dst="$MIA_DIR/$rel"
  if [ ! -e "$src" ]; then
    echo "fatal: expected staged assets at $src (run workers/rig/stage-assets.sh)" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dst")"
  rm -rf "$dst"
  ln -s "$src" "$dst"
done

if [ ! -f "${ARKIT_TEMPLATE:-/app/assets/arkit_template.npz}" ]; then
  # The template also lives in the weights bucket; link it into place.
  mkdir -p /app/assets
  ln -sf "$WEIGHTS_ROOT/arkit_template.npz" /app/assets/arkit_template.npz
fi

exec uvicorn main:app --host 0.0.0.0 --port 8080 --workers 1 --timeout-keep-alive 300
