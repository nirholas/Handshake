"""Point-cloud fusion and PLY export for model-video2scene.

Pure NumPy (torch tensors are accepted by duck typing) so the path that turns
LingBot-Map predictions into a coloured binary PLY can be exercised without a
GPU, a checkpoint, or the upstream repo installed. ``main.py`` imports these
helpers and ``test_scene_fusion.py`` covers them.
"""

from __future__ import annotations

import numpy as np

# xyz float32 + rgb uint8, the exact layout written into the PLY body.
PLY_VERTEX_DTYPE = np.dtype([("xyz", "<f4", 3), ("rgb", "u1", 3)])

# Mid grey, used only when a colour buffer cannot be aligned with the points.
NEUTRAL_GREY = 179


def to_np(x) -> np.ndarray:
    """Materialize a torch tensor (any device/dtype) or array-like as ndarray."""
    if hasattr(x, "detach") and hasattr(x, "cpu"):
        return x.detach().to("cpu").float().numpy()
    return np.asarray(x)


def flatten_colors(images, num_points: int) -> np.ndarray:
    """Flatten per-frame RGB into (num_points, 3) uint8, one row per pixel.

    LingBot-Map hands the preprocessed frames back as (S, 3, H, W); callers that
    already permuted them carry (S, H, W, 3). Both normalize to one row per
    pixel, in the same raster order as the flattened world points. Values in
    [0, 1] are scaled to [0, 255]. A buffer that cannot be aligned with the
    point count falls back to neutral grey rather than mis-colouring the cloud.
    """
    imgs = to_np(images)
    if imgs.ndim >= 3 and imgs.shape[-1] == 3:
        cols = imgs.reshape(-1, 3)
    elif imgs.ndim >= 3 and imgs.shape[-3] == 3:
        cols = np.moveaxis(imgs, -3, -1).reshape(-1, 3)
    else:
        cols = imgs.reshape(-1, 3)

    if cols.shape[0] != num_points:
        return np.full((num_points, 3), NEUTRAL_GREY, dtype=np.uint8)

    cols = cols.astype(np.float32)
    if cols.size and float(np.nanmax(cols)) <= 1.0 + 1e-6:
        cols = cols * 255.0
    return np.clip(np.nan_to_num(cols), 0, 255).astype(np.uint8)


def voxel_downsample(
    pts: np.ndarray, cols: np.ndarray, voxel: float
) -> tuple[np.ndarray, np.ndarray]:
    """Merge points sharing a voxel cell into one averaged, colour-averaged point.

    Higher quality than blind stride subsampling: it collapses the redundant
    overlap where many frames re-observe the same surface, evens out density,
    and suppresses single-frame noise while preserving the true shape.
    Deterministic (no RNG). ``voxel`` is the cell edge length in world units.
    """
    if voxel <= 0 or pts.shape[0] == 0:
        return pts, cols

    keys = np.floor(pts / voxel).astype(np.int64)
    order = np.lexsort((keys[:, 2], keys[:, 1], keys[:, 0]))
    keys, pts, cols = keys[order], pts[order], cols[order]

    boundaries = np.any(np.diff(keys, axis=0) != 0, axis=1)
    starts = np.concatenate(([0], np.nonzero(boundaries)[0] + 1))
    counts = np.diff(np.concatenate((starts, [pts.shape[0]])))[:, None].astype(np.float32)

    # reduceat sums each contiguous cell run in C, so a million-cell cloud never
    # touches a Python-level loop.
    out_pts = (np.add.reduceat(pts, starts, axis=0) / counts).astype(np.float32)
    out_cols = np.add.reduceat(cols.astype(np.float32), starts, axis=0) / counts
    return out_pts, np.clip(out_cols, 0, 255).astype(np.uint8)


def fuse_point_cloud(
    world_points,
    images,
    *,
    conf=None,
    keep=None,
    conf_percentile: float = 30.0,
    max_points: int = 1_500_000,
    voxel_size: float = 0.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Flatten per-frame world points + RGB into one coloured cloud.

    ``world_points`` is (S, H, W, 3) in a shared world frame, ``conf`` the
    aligned (S, H, W) confidence, and ``keep`` an optional per-point boolean
    (already flattened) that survives the confidence step, which is how sky
    masking feeds in. Non-finite points are dropped, the low-confidence tail is
    cut at ``conf_percentile`` computed over the points still standing, the
    cloud is optionally voxel-merged, and the total is capped at ``max_points``.
    """
    pts = to_np(world_points).reshape(-1, 3).astype(np.float32)
    cols = flatten_colors(images, pts.shape[0])

    mask = np.isfinite(pts).all(axis=1)
    if keep is not None:
        keep_flat = np.asarray(keep).reshape(-1)
        if keep_flat.shape[0] == mask.shape[0]:
            mask &= keep_flat.astype(bool)

    if conf is not None and conf_percentile > 0:
        conf_flat = to_np(conf).reshape(-1)
        if conf_flat.shape[0] == mask.shape[0]:
            surviving = conf_flat[mask & np.isfinite(conf_flat)]
            if surviving.size:
                threshold = float(np.percentile(surviving, conf_percentile))
                mask &= conf_flat >= threshold

    pts, cols = pts[mask], cols[mask]

    if voxel_size > 0:
        pts, cols = voxel_downsample(pts, cols, voxel_size)

    if pts.shape[0] > max_points:
        # Deterministic stride subsample: preserves spatial spread without RNG.
        idx = np.linspace(0, pts.shape[0] - 1, max_points).astype(np.int64)
        pts, cols = pts[idx], cols[idx]

    return pts.astype(np.float32), cols.astype(np.uint8)


def write_ply(points: np.ndarray, colors: np.ndarray) -> bytes:
    """Binary little-endian PLY: x y z float32 + red green blue uchar."""
    n = int(points.shape[0])
    header = (
        "ply\n"
        "format binary_little_endian 1.0\n"
        "comment generated by three.ws model-video2scene (LingBot-Map)\n"
        f"element vertex {n}\n"
        "property float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\n"
        "end_header\n"
    ).encode("ascii")
    body = np.empty(n, dtype=PLY_VERTEX_DTYPE)
    body["xyz"] = points
    body["rgb"] = colors
    return header + body.tobytes()


def read_ply(data: bytes) -> tuple[np.ndarray, np.ndarray]:
    """Parse a PLY written by :func:`write_ply` back into (points, colors).

    Exists so the writer can be verified against a real reader rather than
    against its own byte layout.
    """
    marker = b"end_header\n"
    end = data.find(marker)
    if end < 0:
        raise ValueError("not a PLY: no end_header")
    header = data[:end].decode("ascii")
    if "format binary_little_endian 1.0" not in header:
        raise ValueError("unsupported PLY format")
    count = 0
    for line in header.splitlines():
        if line.startswith("element vertex "):
            count = int(line.split()[-1])
    body = np.frombuffer(data, dtype=PLY_VERTEX_DTYPE, count=count, offset=end + len(marker))
    return np.array(body["xyz"]), np.array(body["rgb"])
