"""Video-to-motion service — a video of a person → retargetable animation clip
plus the compositing plates for an avatar body swap.

Given an https video URL, the worker:
  1. normalizes the video with ffmpeg (≤720p, capped fps + duration, H.264,
     original audio preserved),
  2. runs MediaPipe PoseLandmarker (VIDEO mode, heavy model, Apache-2.0) over
     every frame → 33 world landmarks + image landmarks + visibility,
  3. solves the landmarks into local joint rotations on the canonical Wolf3D
     skeleton (pose_solver.py) and emits a three.js AnimationClip JSON — the
     SAME document shape the animation library and text2motion lane serve, so
     the platform retargets it onto any rigged avatar with the existing engine
     (src/animation-retarget.js),
  4. runs MediaPipe ImageSegmenter (selfie model, Apache-2.0) per frame and
     encodes a grayscale person-mask video aligned with the normalized video,
  5. uploads clip + mask + normalized video + per-frame screen anchors to GCS.

The browser compositor (/motion-swap) then plays the normalized video as the
backdrop, drives the user's avatar with the clip, pins it to the subject via
the anchors, and hides the subject under the mask. All model inference is
CPU-friendly — this worker deploys like the segment/rembg lanes, no GPU.

API contract (identical shape to the other model-* workers):
  POST /infer   { video_url: str, fps?: int=24, max_seconds?: float, job_id?: str }
                → 202 { task_id, status: "queued" }
  GET  /tasks/:id → { task_id, status, result_url?, meta_url?, video_url?,
                      mask_url?, frames?, fps?, error? }
  GET  /health    → { ok, models_loaded }

Environment:
  API_KEY          — bearer secret (required)
  GCS_BUCKET       — output bucket (required)
  MAX_CONCURRENT   — default 2
  MAX_SECONDS      — hard cap on processed duration (default 90)
  MODELS_DIR       — directory with the .task model bundles (default /models)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from typing import Optional

import numpy as np
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from google.cloud import storage
from pydantic import BaseModel, Field

from pose_solver import image_anchors, landmarks_to_clip
from worker_security import fetch_remote_bytes, require_api_key, safe_error

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("video2motion")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "2"))
MAX_SECONDS = float(os.environ.get("MAX_SECONDS", "90"))
MODELS_DIR = os.environ.get("MODELS_DIR", "/models")
MAX_VIDEO_BYTES = 256 * 1024 * 1024
DEFAULT_FPS = 24
MAX_EDGE = 1280  # normalized video long-edge cap (720p-class)

_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_tasks: dict[str, dict] = {}
_models_loaded = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem, _models_loaded
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    # Fail fast if the model bundles are missing from the image.
    for f in ("pose_landmarker_heavy.task", "selfie_multiclass_256x256.tflite"):
        path = os.path.join(MODELS_DIR, f)
        if not os.path.exists(path):
            raise RuntimeError(f"model bundle missing: {path}")
    _models_loaded = True
    log.info("video2motion ready — max_concurrent=%d max_seconds=%.0f", MAX_CONCURRENT, MAX_SECONDS)
    yield


app = FastAPI(title="model-video2motion", lifespan=lifespan)


def _require_api_key(authorization: str) -> None:
    try:
        require_api_key(authorization, API_KEY)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


class InferRequest(BaseModel):
    video_url: str = Field(..., min_length=12, max_length=2048)
    fps: int = Field(default=DEFAULT_FPS, ge=8, le=30)
    max_seconds: Optional[float] = Field(default=None, gt=0)
    job_id: Optional[str] = None


@app.post("/infer", status_code=202)
async def infer(body: InferRequest, background_tasks: BackgroundTasks, authorization: str = Header(...)) -> dict:
    _require_api_key(authorization)
    task_id = body.job_id or str(uuid.uuid4())
    _tasks[task_id] = {"task_id": task_id, "status": "queued", "model": "blazepose-heavy"}
    seconds = min(body.max_seconds or MAX_SECONDS, MAX_SECONDS)
    background_tasks.add_task(_run, task_id, body.video_url, body.fps, seconds)
    return {"task_id": task_id, "status": "queued"}


@app.get("/tasks/{task_id}")
async def get_task(task_id: str, authorization: str = Header(...)) -> dict:
    _require_api_key(authorization)
    task = _tasks.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return task


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "models_loaded": _models_loaded}


async def _run(task_id: str, video_url: str, fps: int, seconds: float) -> None:
    assert _sem is not None and _bucket is not None
    async with _sem:
        _tasks[task_id]["status"] = "running"
        started = time.time()
        loop = asyncio.get_event_loop()
        try:
            result = await loop.run_in_executor(None, _process, task_id, video_url, fps, seconds)
            result["status"] = "done"
            result["elapsed_ms"] = int((time.time() - started) * 1000)
            _tasks[task_id].update(result)
            log.info(
                "task %s done — %s frames in %dms",
                task_id,
                result.get("frames"),
                result["elapsed_ms"],
            )
        except Exception as exc:
            msg = safe_error(exc, context=f"video2motion task {task_id}")
            _tasks[task_id].update({"status": "failed", "error": msg})
            log.exception("task %s failed", task_id)


def _ffmpeg(args: list[str]) -> None:
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr[-400:]}")


def _process(task_id: str, video_url: str, fps: int, seconds: float) -> dict:
    workdir = tempfile.mkdtemp(prefix="v2m-")
    try:
        raw_path = os.path.join(workdir, "raw")
        # A real UA: several large hosts (Wikimedia among them) 403 the default
        # python-httpx agent, and users paste public video URLs directly.
        data = fetch_remote_bytes(
            video_url,
            timeout=180,
            max_bytes=MAX_VIDEO_BYTES,
            headers={"user-agent": "three-ws-video2motion/1.0 (+https://three.ws/motion-swap)"},
        )
        with open(raw_path, "wb") as f:
            f.write(data)

        # Normalize: cap duration, fps and resolution; keep audio; strip metadata.
        norm_path = os.path.join(workdir, "video.mp4")
        _ffmpeg(
            [
                "-i", raw_path,
                "-t", f"{seconds:.2f}",
                "-vf",
                f"fps={fps},scale='if(gt(iw,ih),min(iw,{MAX_EDGE}),-2)':'if(gt(iw,ih),-2,min(ih,{MAX_EDGE}))'",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k",
                "-map_metadata", "-1",
                "-movflags", "+faststart",
                norm_path,
            ]
        )

        world, image, vis, masks, width, height = _analyze(norm_path, fps)
        n_frames = world.shape[0]
        if n_frames < 2:
            raise RuntimeError("no person detected in the video")

        clip = landmarks_to_clip(world, fps=fps, name=f"capture-{task_id[:8]}")
        anchors = image_anchors(image, vis)

        mask_path = os.path.join(workdir, "mask.mp4")
        _encode_mask_video(masks, fps, mask_path, workdir)

        meta = {
            "version": 1,
            "fps": fps,
            "frames": n_frames,
            "width": width,
            "height": height,
            "anchors": anchors,
        }

        prefix = f"motion-swap/{task_id}"
        urls = {}
        uploads = [
            ("clip.json", json.dumps(clip).encode("utf-8"), "application/json"),
            ("meta.json", json.dumps(meta).encode("utf-8"), "application/json"),
        ]
        for name, payload, ctype in uploads:
            blob = _bucket.blob(f"{prefix}/{name}")
            blob.upload_from_string(payload, content_type=ctype)
            urls[name] = f"https://storage.googleapis.com/{GCS_BUCKET}/{prefix}/{name}"
        for name, path, ctype in (("video.mp4", norm_path, "video/mp4"), ("mask.mp4", mask_path, "video/mp4")):
            blob = _bucket.blob(f"{prefix}/{name}")
            blob.upload_from_filename(path, content_type=ctype)
            urls[name] = f"https://storage.googleapis.com/{GCS_BUCKET}/{prefix}/{name}"

        return {
            "result_url": urls["clip.json"],
            "meta_url": urls["meta.json"],
            "video_url": urls["video.mp4"],
            "mask_url": urls["mask.mp4"],
            "frames": int(n_frames),
            "fps": int(fps),
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _analyze(video_path: str, fps: int):
    """Run pose + segmentation over every frame of the normalized video.

    Returns (world (T,33,3), image (T,33,2), visibility (T,33), masks list of
    uint8 HxW arrays, width, height). Frames where no person is detected reuse
    the previous frame's landmarks and get visibility 0 (the anchor marks them
    hidden; the solver stays continuous instead of snapping to rest).
    """
    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    pose_opts = vision.PoseLandmarkerOptions(
        base_options=mp_python.BaseOptions(
            model_asset_path=os.path.join(MODELS_DIR, "pose_landmarker_heavy.task")
        ),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.4,
        min_tracking_confidence=0.4,
    )
    # Multiclass person-part segmenter (background/hair/skin/face/clothes/other)
    # — the full-body person mask is 1 - background confidence, which holds up
    # far better than the selfie model on wide framing (house tours, rooms).
    seg_opts = vision.ImageSegmenterOptions(
        base_options=mp_python.BaseOptions(
            model_asset_path=os.path.join(MODELS_DIR, "selfie_multiclass_256x256.tflite")
        ),
        running_mode=vision.RunningMode.VIDEO,
        output_confidence_masks=True,
    )

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError("could not open normalized video")
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    world_frames: list[np.ndarray] = []
    image_frames: list[np.ndarray] = []
    vis_frames: list[np.ndarray] = []
    masks: list[np.ndarray] = []
    prev_world: Optional[np.ndarray] = None
    prev_image: Optional[np.ndarray] = None

    with vision.PoseLandmarker.create_from_options(pose_opts) as pose, vision.ImageSegmenter.create_from_options(
        seg_opts
    ) as segmenter:
        frame_idx = 0
        while True:
            ok, frame_bgr = cap.read()
            if not ok:
                break
            ts_ms = int(frame_idx * 1000.0 / fps)
            rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

            pose_result = pose.detect_for_video(mp_image, ts_ms)
            if pose_result.pose_world_landmarks:
                wl = pose_result.pose_world_landmarks[0]
                il = pose_result.pose_landmarks[0]
                world = np.array([[lm.x, lm.y, lm.z] for lm in wl])
                image = np.array([[lm.x, lm.y] for lm in il])
                vis = np.array([lm.visibility for lm in il])
                prev_world, prev_image = world, image
            elif prev_world is not None:
                world, image, vis = prev_world, prev_image, np.zeros(33)
            else:
                frame_idx += 1
                masks.append(np.zeros((height, width), dtype=np.uint8))
                continue
            world_frames.append(world)
            image_frames.append(image)
            vis_frames.append(vis)

            seg_result = segmenter.segment_for_video(mp_image, ts_ms)
            bg = seg_result.confidence_masks[0].numpy_view()  # class 0 = background
            person = 1.0 - np.clip(bg, 0.0, 1.0)
            if person.shape != (height, width):
                person = cv2.resize(person, (width, height), interpolation=cv2.INTER_LINEAR)
            masks.append((person * 255).astype(np.uint8))
            frame_idx += 1
    cap.release()

    if not world_frames:
        return np.zeros((0, 33, 3)), np.zeros((0, 33, 2)), np.zeros((0, 33)), masks, width, height

    # Leading undetected frames produced masks but no landmarks; pad the
    # landmark arrays at the front with the first detection so lengths match.
    pad = len(masks) - len(world_frames)
    world = np.stack(world_frames)
    image = np.stack(image_frames)
    vis = np.stack(vis_frames)
    if pad > 0:
        world = np.concatenate([np.repeat(world[:1], pad, axis=0), world])
        image = np.concatenate([np.repeat(image[:1], pad, axis=0), image])
        vis = np.concatenate([np.zeros((pad, 33)), vis])
    return world, image, vis, masks, width, height


def _encode_mask_video(masks: list[np.ndarray], fps: int, out_path: str, workdir: str) -> None:
    """Encode uint8 person masks as a grayscale H.264 video via an ffmpeg pipe."""
    if not masks:
        raise RuntimeError("no mask frames to encode")
    h, w = masks[0].shape
    proc = subprocess.Popen(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{w}x{h}", "-r", str(fps),
            "-i", "-",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            out_path,
        ],
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        for m in masks:
            proc.stdin.write(m.tobytes())
        proc.stdin.close()
        proc.wait(timeout=600)
    except Exception:
        proc.kill()
        raise
    if proc.returncode != 0:
        err = proc.stderr.read().decode("utf-8", "replace")[-400:] if proc.stderr else ""
        raise RuntimeError(f"mask encode failed: {err}")
