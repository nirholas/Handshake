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
log = logging.getLogger("trellis")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
WEIGHTS_DIR = os.environ.get("WEIGHTS_DIR", "/weights/trellis-large")
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "1"))

_pipeline = None
_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_tasks: dict[str, dict] = {}


def _load_pipeline():
    global _pipeline
    from trellis.pipelines import TrellisImageTo3DPipeline

    log.info("Loading TRELLIS pipeline from %s", WEIGHTS_DIR)
    _pipeline = TrellisImageTo3DPipeline.from_pretrained(WEIGHTS_DIR)
    _pipeline = _pipeline.to("cuda")
    log.info("TRELLIS pipeline loaded")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _load_pipeline)
    log.info("Service ready — max_concurrent=%d", MAX_CONCURRENT)
    yield


app = FastAPI(title="model-trellis", lifespan=lifespan)


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


async def _run_inference(task_id: str, images: list[str], body_type: str) -> None:
    async with _sem:
        _tasks[task_id]["status"] = "running"
        loop = asyncio.get_event_loop()
        t0 = time.time()
        try:
            img = await loop.run_in_executor(None, _decode_image, images[0])

            def _generate():
                outputs = _pipeline.run(
                    img,
                    seed=42,
                    formats=["gaussian", "mesh"],
                    preprocess_image=True,
                )
                glb = _pipeline.to_glb(
                    outputs["gaussian"][0],
                    outputs["mesh"][0],
                    simplify=0.95,
                    texture_size=1024,
                )
                buf = io.BytesIO()
                glb.export(buf, file_type="glb")
                return buf.getvalue()

            glb_bytes = await loop.run_in_executor(None, _generate)

            blob_name = f"raw-meshes/trellis/{task_id}.glb"
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
    _tasks[task_id] = {"task_id": task_id, "status": "queued", "model": "trellis-large"}
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
        "model": "trellis-image-large",
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "pipeline_loaded": _pipeline is not None,
    }
