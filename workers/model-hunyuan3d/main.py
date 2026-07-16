"""
Hunyuan3D-2 inference service — single-image to textured 3D mesh
(shape DiT → cleanup → multiview paint, via Tencent's hy3dgen).

API contract (consumed by the Pipeline Controller):
  POST /infer   { images: [data-uri|url, ...], body_type?: str, job_id?: str }
             →  202 { task_id, status: "queued" }

  GET  /tasks/:id → { task_id, status, result_gcs_url?, error? }

  GET  /health    → { ok, model, gpu_available }

The model weights are loaded from a GCS volume mount at /weights to avoid
re-downloading tens of GB on every cold start. Pre-populate the bucket
(hy3dgen loads hunyuan3d-dit-v2-0, hunyuan3d-delight-v2-0 and
hunyuan3d-paint-v2-0 from this tree):

  # One-time setup (run locally or in Cloud Shell):
  pip install huggingface_hub
  hf download tencent/Hunyuan3D-2 --local-dir /tmp/hunyuan3d-2
  gcloud storage rsync --recursive /tmp/hunyuan3d-2 gs://three-ws-model-weights/hunyuan3d-2

Environment variables:
  API_KEY           — shared bearer secret
  GCS_BUCKET        — Cloud Storage bucket for output meshes
  WEIGHTS_DIR       — local path to model weights (default: /weights/hunyuan3d-2)
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
log = logging.getLogger("hunyuan3d")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
WEIGHTS_DIR = os.environ.get("WEIGHTS_DIR", "/weights/hunyuan3d-2")
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "1"))

_pipeline = None
_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_ready: Optional[asyncio.Event] = None
_load_error: Optional[str] = None
# In-memory cache only — Cloud Run runs this service across multiple instances
# with no session affinity, so a POST /infer and a later GET /tasks/:id can
# land on different instances. The durable source of truth is the
# `tasks/{task_id}.json` blob in GCS (see _update_task / get_task); this dict
# just avoids a GCS round-trip when a poll happens to hit the same warm
# instance that ran the job. (Same pattern as workers/model-trellis.)
_tasks: dict[str, dict] = {}


def _task_blob(task_id: str):
    return _bucket.blob(f"tasks/{task_id}.json")


async def _update_task(task_id: str, **fields) -> dict:
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


def _load_pipeline():
    global _pipeline
    # hy3dgen (Tencent/Hunyuan3D-2, pinned in the Dockerfile) — the 2.0 package
    # whose class registry matches the hunyuan3d-*-v2-0 checkpoints staged in
    # the weights bucket. The 2.1 checkpoints target hy3dshape.* classes from a
    # different repo and do NOT load through hy3dgen.
    from hy3dgen.rembg import BackgroundRemover
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
    from hy3dgen.texgen import Hunyuan3DPaintPipeline

    log.info("Loading shape generation pipeline from %s", WEIGHTS_DIR)
    # from_pretrained takes hy3dgen kwargs (dtype/device), not diffusers'
    # torch_dtype, and loads straight onto the device — no .to() afterwards.
    shape_pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
        WEIGHTS_DIR,
        subfolder="hunyuan3d-dit-v2-0",
        device="cuda",
        dtype=torch.float16,
        use_safetensors=True,
        variant="fp16",
    )

    log.info("Loading texture generation pipeline from %s", WEIGHTS_DIR)
    # Full-quality paint (not -turbo): the platform's realism bar over speed.
    # Loads the delight model from WEIGHTS_DIR/hunyuan3d-delight-v2-0 itself.
    tex_pipe = Hunyuan3DPaintPipeline.from_pretrained(
        WEIGHTS_DIR,
        subfolder="hunyuan3d-paint-v2-0",
    )

    _pipeline = {
        "shape": shape_pipe,
        "texture": tex_pipe,
        "rembg": BackgroundRemover(),
    }
    log.info("Hunyuan3D-2 pipelines loaded")


async def _load_pipeline_bg():
    """Load the ~10 GB pipeline off the request path and signal readiness when
    done. Runs in a worker thread so the event loop (and the HTTP port) stay
    live — a blocking lifespan load here would delay the port past Cloud Run's
    startup TCP-probe window and the revision would be marked failed."""
    global _load_error
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, _load_pipeline)
        _ready.set()
        log.info("Hunyuan3D-2 pipeline ready")
    except Exception as exc:  # noqa: BLE001 — surfaced via /health + task status
        _load_error = safe_error(exc, context="model load")
        log.error("Hunyuan3D-2 pipeline load FAILED: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem, _ready
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    _ready = asyncio.Event()
    asyncio.create_task(_load_pipeline_bg())
    log.info("Service starting — pipeline loading in background (max_concurrent=%d)", MAX_CONCURRENT)
    yield


app = FastAPI(title="model-hunyuan3d", lifespan=lifespan)


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


async def _run_inference(task_id: str, images: list[str], body_type: str) -> None:
    # Wait for the background pipeline load before touching the GPU. Warm
    # instances pass instantly; a cold one waits out the load rather than
    # NoneType-crashing. A failed load surfaces as a designed task error.
    if _load_error:
        await _update_task(task_id, status="failed", error=f"pipeline unavailable: {_load_error}")
        return
    try:
        await asyncio.wait_for(_ready.wait(), timeout=900)
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
                from hy3dgen.shapegen.postprocessors import (
                    DegenerateFaceRemover,
                    FaceReducer,
                    FloaterRemover,
                )

                # The shape DiT is conditioned on the isolated subject; a busy
                # background bleeds into geometry. Match the upstream demo: cut
                # the background first unless the caller already sent RGBA.
                subject = img if img.mode == "RGBA" else _pipeline["rembg"](img)

                # Quality over speed (GPU time is cheap against the platform's
                # GCP credit budget): 50 steps at 384 octree resolution — above
                # the quickstart defaults (30 steps, 256) — for sharper geometry
                # on realistic human/object subjects. The pipeline returns a
                # list of trimesh objects; single image → take the first.
                mesh = _pipeline["shape"](
                    image=subject,
                    num_inference_steps=50,
                    guidance_scale=5.5,
                    octree_resolution=384,
                )[0]

                # Upstream's standard cleanup chain before painting: drop
                # floating debris and degenerate faces, then decimate to a
                # budget the multiview paint pipeline handles well. 40k faces
                # keeps far more surface detail than the demo's default and
                # still textures in one pass on the L4.
                mesh = FloaterRemover()(mesh)
                mesh = DegenerateFaceRemover()(mesh)
                mesh = FaceReducer()(mesh, max_facenum=40_000)

                # Paint takes (mesh, image) positionally and manages its own
                # diffusion schedule — it accepts no step/guidance kwargs.
                textured = _pipeline["texture"](mesh, subject)
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
    await _update_task(task_id, status="queued", model="hunyuan3d-2")
    background_tasks.add_task(_run_inference, task_id, body.images, body.body_type)
    return {"task_id": task_id, "status": "queued"}


# api/_providers/gcp.js drives this lane in `reconstruct` mode
# (GCP_HUNYUAN3D_URL + mode:'reconstruct'), which speaks the avatar
# controller's wire shape: POST /reconstruct → { job_id }, GET /jobs/:id.
# These aliases accept that shape verbatim so the worker URL can be wired
# directly into the API env; the poll reader is field-tolerant
# (task_id|job_id, glb_url|result_gcs_url) so the same records serve both.
@app.post("/reconstruct", status_code=202)
async def reconstruct(
    body: InferRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(...),
) -> dict:
    result = await infer(body, background_tasks, authorization)
    return {**result, "job_id": result["task_id"]}


@app.get("/jobs/{task_id}")
async def get_job(task_id: str, authorization: str = Header(...)) -> dict:
    task = await get_task(task_id, authorization)
    glb = task.get("result_gcs_url")
    return {**task, "job_id": task.get("task_id"), **({"glb_url": glb} if glb else {})}


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
        "model": "hunyuan3d-2",
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "pipeline_loaded": _pipeline is not None,
        "ready": bool(_ready and _ready.is_set()),
        "load_error": _load_error,
    }
