"""
model-video2scene: streaming video to 3D point-cloud reconstruction.

Wraps LingBot-Map (Apache-2.0, github.com/Robbyant/lingbot-map), a feed-forward
"Geometric Context Transformer" that reconstructs a dense world-space point cloud
from a monocular video or image sequence. We drive the repo's own demo entry
points (load_images / load_model / postprocess), fuse the per-frame world points
+ RGB into a single coloured point cloud, write a binary little-endian PLY, and
upload it to Cloud Storage. The three.ws Scene Capture page renders that PLY
directly with a WebGL point-cloud viewer.

API contract (mirrors the other three.ws model workers: triposr, hunyuan3d):
  POST /infer
    {
      video_url?:        https URL to an .mp4/.mov/.webm        (one of video_url
      images?:           [https url | data-uri, ...],           or images required)
      mode?:             "streaming" | "windowed"   (default streaming)
      fps?:              int,   frames/sec to sample from video (default 8)
      keyframe_interval? int,   cache every N-th frame          (default 4)
      num_scale_frames?  int,   bidirectional scale frames      (default 8)
      window_size?:      int,   windowed mode window            (default 128)
      overlap_size?:     int,   windowed mode overlap           (default 16)
      mask_sky?:         bool,  drop sky points                 (default true)
      conf_percentile?:  0..95, drop low-confidence points      (default 30)
      max_points?:       int,   downsample budget               (default 1_500_000)
      voxel_size?:       float, voxel-merge cell edge, 0 = off  (default 0)
      job_id?:           str    caller correlation id
    }
    -> 202 { task_id, status: "queued" }

  GET  /tasks/:id -> { task_id, status, result_gcs_url?, num_points?, frames?, error? }
  GET  /health    -> { ok, model, gpu_available, model_loaded, weights_present }

Model weights are mounted read-only from the shared weights bucket at
  WEIGHTS_DIR/MODEL_FILE
(see cloudbuild.yaml --add-volume). Pre-populate once with:
  huggingface-cli download robbyant/lingbot-map lingbot-map-long.pt --local-dir /tmp/lm
  gsutil cp /tmp/lm/lingbot-map-long.pt gs://three-ws-model-weights/lingbot-map/

Environment variables:
  API_KEY          shared bearer secret (Cloud Run secret)
  GCS_BUCKET       Cloud Storage bucket for output point clouds
  WEIGHTS_DIR      local mount of model weights (default /weights/lingbot-map)
  MODEL_FILE       checkpoint filename (default lingbot-map-long.pt)
  SKYSEG_FILE      sky-segmentation ONNX filename (default skyseg.onnx)
  LINGBOT_DIR      repo checkout on PYTHONPATH (default /opt/lingbot-map)
  MAX_CONCURRENT   max parallel reconstructions (default 1, heavy long jobs)
  MAX_FRAMES       hard frame cap per job (default 512, RAM-bound, see README)
  MAX_FRAME_NUM    3D RoPE frame budget the model is built with (default 1024)
  USE_SDPA         set to 1 to force PyTorch SDPA attention over FlashInfer
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Optional

import numpy as np
import torch
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from google.cloud import storage
from pydantic import BaseModel, Field

from scene_fusion import fuse_point_cloud, to_np, write_ply
from worker_security import (
    UnsafeUrlError,
    fetch_remote_bytes,
    require_api_key,
    safe_error,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("video2scene")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
WEIGHTS_DIR = os.environ.get("WEIGHTS_DIR", "/weights/lingbot-map")
MODEL_FILE = os.environ.get("MODEL_FILE", "lingbot-map-long.pt")
SKYSEG_FILE = os.environ.get("SKYSEG_FILE", "skyseg.onnx")
SKYSEG_CACHE_DIR = os.environ.get("SKYSEG_CACHE_DIR", "/tmp/skyseg")
LINGBOT_DIR = os.environ.get("LINGBOT_DIR", "/opt/lingbot-map")
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "1"))

# Structural model config. These are LingBot-Map's own demo.py defaults, which is
# what the published checkpoints are exercised with; load_model() builds GCTStream
# from them (the checkpoint carries weights, not architecture), so they have to be
# spelled out here rather than inferred.
IMAGE_SIZE = 518
PATCH_SIZE = 14
ENABLE_3D_ROPE = True
KV_CACHE_SLIDING_WINDOW = 64
CAMERA_NUM_ITERATIONS = 4

# 3D RoPE is sized for MAX_FRAME_NUM frames, so no job may exceed it. MAX_FRAMES
# is the tighter, host-RAM-bound cap: fusion holds world points, confidences and
# RGB for every pixel of every frame at once (~12 MB per 518x518 frame), so 512
# frames peaks around 10 GB of the instance's 32 GiB. Long clips lower `fps`
# instead of raising this.
MAX_FRAME_NUM = int(os.environ.get("MAX_FRAME_NUM", "1024"))
MAX_FRAMES = min(int(os.environ.get("MAX_FRAMES", "512")), MAX_FRAME_NUM)
MAX_POINT_BUDGET = 4_000_000

# Finished tasks are kept so callers can poll after the fact; the oldest are
# dropped past this so a long-lived instance cannot grow without bound.
TASK_HISTORY = 256

_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_tasks: dict[str, dict] = {}
_device = "cuda" if torch.cuda.is_available() else "cpu"

# One model at a time: a checkpoint is ~4.6 GB and the streaming and windowed
# modes are different classes, so the loaded model is cached under its build key
# and swapped when a request needs a different one.
_model = None
_model_key: Optional[tuple[str, int]] = None
_model_error: Optional[str] = None
_model_lock = threading.Lock()


# -- model loading -------------------------------------------------------------


def _use_sdpa() -> bool:
    """FlashInfer is the fast path; SDPA is the fallback when it is unusable.

    FlashInfer JIT-compiles CUDA kernels, so it is neither importable nor useful
    on a CPU-only host. USE_SDPA=1 forces the fallback if the JIT ever breaks in
    production without needing a code change.
    """
    if os.environ.get("USE_SDPA", "").strip().lower() in ("1", "true", "yes"):
        return True
    if not torch.cuda.is_available():
        return True
    try:
        import flashinfer  # noqa: F401
    except Exception:
        log.warning("flashinfer unavailable; falling back to SDPA attention")
        return True
    return False


def _build_args(mode: str, num_scale_frames: int) -> SimpleNamespace:
    """Exactly the attributes LingBot-Map's demo.load_model() reads off argparse.

    Feeding it the same namespace the CLI builds keeps the repo's own loader as
    the single source of truth for how GCTStream is constructed and how the
    checkpoint is applied.
    """
    return SimpleNamespace(
        model_path=os.path.join(WEIGHTS_DIR, MODEL_FILE),
        mode=mode,
        image_size=IMAGE_SIZE,
        patch_size=PATCH_SIZE,
        enable_3d_rope=ENABLE_3D_ROPE,
        max_frame_num=MAX_FRAME_NUM,
        kv_cache_sliding_window=KV_CACHE_SLIDING_WINDOW,
        num_scale_frames=num_scale_frames,
        use_sdpa=_use_sdpa(),
        camera_num_iterations=CAMERA_NUM_ITERATIONS,
    )


def _inference_dtype() -> torch.dtype:
    if not torch.cuda.is_available():
        return torch.float32
    return torch.bfloat16 if torch.cuda.get_device_capability()[0] >= 8 else torch.float16


def _ensure_lingbot_on_path() -> None:
    import sys

    if LINGBOT_DIR not in sys.path:
        sys.path.insert(0, LINGBOT_DIR)


def _get_model(mode: str, num_scale_frames: int):
    """Return the GCTStream for this (mode, scale-frame) build, loading if needed.

    ``kv_cache_scale_frames`` is baked in at construction from num_scale_frames,
    and windowed inference lives on a different class than streaming, so both are
    part of the cache key. A request that needs a different build swaps the
    resident model rather than holding two multi-GB models on one L4.
    """
    global _model, _model_key, _model_error

    key = (mode, int(num_scale_frames))
    with _model_lock:
        if _model is not None and _model_key == key:
            return _model

        _ensure_lingbot_on_path()
        from demo import load_model

        ckpt = os.path.join(WEIGHTS_DIR, MODEL_FILE)
        if not os.path.exists(ckpt):
            raise FileNotFoundError(f"checkpoint not found: {ckpt}")

        if _model is not None:
            log.info("Swapping model build %s -> %s", _model_key, key)
            _model = None
            _model_key = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        t0 = time.time()
        log.info("Loading LingBot-Map %s (%s) on %s", MODEL_FILE, key, _device)
        model = load_model(_build_args(mode, num_scale_frames), torch.device(_device))

        dtype = _inference_dtype()
        if dtype != torch.float32 and getattr(model, "aggregator", None) is not None:
            # Upstream demo.py casts the DINOv2-style trunk to the inference dtype:
            # it drops the redundant fp32 master copy plus the autocast weight cache
            # (a few GB) with no measurable quality change, while the camera/depth/
            # point heads keep fp32 weights of their own accord.
            model.aggregator = model.aggregator.to(dtype=dtype)

        model.eval()
        _model, _model_key, _model_error = model, key, None
        log.info("Model ready in %.1fs (dtype=%s)", time.time() - t0, dtype)
        return _model


def _weights_present() -> bool:
    return os.path.isfile(os.path.join(WEIGHTS_DIR, MODEL_FILE))


def _get_bucket() -> storage.Bucket:
    """The output bucket, resolved on first use.

    Binding it lazily keeps a credentials hiccup (or a local run with no ADC)
    from taking the whole service down at startup: the model still loads, health
    still answers, and only the upload at the end of a job needs the client.
    """
    global _bucket
    if _bucket is None:
        _bucket = storage.Client().bucket(GCS_BUCKET)
    return _bucket


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _sem, _model_error
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    loop = asyncio.get_event_loop()
    try:
        # Warm the default build so the first real request does not pay the load.
        await loop.run_in_executor(None, _get_model, "streaming", 8)
    except Exception as exc:  # noqa: BLE001 - startup must not take the port down
        _model_error = str(exc)
        log.exception("Model preload failed; /health will report model_loaded=false")
    log.info("Service ready: max_concurrent=%d device=%s", MAX_CONCURRENT, _device)
    yield


app = FastAPI(title="model-video2scene", lifespan=lifespan)


def _require_api_key(authorization: str) -> None:
    try:
        require_api_key(authorization, API_KEY)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


# -- input acquisition ---------------------------------------------------------


def _fetch_video(video_url: str, dst_dir: str) -> str:
    try:
        data = fetch_remote_bytes(video_url, timeout=120, max_bytes=512 * 1024 * 1024)
    except UnsafeUrlError as exc:
        raise ValueError(f"refused to fetch video source: {exc}") from exc
    ext = os.path.splitext(video_url.split("?", 1)[0])[1].lower()
    if ext not in (".mp4", ".mov", ".webm", ".mkv", ".avi"):
        ext = ".mp4"
    path = os.path.join(dst_dir, f"input{ext}")
    with open(path, "wb") as fh:
        fh.write(data)
    return path


def _materialize_images(images: list[str], dst_dir: str) -> str:
    """Write caller-supplied frames to a folder LingBot-Map's loader can read."""
    folder = os.path.join(dst_dir, "frames")
    os.makedirs(folder, exist_ok=True)
    for i, src in enumerate(images[: MAX_FRAMES + 1]):
        if src.startswith("data:image"):
            payload = base64.b64decode(src.split(",", 1)[1])
        elif src.startswith("https://"):
            try:
                payload = fetch_remote_bytes(src, timeout=30)
            except UnsafeUrlError as exc:
                raise ValueError(f"refused to fetch frame {i}: {exc}") from exc
        else:
            raise ValueError(f"unsupported image source at {i}: {src[:48]}")
        with open(os.path.join(folder, f"{i:06d}.jpg"), "wb") as fh:
            fh.write(payload)
    return folder


# -- sky masking ---------------------------------------------------------------


def _skyseg_model_path() -> str:
    """Path to skyseg.onnx: the weights mount first, a local cache as fallback.

    Staging it next to the checkpoint keeps the instance off the public internet
    on the hot path; the download fallback keeps sky masking working on a mount
    that predates the file.
    """
    mounted = os.path.join(WEIGHTS_DIR, SKYSEG_FILE)
    if os.path.isfile(mounted):
        return mounted

    local = os.path.join(SKYSEG_CACHE_DIR, SKYSEG_FILE)
    if not os.path.isfile(local):
        os.makedirs(SKYSEG_CACHE_DIR, exist_ok=True)
        _ensure_lingbot_on_path()
        from lingbot_map.vis import download_skyseg_model

        log.info("skyseg model absent from %s; downloading to %s", mounted, local)
        download_skyseg_model(local)
    return local


def _world_points_and_conf(predictions: dict):
    """The world-space points to fuse, and their per-pixel confidence.

    LingBot-Map's GCTStream is built with ``enable_point=False``, so the released
    checkpoints carry no point head and inference returns depth rather than a
    point map: the world points come from unprojecting that depth with the camera
    the model predicted, which is what the upstream viewer and GLB export do too.
    The ``world_points`` branch stays for a checkpoint that does ship a point head.
    """
    if predictions.get("world_points") is not None:
        return predictions["world_points"], predictions.get("world_points_conf")

    missing = [k for k in ("depth", "extrinsic", "intrinsic") if predictions.get(k) is None]
    if missing:
        raise ValueError(
            "cannot build a point cloud: predictions are missing " + ", ".join(missing)
        )

    _ensure_lingbot_on_path()
    from lingbot_map.utils.geometry import (
        closed_form_inverse_se3,
        unproject_depth_map_to_point_map,
    )

    # postprocess() hands back camera-to-world, while the unprojector documents its
    # extrinsic as world-to-camera and inverts it itself. Undo the conversion so the
    # points land in front of the cameras instead of mirrored behind them.
    extrinsic_w2c = closed_form_inverse_se3(predictions["extrinsic"])[:, :3, :4]
    points = unproject_depth_map_to_point_map(
        predictions["depth"], extrinsic_w2c, predictions["intrinsic"]
    )
    return points, predictions.get("depth_conf")


def _sky_keep_mask(conf, images, dst_dir: str) -> tuple[Optional[np.ndarray], int]:
    """Per-point boolean mask with sky pixels removed, plus how many were dropped.

    Runs LingBot-Map's own sky segmentation over the preprocessed frames, which
    zeroes the confidence of sky pixels; anything left at zero confidence is not
    scene geometry and is dropped.
    """
    if conf is None:
        return None, 0
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        log.warning("onnxruntime unavailable; sky masking skipped for this job")
        return None, 0

    _ensure_lingbot_on_path()
    from lingbot_map.vis import apply_sky_segmentation

    conf_np = to_np(conf)
    masked = apply_sky_segmentation(
        conf_np,
        images=to_np(images),
        skyseg_model_path=_skyseg_model_path(),
        sky_mask_dir=os.path.join(dst_dir, "sky_masks"),
    )
    keep = np.asarray(masked).reshape(-1) > 0
    return keep, int(keep.size - int(keep.sum()))


# -- inference -----------------------------------------------------------------


def _load_frames(req: "InferRequest", dst_dir: str):
    """Decode the request's input into LingBot-Map's preprocessed frame tensor.

    Asks the loader for one frame more than the cap so an over-long input is
    detectable, then truncates: reporting the truncation beats silently
    reconstructing a prefix of what the caller sent.
    """
    _ensure_lingbot_on_path()
    from demo import load_images

    if req.video_url:
        video_path = _fetch_video(req.video_url, dst_dir)
        images, _paths, _folder = load_images(
            video_path=video_path,
            fps=req.fps,
            first_k=MAX_FRAMES + 1,
            image_size=IMAGE_SIZE,
            patch_size=PATCH_SIZE,
        )
    else:
        folder = _materialize_images(req.images or [], dst_dir)
        images, _paths, _folder = load_images(
            image_folder=folder,
            first_k=MAX_FRAMES + 1,
            image_size=IMAGE_SIZE,
            patch_size=PATCH_SIZE,
        )

    truncated = int(images.shape[0]) > MAX_FRAMES
    if truncated:
        images = images[:MAX_FRAMES]
    return images, truncated


def _run(req: "InferRequest", dst_dir: str) -> dict:
    _ensure_lingbot_on_path()
    from demo import postprocess

    images, truncated = _load_frames(req, dst_dir)
    frames = int(images.shape[0])
    if frames == 0:
        raise ValueError("no frames decoded from input")

    model = _get_model(req.mode, req.num_scale_frames)
    dtype = _inference_dtype()

    # The frames stay on CPU on purpose: both inference paths slice-then-move per
    # iteration, so peak VRAM tracks one window instead of the whole sequence.
    with torch.no_grad(), torch.amp.autocast(
        "cuda", dtype=dtype, enabled=torch.cuda.is_available()
    ):
        if req.mode == "windowed":
            predictions = model.inference_windowed(
                images,
                window_size=req.window_size,
                overlap_size=req.overlap_size,
                num_scale_frames=req.num_scale_frames,
                keyframe_interval=req.keyframe_interval,
                output_device=torch.device("cpu"),
            )
        else:
            predictions = model.inference_streaming(
                images,
                num_scale_frames=req.num_scale_frames,
                keyframe_interval=req.keyframe_interval,
                output_device=torch.device("cpu"),
            )

    # postprocess() converts poses to c2w, moves everything to CPU, drops the
    # leading batch dim, and hands the frames back separately (it removes the
    # "images" key from predictions), so the colours come from its return value.
    predictions, images_cpu = postprocess(predictions, images)

    world_points, conf = _world_points_and_conf(predictions)
    keep, sky_dropped = (None, 0)
    if req.mask_sky:
        try:
            keep, sky_dropped = _sky_keep_mask(conf, images_cpu, dst_dir)
        except Exception:  # noqa: BLE001 - a cosmetic filter must not lose the job
            # The reconstruction itself already succeeded and cost minutes of GPU
            # time; ship the cloud with the sky in it rather than fail the job.
            log.exception("sky masking failed; returning the unmasked cloud")

    pts, cols = fuse_point_cloud(
        world_points,
        images_cpu,
        conf=conf,
        keep=keep,
        conf_percentile=req.conf_percentile,
        max_points=req.max_points,
        voxel_size=req.voxel_size,
    )
    if pts.shape[0] == 0:
        raise ValueError("reconstruction produced no points above the confidence floor")

    return {
        "ply": write_ply(pts, cols),
        "num_points": int(pts.shape[0]),
        "frames": frames,
        "frames_truncated": truncated,
        "sky_points_removed": sky_dropped,
    }


async def _run_inference(task_id: str, req: "InferRequest") -> None:
    async with _sem:
        _tasks[task_id]["status"] = "running"
        loop = asyncio.get_event_loop()
        t0 = time.time()
        try:
            with tempfile.TemporaryDirectory() as dst_dir:
                result = await loop.run_in_executor(None, _run, req, dst_dir)

            ply_bytes = result.pop("ply")
            blob_name = f"scenes/video2scene/{task_id}.ply"
            await loop.run_in_executor(
                None,
                lambda: _get_bucket().blob(blob_name).upload_from_string(
                    ply_bytes, content_type="application/octet-stream"
                ),
            )
            gcs_url = f"https://storage.googleapis.com/{GCS_BUCKET}/{blob_name}"

            elapsed = time.time() - t0
            _tasks[task_id].update(
                {
                    "status": "done",
                    "result_gcs_url": gcs_url,
                    "bytes": len(ply_bytes),
                    "elapsed_ms": int(elapsed * 1000),
                    **result,
                }
            )
            log.info(
                "[%s] done in %.1fs: %d frames -> %d points (%d bytes) -> %s",
                task_id, elapsed, result["frames"], result["num_points"],
                len(ply_bytes), gcs_url,
            )
        except Exception as exc:  # noqa: BLE001 - surfaced opaquely below
            _tasks[task_id].update(
                {
                    "status": "failed",
                    "error": safe_error(exc, context=f"[{task_id}] reconstruction"),
                    "elapsed_ms": int((time.time() - t0) * 1000),
                }
            )
        finally:
            _prune_tasks()


def _prune_tasks() -> None:
    """Drop the oldest settled tasks once the history budget is exceeded."""
    overflow = len(_tasks) - TASK_HISTORY
    if overflow <= 0:
        return
    for task_id, task in list(_tasks.items()):
        if overflow <= 0:
            return
        if task.get("status") in ("done", "failed"):
            _tasks.pop(task_id, None)
            overflow -= 1


# -- API -----------------------------------------------------------------------


class InferRequest(BaseModel):
    video_url: str | None = None
    images: list[str] | None = Field(default=None, max_length=MAX_FRAME_NUM)
    mode: str = "streaming"
    fps: int = Field(default=8, ge=1, le=30)
    keyframe_interval: int = Field(default=4, ge=1, le=64)
    num_scale_frames: int = Field(default=8, ge=2, le=16)
    window_size: int = Field(default=128, ge=16, le=512)
    overlap_size: int = Field(default=16, ge=0, le=128)
    mask_sky: bool = True
    conf_percentile: float = Field(default=30.0, ge=0.0, le=95.0)
    max_points: int = Field(default=1_500_000, ge=10_000, le=MAX_POINT_BUDGET)
    voxel_size: float = Field(default=0.0, ge=0.0, le=10.0)
    job_id: str | None = None


@app.post("/infer", status_code=202)
async def infer(
    body: InferRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(...),
) -> dict:
    _require_api_key(authorization)
    if not body.video_url and not (body.images and len(body.images) > 0):
        raise HTTPException(status_code=400, detail="provide video_url or images[]")
    if body.mode not in ("streaming", "windowed"):
        raise HTTPException(status_code=400, detail="mode must be streaming or windowed")
    if not _weights_present():
        # Fail the submission rather than queue a job that cannot succeed; the
        # three.ws API maps this to its "capture is unconfigured" state.
        raise HTTPException(
            status_code=503,
            detail=f"model weights are not mounted at {WEIGHTS_DIR}/{MODEL_FILE}",
        )
    task_id = str(uuid.uuid4())
    _tasks[task_id] = {"task_id": task_id, "status": "queued", "model": "video2scene"}
    background_tasks.add_task(_run_inference, task_id, body)
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
    return {
        "ok": True,
        "model": "video2scene",
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "model_loaded": _model is not None,
        "model_build": list(_model_key) if _model_key else None,
        "weights_present": _weights_present(),
        "max_frames": MAX_FRAMES,
        "error": _model_error,
    }
