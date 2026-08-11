"""
Tests for the full-retexture geometry: the canonical view camera, the UV
rasterizer, and the back-projection that turns generated views into an atlas.

Run: python3 test_texture_projection.py   (asserts; exits non-zero on failure)

Needs numpy, scipy and Pillow only. No GPU, no torch, no diffusion weights, so
this runs anywhere the image builds and pins the part of the lane that decides
WHERE a generated pixel lands on the surface. The diffusion half is judged by
looking at output; this half is either right or silently wrong, which is exactly
what a test is for.

The fixtures are synthetic on purpose: a plane whose UV layout is known exactly,
so a projected colour can be asserted at a named texel, and a two-sided pair of
planes where one hides the other, so the occlusion gate has something to refuse.
"""

import sys

import numpy as np

import texture_projection as tp


def _unit_plane():
    """A 2x2 quad in the XY plane at z=0, facing +Z, filling the whole atlas.

    Vertices are laid out so UV (0,0) is the bottom-left corner of the atlas and
    matches the bottom-left corner of the quad in world space.
    """
    positions = np.array([
        [-1.0, -1.0, 0.0],
        [1.0, -1.0, 0.0],
        [1.0, 1.0, 0.0],
        [-1.0, 1.0, 0.0],
    ], dtype=np.float32)
    uv = np.array([
        [0.0, 0.0],
        [1.0, 0.0],
        [1.0, 1.0],
        [0.0, 1.0],
    ], dtype=np.float32)
    faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int64)
    normals = np.tile(np.array([0.0, 0.0, 1.0], dtype=np.float32), (4, 1))
    return positions, normals, uv, faces


# A view's half extent is 1.5x the framing radius it is given, so a radius of 2/3
# frames the 2x2 quad edge to edge. That makes view pixel (x, y) and atlas texel
# (col, row) line up one to one, which is what lets a colour be asserted at a
# named texel instead of at "wherever the quad happened to land".
_QUAD_FRAMING_RADIUS = 2.0 / 3.0


def _quad_view(azimuth_deg: float, size: int) -> tp.OrthographicView:
    return tp.OrthographicView([0, 0, 0], _QUAD_FRAMING_RADIUS, azimuth_deg, 0, size)


def test_view_projects_the_centre_to_the_centre():
    view = tp.OrthographicView(center=[0, 0, 0], radius=1.0, azimuth_deg=0, elevation_deg=0, size=64)
    pixels, depth = view.project(np.array([[0.0, 0.0, 0.0]]))
    assert abs(pixels[0, 0] - 31.5) < 1e-6, pixels
    assert abs(pixels[0, 1] - 31.5) < 1e-6, pixels
    assert abs(depth[0] - view.distance) < 1e-6, depth
    # The camera sits on +Z for azimuth 0, so its view direction points back at +Z.
    assert np.allclose(view.view_direction(), [0, 0, 1], atol=1e-6), view.view_direction()
    # A front-on camera sees +X to the right and +Y up (row index grows downward).
    right, _ = view.project(np.array([[0.5, 0.0, 0.0]]))
    top, _ = view.project(np.array([[0.0, 0.5, 0.0]]))
    assert right[0, 0] > 31.5 and abs(right[0, 1] - 31.5) < 1e-6, right
    assert top[0, 1] < 31.5 and abs(top[0, 0] - 31.5) < 1e-6, top
    print("ok  camera maps world to view pixels with the right handedness")


def test_clip_planes_bracket_the_mesh():
    for radius in (0.01, 1.0, 100.0):
        view = tp.OrthographicView([0, 0, 0], radius, 45, 15, 512)
        assert view.znear > 0, view.znear
        # Every point on the bounding sphere has to land between the planes, or
        # the render comes back empty and the whole lane silently produces black.
        assert view.znear < view.distance - radius + 1e-9, (radius, view.znear)
        assert view.zfar > view.distance + radius - 1e-9, (radius, view.zfar)
    print("ok  clip planes bracket the mesh at every scale")


def test_pose_matrix_is_orthonormal_and_looks_at_the_centre():
    view = tp.OrthographicView([0.3, -0.2, 1.5], 2.0, 135, 15, 128)
    pose = view.pose_matrix()
    rot = pose[:3, :3]
    assert np.allclose(rot @ rot.T, np.eye(3), atol=1e-9), rot
    assert abs(np.linalg.det(rot) - 1.0) < 1e-9, np.linalg.det(rot)
    assert np.allclose(pose[:3, 3], view.eye), pose[:3, 3]
    # pyrender's camera looks down its own -Z, which must be the way to the centre.
    to_centre = view.center - view.eye
    to_centre /= np.linalg.norm(to_centre)
    assert np.allclose(-pose[:3, 2], to_centre, atol=1e-9), pose[:3, 2]
    print("ok  pose matrix is a rotation that looks at the mesh")


def test_depth_control_image_puts_near_at_white():
    depth = np.zeros((8, 8), dtype=np.float32)
    depth[2, 2] = 1.0   # near
    depth[5, 5] = 3.0   # far
    img = tp.depth_to_control_image(depth)
    assert img.shape == (8, 8, 3), img.shape
    assert img[2, 2, 0] == 255, img[2, 2]
    assert img[5, 5, 0] == 0, img[5, 5]
    assert img[0, 0, 0] == 0, img[0, 0]  # background stays black
    print("ok  depth conditioning is near-bright, background black")


def test_rasterizer_covers_the_whole_atlas_for_a_full_quad():
    positions, normals, uv, faces = _unit_plane()
    pos_map, nrm_map, covered = tp.rasterize_uv(positions, normals, uv, faces, 32)
    assert covered.all(), f"{covered.sum()}/{covered.size} texels covered"
    # Texel (row 0, col 0) is UV (0, 1): the top-left of the atlas, which is the
    # quad's top-left corner in world space.
    assert np.allclose(pos_map[0, 0], [-1, 1, 0], atol=1e-5), pos_map[0, 0]
    assert np.allclose(pos_map[31, 0], [-1, -1, 0], atol=1e-5), pos_map[31, 0]
    assert np.allclose(pos_map[31, 31], [1, -1, 0], atol=1e-5), pos_map[31, 31]
    assert np.allclose(nrm_map[0, 0], [0, 0, 1], atol=1e-6), nrm_map[0, 0]
    print("ok  UV rasterizer fills triangle interiors with interpolated surface")


def test_back_projection_lands_the_view_pixels_where_they_belong():
    """The regression that matters: a view painted with a left/right split must
    come back as the same split in the atlas, not as a scatter of vertex texels.
    """
    positions, normals, uv, faces = _unit_plane()
    size = 64
    view = _quad_view(0, size)

    # Left half of the frame red, right half blue, top-left corner green so a
    # vertical flip cannot pass as success.
    image = np.zeros((size, size, 3), dtype=np.uint8)
    image[:, : size // 2] = (255, 0, 0)
    image[:, size // 2:] = (0, 0, 255)
    image[: size // 4, : size // 4] = (0, 255, 0)

    atlas, weight, covered = tp.project_views_to_uv(
        positions, normals, uv, faces, [view], [image], texture_size=size
    )

    assert covered.all()
    assert (weight > 0).all(), "every texel of a front-facing quad should be seen"

    quarter, three_quarter = size // 4, (3 * size) // 4
    assert tuple(atlas[three_quarter, quarter]) == (255, 0, 0), atlas[three_quarter, quarter]
    assert tuple(atlas[three_quarter, three_quarter]) == (0, 0, 255), atlas[three_quarter, three_quarter]
    # Green sits in the view's top-left, so it must land in the atlas top-left.
    assert tuple(atlas[2, 2]) == (0, 255, 0), atlas[2, 2]
    assert tuple(atlas[size - 3, 2]) == (255, 0, 0), atlas[size - 3, 2]
    print("ok  back-projection preserves the view's layout in the atlas")


def test_back_facing_views_are_refused():
    positions, normals, uv, faces = _unit_plane()
    size = 32
    front = _quad_view(0, size)
    back = _quad_view(180, size)

    front_img = np.full((size, size, 3), (0, 200, 0), dtype=np.uint8)
    back_img = np.full((size, size, 3), (200, 0, 0), dtype=np.uint8)

    atlas, weight, _ = tp.project_views_to_uv(
        positions, normals, uv, faces, [front, back], [front_img, back_img], texture_size=size
    )
    assert np.array_equal(np.unique(atlas.reshape(-1, 3), axis=0), np.array([[0, 200, 0]])), \
        np.unique(atlas.reshape(-1, 3), axis=0)
    assert (weight > 0).all()

    # With only the back view there is nothing legitimate to paint, and the
    # honest answer is an error, not a black atlas that looks like a texture.
    try:
        tp.project_views_to_uv(positions, normals, uv, faces, [back], [back_img], texture_size=size)
    except ValueError as exc:
        assert "no generated view" in str(exc), exc
    else:
        raise AssertionError("a purely back-facing view should not produce an atlas")
    print("ok  surfaces turned away from a view take no colour from it")


def test_occluded_texels_are_refused_against_the_depth_buffer():
    """A texel hidden behind nearer geometry must not take that geometry's colour."""
    positions, normals, uv, faces = _unit_plane()
    size = 32
    view = _quad_view(0, size)
    image = np.full((size, size, 3), (10, 20, 30), dtype=np.uint8)

    # The quad sits at z=0, so its depth from this camera is exactly `distance`.
    # A buffer claiming a surface half a radius nearer over the left half of the
    # frame means that half is hidden.
    buffer = np.full((size, size), view.distance, dtype=np.float32)
    buffer[:, : size // 2] = view.distance - view.radius * 0.5

    atlas, weight, _ = tp.project_views_to_uv(
        positions, normals, uv, faces, [view], [image], texture_size=size,
        depth_buffers=[buffer],
    )
    left = weight[:, : size // 2 - 1]
    right = weight[:, size // 2 + 1:]
    assert not left.any(), f"occluded half kept {int((left > 0).sum())} texels"
    assert (right > 0).all(), "visible half should be fully painted"
    # Gap filling still leaves a complete atlas, sourced from the visible half.
    assert (atlas[:, : size // 2 - 1] == (10, 20, 30)).all()
    print("ok  occlusion gate refuses texels hidden behind nearer geometry")


def test_grazing_views_lose_to_face_on_views():
    """Two views see the quad; the one that sees it head on must dominate."""
    positions, normals, uv, faces = _unit_plane()
    size = 32
    head_on = _quad_view(0, size)
    grazing = _quad_view(60, size)

    white = np.full((size, size, 3), 255, dtype=np.uint8)
    black = np.zeros((size, size, 3), dtype=np.uint8)

    atlas, _, _ = tp.project_views_to_uv(
        positions, normals, uv, faces, [head_on, grazing], [white, black], texture_size=size
    )
    centre = int(atlas[size // 2, size // 2, 0])
    # cos(60) ** 2 = 0.25 of the weight, so the blend sits at 1/(1+0.25) = 80%.
    assert 195 <= centre <= 215, centre
    print("ok  face-on views outweigh grazing ones in the blend")


def test_gap_fill_never_leaves_a_hole():
    canvas = np.zeros((8, 8, 3), dtype=np.float32)
    filled = np.zeros((8, 8), dtype=bool)
    canvas[0, 0] = (7, 8, 9)
    filled[0, 0] = True
    out = tp.fill_gaps(canvas.copy(), filled)
    assert (out == (7, 8, 9)).all(), out[4, 4]
    # Nothing written anywhere is left alone rather than crashing the job.
    assert tp.fill_gaps(canvas.copy(), np.zeros((8, 8), dtype=bool)).sum() == 24
    print("ok  gap fill pads every unwritten texel")


TESTS = [
    test_view_projects_the_centre_to_the_centre,
    test_clip_planes_bracket_the_mesh,
    test_pose_matrix_is_orthonormal_and_looks_at_the_centre,
    test_depth_control_image_puts_near_at_white,
    test_rasterizer_covers_the_whole_atlas_for_a_full_quad,
    test_back_projection_lands_the_view_pixels_where_they_belong,
    test_back_facing_views_are_refused,
    test_occluded_texels_are_refused_against_the_depth_buffer,
    test_grazing_views_lose_to_face_on_views,
    test_gap_fill_never_leaves_a_hole,
]


if __name__ == "__main__":
    failures = 0
    for test in TESTS:
        try:
            test()
        except Exception as exc:  # noqa: BLE001, a harness reports every failure
            failures += 1
            print(f"FAIL {test.__name__}: {exc}")
    print(f"\n{len(TESTS) - failures}/{len(TESTS)} passed")
    sys.exit(1 if failures else 0)
