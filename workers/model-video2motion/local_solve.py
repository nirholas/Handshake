#!/usr/bin/env python3
"""Local driver: video -> pose/hand landmarks -> clip.json, no server, no GCS.

Fast iterate loop for debugging pose_solver.py:

    python local_solve.py <video.mp4> <out_clip.json> [--fps=24] [--dump-landmarks=lm.npz]

Runs the SAME MediaPipe PoseLandmarker/HandLandmarker pipeline as main._analyze
(minus segmentation), then pose_solver.landmarks_to_clip. Models are read from
$MODELS_DIR (default ./.models).
"""
import os
import sys
import json
import numpy as np

MODELS_DIR = os.environ.get("MODELS_DIR", os.path.join(os.path.dirname(__file__), ".models"))
os.environ.setdefault("MODELS_DIR", MODELS_DIR)

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

from pose_solver import landmarks_to_clip, image_anchors, match_hands_to_sides


def analyze(video_path, fps):
    pose_opts = vision.PoseLandmarkerOptions(
        base_options=mp_python.BaseOptions(
            model_asset_path=os.path.join(MODELS_DIR, "pose_landmarker_heavy.task")
        ),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.4,
        min_tracking_confidence=0.4,
    )
    hand_opts = vision.HandLandmarkerOptions(
        base_options=mp_python.BaseOptions(
            model_asset_path=os.path.join(MODELS_DIR, "hand_landmarker.task")
        ),
        running_mode=vision.RunningMode.VIDEO,
        num_hands=2,
        min_hand_detection_confidence=0.4,
        min_tracking_confidence=0.4,
    )
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError("could not open video")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or fps
    step = max(1, round(src_fps / fps))
    world_frames, image_frames, vis_frames, hand_frames = [], [], [], []
    prev_world = prev_image = None
    with vision.PoseLandmarker.create_from_options(pose_opts) as pose, \
         vision.HandLandmarker.create_from_options(hand_opts) as hand_lm:
        frame_idx = 0
        out_idx = 0
        while True:
            ok, frame_bgr = cap.read()
            if not ok:
                break
            if frame_idx % step != 0:
                frame_idx += 1
                continue
            ts_ms = int(out_idx * 1000.0 / fps)
            rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            pr = pose.detect_for_video(mp_image, ts_ms)
            if pr.pose_world_landmarks:
                wl = pr.pose_world_landmarks[0]
                il = pr.pose_landmarks[0]
                world = np.array([[lm.x, lm.y, lm.z] for lm in wl])
                image = np.array([[lm.x, lm.y] for lm in il])
                vis = np.array([lm.visibility for lm in il])
                prev_world, prev_image = world, image
            elif prev_world is not None:
                world, image, vis = prev_world, prev_image, np.zeros(33)
            else:
                frame_idx += 1
                out_idx += 1
                continue
            world_frames.append(world)
            image_frames.append(image)
            vis_frames.append(vis)
            fh = np.full((2, 21, 3), np.nan)
            hr = hand_lm.detect_for_video(mp_image, ts_ms)
            if hr.hand_world_landmarks:
                wrists = [(h[0].x, h[0].y) for h in hr.hand_landmarks]
                labels = [(c[0].category_name if c else None) for c in hr.handedness]
                assigned = match_hands_to_sides(wrists, labels, image)
                for si, side in enumerate(("Left", "Right")):
                    idx = assigned[side]
                    if idx is not None:
                        fh[si] = np.array([[lm.x, lm.y, lm.z] for lm in hr.hand_world_landmarks[idx]])
            hand_frames.append(fh)
            frame_idx += 1
            out_idx += 1
    cap.release()
    return (
        np.array(world_frames),
        np.array(image_frames),
        np.array(vis_frames),
        np.array(hand_frames),
    )


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = dict(
        a[2:].split("=", 1) if "=" in a else (a[2:], True)
        for a in sys.argv[1:]
        if a.startswith("--")
    )
    video, out = args[0], args[1]
    fps = int(flags.get("fps", 24))
    world, image, vis, hands = analyze(video, fps)
    print(f"frames={world.shape[0]} fps={fps}", file=sys.stderr)
    if flags.get("dump-landmarks"):
        np.savez(flags["dump-landmarks"], world=world, image=image, vis=vis, hands=hands)
        print(f"dumped landmarks -> {flags['dump-landmarks']}", file=sys.stderr)
    clip = landmarks_to_clip(world, fps=fps, name="local", hands=hands)
    anchors = image_anchors(image, vis)
    json.dump(clip, open(out, "w"))
    print(f"wrote {out} tracks={len(clip['tracks'])} dur={clip['duration']:.1f}s anchors={len(anchors)}", file=sys.stderr)


if __name__ == "__main__":
    main()
