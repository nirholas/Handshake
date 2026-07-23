"""Text-to-motion service — prompt → retargetable three.js animation clip.

Wraps a text-to-motion diffusion model (MDM — Motion Diffusion Model,
GuyTevet/motion-diffusion-model, MIT) on GPU. Given a natural-language prompt
("waving confidently", "a slow tai-chi sweep") it samples SMPL-skeleton motion,
then converts it to a canonical three.js AnimationClip JSON (Wolf3D bone names —
see smpl_to_clip.py) that the platform retargets onto any rigged avatar with the
same engine the curated animation library uses. Output is uploaded to GCS and
the URL returned, mirroring the model-* worker contract exactly.

Licensing
  - MDM (GuyTevet/motion-diffusion-model) — MIT, commercial-OK. Chosen over
    MoMask / T2M-GPT specifically because MIT is unambiguously commercial-safe;
    if a higher-quality model with a commercial license is adopted later, only
    `_generate_motion()` changes — the contract and the clip conversion do not.

API contract (identical shape to the other model-* workers):
  POST /infer   { prompt: str, duration_seconds?: float=4, fps?: int=30, job_id?: str }
                → 202 { task_id, status: "queued" }
  GET  /tasks/:id → { task_id, status, result_url?, frames?, fps?, error? }
  GET  /health    → { ok }

Environment:
  API_KEY            — bearer secret (required)
  GCS_BUCKET         — output bucket (required)
  MAX_CONCURRENT     — default 2
  MOTION_MODEL_DIR   — directory of MDM checkpoints (mounted from GCS)
  MAX_DURATION_SEC   — hard cap on requested clip length (default 10)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from google.cloud import storage
from pydantic import BaseModel, Field

from smpl_to_clip import smpl_motion_to_clip
from worker_security import require_api_key, safe_error

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("text2motion")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "2"))
MOTION_MODEL_DIR = os.environ.get("MOTION_MODEL_DIR", "/weights/mdm")
MAX_DURATION_SEC = float(os.environ.get("MAX_DURATION_SEC", "10"))
DEFAULT_FPS = 30

_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_ready: Optional[asyncio.Event] = None
_load_error: Optional[str] = None
_tasks: dict[str, dict] = {}
_model = None  # lazily-loaded MDM sampler


async def _load_model_bg() -> None:
    global _load_error
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, _load_model)
        _ready.set()
        log.info("text2motion ready — max_concurrent=%d", MAX_CONCURRENT)
    except Exception as exc:  # noqa: BLE001
        _load_error = safe_error(exc, context="MDM checkpoint load")
        log.error("MDM model load FAILED: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem, _ready
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    _ready = asyncio.Event()
    # Load the checkpoint in the BACKGROUND and yield immediately — uvicorn
    # runs the ASGI lifespan before binding the socket, and the full load
    # (MDM transformer + CUDA transfer from the GCS FUSE-mounted weights dir)
    # can run past Cloud Run's startup TCP-probe window on a cold instance.
    # Backgrounding opens the port at once; requests that arrive before the
    # load completes wait on `_ready` in `_run_inference`. Same pattern as
    # model-trellis / model-triposg.
    asyncio.create_task(_load_model_bg())
    log.info("text2motion starting, model loading in background (max_concurrent=%d)", MAX_CONCURRENT)
    yield


app = FastAPI(title="model-text2motion", lifespan=lifespan)


def _require_api_key(authorization: str) -> None:
    try:
        require_api_key(authorization, API_KEY)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


def _load_model() -> None:
    """Load the MDM sampler once per container.

    Kept import-local so the FastAPI app + the pure conversion path import
    cleanly in environments without torch/MDM installed (tests, CI). On the GPU
    runtime this loads the checkpoint from MOTION_MODEL_DIR.
    """
    global _model
    from mdm_sampler import MdmSampler  # provided in the GPU image (see Dockerfile)

    _model = MdmSampler(model_dir=MOTION_MODEL_DIR, device="cuda")
    log.info("MDM checkpoint loaded from %s", MOTION_MODEL_DIR)


def _generate_motion(prompt: str, n_frames: int):
    """Sample SMPL motion for `prompt`. Returns (poses (T,24,3), trans (T,3))."""
    if _model is None:
        raise RuntimeError("motion model not loaded")
    poses, trans = _model.sample(prompt=prompt, n_frames=n_frames)
    return poses, trans


class InferRequest(BaseModel):
    prompt: str = Field(..., min_length=3, max_length=1000)
    duration_seconds: float = Field(default=4.0, gt=0)
    fps: int = Field(default=DEFAULT_FPS, ge=8, le=60)
    job_id: Optional[str] = None


@app.post("/infer", status_code=202)
async def infer(body: InferRequest, background_tasks: BackgroundTasks, authorization: str = Header(...)) -> dict:
    _require_api_key(authorization)
    task_id = body.job_id or str(uuid.uuid4())
    _tasks[task_id] = {"task_id": task_id, "status": "queued", "model": "mdm"}
    duration = min(body.duration_seconds, MAX_DURATION_SEC)
    n_frames = max(2, int(round(duration * body.fps)))
    background_tasks.add_task(_run_inference, task_id, body.prompt, n_frames, body.fps)
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
        "model_loaded": _model is not None,
        "status": "ready" if _model is not None else ("failed" if _load_error else "loading"),
        "load_error": _load_error,
    }


async def _run_inference(task_id: str, prompt: str, n_frames: int, fps: int) -> None:
    assert _sem is not None and _bucket is not None and _ready is not None
    async with _sem:
        _tasks[task_id]["status"] = "running"
        started = time.time()
        loop = asyncio.get_event_loop()
        try:
            try:
                await asyncio.wait_for(_ready.wait(), timeout=600)
            except asyncio.TimeoutError:
                raise RuntimeError(_load_error or "model load timed out")
            poses, trans = await loop.run_in_executor(None, _generate_motion, prompt, n_frames)
            clip = smpl_motion_to_clip(poses, trans, fps=fps, name=_safe_name(prompt))
            payload = json.dumps(clip).encode("utf-8")

            blob_name = f"motion-clips/mdm/{task_id}.json"
            blob = _bucket.blob(blob_name)
            await loop.run_in_executor(
                None,
                lambda: blob.upload_from_string(payload, content_type="application/json"),
            )
            url = f"https://storage.googleapis.com/{GCS_BUCKET}/{blob_name}"
            _tasks[task_id].update(
                {
                    "status": "done",
                    "result_url": url,
                    "frames": int(n_frames),
                    "fps": int(fps),
                    "elapsed_ms": int((time.time() - started) * 1000),
                }
            )
            log.info("task %s done — %d frames in %dms", task_id, n_frames, int((time.time() - started) * 1000))
        except Exception as exc:  # surface an opaque, correlated error to the caller
            msg = safe_error(exc, context=f"text2motion task {task_id}")
            _tasks[task_id].update({"status": "failed", "error": msg})
            log.exception("task %s failed", task_id)


def _safe_name(prompt: str) -> str:
    slug = "".join(c if c.isalnum() else "-" for c in prompt.lower()).strip("-")
    return (slug[:40] or "generated").rstrip("-")
