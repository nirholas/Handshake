"""
Tests for projective texturing.

Run: python3 test_face_projection.py   (asserts; exits non-zero on failure)

These use a synthetic head (a sphere with a spherical UV unwrap) rather than the
real template, so they run without the GLB and pin the *geometry* of the method:
that a known camera is recovered, that back-facing and occluded surfaces are
refused, and that the face oval keeps its landmark-warped pixels. Coverage on
the real mesh with real faces is measured by eval/measure_projection_coverage.py.
"""

import sys

import numpy as np

import face_projection as fp


def _sphere(n_theta=40, n_phi=40, radius=1.0):
    """A UV-unwrapped sphere: positions, normals, uvs, faces."""
    thetas = np.linspace(0.01, np.pi - 0.01, n_theta)
    phis = np.linspace(0, 2 * np.pi, n_phi, endpoint=False)
    pos, uv = [], []
    for i, t in enumerate(thetas):
        for j, p in enumerate(phis):
            pos.append([radius * np.sin(t) * np.sin(p), radius * np.cos(t), radius * np.sin(t) * np.cos(p)])
            uv.append([j / (n_phi - 1), 1.0 - i / (n_theta - 1)])
    pos = np.array(pos, dtype=np.float32)
    uv = np.array(uv, dtype=np.float32)
    normals = pos / np.linalg.norm(pos, axis=1, keepdims=True)

    faces = []
    for i in range(n_theta - 1):
        for j in range(n_phi - 1):
            a = i * n_phi + j
            b = a + 1
            c = a + n_phi
            d = c + 1
            faces.append([a, c, b])
            faces.append([b, c, d])
    return pos, normals.astype(np.float32), uv, np.array(faces, dtype=np.int32)


def _synthetic_landmarks(positions, indices, scale=300.0, angle=0.25, img_h=800):
    """
    Landmark cloud in the frame `face_geometry.landmarks_to_array` produces:
    x in pixels, y as MINUS the pixel row, z a depth that grows away from camera.
    """
    c, s = np.cos(angle), np.sin(angle)
    R = np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])
    pts = (scale * (R @ positions[indices].T)).T
    pts[:, 0] += 400.0
    pts[:, 1] -= img_h / 2.0
    pts[:, 2] += 1000.0
    return pts, scale, R


def test_recovers_a_known_camera():
    """The whole method rests on the fit; if it drifts, everything after it
    paints the right pixels onto the wrong places."""
    pos, _, _, _ = _sphere()
    idx = np.arange(len(pos))
    pts, scale, R = _synthetic_landmarks(pos, idx)

    cam = fp.solve_camera(pts, idx, pos, 800, 800)
    assert cam is not None, "camera failed to fit exact synthetic data"
    assert abs(cam.s - scale) / scale < 0.01, f"scale {cam.s:.1f} vs {scale}"
    assert np.allclose(cam.R, R, atol=0.02), f"rotation drifted:\n{cam.R}\nvs\n{R}"
    print("ok  recovers a known camera from landmark correspondences")


def test_refuses_a_degenerate_fit():
    """Too few correspondences must return None rather than a camera that would
    paint nonsense with full confidence."""
    assert fp.solve_camera(np.zeros((3, 3)), np.arange(3), np.zeros((3, 3)), 800, 800) is None
    print("ok  refuses to fit with too few correspondences")


def test_refuses_correspondences_that_do_not_describe_the_same_object():
    """
    The guard that matters in production. A least-squares fit always returns
    *something*, so without a residual check a garbage correspondence set yields
    a confident, wrong camera and the photo is painted onto the wrong parts of
    the head, which is worse than not painting at all.
    """
    pos, _, _, _ = _sphere()
    idx = np.arange(len(pos))
    rng = np.random.default_rng(7)
    noise = rng.normal(0, 400.0, size=(len(idx), 3))  # comparable to the head itself
    assert fp.solve_camera(noise, idx, pos, 800, 800) is None
    print("ok  refuses correspondences whose residual is a large share of the head")


def test_paints_the_camera_facing_side_only():
    """The far side of the sphere is not visible and must keep its template
    colour. This is the test that fails if the facing or occlusion gate is
    dropped: without them the back of a head gets painted with whatever pixel
    lies behind it."""
    pos, nrm, uv, faces = _sphere()
    idx = np.arange(len(pos))
    pts, _, _ = _synthetic_landmarks(pos, idx)

    photo = np.zeros((800, 800, 3), dtype=np.uint8)
    photo[:, :] = (200, 100, 50)

    out = fp.project_photo_to_uv(photo, None, pos, nrm, uv, faces, pts, idx, 256, 256)
    assert out is not None, "projection returned None on a solvable case"
    _, weight, covered = out

    cam = fp.solve_camera(pts, idx, pos, 800, 800)
    _, nrm_map, _ = fp._rasterize_uv(pos, uv, faces, nrm, 256, 256)
    facing = nrm_map @ cam.view_direction()

    front = covered & (facing > 0.7)
    back = covered & (facing < -0.3)
    assert front.any() and back.any(), "test sphere did not produce both hemispheres"
    assert weight[front].mean() > 0.3, f"front barely painted: {weight[front].mean():.3f}"
    assert weight[back].max() < 0.01, f"back was painted: {weight[back].max():.3f}"
    print(f"ok  paints only the camera-facing surface (front {weight[front].mean():.2f}, back {weight[back].max():.2f})")


def test_reaches_surface_no_landmark_describes():
    """The point of the exercise: texels far from every landmark still get
    painted, because projection needs geometry rather than correspondence."""
    pos, nrm, uv, faces = _sphere()
    # Landmarks confined to a small patch, as MediaPipe's are confined to the face.
    patch = np.where((pos[:, 2] > 0.8) & (np.abs(pos[:, 1]) < 0.3))[0]
    assert len(patch) >= 16
    pts, _, _ = _synthetic_landmarks(pos, patch)

    photo = np.full((800, 800, 3), 128, dtype=np.uint8)
    out = fp.project_photo_to_uv(photo, None, pos, nrm, uv, faces, pts, patch, 256, 256)
    assert out is not None, "camera rejected a small but valid landmark patch"
    _, weight, covered = out

    cam = fp.solve_camera(pts, patch, pos, 800, 800)
    pos_map, nrm_map, _ = fp._rasterize_uv(pos, uv, faces, nrm, 256, 256)
    facing = nrm_map @ cam.view_direction()
    # Visible surface well outside the landmark patch: the ear-and-neck analogue.
    outside = covered & (facing > 0.5) & (np.abs(pos_map[:, :, 1]) > 0.55)
    assert outside.any(), "no test texels outside the landmark patch"
    painted = (weight[outside] > 0.01).mean()
    assert painted > 0.5, f"only {painted:.0%} of no-landmark surface was reached"
    print(f"ok  reaches surface no landmark describes ({painted:.0%} of it painted)")


def test_background_pixels_are_refused():
    """A texel projecting just off the silhouette must not pick up the wall."""
    pos, nrm, uv, faces = _sphere()
    idx = np.arange(len(pos))
    pts, _, _ = _synthetic_landmarks(pos, idx)

    photo = np.full((800, 800, 3), 255, dtype=np.uint8)
    empty_fg = np.zeros((800, 800), dtype=np.float32)  # nothing is foreground

    _, weight, _ = fp.project_photo_to_uv(
        photo, empty_fg, pos, nrm, uv, faces, pts, idx, 256, 256,
    )
    assert weight.max() < 0.01, f"painted through an empty foreground mask: {weight.max():.3f}"
    print("ok  an empty foreground mask refuses every sample")


def test_duplicate_correspondences_are_collapsed():
    """
    `landmark_vtx` is many-to-one: on the shipped template 468 landmarks map onto
    262 head vertices. Left unaveraged, duplicates weight a vertex by how many
    landmarks happened to land on it, tilting the fit toward the dense parts of
    the face. Unaveraged duplicates are also what defeated the perspective solve
    that preceded this camera.
    """
    pos, _, _, _ = _sphere()
    idx = np.array([5, 5, 5, 9, 9, 12] + list(range(20, 60)))
    pts, _, _ = _synthetic_landmarks(pos, idx)
    dst, src = fp._dedupe_correspondences(pts, idx, pos.astype(np.float64))
    assert len(src) == len(np.unique(idx)), "duplicates were not collapsed"
    assert len(src) < len(idx), "test vector had no duplicates to collapse"
    assert np.allclose(dst[0], pts[:3].mean(axis=0)), "duplicates were not averaged"
    print(f"ok  collapses {len(idx)} landmarks onto {len(src)} unique vertices")


def test_face_oval_keeps_its_landmark_warped_pixels():
    """Projection is only as good as the camera fit; inside the oval the
    landmark warp is exact, so it must win."""
    base = np.full((64, 64, 3), 10, dtype=np.uint8)
    projected = np.full((64, 64, 3), 250, dtype=np.float32)
    weight = np.ones((64, 64), dtype=np.float32)
    protect = np.zeros((64, 64), dtype=np.float32)
    protect[16:48, 16:48] = 1.0

    out = fp.blend_projection(base, projected, weight, protect)
    assert abs(int(out[32, 32, 0]) - 10) <= 1, f"protected oval was overwritten: {out[32, 32, 0]}"
    assert out[2, 2, 0] > 200, f"unprotected region was not painted: {out[2, 2, 0]}"
    print("ok  the face oval keeps its landmark-warped pixels")


def test_blend_is_bounded():
    """A camera that is slightly wrong should degrade to a tint, never to a fully
    replaced texture, so the template's baked shading always carries through."""
    base = np.zeros((16, 16, 3), dtype=np.uint8)
    projected = np.full((16, 16, 3), 255, dtype=np.float32)
    out = fp.blend_projection(base, projected, np.full((16, 16), fp.MAX_BLEND, dtype=np.float32))
    assert out.max() <= 255 * fp.MAX_BLEND + 1, "blend exceeded MAX_BLEND"
    assert fp.MAX_BLEND < 1.0, "MAX_BLEND must leave some template shading"
    print(f"ok  blend is bounded at {fp.MAX_BLEND}")


def test_uv_raster_cache_is_result_identical():
    """The cache exists for speed; if it ever changes a pixel it is a bug, and if
    it ever returns stale positions after the identity morph the texture slides
    off the features it was sampled from."""
    pos, nrm, uv, faces = _sphere()
    fp._UV_RASTER_CACHE.clear()
    a = fp._rasterize_uv(pos, uv, faces, nrm, 128, 128)
    b = fp._rasterize_uv(pos, uv, faces, nrm, 128, 128)
    assert np.array_equal(a[0], b[0]) and np.array_equal(a[2], b[2])
    c = fp._rasterize_uv(pos * 2.0, uv, faces, nrm, 128, 128)
    assert not np.allclose(a[0], c[0]), "cache returned stale positions for moved geometry"
    print("ok  UV raster cache is result-identical and not stale on a morph")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    try:
        for t in tests:
            t()
    except AssertionError as e:
        print("FAIL:", e)
        sys.exit(1)
    print(f"\nall {len(tests)} projection tests passed")
