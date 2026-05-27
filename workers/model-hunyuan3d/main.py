"""
Hunyuan3D-2.1 inference service — single-image to textured 3D mesh.

API contract (consumed by the Pipeline Controller):
  POST /infer   { images: [data-uri|url, ...], body_type?: str, job_id?: str }
             →  202 { task_id, status: "queued" }

  GET  /tasks/:id → { task_id, status, result_gcs_url?, error? }

  GET  /health    → { ok, model, gpu_available }

The model weights are loaded from a GCS volume mount at /weights to avoid
re-downloading ~10 GB on every cold start. Pre-populate the bucket:

  # One-time setup (run locally or in Cloud Shell):
  pip install huggingface_hub
  huggingface-cli download tencent/Hunyuan3D-2.1 --local-dir /tmp/hunyuan3d-2.1
  gsutil -m cp -r /tmp/hunyuan3d-2.1 gs://three-ws-model-weights/hunyuan3d-2.1/

Environment variables:
  API_KEY           — shared bearer secret
  GCS_BUCKET        — Cloud Storage bucket for output meshes
  WEIGHTS_DIR       — local path to model weights (default: /weights/hunyuan3d-2.1)
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
log = logging.getLogger("hunyuan3d")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
WEIGHTS_DIR = os.environ.get("WEIGHTS_DIR", "/weights/hunyuan3d-2.1")
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "1"))

_pipeline = None
_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_tasks: dict[str, dict] = {}


def _load_pipeline():
    global _pipeline
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
    from hy3dgen.texgen import Hunyuan3DPaintPipeline

    log.info("Loading shape generation pipeline from %s", WEIGHTS_DIR)
    shape_pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
        WEIGHTS_DIR,
        subfolder="hunyuan3d-dit-v2-1",
        torch_dtype=torch.float16,
        use_safetensors=True,
    )
    shape_pipe = shape_pipe.to("cuda")

    log.info("Loading texture generation pipeline from %s", WEIGHTS_DIR)
    tex_pipe = Hunyuan3DPaintPipeline.from_pretrained(
        WEIGHTS_DIR,
        subfolder="hunyuan3d-paint-v2-1",
        torch_dtype=torch.float16,
        use_safetensors=True,
    )
    tex_pipe = tex_pipe.to("cuda")

    _pipeline = {"shape": shape_pipe, "texture": tex_pipe}
    log.info("Hunyuan3D-2.1 pipelines loaded")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _load_pipeline)
    log.info("Service ready — max_concurrent=%d", MAX_CONCURRENT)
    yield


app = FastAPI(title="model-hunyuan3d", lifespan=lifespan)


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
                mesh = _pipeline["shape"](
                    image=img,
                    num_inference_steps=30,
                    guidance_scale=5.5,
                    octree_resolution=256,
                )
                textured = _pipeline["texture"](
                    mesh=mesh,
                    image=img,
                    num_inference_steps=20,
                    guidance_scale=7.5,
                )
                buf = io.BytesIO()
                textured.export(buf, file_type="glb")
                return buf.getvalue()

            glb_bytes = await loop.run_in_executor(None, _generate)

            blob_name = f"raw-meshes/hunyuan3d/{task_id}.glb"
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
    _tasks[task_id] = {"task_id": task_id, "status": "queued", "model": "hunyuan3d-2.1"}
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
        "model": "hunyuan3d-2.1",
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "pipeline_loaded": _pipeline is not None,
    }
