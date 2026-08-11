"""
TripoSG inference service — high-fidelity image/sketch to 3D shape (VAST-AI, MIT).

1.5B-parameter rectified-flow transformer. Two modes behind one endpoint:

  • image    — single image → mesh (TripoSGPipeline). Quality successor to
               TripoSR: same input contract, markedly better geometry. Used by
               the avatar pipeline controller as a mesh backend.
  • scribble — sketch/drawing + text prompt → mesh (TripoSGScribblePipeline,
               CFG-distilled, 16 steps). Powers the /forge sketch→3D path.

Geometry only — no textures. Pair with workers/texture for texturing.

API contract (consumed by the Pipeline Controller and api/_providers/gcp.js):
  POST /infer   { images: [data-uri|url, ...], mode?: "image"|"scribble",
                  prompt?: str, scribble_confidence?: float,
                  target_polycount?: int, body_type?: str, job_id?: str }
             →  202 { task_id, status: "queued", model, mode }

  GET  /tasks/:id → { task_id, status, result_gcs_url?, error? }

  GET  /health    → { ok, model, gpu_available, ready, load_error }

  GET  /          → service descriptor. Unauthenticated and free: this is the
                    liveness probe the platform sends (api/_lib/forge-health.js
                    and api/cron/gpu-keepwarm.js both GET the worker root and
                    treat any status under 500 as "up").

Task records are durable. Cloud Run runs this service across up to
max-instances containers with no session affinity, so a POST /infer and a later
GET /tasks/:id routinely land on different containers; the in-memory dict alone
answered those polls with 404 ("task not found on gcp service" in
forge_creations, twice in production). The source of truth is the
tasks/{task_id}.json blob in GCS, exactly as in workers/model-trellis.

Model weights pre-population (see workers/deploy/stage-weights.sh):
  VAST-AI/TripoSG           → gs://<weights-bucket>/triposg/
  VAST-AI/TripoSG-scribble  → gs://<weights-bucket>/triposg-scribble/
  briaai/RMBG-1.4           → gs://<weights-bucket>/rmbg-1.4/

Environment variables:
  API_KEY               — shared bearer secret
  GCS_BUCKET            — Cloud Storage bucket for output meshes
  WEIGHTS_DIR           — TripoSG weights (default: /weights/triposg)
  SCRIBBLE_WEIGHTS_DIR  — TripoSG-scribble weights (default: /weights/triposg-scribble)
  RMBG_WEIGHTS_DIR      — RMBG-1.4 weights for image-mode bg removal
                          (default: /weights/rmbg-1.4)
  MAX_CONCURRENT        — max parallel inferences (default: 1)
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from typing import Optional

import numpy as np
import torch
import trimesh
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from google.api_core.exceptions import NotFound
from google.cloud import storage
from PIL import Image
from pydantic import BaseModel, Field

from request_policy import (
    DEFAULT_SCRIBBLE_CONFIDENCE,
    MODES,
    SCRIBBLE_MODE,
    PromptRequired,
    pipeline_settings,
    resolve_mode,
    resolve_prompt,
    should_decimate,
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
log = logging.getLogger("triposg")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
WEIGHTS_DIR = os.environ.get("WEIGHTS_DIR", "/weights/triposg")
SCRIBBLE_WEIGHTS_DIR = os.environ.get("SCRIBBLE_WEIGHTS_DIR", "/weights/triposg-scribble")
RMBG_WEIGHTS_DIR = os.environ.get("RMBG_WEIGHTS_DIR", "/weights/rmbg-1.4")
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "1"))

# Weight staging (same pattern as model-trellis): reading multi-GiB weight trees
# through the GCS FUSE volume stalls for many minutes on a cold instance (rev
# 00006 sat in from_pretrained/.to(cuda) for 10+ min streaming 7.4 GiB), while
# an 8-way parallel storage-client download of the same tree lands in tens of
# seconds. When the *_GCS_URI env is unset or staging fails, loading degrades to
# the FUSE mount path exactly as before.
WEIGHTS_GCS_URI = os.environ.get("WEIGHTS_GCS_URI", "")
SCRIBBLE_WEIGHTS_GCS_URI = os.environ.get("SCRIBBLE_WEIGHTS_GCS_URI", "")
RMBG_WEIGHTS_GCS_URI = os.environ.get("RMBG_WEIGHTS_GCS_URI", "")
WEIGHTS_LOCAL_ROOT = os.environ.get("WEIGHTS_LOCAL_ROOT", "/tmp/triposg-weights")

DTYPE = torch.float16

# Sampler settings, the prompt gate, and mode routing live in request_policy.py
# so every decision that shapes a generation is unit tested without torch, CUDA,
# or the TripoSG source tree (see test_request_policy.py).

_pipe = None
_scribble_pipe = None
_rmbg_net = None
_scribble_lock = threading.Lock()
_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_ready: Optional[asyncio.Event] = None
# Set when the background model load raises. A failed load leaves the container
# listening (so Cloud Run keeps it), which used to mean every task sat out the
# full 600s _ready wait before failing with a misleading "timed out". Recording
# the real reason fails those tasks immediately and surfaces it on /health.
_load_error: Optional[str] = None
# In-memory cache only. Cloud Run runs this service across up to max-instances
# containers with no session affinity, so a POST /infer and a later GET
# /tasks/:id can land on different containers. The durable source of truth is
# the tasks/{task_id}.json blob in GCS (see _update_task / _resolve_task); this
# dict just avoids a GCS round-trip when a poll hits the instance that ran the job.
_tasks: dict[str, dict] = {}


def _stage_tree(gcs_uri: str, name: str, fuse_dir: str) -> str:
    """Download one weight tree from GCS to local disk with the storage client,
    bypassing the FUSE mount. Returns the local dir on success, or the FUSE dir
    to signal "load exactly as before". Never raises: a staging failure must
    degrade to the mount, not crash the loader."""
    if not gcs_uri.startswith("gs://"):
        return fuse_dir
    try:
        from concurrent.futures import ThreadPoolExecutor

        bucket_name, _, prefix = gcs_uri[len("gs://"):].partition("/")
        client = storage.Client()
        blobs = [b for b in client.list_blobs(bucket_name, prefix=prefix) if not b.name.endswith("/")]
        if not blobs:
            log.warning("weights staging: no objects under %s; using FUSE mount", gcs_uri)
            return fuse_dir
        local_dir = os.path.join(WEIGHTS_LOCAL_ROOT, name)

        def _download(blob) -> int:
            rel = blob.name[len(prefix):].lstrip("/")
            dest = os.path.join(local_dir, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            # Reuse an already-staged object (same-instance warm restart) when
            # its size matches, so a reload doesn't re-pull the tree.
            if os.path.exists(dest) and blob.size is not None and os.path.getsize(dest) == blob.size:
                return blob.size or 0
            blob.download_to_filename(dest)
            return blob.size or os.path.getsize(dest)

        os.makedirs(local_dir, exist_ok=True)
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=8) as pool:
            total = sum(pool.map(_download, blobs))
        log.info(
            "%s weights staged to %s in %.1fs (%d objects, %.2f GiB)",
            name, local_dir, time.time() - t0, len(blobs), total / (1024 ** 3),
        )
        return local_dir
    except Exception as exc:  # noqa: BLE001, degrade to the FUSE mount, never crash
        log.warning("%s weights staging failed (%s); falling back to %s", name, exc, fuse_dir)
        return fuse_dir


def _load_models():
    """Load the image pipeline + RMBG at startup. The scribble pipeline is
    loaded lazily on the first scribble task so cold start pays for one model."""
    global _pipe, _rmbg_net
    from triposg.pipelines.pipeline_triposg import TripoSGPipeline
    from briarmbg import BriaRMBG

    weights_path = _stage_tree(WEIGHTS_GCS_URI, "triposg", WEIGHTS_DIR)
    log.info("Loading TripoSG pipeline from %s", weights_path)
    _pipe = TripoSGPipeline.from_pretrained(weights_path).to("cuda", DTYPE)
    rmbg_path = _stage_tree(RMBG_WEIGHTS_GCS_URI, "rmbg-1.4", RMBG_WEIGHTS_DIR)
    log.info("Loading RMBG-1.4 from %s", rmbg_path)
    _rmbg_net = BriaRMBG.from_pretrained(rmbg_path).to("cuda")
    _rmbg_net.eval()
    log.info("TripoSG ready")


def _ensure_scribble_pipe():
    global _scribble_pipe
    if _scribble_pipe is not None:
        return _scribble_pipe
    with _scribble_lock:
        if _scribble_pipe is None:
            from triposg.pipelines.pipeline_triposg_scribble import (
                TripoSGScribblePipeline,
            )

            scribble_path = _stage_tree(
                SCRIBBLE_WEIGHTS_GCS_URI, "triposg-scribble", SCRIBBLE_WEIGHTS_DIR
            )
            log.info("Loading TripoSG-scribble pipeline from %s", scribble_path)
            _scribble_pipe = TripoSGScribblePipeline.from_pretrained(
                scribble_path
            ).to("cuda", DTYPE)
            log.info("TripoSG-scribble ready")
    return _scribble_pipe


async def _load_models_bg() -> None:
    global _load_error
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, _load_models)
        _ready.set()
        log.info("Service ready, max_concurrent=%d", MAX_CONCURRENT)
    except Exception as exc:  # noqa: BLE001, surfaced via /health and per task
        _load_error = safe_error(exc, context="model load")
        log.error("TripoSG model load FAILED: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem, _ready
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    _ready = asyncio.Event()
    # Load the pipelines in the BACKGROUND and yield immediately. uvicorn runs
    # the ASGI lifespan BEFORE it binds the socket, and the full load (TripoSG
    # pipeline + RMBG from the GCS FUSE mount, then the CUDA transfer) runs
    # well past Cloud Run's 240s startup TCP-probe window on a cold instance:
    # revision 00002 died exactly this way (DEADLINE_EXCEEDED mid-load).
    # Backgrounding opens the port at once; tasks that arrive before the load
    # completes wait on _ready in _run_inference. Same pattern as model-trellis.
    asyncio.create_task(_load_models_bg())
    log.info("Service starting, models loading in background (max_concurrent=%d)", MAX_CONCURRENT)
    yield


app = FastAPI(title="model-triposg", lifespan=lifespan)


def _require_api_key(authorization: str) -> None:
    try:
        require_api_key(authorization, API_KEY)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


def _decode_image_bytes(src: str) -> bytes:
    if src.startswith("data:image"):
        return base64.b64decode(src.split(",", 1)[1])
    if src.startswith("https://"):
        # SSRF-hardened: https-only, private/loopback/link-local/metadata IPs
        # rejected after DNS resolution, redirects re-validated per hop, bounded.
        try:
            return fetch_remote_bytes(src, timeout=30)
        except UnsafeUrlError as exc:
            raise ValueError(f"refused to fetch image source: {exc}") from exc
    raise ValueError(f"unsupported image source: {src[:60]}")


def _prepare_photo(src: str) -> Image.Image:
    """Image mode preprocessing — upstream's prepare_image: RMBG background
    removal, bbox crop, recenter, composite over white. Takes a file path, so
    the decoded bytes go through a temp file."""
    from image_process import prepare_image

    data = _decode_image_bytes(src)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        Image.open(io.BytesIO(data)).convert("RGBA").save(tmp, format="PNG")
        tmp_path = tmp.name
    try:
        return prepare_image(tmp_path, bg_color=np.array([1.0, 1.0, 1.0]), rmbg_net=_rmbg_net)
    finally:
        os.unlink(tmp_path)


def _prepare_sketch(src: str) -> Image.Image:
    """Scribble mode preprocessing — the model is conditioned on dark strokes
    over white, so flatten any alpha onto a white background. No bg removal:
    a sketch has no photographic background to strip."""
    data = _decode_image_bytes(src)
    img = Image.open(io.BytesIO(data)).convert("RGBA")
    flat = Image.new("RGBA", img.size, (255, 255, 255, 255))
    flat.alpha_composite(img)
    return flat.convert("RGB")


def _simplify(mesh: trimesh.Trimesh, target_faces: int | None) -> trimesh.Trimesh:
    """Quadric edge-collapse decimation to the tier's poly budget — mirrors
    upstream's simplify_mesh. No-op when already under budget."""
    if not should_decimate(mesh.faces.shape[0], target_faces):
        return mesh
    import pymeshlab

    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=mesh.vertices, face_matrix=mesh.faces))
    ms.meshing_decimation_quadric_edge_collapse(targetfacenum=int(target_faces))
    m = ms.current_mesh()
    return trimesh.Trimesh(m.vertex_matrix(), m.face_matrix())


def _task_blob(task_id: str):
    return _bucket.blob(f"tasks/{task_id}.json")


async def _update_task(task_id: str, **fields) -> dict:
    """Merge `fields` into the task, then persist it to GCS as the source of
    truth (see the comment on `_tasks`)."""
    task = _tasks.setdefault(task_id, {"task_id": task_id})
    task.update(fields)
    task["updated_at"] = time.time()
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: _task_blob(task_id).upload_from_string(
            json.dumps(task), content_type="application/json"
        ),
    )
    return task


# A queued/running record with no state transition for this long is orphaned:
# its runner instance died (Cloud Run reclaimed it, or the deploy rolled) and
# nothing resumes persisted tasks. The ceiling covers the 600s model-load wait
# plus the longest real generation with margin; expiring it turns an endless
# client poll into a designed failure the router's poll-time failover can act on.
_PENDING_TTL_SECS = 1800
_TERMINAL_STATUSES = frozenset({"done", "failed"})


async def _resolve_task(task_id: str) -> dict:
    """Shared poll reader. The instance-local cache is only trusted for terminal
    records: caching a queued/running record would freeze that status on this
    instance while the runner instance advances the durable GCS record (polls
    have no session affinity)."""
    task = _tasks.get(task_id)
    if task is not None and task.get("status") in _TERMINAL_STATUSES:
        return task
    loop = asyncio.get_event_loop()
    try:
        data = await loop.run_in_executor(None, _task_blob(task_id).download_as_bytes)
    except NotFound:
        if task is not None:
            # Local-only record (the initial persist raced or failed): serve the
            # in-memory view rather than 404ing a task we know exists.
            return task
        raise HTTPException(status_code=404, detail="task not found")
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=safe_error(exc, context="task lookup")
        ) from exc
    task = json.loads(data)
    status = task.get("status")
    if status in _TERMINAL_STATUSES:
        _tasks[task_id] = task
        return task
    updated_at = task.get("updated_at")
    stale = (
        not isinstance(updated_at, (int, float))
        or time.time() - updated_at > _PENDING_TTL_SECS
    )
    if status in ("queued", "running") and stale:
        return await _update_task(
            task_id,
            status="failed",
            error="task orphaned: no progress within 30 minutes "
            "(runner instance likely restarted mid-job); retry the request",
        )
    return task


async def _run_inference(
    task_id: str,
    images: list[str],
    mode: str,
    prompt: str,
    scribble_confidence: float,
    target_polycount: int | None,
) -> None:
    # Wait for the background model load before touching the GPU. A warm
    # instance passes instantly; a failed load is a designed task error rather
    # than a ten-minute wait for a timeout that was decided long ago.
    if _load_error:
        await _update_task(task_id, status="failed", error=f"pipeline unavailable: {_load_error}")
        return
    try:
        await asyncio.wait_for(_ready.wait(), timeout=600)
    except asyncio.TimeoutError:
        await _update_task(
            task_id,
            status="failed",
            error=f"pipeline unavailable: {_load_error}" if _load_error
            else "pipeline not ready (model load timed out)",
        )
        return
    async with _sem:
        await _update_task(task_id, status="running")
        loop = asyncio.get_event_loop()
        t0 = time.time()
        try:
            def _generate() -> bytes:
                seed_gen = torch.Generator(device="cuda").manual_seed(0)
                settings = pipeline_settings(
                    mode, prompt=prompt, scribble_confidence=scribble_confidence
                )
                if mode == SCRIBBLE_MODE:
                    pipe = _ensure_scribble_pipe()
                    img = _prepare_sketch(images[0])
                    with torch.no_grad():
                        outputs = pipe(image=img, generator=seed_gen, **settings).samples[0]
                else:
                    img = _prepare_photo(images[0])
                    with torch.no_grad():
                        outputs = _pipe(image=img, generator=seed_gen, **settings).samples[0]

                mesh = trimesh.Trimesh(
                    outputs[0].astype(np.float32),
                    np.ascontiguousarray(outputs[1]),
                )
                mesh = _simplify(mesh, target_polycount)
                buf = io.BytesIO()
                mesh.export(buf, file_type="glb")
                return buf.getvalue()

            glb_bytes = await loop.run_in_executor(None, _generate)

            blob_name = f"raw-meshes/triposg/{task_id}.glb"
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
            log.info(
                "[%s] %s done in %.1fs, %d bytes, %s",
                task_id, mode, elapsed, len(glb_bytes), gcs_url,
            )

        except Exception as exc:
            await _update_task(
                task_id,
                status="failed",
                error=safe_error(exc, context=f"[{task_id}] inference"),
                elapsed_ms=int((time.time() - t0) * 1000),
            )


class InferRequest(BaseModel):
    images: list[str] = Field(..., min_length=1, max_length=6)
    mode: str = "image"
    prompt: str = ""
    scribble_confidence: float = Field(default=DEFAULT_SCRIBBLE_CONFIDENCE, ge=0.0, le=1.0)
    target_polycount: int | None = Field(default=None, ge=100, le=1_000_000)
    body_type: str = "neutral"
    job_id: str | None = None


@app.post("/infer", status_code=202)
async def infer(
    body: InferRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(...),
) -> dict:
    _require_api_key(authorization)
    mode = resolve_mode(body.mode)
    try:
        prompt = resolve_prompt(mode, body.prompt)
    except PromptRequired as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    task_id = str(uuid.uuid4())
    # Persist the queued record BEFORE returning, so a poll that lands on a
    # different instance (no session affinity, max-instances > 1) resolves it
    # from GCS instead of 404ing a task that is running fine elsewhere.
    task = await _update_task(task_id, status="queued", model="triposg", mode=mode)
    background_tasks.add_task(
        _run_inference,
        task_id,
        body.images,
        mode,
        prompt,
        body.scribble_confidence,
        body.target_polycount,
    )
    return task


@app.get("/tasks/{task_id}")
async def get_task(task_id: str, authorization: str = Header(...)) -> dict:
    _require_api_key(authorization)
    return await _resolve_task(task_id)


@app.get("/health")
async def health() -> dict:
    return {
        # False once the model load has failed: the container still listens, so
        # without this a permanently broken instance reports perfect health.
        "ok": _load_error is None,
        "model": "triposg",
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "model_loaded": _pipe is not None,
        "scribble_loaded": _scribble_pipe is not None,
        "ready": bool(_ready and _ready.is_set()),
        "load_error": _load_error,
    }


@app.get("/")
async def root() -> dict:
    """Service descriptor for the platform's liveness probes, which GET the
    worker root (api/_lib/forge-health.js, api/_lib/forge-lane-health.js,
    api/cron/gpu-keepwarm.js) and read any status under 500 as "up". It used to
    404 here, which is indistinguishable in a log from a misrouted request."""
    return {
        "service": "model-triposg",
        "model": "triposg",
        "modes": list(MODES),
        "ready": bool(_ready and _ready.is_set()),
        "endpoints": ["POST /infer", "GET /tasks/{task_id}", "GET /health"],
    }
