"""Unit tests for the decode/schema layer — pure NumPy, no model runtime."""

import numpy as np
import pytest

from decode import (
    FEATURE_COLUMNS,
    ID_TO_CHAR,
    MAX_FRAMES,
    N_FEATURES,
    decode_logits,
    validate_frames,
)


def one_hot(ids, vocab=63):
    out = np.full((len(ids), vocab), -10.0, dtype=np.float32)
    for row, i in enumerate(ids):
        out[row, i] = 10.0
    return out


def ids_for(text):
    char_to_id = {c: i for i, c in ID_TO_CHAR.items()}
    return [char_to_id[c] for c in text]


def test_schema_shape():
    assert N_FEATURES == 390
    assert len(FEATURE_COLUMNS) == 390
    assert FEATURE_COLUMNS[0].startswith("x_")
    # Hands are present in the selection — the whole point of the model.
    assert any("hand" in c for c in FEATURE_COLUMNS)


def test_decode_plain_text():
    assert decode_logits(one_hot(ids_for("hello"))) == "hello"


def test_decode_stops_at_special_after_output():
    ids = ids_for("hi") + [62, *ids_for("junk")]
    assert decode_logits(one_hot(ids)) == "hi"


def test_decode_skips_leading_specials():
    ids = [60, *ids_for("ok")]
    assert decode_logits(one_hot(ids)) == "ok"


def test_decode_rejects_bad_shape():
    with pytest.raises(ValueError):
        decode_logits(np.zeros(63))


def test_validate_frames_happy_path():
    frames = [[0.1] * N_FEATURES for _ in range(10)]
    arr = validate_frames(frames)
    assert arr.shape == (10, N_FEATURES)
    assert arr.dtype == np.float32


def test_validate_frames_null_becomes_nan():
    frames = [[None] * N_FEATURES for _ in range(10)]
    arr = validate_frames(frames)
    assert np.isnan(arr).all()


def test_validate_frames_caps():
    with pytest.raises(ValueError):
        validate_frames([[0.0] * N_FEATURES] * (MAX_FRAMES + 1))
    with pytest.raises(ValueError):
        validate_frames([[0.0] * N_FEATURES] * 2)
    with pytest.raises(ValueError):
        validate_frames([[0.0] * 10 for _ in range(10)])
    with pytest.raises(ValueError):
        validate_frames([])


def test_confidence_high_for_peaked_logits():
    from decode import decode_with_confidence

    text, conf = decode_with_confidence(one_hot(ids_for("hello")))
    assert text == "hello"
    assert conf > 0.95


def test_confidence_low_for_flat_logits():
    from decode import decode_with_confidence

    flat = np.zeros((10, 63), dtype=np.float32)
    flat[:, 5] += 0.01  # a barely-preferred char so something decodes
    text, conf = decode_with_confidence(flat)
    assert text != ""
    assert conf < 0.05


def test_confidence_zero_when_nothing_decodes():
    from decode import decode_with_confidence

    text, conf = decode_with_confidence(one_hot([60, 61, 62]))
    assert text == ""
    assert conf == 0.0
