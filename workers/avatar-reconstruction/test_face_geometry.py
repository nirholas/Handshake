"""
Unit tests for the face-geometry identity morph (pure numpy, no GPU/MediaPipe).

Run: python3 test_face_geometry.py   (asserts; exits non-zero on failure)

Synthetic-landmark strategy: the morph aligns detected landmarks to the neutral
canonical model with a similarity transform, so we can hand it canonical points
put through ANY rotation/scale/translation plus a known local deformation, and it
must recover that deformation (frame-invariant by construction) — no photo needed.
"""

import sys

import numpy as np

import glb_ops
import face_geometry as fg


def _load():
    glb = glb_ops.load_glb(open("templates/default.glb", "rb").read())
    base, _, faces = glb_ops.get_head_mesh_data(glb)
    fmap = fg.FaceMap.load()
    assert fmap is not None, "face_uv_map.json missing geometry fields — run precompute_uv.py"
    return glb, base.astype(np.float64), faces, fmap


def _random_similarity(seed):
    rng = np.random.default_rng(seed)
    # proper rotation
    A = rng.normal(size=(3, 3))
    Q, _ = np.linalg.qr(A)
    if np.linalg.det(Q) < 0:
        Q[:, 0] *= -1
    s = float(rng.uniform(0.5, 2.0))
    t = rng.normal(size=3) * 3.0
    return s, Q, t


def test_umeyama_recovers_transform():
    _, base, _, fmap = _load()
    canon = fmap.canonical_norm
    s, R, t = _random_similarity(1)
    moved = (s * (R @ canon.T)).T + t
    s2, R2, t2 = fg.umeyama(canon, moved)
    recon = (s2 * (R2 @ canon.T)).T + t2
    err = np.abs(recon - moved).max()
    assert err < 1e-9, f"umeyama reconstruction error {err}"
    print("ok  umeyama recovers similarity transform")


def test_identity_no_morph():
    """Detected == canonical (up to a rigid pose) ⇒ zero identity residual ⇒ head unchanged."""
    _, base, _, fmap = _load()
    s, R, t = _random_similarity(2)
    detected = (s * (R @ fmap.canonical_norm.T)).T + t  # neutral face, arbitrary pose
    morphed = fg.morph_head_to_landmarks(base, fmap, detected, strength=0.75)
    err = np.abs(morphed - base).max()
    assert err < 1e-6, f"neutral face should not move the head, got max move {err}"
    print(f"ok  neutral face leaves head unchanged (max move {err:.2e})")


def test_wider_face_widens_head():
    """A face stretched 25% in X ⇒ the head's face region gets wider; back stays put."""
    _, base, _, fmap = _load()
    canon = fmap.canonical_norm.copy()
    wide = canon.copy()
    wide[:, 0] *= 1.25  # 25% wider identity
    s, R, t = _random_similarity(3)
    detected = (s * (R @ wide.T)).T + t
    morphed = fg.morph_head_to_landmarks(base, fmap, detected, strength=1.0)

    # Face-region vertices = those near a control point (front, +Z hemisphere).
    front = base[:, 2] > np.median(base[:, 2])
    cx = base[:, 0].mean()
    base_spread = np.abs(base[front, 0] - cx).mean()
    morph_spread = np.abs(morphed[front, 0] - cx).mean()
    assert morph_spread > base_spread * 1.02, (
        f"face did not widen: base {base_spread:.4f} → morph {morph_spread:.4f}"
    )

    # Back-of-head vertices (behind the face) must be essentially untouched by the mask.
    back = base[:, 2] < np.percentile(base[:, 2], 15)
    back_move = np.linalg.norm(morphed[back] - base[back], axis=1).max()
    assert back_move < 0.01, f"back of head moved too much: {back_move:.4f}"
    print(f"ok  wider face widens front ({base_spread:.4f}→{morph_spread:.4f}), back frozen ({back_move:.2e})")


def test_outlier_clamped():
    """
    A single wild landmark must not blow up the mesh, at whatever clamp is in
    force — including the shipped default, which the ISE sweep may retune.

    The bound is asserted against the clamp actually passed rather than a literal,
    so retuning `max_displacement_frac` cannot silently turn this into a test of
    a value nobody ships.
    """
    _, base, _, fmap = _load()
    detected = fmap.canonical_norm.copy()
    detected[fmap.stable_indices[0]] += np.array([5.0, 5.0, 5.0])  # absurd outlier

    import inspect
    shipped = inspect.signature(fg.morph_head_to_landmarks).parameters["max_displacement_frac"].default

    for frac in (0.18, shipped, 0.65):
        morphed = fg.morph_head_to_landmarks(
            base, fmap, detected, strength=1.0, max_displacement_frac=frac
        )
        move = np.linalg.norm(morphed - base, axis=1).max()
        clamp = frac * fmap.head_face_scale
        assert move <= clamp * 1.5 + 1e-6, (
            f"outlier not clamped at frac={frac}: max move {move:.4f} vs clamp {clamp:.4f}"
        )
        assert np.isfinite(morphed).all(), "non-finite vertices after morph"
    print(f"ok  outlier landmark clamped at every frac (shipped default {shipped})")


def test_roundtrip_through_glb():
    """Morph → write via glb_ops → reload: rig + 67 blendshapes survive, mesh valid."""
    glb, base, faces, fmap = _load()
    wide = fmap.canonical_norm.copy(); wide[:, 1] *= 1.15  # taller face
    morphed = fg.morph_head_to_landmarks(base, fmap, wide, strength=0.9)
    glb_ops.set_head_geometry(glb, morphed, faces=faces)
    out = glb_ops.save_glb(glb)
    g2 = glb_ops.load_glb(out)
    prim = glb_ops._find_head_prim(g2)
    pos2, _, _ = glb_ops.get_head_mesh_data(g2)
    assert len(prim.targets) == 67, "blendshapes lost"
    assert prim.attributes.JOINTS_0 is not None and prim.attributes.WEIGHTS_0 is not None, "skinning lost"
    assert np.isfinite(pos2).all() and len(out) > 100_000, "invalid GLB"
    print("ok  morph survives GLB write/reload with rig + 67 blendshapes intact")


def test_dense_registration_recovers_target():
    """v2: anchored TPS fit pulls the face toward a target feature, off-face frozen.

    Mirrors the real flow: a high-fidelity model (MICA/FLAME) supplies the target's
    468 landmark positions (known correspondence) plus a dense surface, handed to
    the fit in an ARBITRARY pose (exercises Umeyama alignment). We validate with a
    LOCAL feature (a forward nose bump) — a clean, unambiguous signal, because a
    localised displacement carries no global-similarity component for the alignment
    to absorb. Global-scale differences are intentionally normalised away (we
    transfer the person's proportions, not rescale the template), so final quality
    tuning happens against real model output, not synthetic global scalings.
    """
    _, base, faces, fmap = _load()
    target = base.copy()
    nose = base[:, 2] > np.percentile(base[:, 2], 92)
    target[nose, 2] += 0.02                              # local forward nose bump

    s, R, t = _random_similarity(7)                      # arbitrary pose
    target_posed = (s * (R @ target.T)).T + t
    tgt_landmarks = target_posed[fmap.landmark_vtx]      # known correspondence

    result = fg.register_head_to_target(
        base, fmap, tgt_landmarks, target_points=target_posed, strength=1.0
    )

    err_before = np.linalg.norm((base - target)[nose], axis=1).mean()
    err_after = np.linalg.norm((result - target)[nose], axis=1).mean()
    assert err_after < err_before * 0.6, (
        f"registration did not pull toward target: {err_before:.4f} → {err_after:.4f}"
    )
    # Off-face (back of head) must stay frozen.
    back = base[:, 2] < np.percentile(base[:, 2], 12)
    back_move = np.linalg.norm(result[back] - base[back], axis=1).max()
    assert back_move < 0.012, f"back of head moved: {back_move:.4f}"
    assert np.isfinite(result).all()
    print(f"ok  dense registration pulls face to target (nose err {err_before:.4f}→{err_after:.4f}, "
          f"{100*(1-err_after/err_before):.0f}% ↓, back frozen {back_move:.2e})")


def test_registration_preserves_rig_through_glb():
    """v2 registration output writes back through glb_ops with rig + blendshapes intact."""
    glb, base, faces, fmap = _load()
    target = base.copy()
    target[base[:, 2] > np.percentile(base[:, 2], 90), 2] += 0.015
    result = fg.register_head_to_target(base, fmap, target[fmap.landmark_vtx],
                                        target_points=target, strength=1.0)
    glb_ops.set_head_geometry(glb, result, faces=faces)
    out = glb_ops.save_glb(glb)
    prim = glb_ops._find_head_prim(glb_ops.load_glb(out))
    assert len(prim.targets) == 67 and prim.attributes.JOINTS_0 is not None
    assert len(out) > 100_000
    print("ok  v2 registration survives GLB write with rig + 67 blendshapes intact")


class _FakeLandmark:
    """Stands in for a MediaPipe NormalizedLandmark (x, y, z in [0,1]-ish)."""

    __slots__ = ("x", "y", "z")

    def __init__(self, x, y, z):
        self.x, self.y, self.z = float(x), float(y), float(z)


def test_landmarks_are_independent_of_photo_aspect_ratio():
    """
    The same face shot at 3:4, 1:1 and 9:16 must produce the same morph.

    MediaPipe normalises x by image width and y by image height, so its raw
    output stretches with the photo's aspect ratio. Umeyama fits one uniform
    scale and cannot undo an anisotropic one, so any leftover stretch survives
    alignment and is read as facial identity — the camera's aspect ratio ends up
    baked into the avatar's skull. Passing pixel dimensions restores an isotropic
    frame. Without that, this test fails.
    """
    _, base, _, fmap = _load()
    canon = fmap.canonical_norm

    # One face in isotropic pixel space, then expressed in each photo's
    # normalised coordinates — exactly what MediaPipe would return for a face
    # occupying the same physical region of differently-shaped images.
    face_px = (canon - canon.min(0)) / (canon.max(0) - canon.min(0)).max()
    face_px[:, 1] *= -1  # canonical is y-up; image space is y-down

    results = []
    for width, height in ((864, 1152), (1024, 1024), (720, 1280)):
        landmarks = [
            _FakeLandmark(0.2 + p[0] * 0.6 * (720 / width),
                          0.2 + p[1] * 0.6 * (720 / height),
                          p[2] * 0.6 * (720 / width))
            for p in face_px
        ]
        detected = fg.landmarks_to_array(landmarks, width, height)
        results.append(fg.morph_head_to_landmarks(base, fmap, detected, strength=0.75))

    reference = results[0]
    scale = np.linalg.norm(reference.max(0) - reference.min(0))
    for i, other in enumerate(results[1:], 1):
        drift = np.linalg.norm(other - reference, axis=1).max() / scale
        assert drift < 1e-6, f"aspect ratio {i} changed the head shape by {drift:.2%}"
    print("ok  morph is invariant to source photo aspect ratio (3:4 / 1:1 / 9:16)")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    try:
        for t in tests:
            t()
    except AssertionError as e:
        print("FAIL:", e); sys.exit(1)
    print(f"\nall {len(tests)} face-geometry tests passed")
