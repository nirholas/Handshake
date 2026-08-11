"""Convert SMPL-skeleton motion into a three.js AnimationClip JSON.

Text-to-motion diffusion models (MDM, MoMask, T2M-GPT) emit motion on the SMPL
body skeleton: per-frame local joint rotations (axis-angle) plus a root
translation. three.ws avatars are rigged with the canonical Wolf3D humanoid
(see workers/rig/rig_glb.py). This module is the deterministic bridge: it
maps SMPL joints → Wolf3D bone names, converts axis-angle → quaternions, and
emits the exact `THREE.AnimationClip.toJSON()` shape that the rest of the
platform already consumes — the animation library, the `apply_animation` MCP
tool, and the pose-studio GLB exporter all retarget such a clip onto a user's
avatar with the SAME engine (src/animation-retarget.js). So a generated clip is
handled identically to a curated preset.

Pure NumPy — no torch, no three, no GPU — so it is unit-tested deterministically
without the model. The model worker (main.py) calls `smpl_motion_to_clip()` on
the diffusion output.

Rest-pose calibration
---------------------
SMPL's rest pose differs from the Wolf3D rig's, so applying SMPL *local*
rotations onto Wolf3D bones carries a per-joint orientation offset. The
retarget engine aligns names + scales hips, but not rest orientation. Pass
`rest_offsets` (canonical-bone → [x,y,z,w] quaternion, premultiplied onto each
frame) to calibrate against a specific rig; the default (identity) emits the raw
SMPL local rotations, which is correct for SMPL-rest targets and the baseline to
tune from on deploy.
"""

from __future__ import annotations

import math
from typing import Optional

import numpy as np

# SMPL 24-joint index → canonical Wolf3D bone name. Joints with no Wolf3D
# counterpart (SMPL hands beyond the wrist) collapse onto the hand bone's parent
# chain and are omitted. Eyes + Jaw exist on the Wolf3D rig but not in SMPL, so
# they simply receive no track (the avatar keeps its rest face).
SMPL_TO_WOLF3D = {
    0: "Hips",
    3: "Spine",
    6: "Spine1",
    9: "Spine2",
    12: "Neck",
    15: "Head",
    13: "LeftShoulder",
    16: "LeftArm",
    18: "LeftForeArm",
    20: "LeftHand",
    14: "RightShoulder",
    17: "RightArm",
    19: "RightForeArm",
    21: "RightHand",
    1: "LeftUpLeg",
    4: "LeftLeg",
    7: "LeftFoot",
    10: "LeftToeBase",
    2: "RightUpLeg",
    5: "RightLeg",
    8: "RightFoot",
    11: "RightToeBase",
}

# three.js AnimationBlendMode.NormalAnimationBlendMode
_NORMAL_BLEND_MODE = 2500


def axis_angle_to_quaternion(aa: np.ndarray) -> np.ndarray:
    """Axis-angle vectors → unit quaternions [x, y, z, w].

    `aa` is (..., 3); the return is (..., 4). Zero-rotation maps to identity.
    Vectorized and numerically stable near the small-angle limit.
    """
    aa = np.asarray(aa, dtype=np.float64)
    angle = np.linalg.norm(aa, axis=-1, keepdims=True)  # (..., 1)
    # Guard the divide; where angle≈0 the axis is irrelevant (sin term → 0).
    safe_angle = np.where(angle < 1e-8, 1.0, angle)
    axis = aa / safe_angle
    half = angle * 0.5
    sin_half = np.sin(half)
    w = np.cos(half)
    xyz = axis * sin_half
    quat = np.concatenate([xyz, w], axis=-1)  # (..., 4) ordered x,y,z,w
    # Renormalize against accumulated float error.
    norm = np.linalg.norm(quat, axis=-1, keepdims=True)
    norm = np.where(norm < 1e-8, 1.0, norm)
    return quat / norm


def quat_multiply(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Hamilton product of two [x,y,z,w] quaternions (broadcasts on the batch)."""
    ax, ay, az, aw = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    bx, by, bz, bw = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    return np.stack(
        [
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        ],
        axis=-1,
    )


def smpl_motion_to_clip(
    poses: np.ndarray,
    trans: Optional[np.ndarray] = None,
    *,
    fps: int = 30,
    name: str = "generated",
    rest_offsets: Optional[dict] = None,
) -> dict:
    """Build a three.js AnimationClip JSON from SMPL motion.

    Parameters
    ----------
    poses : (T, 24, 3) or (T, 72) axis-angle local joint rotations per frame.
    trans : (T, 3) root translation per frame (metres). Optional; defaults to 0.
    fps   : frame rate the motion was sampled at.
    name  : clip name.
    rest_offsets : optional {bone_name: [x,y,z,w]} premultiplied onto each frame
                   to calibrate SMPL rest orientation to a specific rig.

    Returns a dict matching ``THREE.AnimationClip.toJSON()`` — quaternion tracks
    per mapped bone plus a Hips.position track — ready to retarget onto an avatar.
    """
    poses = np.asarray(poses, dtype=np.float64)
    if poses.ndim == 2:
        if poses.shape[1] % 3 != 0:
            raise ValueError(f"flattened poses must be a multiple of 3, got {poses.shape[1]}")
        poses = poses.reshape(poses.shape[0], poses.shape[1] // 3, 3)
    if poses.ndim != 3 or poses.shape[2] != 3:
        raise ValueError(f"poses must be (T,J,3) or (T,J*3); got {poses.shape}")

    n_frames, n_joints, _ = poses.shape
    if n_frames < 1:
        raise ValueError("motion has no frames")
    if fps < 1:
        raise ValueError("fps must be >= 1")

    # Per-frame timestamps. A single frame yields a static [0.0] pose.
    times = (np.arange(n_frames, dtype=np.float64) / float(fps)).tolist()
    duration = (n_frames - 1) / float(fps) if n_frames > 1 else 0.0

    quats = axis_angle_to_quaternion(poses)  # (T, J, 4)
    rest_offsets = rest_offsets or {}

    tracks = []
    for joint_idx, bone in SMPL_TO_WOLF3D.items():
        if joint_idx >= n_joints:
            continue
        frames = quats[:, joint_idx, :]  # (T, 4)
        offset = rest_offsets.get(bone)
        if offset is not None:
            offset = np.asarray(offset, dtype=np.float64).reshape(1, 4)
            frames = quat_multiply(offset, frames)
            norm = np.linalg.norm(frames, axis=-1, keepdims=True)
            frames = frames / np.where(norm < 1e-8, 1.0, norm)
        tracks.append(
            {
                "type": "quaternion",
                "name": f"{bone}.quaternion",
                "times": times,
                "values": frames.reshape(-1).tolist(),
            }
        )

    # Root translation → Hips.position. Absent translation = a stationary clip.
    if trans is not None:
        trans = np.asarray(trans, dtype=np.float64)
        if trans.shape != (n_frames, 3):
            raise ValueError(f"trans must be (T,3) matching frames; got {trans.shape}")
        tracks.append(
            {
                "type": "vector",
                "name": "Hips.position",
                "times": times,
                "values": trans.reshape(-1).tolist(),
            }
        )

    return {
        "name": name,
        "duration": duration,
        "tracks": tracks,
        "uuid": _stable_uuid(name, n_frames, n_joints),
        "blendMode": _NORMAL_BLEND_MODE,
    }


def _stable_uuid(name: str, n_frames: int, n_joints: int) -> str:
    """Deterministic UUID-shaped id from the clip identity (no randomness — the
    worker resume + tests stay reproducible)."""
    import hashlib

    h = hashlib.sha256(f"{name}:{n_frames}:{n_joints}".encode("utf-8")).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}".upper()
