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
    """A single wild landmark must not blow up the mesh (displacement clamp)."""
    _, base, _, fmap = _load()
    detected = fmap.canonical_norm.copy()
    detected[fmap.stable_indices[0]] += np.array([5.0, 5.0, 5.0])  # absurd outlier
    morphed = fg.morph_head_to_landmarks(base, fmap, detected, strength=1.0)
    move = np.linalg.norm(morphed - base, axis=1).max()
    clamp = 0.18 * fmap.head_face_scale
    assert move <= clamp * 1.5 + 1e-6, f"outlier not clamped: max move {move:.4f} vs clamp {clamp:.4f}"
    assert np.isfinite(morphed).all(), "non-finite vertices after morph"
    print(f"ok  outlier landmark clamped (max move {move:.4f} ≤ ~{clamp:.4f})")


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


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    try:
        for t in tests:
            t()
    except AssertionError as e:
        print("FAIL:", e); sys.exit(1)
    print(f"\nall {len(tests)} face-geometry tests passed")
