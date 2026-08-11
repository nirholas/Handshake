#!/usr/bin/env python3
"""
Stage this worker's checkpoints into the GCS weights prefix the Cloud Run
service loads from (WEIGHTS_GCS_URI in cloudbuild.yaml).

Run once before the first deploy, and again whenever SDXL_MODEL,
CONTROLNET_MODEL, SDXL_INPAINT_MODEL or WEIGHT_VARIANT changes:

    python3 stage_weights.py --prefix sdxl-texture

Why this exists rather than a line in workers/deploy/stage-weights.sh: that
script downloads a repo flat with `hf download --local-dir`, which is the right
shape for a worker that passes the directory as a model path. This worker passes
the staged directory to diffusers as `cache_dir`, so the tree has to be a
HuggingFace cache tree (models--org--name/snapshots/<sha>/..., plus refs/) or
every from_pretrained call treats the cache as empty and re-downloads from
HuggingFace inside the request path.

Only the files the runtime actually resolves are staged: the fp16 variant plus
the configs and tokenizer files. The full-precision set is 44 GiB across the
three SDXL repos against 15 GiB here, and the service never asks for it.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import time

# Real files instead of blobs/ plus symlinks into it. Halves the scratch disk and
# means an object listing of the bucket prefix is the tree itself, not a pile of
# links that would upload as their own path names.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

from google.cloud import storage  # noqa: E402
from huggingface_hub import snapshot_download  # noqa: E402

DEFAULT_BUCKET = "three-ws-model-weights"
DEFAULT_PREFIX = "sdxl-texture"

# Config and tokenizer files, plus the half-precision weights. Everything a
# diffusers pipeline resolves and nothing it does not.
PIPELINE_PATTERNS = ["*.json", "*.txt", "*.fp16.safetensors"]

REPOS = [
    ("stabilityai/stable-diffusion-xl-base-1.0", PIPELINE_PATTERNS),
    ("diffusers/controlnet-depth-sdxl-1.0", PIPELINE_PATTERNS),
    ("diffusers/stable-diffusion-xl-1.0-inpainting-0.1", PIPELINE_PATTERNS),
    # Published fp16-native as one set of files, so it has no .fp16 variant.
    ("madebyollin/sdxl-vae-fp16-fix", ["config.json", "diffusion_pytorch_model.safetensors"]),
]


def log(message: str) -> None:
    print(f"[stage-weights] {message}", flush=True)


def download(cache_dir: str, token: str | None) -> None:
    for repo, patterns in REPOS:
        log(f"downloading {repo}")
        t0 = time.time()
        snapshot_download(
            repo_id=repo,
            cache_dir=cache_dir,
            allow_patterns=patterns,
            token=token,
            max_workers=8,
        )
        log(f"downloaded {repo} in {time.time() - t0:.0f}s")


def _stageable_files(cache_dir: str) -> list[tuple[str, str]]:
    """(local path, path relative to the cache root) for everything to upload.

    `blobs/` is skipped: with symlinks disabled the snapshot holds the real
    bytes, so uploading blobs as well would double the transfer and the storage
    bill for files nothing reads. `refs/` is NOT skipped, because that is what
    maps the revision name a from_pretrained call asks for onto the snapshot
    directory that answers it.
    """
    out = []
    for root, dirs, files in os.walk(cache_dir):
        dirs[:] = [d for d in dirs if d != "blobs"]
        for name in files:
            if name.endswith((".lock", ".incomplete", ".metadata")):
                continue
            path = os.path.join(root, name)
            out.append((path, os.path.relpath(path, cache_dir)))
    return out


def upload(cache_dir: str, bucket_name: str, prefix: str, client=None) -> None:
    client = client or storage.Client()
    bucket = client.bucket(bucket_name)
    files = _stageable_files(cache_dir)
    total = sum(os.path.getsize(p) for p, _ in files)
    log(f"uploading {len(files)} objects ({total / 2 ** 30:.2f} GiB) to gs://{bucket_name}/{prefix}")

    done_bytes = 0
    t0 = time.time()
    for path, rel in sorted(files, key=lambda pair: pair[1]):
        blob = bucket.blob(f"{prefix.rstrip('/')}/{rel}")
        size = os.path.getsize(path)
        # Re-running after a partial upload should cost a HEAD, not a resend.
        if blob.exists():
            blob.reload()
            if blob.size == size:
                done_bytes += size
                continue
        blob.upload_from_filename(path, timeout=3600)
        done_bytes += size
        log(f"  {rel} ({size / 2 ** 20:.1f} MiB) [{done_bytes / total:.0%}]")
    log(f"uploaded in {time.time() - t0:.0f}s")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", default=DEFAULT_BUCKET)
    parser.add_argument("--prefix", default=DEFAULT_PREFIX)
    parser.add_argument("--scratch", default="/tmp/sdxl-texture-stage")
    parser.add_argument("--keep-scratch", action="store_true",
                        help="leave the downloaded cache tree on disk after uploading")
    parser.add_argument("--download-only", action="store_true",
                        help="build the cache tree locally and skip the upload")
    args = parser.parse_args()

    os.makedirs(args.scratch, exist_ok=True)
    download(args.scratch, os.environ.get("HF_TOKEN"))
    if args.download_only:
        log(f"cache tree ready at {args.scratch} (upload skipped)")
        return 0

    upload(args.scratch, args.bucket, args.prefix)
    if not args.keep_scratch:
        shutil.rmtree(args.scratch, ignore_errors=True)
        log(f"removed scratch {args.scratch}")
    log(f"done: gs://{args.bucket}/{args.prefix}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
