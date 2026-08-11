"""Weights layout for LongCat-Video-Avatar-1.5 inference.

Upstream's run_demo_avatar_single_audio_to_video.py loads the tokenizer, the
UMT5 text encoder and the VAE from ``os.path.join(checkpoint_dir, '..',
'LongCat-Video')``. That sibling lookup is hardcoded, so the avatar checkpoint
cannot stand alone: two HuggingFace repos must be staged next to each other
under one root.

    <root>/
      LongCat-Video/              meituan-longcat/LongCat-Video
        tokenizer/  text_encoder/  vae/
      LongCat-Video-Avatar-1.5/   meituan-longcat/LongCat-Video-Avatar-1.5
        base_model_int8/  lora/  scheduler/  whisper-large-v3/  vocal_separator/

Only the subset this worker's inference flags actually touch is required:
``--use_int8`` reads base_model_int8 (not the 31.7 GB bf16 base_model),
``--use_distill`` reads lora/dmd_lora.safetensors, and avatar-v1.5 uses
whisper-large-v3 as the audio encoder (not chinese-wav2vec2-base, which is the
avatar-v1.0 encoder). stage-weights.sh stages exactly this set.

This module is stdlib-only and takes an injectable existence predicate so the
Docker build can unit test the layout rules with no weights present.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Iterable

BASE_MODEL_DIRNAME = "LongCat-Video"
AVATAR_MODEL_DIRNAME = "LongCat-Video-Avatar-1.5"

BASE_REPO_ID = "meituan-longcat/LongCat-Video"
AVATAR_REPO_ID = "meituan-longcat/LongCat-Video-Avatar-1.5"

# Paths relative to <root>/LongCat-Video, each one dereferenced by upstream
# before the first denoising step.
BASE_REQUIRED = (
    "tokenizer/tokenizer_config.json",
    "text_encoder/config.json",
    "text_encoder/model.safetensors.index.json",
    "vae/config.json",
    "vae/diffusion_pytorch_model.safetensors",
)

# Paths relative to <root>/LongCat-Video-Avatar-1.5 for the
# --use_int8 --use_distill --model_type avatar-v1.5 configuration.
AVATAR_REQUIRED = (
    "scheduler/scheduler_config.json",
    "base_model_int8/config.json",
    "base_model_int8/quantized_model.safetensors.index.json",
    "lora/dmd_lora.safetensors",
    "whisper-large-v3/config.json",
    "whisper-large-v3/preprocessor_config.json",
    "whisper-large-v3/model.safetensors",
    "vocal_separator/Kim_Vocal_2.onnx",
    # audio-separator reads the MDX model registry next to the .onnx file. Stage
    # it too, or Separator.load_model tries to download it at inference time.
    "vocal_separator/mdx_model_data.json",
)


def base_dir(root: Path) -> Path:
    return Path(root) / BASE_MODEL_DIRNAME


def avatar_dir(root: Path) -> Path:
    """The value passed to upstream's --checkpoint_dir."""
    return Path(root) / AVATAR_MODEL_DIRNAME


def required_paths(root: Path) -> tuple[Path, ...]:
    """Every file that must exist under ``root`` before inference can start."""
    return tuple(
        [base_dir(root) / rel for rel in BASE_REQUIRED]
        + [avatar_dir(root) / rel for rel in AVATAR_REQUIRED]
    )


def missing_paths(
    root: Path,
    exists: Callable[[Path], bool] | None = None,
) -> tuple[Path, ...]:
    """Which required paths are absent. Empty tuple means ready to infer.

    ``exists`` is injectable so the layout rules can be tested without staging
    45 GB of weights; it defaults to a real filesystem check.
    """
    probe = exists if exists is not None else (lambda path: path.exists())
    return tuple(path for path in required_paths(root) if not probe(path))


def describe_missing(missing: Iterable[Path]) -> str:
    """One-line operator-facing summary naming what to stage."""
    items = [str(path) for path in missing]
    if not items:
        return "none"
    head = ", ".join(items[:4])
    if len(items) > 4:
        head += f", and {len(items) - 4} more"
    return head
