"""Core-path smoke test: real weights, real interpreter, real decode.

test_decode.py covers the pure schema/decode layer without a model runtime.
This file covers the path that actually serves traffic: a landmark matrix goes
through validate_frames, the shipped LiteRT model runs on CPU, and the logits
decode to text. It needs the weights the Dockerfile bakes into /models, so the
normal way to run it is inside the built image:

    docker build -t model-asl-recognition:local .
    docker run --rm -v "$PWD:/src" -w /src model-asl-recognition:local \\
      python test_model_smoke.py

That standalone entrypoint keeps the image free of a test-only pytest install.
Under pytest (with MODEL_PATH pointing at a local model.tflite) the same checks
run as ordinary tests; without weights present they skip rather than pretend.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np

from decode import (
    FEATURE_COLUMNS,
    ID_TO_CHAR,
    MIN_FRAMES,
    N_FEATURES,
    decode_with_confidence,
    validate_frames,
)

MODEL_PATH = os.environ.get("MODEL_PATH", "/models/model.tflite")

_runner = None


def _load_runner():
    """The same interpreter setup main.py's lifespan performs."""
    global _runner
    if _runner is None:
        from ai_edge_litert.interpreter import Interpreter

        interp = Interpreter(model_path=MODEL_PATH)
        _runner = interp.get_signature_runner()
    return _runner


def _infer(arr: np.ndarray) -> np.ndarray:
    runner = _load_runner()
    name = list(runner.get_input_details().keys())[0]
    return next(iter(runner(**{name: arr}).values()))


def _require_model():
    if not Path(MODEL_PATH).exists():
        import pytest

        pytest.skip(f"weights absent at {MODEL_PATH}; run this inside the built image")


def _landmark_frames(count: int, seed: int = 7) -> list[list[float]]:
    """Plausible normalized MediaPipe coordinates: x/y in frame, z near zero."""
    rng = np.random.default_rng(seed)
    rows = rng.uniform(0.2, 0.8, size=(count, N_FEATURES))
    rows[:, 2 * (N_FEATURES // 3) :] *= 0.05
    return rows.round(4).tolist()


def test_model_decodes_a_capture():
    _require_model()
    arr = validate_frames(_landmark_frames(48))
    logits = _infer(arr)
    assert logits.ndim == 2, f"expected (tokens, vocab) logits; got {logits.shape}"
    assert logits.shape[1] > max(ID_TO_CHAR), (
        f"vocab {logits.shape[1]} cannot cover character id {max(ID_TO_CHAR)}"
    )
    text, confidence = decode_with_confidence(logits)
    assert isinstance(text, str)
    assert 0.0 <= confidence <= 1.0


def test_model_tolerates_missing_landmarks():
    """Hands leave frame constantly; those columns arrive as null/NaN and the
    model was trained for it, so a partial capture must still decode."""
    _require_model()
    frames = _landmark_frames(32, seed=11)
    dropped = [i for i, c in enumerate(FEATURE_COLUMNS) if "left_hand" in c]
    assert dropped, "the selection must contain left-hand columns"
    for row in frames:
        for i in dropped:
            row[i] = None
    arr = validate_frames(frames)
    assert np.isnan(arr[:, dropped]).all()
    text, confidence = decode_with_confidence(_infer(arr))
    assert isinstance(text, str)
    assert 0.0 <= confidence <= 1.0


def test_shortest_accepted_capture_runs():
    _require_model()
    logits = _infer(validate_frames(_landmark_frames(MIN_FRAMES, 3)))
    assert logits.ndim == 2
    decode_with_confidence(logits)


def main() -> int:
    if not Path(MODEL_PATH).exists():
        print(f"FAIL: weights absent at {MODEL_PATH}", file=sys.stderr)
        return 1
    checks = [
        test_model_decodes_a_capture,
        test_model_tolerates_missing_landmarks,
        test_shortest_accepted_capture_runs,
    ]
    for check in checks:
        check()
        print(f"ok  {check.__name__}")
    arr = validate_frames(_landmark_frames(48))
    text, confidence = decode_with_confidence(_infer(arr))
    print(f"{len(checks)} checks passed; sample decode {text!r} confidence {confidence:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
