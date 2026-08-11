"""
ARKit-52 blendshape transfer for generated avatars.

Takes the ICT-FaceKit template head (MIT-licensed, 53 FACS expression shapes
following Apple ARKit naming; see build_arkit_template.py, which bakes the OBJ
set into a single arkit_template.npz) and transfers its per-vertex expression
deltas onto the head region of an arbitrary rigged humanoid mesh.

Method: similarity-align the template to the target head (translation from
centroid, uniform scale from vertical extent), find nearest template vertex
for each target head vertex, copy that vertex's deltas scaled to target size,
and attenuate by correspondence distance so vertices far from the template
surface (hair, hats, glasses) receive no deformation.

This is deliberately dependency-light (numpy/scipy) and GPU-free so it is unit
testable anywhere; see test_blendshapes.py.
"""

from __future__ import annotations

import logging

import numpy as np
from scipy.spatial import cKDTree

log = logging.getLogger("rig.blendshapes")

# Fraction of head height used as the falloff sigma for delta attenuation.
_FALLOFF_SIGMA_RATIO = 0.08
# Correspondences farther than this many sigmas contribute nothing.
_FALLOFF_CUTOFF_SIGMAS = 3.0


def load_template(path: str) -> dict:
    """Load the baked ARKit template (see build_arkit_template.py).

    Returns {names: [K], verts: (V,3), deltas: (K,V,3)} with verts centered on
    the template head centroid, Y-up, facing +Z."""
    data = np.load(path, allow_pickle=False)
    names = [str(n) for n in data["names"]]
    verts = np.asarray(data["verts"], dtype=np.float32)
    deltas = np.asarray(data["deltas"], dtype=np.float32)
    if deltas.shape[0] != len(names) or deltas.shape[1] != verts.shape[0] or deltas.shape[2] != 3:
        raise RuntimeError(
            f"malformed template: names={len(names)} verts={verts.shape} deltas={deltas.shape}"
        )
    return {"names": names, "verts": verts, "deltas": deltas}


def head_mask_from_weights(weights: np.ndarray, joint_names: list[str],
                           head_bone: str = "mixamorig:Head",
                           min_weight: float = 0.35) -> np.ndarray:
    """Boolean mask of vertices bound to the head: any vertex whose skinning
    weight on the head bone passes the threshold.

    Eye bones count toward the head when the rig has them. MIA's 52-bone set
    does not, so in this worker the mask reduces to mixamorig:Head alone; the
    clause is here because the function also serves rigs that split the eyes
    out (test_blendshapes.py covers that case).

    `weights` is (V,J) aligned to `joint_names`."""
    head_cols = [
        i for i, n in enumerate(joint_names)
        if n == head_bone or ("Head" in n and "HeadTop" not in n) or "Eye" in n
    ]
    if not head_cols:
        raise RuntimeError(f"no head bone found in joint names (looked for {head_bone})")
    w = np.asarray(weights, dtype=np.float32)[:, head_cols].sum(axis=1)
    return w >= min_weight


def transfer_blendshapes(template: dict, target_verts: np.ndarray,
                         head_mask: np.ndarray) -> dict:
    """Transfer template expression deltas onto the target mesh.

    template     from load_template()
    target_verts (V,3) target mesh vertices, same space as the skeleton
    head_mask    (V,) boolean, True where the vertex belongs to the head

    Returns {"names": [K], "deltas": (K,V,3)} with zeros outside the head,
    suitable for rig_glb.build_rigged_glb's blendshape_data argument."""
    target_verts = np.asarray(target_verts, dtype=np.float32)
    head_mask = np.asarray(head_mask, dtype=bool)
    n_verts = target_verts.shape[0]
    names = template["names"]
    out = np.zeros((len(names), n_verts, 3), dtype=np.float32)

    head_pts = target_verts[head_mask]
    if head_pts.shape[0] < 16:
        log.warning("head region too small (%d verts); skipping blendshape transfer",
                    head_pts.shape[0])
        return {"names": names, "deltas": out}

    # Similarity alignment: template is centered and Y-up; move it onto the
    # target head and match vertical extent.
    tpl_verts = template["verts"]
    tpl_height = float(tpl_verts[:, 1].max() - tpl_verts[:, 1].min())
    head_height = float(head_pts[:, 1].max() - head_pts[:, 1].min())
    if tpl_height <= 0 or head_height <= 0:
        raise RuntimeError("degenerate head or template extent")
    scale = head_height / tpl_height
    offset = head_pts.mean(axis=0) - tpl_verts.mean(axis=0) * scale
    aligned = tpl_verts * scale + offset

    kdt = cKDTree(aligned)
    dist, nearest = kdt.query(head_pts, k=1)
    nearest = np.asarray(nearest).reshape(-1)

    # Distance falloff: a head vertex sitting on the template surface keeps the
    # full delta; hair/accessory vertices far from any facial surface fade out.
    sigma = max(head_height * _FALLOFF_SIGMA_RATIO, 1e-6)
    fall = np.exp(-(dist / sigma) ** 2).astype(np.float32)
    fall[dist > _FALLOFF_CUTOFF_SIGMAS * sigma] = 0.0

    # Deltas scale with the head, and attenuate per correspondence quality.
    head_idx = np.flatnonzero(head_mask)
    tpl_deltas = template["deltas"][:, nearest, :] * scale        # (K,H,3)
    out[:, head_idx, :] = tpl_deltas * fall[None, :, None]

    active = int((np.abs(out).max(axis=(0, 2)) > 1e-7).sum())
    log.info("blendshape transfer: %d/%d head verts active, scale=%.3f sigma=%.4f",
             active, head_pts.shape[0], scale, sigma)
    return {"names": names, "deltas": out}
