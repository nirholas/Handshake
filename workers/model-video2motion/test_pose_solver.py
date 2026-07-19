"""Deterministic tests for the landmark → rotation solver (no mediapipe)."""

import numpy as np
import pytest

from pose_solver import (
    CLIP_BONES,
    LEFT_ANKLE,
    LEFT_ELBOW,
    LEFT_FOOT_INDEX,
    LEFT_HEEL,
    LEFT_HIP,
    LEFT_INDEX,
    LEFT_KNEE,
    LEFT_PINKY,
    LEFT_SHOULDER,
    LEFT_WRIST,
    LEFT_EAR,
    NOSE,
    RIGHT_ANKLE,
    RIGHT_ELBOW,
    RIGHT_EAR,
    RIGHT_FOOT_INDEX,
    RIGHT_HEEL,
    RIGHT_HIP,
    RIGHT_INDEX,
    RIGHT_KNEE,
    RIGHT_PINKY,
    RIGHT_SHOULDER,
    RIGHT_WRIST,
    FINGER_BONES,
    image_anchors,
    landmarks_to_clip,
    match_hands_to_sides,
    solve_frame,
)


def t_pose_world() -> np.ndarray:
    """A synthetic T-pose in MEDIAPIPE world convention (y DOWN, z toward
    camera), person facing the camera. Hip centre at the origin.

    Facing the camera, the person's left side sits at image/world -x is wrong:
    mediapipe world x is right in IMAGE space, so the subject's left hand
    appears on the image right → positive x.
    """
    p = np.zeros((33, 3))
    # y is DOWN: head negative, feet positive.
    p[LEFT_HIP] = [0.10, 0.0, 0.0]
    p[RIGHT_HIP] = [-0.10, 0.0, 0.0]
    p[LEFT_SHOULDER] = [0.18, -0.50, 0.0]
    p[RIGHT_SHOULDER] = [-0.18, -0.50, 0.0]
    p[NOSE] = [0.0, -0.72, -0.10]
    p[LEFT_EAR] = [0.07, -0.70, 0.0]
    p[RIGHT_EAR] = [-0.07, -0.70, 0.0]
    # Arms straight out along ±x (T-pose).
    p[LEFT_ELBOW] = [0.45, -0.50, 0.0]
    p[LEFT_WRIST] = [0.70, -0.50, 0.0]
    p[LEFT_INDEX] = [0.80, -0.50, 0.0]
    p[LEFT_PINKY] = [0.79, -0.50, 0.02]
    p[RIGHT_ELBOW] = [-0.45, -0.50, 0.0]
    p[RIGHT_WRIST] = [-0.70, -0.50, 0.0]
    p[RIGHT_INDEX] = [-0.80, -0.50, 0.0]
    p[RIGHT_PINKY] = [-0.79, -0.50, 0.02]
    # Legs straight down (y-down: knees/ankles positive y).
    p[LEFT_KNEE] = [0.10, 0.45, 0.0]
    p[LEFT_ANKLE] = [0.10, 0.90, 0.0]
    p[LEFT_HEEL] = [0.10, 0.95, 0.03]
    p[LEFT_FOOT_INDEX] = [0.10, 0.95, -0.12]
    p[RIGHT_KNEE] = [-0.10, 0.45, 0.0]
    p[RIGHT_ANKLE] = [-0.10, 0.90, 0.0]
    p[RIGHT_HEEL] = [-0.10, 0.95, 0.03]
    p[RIGHT_FOOT_INDEX] = [-0.10, 0.95, -0.12]
    return p


def _rig(p_world: np.ndarray) -> np.ndarray:
    from pose_solver import _to_rig_space

    return _to_rig_space(p_world[None, ...])[0]


def _angle(q: np.ndarray) -> float:
    return float(2.0 * np.arccos(np.clip(abs(q[3]), -1.0, 1.0)))


def test_t_pose_is_near_identity():
    sol = solve_frame(_rig(t_pose_world()))
    for bone in CLIP_BONES:
        q = sol["locals"][bone]
        assert _angle(q) < np.deg2rad(12.0), f"{bone} deviates {np.rad2deg(_angle(q)):.1f}° in T-pose"


def test_squat_bends_knees_not_arms():
    p = t_pose_world()
    # Deep knee bend: knees come forward (toward camera = world -z), ankles stay.
    p[LEFT_KNEE] = [0.10, 0.30, -0.30]
    p[RIGHT_KNEE] = [-0.10, 0.30, -0.30]
    sol = solve_frame(_rig(p))
    assert _angle(sol["locals"]["LeftUpLeg"]) > np.deg2rad(20.0)
    assert _angle(sol["locals"]["LeftLeg"]) > np.deg2rad(20.0)
    assert _angle(sol["locals"]["LeftArm"]) < np.deg2rad(12.0)


def test_arm_raise_isolated_to_arm():
    p = t_pose_world()
    # Left arm straight up (y-down world: up = negative y).
    p[LEFT_ELBOW] = [0.18, -0.80, 0.0]
    p[LEFT_WRIST] = [0.18, -1.05, 0.0]
    p[LEFT_INDEX] = [0.18, -1.15, 0.0]
    p[LEFT_PINKY] = [0.20, -1.14, 0.0]
    sol = solve_frame(_rig(p))
    assert _angle(sol["locals"]["LeftArm"]) > np.deg2rad(60.0)
    assert _angle(sol["locals"]["RightArm"]) < np.deg2rad(12.0)
    assert _angle(sol["locals"]["LeftUpLeg"]) < np.deg2rad(12.0)


def test_turned_person_rotates_hips():
    p = t_pose_world()
    # Rotate everything 90° about the vertical axis (person faces image left).
    c, s = 0.0, 1.0
    rot = np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])
    p = p @ rot.T
    sol = solve_frame(_rig(p))
    assert _angle(sol["locals"]["Hips"]) > np.deg2rad(60.0)


def test_clip_shape_and_continuity():
    frames = []
    base = t_pose_world()
    for t in range(30):
        p = base.copy()
        lift = 0.25 * np.sin(t / 29.0 * np.pi)
        p[LEFT_ELBOW][1] -= lift
        p[LEFT_WRIST][1] -= 1.6 * lift
        p[LEFT_INDEX][1] -= 1.7 * lift
        p[LEFT_PINKY][1] -= 1.7 * lift
        frames.append(p)
    clip = landmarks_to_clip(np.stack(frames), fps=30, name="wave test")
    assert clip["duration"] == pytest.approx(29 / 30)
    track_names = {t["name"] for t in clip["tracks"]}
    assert f"Hips.quaternion" in track_names
    assert "Hips.position" in track_names
    assert len(track_names) == len(CLIP_BONES) + 1
    for track in clip["tracks"]:
        if track["type"] != "quaternion":
            continue
        vals = np.asarray(track["values"]).reshape(-1, 4)
        assert np.allclose(np.linalg.norm(vals, axis=1), 1.0, atol=1e-6)
        # Hemisphere continuity: consecutive quaternions never anti-parallel.
        dots = np.sum(vals[1:] * vals[:-1], axis=1)
        assert np.all(dots > -0.5)


def test_clip_deterministic():
    frames = np.stack([t_pose_world()] * 5)
    a = landmarks_to_clip(frames, fps=24, name="same")
    b = landmarks_to_clip(frames, fps=24, name="same")
    assert a == b


def test_rejects_bad_shapes():
    with pytest.raises(ValueError):
        landmarks_to_clip(np.zeros((5, 10, 3)), fps=30)
    with pytest.raises(ValueError):
        landmarks_to_clip(np.zeros((0, 33, 3)), fps=30)
    with pytest.raises(ValueError):
        landmarks_to_clip(np.zeros((5, 33, 3)), fps=0)


def flat_hand_world(side: str) -> np.ndarray:
    """A synthetic flat hand in MEDIAPIPE convention (y DOWN, z toward camera
    is negative z), matching the T-pose: palm down, fingers along ±x, thumb
    splayed toward the camera. Should solve to near-identity finger locals.
    """
    s = 1.0 if side == "Left" else -1.0
    h = np.zeros((21, 3))
    w = np.array([s * 0.70, -0.50, 0.0])
    h[0] = w
    mcps = {5: -0.025, 9: 0.0, 13: 0.022, 17: 0.045}
    for base, z in mcps.items():
        h[base] = w + [s * 0.09, 0.0, z]
        for j in range(1, 4):
            h[base + j] = h[base] + [s * 0.035 * j, 0.0, 0.0]
    thumb_dir = np.array([s * 0.707, 0.0, -0.707])
    h[1] = w + [s * 0.025, 0.0, -0.03]
    for j, step in ((2, 0.035), (3, 0.065), (4, 0.09)):
        h[j] = h[1] + step * thumb_dir
    return h


def test_flat_hands_near_identity():
    hands = {"Left": _rig(flat_hand_world("Left")), "Right": _rig(flat_hand_world("Right"))}
    sol = solve_frame(_rig(t_pose_world()), None, hands)
    for bone in FINGER_BONES:
        q = sol["locals"][bone]
        assert _angle(q) < np.deg2rad(15.0), f"{bone} deviates {np.rad2deg(_angle(q)):.1f}° on a flat hand"
    for side in ("Left", "Right"):
        assert _angle(sol["locals"][f"{side}Hand"]) < np.deg2rad(15.0)


def test_curled_finger_hinges_about_z():
    h = flat_hand_world("Left")
    # Bend the index 90° toward the palm at the PIP (palm down → curl is +y in
    # the y-down mediapipe convention); the tip continues in the bent direction.
    h[7] = h[6] + [0.0, 0.035, 0.0]
    h[8] = h[7] + [0.0, 0.030, 0.0]
    hands = {"Left": _rig(h), "Right": None}
    sol = solve_frame(_rig(t_pose_world()), None, hands)
    q = sol["locals"]["LeftHandIndex2"]
    assert _angle(q) > np.deg2rad(60.0)
    axis = np.abs(q[:3]) / max(np.linalg.norm(q[:3]), 1e-9)
    assert axis[2] > 0.9, f"index hinge should be about z; axis={axis}"
    assert _angle(sol["locals"]["LeftHandIndex1"]) < np.deg2rad(15.0)
    assert _angle(sol["locals"]["LeftHandIndex3"]) < np.deg2rad(15.0)
    # The undetected right hand holds rest, not garbage.
    assert _angle(sol["locals"]["RightHandIndex2"]) < 1e-6


def test_clip_with_hands_carries_finger_tracks():
    frames = np.stack([t_pose_world()] * 6)
    hands = np.full((6, 2, 21, 3), np.nan)
    for t in range(6):
        hands[t, 0] = flat_hand_world("Left")
    clip = landmarks_to_clip(frames, fps=24, name="hands", hands=hands)
    track_names = {t["name"] for t in clip["tracks"]}
    for bone in FINGER_BONES:
        assert f"{bone}.quaternion" in track_names
    assert len(track_names) == len(CLIP_BONES) + len(FINGER_BONES) + 1
    for track in clip["tracks"]:
        if track["type"] != "quaternion":
            continue
        vals = np.asarray(track["values"]).reshape(-1, 4)
        assert np.allclose(np.linalg.norm(vals, axis=1), 1.0, atol=1e-6)
        # The never-detected right hand holds its canonical bind local (not
        # identity — the clip is authored in the canonical rig convention) for
        # the whole clip: every frame equals frame 0.
        if track["name"].startswith("RightHandIndex"):
            assert np.allclose(vals - vals[0], 0.0, atol=1e-6)
    b = landmarks_to_clip(frames, fps=24, name="hands", hands=hands)
    assert clip == b


def test_rest_pose_emits_canonical_bind_local():
    """A person at the reference rest pose must author each keyframe as the
    canonical rig's BIND local (e.g. LeftUpLeg ~180° about Z), not identity —
    otherwise the browser retarget folds the skeleton (the shipped-broken bug).
    """
    from canonical_rest import REST_LOCAL

    frames = np.stack([t_pose_world()] * 4)
    clip = landmarks_to_clip(frames, fps=24, name="rest")
    tracks = {t["name"].split(".")[0]: t for t in clip["tracks"] if t["type"] == "quaternion"}
    for bone in ("LeftUpLeg", "RightUpLeg", "LeftArm", "Hips", "Spine"):
        got = np.asarray(tracks[bone]["values"]).reshape(-1, 4)[0]
        want = np.asarray(REST_LOCAL[bone])
        # quaternion equality up to sign
        assert abs(abs(float(np.dot(got, want))) - 1.0) < 2e-2, (
            f"{bone} rest should be its canonical bind local {want}, got {got}"
        )
    # LeftUpLeg's canonical bind is a ~180° flip — the exact thing identity got wrong.
    up = np.asarray(tracks["LeftUpLeg"]["values"]).reshape(-1, 4)[0]
    assert abs(up[3]) < 0.1, "LeftUpLeg bind must be a large rotation, not identity"


def test_clip_without_hands_unchanged():
    frames = np.stack([t_pose_world()] * 4)
    clip = landmarks_to_clip(frames, fps=24, name="nohands")
    track_names = {t["name"] for t in clip["tracks"]}
    assert len(track_names) == len(CLIP_BONES) + 1
    assert not any("Index" in n or "Thumb" in n for n in track_names)


def test_clip_rejects_bad_hands_shape():
    frames = np.stack([t_pose_world()] * 4)
    with pytest.raises(ValueError):
        landmarks_to_clip(frames, fps=24, hands=np.zeros((3, 2, 21, 3)))
    with pytest.raises(ValueError):
        landmarks_to_clip(frames, fps=24, hands=np.zeros((4, 2, 20, 3)))


def test_match_hands_to_sides_by_proximity():
    pose_img = np.zeros((33, 2))
    pose_img[LEFT_WRIST] = [0.70, 0.50]
    pose_img[RIGHT_WRIST] = [0.30, 0.50]
    # Labels deliberately wrong: proximity must win.
    out = match_hands_to_sides([(0.31, 0.52), (0.69, 0.48)], ["Left", "Left"], pose_img)
    assert out == {"Left": 1, "Right": 0}


def test_match_hands_falls_back_to_flipped_label():
    pose_img = np.zeros((33, 2))
    pose_img[LEFT_WRIST] = [0.70, 0.50]
    pose_img[RIGHT_WRIST] = [0.30, 0.50]
    # Too far from either pose wrist → the mirrored-convention label decides:
    # a reported "Left" is the subject's right hand in unmirrored video.
    out = match_hands_to_sides([(0.95, 0.95)], ["Left"], pose_img)
    assert out == {"Left": None, "Right": 0}


def test_image_anchors():
    img = np.zeros((2, 33, 2))
    img[:, LEFT_HIP] = [0.55, 0.55]
    img[:, RIGHT_HIP] = [0.45, 0.55]
    img[:, LEFT_SHOULDER] = [0.57, 0.35]
    img[:, RIGHT_SHOULDER] = [0.43, 0.35]
    img[:, NOSE] = [0.5, 0.2]
    img[:, LEFT_EAR] = [0.52, 0.21]
    img[:, RIGHT_EAR] = [0.48, 0.21]
    img[:, LEFT_ANKLE] = [0.54, 0.92]
    img[:, RIGHT_ANKLE] = [0.46, 0.93]
    vis = np.ones((2, 33))
    vis[1, LEFT_HIP] = vis[1, RIGHT_HIP] = vis[1, LEFT_SHOULDER] = vis[1, RIGHT_SHOULDER] = 0.1
    anchors = image_anchors(img, vis)
    assert anchors[0]["x"] == pytest.approx(0.5)
    assert anchors[0]["y"] == pytest.approx(0.55)
    assert anchors[0]["h"] == pytest.approx(0.73, abs=0.01)
    assert anchors[0]["v"] == 1
    assert anchors[1]["v"] == 0
