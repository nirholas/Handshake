"""Deterministic tests for the MDM decode path: joint positions to local rotations.

`mdm_sampler._decode_to_smpl` is the riskiest code in this worker: it takes what
the diffusion model actually emits (global joint POSITIONS, via upstream's
`recover_from_ric`) and recovers the local joint ROTATIONS a three.js clip needs.
Everything in that recovery except the two upstream calls is pure NumPy, so it is
testable here without torch, a GPU, or the checkpoint.

The load-bearing property is a forward/inverse round trip: run known local
rotations through forward kinematics to get positions, feed those positions to
`_positions_to_local_quats`, and the recovered rotations must reproduce the same
positions. Comparing rotations directly would fail spuriously on single-child
joints, whose twist about their own bone axis leaves no trace in position data
(the ambiguity is inherent to the representation, not to this implementation),
so the round trip is asserted on positions, which is exactly what a viewer sees.

Run (from this directory):
    python3 -m unittest discover -p 'test_*.py'
"""

from __future__ import annotations

import math
import unittest

import numpy as np

from mdm_sampler import (
    _kabsch_quat,
    _parents_from_kinematic_chain,
    _positions_to_local_quats,
    _quat_multiply,
    _quat_rotate,
    _quat_to_axis_angle,
    _resample,
)
from smpl_to_clip import axis_angle_to_quaternion, smpl_motion_to_clip

# The HumanML3D 22-joint topology MDM samples on, as limb chains rooted at joint
# 0, the same shape as upstream's `data_loaders.humanml.utils.paramUtil
# .t2m_kinematic_chain`, which the worker reads at runtime. Held here as a
# fixture so the decode math is testable without the MDM repo checked out; the
# assertions below are round-trip properties, so they hold for any topology of
# this shape rather than depending on these exact indices.
T2M_CHAINS = [
    [0, 2, 5, 8, 11],  # right leg
    [0, 1, 4, 7, 10],  # left leg
    [0, 3, 6, 9, 12, 15],  # spine → head
    [9, 14, 17, 19, 21],  # right arm
    [9, 13, 16, 18, 20],  # left arm
]
N_JOINTS = 22


def _rest_directions(parents: np.ndarray) -> np.ndarray:
    """Unit rest direction of each bone (joint → its parent's frame), T-pose-ish.

    Joint 0 has no bone, so its row is unused by the solver and stays zero-free
    (an arbitrary unit vector) to keep normalization well defined.
    """
    dirs = np.zeros((len(parents), 3), dtype=np.float64)
    dirs[0] = [0.0, 1.0, 0.0]
    for j in range(1, len(parents)):
        if j in (1, 2):  # hips → upper legs, splayed outward and down
            dirs[j] = [-1.0 if j == 1 else 1.0, -0.6, 0.0]
        elif j in (13, 14):  # chest → shoulders, straight out sideways
            dirs[j] = [-1.0 if j == 13 else 1.0, 0.2, 0.0]
        elif j in (16, 17, 18, 19, 20, 21):  # arms continue sideways
            dirs[j] = [-1.0 if j % 2 == 0 else 1.0, 0.0, 0.0]
        elif j in (10, 11):  # toes point forward
            dirs[j] = [0.0, -0.2, 1.0]
        elif j in (4, 5, 7, 8):  # legs continue downward
            dirs[j] = [0.0, -1.0, 0.0]
        else:  # spine, neck, head: up
            dirs[j] = [0.0, 1.0, 0.0]
    return dirs / np.linalg.norm(dirs, axis=-1, keepdims=True)


def _forward_kinematics(
    local_quat: np.ndarray, parents: np.ndarray, rest_dirs: np.ndarray, bone_len: np.ndarray
) -> np.ndarray:
    """(T,J,4) local rotations → (T,J,3) global joint positions.

    The exact convention `_positions_to_local_quats` inverts: a joint's global
    orientation is its parent's composed with its own local rotation, and a
    bone's world offset is its rest direction rotated by the PARENT joint's
    global orientation.
    """
    n_frames, n_joints, _ = local_quat.shape
    global_quat = np.tile(np.array([0.0, 0.0, 0.0, 1.0]), (n_frames, n_joints, 1))
    positions = np.zeros((n_frames, n_joints, 3), dtype=np.float64)
    for j in range(n_joints):
        if j == 0:
            global_quat[:, j] = local_quat[:, j]
            continue
        p = parents[j]
        global_quat[:, j] = _quat_multiply(global_quat[:, p], local_quat[:, j])
        offset = np.broadcast_to(rest_dirs[j] * bone_len[j], (n_frames, 3))
        positions[:, j] = positions[:, p] + _quat_rotate(global_quat[:, p], offset)
    return positions


def _random_local_quats(n_frames: int, n_joints: int, seed: int, scale: float = 0.4) -> np.ndarray:
    rng = np.random.default_rng(seed)
    aa = rng.standard_normal((n_frames, n_joints, 3)) * scale
    return axis_angle_to_quaternion(aa)


class KinematicChainTest(unittest.TestCase):
    def test_flattens_chains_to_parents(self):
        parents = _parents_from_kinematic_chain([[0, 1, 2], [0, 3, 4, 5]], 6)
        np.testing.assert_array_equal(parents, [-1, 0, 1, 0, 3, 4])

    def test_root_has_no_parent(self):
        parents = _parents_from_kinematic_chain(T2M_CHAINS, N_JOINTS)
        self.assertEqual(parents[0], -1)
        self.assertEqual(int((parents == -1).sum()), 1)

    def test_every_joint_is_reachable_from_the_root(self):
        parents = _parents_from_kinematic_chain(T2M_CHAINS, N_JOINTS)
        for j in range(1, N_JOINTS):
            seen, cur = 0, j
            while cur != 0 and seen <= N_JOINTS:
                cur = parents[cur]
                seen += 1
            self.assertEqual(cur, 0, f"joint {j} does not chain back to the root")

    def test_parents_precede_children(self):
        # The single top-down pass in `_positions_to_local_quats` depends on this
        # ordering: a joint's parent must already be resolved when it is reached.
        parents = _parents_from_kinematic_chain(T2M_CHAINS, N_JOINTS)
        for j in range(1, N_JOINTS):
            self.assertLess(parents[j], j)


class KabschTest(unittest.TestCase):
    def test_recovers_a_known_rotation(self):
        q = axis_angle_to_quaternion(np.array([0.3, -0.7, 0.2]))
        sources = np.eye(3)[None, :, :]  # (1,3,3): three orthonormal directions
        targets = _quat_rotate(np.broadcast_to(q, (1, 3, 4)), sources)
        recovered = _kabsch_quat(sources, targets)[0]
        # Quaternions double-cover rotations, so compare up to sign.
        if np.dot(recovered, q) < 0:
            recovered = -recovered
        np.testing.assert_allclose(recovered, q, atol=1e-8)

    def test_result_is_a_proper_rotation(self):
        rng = np.random.default_rng(7)
        sources = rng.standard_normal((4, 2, 3))
        sources /= np.linalg.norm(sources, axis=-1, keepdims=True)
        targets = rng.standard_normal((4, 2, 3))
        targets /= np.linalg.norm(targets, axis=-1, keepdims=True)
        quats = _kabsch_quat(sources, targets)
        np.testing.assert_allclose(np.linalg.norm(quats, axis=-1), np.ones(4), atol=1e-8)

    def test_single_direction_aligns_that_direction(self):
        # One child is the common case: the solve degenerates to shortest-arc,
        # which must still land the source exactly on the target.
        source = np.array([[[0.0, 1.0, 0.0]]])
        target = np.array([[[1.0, 0.0, 0.0]]])
        q = _kabsch_quat(source, target)
        np.testing.assert_allclose(_quat_rotate(q, source)[0, 0], target[0, 0], atol=1e-8)


class QuatToAxisAngleTest(unittest.TestCase):
    def test_inverts_axis_angle_to_quaternion(self):
        rng = np.random.default_rng(3)
        aa = rng.standard_normal((25, 3))
        aa = aa / np.linalg.norm(aa, axis=-1, keepdims=True) * rng.uniform(0.05, 2.8, (25, 1))
        np.testing.assert_allclose(_quat_to_axis_angle(axis_angle_to_quaternion(aa)), aa, atol=1e-8)

    def test_identity_maps_to_zero(self):
        q = np.array([[0.0, 0.0, 0.0, 1.0]])
        np.testing.assert_allclose(_quat_to_axis_angle(q), np.zeros((1, 3)), atol=1e-12)

    def test_angle_matches_quaternion_half_angle(self):
        q = axis_angle_to_quaternion(np.array([0.0, math.pi / 2, 0.0]))
        aa = _quat_to_axis_angle(q)
        self.assertAlmostEqual(float(np.linalg.norm(aa)), math.pi / 2, places=9)


class PositionsToLocalQuatsTest(unittest.TestCase):
    def setUp(self):
        self.parents = _parents_from_kinematic_chain(T2M_CHAINS, N_JOINTS)
        self.rest_dirs = _rest_directions(self.parents)
        self.bone_len = np.full(N_JOINTS, 0.4)

    def _round_trip(self, local_quat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        positions = _forward_kinematics(local_quat, self.parents, self.rest_dirs, self.bone_len)
        recovered = _positions_to_local_quats(positions, self.parents, self.rest_dirs)
        replayed = _forward_kinematics(recovered, self.parents, self.rest_dirs, self.bone_len)
        return positions, replayed

    def test_rest_pose_recovers_identity(self):
        local = np.tile(np.array([0.0, 0.0, 0.0, 1.0]), (5, N_JOINTS, 1))
        positions = _forward_kinematics(local, self.parents, self.rest_dirs, self.bone_len)
        recovered = _positions_to_local_quats(positions, self.parents, self.rest_dirs)
        np.testing.assert_allclose(np.abs(recovered[..., 3]), np.ones((5, N_JOINTS)), atol=1e-8)

    def test_position_round_trip(self):
        local = _random_local_quats(6, N_JOINTS, seed=11)
        positions, replayed = self._round_trip(local)
        np.testing.assert_allclose(replayed, positions, atol=1e-8)

    def test_position_round_trip_survives_large_rotations(self):
        local = _random_local_quats(4, N_JOINTS, seed=12, scale=1.2)
        positions, replayed = self._round_trip(local)
        np.testing.assert_allclose(replayed, positions, atol=1e-8)

    def test_output_quaternions_are_unit(self):
        local = _random_local_quats(3, N_JOINTS, seed=13)
        positions = _forward_kinematics(local, self.parents, self.rest_dirs, self.bone_len)
        recovered = _positions_to_local_quats(positions, self.parents, self.rest_dirs)
        np.testing.assert_allclose(np.linalg.norm(recovered, axis=-1), np.ones((3, N_JOINTS)), atol=1e-8)

    def test_leaf_joints_are_identity(self):
        # Hands, feet tips and head have no children, so position data carries no
        # evidence for their rotation and they must stay at rest, not drift.
        local = _random_local_quats(3, N_JOINTS, seed=14)
        positions = _forward_kinematics(local, self.parents, self.rest_dirs, self.bone_len)
        recovered = _positions_to_local_quats(positions, self.parents, self.rest_dirs)
        leaves = [j for j in range(N_JOINTS) if j not in set(self.parents.tolist())]
        self.assertTrue(leaves)
        for leaf in leaves:
            np.testing.assert_allclose(
                recovered[:, leaf], np.tile([0.0, 0.0, 0.0, 1.0], (3, 1)), atol=1e-12
            )

    def test_root_rotation_is_recovered_exactly(self):
        # The root branches into three chains, so Kabsch is fully determined
        # there and its rotation must come back exactly, twist included.
        local = np.tile(np.array([0.0, 0.0, 0.0, 1.0]), (2, N_JOINTS, 1))
        q = axis_angle_to_quaternion(np.array([0.1, 0.9, -0.2]))
        local[:, 0] = q
        positions = _forward_kinematics(local, self.parents, self.rest_dirs, self.bone_len)
        recovered = _positions_to_local_quats(positions, self.parents, self.rest_dirs)[0, 0]
        if np.dot(recovered, q) < 0:
            recovered = -recovered
        np.testing.assert_allclose(recovered, q, atol=1e-8)


class ResampleTest(unittest.TestCase):
    def test_exact_length_is_a_passthrough(self):
        poses = np.arange(24, dtype=np.float64).reshape(4, 2, 3)
        trans = np.zeros((4, 3))
        out_poses, out_trans = _resample(poses, trans, 4)
        self.assertIs(out_poses, poses)
        self.assertIs(out_trans, trans)

    def test_upsample_preserves_endpoints_and_shape(self):
        poses = np.linspace(0.0, 1.0, 5)[:, None, None] * np.ones((1, 22, 3))
        trans = np.linspace(0.0, 2.0, 5)[:, None] * np.ones((1, 3))
        out_poses, out_trans = _resample(poses, trans, 13)
        self.assertEqual(out_poses.shape, (13, 22, 3))
        self.assertEqual(out_trans.shape, (13, 3))
        np.testing.assert_allclose(out_poses[0], poses[0], atol=1e-12)
        np.testing.assert_allclose(out_poses[-1], poses[-1], atol=1e-12)
        np.testing.assert_allclose(out_trans[-1], trans[-1], atol=1e-12)

    def test_downsample_interpolates_linearly(self):
        poses = np.linspace(0.0, 1.0, 9)[:, None, None] * np.ones((1, 1, 3))
        trans = np.linspace(0.0, 1.0, 9)[:, None] * np.ones((1, 3))
        out_poses, out_trans = _resample(poses, trans, 5)
        np.testing.assert_allclose(out_poses[:, 0, 0], [0.0, 0.25, 0.5, 0.75, 1.0], atol=1e-12)
        np.testing.assert_allclose(out_trans[:, 0], [0.0, 0.25, 0.5, 0.75, 1.0], atol=1e-12)


class DecodePipelineSmokeTest(unittest.TestCase):
    """The worker's core path, end to end, minus the two GPU-only upstream calls.

    `_decode_to_smpl` is: recover positions (upstream, torch) → this module's IK →
    axis-angle; `main._run_inference` then hands that to `smpl_motion_to_clip`.
    Feeding the IK positions that upstream would have produced exercises every
    line of that chain the worker owns, and asserts the artifact a browser
    actually loads.
    """

    def test_positions_become_a_valid_animation_clip(self):
        parents = _parents_from_kinematic_chain(T2M_CHAINS, N_JOINTS)
        rest_dirs = _rest_directions(parents)
        local = _random_local_quats(40, N_JOINTS, seed=21)
        positions = _forward_kinematics(local, parents, rest_dirs, np.full(N_JOINTS, 0.4))
        # A moving root, the way sampled motion travels through the world.
        positions += np.linspace(0.0, 1.5, 40)[:, None, None] * np.array([0.0, 0.0, 1.0])

        recovered = _positions_to_local_quats(positions, parents, rest_dirs)
        poses = _quat_to_axis_angle(recovered)
        trans = positions[:, 0, :]
        poses, trans = _resample(poses, trans, 30)

        clip = smpl_motion_to_clip(poses, trans, fps=30, name="smoke")

        self.assertEqual(clip["name"], "smoke")
        self.assertAlmostEqual(clip["duration"], 29 / 30)
        quat_tracks = [t for t in clip["tracks"] if t["type"] == "quaternion"]
        # Every one of the 22 HumanML3D joints maps to a Wolf3D bone.
        self.assertEqual(len(quat_tracks), 22)
        self.assertIn("Hips.quaternion", {t["name"] for t in quat_tracks})
        for track in quat_tracks:
            values = np.array(track["values"]).reshape(-1, 4)
            self.assertEqual(len(values), 30)
            np.testing.assert_allclose(np.linalg.norm(values, axis=1), 1.0, atol=1e-8)

        hips = next(t for t in clip["tracks"] if t["name"] == "Hips.position")
        self.assertEqual(len(hips["values"]), 30 * 3)
        # The root track must carry the travel, not sit at the origin.
        travelled = np.array(hips["values"]).reshape(-1, 3)
        self.assertGreater(float(travelled[-1, 2] - travelled[0, 2]), 1.0)

    def test_static_input_yields_a_still_clip(self):
        parents = _parents_from_kinematic_chain(T2M_CHAINS, N_JOINTS)
        rest_dirs = _rest_directions(parents)
        local = np.tile(np.array([0.0, 0.0, 0.0, 1.0]), (12, N_JOINTS, 1))
        positions = _forward_kinematics(local, parents, rest_dirs, np.full(N_JOINTS, 0.4))
        poses = _quat_to_axis_angle(_positions_to_local_quats(positions, parents, rest_dirs))
        clip = smpl_motion_to_clip(poses, positions[:, 0, :], fps=24, name="still")
        for track in clip["tracks"]:
            if track["type"] != "quaternion":
                continue
            values = np.array(track["values"]).reshape(-1, 4)
            np.testing.assert_allclose(values, np.tile(values[0], (len(values), 1)), atol=1e-9)


if __name__ == "__main__":
    unittest.main()
