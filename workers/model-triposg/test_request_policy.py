"""Unit tests for request_policy.py: pure decision logic, no torch, no CUDA, no
weights, no TripoSG source tree. Runs anywhere:

    python3 workers/model-triposg/test_request_policy.py

(also collectable by pytest if it is installed). These pin the two things a
caller can get wrong and the two the worker must never get wrong: mode routing,
the scribble prompt gate, the CFG-distilled sampler settings, and the
decimation guard.
"""

from __future__ import annotations

import sys

from request_policy import (
    DEFAULT_SCRIBBLE_CONFIDENCE,
    IMAGE_GUIDANCE,
    IMAGE_MODE,
    IMAGE_STEPS,
    PromptRequired,
    SCRIBBLE_MODE,
    SCRIBBLE_STEPS,
    clamp_confidence,
    pipeline_settings,
    resolve_mode,
    resolve_prompt,
    should_decimate,
)


def test_mode_defaults_to_image():
    assert resolve_mode(None) == IMAGE_MODE
    assert resolve_mode("") == IMAGE_MODE
    assert resolve_mode("photo") == IMAGE_MODE
    assert resolve_mode(7) == IMAGE_MODE


def test_mode_accepts_both_documented_modes():
    assert resolve_mode("image") == IMAGE_MODE
    assert resolve_mode("scribble") == SCRIBBLE_MODE
    assert resolve_mode("  Scribble ") == SCRIBBLE_MODE


def test_scribble_without_prompt_is_a_caller_error():
    for empty in (None, "", "   ", 0):
        try:
            resolve_prompt(SCRIBBLE_MODE, empty)
        except PromptRequired:
            continue
        raise AssertionError(f"empty prompt {empty!r} was accepted in scribble mode")


def test_scribble_prompt_is_trimmed():
    assert resolve_prompt(SCRIBBLE_MODE, "  a brass steampunk owl  ") == "a brass steampunk owl"


def test_image_mode_drops_the_prompt():
    # The image pipeline takes no text; carrying a prompt into it would be a
    # TypeError at call time, and silently honouring it would be a lie.
    assert resolve_prompt(IMAGE_MODE, "a brass steampunk owl") == ""


def test_confidence_is_clamped_and_never_fails_a_generation():
    assert clamp_confidence(0.4) == 0.4
    assert clamp_confidence(-3) == 0.0
    assert clamp_confidence(9) == 1.0
    assert clamp_confidence("0.75") == 0.75
    assert clamp_confidence(None) == DEFAULT_SCRIBBLE_CONFIDENCE
    assert clamp_confidence("later") == DEFAULT_SCRIBBLE_CONFIDENCE
    assert clamp_confidence(float("nan")) == DEFAULT_SCRIBBLE_CONFIDENCE


def test_image_settings_are_the_full_sampler():
    settings = pipeline_settings(IMAGE_MODE)
    assert settings == {
        "num_inference_steps": IMAGE_STEPS,
        "guidance_scale": IMAGE_GUIDANCE,
    }
    # No prompt and no attention kwargs reach the image pipeline.
    assert "prompt" not in settings
    assert "attention_kwargs" not in settings


def test_scribble_settings_keep_guidance_at_zero():
    settings = pipeline_settings(SCRIBBLE_MODE, prompt="a brass steampunk owl", scribble_confidence=0.9)
    assert settings["num_inference_steps"] == SCRIBBLE_STEPS
    # The distilled checkpoint bakes guidance in; a non-zero scale double-applies it.
    assert settings["guidance_scale"] == 0.0
    assert settings["prompt"] == "a brass steampunk owl"
    assert settings["attention_kwargs"]["cross_attention_2_scale"] == 0.9
    assert settings["attention_kwargs"]["cross_attention_scale"] == 1.0
    assert settings["use_flash_decoder"] is False
    assert settings["dense_octree_depth"] == settings["hierarchical_octree_depth"] == 8


def test_scribble_settings_clamp_the_confidence_they_are_given():
    settings = pipeline_settings(SCRIBBLE_MODE, prompt="owl", scribble_confidence=42)
    assert settings["attention_kwargs"]["cross_attention_2_scale"] == 1.0
    default = pipeline_settings(SCRIBBLE_MODE, prompt="owl")
    assert default["attention_kwargs"]["cross_attention_2_scale"] == DEFAULT_SCRIBBLE_CONFIDENCE


def test_decimation_only_runs_when_asked_and_over_budget():
    assert should_decimate(500_000, 100_000) is True
    assert should_decimate(50_000, 100_000) is False
    assert should_decimate(50_000, 50_000) is False
    assert should_decimate(500_000, None) is False
    assert should_decimate(500_000, 0) is False
    assert should_decimate(500_000, "nope") is False


def main() -> int:
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith("test_") and callable(fn)]
    for name, fn in tests:
        try:
            fn()
        except AssertionError as exc:
            print(f"FAIL  {name}  {exc}")
            return 1
        print(f"ok    {name}")
    print(f"\n{len(tests)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
