"""
Hunyuan3D-2.1 inference service — single image → PBR-textured 3D mesh.

This is the realism lane. Where 2.0 (see main.py, deployed as the
`model-hunyuan3d` service) bakes a single diffuse texture, 2.1 runs Tencent's
hy3dshape shape DiT followed by the hy3dpaint PBR paint pass and exports a GLB
with a TRUE physically-based material set:

    baseColor (albedo) + metallicRoughness (metallic in B, roughness in G) + normal

PBR materials are what make a render read as a real photographed object under
real lighting instead of a flat plastic toy — the single biggest realism lever
in the platform's own GPU fleet.

Deployed as its OWN Cloud Run service (`model-hunyuan3d-21`) rather than a new
revision of `model-hunyuan3d`, because 2.0 and 2.1 have mutually incompatible
Python stacks (torch 2.3/cu121 + hy3dgen vs torch 2.5/cu124 +
hy3dshape/hy3dpaint). Running them as two services means the working 2.0 lane is
never touched: fallback is an instant `GCP_HUNYUAN3D_URL` env swap back to the
2.0 service, with zero rebuild. The HUNYUAN3D_MODEL flag pins this image to 2.1.

API contract (identical to the 2.0 worker; consumed by the Pipeline Controller
and by api/_providers/gcp.js in reconstruct mode):

  POST /infer        { images: [data-uri|url, ...], tier?, target_polycount?, job_id? }
                  →  202 { task_id, status: "queued" }
  POST /reconstruct  same body → 202 { task_id, job_id, status }   (alias)
  GET  /tasks/:id    → { task_id, status, result_gcs_url?, error? }
  GET  /jobs/:id     → same, plus job_id + glb_url aliases         (alias)
  GET  /health       → { ok, model, gpu_available, ready, load_error }

Task state is persisted to the durable `tasks/{id}.json` GCS blob on every
transition (same as the 2.0 worker) so a POST /infer and a later GET /tasks/:id
that land on different instances still see the same record.

Weights load from GCS. The shape DiT is a single 6.9 GiB `.ckpt` and the paint
UNet a single 3.7 GiB `.bin`; reading files that large over the Cloud Storage
FUSE mount stalls indefinitely (the exact failure the 2.0 lane hit and fixed),
so this worker streams the needed subtrees to local disk with the storage client
(a plain sequential GET, which does not stall) and loads from there. Staging is
gated on WEIGHTS_GCS_URI / DINO_GCS_URI and degrades to the FUSE mount on any
failure — it never crashes the loader.

Environment variables:
  API_KEY           — shared bearer secret (== platform GCP_RECONSTRUCTION_KEY)
  GCS_BUCKET        — Cloud Storage bucket for output meshes
  HUNYUAN3D_MODEL   — pinned to "2.1" for this image
  WEIGHTS_GCS_URI   — gs:// prefix of the 2.1 weight tree to stage locally
  WEIGHTS_LOCAL_DIR — local staging dir for the 2.1 weights (default /tmp/hunyuan3d-2.1)
  WEIGHTS_DIR       — FUSE-mount fallback for the 2.1 weights (default /weights/hunyuan3d-2.1)
  DINO_GCS_URI      — gs:// prefix of facebook/dinov2-giant to stage locally
  DINO_LOCAL_DIR    — local staging dir for DINOv2 (default /tmp/dinov2-giant)
  DINO_DIR          — FUSE-mount fallback for DINOv2 (default /weights/dinov2-giant)
  HUNYUAN3D21_REPO  — path of the cloned 2.1 repo in the image (default /opt/hunyuan3d21)
  MAX_CONCURRENT    — in-flight inferences (default 1; one L4 fits one)
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import sys
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
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
log = logging.getLogger("hunyuan3d21")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
MODEL_VERSION = os.environ.get("HUNYUAN3D_MODEL", "2.1").strip()
MODEL_LABEL = "hunyuan3d-2.1"
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "1"))
REPO_ROOT = os.environ.get("HUNYUAN3D21_REPO", "/opt/hunyuan3d21")

WEIGHTS_DIR = os.environ.get("WEIGHTS_DIR", "/weights/hunyuan3d-2.1")
WEIGHTS_GCS_URI = os.environ.get("WEIGHTS_GCS_URI", "")  # e.g. gs://bucket/hunyuan3d-2.1
WEIGHTS_LOCAL_DIR = os.environ.get("WEIGHTS_LOCAL_DIR", "/tmp/hunyuan3d-2.1")
DINO_DIR = os.environ.get("DINO_DIR", "/weights/dinov2-giant")
DINO_GCS_URI = os.environ.get("DINO_GCS_URI", "")  # e.g. gs://bucket/dinov2-giant
DINO_LOCAL_DIR = os.environ.get("DINO_LOCAL_DIR", "/tmp/dinov2-giant")

_pipeline = None
_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_ready: Optional[asyncio.Event] = None
_load_error: Optional[str] = None
# In-memory cache only — Cloud Run has no session affinity, so a POST /infer and
# a later GET /tasks/:id can land on different instances. The durable source of
# truth is the tasks/{id}.json GCS blob; this dict just avoids a GCS round-trip
# on a warm same-instance poll.
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


def _stage_prefix_local(gcs_uri: str, local_dir: str, label: str) -> Optional[str]:
    """Stream every object under a gs:// prefix to local disk with the storage
    client, bypassing the FUSE mount (which stalls on multi-GiB sequential
    reads). Returns local_dir on success or None to signal "load from the FUSE
    mount instead". Never raises — a staging failure must degrade, not crash."""
    if not gcs_uri.startswith("gs://"):
        return None
    try:
        bucket_name, _, prefix = gcs_uri[len("gs://"):].partition("/")
        prefix = prefix.rstrip("/") + "/"
        client = storage.Client()
        blobs = [
            b for b in client.list_blobs(bucket_name, prefix=prefix)
            if b.name[len(prefix):] and not b.name.endswith("/")
        ]
        if not blobs:
            log.warning("[%s] staging: no objects under %s; using FUSE mount", label, gcs_uri)
            return None

        def _download(blob) -> int:
            rel = blob.name[len(prefix):]
            dest = os.path.join(local_dir, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            # Reuse an already-staged object (warm restart) when its size matches.
            if os.path.exists(dest) and blob.size is not None and os.path.getsize(dest) == blob.size:
                return blob.size or 0
            blob.download_to_filename(dest)
            return blob.size or os.path.getsize(dest)

        os.makedirs(local_dir, exist_ok=True)
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=8) as pool:
            total = sum(pool.map(_download, blobs))
        log.info(
            "[%s] staged to %s in %.1fs (%d objects, %.2f GiB)",
            label, local_dir, time.time() - t0, len(blobs), total / (1024 ** 3),
        )
        return local_dir
    except Exception as exc:  # noqa: BLE001 — degrade to the FUSE mount, never crash
        log.warning("[%s] staging failed (%s); falling back to FUSE mount", label, exc)
        return None


# ── Tier → generation budget ────────────────────────────────────────────────
# Quality over speed: GPU time is cheap against the platform's GCP credit
# budget, so the ceiling is pushed high. The budget splits across the shape DiT
# (inference steps + marching-cubes octree resolution) and the PBR paint pass
# (multiview count + per-view diffusion resolution). The paint atlas size is
# fixed high at load (render 2048, texture 4096).
_TIER_QUALITY = {
    "draft": {"steps": 30, "octree_resolution": 256, "views": 6, "resolution": 512},
    "standard": {"steps": 50, "octree_resolution": 384, "views": 6, "resolution": 512},
    # high pushes shape octree + per-view diffusion resolution (768) for sharper
    # PBR maps while holding the multiview count at 6 so the paint pass stays
    # within the L4's 24 GiB VRAM alongside the shape DiT + DINOv2 + super-res.
    "high": {"steps": 50, "octree_resolution": 512, "views": 6, "resolution": 768},
}
_DEFAULT_QUALITY = _TIER_QUALITY["high"]


def _quality_for(tier: str | None) -> dict:
    return dict(_TIER_QUALITY.get((tier or "").strip().lower(), _DEFAULT_QUALITY))


def _load_pipeline():
    global _pipeline
    # The 2.1 repo is cloned to REPO_ROOT in the image and expects its two
    # package dirs on sys.path plus cwd==REPO_ROOT (the paint config references
    # cfg/ckpt files by repo-relative path). The Dockerfile sets WORKDIR there.
    for p in (REPO_ROOT, os.path.join(REPO_ROOT, "hy3dshape"), os.path.join(REPO_ROOT, "hy3dpaint")):
        if p not in sys.path:
            sys.path.insert(0, p)

    # torchvision >=0.17 moved functional_tensor; the repo ships a shim for it.
    try:
        from torchvision_fix import apply_fix
        apply_fix()
    except Exception as exc:  # noqa: BLE001 — non-fatal compatibility shim
        log.warning("[2.1] torchvision_fix not applied: %s", exc)

    # Stage the big weight trees off the FUSE mount to local disk.
    weights_root = _stage_prefix_local(WEIGHTS_GCS_URI, WEIGHTS_LOCAL_DIR, "weights") or WEIGHTS_DIR
    dino_root = _stage_prefix_local(DINO_GCS_URI, DINO_LOCAL_DIR, "dino") or DINO_DIR

    # hy3dshape's smart_load_model resolves ${HY3DGEN_MODELS}/${model_path}/${subfolder};
    # point it at the staged tree's parent so nothing downloads at boot.
    weights_parent = os.path.dirname(weights_root.rstrip("/"))
    weights_name = os.path.basename(weights_root.rstrip("/"))
    os.environ["HY3DGEN_MODELS"] = weights_parent

    # The paint pipeline's multiview loader calls
    #   huggingface_hub.snapshot_download(repo_id, allow_patterns=["hunyuan3d-paintpbr-v2-1/*"])
    # and joins that subfolder. Intercept the known repo id and hand back the
    # local staged tree (which already contains hunyuan3d-paintpbr-v2-1/). Any
    # other repo id falls through to the real downloader, so this never blocks a
    # legitimate fetch.
    import huggingface_hub

    _real_snapshot = huggingface_hub.snapshot_download

    def _local_snapshot(*args, **kwargs):
        repo_id = kwargs.get("repo_id") or (args[0] if args else None)
        if repo_id == "tencent/Hunyuan3D-2.1" and os.path.isdir(weights_root):
            log.info("[2.1] serving paint weights from local staged tree %s", weights_root)
            return weights_root
        return _real_snapshot(*args, **kwargs)

    huggingface_hub.snapshot_download = _local_snapshot

    from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline
    from hy3dshape.rembg import BackgroundRemover
    from textureGenPipeline import Hunyuan3DPaintPipeline, Hunyuan3DPaintConfig
    from hy3dpaint.convert_utils import create_glb_with_pbr_materials

    log.info("[2.1] loading shape DiT (%s / hunyuan3d-dit-v2-1)", weights_name)
    shape_pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
        weights_name,
        subfolder="hunyuan3d-dit-v2-1",
        use_safetensors=False,
        variant="fp16",
        device="cuda",
        dtype=torch.float16,
    )

    log.info("[2.1] loading PBR paint pipeline (multiview + super-res + DINOv2)")
    # Build the paint pipeline once at the ceiling view count; per job the tier
    # scales max_selected_view_num / resolution down in place (both are read
    # live from config at call time, so no model reload is needed).
    conf = Hunyuan3DPaintConfig(max_num_view=8, resolution=768)
    conf.realesrgan_ckpt_path = "hy3dpaint/ckpt/RealESRGAN_x4plus.pth"
    conf.multiview_cfg_path = "hy3dpaint/cfgs/hunyuan-paint-pbr.yaml"
    conf.custom_pipeline = "hy3dpaint/hunyuanpaintpbr"
    conf.multiview_pretrained_path = "tencent/Hunyuan3D-2.1"
    if os.path.isdir(dino_root):
        conf.dino_ckpt_path = dino_root
        log.info("[2.1] DINOv2 from %s", dino_root)
    paint_pipe = Hunyuan3DPaintPipeline(conf)

    _pipeline = {
        "shape": shape_pipe,
        "paint": paint_pipe,
        "rembg": BackgroundRemover(),
        "to_pbr_glb": create_glb_with_pbr_materials,
    }
    log.info("[2.1] pipelines loaded")


def _generate(img: Image.Image, q: dict) -> bytes:
    # Isolate the subject from a busy background: the shape DiT conditions on it.
    subject = img if img.mode == "RGBA" else _pipeline["rembg"](img.convert("RGB"))

    mesh = _pipeline["shape"](
        image=subject,
        num_inference_steps=q["steps"],
        guidance_scale=5.0,
        octree_resolution=q["octree_resolution"],
    )[0]

    with tempfile.TemporaryDirectory(prefix="hy3d21_") as tmp:
        initial_glb = os.path.join(tmp, "shape.glb")
        mesh.export(initial_glb)

        # Scale the PBR paint budget to the tier in place.
        paint = _pipeline["paint"]
        paint.config.max_selected_view_num = q["views"]
        paint.config.resolution = q["resolution"]

        obj_out = os.path.join(tmp, "textured.obj")
        # save_glb=False → returns the textured OBJ with sibling PBR maps:
        #   textured.jpg (albedo), textured_metallic.jpg, textured_roughness.jpg,
        #   textured_normal.jpg
        textured_obj = paint(
            mesh_path=initial_glb,
            image_path=subject,
            output_mesh_path=obj_out,
            use_remesh=True,
            save_glb=False,
        )

        base = textured_obj[:-4] if textured_obj.endswith(".obj") else textured_obj
        textures = {"albedo": f"{base}.jpg"}
        metallic, roughness, normal = f"{base}_metallic.jpg", f"{base}_roughness.jpg", f"{base}_normal.jpg"
        if os.path.exists(metallic) and os.path.exists(roughness):
            textures["metallic"] = metallic
            textures["roughness"] = roughness
        if os.path.exists(normal):
            # Upstream's quick-convert drops the normal map; keep it so the GLB
            # carries the full baseColor + metallicRoughness + normal PBR set.
            textures["normal"] = normal

        glb_out = os.path.join(tmp, "textured_pbr.glb")
        _pipeline["to_pbr_glb"](textured_obj, textures, glb_out)
        with open(glb_out, "rb") as fh:
            return fh.read()


async def _load_pipeline_bg():
    """Load the pipeline off the request path and signal readiness when done.
    Runs in a worker thread so the event loop (and the HTTP port) stay live — a
    blocking lifespan load would delay the port past Cloud Run's startup probe
    window and the revision would be marked failed."""
    global _load_error
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, _load_pipeline)
        _ready.set()
        log.info("%s pipeline ready", MODEL_LABEL)
    except Exception as exc:  # noqa: BLE001 — surfaced via /health + task status
        _load_error = safe_error(exc, context="model load")
        log.error("%s pipeline load FAILED: %s", MODEL_LABEL, exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem, _ready
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    _ready = asyncio.Event()
    asyncio.create_task(_load_pipeline_bg())
    log.info(
        "Service starting — %s loading in background (max_concurrent=%d)",
        MODEL_LABEL, MAX_CONCURRENT,
    )
    yield


app = FastAPI(title="model-hunyuan3d-21", lifespan=lifespan)


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


async def _run_inference(task_id: str, images: list[str], quality: dict | None = None) -> None:
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
            glb_bytes = await loop.run_in_executor(None, _generate, img, q)

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
    # tier verbatim; it selects the generation budget via _quality_for. Absent
    # fields mean the high default.
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
    # Persist "queued" before responding — a poll can reach a different instance
    # the moment the 202 lands, and that instance has nothing local to fall back on.
    await _update_task(task_id, status="queued", model=MODEL_LABEL)
    background_tasks.add_task(_run_inference, task_id, body.images, _quality_for(body.tier))
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
    # Not in this instance's local cache — fall back to the durable GCS record.
    loop = asyncio.get_event_loop()
    try:
        data = await loop.run_in_executor(None, _task_blob(task_id).download_as_bytes)
    except NotFound:
        raise HTTPException(status_code=404, detail="task not found")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=safe_error(exc, context="task lookup")) from exc
    task = json.loads(data)
    _tasks[task_id] = task
    return task


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "model": MODEL_LABEL,
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "pipeline_loaded": _pipeline is not None,
        "ready": bool(_ready and _ready.is_set()),
        "load_error": _load_error,
    }
