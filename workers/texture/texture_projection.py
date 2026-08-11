"""
Geometry for the full-retexture path: the camera each canonical view is rendered
through, and the back-projection of those rendered views onto the mesh's UV
atlas.

Split out of main.py on purpose. This is the part of the lane that decides where
a generated pixel lands on the surface, it is pure numpy, and keeping it free of
torch, diffusers and pyrender is what lets test_texture_projection.py exercise it
on CPU with no GPU and no model weights. Same split as
workers/avatar-reconstruction/face_projection.py, whose gates (in frame, facing
the camera, nothing nearer along the ray) this mirrors.

Conventions, both load-bearing:

  * Camera. OpenGL/pyrender style: the camera looks down its own -Z, so the pose
    matrix carries (right, up, -forward) in its rotation columns. `project`
    returns pixel coordinates in the rendered view plus a positive depth measured
    along the view axis, which is the same quantity pyrender's offscreen renderer
    writes into its depth buffer, so the two can be compared directly for the
    occlusion test.

  * UV. trimesh flips V on glTF import and flips it back on export, so inside
    trimesh (and therefore here) V points up and the atlas row for a texel is
    (1 - v) * (size - 1). Getting this backwards writes the texture in
    upside down, which still renders and so fails silently.
"""

from __future__ import annotations

import math
from typing import Optional, Sequence

import numpy as np

# Confidence falls off as cos(angle between the surface normal and the direction
# to the camera) ** FACING_EXPONENT. A view that sees a texel head on should win
# decisively over one that catches it at a glancing angle, because the glancing
# view spreads a handful of its pixels across a wide strip of surface and
# back-projecting it smears that strip. Squaring is enough for that: at 45
# degrees a view still contributes half the weight of a face-on one, so the
# blend across a curved surface stays smooth rather than switching hard between
# viewpoints.
FACING_EXPONENT = 2.0

# Past ~83 degrees a source pixel covers so much surface that its colour says
# more about the neighbouring geometry than about the texel it would be written
# to. Those samples are dropped rather than down-weighted.
MIN_FACING = 0.12

# Floor on the depth-test slack, as a fraction of the mesh's bounding radius.
# Absorbs the quantisation between a texel's analytic depth and the binned
# z-buffer it is tested against, while staying far tighter than the gap between
# an arm and the torso behind it. Tilted surfaces get more than this floor, see
# the slope-scaled bias in project_views_to_uv.
DEPTH_TOLERANCE_FRAC = 0.01

_WORLD_UP = np.array([0.0, 1.0, 0.0])
_WORLD_UP_FALLBACK = np.array([0.0, 0.0, 1.0])


def _normalize(vec: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vec))
    return vec / norm if norm > 1e-12 else vec


class OrthographicView:
    """One canonical viewpoint: how it is rendered, and how to invert it.

    Orthographic rather than perspective because the depth conditioning and the
    back-projection then share one linear map with no foreshortening term, and
    because a texture view wants uniform scale across the surface anyway: a
    perspective view would generate more texture detail for the near side of the
    mesh than the far side and bake that inconsistency into the atlas.
    """

    def __init__(
        self,
        center: Sequence[float],
        radius: float,
        azimuth_deg: float,
        elevation_deg: float,
        size: int,
    ) -> None:
        self.center = np.asarray(center, dtype=np.float64).reshape(3)
        self.radius = max(float(radius), 1e-6)
        self.azimuth_deg = float(azimuth_deg)
        self.elevation_deg = float(elevation_deg)
        self.size = int(size)

        az = math.radians(azimuth_deg)
        el = math.radians(elevation_deg)
        direction = np.array([
            math.cos(el) * math.sin(az),
            math.sin(el),
            math.cos(el) * math.cos(az),
        ])

        self.distance = self.radius * 2.5
        self.eye = self.center + direction * self.distance

        forward = _normalize(self.center - self.eye)
        world_up = _WORLD_UP if abs(float(forward @ _WORLD_UP)) < 0.999 else _WORLD_UP_FALLBACK
        right = _normalize(np.cross(forward, world_up))
        up = np.cross(right, forward)

        self.forward = forward
        self.right = right
        self.up = up

        # The mesh spans `radius` about its centre, so 1.5x that as the half
        # extent leaves the silhouette a comfortable margin inside the frame.
        self.xmag = self.distance * 0.6
        self.ymag = self.distance * 0.6

        # Derived from the mesh instead of left at pyrender's 0.05/100 defaults:
        # a mesh authored in centimetres pushes the camera past a fixed far plane
        # and the whole render comes back empty, which reads downstream as "the
        # model produced nothing" rather than as a clipping bug.
        self.znear = max(self.distance - self.radius * 1.05, 1e-4)
        self.zfar = self.distance + self.radius * 1.05

    def pose_matrix(self) -> np.ndarray:
        """4x4 camera-to-world pose in the convention pyrender expects."""
        pose = np.eye(4)
        pose[:3, 0] = self.right
        pose[:3, 1] = self.up
        pose[:3, 2] = -self.forward
        pose[:3, 3] = self.eye
        return pose

    def view_direction(self) -> np.ndarray:
        """Unit vector from a point on the surface toward the camera."""
        return -self.forward

    def project(self, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """World points (N, 3) to (pixels (N, 2), depth (N,)).

        Pixels are (x, y) in the rendered image with y increasing downward.
        Depth is the distance along the view axis, positive in front of the
        camera and directly comparable with a rendered depth buffer.
        """
        rel = np.asarray(points, dtype=np.float64).reshape(-1, 3) - self.eye
        cam_x = rel @ self.right
        cam_y = rel @ self.up
        depth = rel @ self.forward

        half = (self.size - 1) * 0.5
        px = (cam_x / self.xmag + 1.0) * half
        py = (1.0 - cam_y / self.ymag) * half
        return np.stack([px, py], axis=1), depth


def canonical_views(
    center: Sequence[float],
    radius: float,
    viewpoints: Sequence[tuple[float, float]],
    size: int,
) -> list[OrthographicView]:
    return [OrthographicView(center, radius, az, el, size) for az, el in viewpoints]


def depth_to_control_image(depth: np.ndarray) -> np.ndarray:
    """A rendered depth buffer to the 3-channel uint8 map ControlNet expects.

    Near is bright, far is dark, and anything the camera did not hit is black.
    That polarity is not cosmetic: the SDXL depth ControlNet is trained on
    MiDaS-style inverse depth, so handing it the raw near-is-dark buffer inverts
    the conditioning and the model reads the silhouette as a hole in the scene.
    """
    depth = np.asarray(depth, dtype=np.float32)
    hit = depth > 0
    out = np.zeros(depth.shape, dtype=np.float32)
    if hit.any():
        near = float(depth[hit].min())
        far = float(depth[hit].max())
        out[hit] = 1.0 - (depth[hit] - near) / (far - near + 1e-9)
    u8 = (out * 255.0).clip(0, 255).astype(np.uint8)
    return np.stack([u8] * 3, axis=-1)


def sample_bilinear(image: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Bilinearly sample `image` (H, W, C) at float coordinates, returning (N, C)."""
    src = np.asarray(image, dtype=np.float32)
    if src.ndim == 2:
        src = src[:, :, None]
    h, w = src.shape[:2]

    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fx = (x - x0).astype(np.float32)[:, None]
    fy = (y - y0).astype(np.float32)[:, None]
    x0 = np.clip(x0, 0, w - 1)
    y0 = np.clip(y0, 0, h - 1)

    top = src[y0, x0] * (1 - fx) + src[y0, x1] * fx
    bot = src[y1, x0] * (1 - fx) + src[y1, x1] * fx
    return top * (1 - fy) + bot * fy


def uv_barycentric_map(
    uv: np.ndarray, faces: np.ndarray, size: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Which triangle owns each atlas texel, and with what barycentric weights.

    Returns (tri_idx (M,), bary (M, 3), covered (size, size) bool). Walking the
    triangles in python costs one pass per job; the alternative, scattering only
    the three vertex texels of each face, leaves every triangle interior empty
    and hands the gap fill a job it cannot do honestly.
    """
    uv = np.asarray(uv, dtype=np.float64)
    faces = np.asarray(faces, dtype=np.int64)

    tri_map = np.full((size, size), -1, dtype=np.int32)
    bary_map = np.zeros((size, size, 3), dtype=np.float32)

    px = uv[:, 0] * (size - 1)
    py = (1.0 - uv[:, 1]) * (size - 1)

    for t, tri in enumerate(faces):
        i0, i1, i2 = tri
        x0, y0 = px[i0], py[i0]
        x1, y1 = px[i1], py[i1]
        x2, y2 = px[i2], py[i2]

        min_x = max(0, int(math.floor(min(x0, x1, x2))))
        max_x = min(size - 1, int(math.ceil(max(x0, x1, x2))))
        min_y = max(0, int(math.floor(min(y0, y1, y2))))
        max_y = min(size - 1, int(math.ceil(max(y0, y1, y2))))
        if min_x > max_x or min_y > max_y:
            continue

        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-12:
            continue  # degenerate in UV space, it owns no texel

        gy, gx = np.mgrid[min_y:max_y + 1, min_x:max_x + 1]
        gxf = gx.astype(np.float64)
        gyf = gy.astype(np.float64)
        w0 = ((y1 - y2) * (gxf - x2) + (x2 - x1) * (gyf - y2)) / denom
        w1 = ((y2 - y0) * (gxf - x2) + (x0 - x2) * (gyf - y2)) / denom
        w2 = 1.0 - w0 - w1

        # A small negative tolerance closes the hairline cracks an exact
        # barycentric test leaves between adjacent triangles.
        inside = (w0 >= -1e-4) & (w1 >= -1e-4) & (w2 >= -1e-4)
        if not inside.any():
            continue

        ys, xs = gy[inside], gx[inside]
        tri_map[ys, xs] = t
        bary_map[ys, xs, 0] = w0[inside]
        bary_map[ys, xs, 1] = w1[inside]
        bary_map[ys, xs, 2] = w2[inside]

    covered = tri_map >= 0
    return tri_map[covered], bary_map[covered], covered


def rasterize_uv(
    positions: np.ndarray,
    normals: np.ndarray,
    uv: np.ndarray,
    faces: np.ndarray,
    size: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The 3D position and normal of the surface at every covered atlas texel."""
    tri_idx, bary, covered = uv_barycentric_map(uv, faces, size)
    tris = np.asarray(faces, dtype=np.int64)[tri_idx]
    weights = bary[:, :, None]

    pos_map = np.zeros((size, size, 3), dtype=np.float32)
    nrm_map = np.zeros((size, size, 3), dtype=np.float32)
    pos_map[covered] = (np.asarray(positions, dtype=np.float32)[tris] * weights).sum(axis=1)
    nrm_map[covered] = (np.asarray(normals, dtype=np.float32)[tris] * weights).sum(axis=1)

    lengths = np.linalg.norm(nrm_map, axis=2, keepdims=True)
    lengths[lengths == 0] = 1.0
    nrm_map /= lengths
    return pos_map, nrm_map, covered


def occlusion_buffer_size(view_size: int) -> int:
    """Resolution of the occlusion z-buffer for a view of `view_size` pixels.

    Deliberately coarser than the view. The occluders are surface samples taken
    at atlas texel density, and where the atlas is sparser than the view (any UV
    island scaled down relative to its screen area) one sample per pixel leaves
    the buffer full of holes: two surfaces then interleave into alternating
    pixels and neither ever sees the other. Binning several samples together is
    what lets the near surface win. The cost is precision at depth
    discontinuities, which the slope-scaled bias and the gap fill absorb.
    """
    return max(32, min(512, int(view_size) // 2))


def view_depth_buffer(
    view: OrthographicView, points: np.ndarray, resolution: Optional[int] = None
) -> np.ndarray:
    """Nearest surface depth per buffer bin, z-buffered from `points`.

    Built here rather than read back from the render for one specific reason:
    pyrender converts its depth buffer with the perspective un-projection
    formula whatever camera drew it, so for an orthographic camera the numbers
    it returns are a nonlinear remap of the real depth. Comparing an analytic
    depth against them rejects almost every texel, and the symptom is not a
    wrong texture but a job that fails with "no view could see the surface".

    The occluders are the same rasterized surface samples being tested, so a
    sample is always its own nearest hit and the comparison degenerates to
    "is anything else in front of me". `inf` means no sample landed on that
    pixel, which is read as nothing occluding.
    """
    size = int(resolution or view.size)
    pixels, depth = view.project(points)
    u, v = pixels[:, 0], pixels[:, 1]
    scale = size / float(view.size)
    x = np.rint(u * scale).astype(np.int64)
    y = np.rint(v * scale).astype(np.int64)
    inside = (x >= 0) & (x < size) & (y >= 0) & (y < size) & (depth > 0)

    buffer = np.full(size * size, np.inf, dtype=np.float32)
    if inside.any():
        np.minimum.at(buffer, y[inside] * size + x[inside], depth[inside].astype(np.float32))
    buffer = buffer.reshape(size, size)

    # Spread each hit into its neighbouring bins. Sample density is uneven (a UV
    # island scaled down relative to its screen area contributes fewer samples
    # than it covers bins), so an occluder can miss a bin the surface behind it
    # does hit, and that one row of holes is enough to let a hidden strip take
    # colour from a view that cannot see it. Dilating makes the test err toward
    # refusing a texel near an occluder's edge, which the gap fill then paints
    # from its neighbours.
    from scipy.ndimage import minimum_filter

    return minimum_filter(buffer, size=3, mode="nearest")


def fill_gaps(canvas: np.ndarray, filled: np.ndarray) -> np.ndarray:
    """Flood every unwritten texel with its nearest written neighbour.

    Two jobs at once: texels no view could see (a cavity, a fold) get a plausible
    neighbouring colour instead of black, and the padding around each UV island
    stops the renderer's bilinear filter from pulling black in at island edges,
    which shows up as dark seams on the model.
    """
    gap = ~filled
    if not gap.any() or not filled.any():
        return canvas
    from scipy.ndimage import distance_transform_edt

    _, indices = distance_transform_edt(gap, return_indices=True)
    canvas[gap] = canvas[tuple(indices[:, gap])]
    return canvas


def project_views_to_uv(
    positions: np.ndarray,
    normals: np.ndarray,
    uv: np.ndarray,
    faces: np.ndarray,
    views: Sequence[OrthographicView],
    images: Sequence[np.ndarray],
    texture_size: int,
    occlude: bool = True,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Back-project the generated views onto the UV atlas.

    Each texel is rasterized to a 3D surface point, that point is projected into
    every view, and the views that can legitimately see it (inside the frame,
    facing the camera, nothing nearer along the ray) are averaged with weight
    cos(angle) ** FACING_EXPONENT.

    `occlude` builds a z-buffer per view (see view_depth_buffer) so a texel on a
    surface hidden behind another part of the mesh takes no colour from the view
    that cannot actually see it. Turning it off is only correct for a convex
    mesh, where nothing can hide anything.

    Returns (atlas uint8 (S, S, 3), weight float32 (S, S), covered bool (S, S)).
    """
    if len(views) != len(images):
        raise ValueError("views and images must be the same length")

    pos_map, nrm_map, covered = rasterize_uv(positions, normals, uv, faces, texture_size)
    if not covered.any():
        raise ValueError("the mesh occupies no texels in UV space")

    flat_pos = pos_map[covered]
    flat_nrm = nrm_map[covered]
    accum = np.zeros((flat_pos.shape[0], 3), dtype=np.float32)
    weight = np.zeros(flat_pos.shape[0], dtype=np.float32)

    for view, image in zip(views, images):
        img = np.asarray(image)
        if img.ndim == 2:
            img = np.stack([img] * 3, axis=-1)
        img_h, img_w = img.shape[:2]

        pixels, depth = view.project(flat_pos)
        u, v = pixels[:, 0], pixels[:, 1]

        # The generated view does not have to be the size the camera was defined
        # at: a lane may generate at SDXL-native 1024 and bake a 2048 atlas.
        # Rescale pixel centres onto the image's grid rather than silently
        # projecting into the wrong half of it.
        if img_w != view.size or img_h != view.size:
            u = (u + 0.5) * (img_w / view.size) - 0.5
            v = (v + 0.5) * (img_h / view.size) - 0.5

        facing = np.clip(flat_nrm @ view.view_direction(), 0.0, 1.0)
        confidence = facing ** FACING_EXPONENT
        confidence = np.where(confidence >= MIN_FACING, confidence, 0.0)
        # Half a pixel of slack at the frame border. A texel on the silhouette
        # projects exactly onto the edge pixel, and float error in the rasterized
        # position is enough to push it a hair outside; an exact test would drop
        # the outline of every view and leave the mesh's silhouette painted from
        # the gap fill instead of from the generated texture.
        confidence = np.where(
            (u >= -0.5) & (u <= img_w - 0.5) & (v >= -0.5) & (v <= img_h - 0.5) & (depth > 0),
            confidence,
            0.0,
        )

        if occlude:
            resolution = occlusion_buffer_size(view.size)
            buf = view_depth_buffer(view, flat_pos, resolution)
            scale = resolution / float(view.size)
            bx = np.clip(np.rint(pixels[:, 0] * scale).astype(np.int64), 0, resolution - 1)
            by = np.clip(np.rint(pixels[:, 1] * scale).astype(np.int64), 0, resolution - 1)
            nearest = buf[by, bx]
            # Slope-scaled bias. Within one bin a surface tilted away from the
            # camera spans bin_width * tan(angle) of depth, so a flat tolerance
            # makes the near edge of a bin reject its own far edge: the surface
            # shadows itself and the texture drops out in exactly the grazing
            # regions that already have the least coverage.
            cos_angle = np.clip(facing, MIN_FACING, 1.0)
            slope = np.sqrt(1.0 - cos_angle ** 2) / cos_angle
            bin_width = 2.0 * view.xmag / resolution
            # 4 bin widths: one for the spread inside a bin, one more for the
            # dilation above, and a factor of two so a surface never shadows
            # itself at the angles where coverage is already thinnest.
            bias = np.maximum(view.radius * DEPTH_TOLERANCE_FRAC, 4.0 * bin_width * slope)
            confidence = np.where(
                ~np.isfinite(nearest) | (depth <= nearest + bias), confidence, 0.0
            )

        if not confidence.any():
            continue

        sampled = sample_bilinear(
            img, np.clip(u, 0, img_w - 1), np.clip(v, 0, img_h - 1)
        )[:, :3]
        accum += sampled * confidence[:, None]
        weight += confidence

    if not weight.any():
        raise ValueError("no generated view could see the mesh surface")

    seen = weight > 0
    colour = np.zeros_like(accum)
    colour[seen] = accum[seen] / weight[seen, None]

    canvas = np.zeros((texture_size, texture_size, 3), dtype=np.float32)
    weight_map = np.zeros((texture_size, texture_size), dtype=np.float32)
    canvas[covered] = colour
    weight_map[covered] = weight

    filled = weight_map > 0
    canvas = fill_gaps(canvas, filled)
    # Round rather than truncate: the blend is float, and truncating biases every
    # texel down by up to one level, which shows up as a whole atlas a shade
    # darker than the views it was built from.
    return np.rint(canvas).clip(0, 255).astype(np.uint8), weight_map, covered
