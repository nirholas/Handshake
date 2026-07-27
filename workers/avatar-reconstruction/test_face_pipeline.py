"""
Unit tests for the texture stage of the selfie → avatar pipeline.

Run: python3 test_face_pipeline.py   (asserts; exits non-zero on failure)

Scope note: the face oval the selfie covers is only 10.4% of the head's texels
(9.4% of its surface area). Ears, scalp, neck and under-jaw are reached by
projective texturing (face_projection.py) and, where even that cannot see, by
the skin tint alone. That asymmetry is why the tint's mask behaviour matters
enough to pin: it must reach everything the photo could not, and nothing the
photo did.
"""

import sys

import numpy as np
from PIL import Image

import face_pipeline as fp


def _flat(rgb, size=64):
    return Image.fromarray(np.full((size, size, 3), rgb, dtype=np.uint8))


def test_tint_moves_texture_toward_target():
    """Baseline: with no mask, the tint shifts the whole texture toward target."""
    base = _flat((100, 100, 100))
    out = np.array(_tint(base, np.array([200.0, 200.0, 200.0]), 0.5).convert("RGB"), dtype=np.float32)
    # mean 100, target 200, strength 0.5 → +50
    assert abs(out.mean() - 150.0) < 1.0, f"expected ~150, got {out.mean():.1f}"
    print("ok  tint shifts an unmasked texture toward the target")


def _tint(base, target, strength, protect_mask=None):
    return fp._tint_texture(base, target, strength=strength, protect_mask=protect_mask)


def test_protected_region_keeps_its_photographic_colour():
    """
    The face oval is composited straight from the user's photograph and is the
    only region of the model carrying true photographic colour. Tinting it
    toward a sampled average of itself can only move it away from the truth, so
    a fully-protected region must come through untouched.
    """
    size = 64
    base = _flat((100, 100, 100), size)
    mask = np.zeros((size, size), dtype=np.float32)
    mask[16:48, 16:48] = 1.0  # "face oval"

    out = np.array(_tint(base, np.array([200.0, 200.0, 200.0]), 0.5, mask).convert("RGB"), dtype=np.float32)
    inside = out[16:48, 16:48]
    outside = out[:8, :8]

    assert abs(inside.mean() - 100.0) < 0.51, f"protected region moved: {inside.mean():.1f} (want 100)"
    assert abs(outside.mean() - 150.0) < 1.0, f"unprotected region not tinted: {outside.mean():.1f} (want 150)"
    print("ok  protected face pixels keep photographic colour; template still tinted")


def test_tint_still_reaches_every_unprotected_pixel():
    """
    The tint's whole job is the ~90% of the head the camera never saw. A mask
    that accidentally suppressed it there would leave a template-coloured neck
    against a photographic face — a worse artefact than the one being fixed.
    """
    size = 64
    base = _flat((100, 100, 100), size)
    mask = np.zeros((size, size), dtype=np.float32)
    mask[0:2, 0:2] = 1.0  # tiny protected corner

    out = np.array(_tint(base, np.array([160.0, 160.0, 160.0]), 0.5, mask).convert("RGB"), dtype=np.float32)
    unprotected = out[4:, 4:]
    assert unprotected.min() > 100.0, "some unprotected pixels were not tinted at all"
    assert abs(unprotected.mean() - 130.0) < 1.0, f"unprotected mean {unprotected.mean():.1f}, want ~130"
    print("ok  tint reaches every unprotected pixel (neck/ears/scalp still personalised)")


def test_feathered_mask_produces_a_gradient_not_a_seam():
    """
    The real mask is feathered. A binary application would leave a visible ring
    at the oval boundary — the exact place a viewer looks. Intermediate mask
    values must produce intermediate tinting.
    """
    size = 64
    base = _flat((100, 100, 100), size)
    mask = np.zeros((size, size), dtype=np.float32)
    mask[:, :] = np.linspace(0.0, 1.0, size, dtype=np.float32)[None, :]

    out = np.array(_tint(base, np.array([200.0, 200.0, 200.0]), 0.5, mask).convert("RGB"), dtype=np.float32)
    col_means = out.mean(axis=(0, 2))
    # Tint strength must fall monotonically as protection rises.
    assert col_means[0] > col_means[size // 2] > col_means[-1], "tint is not monotonic across the feather"
    assert abs(col_means[-1] - 100.0) < 1.5, "fully-protected edge was still tinted"
    print("ok  feathered mask yields a smooth gradient, no seam at the oval boundary")


def test_none_mask_is_backwards_compatible():
    """Callers that pass no mask (hair tint) must behave exactly as before."""
    base = _flat((80, 90, 100))
    a = np.array(_tint(base, np.array([180.0, 180.0, 180.0]), 0.35).convert("RGB"), dtype=np.float32)
    b = np.array(_tint(base, np.array([180.0, 180.0, 180.0]), 0.35, None).convert("RGB"), dtype=np.float32)
    assert np.array_equal(a, b)
    print("ok  omitting the mask is unchanged behaviour (hair tint unaffected)")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    try:
        for t in tests:
            t()
    except AssertionError as e:
        print("FAIL:", e)
        sys.exit(1)
    print(f"\nall {len(tests)} face-pipeline tests passed")
