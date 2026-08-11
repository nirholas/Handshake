"""Deterministic tests for the point-cloud fusion + PLY export core path.

No torch, no checkpoint, no GPU: pure-math validation of the stage that turns
LingBot-Map predictions into the binary PLY the three.ws Scene Capture page
renders. Run:  python -m unittest workers/model-video2scene/test_scene_fusion.py
"""

from __future__ import annotations

import unittest

import numpy as np

from scene_fusion import (
    NEUTRAL_GREY,
    flatten_colors,
    fuse_point_cloud,
    read_ply,
    voxel_downsample,
    write_ply,
)


def frames_chw(colors: list[list[float]], height: int, width: int) -> np.ndarray:
    """Build an (S, 3, H, W) frame stack where frame i is a flat colour."""
    stack = np.empty((len(colors), 3, height, width), dtype=np.float32)
    for i, rgb in enumerate(colors):
        for c in range(3):
            stack[i, c] = rgb[c]
    return stack


class FlattenColorsTest(unittest.TestCase):
    def test_chw_layout_is_transposed_not_reinterpreted(self):
        # Frame 0 is pure red, frame 1 pure blue, in (S, 3, H, W).
        imgs = frames_chw([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]], 2, 2)
        cols = flatten_colors(imgs, 8)
        self.assertEqual(cols.shape, (8, 3))
        np.testing.assert_array_equal(cols[:4], np.tile([255, 0, 0], (4, 1)))
        np.testing.assert_array_equal(cols[4:], np.tile([0, 0, 255], (4, 1)))

    def test_hwc_layout_passes_through(self):
        imgs = np.zeros((2, 2, 2, 3), dtype=np.float32)
        imgs[..., 1] = 1.0
        cols = flatten_colors(imgs, 8)
        np.testing.assert_array_equal(cols, np.tile([0, 255, 0], (8, 1)))

    def test_already_byte_ranged_values_are_not_rescaled(self):
        imgs = np.full((1, 1, 1, 3), 200.0, dtype=np.float32)
        np.testing.assert_array_equal(flatten_colors(imgs, 1), [[200, 200, 200]])

    def test_unalignable_buffer_falls_back_to_grey(self):
        cols = flatten_colors(np.zeros((3, 3, 3), dtype=np.float32), 5)
        self.assertEqual(cols.shape, (5, 3))
        np.testing.assert_array_equal(cols, np.full((5, 3), NEUTRAL_GREY))


class VoxelDownsampleTest(unittest.TestCase):
    def test_merges_cell_and_averages_colour(self):
        pts = np.array(
            [[0.0, 0.0, 0.0], [0.1, 0.1, 0.1], [5.0, 5.0, 5.0]], dtype=np.float32
        )
        cols = np.array([[0, 0, 0], [100, 100, 100], [255, 0, 0]], dtype=np.uint8)
        out_pts, out_cols = voxel_downsample(pts, cols, 1.0)
        self.assertEqual(out_pts.shape[0], 2)
        np.testing.assert_allclose(out_pts[0], [0.05, 0.05, 0.05], atol=1e-6)
        np.testing.assert_array_equal(out_cols[0], [50, 50, 50])
        np.testing.assert_allclose(out_pts[1], [5.0, 5.0, 5.0], atol=1e-6)
        np.testing.assert_array_equal(out_cols[1], [255, 0, 0])

    def test_is_deterministic_and_order_independent(self):
        rng = np.random.default_rng(7)
        pts = rng.standard_normal((500, 3)).astype(np.float32)
        cols = rng.integers(0, 256, (500, 3)).astype(np.uint8)
        a_pts, a_cols = voxel_downsample(pts.copy(), cols.copy(), 0.25)
        shuffle = rng.permutation(500)
        b_pts, b_cols = voxel_downsample(pts[shuffle], cols[shuffle], 0.25)
        np.testing.assert_allclose(a_pts, b_pts, atol=1e-5)
        np.testing.assert_allclose(
            a_cols.astype(np.int16), b_cols.astype(np.int16), atol=1
        )

    def test_zero_voxel_is_a_no_op(self):
        pts = np.zeros((4, 3), dtype=np.float32)
        cols = np.zeros((4, 3), dtype=np.uint8)
        out_pts, _ = voxel_downsample(pts, cols, 0.0)
        self.assertEqual(out_pts.shape[0], 4)


class FusePointCloudTest(unittest.TestCase):
    def predictions(self):
        """A 2-frame, 2x2-pixel prediction set shaped exactly like the model's."""
        world = np.arange(2 * 2 * 2 * 3, dtype=np.float32).reshape(2, 2, 2, 3)
        conf = np.array([[[1.0, 2.0], [3.0, 4.0]], [[5.0, 6.0], [7.0, 8.0]]], np.float32)
        images = frames_chw([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], 2, 2)
        return world, conf, images

    def test_no_filtering_keeps_every_pixel(self):
        world, conf, images = self.predictions()
        pts, cols = fuse_point_cloud(world, images, conf=conf, conf_percentile=0.0)
        self.assertEqual(pts.shape, (8, 3))
        np.testing.assert_array_equal(pts, world.reshape(-1, 3))
        np.testing.assert_array_equal(cols[0], [255, 0, 0])
        np.testing.assert_array_equal(cols[-1], [0, 255, 0])

    def test_confidence_percentile_cuts_the_low_tail(self):
        world, conf, images = self.predictions()
        pts, _ = fuse_point_cloud(world, images, conf=conf, conf_percentile=50.0)
        # Median of 1..8 is 4.5, so the four points at conf 5..8 survive.
        self.assertEqual(pts.shape[0], 4)
        np.testing.assert_array_equal(pts, world.reshape(-1, 3)[4:])

    def test_non_finite_points_are_dropped(self):
        world, conf, images = self.predictions()
        world = world.copy()
        world[0, 0, 0] = [np.nan, 0.0, 0.0]
        world[1, 1, 1] = [np.inf, 0.0, 0.0]
        pts, _ = fuse_point_cloud(world, images, conf=conf, conf_percentile=0.0)
        self.assertEqual(pts.shape[0], 6)
        self.assertTrue(np.isfinite(pts).all())

    def test_keep_mask_removes_points_and_reshapes_the_percentile(self):
        # The keep mask is how sky segmentation feeds in: the points it removes
        # must not drag the confidence threshold with them.
        world, conf, images = self.predictions()
        keep = np.array([True] * 4 + [False] * 4)
        pts, _ = fuse_point_cloud(
            world, images, conf=conf, keep=keep, conf_percentile=50.0
        )
        # Median of the surviving 1..4 is 2.5, so conf 3 and 4 remain.
        self.assertEqual(pts.shape[0], 2)
        np.testing.assert_array_equal(pts, world.reshape(-1, 3)[2:4])

    def test_max_points_caps_without_reordering(self):
        world = np.arange(100 * 3, dtype=np.float32).reshape(1, 10, 10, 3)
        images = frames_chw([[0.5, 0.5, 0.5]], 10, 10)
        pts, cols = fuse_point_cloud(
            world, images, conf=None, conf_percentile=0.0, max_points=10
        )
        self.assertEqual(pts.shape[0], 10)
        self.assertEqual(cols.shape[0], 10)
        np.testing.assert_array_equal(pts[0], world.reshape(-1, 3)[0])
        np.testing.assert_array_equal(pts[-1], world.reshape(-1, 3)[-1])

    def test_voxel_merge_runs_before_the_cap(self):
        world = np.zeros((1, 4, 4, 3), dtype=np.float32)
        images = frames_chw([[0.0, 0.0, 1.0]], 4, 4)
        pts, cols = fuse_point_cloud(
            world, images, conf=None, conf_percentile=0.0, voxel_size=1.0
        )
        self.assertEqual(pts.shape[0], 1)
        np.testing.assert_array_equal(cols[0], [0, 0, 255])


class PlyRoundTripTest(unittest.TestCase):
    def test_header_and_body_survive_a_real_reader(self):
        pts = np.array([[0.0, 1.5, -2.25], [10.0, 0.0, 3.75]], dtype=np.float32)
        cols = np.array([[255, 128, 0], [1, 2, 3]], dtype=np.uint8)
        data = write_ply(pts, cols)
        self.assertTrue(data.startswith(b"ply\n"))
        self.assertIn(b"element vertex 2\n", data)
        self.assertIn(b"format binary_little_endian 1.0", data)
        back_pts, back_cols = read_ply(data)
        np.testing.assert_array_equal(back_pts, pts)
        np.testing.assert_array_equal(back_cols, cols)

    def test_body_is_exactly_15_bytes_per_vertex(self):
        pts = np.zeros((7, 3), dtype=np.float32)
        cols = np.zeros((7, 3), dtype=np.uint8)
        data = write_ply(pts, cols)
        header_len = data.find(b"end_header\n") + len(b"end_header\n")
        self.assertEqual(len(data) - header_len, 7 * 15)

    def test_empty_cloud_writes_a_valid_zero_vertex_file(self):
        data = write_ply(np.zeros((0, 3), np.float32), np.zeros((0, 3), np.uint8))
        pts, cols = read_ply(data)
        self.assertEqual(pts.shape, (0, 3))
        self.assertEqual(cols.shape, (0, 3))


class CorePathSmokeTest(unittest.TestCase):
    """Predictions in, uploadable PLY bytes out, with the sky removed."""

    def test_predictions_to_ply_bytes(self):
        frames, height, width = 3, 8, 8
        rng = np.random.default_rng(3)
        world = rng.standard_normal((frames, height, width, 3)).astype(np.float32) * 2.0
        conf = np.full((frames, height, width), 5.0, dtype=np.float32)
        images = frames_chw([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], height, width)

        # The top two rows of every frame are sky: segmentation zeroes their
        # confidence, which is what reaches fusion as a keep mask.
        sky = np.ones((frames, height, width), dtype=bool)
        sky[:, :2, :] = False
        expected = int(sky.sum())

        pts, cols = fuse_point_cloud(
            world,
            images,
            conf=conf,
            keep=sky,
            conf_percentile=0.0,
            max_points=1_000_000,
        )
        self.assertEqual(pts.shape[0], expected)
        self.assertEqual(cols.shape[0], expected)

        data = write_ply(pts, cols)
        back_pts, back_cols = read_ply(data)
        self.assertEqual(back_pts.shape[0], expected)
        np.testing.assert_allclose(back_pts, pts, atol=0)
        # Colours still track their source frame after the sky rows are cut.
        per_frame = expected // frames
        np.testing.assert_array_equal(back_cols[0], [255, 0, 0])
        np.testing.assert_array_equal(back_cols[per_frame], [0, 255, 0])
        np.testing.assert_array_equal(back_cols[2 * per_frame], [0, 0, 255])


if __name__ == "__main__":
    unittest.main()
