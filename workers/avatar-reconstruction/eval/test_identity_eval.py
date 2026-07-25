"""
Properties the ISE metric must hold, or its numbers cannot be trusted to gate a
pipeline change.

Run:  python -m pytest eval/test_identity_eval.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import face_geometry  # noqa: E402
from eval.identity_eval import score  # noqa: E402

RNG = np.random.default_rng(20260725)
N_LANDMARKS = 468


def _face_map() -> face_geometry.FaceMap:
    """A synthetic but structurally faithful canonical face + correspondence."""
    canonical = RNG.normal(scale=0.25, size=(N_LANDMARKS, 3))
    return face_geometry.FaceMap({
        "canonical_norm": canonical.tolist(),
        "landmark_vtx": list(range(N_LANDMARKS)),
        "head_face_scale": 0.18,
    })


def _similarity(points: np.ndarray, *, scale: float, seed: int) -> np.ndarray:
    """Apply a random rotation + the given scale + a random translation."""
    rng = np.random.default_rng(seed)
    q, _ = np.linalg.qr(rng.normal(size=(3, 3)))
    if np.linalg.det(q) < 0:
        q[:, 0] *= -1  # keep it a proper rotation, not a reflection
    return scale * (q @ points.T).T + rng.normal(scale=2.0, size=3)


def test_identical_shape_scores_zero():
    """An avatar whose landmark points *are* the person's scores ~0."""
    fm = _face_map()
    person = fm.canonical_norm + RNG.normal(scale=0.02, size=(N_LANDMARKS, 3))
    assert score(person, person.copy(), fm)["ise"] == pytest.approx(0.0, abs=1e-9)


def test_score_is_invariant_to_pose_and_scale():
    """
    The metric must measure shape only. A head that is twice as large, rotated
    and translated is the same face and must score the same — otherwise a
    pipeline could 'improve' by resizing the head.
    """
    fm = _face_map()
    person = fm.canonical_norm + RNG.normal(scale=0.03, size=(N_LANDMARKS, 3))
    head = fm.canonical_norm + RNG.normal(scale=0.05, size=(N_LANDMARKS, 3))

    baseline = score(person, head, fm)["ise"]
    for scale, seed in ((2.0, 1), (0.5, 2), (1.0, 3)):
        moved = score(person, _similarity(head, scale=scale, seed=seed), fm)["ise"]
        assert moved == pytest.approx(baseline, rel=1e-6)


def test_moving_toward_the_person_lowers_the_score():
    """
    Monotonicity: interpolating the template head toward the person's shape must
    reduce ISE at every step. This is the property that makes the score usable
    as an objective — it has to reward the thing the morph actually does.
    """
    fm = _face_map()
    person = fm.canonical_norm + RNG.normal(scale=0.06, size=(N_LANDMARKS, 3))
    template = fm.canonical_norm + RNG.normal(scale=0.06, size=(N_LANDMARKS, 3))

    scores = [
        score(person, template + t * (person - template), fm)["ise"]
        for t in (0.0, 0.25, 0.5, 0.75, 1.0)
    ]
    assert scores == sorted(scores, reverse=True), scores
    assert scores[-1] == pytest.approx(0.0, abs=1e-9)
    assert scores[0] > 0.0


def test_regions_are_reported_and_bounded_by_the_extremes():
    """Every region reports, and each mean sits inside the global min/max."""
    fm = _face_map()
    person = fm.canonical_norm + RNG.normal(scale=0.04, size=(N_LANDMARKS, 3))
    head = fm.canonical_norm + RNG.normal(scale=0.04, size=(N_LANDMARKS, 3))

    result = score(person, head, fm)
    assert set(result["regions"]) == {"oval", "nose", "cheeks", "brow", "jaw"}
    for value in result["regions"].values():
        assert 0.0 < value <= result["ise_max"]


def test_extra_iris_landmarks_are_ignored():
    """
    MediaPipe returns 478 points when iris refinement is on. The extra 10 must
    not shift the score — irises are expression/gaze, not identity.
    """
    fm = _face_map()
    person = fm.canonical_norm + RNG.normal(scale=0.03, size=(N_LANDMARKS, 3))
    head = fm.canonical_norm + RNG.normal(scale=0.05, size=(N_LANDMARKS, 3))

    with_irises = np.vstack([person, RNG.normal(scale=5.0, size=(10, 3))])
    assert score(with_irises, head, fm)["ise"] == pytest.approx(score(person, head, fm)["ise"])
