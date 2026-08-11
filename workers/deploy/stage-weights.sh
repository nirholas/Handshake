#!/usr/bin/env bash
#
# stage-weights.sh — download avatar-pipeline model weights from Hugging Face
# and stage them into the GCS weights bucket the Cloud Run services mount at
# /weights. Run this ONCE (and again only when a model is added/updated)
# before deploy-all.sh — the services load weights with from_pretrained() off
# the mounted bucket and will fail their cold-start health check if the weights
# are missing.
#
# Two modes:
#   • gcsfuse (default, REQUIRED in Cloud Shell) — mounts the bucket and downloads
#     HF repos straight into it. No large local disk needed; the full fleet is
#     ~80 GB and Cloud Shell only has ~5 GB, so local staging would fail.
#   • local   (LOCAL_STAGE=1) — download to a local dir then rsync up. Only on a
#     box with ~80 GB free disk (e.g. a GCE VM).
#
# Usage (Cloud Shell, full fleet):
#   HF_TOKEN=hf_xxx SERVICES="hunyuan3d trellis triposr triposg" ./stage-weights.sh
#
# The rig worker is NOT staged here: its assets span an LFS-filtered model repo,
# a gated Mixamo dataset, and a baked ARKit template, which this one-repo-per-
# service map cannot express. Stage it with `bash workers/rig/stage-assets.sh`.
#
# Env:
#   WEIGHTS_BUCKET  GCS bucket name        (default: three-ws-model-weights)
#   SERVICES        space-separated subset (default: "hunyuan3d")
#   HF_TOKEN        Hugging Face token     (required for gated repos e.g. Hunyuan3D)
#   LOCAL_STAGE     "1" to use the local-dir+rsync path instead of gcsfuse
#   MOUNT_DIR       gcsfuse mountpoint     (default: /tmp/three-ws-weights-mnt)
#   STAGE_DIR       local scratch (LOCAL_STAGE only, default: /tmp/three-ws-weights)
#   FORCE           "1" to re-download even if the bucket prefix already exists

set -euo pipefail

WEIGHTS_BUCKET="${WEIGHTS_BUCKET:-three-ws-model-weights}"
SERVICES="${SERVICES:-hunyuan3d}"
LOCAL_STAGE="${LOCAL_STAGE:-0}"
MOUNT_DIR="${MOUNT_DIR:-/tmp/three-ws-weights-mnt}"
STAGE_DIR="${STAGE_DIR:-/tmp/three-ws-weights}"
FORCE="${FORCE:-0}"

# service -> "hf_repo|bucket_subdir" (sources documented in each worker's main.py)
# `triposg` is three repos: the image pipeline, the scribble (sketch→3D)
# pipeline, and RMBG-1.4 for its image-mode background removal — stage_one
# handles the multi-repo case.
weight_source() {
  case "$1" in
    hunyuan3d) echo "tencent/Hunyuan3D-2.1|hunyuan3d-2.1" ;;
    trellis)   echo "microsoft/TRELLIS-image-large|trellis-large" ;;
    triposr)   echo "stabilityai/TripoSR|triposr" ;;
    triposg)   echo "VAST-AI/TripoSG|triposg VAST-AI/TripoSG-scribble|triposg-scribble briaai/RMBG-1.4|rmbg-1.4" ;;
    *)         echo "" ;;
  esac
}

log()  { printf '\033[1;36m[stage-weights]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[stage-weights] ✓\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[stage-weights] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v gcloud  >/dev/null 2>&1 || die "gcloud not found on PATH"
command -v python3 >/dev/null 2>&1 || die "python3 not found on PATH"
gcloud auth print-access-token >/dev/null 2>&1 || die "gcloud not authenticated — run 'gcloud auth login'"

# A recent huggingface_hub downloads directly into --local-dir with no separate
# multi-GB global cache, which is what makes the gcsfuse path disk-free.
if ! python3 -c "import huggingface_hub, sys; v=tuple(map(int,huggingface_hub.__version__.split('.')[:2])); sys.exit(0 if v>=(0,23) else 1)" >/dev/null 2>&1; then
  log "installing/upgrading huggingface_hub…"
  pip install --quiet --upgrade "huggingface_hub[cli]>=0.23"
fi
# Newer huggingface_hub ships the `hf` CLI and the legacy `huggingface-cli`
# is a deprecated no-op, so prefer `hf` and fall back only if it's missing.
if command -v hf >/dev/null 2>&1; then
  HF_CLI="hf"
elif command -v huggingface-cli >/dev/null 2>&1; then
  HF_CLI="huggingface-cli"
else
  HF_CLI="python3 -m huggingface_hub.cli"
fi
[ -n "${HF_TOKEN:-}" ] && export HF_TOKEN

# Ensure the weights bucket exists.
if ! gcloud storage buckets describe "gs://${WEIGHTS_BUCKET}" >/dev/null 2>&1; then
  log "creating weights bucket gs://${WEIGHTS_BUCKET}…"
  gcloud storage buckets create "gs://${WEIGHTS_BUCKET}" --uniform-bucket-level-access >/dev/null
fi

# ── gcsfuse mount lifecycle (default mode) ────────────────────────────────────
GCSFUSE_MOUNTED=0
cleanup() { [ "$GCSFUSE_MOUNTED" = "1" ] && fusermount -u "$MOUNT_DIR" 2>/dev/null || true; }
trap cleanup EXIT

if [ "$LOCAL_STAGE" != "1" ]; then
  command -v gcsfuse >/dev/null 2>&1 || die "gcsfuse not found — install it, or re-run with LOCAL_STAGE=1 on a big-disk host"
  mkdir -p "$MOUNT_DIR"
  log "mounting gs://${WEIGHTS_BUCKET} at ${MOUNT_DIR} via gcsfuse…"
  # implicit-dirs lets HF's nested paths appear; rename-dir-limit keeps temp renames working.
  gcsfuse --implicit-dirs --rename-dir-limit=200000 "$WEIGHTS_BUCKET" "$MOUNT_DIR" \
    || die "gcsfuse mount failed"
  GCSFUSE_MOUNTED=1
  ok "mounted"
fi

stage_one() {
  local svc="$1" src pair
  src="$(weight_source "$svc")"
  [ -n "$src" ] || die "unknown service '$svc' (valid: hunyuan3d trellis triposr triposg; rig stages via workers/rig/stage-assets.sh)"
  # A service may need several HF repos (triposg) — stage each pair.
  for pair in $src; do
    stage_repo "$svc" "$pair"
  done
}

stage_repo() {
  local svc="$1" repo subdir dest target
  repo="${2%%|*}"; subdir="${2##*|}"
  dest="gs://${WEIGHTS_BUCKET}/${subdir}"

  if [ "$FORCE" != "1" ] && gcloud storage ls "${dest}/" >/dev/null 2>&1; then
    ok "${svc}: ${dest} already populated — skipping (FORCE=1 to re-stage)"
    return
  fi

  if [ "$LOCAL_STAGE" = "1" ]; then
    target="${STAGE_DIR}/${subdir}"
    log "${svc}: downloading ${repo} → ${target}"
    $HF_CLI download "$repo" --local-dir "$target" ${HF_TOKEN:+--token "$HF_TOKEN"}
    log "${svc}: uploading → ${dest}"
    gcloud storage rsync --recursive --delete-unmatched-destination-objects "$target" "$dest"
    # Free the local copy immediately so peak disk stays ~one model, not the
    # whole fleet — lets staging run on a bounded-disk host.
    rm -rf "$target"
    log "${svc}: freed local scratch ${target}"
  else
    target="${MOUNT_DIR}/${subdir}"
    log "${svc}: downloading ${repo} straight into bucket (${dest}) — this is the slow step"
    $HF_CLI download "$repo" --local-dir "$target" ${HF_TOKEN:+--token "$HF_TOKEN"}
  fi
  ok "${svc}: staged at ${dest}"
}

for svc in $SERVICES; do stage_one "$svc"; done

log "all requested weights staged into gs://${WEIGHTS_BUCKET}"
log "next:  PROJECT_ID=<your-project> SERVICES=\"${SERVICES}\" ./deploy-all.sh"
