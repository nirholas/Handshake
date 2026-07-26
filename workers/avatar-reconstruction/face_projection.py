"""
Projective texturing: paint the photograph onto the parts of the head the
landmark warp cannot reach.

── The gap this closes ────────────────────────────────────────────────────────
Phase 1 (`_warp_face_to_uv`) maps the selfie into UV space through a thin-plate
spline fitted to MediaPipe's 468 landmarks, then composites it inside the
face-oval polygon. That is the right tool for the face, and the wrong tool for
everything else, because the landmarks *are* the face: MediaPipe has no points
on the ears, the scalp, the neck or under the jaw, so there is no correspondence
to warp with out there and the mask has to stop at the oval.

Measured on the Wolf3D head, that oval is only **19.2%** of the head's UV
surface. The other 80.8% is template texture personalised by nothing but a
global skin tint. Adding more synthesized views to the warp does not help; the
correspondence is missing, not the pixels.

── Why projection works where warping does not ────────────────────────────────
After the geometry morph we know the head's actual 3D shape. That turns the
problem from "find matching points" into "find where each surface point lands in
the photo", which needs no landmarks at all:

  1. Solve the camera pose that maps the head's 3D landmark vertices onto their
     detected 2D positions (PnP). This is the only place landmarks are used, and
     they are used to locate the *camera*, not to establish surface
     correspondence.
  2. Rasterize the head in UV space, so every texel knows its 3D position and
     surface normal.
  3. Project each texel's 3D position through that camera into the photo and
     sample it.

Ears, jawline and neck fall out of step 3 for free, because they are part of the
mesh even though no landmark describes them.

── Being honest about what the camera actually saw ────────────────────────────
Projection will happily paint the back of the head with whatever pixel happens
to lie behind it. Three tests gate every texel, and a texel that fails any of
them keeps its existing colour rather than inventing one:

  • **Facing.** Surfaces angled away from the camera are sampled at grazing
    incidence where a single pixel smears across centimetres of surface. The
    confidence weight is cos(angle) raised to a power, so it falls off long
    before the silhouette.
  • **Occlusion.** A depth buffer rendered from the camera catches the nose
    shadowing the cheek and the jaw shadowing the neck. Without it the far side
    of an occluder receives the occluder's own pixels.
  • **Foreground.** The rembg alpha rejects background pixels, so a texel that
    projects just off the silhouette does not pick up the wall behind the
    person.

The result is blended under the existing face-oval composite, which stays
authoritative where it applies: it is landmark-accurate there, while projection
is only as accurate as the pose solve.
"""

from __future__ import annotations

import logging
from typing import Optional

import cv2
import numpy as np

log = logging.getLogger("face_projection")

# Confidence falls off as cos(view angle) ** FACING_EXPONENT.
#
# Tuned against what this is for. A steeper curve (exponent 3, cutoff 0.15)
# stops painting at 58 degrees from the camera, which measured at 26% of the
# visible hemisphere and, on a head, rejects the ears outright: they sit near
# 70-90 degrees from a frontal camera, and they are a large share of the 81% of
# the head the face-oval warp cannot reach. Refusing them would leave the
# headline gap unclosed while looking like it had been addressed.
#
# 1.5 with a 0.06 floor still discounts grazing samples heavily (an ear at 70
# degrees contributes ~0.2, a cheek at 20 degrees ~0.9) but lets them through as
# a light wash over the template instead of dropping them. Combined with
# MAX_BLEND, a grazing texel can move at most ~17% of the way to the photo.
FACING_EXPONENT = 1.5

# Texels whose confidence lands below this keep the template: past ~81 degrees a
# single pixel smears across too much surface to carry identity.
MIN_CONFIDENCE = 0.06

# Ceiling on how far projection may pull a texel toward the photo. Held under 1
# so the template's baked shading still carries the surface, and a pose solve
# that is slightly off degrades to a tint rather than to a visibly wrong image.
MAX_BLEND = 0.85

# Depth tolerance for the occlusion test, as a fraction of the head's bounding
# radius. Loose enough to absorb rasterization error on a 2k-triangle mesh,
# tight enough to still reject a surface hidden behind the nose or jaw.
DEPTH_TOLERANCE_FRAC = 0.06

# Resolution of the camera-space depth buffer. Independent of the photo size:
# what matters is that it resolves the head, and the head fills a fraction of a
# selfie. 512 is ample for a 2162-vertex mesh and keeps the render cheap.
DEPTH_BUFFER_SIZE = 512


def _sample_bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """
    Bilinearly sample `img` at float coordinates, returning (N, C) or (N, 1).

    Done by hand rather than with `cv2.remap`, which asserts every map dimension
    is below SHRT_MAX. The sample list here is one entry per covered texel, which
    passes 32767 on any real head at 1024 square, so remap rejects it outright
    whatever shape the list is folded into.
    """
    h, w = img.shape[:2]
    src = img.astype(np.float32)
    if src.ndim == 2:
        src = src[:, :, None]

    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    x0 = np.clip(x0, 0, w - 1)
    y0 = np.clip(y0, 0, h - 1)

    fx = (x - x0).astype(np.float32)[:, None]
    fy = (y - y0).astype(np.float32)[:, None]

    top = src[y0, x0] * (1 - fx) + src[y0, x1] * fx
    bot = src[y1, x0] * (1 - fx) + src[y1, x1] * fx
    return top * (1 - fy) + bot * fy


def solve_camera_pose(
    landmarks_2d: np.ndarray,
    landmark_vertices: np.ndarray,
    img_w: int,
    img_h: int,
) -> Optional[tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """
    Recover the camera that photographed this head.

    Args:
        landmarks_2d:      (N, 2) detected landmark positions in image pixels.
        landmark_vertices: (N, 3) the head vertices those landmarks correspond to.
        img_w, img_h:      photo dimensions.

    Returns:
        (rvec, tvec, K) or None when the solve does not converge.

    The focal length is unknown for an arbitrary upload, so it is assumed equal
    to the image width, a standard stand-in for a phone camera's ~60 degree
    field of view. An error here scales the recovered depth rather than bending
    the mapping, and the facing/occlusion gates below absorb the residual.
    """
    if len(landmarks_2d) < 6:
        return None

    focal = float(img_w)
    K = np.array(
        [[focal, 0.0, img_w / 2.0], [0.0, focal, img_h / 2.0], [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )

    obj = np.ascontiguousarray(landmark_vertices, dtype=np.float64)
    img = np.ascontiguousarray(landmarks_2d, dtype=np.float64)

    # RANSAC: a handful of landmarks sit on the eyelids and lips, which move with
    # expression and would otherwise drag the whole pose. Let the solver discard
    # them rather than averaging them in.
    try:
        ok, rvec, tvec, inliers = cv2.solvePnPRansac(
            obj,
            img,
            K,
            None,
            flags=cv2.SOLVEPNP_EPNP,
            reprojectionError=8.0,
            iterationsCount=200,
            confidence=0.99,
        )
    except cv2.error as exc:
        log.warning("solvePnPRansac failed: %s", exc)
        return None

    if not ok or inliers is None or len(inliers) < 6:
        return None

    # Refine on the inlier set only.
    idx = inliers.ravel()
    try:
        ok, rvec, tvec = cv2.solvePnP(
            obj[idx], img[idx], K, None, rvec=rvec, tvec=tvec,
            useExtrinsicGuess=True, flags=cv2.SOLVEPNP_ITERATIVE,
        )
    except cv2.error:
        pass  # keep the RANSAC estimate

    if tvec[2] <= 0:
        # Head behind the camera: a degenerate solve, not a usable pose.
        return None

    return rvec, tvec, K


def _rasterize_uv(
    positions: np.ndarray,
    uvs: np.ndarray,
    faces: np.ndarray,
    normals: np.ndarray,
    tex_w: int,
    tex_h: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Rasterize the mesh into UV space.

    Returns (pos_map, nrm_map, covered) where pos_map/nrm_map are
    (tex_h, tex_w, 3) float32 giving the 3D position and normal of the surface
    at each texel, and `covered` is a bool mask of texels the mesh actually uses.

    Walks triangles rather than texels: the head occupies a small fraction of a
    1024² atlas, so scanning every texel against every triangle would be mostly
    wasted work.
    """
    pos_map = np.zeros((tex_h, tex_w, 3), dtype=np.float32)
    nrm_map = np.zeros((tex_h, tex_w, 3), dtype=np.float32)
    covered = np.zeros((tex_h, tex_w), dtype=bool)

    # UV origin is bottom-left in glTF and top-left in an image.
    px = uvs[:, 0] * (tex_w - 1)
    py = (1.0 - uvs[:, 1]) * (tex_h - 1)

    for tri in faces:
        i0, i1, i2 = tri
        x0, y0 = px[i0], py[i0]
        x1, y1 = px[i1], py[i1]
        x2, y2 = px[i2], py[i2]

        min_x = max(0, int(np.floor(min(x0, x1, x2))))
        max_x = min(tex_w - 1, int(np.ceil(max(x0, x1, x2))))
        min_y = max(0, int(np.floor(min(y0, y1, y2))))
        max_y = min(tex_h - 1, int(np.ceil(max(y0, y1, y2))))
        if min_x > max_x or min_y > max_y:
            continue

        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-12:
            continue  # degenerate triangle in UV space

        gy, gx = np.mgrid[min_y:max_y + 1, min_x:max_x + 1]
        gxf = gx.astype(np.float32)
        gyf = gy.astype(np.float32)

        w0 = ((y1 - y2) * (gxf - x2) + (x2 - x1) * (gyf - y2)) / denom
        w1 = ((y2 - y0) * (gxf - x2) + (x0 - x2) * (gyf - y2)) / denom
        w2 = 1.0 - w0 - w1

        # A small negative tolerance closes the hairline cracks between adjacent
        # triangles that exact barycentric tests leave behind.
        inside = (w0 >= -1e-4) & (w1 >= -1e-4) & (w2 >= -1e-4)
        if not inside.any():
            continue

        ys, xs = gy[inside], gx[inside]
        b0, b1, b2 = w0[inside][:, None], w1[inside][:, None], w2[inside][:, None]

        pos_map[ys, xs] = b0 * positions[i0] + b1 * positions[i1] + b2 * positions[i2]
        nrm_map[ys, xs] = b0 * normals[i0] + b1 * normals[i1] + b2 * normals[i2]
        covered[ys, xs] = True

    lengths = np.linalg.norm(nrm_map, axis=2, keepdims=True)
    lengths[lengths == 0] = 1.0
    nrm_map /= lengths
    return pos_map, nrm_map, covered


def _render_depth(
    positions: np.ndarray,
    faces: np.ndarray,
    rvec: np.ndarray,
    tvec: np.ndarray,
    K: np.ndarray,
    img_w: int,
    img_h: int,
) -> tuple[np.ndarray, float, float]:
    """
    Z-buffer the head from the camera, so a texel can ask whether it is the
    nearest surface along its own ray or hidden behind another part of the head.

    Returns (depth, scale, offset) where `depth` is a DEPTH_BUFFER_SIZE-square
    buffer of camera-space Z (np.inf where nothing was drawn), and scale/offset
    map a full-resolution image pixel into that buffer.
    """
    R, _ = cv2.Rodrigues(rvec)
    cam = (positions @ R.T) + tvec.reshape(1, 3)  # camera space

    scale = DEPTH_BUFFER_SIZE / max(img_w, img_h)
    proj = (cam @ K.T)
    z = cam[:, 2]
    safe_z = np.where(np.abs(z) < 1e-9, 1e-9, z)
    sx = proj[:, 0] / safe_z * scale
    sy = proj[:, 1] / safe_z * scale

    depth = np.full((DEPTH_BUFFER_SIZE, DEPTH_BUFFER_SIZE), np.inf, dtype=np.float32)

    for tri in faces:
        i0, i1, i2 = tri
        if z[i0] <= 0 or z[i1] <= 0 or z[i2] <= 0:
            continue  # behind the camera
        x0, y0 = sx[i0], sy[i0]
        x1, y1 = sx[i1], sy[i1]
        x2, y2 = sx[i2], sy[i2]

        min_x = max(0, int(np.floor(min(x0, x1, x2))))
        max_x = min(DEPTH_BUFFER_SIZE - 1, int(np.ceil(max(x0, x1, x2))))
        min_y = max(0, int(np.floor(min(y0, y1, y2))))
        max_y = min(DEPTH_BUFFER_SIZE - 1, int(np.ceil(max(y0, y1, y2))))
        if min_x > max_x or min_y > max_y:
            continue

        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-12:
            continue

        gy, gx = np.mgrid[min_y:max_y + 1, min_x:max_x + 1]
        gxf = gx.astype(np.float32)
        gyf = gy.astype(np.float32)
        w0 = ((y1 - y2) * (gxf - x2) + (x2 - x1) * (gyf - y2)) / denom
        w1 = ((y2 - y0) * (gxf - x2) + (x0 - x2) * (gyf - y2)) / denom
        w2 = 1.0 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue

        tri_z = w0 * z[i0] + w1 * z[i1] + w2 * z[i2]
        ys, xs = gy[inside], gx[inside]
        zs = tri_z[inside]
        nearer = zs < depth[ys, xs]
        depth[ys[nearer], xs[nearer]] = zs[nearer]

    return depth, scale, 0.0


def project_photo_to_uv(
    photo_rgb: np.ndarray,
    foreground_mask: Optional[np.ndarray],
    positions: np.ndarray,
    normals: np.ndarray,
    uvs: np.ndarray,
    faces: np.ndarray,
    landmarks_2d: np.ndarray,
    landmark_vertices: np.ndarray,
    tex_w: int,
    tex_h: int,
) -> Optional[tuple[np.ndarray, np.ndarray]]:
    """
    Paint the photo onto the whole visible head in UV space.

    Args:
        photo_rgb:         (H, W, 3) uint8 source photograph.
        foreground_mask:   (H, W) float 0..1 person mask, or None to skip the
                           foreground gate.
        positions/normals: (V, 3) head geometry, post-morph.
        uvs:               (V, 2) TEXCOORD_0.
        faces:             (F, 3) triangle indices.
        landmarks_2d:      (L, 2) detected landmarks in image pixels.
        landmark_vertices: (L, 3) head vertices those landmarks map to.

    Returns:
        (rgb_uv, weight_uv), the projected colour in UV space and its per-texel
        confidence in 0..MAX_BLEND, or None when the pose could not be solved.
    """
    img_h, img_w = photo_rgb.shape[:2]

    pose = solve_camera_pose(landmarks_2d, landmark_vertices, img_w, img_h)
    if pose is None:
        log.info("projective texturing skipped: camera pose did not solve")
        return None
    rvec, tvec, K = pose

    pos_map, nrm_map, covered = _rasterize_uv(positions, uvs, faces, normals, tex_w, tex_h)
    if not covered.any():
        return None

    R, _ = cv2.Rodrigues(rvec)
    flat_pos = pos_map[covered]                       # (M, 3)
    flat_nrm = nrm_map[covered]

    cam_pos = (flat_pos @ R.T) + tvec.reshape(1, 3)   # camera space
    z = cam_pos[:, 2]
    in_front = z > 1e-6

    proj = cam_pos @ K.T
    safe_z = np.where(np.abs(z) < 1e-9, 1e-9, z)
    u = proj[:, 0] / safe_z
    v = proj[:, 1] / safe_z

    # ── gate 1: the texel projects inside the photograph ──────────────────────
    in_image = (u >= 0) & (u < img_w - 1) & (v >= 0) & (v < img_h - 1) & in_front

    # ── gate 2: the surface faces the camera ─────────────────────────────────
    # View ray from surface to camera centre, both expressed in world space.
    cam_centre = (-R.T @ tvec).reshape(3)
    to_cam = cam_centre[None, :] - flat_pos
    to_cam /= np.maximum(np.linalg.norm(to_cam, axis=1, keepdims=True), 1e-9)
    facing = np.einsum("ij,ij->i", flat_nrm, to_cam)
    confidence = np.clip(facing, 0.0, 1.0) ** FACING_EXPONENT

    # ── gate 3: nothing nearer along the same ray ────────────────────────────
    depth, scale, _ = _render_depth(positions, faces, rvec, tvec, K, img_w, img_h)
    radius = float(np.linalg.norm(positions - positions.mean(axis=0), axis=1).max())
    tol = max(radius * DEPTH_TOLERANCE_FRAC, 1e-6)

    dx = np.clip((u * scale).astype(np.int32), 0, DEPTH_BUFFER_SIZE - 1)
    dy = np.clip((v * scale).astype(np.int32), 0, DEPTH_BUFFER_SIZE - 1)
    nearest = depth[dy, dx]
    visible = np.isfinite(nearest) & (z <= nearest + tol)

    keep = in_image & visible & (confidence > 0)
    confidence = np.where(keep, confidence, 0.0)

    # ── sample the photograph ────────────────────────────────────────────────
    map_x = np.clip(u, 0, img_w - 1)
    map_y = np.clip(v, 0, img_h - 1)
    sampled = _sample_bilinear(photo_rgb, map_x, map_y)

    # ── gate 4: the sampled pixel is the person, not the background ──────────
    if foreground_mask is not None:
        fg = _sample_bilinear(foreground_mask.astype(np.float32), map_x, map_y).reshape(-1)
        confidence *= np.clip(fg, 0.0, 1.0)

    confidence = np.where(confidence < MIN_CONFIDENCE, 0.0, confidence) * MAX_BLEND

    rgb_uv = np.zeros((tex_h, tex_w, 3), dtype=np.float32)
    weight_uv = np.zeros((tex_h, tex_w), dtype=np.float32)
    rgb_uv[covered] = sampled.astype(np.float32)
    weight_uv[covered] = confidence

    # Feather the weight so the boundary between projected and template texture
    # is a gradient rather than an edge the eye can find.
    k = max(3, int(tex_w * 0.012)) | 1
    weight_uv = cv2.GaussianBlur(weight_uv, (k, k), 0)
    # Blur bleeds weight onto texels that were never sampled; clear them, or the
    # template gets blended toward whatever black pixel sits in rgb_uv there.
    weight_uv[~covered] = 0.0

    return rgb_uv, weight_uv


def blend_projection(
    base_rgb: np.ndarray,
    projected_rgb: np.ndarray,
    weight: np.ndarray,
    protect: Optional[np.ndarray] = None,
) -> np.ndarray:
    """
    Blend projected colour over the base texture.

    `protect` (0..1) holds regions the projection must not overwrite. The
    face-oval composite goes here: inside the oval, Phase 1's landmark-driven
    warp is strictly more accurate than a projection through an estimated pose,
    so it stays authoritative and projection only fills what it could not reach.
    """
    w = np.clip(weight, 0.0, 1.0)
    if protect is not None:
        w = w * np.clip(1.0 - protect, 0.0, 1.0)
    w3 = w[..., None]
    out = base_rgb.astype(np.float32) * (1.0 - w3) + projected_rgb.astype(np.float32) * w3
    return np.clip(out, 0, 255).astype(np.uint8)


def coverage_fraction(weight: np.ndarray, covered: Optional[np.ndarray] = None) -> float:
    """
    Fraction of the head's UV surface this projection actually personalises.

    The headline number for the whole exercise: before projection, only the
    ~19% face oval carried photographic colour. Reported per job so a regression
    in pose solving shows up as coverage collapsing rather than as a silent
    return to template texture.
    """
    mask = weight > 0.01
    if covered is not None:
        total = int(covered.sum())
        return float(mask.sum()) / total if total else 0.0
    return float(mask.mean())
