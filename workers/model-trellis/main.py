"""
TRELLIS inference service — single-image to textured 3D mesh via structured
latent representations (Microsoft, MIT license).

API contract (consumed by the Pipeline Controller):
  POST /infer   { images: [data-uri|url, ...], body_type?: str, job_id?: str }
             →  202 { task_id, status: "queued" }

  GET  /tasks/:id → { task_id, status, result_gcs_url?, error? }

  GET  /health    → { ok, model, gpu_available }

Model weights pre-population:
  pip install huggingface_hub
  huggingface-cli download microsoft/TRELLIS-image-large --local-dir /tmp/trellis-large
  gsutil -m cp -r /tmp/trellis-large gs://three-ws-model-weights/trellis-large/

Environment variables:
  API_KEY           — shared bearer secret
  GCS_BUCKET        — Cloud Storage bucket for output meshes
  WEIGHTS_DIR       — local path to model weights (default: /weights/trellis-large)
  MAX_CONCURRENT    — max parallel inferences (default: 1)
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import time
import uuid

# TRELLIS reads its attention + sparse-conv backends from the environment at
# import time. The Dockerfile sets these as ENV; default them here too so the
# service still loads correctly if deployed with a bare env. xformers is chosen
# over flash-attn (no source compile) and runs well on the L4.
os.environ.setdefault("ATTN_BACKEND", "xformers")
os.environ.setdefault("SPCONV_ALGO", "native")
from contextlib import asynccontextmanager
from typing import Optional

import torch
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from google.api_core.exceptions import NotFound
from google.cloud import storage
from PIL import Image
from pydantic import BaseModel, Field

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
log = logging.getLogger("trellis")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
WEIGHTS_DIR = os.environ.get("WEIGHTS_DIR", "/weights/trellis-large")
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "1"))
# Optional: stage the ~3 GB weight tree from GCS to fast local disk at startup,
# then load from there instead of the Cloud Storage FUSE mount. The FUSE mount
# serves the model's random-access reads over the network, and a cold load
# routinely stalls on it ("stalled read-req cancelled", "context deadline
# exceeded") — turning a ~50s warm load into 15+ minutes, or a hard timeout. The
# storage client streams each object with a plain sequential HTTP GET, which does
# not suffer that stall. When WEIGHTS_GCS_URI is unset, or staging fails for any
# reason, the loader falls back to WEIGHTS_DIR unchanged — this can only add
# reliability, never remove the existing path.
WEIGHTS_GCS_URI = os.environ.get("WEIGHTS_GCS_URI", "")  # e.g. gs://bucket/trellis-large
WEIGHTS_LOCAL_DIR = os.environ.get("WEIGHTS_LOCAL_DIR", "/tmp/trellis-weights")

_pipeline = None
_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_ready: Optional[asyncio.Event] = None
_load_error: Optional[str] = None
# In-memory cache only — Cloud Run runs this service across up to _MAX_INSTANCES
# containers with no session affinity, so a POST /infer and a later GET
# /tasks/:id can land on different instances. The durable source of truth is
# the `tasks/{task_id}.json` blob in GCS (see _update_task / get_task); this
# dict just avoids a GCS round-trip when a poll happens to hit the same warm
# instance that ran the job.
_tasks: dict[str, dict] = {}


def _stage_weights_local() -> Optional[str]:
    """Download the weight tree from GCS to local disk with the storage client,
    bypassing the FUSE mount. Returns the local dir on success, or None to signal
    "load from WEIGHTS_DIR as before". Never raises — a staging failure must
    degrade to the existing FUSE-mount load, not crash the loader."""
    if not WEIGHTS_GCS_URI.startswith("gs://"):
        return None
    try:
        from concurrent.futures import ThreadPoolExecutor

        bucket_name, _, prefix = WEIGHTS_GCS_URI[len("gs://"):].partition("/")
        client = storage.Client()
        blobs = [b for b in client.list_blobs(bucket_name, prefix=prefix) if not b.name.endswith("/")]
        if not blobs:
            log.warning("weights staging: no objects under %s; using FUSE mount", WEIGHTS_GCS_URI)
            return None

        def _download(blob) -> int:
            rel = blob.name[len(prefix):].lstrip("/")
            dest = os.path.join(WEIGHTS_LOCAL_DIR, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            # Reuse an already-staged object (same-instance warm restart) when its
            # size matches, so a reload doesn't re-pull 3 GB.
            if os.path.exists(dest) and blob.size is not None and os.path.getsize(dest) == blob.size:
                return blob.size or 0
            blob.download_to_filename(dest)
            return blob.size or os.path.getsize(dest)

        os.makedirs(WEIGHTS_LOCAL_DIR, exist_ok=True)
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=8) as pool:
            total = sum(pool.map(_download, blobs))
        log.info(
            "weights staged to %s in %.1fs (%d objects, %.2f GiB)",
            WEIGHTS_LOCAL_DIR, time.time() - t0, len(blobs), total / (1024 ** 3),
        )
        return WEIGHTS_LOCAL_DIR
    except Exception as exc:  # noqa: BLE001 — degrade to the FUSE mount, never crash
        log.warning("weights staging failed (%s); falling back to FUSE mount %s", exc, WEIGHTS_DIR)
        return None


def _load_pipeline():
    global _pipeline
    from trellis.pipelines import TrellisImageTo3DPipeline

    weights_path = _stage_weights_local() or WEIGHTS_DIR
    log.info("Loading TRELLIS pipeline from %s", weights_path)
    _pipeline = TrellisImageTo3DPipeline.from_pretrained(weights_path)
    # TRELLIS exposes .cuda() (not .to()) to move every sub-model to the GPU.
    _pipeline.cuda()
    log.info("TRELLIS pipeline loaded")


async def _load_pipeline_bg():
    """Load the pipeline off the request path and signal readiness when done.

    Runs the blocking, GPU-bound load in a worker thread so the event loop (and
    the HTTP port) stay live. On failure the error is recorded and surfaced via
    /health and per-task, rather than crash-looping the container.
    """
    global _load_error
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, _load_pipeline)
        _ready.set()
        log.info("TRELLIS pipeline ready")
    except Exception as exc:  # noqa: BLE001 — surfaced via /health + task status
        _load_error = safe_error(exc, context="model load")
        log.error("TRELLIS pipeline load FAILED: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem, _ready
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    _ready = asyncio.Event()
    # Load the ~3 GB pipeline in the BACKGROUND and yield immediately. uvicorn
    # runs the ASGI lifespan BEFORE it binds the socket, so a blocking load here
    # would delay the port past Cloud Run's startup TCP-probe window (the model
    # load + GPU transfer runs minutes on a cold instance) and the revision would
    # be marked failed. Backgrounding lets the port open at once; requests that
    # arrive before the load completes wait on _ready (see _run_inference).
    asyncio.create_task(_load_pipeline_bg())
    log.info("Service starting — pipeline loading in background (max_concurrent=%d)", MAX_CONCURRENT)
    yield


app = FastAPI(title="model-trellis", lifespan=lifespan)


def _require_api_key(authorization: str) -> None:
    try:
        require_api_key(authorization, API_KEY)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


def _decode_image(src: str) -> Image.Image:
    if src.startswith("data:image"):
        b64 = src.split(",", 1)[1]
        return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
    if src.startswith("https://"):
        # SSRF-hardened: https-only, private/loopback/link-local/metadata IPs
        # rejected after DNS resolution, redirects re-validated per hop, bounded.
        try:
            data = fetch_remote_bytes(src, timeout=30)
        except UnsafeUrlError as exc:
            raise ValueError(f"refused to fetch image source: {exc}") from exc
        return Image.open(io.BytesIO(data)).convert("RGB")
    raise ValueError(f"unsupported image source: {src[:60]}")


def _task_blob(task_id: str):
    return _bucket.blob(f"tasks/{task_id}.json")


async def _update_task(task_id: str, **fields) -> dict:
    """Merge `fields` into the task, then persist to GCS as the source of truth
    (see the comment on `_tasks`)."""
    task = _tasks.setdefault(task_id, {"task_id": task_id})
    task.update(fields)
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: _task_blob(task_id).upload_from_string(
            json.dumps(task), content_type="application/json"
        ),
    )
    return task


async def _run_inference(task_id: str, images: list[str], body_type: str) -> None:
    # Wait for the background pipeline load before touching the GPU. Warm
    # instances pass instantly; a cold one waits out the load rather than
    # NoneType-crashing. A failed load surfaces as a designed task error.
    if _load_error:
        await _update_task(task_id, status="failed", error=f"pipeline unavailable: {_load_error}")
        return
    try:
        await asyncio.wait_for(_ready.wait(), timeout=600)
    except asyncio.TimeoutError:
        await _update_task(task_id, status="failed", error="pipeline not ready (model load timed out)")
        return
    if _load_error:
        await _update_task(task_id, status="failed", error=f"pipeline unavailable: {_load_error}")
        return

    async with _sem:
        await _update_task(task_id, status="running")
        loop = asyncio.get_event_loop()
        t0 = time.time()
        try:
            img = await loop.run_in_executor(None, _decode_image, images[0])

            def _generate():
                # GLB export lives in trellis.utils.postprocessing_utils.to_glb —
                # it fuses the Gaussian appearance onto the extracted mesh and bakes
                # a texture. It is NOT a pipeline method (the pipeline only .run()s
                # the structured-latent generation).
                from trellis.utils import postprocessing_utils

                outputs = _pipeline.run(
                    img,
                    seed=42,
                    formats=["gaussian", "mesh"],
                    preprocess_image=True,
                )
                glb = postprocessing_utils.to_glb(
                    outputs["gaussian"][0],
                    outputs["mesh"][0],
                    simplify=0.95,
                    texture_size=1024,
                )
                return glb.export(file_type="glb")

            glb_bytes = await loop.run_in_executor(None, _generate)

            blob_name = f"raw-meshes/trellis/{task_id}.glb"
            blob = _bucket.blob(blob_name)
            await loop.run_in_executor(
                None,
                lambda: blob.upload_from_string(glb_bytes, content_type="model/gltf-binary"),
            )
            gcs_url = f"https://storage.googleapis.com/{GCS_BUCKET}/{blob_name}"

            elapsed = time.time() - t0
            await _update_task(
                task_id,
                status="done",
                result_gcs_url=gcs_url,
                elapsed_ms=int(elapsed * 1000),
            )
            log.info("[%s] done in %.1fs — %d bytes → %s", task_id, elapsed, len(glb_bytes), gcs_url)

        except Exception as exc:
            await _update_task(
                task_id,
                status="failed",
                error=safe_error(exc, context=f"[{task_id}] inference"),
                elapsed_ms=int((time.time() - t0) * 1000),
            )


class InferRequest(BaseModel):
    images: list[str] = Field(..., min_length=1, max_length=6)
    body_type: str = "neutral"
    job_id: str | None = None


@app.post("/infer", status_code=202)
async def infer(
    body: InferRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(...),
) -> dict:
    _require_api_key(authorization)
    task_id = str(uuid.uuid4())
    # Persist the "queued" record before responding — a poll can reach a
    # different instance than this one the moment the 202 lands, and that
    # instance has nothing in its local `_tasks` dict to fall back on.
    await _update_task(task_id, status="queued", model="trellis-large")
    background_tasks.add_task(_run_inference, task_id, body.images, body.body_type)
    return {"task_id": task_id, "status": "queued"}


@app.get("/tasks/{task_id}")
async def get_task(task_id: str, authorization: str = Header(...)) -> dict:
    _require_api_key(authorization)
    task = _tasks.get(task_id)
    if task is not None:
        return task
    # Not in this instance's local cache — fall back to the durable GCS
    # record, which every instance writes to on every state transition.
    loop = asyncio.get_event_loop()
    try:
        data = await loop.run_in_executor(None, _task_blob(task_id).download_as_bytes)
    except NotFound:
        raise HTTPException(status_code=404, detail="task not found")
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=safe_error(exc, context="task lookup")
        ) from exc
    task = json.loads(data)
    _tasks[task_id] = task
    return task


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "model": "trellis-image-large",
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "pipeline_loaded": _pipeline is not None,
        "ready": bool(_ready and _ready.is_set()),
        "load_error": _load_error,
    }
