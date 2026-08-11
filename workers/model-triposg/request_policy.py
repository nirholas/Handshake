"""Request policy for the TripoSG worker: mode routing, prompt gating, and the
per-mode sampler settings.

This module is deliberately free of torch, CUDA, and the TripoSG source tree, so
every decision that shapes a generation can be imported and unit tested on any
machine with no GPU and no model weights (see test_request_policy.py). main.py
imports every public name here; nothing in this file touches the GPU.

Two modes share the one /infer endpoint and they are NOT interchangeable:

  image     one photo, the full 50-step rectified-flow sampler at guidance 7.0.
  scribble  a drawing plus a text prompt, the CFG-distilled sampler (16 steps,
            guidance 0). Prompt-conditioned, so an empty prompt is a caller
            error (422), not a silent fall back to image mode: without the
            prompt the scribble pipeline has nothing to condition on and
            returns a blob.

The numbers below are upstream's own inference defaults
(scripts/inference_triposg.py and scripts/inference_triposg_scribble.py in
github.com/VAST-AI-Research/TripoSG), not tuned guesses.
"""

from __future__ import annotations

IMAGE_MODE = "image"
SCRIBBLE_MODE = "scribble"
MODES = (IMAGE_MODE, SCRIBBLE_MODE)

IMAGE_STEPS = 50
IMAGE_GUIDANCE = 7.0

# CFG-distilled checkpoint: few steps, and guidance MUST stay 0 (the distilled
# model already bakes in the guided trajectory; a non-zero scale double-applies
# it and the geometry blows out).
SCRIBBLE_STEPS = 16
SCRIBBLE_GUIDANCE = 0.0
DEFAULT_SCRIBBLE_CONFIDENCE = 0.4
# Octree depths for the scribble decoder. Flash decoding is off because the
# distilled checkpoint's latents decode wrong through it upstream.
SCRIBBLE_OCTREE_DEPTH = 8


class PromptRequired(ValueError):
    """Scribble mode was requested with no prompt. main.py maps this to 422."""


def resolve_mode(raw) -> str:
    """Normalize the caller's `mode`. Anything unrecognized (including None and
    a non-string) falls back to image mode, which is the safe default: it needs
    no prompt and accepts any photo."""
    if isinstance(raw, str) and raw.strip().lower() in MODES:
        return raw.strip().lower()
    return IMAGE_MODE


def resolve_prompt(mode: str, raw) -> str:
    """Trim the prompt and enforce the scribble-mode requirement. Image mode
    ignores the prompt entirely (the image pipeline takes no text), so it is
    returned as an empty string there rather than being carried into a call
    that would reject it."""
    prompt = raw.strip() if isinstance(raw, str) else ""
    if mode == SCRIBBLE_MODE:
        if not prompt:
            raise PromptRequired(
                "scribble mode is prompt-conditioned: supply a prompt naming what the sketch depicts"
            )
        return prompt
    return ""


def clamp_confidence(value) -> float:
    """Sketch-adherence scale, clamped to the 0..1 the cross-attention scale
    accepts. A non-numeric value falls back to the default rather than failing
    the generation."""
    try:
        num = float(value)
    except (TypeError, ValueError):
        return DEFAULT_SCRIBBLE_CONFIDENCE
    if num != num:  # NaN
        return DEFAULT_SCRIBBLE_CONFIDENCE
    return max(0.0, min(1.0, num))


def pipeline_settings(mode: str, *, prompt: str = "", scribble_confidence=None) -> dict:
    """Exact keyword arguments for the mode's pipeline call, minus the image and
    the RNG generator (which main.py supplies). Keeping them here means the two
    samplers can never drift apart unnoticed: a change to either is a change to
    a tested value."""
    if mode == SCRIBBLE_MODE:
        confidence = clamp_confidence(
            DEFAULT_SCRIBBLE_CONFIDENCE if scribble_confidence is None else scribble_confidence
        )
        return {
            "prompt": prompt,
            "num_inference_steps": SCRIBBLE_STEPS,
            "guidance_scale": SCRIBBLE_GUIDANCE,
            "attention_kwargs": {
                "cross_attention_scale": 1.0,
                "cross_attention_2_scale": confidence,
            },
            "use_flash_decoder": False,
            "dense_octree_depth": SCRIBBLE_OCTREE_DEPTH,
            "hierarchical_octree_depth": SCRIBBLE_OCTREE_DEPTH,
        }
    return {
        "num_inference_steps": IMAGE_STEPS,
        "guidance_scale": IMAGE_GUIDANCE,
    }


def should_decimate(face_count: int, target_faces) -> bool:
    """Decimation runs only when the caller asked for a budget AND the mesh is
    over it. Running a quadric collapse on an already-small mesh costs seconds
    and can only lose detail, so an under-budget mesh is exported as generated."""
    if not target_faces:
        return False
    try:
        target = int(target_faces)
    except (TypeError, ValueError):
        return False
    if target <= 0:
        return False
    return int(face_count) > target
