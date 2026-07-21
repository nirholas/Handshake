"""Solve BlazePose world landmarks into canonical-skeleton joint rotations.

MediaPipe's PoseLandmarker (VIDEO mode) emits, per frame, 33 world landmarks in
metres with the origin at the hip centre (x right, y DOWN, z toward the camera
in image convention). This module converts a (T, 33, 3) landmark sequence into
per-frame LOCAL joint rotations on the canonical Wolf3D humanoid and emits the
exact ``THREE.AnimationClip.toJSON()`` document the rest of the platform
consumes (identical track shape to workers/model-text2motion/smpl_to_clip.py),
so a motion captured from video retargets onto any rigged avatar with the SAME
engine (src/animation-retarget.js) as a curated preset.

Method: per frame,
  1. flip landmarks into the rig's y-up right-handed space,
  2. build a global orientation for the pelvis and the chest from the hip and
     shoulder lines plus the spine direction,
  3. for each limb segment, build a global orientation that carries its rest
     direction onto the observed parent→child landmark direction, using the
     limb's bend plane (upper/lower segment cross product) to fix the twist
     about the bone axis where the geometry defines it,
  4. convert globals to locals against the parent chain,
  5. smooth landmarks with a fps-aware exponential filter and keep quaternion
     hemisphere continuity across frames.

When HandLandmarker world landmarks are supplied alongside the pose (21 per
hand, same camera convention), the solver additionally replaces the swing-only
wrist orientation with a palm frame and solves all 30 canonical finger bones
(pure-swing hinges in each parent's local frame), so captured clips carry full
hand articulation — the requirement for sign language and fine gesture capture.

In the rig's rest space the character stands in a T-pose facing +Z: spine +Y,
legs -Y, left arm +X, right arm -X, feet +Z. Zero local rotation everywhere
reproduces the rest pose, matching the SMPL-rest convention the text2motion
lane already emits (rest-offset calibration happens downstream, same as there).

Pure NumPy — no mediapipe, no GPU — so the solve is unit-tested
deterministically from synthetic landmark sequences without the model.
"""

from __future__ import annotations

import hashlib
from typing import Optional

import numpy as np

# BlazePose 33-landmark indices (subset used by the solver).
NOSE = 0
LEFT_EAR, RIGHT_EAR = 7, 8
LEFT_SHOULDER, RIGHT_SHOULDER = 11, 12
LEFT_ELBOW, RIGHT_ELBOW = 13, 14
LEFT_WRIST, RIGHT_WRIST = 15, 16
LEFT_PINKY, RIGHT_PINKY = 17, 18
LEFT_INDEX, RIGHT_INDEX = 19, 20
LEFT_HIP, RIGHT_HIP = 23, 24
LEFT_KNEE, RIGHT_KNEE = 25, 26
LEFT_ANKLE, RIGHT_ANKLE = 27, 28
LEFT_HEEL, RIGHT_HEEL = 29, 30
LEFT_FOOT_INDEX, RIGHT_FOOT_INDEX = 31, 32

# HandLandmarker 21-landmark indices (subset used by the finger solver). Each
# finger chain lists the landmark path root→tip; consecutive pairs are the
# three canonical finger bones (e.g. Index MCP→PIP is LeftHandIndex1).
HAND_WRIST = 0
HAND_INDEX_MCP, HAND_MIDDLE_MCP, HAND_PINKY_MCP = 5, 9, 17
_HAND_CHAINS = (
    ("Thumb", (1, 2, 3, 4)),
    ("Index", (5, 6, 7, 8)),
    ("Middle", (9, 10, 11, 12)),
    ("Ring", (13, 14, 15, 16)),
    ("Pinky", (17, 18, 19, 20)),
)

# three.js AnimationBlendMode.NormalAnimationBlendMode
_NORMAL_BLEND_MODE = 2500

_IDENTITY = np.array([0.0, 0.0, 0.0, 1.0])


def _normalize(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    if n < 1e-8:
        return np.zeros_like(v)
    return v / n


def _quat_from_matrix(m: np.ndarray) -> np.ndarray:
    """3x3 rotation matrix → [x,y,z,w] quaternion (Shepperd's method)."""
    t = np.trace(m)
    if t > 0.0:
        s = np.sqrt(t + 1.0) * 2.0
        return np.array(
            [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
        )
    i = int(np.argmax(np.diag(m)))
    if i == 0:
        s = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2.0
        return np.array(
            [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
        )
    if i == 1:
        s = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2.0
        return np.array(
            [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
        )
    s = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2.0
    return np.array(
        [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]
    )


def _quat_multiply(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return np.array(
        [
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        ]
    )


def _quat_conjugate(q: np.ndarray) -> np.ndarray:
    return np.array([-q[0], -q[1], -q[2], q[3]])


def _quat_normalize(q: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(q)
    if n < 1e-8:
        return _IDENTITY.copy()
    return q / n


def _quat_slerp(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    dot = float(np.dot(a, b))
    if dot < 0.0:
        b = -b
        dot = -dot
    if dot > 0.9995:
        return _quat_normalize(a + t * (b - a))
    theta = np.arccos(np.clip(dot, -1.0, 1.0))
    s = np.sin(theta)
    return _quat_normalize((np.sin((1.0 - t) * theta) / s) * a + (np.sin(t * theta) / s) * b)


def _shortest_arc(frm: np.ndarray, to: np.ndarray) -> np.ndarray:
    """Quaternion rotating unit vector `frm` onto unit vector `to`."""
    d = float(np.dot(frm, to))
    if d > 1.0 - 1e-9:
        return _IDENTITY.copy()
    if d < -1.0 + 1e-9:
        # 180°: rotate about any axis perpendicular to `frm`.
        axis = np.cross(frm, np.array([1.0, 0.0, 0.0]))
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(frm, np.array([0.0, 1.0, 0.0]))
        axis = _normalize(axis)
        return np.array([axis[0], axis[1], axis[2], 0.0])
    axis = np.cross(frm, to)
    q = np.array([axis[0], axis[1], axis[2], 1.0 + d])
    return _quat_normalize(q)


def _frame_quat(direction: np.ndarray, bend_normal: np.ndarray, rest_dir: np.ndarray, rest_normal: np.ndarray) -> np.ndarray:
    """Global orientation carrying (rest_dir, rest_normal) onto (direction, bend_normal).

    `direction` fixes the bone axis; `bend_normal` (projected perpendicular to
    the axis) fixes the twist about it. Falls back to swing-only when the
    normal is degenerate (straight limb).
    """
    swing = _shortest_arc(rest_dir, direction)
    n = bend_normal - direction * float(np.dot(bend_normal, direction))
    if np.linalg.norm(n) < 1e-5:
        return swing
    n = _normalize(n)
    carried = _rotate_vec(swing, rest_normal)
    carried = carried - direction * float(np.dot(carried, direction))
    if np.linalg.norm(carried) < 1e-5:
        return swing
    carried = _normalize(carried)
    twist = _shortest_arc(carried, n)
    # Constrain the correction to a pure twist about the bone axis.
    axis_dot = float(np.dot(twist[:3], direction))
    twist = _quat_normalize(np.array([direction[0] * axis_dot, direction[1] * axis_dot, direction[2] * axis_dot, twist[3]]))
    return _quat_multiply(twist, swing)


def _rotate_vec(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    qv = np.array([v[0], v[1], v[2], 0.0])
    return _quat_multiply(_quat_multiply(q, qv), _quat_conjugate(q))[:3]


def _basis_quat(x_axis: np.ndarray, y_hint: np.ndarray) -> np.ndarray:
    """Orthonormal basis quaternion from a trusted X axis and an up hint."""
    x = _normalize(x_axis)
    z = _normalize(np.cross(x, _normalize(y_hint)))
    if np.linalg.norm(z) < 1e-6:
        return _IDENTITY.copy()
    y = np.cross(z, x)
    m = np.stack([x, y, z], axis=1)
    return _quat_normalize(_quat_from_matrix(m))


def _hemisphere(prev: Optional[np.ndarray], q: np.ndarray) -> np.ndarray:
    if prev is not None and float(np.dot(prev, q)) < 0.0:
        return -q
    return q


# (bone, parent, landmarks (a→b) giving the bone direction, rest_dir, rest bend normal or None)
_LIMBS = [
    ("LeftUpLeg", "Hips", LEFT_HIP, LEFT_KNEE, np.array([0.0, -1.0, 0.0])),
    ("LeftLeg", "LeftUpLeg", LEFT_KNEE, LEFT_ANKLE, np.array([0.0, -1.0, 0.0])),
    ("RightUpLeg", "Hips", RIGHT_HIP, RIGHT_KNEE, np.array([0.0, -1.0, 0.0])),
    ("RightLeg", "RightUpLeg", RIGHT_KNEE, RIGHT_ANKLE, np.array([0.0, -1.0, 0.0])),
    ("LeftArm", "Spine2", LEFT_SHOULDER, LEFT_ELBOW, np.array([1.0, 0.0, 0.0])),
    ("LeftForeArm", "LeftArm", LEFT_ELBOW, LEFT_WRIST, np.array([1.0, 0.0, 0.0])),
    ("RightArm", "Spine2", RIGHT_SHOULDER, RIGHT_ELBOW, np.array([-1.0, 0.0, 0.0])),
    ("RightForeArm", "RightArm", RIGHT_ELBOW, RIGHT_WRIST, np.array([-1.0, 0.0, 0.0])),
]

# Bones written to the clip, in a stable order.
CLIP_BONES = [
    "Hips",
    "Spine",
    "Spine1",
    "Spine2",
    "Neck",
    "Head",
    "LeftUpLeg",
    "LeftLeg",
    "LeftFoot",
    "RightUpLeg",
    "RightLeg",
    "RightFoot",
    "LeftArm",
    "LeftForeArm",
    "LeftHand",
    "RightArm",
    "RightForeArm",
    "RightHand",
]

# Finger bones written to the clip when hand landmarks are supplied, in a
# stable order. Names match the canonical set in src/glb-canonicalize.js, so
# these tracks retarget exactly like the baked library clips' finger tracks.
FINGER_BONES = [
    f"{side}Hand{finger}{joint}"
    for side in ("Left", "Right")
    for finger, _ in _HAND_CHAINS
    for joint in (1, 2, 3)
]

_FINGER_PARENTS = {}
for _side in ("Left", "Right"):
    for _finger, _ in _HAND_CHAINS:
        _FINGER_PARENTS[f"{_side}Hand{_finger}1"] = f"{_side}Hand"
        _FINGER_PARENTS[f"{_side}Hand{_finger}2"] = f"{_side}Hand{_finger}1"
        _FINGER_PARENTS[f"{_side}Hand{_finger}3"] = f"{_side}Hand{_finger}2"

# Full canonical parent map (body + fingers), used by the canonical-convention
# authoring below.
_BODY_PARENTS = {
    "Hips": None, "Spine": "Hips", "Spine1": "Spine", "Spine2": "Spine1",
    "Neck": "Spine2", "Head": "Neck",
    "LeftUpLeg": "Hips", "LeftLeg": "LeftUpLeg", "LeftFoot": "LeftLeg",
    "RightUpLeg": "Hips", "RightLeg": "RightUpLeg", "RightFoot": "RightLeg",
    "LeftArm": "Spine2", "LeftForeArm": "LeftArm", "LeftHand": "LeftForeArm",
    "RightArm": "Spine2", "RightForeArm": "RightArm", "RightHand": "RightForeArm",
}
_ALL_PARENTS = {**_BODY_PARENTS, **_FINGER_PARENTS}


# ---------------------------------------------------------------------------
# Canonical-convention authoring
# ---------------------------------------------------------------------------
# The solver computes each bone's WORLD orientation from the landmarks in its own
# y-up rig frame, where identity local = a T-pose. But the browser retarget
# (src/animation-retarget.js) interprets a clip's keyframes as rotations relative
# to the CANONICAL rig bind pose (Mixamo/Wolf3D — legs baked 180° about Z, arms
# in a specific frame; see canonical_rest.REST_LOCAL). Emitting our own T-pose
# convention makes the retarget's world-delta correction reframe every bone into
# garbage (legs fold over the head). So we author each keyframe in the canonical
# convention with the standard world-delta retarget:
#
#     q_canon = WSp⁻¹ · (G · Grest⁻¹) · WSp · Rs
#
# where G is the measured world orientation, Grest the solver's world orientation
# for the SAME bone at the reference rest pose, WSp = REST_WORLD[parent] (parent
# world bind), and Rs = REST_LOCAL[bone] (bone local bind). At rest (G == Grest)
# this returns exactly Rs, so a rest bone emits the canonical bind local and the
# retarget round-trips instead of mangling it.
from canonical_rest import REST_LOCAL, REST_WORLD  # noqa: E402

_REST_GLOBALS_CACHE: Optional[dict] = None


def _reference_rest_pose() -> tuple:
    """Synthetic reference rest: a T-pose facing the camera with flat hands, in
    MediaPipe world convention (y DOWN). Identical geometry to the solver's rest
    assumptions, so solving it yields each bone's rest world orientation."""
    p = np.zeros((33, 3))
    p[LEFT_HIP] = [0.10, 0.0, 0.0]; p[RIGHT_HIP] = [-0.10, 0.0, 0.0]
    p[LEFT_SHOULDER] = [0.18, -0.50, 0.0]; p[RIGHT_SHOULDER] = [-0.18, -0.50, 0.0]
    p[NOSE] = [0.0, -0.72, -0.10]
    p[LEFT_EAR] = [0.07, -0.70, 0.0]; p[RIGHT_EAR] = [-0.07, -0.70, 0.0]
    p[LEFT_ELBOW] = [0.45, -0.50, 0.0]; p[LEFT_WRIST] = [0.70, -0.50, 0.0]
    p[LEFT_INDEX] = [0.80, -0.50, 0.0]; p[LEFT_PINKY] = [0.79, -0.50, 0.02]
    p[RIGHT_ELBOW] = [-0.45, -0.50, 0.0]; p[RIGHT_WRIST] = [-0.70, -0.50, 0.0]
    p[RIGHT_INDEX] = [-0.80, -0.50, 0.0]; p[RIGHT_PINKY] = [-0.79, -0.50, 0.02]
    p[LEFT_KNEE] = [0.10, 0.45, 0.0]; p[LEFT_ANKLE] = [0.10, 0.90, 0.0]
    p[LEFT_HEEL] = [0.10, 0.95, 0.03]; p[LEFT_FOOT_INDEX] = [0.10, 0.95, -0.12]
    p[RIGHT_KNEE] = [-0.10, 0.45, 0.0]; p[RIGHT_ANKLE] = [-0.10, 0.90, 0.0]
    p[RIGHT_HEEL] = [-0.10, 0.95, 0.03]; p[RIGHT_FOOT_INDEX] = [-0.10, 0.95, -0.12]

    def flat_hand(side: str) -> np.ndarray:
        s = 1.0 if side == "Left" else -1.0
        h = np.zeros((21, 3))
        w = np.array([s * 0.70, -0.50, 0.0]); h[0] = w
        for base, z in {5: -0.025, 9: 0.0, 13: 0.022, 17: 0.045}.items():
            h[base] = w + [s * 0.09, 0.0, z]
            for j in range(1, 4):
                h[base + j] = h[base] + [s * 0.035 * j, 0.0, 0.0]
        thumb = np.array([s * 0.707, 0.0, -0.707])
        h[1] = w + [s * 0.025, 0.0, -0.03]
        for j, step in ((2, 0.035), (3, 0.065), (4, 0.09)):
            h[j] = h[1] + step * thumb
        return h

    hands = np.stack([flat_hand("Left"), flat_hand("Right")])
    return p, hands


def _rest_globals() -> dict:
    global _REST_GLOBALS_CACHE
    if _REST_GLOBALS_CACHE is None:
        pose, hands = _reference_rest_pose()
        rig = _to_rig_space(pose[None, ...])[0]
        rig_hands = _to_rig_space(hands)
        frame_hands = {side: rig_hands[i] for i, side in enumerate(("Left", "Right"))}
        _REST_GLOBALS_CACHE = solve_frame(rig, None, frame_hands)["globals"]
    return _REST_GLOBALS_CACHE


def _to_canonical_local(bone: str, g: np.ndarray, rest_globals: dict) -> np.ndarray:
    """World orientation `g` of `bone` → canonical-convention local keyframe."""
    rs = REST_LOCAL.get(bone)
    if rs is None:
        return _IDENTITY.copy()
    rs = np.asarray(rs, dtype=np.float64)
    grest = rest_globals.get(bone)
    if grest is None:
        return rs
    # D = g · grest⁻¹  (physical world delta from rest)
    delta = _quat_multiply(g, _quat_conjugate(grest))
    parent = _ALL_PARENTS.get(bone)
    wsp = np.asarray(REST_WORLD[parent], dtype=np.float64) if parent else _IDENTITY
    wsp_inv = _quat_conjugate(wsp)
    q = _quat_multiply(_quat_multiply(_quat_multiply(wsp_inv, delta), wsp), rs)
    return _quat_normalize(q)


def _smooth_quaternion_track(values: np.ndarray, fps: float) -> np.ndarray:
    """One-Euro low-pass on a (T,4) quaternion track: heavy smoothing when the
    joint is near-still (kills tracking jitter), light when it moves fast (keeps
    real motion crisp). Operates by slerping toward each raw sample with an
    adaptive factor derived from the local angular velocity."""
    n = values.shape[0]
    if n < 3:
        return values
    # One-Euro params tuned for markerless pose: heavy smoothing at rest,
    # loosening only for genuine fast motion. A single-frame spike beyond
    # SPIKE_DEG (occlusion teleport, not real motion) is rejected — the filter
    # holds and catches up over the next frames instead of snapping.
    min_cutoff, beta = 0.8, 0.025
    SPIKE_DEG = 45.0
    out = values.copy()
    prev = values[0].copy()
    prev_speed = 0.0
    for t in range(1, n):
        raw = values[t]
        if float(np.dot(prev, raw)) < 0.0:
            raw = -raw
        dot = float(np.clip(abs(np.dot(prev, raw)), -1.0, 1.0))
        step_deg = np.degrees(2.0 * np.arccos(dot))
        speed = np.radians(step_deg) * fps  # rad/s
        prev_speed = 0.7 * prev_speed + 0.3 * speed
        cutoff = min_cutoff + beta * np.degrees(prev_speed)
        tau = 1.0 / (2.0 * np.pi * cutoff)
        alpha = 1.0 / (1.0 + tau * fps)
        if step_deg > SPIKE_DEG:
            alpha = min(alpha, 0.25)  # suspected teleport: ease in, don't snap
        prev = _quat_slerp(prev, raw, float(np.clip(alpha, 0.04, 1.0)))
        out[t] = prev
    return out


def smooth_landmarks(world: np.ndarray, fps: float, cutoff_hz: float = 4.0) -> np.ndarray:
    """fps-aware exponential smoothing over the time axis of (T, 33, 3)."""
    world = np.asarray(world, dtype=np.float64)
    if world.shape[0] < 2 or fps <= 0:
        return world
    alpha = 1.0 - np.exp(-2.0 * np.pi * cutoff_hz / fps)
    alpha = float(np.clip(alpha, 0.05, 1.0))
    out = world.copy()
    for t in range(1, world.shape[0]):
        out[t] = out[t - 1] + alpha * (world[t] - out[t - 1])
    return out


def _to_rig_space(world: np.ndarray) -> np.ndarray:
    """MediaPipe world space (x right, y down, z toward camera) → rig space
    (y up, character facing the camera along +Z)."""
    out = world.copy()
    out[..., 1] *= -1.0
    out[..., 2] *= -1.0
    return out


def match_hands_to_sides(
    hand_wrists: list, labels: list, pose_image: np.ndarray, max_dist: float = 0.25
) -> dict:
    """Assign detected hands to the subject's Left/Right side.

    `hand_wrists` are normalized image (x, y) positions of each detected hand's
    wrist landmark; `labels` the model's handedness strings; `pose_image` one
    frame of (33, 2+) pose image landmarks. Proximity to the pose wrists is the
    primary signal because it cannot be confused by mirroring. The handedness
    label is only a fallback, FLIPPED: Tasks-API handedness assumes a mirrored
    selfie image, and the videos here are unmirrored. Returns
    {"Left": index|None, "Right": index|None} into the detected-hand list.
    """
    targets = {
        "Left": np.asarray(pose_image[LEFT_WRIST][:2], dtype=np.float64),
        "Right": np.asarray(pose_image[RIGHT_WRIST][:2], dtype=np.float64),
    }
    pairs = sorted(
        (float(np.linalg.norm(np.asarray(hand_wrists[i][:2], dtype=np.float64) - t)), i, side)
        for i in range(len(hand_wrists))
        for side, t in targets.items()
    )
    out = {"Left": None, "Right": None}
    used: set[int] = set()
    for dist, i, side in pairs:
        if dist > max_dist:
            break
        if out[side] is None and i not in used:
            out[side] = i
            used.add(i)
    for i in range(len(hand_wrists)):
        if i in used:
            continue
        side = {"Left": "Right", "Right": "Left"}.get(labels[i] if i < len(labels) else None)
        if side and out[side] is None:
            out[side] = i
            used.add(i)
    return out


def _solve_hand(pts: np.ndarray, side: str, g: dict) -> None:
    """Solve one hand's (21, 3) rig-space landmarks into global orientations.

    Overwrites g["{side}Hand"] with a palm-frame orientation (the pose-only
    solve is swing-only; the palm plane pins the wrist twist, which finger
    poses depend on) and adds a global for each of the 15 finger bones.

    Finger joints are solved as pure swing in the parent's local frame: in the
    canonical rest every finger segment runs along the hand axis (thumb along
    its splayed axis), so the parent-local observed direction against that rest
    direction gives a hinge rotation about the anatomically correct axis with
    no twist accumulation down the chain.
    """
    sign = 1.0 if side == "Left" else -1.0
    axis_rest = np.array([sign, 0.0, 0.0])
    w = pts[HAND_WRIST]
    hand_dir = _normalize(pts[HAND_MIDDLE_MCP] - w)
    if np.linalg.norm(hand_dir) < 1e-6:
        return
    # Back-of-hand normal from the knuckle spread; +Y in the rest pose (T-pose
    # arms out, palms down). The cross product flips chirality per side.
    back = np.cross(pts[HAND_INDEX_MCP] - w, pts[HAND_PINKY_MCP] - w) * sign
    g[f"{side}Hand"] = _frame_quat(hand_dir, back, axis_rest, np.array([0.0, 1.0, 0.0]))
    # Rest thumb: splayed ~45° from the fingers toward the palm-forward (+Z)
    # direction. The retarget engine's per-bone bind correction absorbs the
    # residual mismatch against a specific rig's bind thumb, same as elsewhere.
    thumb_rest = _normalize(np.array([sign, 0.0, 1.0]))
    for finger, chain in _HAND_CHAINS:
        rest = thumb_rest if finger == "Thumb" else axis_rest
        parent_g = g[f"{side}Hand"]
        for joint in range(3):
            bone = f"{side}Hand{finger}{joint + 1}"
            d = _normalize(pts[chain[joint + 1]] - pts[chain[joint]])
            if np.linalg.norm(d) < 1e-6:
                g[bone] = parent_g.copy()
            else:
                d_local = _normalize(_rotate_vec(_quat_conjugate(parent_g), d))
                g[bone] = _quat_multiply(parent_g, _shortest_arc(rest, d_local))
            parent_g = g[bone]


def solve_frame(p: np.ndarray, prev: Optional[dict] = None, hands: Optional[dict] = None) -> dict:
    """Solve one frame of rig-space landmarks (33, 3) → {bone: [x,y,z,w]} locals."""
    hip_c = 0.5 * (p[LEFT_HIP] + p[RIGHT_HIP])
    sho_c = 0.5 * (p[LEFT_SHOULDER] + p[RIGHT_SHOULDER])
    spine_up = _normalize(sho_c - hip_c)
    if np.linalg.norm(spine_up) < 1e-6:
        spine_up = np.array([0.0, 1.0, 0.0])

    g = {}  # bone → global quaternion
    g["Hips"] = _basis_quat(p[LEFT_HIP] - p[RIGHT_HIP], spine_up)
    chest = _basis_quat(p[LEFT_SHOULDER] - p[RIGHT_SHOULDER], spine_up)

    # Distribute the pelvis→chest relative rotation across the spine chain.
    rel = _quat_multiply(_quat_conjugate(g["Hips"]), chest)
    step = _quat_slerp(_IDENTITY, rel, 1.0 / 3.0)
    g["Spine"] = _quat_multiply(g["Hips"], step)
    g["Spine1"] = _quat_multiply(g["Spine"], step)
    g["Spine2"] = chest

    # Head from the ear line and the ear-midpoint→nose forward vector.
    ear_c = 0.5 * (p[LEFT_EAR] + p[RIGHT_EAR])
    head_fwd = _normalize(p[NOSE] - ear_c)
    head_x = p[LEFT_EAR] - p[RIGHT_EAR]
    if np.linalg.norm(head_fwd) > 1e-6 and np.linalg.norm(head_x) > 1e-6:
        head_up = _normalize(np.cross(head_fwd, _normalize(head_x)))
        if float(np.dot(head_up, spine_up)) < 0.0:
            head_up = -head_up
        head_g = _basis_quat(head_x, head_up)
    else:
        head_g = chest.copy()
    g["Neck"] = _quat_slerp(chest, head_g, 0.5)
    g["Head"] = head_g

    # Limbs: bend-plane normal from the upper/lower segment cross product.
    limb_pairs = {
        "LeftUpLeg": ("LeftLeg", LEFT_HIP, LEFT_KNEE, LEFT_ANKLE),
        "RightUpLeg": ("RightLeg", RIGHT_HIP, RIGHT_KNEE, RIGHT_ANKLE),
        "LeftArm": ("LeftForeArm", LEFT_SHOULDER, LEFT_ELBOW, LEFT_WRIST),
        "RightArm": ("RightForeArm", RIGHT_SHOULDER, RIGHT_ELBOW, RIGHT_WRIST),
    }
    bend_normals = {}
    for upper, (lower, a, b, c) in limb_pairs.items():
        d_up = _normalize(p[b] - p[a])
        d_lo = _normalize(p[c] - p[b])
        n = np.cross(d_up, d_lo)
        bend_normals[upper] = n
        bend_normals[lower] = n

    # Rest bend normals in T-pose: knees hinge about the pelvis X axis; elbows
    # about the world -Z when arms are out (forearm folds toward the chest).
    rest_normals = {
        "LeftUpLeg": np.array([1.0, 0.0, 0.0]),
        "LeftLeg": np.array([1.0, 0.0, 0.0]),
        "RightUpLeg": np.array([1.0, 0.0, 0.0]),
        "RightLeg": np.array([1.0, 0.0, 0.0]),
        "LeftArm": np.array([0.0, 0.0, -1.0]),
        "LeftForeArm": np.array([0.0, 0.0, -1.0]),
        "RightArm": np.array([0.0, 0.0, -1.0]),
        "RightForeArm": np.array([0.0, 0.0, -1.0]),
    }

    for bone, parent, a, b, rest_dir in _LIMBS:
        d = _normalize(p[b] - p[a])
        if np.linalg.norm(d) < 1e-6:
            g[bone] = g[parent].copy()
            continue
        n = bend_normals.get(bone, np.zeros(3))
        if np.linalg.norm(n) < 1e-4 and prev is not None and bone in prev.get("globals", {}):
            # Straight limb: keep last frame's twist rather than snapping.
            swing = _shortest_arc(_rotate_vec(prev["globals"][bone], rest_dir), d)
            g[bone] = _quat_multiply(swing, prev["globals"][bone])
        else:
            g[bone] = _frame_quat(d, n, rest_dir, rest_normals[bone])

    # Feet: ankle → foot-index. The rest foot bone points forward and ~27°
    # down (ankle sits above the toes), matching humanoid rig conventions.
    foot_rest = _normalize(np.array([0.0, -0.5, 1.0]))
    for foot, parent, a, b, rest_dir in (
        ("LeftFoot", "LeftLeg", LEFT_ANKLE, LEFT_FOOT_INDEX, foot_rest),
        ("RightFoot", "RightLeg", RIGHT_ANKLE, RIGHT_FOOT_INDEX, foot_rest),
    ):
        d = _normalize(p[b] - p[a])
        g[foot] = _frame_quat(d, np.array([0.0, 1.0, 0.0]), rest_dir, np.array([0.0, 1.0, 0.0])) if np.linalg.norm(d) > 1e-6 else g[parent].copy()

    # Hands: wrist → mid(index, pinky), swing only.
    for hand, parent, w, i, k, rest_dir in (
        ("LeftHand", "LeftForeArm", LEFT_WRIST, LEFT_INDEX, LEFT_PINKY, np.array([1.0, 0.0, 0.0])),
        ("RightHand", "RightForeArm", RIGHT_WRIST, RIGHT_INDEX, RIGHT_PINKY, np.array([-1.0, 0.0, 0.0])),
    ):
        d = _normalize(0.5 * (p[i] + p[k]) - p[w])
        if np.linalg.norm(d) < 1e-6:
            g[hand] = g[parent].copy()
        else:
            swing = _shortest_arc(_rotate_vec(g[parent], rest_dir), d)
            g[hand] = _quat_multiply(swing, g[parent])

    # Fingers: replace the swing-only wrist with a palm frame and solve the
    # finger chains where hand landmarks are available; a side with no
    # detection this frame holds its previous finger locals (rest if never
    # seen), so dropped hand tracking degrades gracefully instead of snapping.
    solved_fingers: list[str] = []
    held_fingers: list[str] = []
    if hands is not None:
        for side in ("Left", "Right"):
            pts = hands.get(side)
            side_bones = [b for b in FINGER_BONES if b.startswith(side)]
            if pts is not None and np.isfinite(pts).all():
                _solve_hand(np.asarray(pts, dtype=np.float64), side, g)
                solved_fingers.extend(b for b in side_bones if b in g)
                held_fingers.extend(b for b in side_bones if b not in g)
            else:
                held_fingers.extend(side_bones)

    parents = {
        "Hips": None,
        "Spine": "Hips",
        "Spine1": "Spine",
        "Spine2": "Spine1",
        "Neck": "Spine2",
        "Head": "Neck",
        "LeftUpLeg": "Hips",
        "LeftLeg": "LeftUpLeg",
        "LeftFoot": "LeftLeg",
        "RightUpLeg": "Hips",
        "RightLeg": "RightUpLeg",
        "RightFoot": "RightLeg",
        "LeftArm": "Spine2",
        "LeftForeArm": "LeftArm",
        "LeftHand": "LeftForeArm",
        "RightArm": "Spine2",
        "RightForeArm": "RightArm",
        "RightHand": "RightForeArm",
    }
    parents.update(_FINGER_PARENTS)
    locals_ = {}
    for bone in CLIP_BONES + solved_fingers:
        parent = parents[bone]
        if parent is None:
            locals_[bone] = _quat_normalize(g[bone])
        else:
            locals_[bone] = _quat_normalize(_quat_multiply(_quat_conjugate(g[parent]), g[bone]))
    for bone in held_fingers:
        if prev is not None and bone in prev.get("locals", {}):
            locals_[bone] = prev["locals"][bone]
        else:
            locals_[bone] = _IDENTITY.copy()
    return {"locals": locals_, "globals": g}


def _fill_missing_hand(seq: np.ndarray) -> np.ndarray:
    """Forward- then back-fill NaN frames of one hand's (T, 21, 3) sequence.

    A hand with zero detections stays all-NaN, which the solver renders as
    rest-pose fingers.
    """
    ok = np.isfinite(seq).all(axis=(1, 2))
    if not ok.any() or ok.all():
        return seq
    filled = seq.copy()
    last: Optional[int] = None
    for t in range(seq.shape[0]):
        if ok[t]:
            last = t
        elif last is not None:
            filled[t] = filled[last]
    first = int(np.where(ok)[0][0])
    filled[:first] = filled[first]
    return filled


def landmarks_to_clip(
    world: np.ndarray,
    *,
    fps: float,
    name: str = "captured",
    smooth: bool = True,
    hands: Optional[np.ndarray] = None,
) -> dict:
    """(T, 33, 3) MediaPipe world landmarks → three.js AnimationClip JSON.

    `hands`, when given, is (T, 2, 21, 3) HandLandmarker world landmarks in the
    same MediaPipe camera convention as `world` — index 0 the subject's left
    hand, 1 the right, NaN-filled where a hand was not detected that frame —
    and the clip additionally carries the 30 canonical finger-bone tracks plus
    palm-accurate wrist orientation.
    """
    world = np.asarray(world, dtype=np.float64)
    if world.ndim != 3 or world.shape[1] < 33 or world.shape[2] != 3:
        raise ValueError(f"landmarks must be (T, 33, 3); got {world.shape}")
    if fps <= 0:
        raise ValueError("fps must be > 0")
    n_frames = world.shape[0]
    if n_frames < 1:
        raise ValueError("motion has no frames")

    if hands is not None:
        hands = np.asarray(hands, dtype=np.float64)
        if hands.shape != (n_frames, 2, 21, 3):
            raise ValueError(f"hands must be ({n_frames}, 2, 21, 3); got {hands.shape}")
        hands = _to_rig_space(hands)
        sides = []
        for si in range(2):
            seq = _fill_missing_hand(hands[:, si])
            if smooth and np.isfinite(seq).all():
                seq = smooth_landmarks(seq, fps)
            sides.append(seq)

    rig = _to_rig_space(world)
    if smooth:
        rig = smooth_landmarks(rig, fps)

    track_bones = CLIP_BONES + FINGER_BONES if hands is not None else CLIP_BONES
    rest_globals = _rest_globals()
    per_bone: dict[str, list[np.ndarray]] = {b: [] for b in track_bones}
    prev_solution: Optional[dict] = None
    prev_quats: dict[str, np.ndarray] = {}
    for t in range(n_frames):
        frame_hands = None
        if hands is not None:
            frame_hands = {
                side: sides[si][t] if np.isfinite(sides[si][t]).all() else None
                for si, side in enumerate(("Left", "Right"))
            }
        sol = solve_frame(rig[t], prev_solution, frame_hands)
        for bone in track_bones:
            # Author in the canonical rig convention (see _to_canonical_local),
            # not the solver's own T-pose frame, so the browser retarget
            # round-trips instead of folding the skeleton. A held bone (no global
            # this frame, e.g. an undetected finger) rests at its bind local.
            gb = sol["globals"].get(bone)
            if gb is None:
                q = np.asarray(REST_LOCAL.get(bone, _IDENTITY), dtype=np.float64)
            else:
                q = _to_canonical_local(bone, gb, rest_globals)
            q = _hemisphere(prev_quats.get(bone), q)
            prev_quats[bone] = q
            per_bone[bone].append(q)
        prev_solution = sol

    times = (np.arange(n_frames, dtype=np.float64) / float(fps)).tolist()
    duration = (n_frames - 1) / float(fps) if n_frames > 1 else 0.0
    tracks = []
    for bone in track_bones:
        values = np.stack(per_bone[bone], axis=0)
        if smooth:
            values = _smooth_quaternion_track(values, float(fps))
        tracks.append(
            {
                "type": "quaternion",
                "name": f"{bone}.quaternion",
                "times": times,
                "values": values.reshape(-1).tolist(),
            }
        )
    # Root motion stays at the origin: the compositor pins the avatar to the
    # subject's on-screen anchor each frame (see anchors in the worker meta).
    tracks.append(
        {
            "type": "vector",
            "name": "Hips.position",
            "times": [0.0],
            "values": [0.0, 0.0, 0.0],
        }
    )
    return {
        "name": name,
        "duration": duration,
        "tracks": tracks,
        "uuid": _stable_uuid(name, n_frames),
        "blendMode": _NORMAL_BLEND_MODE,
    }


def image_anchors(image_landmarks: np.ndarray, visibility: Optional[np.ndarray] = None) -> list:
    """Per-frame on-screen placement anchors from normalized image landmarks.

    `image_landmarks` is (T, 33, 2+) in normalized [0,1] image coordinates.
    Returns one dict per frame: hip-centre position, the subject's on-screen
    height (head-to-ankle span), and a visibility flag — everything the browser
    compositor needs to pin and scale the avatar over the subject.
    """
    image_landmarks = np.asarray(image_landmarks, dtype=np.float64)
    n = image_landmarks.shape[0]
    key = [LEFT_HIP, RIGHT_HIP, LEFT_SHOULDER, RIGHT_SHOULDER]

    # Pass 1: raw per-frame x / y / h + a visibility flag.
    raw_x = np.zeros(n)
    raw_y = np.zeros(n)
    raw_h = np.full(n, np.nan)
    vis_flag = np.ones(n, dtype=bool)
    for t in range(n):
        p = image_landmarks[t]
        if visibility is not None:
            vis_flag[t] = bool(np.mean([visibility[t][i] for i in key]) > 0.35)
        hip = 0.5 * (p[LEFT_HIP, :2] + p[RIGHT_HIP, :2])
        raw_x[t] = hip[0]
        raw_y[t] = hip[1]
        top = float(min(p[NOSE, 1], p[LEFT_EAR, 1], p[RIGHT_EAR, 1]))
        bottom = float(max(p[LEFT_ANKLE, 1], p[RIGHT_ANKLE, 1]))
        span = bottom - top
        # Only trust the height when the subject is visible and the span is
        # plausible; otherwise leave it NaN so it gets filled from neighbours
        # instead of collapsing the avatar to a speck.
        if vis_flag[t] and span > 0.05:
            raw_h[t] = span

    # Robust height reference: the median of trusted spans. Clamp every frame's
    # height to a band around it so one bad detection can't shrink/grow the
    # avatar. If nothing was trusted, fall back to a sane default.
    good = raw_h[np.isfinite(raw_h)]
    med_h = float(np.median(good)) if good.size else 0.6
    lo, hi = med_h * 0.7, med_h * 1.4
    filled_h = np.where(np.isfinite(raw_h), np.clip(raw_h, lo, hi), med_h)

    # Forward/back-fill x/y across invisible frames so the anchor holds instead
    # of jumping, then EMA-smooth x/y/h (fps-agnostic, gentle) for stable
    # scale and position. The visibility flag still marks hidden frames.
    def _fill(seq: np.ndarray) -> np.ndarray:
        out = seq.copy()
        last = None
        for t in range(n):
            if vis_flag[t]:
                last = out[t]
            elif last is not None:
                out[t] = last
        if not vis_flag.any():
            return out
        first = int(np.argmax(vis_flag))
        out[:first] = out[first]
        return out

    def _ema(seq: np.ndarray, alpha: float = 0.3) -> np.ndarray:
        out = seq.copy()
        for t in range(1, n):
            out[t] = out[t - 1] + alpha * (seq[t] - out[t - 1])
        return out

    sx = _ema(_fill(raw_x))
    sy = _ema(_fill(raw_y))
    sh = _ema(_fill(filled_h))

    return [
        {
            "x": round(float(sx[t]), 4),
            "y": round(float(sy[t]), 4),
            "h": round(float(sh[t]), 4),
            "v": 1 if vis_flag[t] else 0,
        }
        for t in range(n)
    ]


def _stable_uuid(name: str, n_frames: int) -> str:
    h = hashlib.sha256(f"{name}:{n_frames}:v2m".encode("utf-8")).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}".upper()
