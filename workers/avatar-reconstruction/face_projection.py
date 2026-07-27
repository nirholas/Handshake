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

Measured on the shipped Wolf3D head, that oval is **10.4% of the head's texels**
(9.4% of its actual surface area). The other ~90% is template texture
personalised by nothing but a global skin tint. Adding more synthesized views to
the warp does not help; the correspondence is missing, not the pixels.

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
# 70-90 degrees from a frontal camera, and they are a large share of the ~90% of
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

# Largest mean fit residual, as a fraction of the head's extent in the photo,
# before the camera is rejected. The head being fitted is a template, not this
# person, so a real fit still leaves millimetres of residual; a residual near a
# fifth of the head means the correspondences are not describing the same object
# and painting through that camera would be worse than not painting.
MAX_FIT_RESIDUAL_FRAC = 0.12

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


class WeakPerspectiveCamera:
    """
    The mapping from a 3D head point to a pixel, and to a depth for occlusion.

    ── Why not a full perspective solve ────────────────────────────────────────
    The obvious approach is `cv2.solvePnP` against the head's landmark vertices.
    Measured on real photos, it does not work here: `landmark_vtx` maps
    MediaPipe's 468 landmarks onto only **262 distinct head vertices**, because
    the template's face is coarser than MediaPipe's landmark density and the
    mapping is nearest-vertex. Hundreds of landmarks therefore share one 3D point
    while sitting at different 2D positions, which is a contradiction no camera
    can satisfy. RANSAC found 25-35% inliers and returned a solution behind the
    camera (negative depth) on half the reference faces, with the sign flipping
    between runs and coordinate conventions. Shipping that would mean projection
    either silently does nothing or paints through a wrong camera, which is worse
    than not painting at all.

    ── What this does instead ──────────────────────────────────────────────────
    MediaPipe reports *3D* landmarks: x and y in image space plus a relative
    depth z. So the alignment is 3D-to-3D, not 2D-to-3D, and Umeyama solves it in
    closed form as a least-squares similarity (uniform scale, rotation,
    translation) with a reflection guard. No RANSAC, no depth-sign ambiguity, no
    iteration that can diverge. It is the same alignment the identity morph
    already relies on, so it is exercised on every job that reaches this stage.

    The result is a weak-perspective (scaled orthographic) camera. That is the
    right model for a selfie anyway: head depth is a few centimetres against a
    camera distance of tens, so perspective foreshortening across the head is
    small, and a model that cannot diverge beats a sharper one that can.
    """

    def __init__(self, scale: float, rotation: np.ndarray, translation: np.ndarray,
                 img_w: int, img_h: int):
        self.s = float(scale)
        self.R = np.asarray(rotation, dtype=np.float64)
        self.t = np.asarray(translation, dtype=np.float64).reshape(3)
        self.img_w = int(img_w)
        self.img_h = int(img_h)

    def project(self, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """World points (N,3) → (pixels (N,2), depth (N,)). Larger depth = further."""
        mapped = (self.s * (self.R @ np.asarray(points, dtype=np.float64).T)).T + self.t
        # `landmarks_to_array` stores y as -row (it flips to +up so the frame
        # matches the canonical face), so the image row is simply its negation.
        # Subtracting from img_h instead double-flips and throws every texel off
        # the bottom of the photo, which reads as "nothing is visible" rather
        # than as an error.
        px = np.stack([mapped[:, 0], -mapped[:, 1]], axis=1)
        # Depth sign is determined empirically, not from MediaPipe's documented z
        # convention: Umeyama's reflection guard forces a proper rotation, which
        # can absorb a sign flip in the correspondence and leave the fitted frame
        # mirrored in z relative to the raw landmarks. The check that settles it
        # is that the face must come out facing the camera; with the opposite
        # sign the face oval measures -0.78 against the view axis, i.e. the
        # pipeline believes the front of the head is pointing away.
        return px, -mapped[:, 2]

    def view_direction(self) -> np.ndarray:
        """
        Unit vector in world space pointing from the surface toward the camera.

        Constant across the head under an orthographic model, which is the point:
        there is no camera centre to be wrong about, only a viewing axis.
        """
        # Paired with the depth sign above: the camera lies toward +z in the
        # fitted frame. Verified by the face oval measuring +0.78 against this
        # axis on the reference set, which is what a face pointing at the lens
        # looks like.
        axis = self.R.T @ np.array([0.0, 0.0, 1.0])
        n = np.linalg.norm(axis)
        return axis / n if n > 0 else np.array([0.0, 0.0, 1.0])


def _dedupe_correspondences(
    landmarks_3d: np.ndarray, vertex_indices: np.ndarray, positions: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """
    Collapse landmarks that share a head vertex into one correspondence each.

    The nearest-vertex map is many-to-one (468 landmarks, 262 vertices on the
    shipped template). Feeding the duplicates in unaveraged weights those
    vertices by how many landmarks happened to land on them, which tilts the fit
    toward the dense parts of the face (eyes, lips) and away from the jaw and
    brow that actually pin the head's orientation.
    """
    order = np.argsort(vertex_indices, kind="stable")
    ordered_idx = vertex_indices[order]
    ordered_pts = landmarks_3d[order]
    uniq, starts = np.unique(ordered_idx, return_index=True)
    sums = np.add.reduceat(ordered_pts, starts, axis=0)
    counts = np.diff(np.append(starts, len(ordered_idx)))[:, None]
    return sums / counts, positions[uniq]


def solve_camera(
    landmarks_3d: np.ndarray,
    vertex_indices: np.ndarray,
    positions: np.ndarray,
    img_w: int,
    img_h: int,
) -> Optional[WeakPerspectiveCamera]:
    """
    Fit the weak-perspective camera that maps this head onto this photo.

    Args:
        landmarks_3d:    (N, 3) MediaPipe landmarks in an isotropic pixel frame
                         (`face_geometry.landmarks_to_array` with the image size).
        vertex_indices:  (N,) head vertex each landmark corresponds to.
        positions:       (V, 3) head vertex positions.

    Returns None when the fit is too poor to trust, so a bad photo degrades to
    warp-only skin rather than to a confidently wrong projection.
    """
    n = min(len(landmarks_3d), len(vertex_indices))
    if n < 16:
        return None

    dst, src = _dedupe_correspondences(
        np.asarray(landmarks_3d[:n], dtype=np.float64),
        np.asarray(vertex_indices[:n], dtype=np.int64),
        np.asarray(positions, dtype=np.float64),
    )
    if len(src) < 16:
        return None

    scale, rotation, translation = _umeyama(src, dst)
    if not np.isfinite(scale) or scale <= 0:
        return None

    # Residual check. The fit is a rigid similarity onto a head that is not
    # exactly this person's, so some residual is expected; a residual comparable
    # to the head itself means the correspondences are garbage.
    fitted = (scale * (rotation @ src.T)).T + translation
    residual = float(np.linalg.norm(fitted - dst, axis=1).mean())
    extent = float(np.linalg.norm(dst.max(axis=0) - dst.min(axis=0)))
    if extent <= 0 or residual / extent > MAX_FIT_RESIDUAL_FRAC:
        log.info("camera fit rejected: residual %.1f px is %.0f%% of head extent",
                 residual, 100.0 * residual / max(extent, 1e-9))
        return None

    return WeakPerspectiveCamera(scale, rotation, translation, img_w, img_h)


def _umeyama(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """
    Least-squares similarity mapping src → dst (Umeyama 1991), with a reflection
    guard so the result is always a proper rotation.

    Duplicated from face_geometry rather than imported: this module is used by
    the coverage harness without the morph's dependencies, and the function is
    twelve lines of closed-form linear algebra pinned by its own test.
    """
    mu_s, mu_d = src.mean(0), dst.mean(0)
    sc, dc = src - mu_s, dst - mu_d
    cov = (dc.T @ sc) / src.shape[0]
    U, D, Vt = np.linalg.svd(cov)
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1.0
    R = U @ S @ Vt
    var_s = (sc ** 2).sum() / src.shape[0]
    s = float((D * np.diag(S)).sum() / var_s) if var_s > 0 else 1.0
    t = mu_d - s * (R @ mu_s)
    return s, R, t


# The UV atlas is fixed template geometry: `uvs` and `faces` never change, and
# neither does which triangle owns a texel or with what barycentric weights. Only
# vertex POSITIONS move (the identity morph). Rasterizing per job therefore
# repeated ~6.4 seconds of identical Python triangle-walking every time, the
# single largest cost in this stage. Solve it once per process and reduce every
# subsequent job to three vectorized gathers.
_UV_RASTER_CACHE: dict = {}


def _uv_barycentric_map(
    uvs: np.ndarray, faces: np.ndarray, tex_w: int, tex_h: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Which triangle owns each texel, and with what barycentric weights.

    Returns (tri_idx, bary, covered): `tri_idx` is (M,) triangle indices for the
    M covered texels, `bary` is (M, 3) weights, and `covered` is the
    (tex_h, tex_w) bool mask. Cached per (mesh, texture size).
    """
    key = (uvs.shape[0], faces.shape[0], tex_w, tex_h,
           float(uvs[:, 0].sum()), float(uvs[:, 1].sum()))
    hit = _UV_RASTER_CACHE.get(key)
    if hit is not None:
        return hit

    tri_map = np.full((tex_h, tex_w), -1, dtype=np.int32)
    bary_map = np.zeros((tex_h, tex_w, 3), dtype=np.float32)

    # NO v-flip. glTF's UV origin is nominally bottom-left, so flipping looks
    # correct in isolation, but this template's atlas and the precomputed
    # `face_uv_map.json` both address it top-left (py = v * height) and the
    # landmark warp composites against that. Flipping here writes the projected
    # texture in mirrored, and makes the face-oval protect mask shield a band
    # that is not the face. The symptom is silent: the avatar still renders, and
    # the only tell is that projected coverage and the oval stop overlapping,
    # which is what the coverage harness measures.
    px = uvs[:, 0] * (tex_w - 1)
    py = uvs[:, 1] * (tex_h - 1)

    for _t, tri in enumerate(faces):
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
        tri_map[ys, xs] = _t
        bary_map[ys, xs, 0] = w0[inside]
        bary_map[ys, xs, 1] = w1[inside]
        bary_map[ys, xs, 2] = w2[inside]

    covered = tri_map >= 0
    out = (tri_map[covered], bary_map[covered], covered)
    _UV_RASTER_CACHE[key] = out
    return out


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
    (tex_h, tex_w, 3) float32 giving the 3D position and normal of the surface at
    each texel, and `covered` is a bool mask of texels the mesh actually uses.

    The expensive half (which triangle owns each texel, with what weights) is
    cached by `_uv_barycentric_map`, so this reduces to interpolating the current
    vertex positions and normals.
    """
    tri_idx, bary, covered = _uv_barycentric_map(uvs, faces, tex_w, tex_h)

    tris = faces[tri_idx]                       # (M, 3) vertex indices
    b = bary[:, :, None]                        # (M, 3, 1)
    pos_map = np.zeros((tex_h, tex_w, 3), dtype=np.float32)
    nrm_map = np.zeros((tex_h, tex_w, 3), dtype=np.float32)
    pos_map[covered] = (positions[tris] * b).sum(axis=1)
    nrm_map[covered] = (normals[tris] * b).sum(axis=1)

    lengths = np.linalg.norm(nrm_map, axis=2, keepdims=True)
    lengths[lengths == 0] = 1.0
    nrm_map /= lengths
    return pos_map, nrm_map, covered


def _render_depth(
    positions: np.ndarray,
    faces: np.ndarray,
    camera: "WeakPerspectiveCamera",
) -> tuple[np.ndarray, float]:
    """
    Z-buffer the head from the camera, so a texel can ask whether it is the
    nearest surface along its own ray or hidden behind another part of the head.

    Returns (depth, scale) where `depth` is a DEPTH_BUFFER_SIZE-square buffer of
    camera depth (np.inf where nothing was drawn) and `scale` maps a photo pixel
    into that buffer.
    """
    px, z = camera.project(positions)
    scale = DEPTH_BUFFER_SIZE / max(camera.img_w, camera.img_h)
    sx = px[:, 0] * scale
    sy = px[:, 1] * scale

    depth = np.full((DEPTH_BUFFER_SIZE, DEPTH_BUFFER_SIZE), np.inf, dtype=np.float32)

    for tri in faces:
        i0, i1, i2 = tri
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

    return depth, scale


def project_photo_to_uv(
    photo_rgb: np.ndarray,
    foreground_mask: Optional[np.ndarray],
    positions: np.ndarray,
    normals: np.ndarray,
    uvs: np.ndarray,
    faces: np.ndarray,
    landmarks_3d: np.ndarray,
    vertex_indices: np.ndarray,
    tex_w: int,
    tex_h: int,
) -> Optional[tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """
    Paint the photo onto the whole visible head in UV space.

    Args:
        photo_rgb:         (H, W, 3) uint8 source photograph.
        foreground_mask:   (H, W) float 0..1 person mask, or None to skip the
                           foreground gate.
        positions/normals: (V, 3) head geometry, post-morph.
        uvs:               (V, 2) TEXCOORD_0.
        faces:             (F, 3) triangle indices.
        landmarks_3d:      (L, 3) MediaPipe landmarks in an isotropic pixel
                           frame (`face_geometry.landmarks_to_array` with size).
        vertex_indices:    (L,) head vertex each landmark corresponds to.

    Returns:
        (rgb_uv, weight_uv, covered), the projected colour in UV space, its
        per-texel confidence in 0..MAX_BLEND, and the mask of texels the head
        mesh actually occupies. `covered` is the honest denominator for any
        coverage figure: the skin atlas is shared with the body, so measuring
        against the full square would flatter the number with texels no head
        vertex touches.

        None when the pose could not be solved.
    """
    img_h, img_w = photo_rgb.shape[:2]

    camera = solve_camera(landmarks_3d, vertex_indices, positions, img_w, img_h)
    if camera is None:
        log.info("projective texturing skipped: camera fit rejected")
        return None

    pos_map, nrm_map, covered = _rasterize_uv(positions, uvs, faces, normals, tex_w, tex_h)
    if not covered.any():
        return None

    flat_pos = pos_map[covered]                       # (M, 3)
    flat_nrm = nrm_map[covered]

    px, depth_of = camera.project(flat_pos)
    u, v = px[:, 0], px[:, 1]

    # ── gate 1: the texel projects inside the photograph ──────────────────────
    in_image = (u >= 0) & (u < img_w - 1) & (v >= 0) & (v < img_h - 1)

    # ── gate 2: the surface faces the camera ─────────────────────────────────
    # Orthographic, so the viewing axis is the same everywhere on the head.
    to_cam = camera.view_direction()
    facing = flat_nrm @ to_cam
    confidence = np.clip(facing, 0.0, 1.0) ** FACING_EXPONENT

    # ── gate 3: nothing nearer along the same ray ────────────────────────────
    depth_buf, dscale = _render_depth(positions, faces, camera)
    extent = float(np.linalg.norm(positions.max(axis=0) - positions.min(axis=0)))
    span = float(np.abs(depth_of).max() - np.abs(depth_of).min()) if len(depth_of) else 0.0
    tol = max(span * DEPTH_TOLERANCE_FRAC, extent * camera.s * 1e-3, 1e-6)

    dx = np.clip((u * dscale).astype(np.int32), 0, DEPTH_BUFFER_SIZE - 1)
    dy = np.clip((v * dscale).astype(np.int32), 0, DEPTH_BUFFER_SIZE - 1)
    nearest = depth_buf[dy, dx]
    visible = np.isfinite(nearest) & (depth_of <= nearest + tol)

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

    return rgb_uv, weight_uv, covered


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
    10.4% face oval carried photographic colour. Reported per job so a regression
    in pose solving shows up as coverage collapsing rather than as a silent
    return to template texture.
    """
    mask = weight > 0.01
    if covered is not None:
        total = int(covered.sum())
        return float(mask.sum()) / total if total else 0.0
    return float(mask.mean())
