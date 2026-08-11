"""
Background removal service: strips the background from an image and returns a
transparent PNG, using rembg (MIT) and its ONNX salient-object-detection models.

API contract:
  POST /remove   { image: data-uri|url, model?: name }
              →  202 { task_id, status: "queued", model }
       model is one of u2net | isnet-general-use | u2net_human_seg | silueta.
       The legacy aliases "rmbg2" and "isnet" resolve to isnet-general-use.

  GET  /tasks/:id → { task_id, status, result_url?, error? }

  GET  /health    → { ok, models_loaded, models_available, default_model,
                      gpu_available, execution_providers }

No GPU required: the models run on ONNX Runtime's CPU provider in ~1-2 s for the
inference step. Only the default model is loaded at startup (the rest load
lazily on first use) so cold starts stay fast and /remove returns instantly.

Environment variables:
  API_KEY           shared bearer secret (required)
  GCS_BUCKET        Cloud Storage bucket for output PNGs (required)
  MODEL             default model name (default: isnet-general-use)
  MAX_CONCURRENT    in-flight removals allowed at once (default: 4)
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
import logging
import os
import threading
import time
import uuid
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from google.cloud import storage
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

from rembg_policy import (
    CANONICAL_MODELS,
    MAX_TASKS,
    SourceImageError,
    TASK_RETENTION_S,
    canonical_model,
    gpu_providers,
    prune_tasks,
)
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
log = logging.getLogger("rembg")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "4"))

# The startup default, pre-baked into the image (see Dockerfile), so warming it
# never touches the network. Env override is resolved through the alias table.
DEFAULT_MODEL = canonical_model(os.environ.get("MODEL", ""))

# Some image hosts (Wikimedia most visibly) answer 403 to a bare library
# user-agent. Identify the service and where to complain about it, per their
# published policy, so a public image URL a user pastes actually resolves.
USER_AGENT = "three.ws-rembg/1.0 (background removal worker; +https://three.ws)"
FETCH_TIMEOUT_S = 30.0
MAX_SOURCE_BYTES = 16 * 1024 * 1024

# Timestamps prune_tasks() reads; never part of the wire response.
_INTERNAL_TASK_FIELDS = ("created_at", "finished_at")

_sessions: dict[str, object] = {}
_sessions_lock = threading.Lock()
_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_tasks: dict[str, dict] = {}


def _get_session(model_name: str):
    """Lazily build (and cache) a rembg session, double-checked under a lock so
    the worker thread-pool never loads the same model twice. Only the default
    model is warmed at startup; the rest load on first use, so cold start stays
    fast and the /remove submit returns its 202 immediately."""
    canon = canonical_model(model_name, fallback=DEFAULT_MODEL)
    session = _sessions.get(canon)
    if session is not None:
        return session
    with _sessions_lock:
        session = _sessions.get(canon)
        if session is None:
            import rembg
            session = rembg.new_session(canon)
            _sessions[canon] = session
            log.info("Loaded rembg session: %s", canon)
        return session


def _execution_providers() -> list:
    """ONNX Runtime execution providers this build can use."""
    import onnxruntime
    return list(onnxruntime.get_available_providers())


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    loop = asyncio.get_event_loop()
    # Warm only the default model so the container becomes ready in seconds; the
    # other models are loaded lazily on first request.
    await loop.run_in_executor(None, _get_session, DEFAULT_MODEL)
    log.info("rembg service ready, default model: %s", DEFAULT_MODEL)
    yield


app = FastAPI(title="rembg-service", lifespan=lifespan)


def _require_api_key(authorization: Optional[str]) -> None:
    try:
        require_api_key(authorization, API_KEY)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


def _open_image(data: bytes) -> Image.Image:
    """Decode fetched bytes into RGBA, or say what arrived instead.

    RGBA is what rembg composites against: it pastes the cutout onto a
    transparent RGBA canvas of the same mode, so handing it RGB raises deep
    inside the library with a message no caller could act on.
    """
    try:
        return Image.open(io.BytesIO(data)).convert("RGBA")
    except UnidentifiedImageError as exc:
        raise SourceImageError(
            "the source is not a decodable image (expected PNG, JPEG, WebP or similar)"
        ) from exc
    except OSError as exc:
        raise SourceImageError(f"the source image is truncated or corrupt: {exc}") from exc


def _decode_image(src: str) -> Image.Image:
    if src.startswith("data:image"):
        _, _, payload = src.partition(",")
        try:
            raw = base64.b64decode(payload, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise SourceImageError("the data URI payload is not valid base64") from exc
        return _open_image(raw)
    if src.startswith("https://"):
        try:
            data = fetch_remote_bytes(
                src,
                timeout=FETCH_TIMEOUT_S,
                max_bytes=MAX_SOURCE_BYTES,
                headers={"User-Agent": USER_AGENT},
            )
        except UnsafeUrlError as exc:
            raise SourceImageError(f"refused to fetch the image: {exc}") from exc
        except httpx.HTTPStatusError as exc:
            raise SourceImageError(
                f"the image URL returned HTTP {exc.response.status_code}"
            ) from exc
        except httpx.HTTPError as exc:
            raise SourceImageError(f"could not fetch the image URL: {type(exc).__name__}") from exc
        except ValueError as exc:
            # fetch_remote_bytes raises ValueError once the body passes max_bytes.
            raise SourceImageError(str(exc)) from exc
        return _open_image(data)
    raise SourceImageError("image must be an https:// URL or a data:image/... URI")


def _run_removal(img: Image.Image, model_name: str) -> Image.Image:
    """Cut the subject out, returning an RGBA image.

    The image goes to rembg as a PIL image rather than as re-encoded PNG bytes:
    the round trip cost more than the inference itself (2.9 s of the 8.1 s total
    on a 12 MP photo, measured on 2 cores) and threw away the EXIF orientation,
    so upright phone photos came back on their side.
    """
    import rembg
    session = _get_session(model_name)
    return rembg.remove(img, session=session)


async def _process(task_id: str, image_src: str, model_name: str) -> None:
    async with _sem:
        _tasks[task_id]["status"] = "running"
        loop = asyncio.get_event_loop()
        t0 = time.time()
        try:
            img = await loop.run_in_executor(None, _decode_image, image_src)
            result = await loop.run_in_executor(None, _run_removal, img, model_name)

            buf = io.BytesIO()
            result.save(buf, format="PNG")
            png_bytes = buf.getvalue()

            blob_name = f"rembg/{task_id}.png"
            blob = _bucket.blob(blob_name)
            await loop.run_in_executor(
                None,
                lambda: blob.upload_from_string(png_bytes, content_type="image/png"),
            )
            result_url = f"https://storage.googleapis.com/{GCS_BUCKET}/{blob_name}"

            elapsed = time.time() - t0
            _tasks[task_id].update({
                "status": "done",
                "result_url": result_url,
                "width": result.width,
                "height": result.height,
                "elapsed_ms": int(elapsed * 1000),
                "finished_at": time.time(),
            })
            log.info("[%s] done in %.2fs, %d bytes", task_id, elapsed, len(png_bytes))

        except SourceImageError as exc:
            # The caller's input is at fault, so answer with what is wrong. The
            # opaque safe_error path exists for OUR failures, and using it here
            # sent people hunting a service outage over a dead image link.
            log.warning("[%s] rejected source image: %s", task_id, exc)
            _tasks[task_id].update({
                "status": "failed",
                "error": str(exc),
                "elapsed_ms": int((time.time() - t0) * 1000),
                "finished_at": time.time(),
            })
        except Exception as exc:
            _tasks[task_id].update({
                "status": "failed",
                "error": safe_error(exc, context=f"[{task_id}] rembg"),
                "elapsed_ms": int((time.time() - t0) * 1000),
                "finished_at": time.time(),
            })


class RemoveRequest(BaseModel):
    image: str = Field(..., description="data-uri or https URL of the source image")
    model: str = Field(default="rmbg2", description="rembg model name")


@app.post("/remove", status_code=202)
async def remove_background(
    body: RemoveRequest,
    background_tasks: BackgroundTasks,
    authorization: Optional[str] = Header(default=None),
) -> dict:
    _require_api_key(authorization)
    model_name = canonical_model(body.model, fallback=DEFAULT_MODEL)
    task_id = str(uuid.uuid4())
    now = time.time()
    evicted = prune_tasks(_tasks, now)
    if evicted:
        log.info("pruned %d finished task(s), %d retained", len(evicted), len(_tasks))
    _tasks[task_id] = {
        "task_id": task_id,
        "status": "queued",
        "model": model_name,
        "created_at": now,
    }
    background_tasks.add_task(_process, task_id, body.image, model_name)
    return {"task_id": task_id, "status": "queued", "model": model_name}


@app.get("/tasks/{task_id}")
async def get_task(task_id: str, authorization: Optional[str] = Header(default=None)) -> dict:
    _require_api_key(authorization)
    task = _tasks.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    # Retention bookkeeping stays server-side: the documented response shape is
    # what callers get, whatever the eviction policy needs to track.
    return {key: value for key, value in task.items() if key not in _INTERNAL_TASK_FIELDS}


@app.get("/health")
async def health() -> dict:
    providers = _execution_providers()
    return {
        "ok": True,
        "service": "rembg",
        "gpu_available": bool(gpu_providers(providers)),
        "execution_providers": providers,
        "models_loaded": list(_sessions),
        "models_available": list(CANONICAL_MODELS),
        "default_model": DEFAULT_MODEL,
        "tasks_tracked": len(_tasks),
        "task_retention_s": TASK_RETENTION_S,
        "max_tasks": MAX_TASKS,
    }
