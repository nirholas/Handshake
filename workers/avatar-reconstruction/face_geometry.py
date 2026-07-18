"""
Selfie → 3D face-shape identity morph (Phase 2: geometry, not just texture).

Phase 1 (face_pipeline.py) only paints the user's face texture onto a generic
Wolf3D head, so the *shape* — face width, jaw, nose projection, brow, cheekbones
— stays that of the template. This module recovers the person's actual face
geometry from a single photo and reshapes the template head to match, which is
the difference between "a face sticker on a mannequin" and an avatar that reads
as the same person (the gap vs Avaturn).

Approach — sparse-to-dense identity transfer, fully commercial-clean:
  1. MediaPipe FaceMesh (Apache-2.0, already a dependency) → 468 3D landmarks.
  2. Umeyama similarity-align the detected landmarks onto MediaPipe's neutral
     canonical face model (shared frame). The residual (person - canonical) on a
     stable identity subset IS the person's face-shape deviation from neutral.
  3. Carry that per-landmark displacement onto the template head's corresponding
     vertices (precomputed nearest-vertex map), scaled into head units.
  4. Diffuse the sparse displacements across all head vertices with a normalised
     Gaussian RBF (partition of unity — local, bounded, never extrapolates), and
     fade to zero outside the face region so the neck, scalp and back of the head
     stay put.
  5. face_pipeline writes the morphed positions back with glb_ops.set_head_geometry,
     which preserves skinning and all 52 ARKit blendshapes + visemes.

Everything below the MediaPipe adapter is pure numpy and is unit-tested with
synthetic landmarks, so the geometry math is verifiable without a GPU or a photo.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

import numpy as np

log = logging.getLogger("face_geometry")

HERE = Path(__file__).parent
FACE_MAP_PATH = HERE / "face_uv_map.json"

# Landmarks that encode stable identity (bone/cartilage structure) rather than
# transient expression. We deliberately exclude the eyeballs/irises (468-477),
# inner lips and tongue: a smile or blink in the selfie must not deform the rest
# pose of the avatar. Face oval, nose bridge/tip, cheeks, brow ridge, jawline.
_STABLE_IDENTITY_INDICES = [
    # face oval / silhouette
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
    397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
    172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
    # nose bridge + tip + alae
    6, 197, 195, 5, 4, 1, 19, 94, 2, 98, 327, 129, 358,
    # cheeks / malar
    50, 280, 116, 345, 117, 346, 118, 347, 205, 425,
    # brow ridge
    107, 336, 66, 296, 105, 334, 63, 293,
    # jaw / chin
    32, 262, 211, 431, 170, 395, 208, 428,
]


class FaceMap:
    """Precomputed template↔canonical correspondence (built by precompute_uv.py)."""

    def __init__(self, data: dict):
        self.canonical_norm = np.asarray(data["canonical_norm"], dtype=np.float64)  # (468,3)
        self.landmark_vtx = np.asarray(data["landmark_vtx"], dtype=np.int64)        # (468,)
        self.head_face_scale = float(data["head_face_scale"])
        n = self.canonical_norm.shape[0]
        self.stable_indices = np.asarray(
            [i for i in data.get("stable_indices", _STABLE_IDENTITY_INDICES) if i < n],
            dtype=np.int64,
        )

    @classmethod
    def load(cls, path: Path = FACE_MAP_PATH) -> Optional["FaceMap"]:
        if not path.exists():
            return None
        data = json.loads(path.read_text())
        if "canonical_norm" not in data or "landmark_vtx" not in data:
            # Older texture-only map without geometry fields — geometry morph off.
            return None
        return cls(data)


# ── alignment ────────────────────────────────────────────────────────────────

def umeyama(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """
    Least-squares similarity transform (scale s, rotation R, translation t) that
    best maps src → dst (both (N,3)). Umeyama 1991. Returns (s, R, t) with
    dst ≈ s * R @ src + t.
    """
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)
    mu_s, mu_d = src.mean(0), dst.mean(0)
    sc, dc = src - mu_s, dst - mu_d
    cov = (dc.T @ sc) / src.shape[0]
    U, D, Vt = np.linalg.svd(cov)
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1.0  # reflection guard — keep a proper rotation
    R = U @ S @ Vt
    var_s = (sc ** 2).sum() / src.shape[0]
    s = float((D * np.diag(S)).sum() / var_s) if var_s > 0 else 1.0
    t = mu_d - s * (R @ mu_s)
    return s, R, t


def _apply(s: float, R: np.ndarray, t: np.ndarray, pts: np.ndarray) -> np.ndarray:
    return (s * (R @ pts.T)).T + t


# ── the morph ────────────────────────────────────────────────────────────────

def morph_head_to_landmarks(
    base_positions: np.ndarray,
    face_map: FaceMap,
    detected_landmarks: np.ndarray,
    *,
    strength: float = 0.75,
    max_displacement_frac: float = 0.18,
    falloff: float = 1.6,
) -> np.ndarray:
    """
    Reshape the template head to the person's face identity.

    Args:
        base_positions:     (V,3) template head vertices (head/metre space).
        face_map:           precomputed correspondence + scale.
        detected_landmarks: (468,3) MediaPipe landmarks for the selfie. May be
                            (478,3) with irises — extra rows are ignored.
        strength:           0..1 how strongly to move toward the person's shape.
                            <1 keeps the result on a plausible face manifold.
        max_displacement_frac: clamp per-control displacement to this fraction of
                            the face scale — rejects landmark/pose outliers.
        falloff:            Gaussian RBF radius as a multiple of the median
                            control-point spacing. Larger = smoother/broader.

    Returns:
        (V,3) float32 morphed vertices. Vertex count/order unchanged, so the
        caller can write them back without disturbing skinning or blendshapes.
    """
    base = np.asarray(base_positions, dtype=np.float64)
    canon = face_map.canonical_norm                    # (468,3), unit-cube frame
    idx = face_map.stable_indices
    det = np.asarray(detected_landmarks, dtype=np.float64)[: canon.shape[0]]

    # 1. Similarity-align the person's landmarks onto the neutral canonical face,
    #    using only stable identity points, then measure the residual there.
    s, R, t = umeyama(det[idx], canon[idx])
    det_aligned = _apply(s, R, t, det)                 # person in canonical frame
    residual = det_aligned - canon                     # identity deviation (norm units)

    # 2. Carry to head units and clamp outliers.
    disp = residual[idx] * face_map.head_face_scale * float(strength)  # (K,3)
    clamp = max_displacement_frac * face_map.head_face_scale
    mag = np.linalg.norm(disp, axis=1, keepdims=True)
    over = (mag > clamp).ravel()
    if over.any():
        disp[over] *= (clamp / mag[over])

    # 3. Control points = the template vertices those stable landmarks map to.
    ctrl_vtx = face_map.landmark_vtx[idx]
    ctrl_pos = base[ctrl_vtx]                           # (K,3) in head space

    # Deduplicate control vertices (several landmarks can share a nearest vertex);
    # average their displacements so no vertex is double-weighted.
    uniq, inv = np.unique(ctrl_vtx, return_inverse=True)
    acc = np.zeros((uniq.shape[0], 3)); cnt = np.zeros((uniq.shape[0], 1))
    np.add.at(acc, inv, disp); np.add.at(cnt, inv, 1.0)
    ctrl_pos = base[uniq]
    ctrl_disp = acc / np.maximum(cnt, 1.0)

    # 4. Thin-plate-spline INTERPOLATION of the control displacements over every
    #    head vertex. TPS passes THROUGH the anchors, so localised identity (a
    #    wider jaw, a longer nose) is preserved instead of being averaged away —
    #    the failure mode of Shepard/normalised-Gaussian weighting. TPS can drift
    #    far from the anchors, but the off-face mask zeroes it there, so the neck
    #    and scalp stay put. Same RBF family face_pipeline uses for its UV warp.
    spacing = _median_nn_spacing(ctrl_pos)
    sigma = max(spacing * float(falloff), 1e-4)
    nearest = np.sqrt(_pairwise_sq(base, ctrl_pos).min(1, keepdims=True))
    mask = np.exp(-(nearest ** 2) / (2.0 * (sigma * 2.0) ** 2))

    from scipy.interpolate import RBFInterpolator
    rbf = RBFInterpolator(ctrl_pos, ctrl_disp, kernel="thin_plate_spline", smoothing=1e-3)
    field = rbf(base) * mask

    return (base + field).astype(np.float32)


def register_head_to_target(
    base_positions: np.ndarray,
    face_map: FaceMap,
    target_landmarks: np.ndarray,
    *,
    target_points: Optional[np.ndarray] = None,
    strength: float = 1.0,
    max_displacement_frac: float = 0.4,
    falloff: float = 3.0,
    icp_iterations: int = 4,
) -> np.ndarray:
    """
    Dense non-rigid registration (the v2 path): reshape the template head to a
    high-fidelity target head from MICA/FLAME, a re-based HRN, or any dense face
    model. Model-agnostic — it needs the target's 468 landmark positions (every
    such model exposes a landmark embedding) and, optionally, a dense surface.

    Two stages, because they solve different problems:
      A. Landmark-anchored fit — the 468 target landmarks have KNOWN correspondence
         to the template's control vertices, so this recovers gross shape (face
         width, length, nose/jaw projection) without the tangential "sliding" that
         defeats pure closest-point ICP on a smooth surface.
      B. Optional dense point-to-plane ICP — refines fine surface detail along the
         normal direction, where closest-point matching is well-posed.

    The target is first Umeyama-aligned to the template via the shared landmarks,
    so the caller can pass the model's raw output frame. Vertex count/order are
    preserved, so `glb_ops.set_head_geometry` writes it back with the rig and every
    ARKit blendshape intact.

    Args:
        target_landmarks: (>=468, 3) the target's landmark positions (any frame).
        target_points:    optional (M,3) dense target surface for stage B.

    Returns:
        (V,3) float32 morphed vertices.
    """
    base = np.asarray(base_positions, dtype=np.float64)
    tgt_lm = np.asarray(target_landmarks, dtype=np.float64)[: face_map.canonical_norm.shape[0]]
    face_scale = face_map.head_face_scale
    clamp = max_displacement_frac * face_scale

    # Control vertices and the target landmark that drives each (dedup shared).
    lm_vtx = face_map.landmark_vtx
    uniq, inv = np.unique(lm_vtx, return_inverse=True)
    tgt_per_uniq = np.zeros((uniq.shape[0], 3)); cnt = np.zeros((uniq.shape[0], 1))
    np.add.at(tgt_per_uniq, inv, tgt_lm); np.add.at(cnt, inv, 1.0)
    tgt_ctrl = tgt_per_uniq / np.maximum(cnt, 1.0)         # target pos per control vtx
    base_ctrl = base[uniq]

    # Align the target landmarks onto the template's control vertices (absorbs the
    # model's scale/orientation/translation) so displacements are in head space.
    s, R, t = umeyama(tgt_ctrl, base_ctrl)
    tgt_ctrl = _apply(s, R, t, tgt_ctrl)

    # Off-face mask so only the face tracks the target (scalp/ears/neck frozen).
    sigma = max(_median_nn_spacing(base_ctrl) * float(falloff), 1e-4)
    nearest = np.sqrt(_pairwise_sq(base, base_ctrl).min(1, keepdims=True))
    mask = np.exp(-(nearest ** 2) / (2.0 * (sigma * 2.0) ** 2))

    def interpolate(centers, disp):
        """
        Thin-plate-spline INTERPOLATION of the control displacements over all
        vertices (passes through the anchors exactly — unlike Shepard averaging,
        which smooths them away and dilutes localised shape like a wider jaw),
        faded off-face by the mask. Same RBF family face_pipeline uses for its
        texture warp.
        """
        from scipy.interpolate import RBFInterpolator
        rbf = RBFInterpolator(centers, disp, kernel="thin_plate_spline", smoothing=1e-3)
        return rbf(base) * mask

    # ── Stage A: anchored gross-shape fit (known correspondence, no sliding) ──
    disp = (tgt_ctrl - base_ctrl) * float(strength)
    m = np.linalg.norm(disp, axis=1, keepdims=True)
    over = (m > clamp).ravel()
    if over.any():
        disp[over] *= (clamp / m[over])
    current = base + interpolate(base_ctrl, disp)

    # ── Stage B: dense point-to-point ICP refinement (surface detail) ──
    if target_points is not None and len(target_points) > 0:
        target = np.asarray(target_points, dtype=np.float64)
        target = _apply(s, R, t, target)                  # same frame as landmarks
        driven = np.where(mask.ravel() > 0.3)[0]
        for _ in range(max(0, icp_iterations)):
            d2 = _pairwise_sq(current[driven], target)
            nn = d2.argmin(1)
            step = (target[nn] - current[driven]) * 0.5    # damped for stability
            sm = np.linalg.norm(step, axis=1, keepdims=True)
            so = (sm > clamp * 0.5).ravel()
            if so.any():
                step[so] *= (clamp * 0.5 / sm[so])
            current = current + interpolate(current[driven], step)

    return current.astype(np.float32)


def _pairwise_sq(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Squared Euclidean distances, (len(a), len(b))."""
    return ((a[:, None, :] - b[None, :, :]) ** 2).sum(-1)


def _median_nn_spacing(pts: np.ndarray) -> float:
    if pts.shape[0] < 2:
        return 1.0
    d2 = _pairwise_sq(pts, pts)
    np.fill_diagonal(d2, np.inf)
    return float(np.median(np.sqrt(d2.min(1))))


# ── MediaPipe adapter ────────────────────────────────────────────────────────

def landmarks_to_array(landmarks) -> np.ndarray:
    """MediaPipe NormalizedLandmark list → (N,3) array. y is flipped to +up so the
    frame matches the canonical model (image space is y-down)."""
    return np.array([[lm.x, -lm.y, lm.z] for lm in landmarks], dtype=np.float64)
