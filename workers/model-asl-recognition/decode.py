"""Feature schema + output decoding for the ASL fingerspelling recognizer.

The model is the Google ASL Fingerspelling (Kaggle 2023) 1st-place TFLite
export (Apache-2.0, Christof Henkel), trained on Google's FSboard corpus
(CC BY 4.0). Input is a (frames, 390) float32 matrix of selected MediaPipe
landmark coordinates (the exact column order ships in inference_args.json);
output is (tokens, 63) logits over the competition character set
(character_to_prediction_index.json, 59 printable characters + specials).

Pure NumPy + stdlib so decoding is unit-tested without the model runtime.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

_HERE = Path(__file__).parent

with open(_HERE / "inference_args.json", "r", encoding="utf-8") as f:
    FEATURE_COLUMNS: list[str] = json.load(f)["selected_columns"]

with open(_HERE / "character_to_prediction_index.json", "r", encoding="utf-8") as f:
    _CHAR_TO_ID: dict[str, int] = json.load(f)

ID_TO_CHAR: dict[int, str] = {i: c for c, i in _CHAR_TO_ID.items()}

N_FEATURES = len(FEATURE_COLUMNS)  # 390

# Practical caps: ~50s of 30fps signing per request keeps payloads sane.
MAX_FRAMES = 1500
MIN_FRAMES = 8


def decode_logits(logits: np.ndarray) -> str:
    """(tokens, vocab) logits → text. Ids outside the printable character map
    (BOS/EOS/PAD) terminate or are dropped, matching the competition decode."""
    logits = np.asarray(logits)
    if logits.ndim != 2:
        raise ValueError(f"logits must be 2D (tokens, vocab); got {logits.shape}")
    ids = np.argmax(logits, axis=-1)
    chars = []
    for i in ids:
        ch = ID_TO_CHAR.get(int(i))
        if ch is None:
            # First special token after any output ends the sequence; leading
            # specials are skipped so a BOS never truncates the whole decode.
            if chars:
                break
            continue
        chars.append(ch)
    return "".join(chars).strip()


def validate_frames(frames) -> np.ndarray:
    """Request payload → (T, 390) float32 with None mapped to NaN (missing
    landmarks — the model was trained to handle NaN natively)."""
    if not isinstance(frames, list) or not frames:
        raise ValueError("frames must be a non-empty list")
    if len(frames) > MAX_FRAMES:
        raise ValueError(f"too many frames (max {MAX_FRAMES})")
    if len(frames) < MIN_FRAMES:
        raise ValueError(f"too few frames for recognition (min {MIN_FRAMES})")
    arr = np.array(
        [[np.nan if v is None else float(v) for v in row] for row in frames],
        dtype=np.float32,
    )
    if arr.shape[1] != N_FEATURES:
        raise ValueError(f"each frame must have {N_FEATURES} values; got {arr.shape[1]}")
    return arr
