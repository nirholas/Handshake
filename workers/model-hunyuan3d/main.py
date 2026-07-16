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
# Stage the needed weight subtrees from GCS to local disk at startup and load
# from there instead of the Cloud Storage FUSE mount. FUSE stalls indefinitely
# on the 4.6 GB DiT safetensors read (observed live 2026-07-16: two instances
# sat 20+ minutes on "Loading model from …model.fp16.safetensors"), exactly the
# failure model-trellis hit at 3 GB. The storage client streams each object
# with a plain sequential GET, which does not stall. Only the four subfolders
# the 2.0 pipelines read are staged, and the DiT/VAE fp32 + .ckpt duplicates
# are skipped (~18 GiB staged instead of the tree's ~70 GiB) so the tmpfs
# footprint fits the instance's 32 GiB memory. Unset WEIGHTS_GCS_URI, or any
# staging failure, falls back to the FUSE mount unchanged.
WEIGHTS_GCS_URI = os.environ.get("WEIGHTS_GCS_URI", "")  # e.g. gs://bucket/hunyuan3d-2
WEIGHTS_LOCAL_DIR = os.environ.get("WEIGHTS_LOCAL_DIR", "/tmp/hunyuan3d-2")
# Subtrees the shape + paint pipelines actually read.
_STAGE_PREFIXES = (
    "hunyuan3d-dit-v2-0/",
    "hunyuan3d-vae-v2-0/",
    "hunyuan3d-paint-v2-0/",
    "hunyuan3d-delight-v2-0/",
)
# Duplicate checkpoint spellings the fp16-safetensors load never opens. Only
# safe to drop in directories that actually ship model.fp16.safetensors: the
# delight tree's text_encoder ships model.safetensors ALONE, and skipping it
# unconditionally left the staged copy without any checkpoint (load_error
# "no file named pytorch_model.bin, model.safetensors, ..." on rev 00008).
_STAGE_SKIP_BASENAMES = frozenset({"model.ckpt", "model.safetensors", "model_fp16.ckpt", "model.fp16.ckpt"})
_STAGE_FP16_BASENAME = "model.fp16.safetensors"


def _stage_weights_local() -> Optional[str]:
    """Download the needed weight subtrees from GCS to local disk with the
    storage client, bypassing the FUSE mount. Returns the local dir on success,
    or None to signal "load from WEIGHTS_DIR as before". Never raises — a
    staging failure must degrade to the existing FUSE-mount load, not crash
    the loader. (Same pattern as workers/model-trellis.)"""
    if not WEIGHTS_GCS_URI.startswith("gs://"):
        return None
    try:
        from concurrent.futures import ThreadPoolExecutor

        bucket_name, _, prefix = WEIGHTS_GCS_URI[len("gs://"):].partition("/")
        prefix = prefix.rstrip("/") + "/"
        client = storage.Client()
        candidates = []
        fp16_dirs = set()
        for blob in client.list_blobs(bucket_name, prefix=prefix):
            rel = blob.name[len(prefix):]
            if not rel or rel.endswith("/"):
                continue
            if not rel.startswith(_STAGE_PREFIXES):
                continue
            parent, _, base = rel.rpartition("/")
            if base == _STAGE_FP16_BASENAME:
                fp16_dirs.add(parent)
            candidates.append((rel, blob))
        # Drop a duplicate spelling only where the fp16 checkpoint it
        # duplicates is present in the same directory; a directory whose only
        # checkpoint matches a "duplicate" name keeps it.
        blobs = [
            blob
            for rel, blob in candidates
            if not (rel.rsplit("/", 1)[-1] in _STAGE_SKIP_BASENAMES and rel.rpartition("/")[0] in fp16_dirs)
        ]
        if not blobs:
            log.warning("weights staging: no objects under %s; using FUSE mount", WEIGHTS_GCS_URI)
            return None

        def _download(blob) -> int:
            rel = blob.name[len(prefix):]
            dest = os.path.join(WEIGHTS_LOCAL_DIR, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            # Reuse an already-staged object (same-instance warm restart) when
            # its size matches, so a reload doesn't re-pull 18 GiB.
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
# its runner instance died (or lost the background task) and nothing resumes
# persisted tasks. The ceiling covers the 900s pipeline-ready wait plus the
# longest real shape+paint run with margin; expiring it turns an endless
# client poll into a designed failure the router's poll-time failover can act
# on. (Same pattern as workers/model-trellis.)
_PENDING_TTL_SECS = 1800
_TERMINAL_STATUSES = frozenset({"done", "failed"})


async def _resolve_task(task_id: str) -> dict:
    """Shared poll reader. The instance-local cache is only trusted for
    terminal records — caching a queued/running record would freeze that
    status on this instance forever while the runner instance advances the
    durable GCS record (polls have no session affinity). Non-terminal records
    are always re-read from GCS and expired once orphaned."""
    task = _tasks.get(task_id)
    if task is not None and task.get("status") in _TERMINAL_STATUSES:
        return task
    loop = asyncio.get_event_loop()
    try:
        data = await loop.run_in_executor(None, _task_blob(task_id).download_as_bytes)
    except NotFound:
        if task is not None:
            # Local-only record (the initial persist raced or failed) — serve
            # the in-memory view rather than 404ing a task we know exists.
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
    # Records written before updated_at existed can't prove liveness; after a
    # deploy their runner instances are gone, so treat them as orphaned too.
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


def _load_pipeline():
    global _pipeline
    # hy3dgen (Tencent/Hunyuan3D-2, pinned in the Dockerfile) — the 2.0 package
    # whose class registry matches the hunyuan3d-*-v2-0 checkpoints staged in
    # the weights bucket. The 2.1 checkpoints target hy3dshape.* classes from a
    # different repo and do NOT load through hy3dgen.
    from hy3dgen.rembg import BackgroundRemover
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
    from hy3dgen.texgen import Hunyuan3DPaintPipeline

    weights_path = _stage_weights_local() or WEIGHTS_DIR
    log.info("Loading shape generation pipeline from %s", weights_path)
    # from_pretrained takes hy3dgen kwargs (dtype/device), not diffusers'
    # torch_dtype, and loads straight onto the device — no .to() afterwards.
    shape_pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
        weights_path,
        subfolder="hunyuan3d-dit-v2-0",
        device="cuda",
        dtype=torch.float16,
        use_safetensors=True,
        variant="fp16",
    )

    log.info("Loading texture generation pipeline from %s", weights_path)
    # Full-quality paint (not -turbo): the platform's realism bar over speed.
    # Loads the delight model from <weights_path>/hunyuan3d-delight-v2-0 itself.
    tex_pipe = Hunyuan3DPaintPipeline.from_pretrained(
        weights_path,
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


# Tier → generation budget for callers that speak forge tiers (the gcp
# provider's reconstruct mode forwards `tier` verbatim). The defaults match
# the high bar below; draft trades octree resolution + steps for latency.
# max_facenum bounds the cleanup decimation before painting.
_TIER_QUALITY = {
    "draft": {"steps": 30, "octree_resolution": 256, "max_facenum": 20_000},
    "standard": {"steps": 40, "octree_resolution": 320, "max_facenum": 40_000},
    "high": {"steps": 50, "octree_resolution": 384, "max_facenum": 40_000},
}
_DEFAULT_QUALITY = _TIER_QUALITY["high"]


def _quality_for(tier: str | None, target_polycount: int | None) -> dict:
    q = dict(_TIER_QUALITY.get((tier or "").strip().lower(), _DEFAULT_QUALITY))
    # A poly-aware caller's explicit budget wins over the tier preset, clamped
    # to what the multiview paint pass handles well on the L4.
    if isinstance(target_polycount, int) and target_polycount > 0:
        q["max_facenum"] = max(5_000, min(target_polycount, 200_000))
    return q


async def _run_inference(task_id: str, images: list[str], body_type: str, quality: dict | None = None) -> None:
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

            q = quality or _DEFAULT_QUALITY

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
                # GCP credit budget): the default budget runs 50 steps at 384
                # octree resolution — above the quickstart defaults (30 steps,
                # 256) — for sharper geometry on realistic human/object
                # subjects. Tiered callers scale this down via _TIER_QUALITY.
                # The pipeline returns a list of trimesh objects; single
                # image → take the first.
                mesh = _pipeline["shape"](
                    image=subject,
                    num_inference_steps=q["steps"],
                    guidance_scale=5.5,
                    octree_resolution=q["octree_resolution"],
                )[0]

                # Upstream's standard cleanup chain before painting: drop
                # floating debris and degenerate faces, then decimate to a
                # budget the multiview paint pipeline handles well. 40k faces
                # keeps far more surface detail than the demo's default and
                # still textures in one pass on the L4.
                mesh = FloaterRemover()(mesh)
                mesh = DegenerateFaceRemover()(mesh)
                mesh = FaceReducer()(mesh, max_facenum=q["max_facenum"])

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
    # Forge reconstruct-mode provenance: the gcp provider forwards the resolved
    # tier and (for poly-aware callers) a target polycount — they select the
    # generation budget via _quality_for. Absent fields mean the high default.
    tier: str | None = None
    path: str | None = None
    target_polycount: int | None = None


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
    background_tasks.add_task(
        _run_inference,
        task_id,
        body.images,
        body.body_type,
        _quality_for(body.tier, body.target_polycount),
    )
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
    return await _resolve_task(task_id)


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
