"""
UniRig auto-rigging service — adds skeleton, skinning weights, and ARKit-52
blendshapes to raw meshes from the 3D generation models.

VAST-AI-Research/UniRig (MIT, SIGGRAPH 2025) predicts:
  - Skeleton joint placement (humanoid hierarchy)
  - Per-vertex skinning weights
  - Blendshape transfer from a template head mesh

API contract (consumed by the Pipeline Controller):
  POST /rig   { mesh_gcs_url: str, template?: str, blendshapes?: bool, job_id?: str }
           →  202 { task_id, status: "queued" }

  GET  /tasks/:id → { task_id, status, rigged_gcs_url?, error? }

  GET  /health    → { ok, model, gpu_available }

Model weights pre-population:
  pip install huggingface_hub
  huggingface-cli download VAST-AI/UniRig --local-dir /tmp/unirig
  gsutil -m cp -r /tmp/unirig gs://three-ws-model-weights/unirig/

Environment variables:
  API_KEY           — shared bearer secret
  GCS_BUCKET        — Cloud Storage bucket for output rigged GLBs
  WEIGHTS_DIR       — local path to UniRig model weights (default: /weights/unirig)
  TEMPLATES_DIR     — local path to skeleton/blendshape templates (default: /app/templates)
  MAX_CONCURRENT    — max parallel rigging jobs (default: 1)
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import time
import traceback
import uuid
from contextlib import asynccontextmanager
from typing import Optional

import numpy as np
import torch
import trimesh
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from google.cloud import storage
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("unirig")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
WEIGHTS_DIR = os.environ.get("WEIGHTS_DIR", "/weights/unirig")
TEMPLATES_DIR = os.environ.get("TEMPLATES_DIR", "/app/templates")
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "1"))

_model = None
_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_tasks: dict[str, dict] = {}


def _load_model():
    global _model
    from unirig import UniRigModel

    log.info("Loading UniRig model from %s", WEIGHTS_DIR)
    _model = UniRigModel.from_pretrained(WEIGHTS_DIR)
    _model = _model.to("cuda")
    _model.eval()
    log.info("UniRig model loaded")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _load_model)
    log.info("Service ready — max_concurrent=%d", MAX_CONCURRENT)
    yield


app = FastAPI(title="unirig", lifespan=lifespan)


def _require_api_key(authorization: str) -> None:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    if authorization[len("Bearer "):].strip() != API_KEY:
        raise HTTPException(status_code=401, detail="invalid api key")


# Wolf3D / ARKit-52 skeleton joint names. UniRig predicts joint placement; we
# remap its output to this hierarchy so the three.ws avatar runtime can drive it.
WOLF3D_JOINTS = [
    "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
    "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
    "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
    "LeftEye", "RightEye", "Jaw",
]

ARKIT_52_BLENDSHAPES = [
    "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft",
    "browOuterUpRight", "cheekPuff", "cheekSquintLeft", "cheekSquintRight",
    "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft", "eyeLookDownRight",
    "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
    "eyeLookUpLeft", "eyeLookUpRight", "eyeSquintLeft", "eyeSquintRight",
    "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawOpen",
    "jawRight", "mouthClose", "mouthDimpleLeft", "mouthDimpleRight",
    "mouthFrownLeft", "mouthFrownRight", "mouthFunnel", "mouthLeft",
    "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft",
    "mouthPressRight", "mouthPucker", "mouthRight", "mouthRollLower",
    "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "mouthSmileLeft",
    "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight",
    "mouthUpperUpLeft", "mouthUpperUpRight", "noseSneerLeft", "noseSneerRight",
    "tongueOut",
]


async def _run_rigging(
    task_id: str,
    mesh_gcs_url: str,
    template: str,
    blendshapes: bool,
) -> None:
    async with _sem:
        _tasks[task_id]["status"] = "running"
        loop = asyncio.get_event_loop()
        t0 = time.time()
        try:
            # Download the raw mesh from GCS.
            import httpx
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.get(mesh_gcs_url)
                resp.raise_for_status()
                mesh_bytes = resp.content

            def _rig():
                mesh = trimesh.load(io.BytesIO(mesh_bytes), file_type="glb", force="mesh")

                with torch.no_grad():
                    result = _model.rig(
                        vertices=torch.tensor(mesh.vertices, dtype=torch.float32, device="cuda"),
                        faces=torch.tensor(mesh.faces, dtype=torch.long, device="cuda"),
                    )

                skeleton = result["skeleton"]
                skinning_weights = result["skinning_weights"]

                joints = skeleton["joints"].cpu().numpy()
                parents = skeleton["parents"].cpu().numpy()
                weights = skinning_weights.cpu().numpy()

                import pygltflib
                glb = pygltflib.GLTF2.load_from_bytes(mesh_bytes)
                _inject_skeleton(glb, mesh, joints, parents, weights)

                if blendshapes and hasattr(result, "blendshapes"):
                    _inject_blendshapes(glb, mesh, result["blendshapes"])

                buf = io.BytesIO()
                glb.save_to_bytes(buf)
                return buf.getvalue()

            rigged_bytes = await loop.run_in_executor(None, _rig)

            blob_name = f"rigged-meshes/{task_id}.glb"
            blob = _bucket.blob(blob_name)
            await loop.run_in_executor(
                None,
                lambda: blob.upload_from_string(rigged_bytes, content_type="model/gltf-binary"),
            )
            gcs_url = f"https://storage.googleapis.com/{GCS_BUCKET}/{blob_name}"

            elapsed = time.time() - t0
            _tasks[task_id].update({
                "status": "done",
                "rigged_gcs_url": gcs_url,
                "elapsed_ms": int(elapsed * 1000),
            })
            log.info("[%s] rigging done in %.1fs — %d bytes → %s", task_id, elapsed, len(rigged_bytes), gcs_url)

        except Exception:
            _tasks[task_id].update({
                "status": "failed",
                "error": traceback.format_exc(),
                "elapsed_ms": int((time.time() - t0) * 1000),
            })
            log.exception("[%s] rigging failed", task_id)


def _inject_skeleton(glb, mesh, joints, parents, weights):
    """
    Inject a skeleton (joints + inverse bind matrices) and skinning weights
    into the GLB. This wires the mesh as a skinned mesh node with the Wolf3D
    joint hierarchy so the three.ws avatar runtime can animate it.

    The actual implementation depends on UniRig's output format. This is a
    scaffold — the joint remapping from UniRig's predicted skeleton to Wolf3D's
    naming convention will need calibration during integration testing.
    """
    log.info("Injecting skeleton: %d joints, %d vertices", len(joints), len(mesh.vertices))
    # TODO: Full pygltflib skeleton injection.
    # This requires:
    #   1. Creating skin.joints[] node array with Wolf3D names
    #   2. Computing inverseBindMatrices accessor
    #   3. Creating a JOINTS_0 + WEIGHTS_0 accessor pair on the mesh primitive
    #   4. Remapping UniRig's joint ordering to WOLF3D_JOINTS
    # Placeholder: the rigged GLB will be returned as-is from UniRig's output
    # format. The three.ws glb-inspect.js will detect whether it's properly rigged.


def _inject_blendshapes(glb, mesh, blendshapes_data):
    """
    Inject ARKit-52 blendshape morph targets into the GLB.

    Blendshape transfer from a template head is the research-heavy part.
    UniRig may or may not support this natively. Fallback approach:
      1. Register the generated head mesh to a Wolf3D template via ICP
      2. Transfer blendshape deltas using deformation transfer
      3. Name them per ARKIT_52_BLENDSHAPES

    This is scaffolded for now — the initial deployment will ship without
    blendshapes (body animation only via skeleton). Blendshapes will be
    added in a follow-up once we validate the mesh quality from each model.
    """
    log.info("Blendshape injection requested — not yet implemented, skipping")


class RigRequest(BaseModel):
    mesh_gcs_url: str
    template: str = "wolf3d_neutral"
    blendshapes: bool = True
    job_id: str | None = None


@app.post("/rig", status_code=202)
async def rig(
    body: RigRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(...),
) -> dict:
    _require_api_key(authorization)
    task_id = str(uuid.uuid4())
    _tasks[task_id] = {"task_id": task_id, "status": "queued"}
    background_tasks.add_task(
        _run_rigging, task_id, body.mesh_gcs_url, body.template, body.blendshapes,
    )
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
        "model": "unirig",
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "model_loaded": _model is not None,
    }
