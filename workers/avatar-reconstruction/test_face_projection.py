"""
Tests for projective texturing.

Run: python3 test_face_projection.py   (asserts; exits non-zero on failure)

These use a synthetic head (a sphere with a spherical UV unwrap) rather than the
real template, so they run without the GLB and pin the *geometry* of the method:
that a known camera is recovered, that back-facing and occluded surfaces are
refused, and that the face oval keeps its landmark-warped pixels. The real-mesh
coverage number is measured separately by measure_projection_coverage.py.
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


def _project(points, rvec, tvec, K):
    import cv2
    R, _ = cv2.Rodrigues(rvec)
    cam = points @ R.T + tvec.reshape(1, 3)
    p = cam @ K.T
    return np.stack([p[:, 0] / cam[:, 2], p[:, 1] / cam[:, 2]], axis=1)


def _known_camera(img_w=800, img_h=800, dist=6.0):
    rvec = np.array([[0.05], [0.12], [0.0]], dtype=np.float64)
    tvec = np.array([[0.0], [0.0], [dist]], dtype=np.float64)
    f = float(img_w)
    K = np.array([[f, 0, img_w / 2], [0, f, img_h / 2], [0, 0, 1]], dtype=np.float64)
    return rvec, tvec, K


def test_recovers_a_known_camera():
    """The whole method rests on the pose solve; if it drifts, everything after
    it paints the right pixels onto the wrong places."""
    pos, _, _, _ = _sphere()
    rvec, tvec, K = _known_camera()
    idx = np.random.default_rng(0).choice(len(pos), 60, replace=False)
    pts2d = _project(pos[idx], rvec, tvec, K)

    got = fp.solve_camera_pose(pts2d, pos[idx], 800, 800)
    assert got is not None, "pose failed to solve on exact synthetic data"
    r, t, _ = got
    assert np.allclose(r.ravel(), rvec.ravel(), atol=0.02), f"rvec {r.ravel()} vs {rvec.ravel()}"
    assert np.allclose(t.ravel(), tvec.ravel(), atol=0.1), f"tvec {t.ravel()} vs {tvec.ravel()}"
    print("ok  recovers a known camera pose from landmark correspondences")


def test_refuses_a_degenerate_solve():
    """Too few points, or a head behind the camera, must return None rather than
    a pose that would paint nonsense with full confidence."""
    assert fp.solve_camera_pose(np.zeros((3, 2)), np.zeros((3, 3)), 800, 800) is None
    print("ok  refuses to solve with too few correspondences")


def test_paints_the_camera_facing_side_only():
    """The far side of the sphere is not visible to the camera and must keep its
    template colour. This is the test that would fail if the facing or occlusion
    gate were dropped: without them the back of a head gets painted with
    whatever pixel lies behind it."""
    pos, nrm, uv, faces = _sphere()
    rvec, tvec, K = _known_camera()
    idx = np.random.default_rng(1).choice(len(pos), 80, replace=False)
    pts2d = _project(pos[idx], rvec, tvec, K)

    photo = np.zeros((800, 800, 3), dtype=np.uint8)
    photo[:, :] = (200, 100, 50)

    out = fp.project_photo_to_uv(
        photo, None, pos, nrm, uv, faces, pts2d, pos[idx], 256, 256,
    )
    assert out is not None, "projection returned None on a solvable case"
    rgb, weight = out

    # The sphere's UV unwrap puts +Z (toward the camera) near the seam and -Z in
    # the middle of the atlas, so compare hemispheres by their actual normals.
    pos_map, nrm_map, covered = fp._rasterize_uv(pos, uv, faces, nrm, 256, 256)
    import cv2
    R, _ = cv2.Rodrigues(rvec)
    cam_centre = (-R.T @ tvec).reshape(3)
    to_cam = cam_centre[None, None, :] - pos_map
    to_cam /= np.maximum(np.linalg.norm(to_cam, axis=2, keepdims=True), 1e-9)
    facing = np.einsum("ijk,ijk->ij", nrm_map, to_cam)

    front = covered & (facing > 0.7)
    back = covered & (facing < -0.3)
    assert front.any() and back.any(), "test sphere did not produce both hemispheres"

    assert weight[front].mean() > 0.3, f"front hemisphere barely painted: {weight[front].mean():.3f}"
    assert weight[back].max() < 0.01, f"back hemisphere was painted: {weight[back].max():.3f}"
    print(f"ok  paints only the camera-facing surface (front {weight[front].mean():.2f}, back {weight[back].max():.2f})")


def test_reaches_surface_no_landmark_describes():
    """The point of the exercise: texels far from every landmark still get
    painted, because projection needs geometry rather than correspondence."""
    pos, nrm, uv, faces = _sphere()
    rvec, tvec, K = _known_camera()
    # tvec = (0, 0, 6) puts the camera centre at world z = -6, so the surface
    # facing it is the -z cap. Landmarks are confined to a small patch of it, as
    # MediaPipe's are confined to the face.
    front = np.where((pos[:, 2] < -0.8) & (np.abs(pos[:, 1]) < 0.3))[0]
    assert len(front) >= 10
    pts2d = _project(pos[front], rvec, tvec, K)

    photo = np.full((800, 800, 3), 128, dtype=np.uint8)
    rgb, weight = fp.project_photo_to_uv(
        photo, None, pos, nrm, uv, faces, pts2d, pos[front], 256, 256,
    )

    pos_map, _, covered = fp._rasterize_uv(pos, uv, faces, nrm, 256, 256)
    # Visible surface well outside the landmark patch: the ear-and-neck analogue.
    outside = covered & (pos_map[:, :, 2] < -0.3) & (np.abs(pos_map[:, :, 1]) > 0.55)
    assert outside.any(), "no test texels outside the landmark patch"
    painted = (weight[outside] > 0.01).mean()
    assert painted > 0.5, f"only {painted:.0%} of no-landmark surface was reached"
    print(f"ok  reaches surface no landmark describes ({painted:.0%} of it painted)")


def test_background_pixels_are_refused():
    """A texel projecting just off the silhouette must not pick up the wall."""
    pos, nrm, uv, faces = _sphere()
    rvec, tvec, K = _known_camera()
    idx = np.random.default_rng(2).choice(len(pos), 80, replace=False)
    pts2d = _project(pos[idx], rvec, tvec, K)

    photo = np.full((800, 800, 3), 255, dtype=np.uint8)
    empty_fg = np.zeros((800, 800), dtype=np.float32)  # nothing is foreground

    _, weight = fp.project_photo_to_uv(
        photo, empty_fg, pos, nrm, uv, faces, pts2d, pos[idx], 256, 256,
    )
    assert weight.max() < 0.01, f"painted through an empty foreground mask: {weight.max():.3f}"
    print("ok  an empty foreground mask refuses every sample")


def test_face_oval_keeps_its_landmark_warped_pixels():
    """Projection is only as good as the pose solve; inside the oval the
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
    """A pose that is slightly wrong should degrade to a tint, never to a fully
    replaced texture, so the template's baked shading always carries through."""
    base = np.zeros((16, 16, 3), dtype=np.uint8)
    projected = np.full((16, 16, 3), 255, dtype=np.float32)
    out = fp.blend_projection(base, projected, np.full((16, 16), fp.MAX_BLEND, dtype=np.float32))
    assert out.max() <= 255 * fp.MAX_BLEND + 1, "blend exceeded MAX_BLEND"
    assert fp.MAX_BLEND < 1.0, "MAX_BLEND must leave some template shading"
    print(f"ok  blend is bounded at {fp.MAX_BLEND}")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    try:
        for t in tests:
            t()
    except AssertionError as e:
        print("FAIL:", e)
        sys.exit(1)
    print(f"\nall {len(tests)} projection tests passed")
