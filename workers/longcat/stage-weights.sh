#!/usr/bin/env bash
#
# Stage LongCat-Video-Avatar-1.5 weights into the shared model-weights bucket.
#
#   workers/longcat/stage-weights.sh --dry-run     # list what would be fetched
#   workers/longcat/stage-weights.sh               # download, then upload to GCS
#   workers/longcat/stage-weights.sh --local-only  # download, skip the upload
#
# Two HuggingFace repos are required, side by side, because upstream's
# run_demo_avatar_single_audio_to_video.py loads the tokenizer, text encoder and
# VAE from "<checkpoint_dir>/../LongCat-Video":
#
#   <dest>/LongCat-Video/            tokenizer, text_encoder, vae
#   <dest>/LongCat-Video-Avatar-1.5/ base_model_int8, lora, scheduler,
#                                    whisper-large-v3, vocal_separator
#
# Only the files this worker's flags dereference are fetched
# (--use_int8 --use_distill --model_type avatar-v1.5). Pulling both repos whole
# would be 158 GB; this subset is about 45 GB. model_weights.py holds the
# authoritative required-file list and the service checks it on every /generate.
#
# Environment:
#   WEIGHTS_BUCKET   GCS bucket to upload into (default: three-ws-model-weights)
#   WEIGHTS_PREFIX   object prefix inside the bucket  (default: longcat)
#   LOCAL_DIR        local staging directory (default: /tmp/longcat-weights)
#   HF_TOKEN         optional; the repos are public, so normally unset

set -euo pipefail

BASE_REPO="meituan-longcat/LongCat-Video"
AVATAR_REPO="meituan-longcat/LongCat-Video-Avatar-1.5"

WEIGHTS_BUCKET="${WEIGHTS_BUCKET:-three-ws-model-weights}"
WEIGHTS_PREFIX="${WEIGHTS_PREFIX:-longcat}"
LOCAL_DIR="${LOCAL_DIR:-/tmp/longcat-weights}"

# Base repo: everything except the 54 GB text-to-video DiT and its LoRAs, which
# the avatar pipeline never loads.
BASE_INCLUDE=(
  "tokenizer/*"
  "text_encoder/*"
  "vae/*"
  "config.json"
  "model_index.json"
)

# Avatar repo: the INT8 DiT, the distillation LoRA, the Whisper audio encoder
# (safetensors only) and the ONNX vocal separator. Excluded on purpose:
# base_model/* (31.7 GB bf16 DiT, superseded by base_model_int8), whisper's
# flax/bin/fp32 duplicates (19.5 GB of the same weights), and assets/*.
AVATAR_INCLUDE=(
  "config.json"
  "model_index.json"
  "scheduler/*"
  "base_model_int8/*"
  "lora/dmd_lora.safetensors"
  "vocal_separator/*"
  "whisper-large-v3/config.json"
  "whisper-large-v3/generation_config.json"
  "whisper-large-v3/preprocessor_config.json"
  "whisper-large-v3/tokenizer.json"
  "whisper-large-v3/tokenizer_config.json"
  "whisper-large-v3/special_tokens_map.json"
  "whisper-large-v3/added_tokens.json"
  "whisper-large-v3/normalizer.json"
  "whisper-large-v3/merges.txt"
  "whisper-large-v3/vocab.json"
  "whisper-large-v3/model.safetensors"
)

DRY_RUN=0
LOCAL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=1 ;;
    --local-only) LOCAL_ONLY=1 ;;
    -h|--help)    sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

python3 - "$BASE_REPO" "${#BASE_INCLUDE[@]}" "${BASE_INCLUDE[@]}" \
           "$AVATAR_REPO" "${#AVATAR_INCLUDE[@]}" "${AVATAR_INCLUDE[@]}" <<'PY'
"""Resolve the include patterns against the live HF file listing and report."""
import fnmatch
import json
import sys
import urllib.request

argv = sys.argv[1:]
groups = []
while argv:
    repo = argv.pop(0)
    count = int(argv.pop(0))
    patterns, argv = argv[:count], argv[count:]
    groups.append((repo, patterns))

grand_total = 0
for repo, patterns in groups:
    url = f"https://huggingface.co/api/models/{repo}?blobs=true"
    with urllib.request.urlopen(url, timeout=60) as response:
        data = json.load(response)
    matched, total = [], 0
    for sibling in data.get("siblings", []):
        name = sibling["rfilename"]
        if any(fnmatch.fnmatch(name, pattern) for pattern in patterns):
            size = sibling.get("size") or 0
            matched.append((size, name))
            total += size
    if not matched:
        print(f"ERROR  {repo}: include patterns matched nothing", file=sys.stderr)
        sys.exit(1)
    grand_total += total
    print(f"{repo}: {len(matched)} file(s), {total / 1e9:.2f} GB")
    for size, name in sorted(matched, reverse=True)[:6]:
        print(f"    {size / 1e9:8.2f} GB  {name}")
    if len(matched) > 6:
        print(f"    ... {len(matched) - 6} smaller file(s)")
print(f"TOTAL: {grand_total / 1e9:.2f} GB")
PY

if [[ "$DRY_RUN" == "1" ]]; then
  echo "dry run: nothing downloaded."
  exit 0
fi

if ! command -v huggingface-cli >/dev/null 2>&1; then
  echo "huggingface-cli not found. Install it with: pip install 'huggingface_hub>=0.30'" >&2
  exit 1
fi

download() {
  local repo="$1" dest="$2"
  shift 2
  local include_args=()
  for pattern in "$@"; do include_args+=(--include "$pattern"); done
  echo "==> downloading $repo into $dest"
  huggingface-cli download "$repo" \
    --local-dir "$dest" \
    "${include_args[@]}"
}

download "$BASE_REPO"   "$LOCAL_DIR/LongCat-Video"            "${BASE_INCLUDE[@]}"
download "$AVATAR_REPO" "$LOCAL_DIR/LongCat-Video-Avatar-1.5" "${AVATAR_INCLUDE[@]}"

echo "==> verifying the layout the service requires"
WEIGHTS_DIR="$LOCAL_DIR" python3 -c "
import os, sys
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.abspath('${BASH_SOURCE[0]}')) or '.')
import model_weights
root = Path(os.environ['WEIGHTS_DIR'])
missing = model_weights.missing_paths(root)
if missing:
    print('INCOMPLETE:', model_weights.describe_missing(missing))
    sys.exit(1)
print('layout complete under', root)
"

if [[ "$LOCAL_ONLY" == "1" ]]; then
  echo "local-only: staged at $LOCAL_DIR, skipping upload."
  exit 0
fi

echo "==> uploading to gs://${WEIGHTS_BUCKET}/${WEIGHTS_PREFIX}/"
gcloud storage rsync --recursive \
  "$LOCAL_DIR" "gs://${WEIGHTS_BUCKET}/${WEIGHTS_PREFIX}"

echo "done. Mount gs://${WEIGHTS_BUCKET} and set WEIGHTS_DIR=/weights/${WEIGHTS_PREFIX}"
