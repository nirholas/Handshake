"""
TripoSR inference service — fast single-image to 3D mesh (VAST-AI, MIT).

Lightest of the three candidate models. Runs in 5-15 seconds. No PBR textures
(baked single texture), but useful as a fast-path or fallback.

API contract (consumed by the Pipeline Controller):
  POST /infer   { images: [data-uri|url, ...], body_type?: str, job_id?: str }
             →  202 { task_id, status: "queued" }

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
import base64
import io
import logging
import os
import time
import traceback
import uuid
from contextlib import asynccontextmanager
from typing import Optional

import torch
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from google.cloud import storage
from PIL import Image
from pydantic import BaseModel, Field

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
_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_tasks: dict[str, dict] = {}


def _load_model():
    global _model
    from tsr import TSR

    log.info("Loading TripoSR model from %s", WEIGHTS_DIR)
    _model = TSR.from_pretrained(
        WEIGHTS_DIR,
        config_name="config.yaml",
        weight_name="model.ckpt",
    )
    _model.to("cuda")
    log.info("TripoSR model loaded")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _load_model)
    log.info("Service ready — max_concurrent=%d", MAX_CONCURRENT)
    yield


app = FastAPI(title="model-triposr", lifespan=lifespan)


def _require_api_key(authorization: str) -> None:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    if authorization[len("Bearer "):].strip() != API_KEY:
        raise HTTPException(status_code=401, detail="invalid api key")


def _decode_image(src: str) -> Image.Image:
    if src.startswith("data:image"):
        b64 = src.split(",", 1)[1]
        return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
    if src.startswith("http://") or src.startswith("https://"):
        import httpx
        resp = httpx.get(src, timeout=30)
        resp.raise_for_status()
        return Image.open(io.BytesIO(resp.content)).convert("RGB")
    raise ValueError(f"unsupported image source: {src[:60]}")


def _remove_background(img: Image.Image) -> Image.Image:
    try:
        import rembg
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        out = rembg.remove(buf.getvalue())
        return Image.open(io.BytesIO(out)).convert("RGBA")
    except Exception:
        return img.convert("RGBA")


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
                meshes = _model.extract_mesh(scene_codes, resolution=256)
                mesh = meshes[0]
                buf = io.BytesIO()
                mesh.export(buf, file_type="glb")
                return buf.getvalue()

            glb_bytes = await loop.run_in_executor(None, _generate)

            blob_name = f"raw-meshes/triposr/{task_id}.glb"
            blob = _bucket.blob(blob_name)
            await loop.run_in_executor(
                None,
                lambda: blob.upload_from_string(glb_bytes, content_type="model/gltf-binary"),
            )
            gcs_url = f"https://storage.googleapis.com/{GCS_BUCKET}/{blob_name}"

            elapsed = time.time() - t0
            _tasks[task_id].update({
                "status": "done",
                "result_gcs_url": gcs_url,
                "elapsed_ms": int(elapsed * 1000),
            })
            log.info("[%s] done in %.1fs — %d bytes → %s", task_id, elapsed, len(glb_bytes), gcs_url)

        except Exception:
            _tasks[task_id].update({
                "status": "failed",
                "error": traceback.format_exc(),
                "elapsed_ms": int((time.time() - t0) * 1000),
            })
            log.exception("[%s] inference failed", task_id)


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
        "model": "triposr",
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "model_loaded": _model is not None,
    }
