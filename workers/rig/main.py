"""
Auto-rigging service: adds a Mixamo-standard skeleton, skinning weights, and
ARKit-52 blendshapes to raw humanoid meshes from the 3D generation models.

Engine: jasongzy/Make-It-Animatable (MIT, CVPR 2025) predicts joint placement
and per-vertex weights (see engine_mia.py); rig_glb.py grafts them into the
original GLB bytes so materials/PBR textures are preserved exactly;
blendshapes.py transfers the ICT-FaceKit (MIT) ARKit-52 expression set onto
the head so emotions and lipsync work out of the box.

API contract (identical to the retired unirig worker, so the platform's
GCP_UNIRIG_URL wiring is a config-only cutover):
  POST /rig   { mesh_gcs_url: str, template?: str, blendshapes?: bool, job_id?: str }
           -> 202 { task_id, status: "queued" }
  GET  /tasks/:id -> { task_id, status, rigged_gcs_url?, error?, elapsed_ms? }
  GET  /health    -> { ok, model, gpu_available, gpu_name, model_loaded, queued }

Design notes vs the service this replaces:
  - Every task runs under a hard timeout (TASK_TIMEOUT_S, default 420s): a task
    can finish or fail, but never hang in "running" forever.
  - Bones are named (mixamorig:*), so the platform canonicalizer can retarget
    the full clip library; generic bone_N output is a bug, not a fallback.
  - Task state is in-memory by design: run with min-instances = max-instances
    so pollers always reach the instance that owns the task. A restart 404s
    the poll and the platform fails the job cleanly instead of hanging.
  - Un-riggable input (not a GLB, no triangles) is rejected before the GPU is
    touched and reported with the actual reason; only unexpected failures get
    the opaque correlation id. See rig_glb.validate_input_mesh.

Environment variables:
  API_KEY           shared bearer secret (Secret Manager)
  GCS_BUCKET        output bucket for rigged GLBs
  MIA_DIR           Make-It-Animatable checkout (default /app/mia)
  ARKIT_TEMPLATE    baked template npz (default /app/assets/arkit_template.npz)
  MAX_CONCURRENT    parallel rigging jobs (default 1)
  TASK_TIMEOUT_S    per-task hard timeout in seconds (default 420)
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Optional

import httpx
import torch
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from google.cloud import storage
from google.cloud.storage.retry import DEFAULT_RETRY
from pydantic import BaseModel

import engine_mia
import rig_glb
from blendshapes import head_mask_from_weights, load_template, transfer_blendshapes
from worker_security import (
    UnsafeUrlError,
    fetch_remote_bytes_async,
    require_api_key,
    safe_error,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("rig")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
ARKIT_TEMPLATE = os.environ.get("ARKIT_TEMPLATE", "/app/assets/arkit_template.npz")
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "1"))
TASK_TIMEOUT_S = float(os.environ.get("TASK_TIMEOUT_S", "420"))
# Tasks older than this are pruned from the in-memory store.
TASK_TTL_S = 3600.0

_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_template: Optional[dict] = None
_tasks: dict[str, dict] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem, _template
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    # bpy (used while building MIA's kinematic tree) must run on the main
    # thread, so init happens here, synchronously, before serving. Cloud Run's
    # startup probe covers the load window.
    engine_mia.init()
    _template = load_template(ARKIT_TEMPLATE)
    log.info(
        "Service ready: max_concurrent=%d task_timeout=%.0fs template_shapes=%d",
        MAX_CONCURRENT, TASK_TIMEOUT_S, len(_template["names"]),
    )
    yield


app = FastAPI(title="rig", lifespan=lifespan)


def _require_api_key(authorization: str) -> None:
    try:
        require_api_key(authorization, API_KEY)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


def _prune_tasks() -> None:
    cutoff = time.time() - TASK_TTL_S
    for tid in [t for t, v in _tasks.items() if v.get("created_at", 0) < cutoff]:
        _tasks.pop(tid, None)


def _rig_sync(mesh_bytes: bytes, want_blendshapes: bool) -> bytes:
    """The blocking rig pipeline; runs in a worker thread."""
    # Cheap container/surface check first: a non-GLB or triangle-free input
    # otherwise burns GPU time only to die inside the predictor with a
    # traceback that names neither the caller nor the cause.
    rig_glb.validate_input_mesh(mesh_bytes)

    with tempfile.TemporaryDirectory() as tmp:
        glb_path = os.path.join(tmp, "input.glb")
        with open(glb_path, "wb") as fh:
            fh.write(mesh_bytes)
        pred = engine_mia.predict(glb_path)

    blend = None
    if want_blendshapes:
        mask = head_mask_from_weights(pred["weights"], pred["names"])
        blend = transfer_blendshapes(_template, pred["verts"], mask)

    # rig_glb only needs .vertices off the mesh argument; hand it MIA's working
    # vertices (already back in input space) rather than re-parsing the GLB.
    return rig_glb.build_rigged_glb(
        mesh_bytes,
        SimpleNamespace(vertices=pred["verts"]),
        pred["joints"],
        pred["parents"],
        pred["weights"],
        blendshape_data=blend,
        joint_names=pred["names"],
    )


async def _run_task(task_id: str, mesh_gcs_url: str, want_blendshapes: bool) -> None:
    async with _sem:
        _tasks[task_id]["status"] = "running"
        loop = asyncio.get_event_loop()
        t0 = time.time()
        try:
            async def _work() -> str:
                async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
                    try:
                        mesh_bytes = await fetch_remote_bytes_async(client, mesh_gcs_url)
                    except UnsafeUrlError as exc:
                        raise RuntimeError(f"refused to fetch mesh url: {exc}") from exc

                rigged = await loop.run_in_executor(
                    None, _rig_sync, mesh_bytes, want_blendshapes
                )

                blob_name = f"rigged-meshes/{task_id}.glb"
                blob = _bucket.blob(blob_name)
                # upload_from_string defaults to DEFAULT_RETRY_IF_GENERATION_SPECIFIED,
                # which retries NOTHING when no generation precondition is set, so a
                # transient RemoteDisconnected on the resumable-upload handshake threw
                # away a finished rig. The blob name is a fresh uuid per task, so
                # re-sending can only overwrite this task's own object.
                await loop.run_in_executor(
                    None,
                    lambda: blob.upload_from_string(
                        rigged, content_type="model/gltf-binary", retry=DEFAULT_RETRY
                    ),
                )
                return f"https://storage.googleapis.com/{GCS_BUCKET}/{blob_name}"

            gcs_url = await asyncio.wait_for(_work(), timeout=TASK_TIMEOUT_S)
            elapsed = time.time() - t0
            _tasks[task_id].update({
                "status": "done",
                "rigged_gcs_url": gcs_url,
                "elapsed_ms": int(elapsed * 1000),
            })
            log.info("[%s] rigging done in %.1fs -> %s", task_id, elapsed, gcs_url)
        except asyncio.TimeoutError:
            _tasks[task_id].update({
                "status": "failed",
                "error": f"rigging timed out after {TASK_TIMEOUT_S:.0f}s",
                "elapsed_ms": int((time.time() - t0) * 1000),
            })
            log.error("[%s] rigging timed out", task_id)
        except rig_glb.InvalidMeshError as exc:
            # The caller sent something un-riggable. Report what, verbatim: the
            # message describes only their input, so an opaque correlation id
            # would cost them the one detail that lets them fix the request.
            _tasks[task_id].update({
                "status": "failed",
                "error": str(exc),
                "elapsed_ms": int((time.time() - t0) * 1000),
            })
            log.warning("[%s] rejected input mesh: %s", task_id, exc)
        except Exception as exc:
            _tasks[task_id].update({
                "status": "failed",
                "error": safe_error(exc, context=f"[{task_id}] rigging"),
                "elapsed_ms": int((time.time() - t0) * 1000),
            })


class RigRequest(BaseModel):
    mesh_gcs_url: str
    # Accepted for wire compatibility with the old worker; the ICT template is
    # the only one shipped and `template` no longer selects anything.
    template: str = "arkit_ict"
    blendshapes: bool = True
    job_id: str | None = None


@app.post("/rig", status_code=202)
async def rig(
    body: RigRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(...),
) -> dict:
    _require_api_key(authorization)
    _prune_tasks()
    task_id = str(uuid.uuid4())
    _tasks[task_id] = {
        "task_id": task_id,
        "status": "queued",
        "created_at": time.time(),
    }
    background_tasks.add_task(_run_task, task_id, body.mesh_gcs_url, body.blendshapes)
    return {"task_id": task_id, "status": "queued"}


@app.get("/tasks/{task_id}")
async def get_task(task_id: str, authorization: str = Header(...)) -> dict:
    _require_api_key(authorization)
    task = _tasks.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return {k: v for k, v in task.items() if k != "created_at"}


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "model": "make-it-animatable",
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "model_loaded": engine_mia.is_ready(),
        "queued": sum(1 for t in _tasks.values() if t.get("status") in ("queued", "running")),
    }
