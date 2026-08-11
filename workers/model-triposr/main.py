"""
TripoSR inference service — fast single-image to 3D mesh (VAST-AI, MIT).

Lightest of the three candidate models. Runs in 5-15 seconds. No PBR textures
(baked single texture), but useful as a fast-path or fallback.

API contract (consumed by the Pipeline Controller):
  POST /infer   { images: [data-uri|url, ...], body_type?: str, job_id?: str }
             →  202 { task_id, status: "queued", model: "triposr" }

  GET  /tasks/:id → { task_id, status, result_gcs_url?, error? }

  GET  /health    → { ok, model, gpu_available }

Model weights pre-population:
  pip install huggingface_hub
  huggingface-cli download stabilityai/TripoSR --local-dir /tmp/triposr
  gsutil -m cp -r /tmp/triposr gs://three-ws-model-weights/triposr/

Environment variables:
  API_KEY           — shared bearer secret
  GCS_BUCKET        — Cloud Storage bucket for output meshes
  WEIGHTS_DIR       — local path to model weights (default: /weights/triposr)
  MAX_CONCURRENT    — max parallel inferences (default: 2, lighter model)
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Optional

import torch
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from google.cloud import storage
from PIL import Image
from pydantic import BaseModel, Field

from image_prep import (
    decode_image,
    flatten_to_rgb,
    mesh_blob_name,
    mesh_public_url,
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
log = logging.getLogger("triposr")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
WEIGHTS_DIR = os.environ.get("WEIGHTS_DIR", "/weights/triposr")
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "2"))

_model = None
_matting_session = None
_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_tasks: dict[str, dict] = {}


def _load_model():
    global _model
    # TripoSR's top-level `tsr/__init__.py` is empty — the class lives in
    # `tsr.system` (as upstream run.py imports it). `from tsr import TSR` raises
    # ImportError: cannot import name 'TSR' from 'tsr'.
    from tsr.system import TSR

    log.info("Loading TripoSR model from %s", WEIGHTS_DIR)
    _model = TSR.from_pretrained(
        WEIGHTS_DIR,
        config_name="config.yaml",
        weight_name="model.ckpt",
    )
    _model.to("cuda")
    log.info("TripoSR model loaded")


def _load_matting_session():
    """Build the rembg session once, at startup, from the baked-in weights.

    rembg.remove() with no session builds one per call, and an unprimed session
    downloads its 176 MB u2net model on first use: measured at 19 s of the
    first job on a fresh instance, and a hard dependency on a third-party
    download inside a user request. The Dockerfile pre-fetches the model into
    U2NET_HOME, so this only opens it.
    """
    global _matting_session
    try:
        from rembg import new_session

        _matting_session = new_session("u2net")
        log.info("Matting session ready (u2net)")
    except Exception as exc:
        log.warning("Matting session unavailable, frames will be used raw: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _load_model)
    await loop.run_in_executor(None, _load_matting_session)
    log.info("Service ready — max_concurrent=%d", MAX_CONCURRENT)
    yield


app = FastAPI(title="model-triposr", lifespan=lifespan)


def _require_api_key(authorization: str) -> None:
    try:
        require_api_key(authorization, API_KEY)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


def _fetch_image_bytes(url: str) -> bytes:
    # SSRF-hardened: https-only, private/loopback/link-local/metadata IPs
    # rejected after DNS resolution, redirects re-validated per hop, bounded.
    try:
        return fetch_remote_bytes(url, timeout=30)
    except UnsafeUrlError as exc:
        raise ValueError(f"refused to fetch image source: {exc}") from exc


def _decode_image(src: str) -> Image.Image:
    return decode_image(src, fetch=_fetch_image_bytes)


def _remove_background(img: Image.Image) -> Image.Image:
    try:
        import rembg
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        out = rembg.remove(buf.getvalue(), session=_matting_session)
        rgba = Image.open(io.BytesIO(out)).convert("RGBA")
    except Exception as exc:
        # Matting is an enhancement, not a hard requirement: TripoSR still
        # reconstructs from the raw frame, just with the background baked in.
        # Log it so a silently degraded lane is visible in the logs.
        log.warning("background removal failed, using the raw frame: %s", exc)
        rgba = img
    return flatten_to_rgb(rgba)


async def _run_inference(task_id: str, images: list[str], body_type: str) -> None:
    async with _sem:
        _tasks[task_id]["status"] = "running"
        loop = asyncio.get_event_loop()
        t0 = time.time()
        try:
            img = await loop.run_in_executor(None, _decode_image, images[0])
            img_nobg = await loop.run_in_executor(None, _remove_background, img)

            def _generate():
                with torch.no_grad():
                    scene_codes = _model([img_nobg], device="cuda")
                # has_vertex_color is a required positional in current TripoSR;
                # True also bakes vertex colors so the GLB isn't an untextured
                # flat-grey mesh (TripoSR emits no PBR materials).
                meshes = _model.extract_mesh(scene_codes, True, resolution=256)
                mesh = meshes[0]
                buf = io.BytesIO()
                mesh.export(buf, file_type="glb")
                return buf.getvalue()

            glb_bytes = await loop.run_in_executor(None, _generate)

            blob_name = mesh_blob_name(task_id)
            blob = _bucket.blob(blob_name)
            await loop.run_in_executor(
                None,
                lambda: blob.upload_from_string(glb_bytes, content_type="model/gltf-binary"),
            )
            gcs_url = mesh_public_url(GCS_BUCKET, blob_name)

            elapsed = time.time() - t0
            _tasks[task_id].update({
                "status": "done",
                "result_gcs_url": gcs_url,
                "elapsed_ms": int(elapsed * 1000),
            })
            log.info("[%s] done in %.1fs — %d bytes → %s", task_id, elapsed, len(glb_bytes), gcs_url)

        except Exception as exc:
            _tasks[task_id].update({
                "status": "failed",
                "error": safe_error(exc, context=f"[{task_id}] inference"),
                "elapsed_ms": int((time.time() - t0) * 1000),
            })


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
    _tasks[task_id] = {"task_id": task_id, "status": "queued", "model": "triposr"}
    background_tasks.add_task(_run_inference, task_id, body.images, body.body_type)
    return {"task_id": task_id, "status": "queued", "model": "triposr"}


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
        "model": "triposr",
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "model_loaded": _model is not None,
    }
