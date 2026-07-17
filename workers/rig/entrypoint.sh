#!/bin/sh
# Wire staged assets into the Make-It-Animatable checkout, then serve.
#
# The weights bucket is FUSE-mounted at /weights (see cloudbuild.yaml), but the
# checkpoints are COPIED to local disk rather than symlinked: torch.load over
# gcsfuse does slow random reads and blew past the startup probe (the same
# lesson the hunyuan3d worker learned). A sequential cp of ~2.4 GB takes
# seconds; loading from local disk is then fast and deterministic.
set -eu

WEIGHTS_ROOT="${WEIGHTS_ROOT:-/weights/make-it-animatable}"
MIA_DIR="${MIA_DIR:-/app/mia}"

# data/ carries the Mixamo bone templates plus the demo files (Standard
# Run.fbx, examples/) that MIA's init_blocks() resolves at import; missing
# demo files abort startup, so the whole staged data tree comes along.
for rel in output/best/new data; do
  src="$WEIGHTS_ROOT/$rel"
  dst="$MIA_DIR/$rel"
  if [ ! -e "$src" ]; then
    echo "fatal: expected staged assets at $src (run workers/rig/stage-assets.sh)" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dst")"
  rm -rf "$dst"
  echo "staging $src -> $dst"
  cp -r "$src" "$dst"
done

if [ ! -f "${ARKIT_TEMPLATE:-/app/assets/arkit_template.npz}" ]; then
  mkdir -p /app/assets
  cp "$WEIGHTS_ROOT/arkit_template.npz" /app/assets/arkit_template.npz
fi

exec uvicorn main:app --host 0.0.0.0 --port 8080 --workers 1 --timeout-keep-alive 300
