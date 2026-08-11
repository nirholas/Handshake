"""Smoke tests for the service path around the solver: HTTP contract, video
normalization, mask encoding, the SSRF guard on the caller-supplied URL, and
the queue → run → task-store error path.

These exercise the real code with real ffmpeg and real MediaPipe; nothing is
mocked. Two things are deliberately out of scope here because they need
credentials rather than logic: the GCS upload and a real human video. Those are
covered by running the built image against a live video URL (see the README's
"Verify a real capture" section).

The FastAPI lifespan (which opens the output bucket) is only entered by the
real server, so importing the app needs no credentials. `main._analyze` imports
mediapipe and OpenCV lazily, so the frame-analysis test skips cleanly when the
model bundles are not staged.

Run:  python -m pytest test_service.py -q
"""

import asyncio
import json
import os
import subprocess

import numpy as np
import pytest

# main.py reads its configuration at import time; give it a test configuration
# before importing it. The key is only ever compared against itself here.
os.environ.setdefault("API_KEY", "smoke-test-key")
os.environ.setdefault("GCS_BUCKET", "three-ws-video2motion-smoke")

import main  # noqa: E402  (import follows the env setup above by necessity)
from worker_security import UnsafeUrlError, fetch_remote_bytes  # noqa: E402

API_KEY = os.environ["API_KEY"]
AUTH = {"Authorization": f"Bearer {API_KEY}"}
MODEL_BUNDLES = (
    "pose_landmarker_heavy.task",
    "hand_landmarker.task",
    "selfie_multiclass_256x256.tflite",
)


# ── helpers ─────────────────────────────────────────────────────────────────────


def _ffprobe(path: str, *extra: str) -> dict:
    out = subprocess.run(
        [
            "ffprobe", "-hide_banner", "-loglevel", "error",
            "-show_format", "-show_streams", "-print_format", "json",
            *extra, path,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(out.stdout)


def _stream(probe: dict, kind: str) -> dict:
    for s in probe["streams"]:
        if s["codec_type"] == kind:
            return s
    raise AssertionError(f"no {kind} stream in {probe['streams']}")


def _make_source(path: str, *, width: int, height: int, fps: int, seconds: int) -> None:
    """A real H.264+AAC test video with a title tag, via ffmpeg."""
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc=size={width}x{height}:rate={fps}:duration={seconds}",
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-metadata", "title=source-metadata-should-not-survive",
            "-shortest", path,
        ],
        capture_output=True,
        check=True,
    )


def _models_dir() -> str:
    """Where the MediaPipe bundles live: the env override, the image path, or
    the checked-in dev copy. Returns "" when the set is incomplete."""
    candidates = [
        os.environ.get("MODELS_DIR"),
        "/models",
        os.path.join(os.path.dirname(__file__), ".models"),
    ]
    for d in candidates:
        if d and all(os.path.exists(os.path.join(d, f)) for f in MODEL_BUNDLES):
            return d
    return ""


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    # Constructed without the `with` block on purpose: that would run the
    # lifespan, which opens a real GCS bucket handle.
    return TestClient(main.app)


# ── HTTP contract ───────────────────────────────────────────────────────────────


def test_health_is_open_and_reports_model_state(client):
    body = client.get("/health").json()
    assert body["ok"] is True
    assert "models_loaded" in body


def test_infer_rejects_missing_and_wrong_bearer(client):
    payload = {"video_url": "https://example.com/a.mp4"}
    assert client.post("/infer", json=payload).status_code == 422
    bad = client.post("/infer", json=payload, headers={"Authorization": "Bearer nope"})
    assert bad.status_code == 401


def test_task_lookup_is_authenticated_and_404s_unknown_ids(client):
    assert client.get("/tasks/does-not-exist").status_code == 422
    wrong = client.get("/tasks/does-not-exist", headers={"Authorization": "Bearer nope"})
    assert wrong.status_code == 401
    assert client.get("/tasks/does-not-exist", headers=AUTH).status_code == 404


@pytest.mark.parametrize(
    "payload",
    [
        {"video_url": "https://example.com/a.mp4", "fps": 60},
        {"video_url": "https://example.com/a.mp4", "fps": 4},
        {"video_url": "short"},
        {"video_url": "https://example.com/a.mp4", "max_seconds": 0},
        {},
    ],
)
def test_infer_validates_the_request(client, payload):
    assert client.post("/infer", json=payload, headers=AUTH).status_code == 422


def test_queued_job_that_cannot_be_fetched_lands_as_failed_with_an_opaque_error(client):
    """The full accept → background run → task-store path, with the fetch
    rejected by the SSRF guard rather than by a network round trip."""
    from google.cloud import storage

    # What the lifespan sets up, minus credentials: an anonymous bucket handle
    # is never contacted because the job fails at the fetch step.
    main._sem = asyncio.Semaphore(1)
    main._bucket = storage.Client.create_anonymous_client().bucket(os.environ["GCS_BUCKET"])

    res = client.post(
        "/infer",
        json={"video_url": "https://127.0.0.1/clip.mp4", "job_id": "smoke-ssrf"},
        headers=AUTH,
    )
    assert res.status_code == 202
    assert res.json() == {"task_id": "smoke-ssrf", "status": "queued"}

    task = client.get("/tasks/smoke-ssrf", headers=AUTH).json()
    assert task["status"] == "failed"
    # Opaque: a correlation id, never a traceback or a path.
    assert task["error"].startswith("internal error (ref ")
    assert "Traceback" not in task["error"] and "/app" not in task["error"]


# ── SSRF guard on the caller-supplied video URL ─────────────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/a.mp4",          # cleartext
        "file:///etc/passwd",                # non-http scheme
        "https://127.0.0.1/a.mp4",           # loopback
        "https://169.254.169.254/computeMetadata/v1/",  # cloud metadata
        "https://10.0.0.5/a.mp4",            # RFC1918
        "https://[::1]/a.mp4",               # IPv6 loopback
    ],
)
def test_fetch_rejects_unsafe_video_urls(url):
    with pytest.raises(UnsafeUrlError):
        fetch_remote_bytes(url, timeout=5, max_bytes=1024)


# ── video normalization ─────────────────────────────────────────────────────────


def test_normalize_caps_fps_and_duration_keeps_audio_and_strips_metadata(tmp_path):
    raw = str(tmp_path / "raw.mp4")
    out = str(tmp_path / "video.mp4")
    _make_source(raw, width=640, height=480, fps=30, seconds=4)

    main._normalize_video(raw, out, 12, 2.0)

    probe = _ffprobe(out, "-count_frames")
    video = _stream(probe, "video")
    assert video["codec_name"] == "h264"
    assert video["avg_frame_rate"] == "12/1"
    assert video["width"] == 640 and video["height"] == 480
    # 12 fps capped at 2 s: 24 frames, give or take the encoder's last frame.
    assert 22 <= int(video["nb_read_frames"]) <= 25
    assert float(probe["format"]["duration"]) < 2.6
    assert _stream(probe, "audio")["codec_name"] == "aac"
    assert "title" not in {k.lower() for k in probe["format"].get("tags", {})}


def test_normalize_caps_the_long_edge_to_720p_class_with_even_dimensions(tmp_path):
    raw = str(tmp_path / "big.mp4")
    out = str(tmp_path / "video.mp4")
    _make_source(raw, width=1920, height=1080, fps=24, seconds=1)

    main._normalize_video(raw, out, 24, 1.0)

    video = _stream(_ffprobe(out), "video")
    assert video["width"] == main.MAX_EDGE
    assert video["height"] == 720
    assert video["width"] % 2 == 0 and video["height"] % 2 == 0


def test_normalize_reports_a_failed_ffmpeg_run(tmp_path):
    raw = str(tmp_path / "not-a-video.mp4")
    with open(raw, "wb") as f:
        f.write(b"this is not a video")
    with pytest.raises(RuntimeError, match="ffmpeg failed"):
        main._normalize_video(raw, str(tmp_path / "out.mp4"), 24, 1.0)


# ── mask video encoding ─────────────────────────────────────────────────────────


def _mask_frames(n: int, w: int, h: int) -> list:
    """n grayscale frames, each with a bright block on the left half."""
    frames = []
    for _ in range(n):
        m = np.zeros((h, w), dtype=np.uint8)
        m[:, : w // 2] = 255
        frames.append(m)
    return frames


def test_mask_video_round_trips_the_person_mask(tmp_path):
    out = str(tmp_path / "mask.mp4")
    frames = _mask_frames(16, 64, 48)

    main._encode_mask_video(frames, 12, out, str(tmp_path))

    probe = _ffprobe(out, "-count_frames")
    video = _stream(probe, "video")
    assert video["width"] == 64 and video["height"] == 48
    assert int(video["nb_read_frames"]) == 16
    assert video["avg_frame_rate"] == "12/1"

    # Decode back to raw gray and confirm the mask survived: left half bright,
    # right half dark (H.264 is lossy, so assert on the separation, not equality).
    decoded = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-i", out, "-f", "rawvideo", "-pix_fmt", "gray", "-",
        ],
        capture_output=True,
        check=True,
    ).stdout
    got = np.frombuffer(decoded, dtype=np.uint8).reshape(-1, 48, 64)
    assert got.shape[0] == 16
    assert got[:, :, :32].mean() > 200
    assert got[:, :, 32:].mean() < 55


def test_mask_encode_refuses_an_empty_frame_list(tmp_path):
    with pytest.raises(RuntimeError, match="no mask frames"):
        main._encode_mask_video([], 24, str(tmp_path / "mask.mp4"), str(tmp_path))


# ── frame analysis (needs the MediaPipe bundles) ────────────────────────────────


def test_analyze_runs_every_model_over_the_normalized_video(tmp_path, monkeypatch):
    """The real MediaPipe leg: all three bundles load and run per frame. A clip
    with no person in it yields one mask per frame and no landmarks, which is
    exactly what `_process` turns into "no person detected in the video"."""
    models = _models_dir()
    if not models:
        pytest.skip(f"MediaPipe bundles not staged; need {MODEL_BUNDLES} in MODELS_DIR")
    pytest.importorskip("mediapipe")
    pytest.importorskip("cv2")
    monkeypatch.setattr(main, "MODELS_DIR", models)

    raw = str(tmp_path / "raw.mp4")
    norm = str(tmp_path / "video.mp4")
    _make_source(raw, width=320, height=240, fps=10, seconds=1)
    main._normalize_video(raw, norm, 10, 1.0)

    world, image, vis, hands, masks, width, height = main._analyze(norm, 10)

    assert (width, height) == (320, 240)
    assert len(masks) >= 8
    assert all(m.shape == (240, 320) and m.dtype == np.uint8 for m in masks)
    # Nothing human in a test pattern: no landmarks, so no clip is authorable.
    assert world.shape == (0, 33, 3)
    assert image.shape == (0, 33, 2) and vis.shape == (0, 33)
    assert hands.shape == (0, 2, 21, 3)


# ── the clip + plates a capture produces ────────────────────────────────────────


def test_solved_landmarks_produce_the_clip_and_plates_process_uploads(tmp_path):
    """The artifact contract `_process` writes to GCS, assembled from the same
    functions it calls: a three.js AnimationClip document, per-frame anchors,
    and a mask video aligned frame-for-frame with the normalized video."""
    from pose_solver import CLIP_BONES, image_anchors, landmarks_to_clip
    from test_pose_solver import t_pose_world

    fps, n = 12, 18
    world = np.stack([t_pose_world()] * n)
    image = np.tile(np.full((33, 2), 0.5), (n, 1, 1))
    vis = np.ones((n, 33))

    clip = landmarks_to_clip(world, fps=fps, name="smoke-capture")
    anchors = image_anchors(image, vis)
    mask_path = str(tmp_path / "mask.mp4")
    main._encode_mask_video(_mask_frames(n, 64, 48), fps, mask_path, str(tmp_path))

    # Clip: the shape src/animation-retarget.js consumes.
    assert set(clip) == {"name", "duration", "tracks", "uuid", "blendMode"}
    assert clip["duration"] == pytest.approx((n - 1) / fps)
    assert len(clip["tracks"]) == len(CLIP_BONES) + 1
    assert json.loads(json.dumps(clip)) == clip

    # meta.json: one anchor per frame, each pinnable on screen.
    meta = {"version": 1, "fps": fps, "frames": n, "width": 64, "height": 48, "anchors": anchors}
    assert len(meta["anchors"]) == n
    assert all({"x", "y", "h", "v"} <= set(a) for a in anchors)
    assert json.loads(json.dumps(meta)) == meta

    # mask.mp4: same frame count and fps as the clip's timebase.
    video = _stream(_ffprobe(mask_path, "-count_frames"), "video")
    assert int(video["nb_read_frames"]) == n
    assert video["avg_frame_rate"] == f"{fps}/1"
