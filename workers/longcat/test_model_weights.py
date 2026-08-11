"""Unit tests for model_weights.py: the two-repo layout upstream demands.

    python3 workers/longcat/test_model_weights.py

Also a Docker build gate. These pin the 2026-08-11 audit finding that the worker
staged only the avatar checkpoint. Upstream loads the tokenizer, the UMT5 text
encoder and the VAE from ``<checkpoint_dir>/../LongCat-Video``, so an
avatar-only staging always died at the first tokenizer load, after the request
had already been accepted with a 202.
"""

from __future__ import annotations

import sys
from pathlib import Path

import model_weights

PASS = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS
    if not condition:
        print(f"FAIL  {name}  {detail}")
        sys.exit(1)
    PASS += 1


ROOT = Path("/weights/longcat")

# ── layout ─────────────────────────────────────────────────────────────────────

check(
    "the checkpoint dir is the avatar-1.5 repo",
    model_weights.avatar_dir(ROOT) == ROOT / "LongCat-Video-Avatar-1.5",
    str(model_weights.avatar_dir(ROOT)),
)
check(
    "the base repo is a sibling of the checkpoint dir",
    model_weights.base_dir(ROOT) == model_weights.avatar_dir(ROOT).parent / "LongCat-Video",
    str(model_weights.base_dir(ROOT)),
)
check(
    "upstream's ../LongCat-Video lookup resolves to the base dir",
    Path(model_weights.avatar_dir(ROOT), "..", "LongCat-Video").resolve()
    == model_weights.base_dir(ROOT).resolve(),
)

required = model_weights.required_paths(ROOT)
check("the required set is non-empty", len(required) > 0)
check("every required path is absolute under the root", all(ROOT in p.parents or p.parent == ROOT or str(p).startswith(str(ROOT)) for p in required))

# The text encoder and VAE come from the base repo, not the avatar repo. Getting
# this backwards is exactly the bug these tests exist to prevent.
required_str = {str(p) for p in required}
for rel in ("text_encoder/config.json", "vae/diffusion_pytorch_model.safetensors", "tokenizer/tokenizer_config.json"):
    check(
        f"{rel} is required from the base repo",
        str(model_weights.base_dir(ROOT) / rel) in required_str,
    )

# The int8 DiT, the distillation LoRA, the Whisper audio encoder and the vocal
# separator all come from the avatar repo, because that is what
# --use_int8 --use_distill --model_type avatar-v1.5 dereferences.
for rel in (
    "base_model_int8/quantized_model.safetensors.index.json",
    "lora/dmd_lora.safetensors",
    "whisper-large-v3/model.safetensors",
    "vocal_separator/Kim_Vocal_2.onnx",
):
    check(
        f"{rel} is required from the avatar repo",
        str(model_weights.avatar_dir(ROOT) / rel) in required_str,
    )

# The 31.7 GB bf16 base_model and the avatar-v1.0 wav2vec2 encoder are NOT used
# by this worker's flags. Requiring them would triple the staging bill.
for unused in ("base_model/", "chinese-wav2vec2-base", "flax_model.msgpack", "pytorch_model.bin"):
    check(
        f"{unused} is not required",
        not any(unused in s for s in required_str),
        f"unexpectedly required: {[s for s in required_str if unused in s]}",
    )

# ── missing-path detection ─────────────────────────────────────────────────────

check(
    "nothing staged means everything is missing",
    len(model_weights.missing_paths(ROOT, exists=lambda p: False)) == len(required),
)
check(
    "everything staged means nothing is missing",
    model_weights.missing_paths(ROOT, exists=lambda p: True) == (),
)

# The historical failure mode: the avatar repo is staged, the base repo is not.
avatar_only = {str(p) for p in required if str(p).startswith(str(model_weights.avatar_dir(ROOT)))}
missing = model_weights.missing_paths(ROOT, exists=lambda p: str(p) in avatar_only)
check("an avatar-only staging is reported incomplete", len(missing) > 0)
check(
    "an avatar-only staging reports exactly the base-repo files",
    all(str(p).startswith(str(model_weights.base_dir(ROOT))) for p in missing),
    str([str(p) for p in missing]),
)

# One absent file is enough to hold the service back: a half-staged checkpoint
# fails deep inside CUDA, minutes after the request was accepted.
one_gone = str(model_weights.avatar_dir(ROOT) / "lora/dmd_lora.safetensors")
missing = model_weights.missing_paths(ROOT, exists=lambda p: str(p) != one_gone)
check("one absent file is detected", [str(p) for p in missing] == [one_gone], str(missing))

# ── operator summary ───────────────────────────────────────────────────────────

check("an empty summary reads as none", model_weights.describe_missing([]) == "none")
check(
    "a short summary lists the paths",
    model_weights.describe_missing([Path("/a"), Path("/b")]) == "/a, /b",
)
summary = model_weights.describe_missing([Path(f"/p{i}") for i in range(9)])
check("a long summary is truncated with a count", "and 5 more" in summary, summary)
check("a long summary still names the first paths", summary.startswith("/p0, /p1, /p2, /p3"), summary)

# ── the real repo ids are the ones stage-weights.sh pulls ──────────────────────

check(
    "base repo id",
    model_weights.BASE_REPO_ID == "meituan-longcat/LongCat-Video",
)
check(
    "avatar repo id",
    model_weights.AVATAR_REPO_ID == "meituan-longcat/LongCat-Video-Avatar-1.5",
)
check(
    "the avatar directory name matches the avatar repo name",
    model_weights.AVATAR_MODEL_DIRNAME == model_weights.AVATAR_REPO_ID.split("/")[1],
)
check(
    "the base directory name matches the base repo name",
    model_weights.BASE_MODEL_DIRNAME == model_weights.BASE_REPO_ID.split("/")[1],
)

print(f"OK  {PASS} weights-layout checks passed")
