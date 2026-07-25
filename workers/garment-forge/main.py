"""
garment-forge: text prompt → rigged, wearable garment GLB + manifest.

Orchestrates the platform's already-deployed GPU workers instead of hosting a
model itself, so this service runs on plain CPU:

  prompt ─→ Vertex AI image lane (ghost-mannequin reference photo)
         ─→ model-hunyuan3d-21-rtx → model-hunyuan3d-21 → model-trellis
            (image → PBR-textured mesh, first healthy rung wins)
         ─→ compose with the canonical reference body (parametric-base)
         ─→ model-rig (Make-It-Animatable: skeleton + skin weights with
            full-body context)
         ─→ strip the reference body, canonicalize bones, validate the 6
            manifest rules, publish to GCS + garments/catalog.json

API contract (same wire shape as workers/avatar-reconstruction/main.py):

  POST /generate   { prompt, slot, tier?, yaw_deg? }
                →  202 { job_id, status: "queued" }
  GET  /jobs/:id → { job_id, status, stage, glb_url?, manifest_url?,
                     thumb_url?, coverage?, occludes?, error?, updated_at }
  GET  /health   → { ok, refbody_loaded, mesh_backends, rig_url }

Job state is persisted to a durable GCS blob on every transition (the same
pattern as the hunyuan 2.1 worker): a POST and a later poll that land on
different instances still see one record, and the service can scale to zero.

Environment variables:
  API_KEY          shared bearer secret (avatar-reconstruction-key), used both
                   to authenticate callers and to call the other workers
  GCS_BUCKET       job records + rig staging (three-ws-avatar-reconstructions,
                   the same worker-artifact bucket the rest of the fleet uses)
  PUBLISH_BUCKET   public catalog bucket holding garments/** (three-ws-garments,
                   the bucket src/garment-catalog.js reads)
  MESH_WORKER_URLS comma-separated /infer-contract mesh workers, priority order
  RIG_URL          model-rig base URL
  REFBODY_PATH     reference body GLB baked into the image
  GOOGLE_CLOUD_PROJECT, VERTEX_IMAGEN_MODEL, VERTEX_IMAGEN_LOCATION,
  VERTEX_IMAGE_SIZE                          Vertex image lane (see pipeline.py)
  GARMENT_YAW_DEG  yaw applied to generator output before placement (default 0)
  MAX_CONCURRENT   parallel jobs per instance (default 2; CPU-bound stages only)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from google.api_core.exceptions import NotFound
from google.cloud import storage
from pydantic import BaseModel, Field

import garment_glb
import pipeline
from canonical_bones import GARMENT_SLOTS
from worker_security import require_api_key, safe_error

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("garment-forge")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
PUBLISH_BUCKET = os.environ["PUBLISH_BUCKET"]
MESH_WORKER_URLS = [u.strip().rstrip("/") for u in
                    os.environ["MESH_WORKER_URLS"].split(",") if u.strip()]
RIG_URL = os.environ["RIG_URL"].rstrip("/")
REFBODY_PATH = os.environ.get("REFBODY_PATH", "/app/assets/refbody.glb")
GARMENT_YAW_DEG = float(os.environ.get("GARMENT_YAW_DEG", "0"))
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "2"))

_bucket: Optional[storage.Bucket] = None          # jobs + rig staging
_publish_bucket: Optional[storage.Bucket] = None  # public garment catalog
_sem: Optional[asyncio.Semaphore] = None
_refbody: Optional[bytes] = None
_jobs: dict[str, dict] = {}


def _job_blob(job_id: str):
    return _bucket.blob(f"garment-jobs/{job_id}.json")


async def _update_job(job_id: str, **fields) -> dict:
    job = _jobs.setdefault(job_id, {"job_id": job_id})
    job.update(fields, updated_at=datetime.now(timezone.utc).isoformat())
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: _job_blob(job_id).upload_from_string(
            json.dumps(job), content_type="application/json"),
    )
    return job


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _publish_bucket, _sem, _refbody
    client = storage.Client()
    _bucket = client.bucket(GCS_BUCKET)
    _publish_bucket = client.bucket(PUBLISH_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    with open(REFBODY_PATH, "rb") as fh:
        _refbody = fh.read()
    log.info("garment-forge ready: refbody=%d bytes, mesh backends=%s, rig=%s",
             len(_refbody), MESH_WORKER_URLS, RIG_URL)
    yield


app = FastAPI(title="garment-forge", lifespan=lifespan)


def _require_api_key(authorization: str) -> None:
    try:
        require_api_key(authorization, API_KEY)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


def _run_stages(job_id: str, prompt: str, slot: str, tier: str,
                yaw_deg: float, progress) -> dict:
    """The blocking pipeline; runs in a worker thread. `progress(stage)`
    persists the stage transition so pollers watch the job move."""
    progress("image")
    image_bytes, image_model = pipeline.generate_reference_image(prompt, slot)

    progress("mesh")
    mesh_bytes, mesh_backend = pipeline.generate_mesh(
        image_bytes, MESH_WORKER_URLS, API_KEY, tier=tier)

    progress("compose")
    composite = garment_glb.compose_scene(mesh_bytes, _refbody, slot, yaw_deg)

    progress("rig")
    rigged = pipeline.rig_composite(composite, RIG_URL, API_KEY, _bucket, job_id)

    progress("extract")
    garment_bytes = garment_glb.extract_garment(rigged)

    progress("validate")
    stats = garment_glb.skin_stats(garment_bytes)
    occludes = garment_glb.derive_occludes(stats["bone_mass"], stats["total_mass"],
                                           slot=slot)
    bones = garment_glb.weighted_bones(stats["bone_mass"], stats["total_mass"])

    garment_id = f"{garment_glb.slugify(prompt)}-{job_id[:6]}"
    version = pipeline.next_version(_publish_bucket, slot, garment_id)
    base = (f"https://storage.googleapis.com/{_publish_bucket.name}/garments/"
            f"{slot}/{garment_id}/v{version}")
    manifest = garment_glb.build_manifest(
        garment_id=garment_id,
        name=prompt.strip().capitalize(),
        slot=slot,
        version=version,
        model_uri=f"{base}/garment.glb",
        glb_bytes=garment_bytes,
        triangle_count=stats["triangle_count"],
        bones=bones,
        occludes=occludes,
        prompt=prompt,
        mesh_model=mesh_backend,
        thumb_uri=f"{base}/thumb.webp",
    )
    verdict = garment_glb.validate_manifest(manifest, garment_bytes)
    if not verdict["ok"]:
        raise RuntimeError("manifest validation failed: "
                           + "; ".join(verdict["failures"]))

    progress("publish")
    thumb = pipeline.make_thumbnail(image_bytes)
    urls = pipeline.publish(_publish_bucket, slot, garment_id, version,
                            garment_bytes, manifest, thumb)
    return {
        **urls,
        "garment_id": garment_id,
        "version": version,
        "coverage": round(verdict["coverage"], 4),
        "occludes": occludes,
        "bones": bones,
        "triangle_count": stats["triangle_count"],
        "mesh_backend": mesh_backend,
        "image_model": image_model,
    }


async def _process_job(job_id: str, prompt: str, slot: str, tier: str,
                       yaw_deg: float) -> None:
    async with _sem:
        loop = asyncio.get_event_loop()
        t0 = time.time()

        def progress(stage: str) -> None:
            # Persist synchronously from the worker thread: a poll may land
            # on another instance the moment the stage flips.
            job = _jobs.setdefault(job_id, {"job_id": job_id})
            job.update(status="running", stage=stage,
                       updated_at=datetime.now(timezone.utc).isoformat())
            _job_blob(job_id).upload_from_string(
                json.dumps(job), content_type="application/json")
            log.info("[%s] stage: %s", job_id, stage)

        try:
            result = await loop.run_in_executor(
                None, _run_stages, job_id, prompt, slot, tier, yaw_deg, progress)
            await _update_job(job_id, status="done", stage="done",
                              elapsed_ms=int((time.time() - t0) * 1000), **result)
            log.info("[%s] done in %.1fs → %s (coverage %.3f)",
                     job_id, time.time() - t0, result["glb_url"], result["coverage"])
        except Exception as exc:  # noqa: BLE001: surfaced via job status
            await _update_job(
                job_id, status="failed",
                error=safe_error(exc, context=f"[{job_id}] garment pipeline"),
                elapsed_ms=int((time.time() - t0) * 1000),
            )
            log.error("[%s] failed: %s", job_id, exc)


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=3, max_length=500)
    slot: str
    tier: str = "high"
    yaw_deg: float | None = None
    job_id: str | None = None


@app.post("/generate", status_code=202)
async def generate(
    body: GenerateRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(...),
) -> dict:
    _require_api_key(authorization)
    if body.slot not in GARMENT_SLOTS:
        raise HTTPException(status_code=422,
                            detail=f"slot must be one of {list(GARMENT_SLOTS)}")
    job_id = body.job_id or str(uuid.uuid4())
    await _update_job(job_id, status="queued", stage="queued",
                      prompt=body.prompt, slot=body.slot)
    background_tasks.add_task(
        _process_job, job_id, body.prompt, body.slot, body.tier,
        body.yaw_deg if body.yaw_deg is not None else GARMENT_YAW_DEG,
    )
    return {"job_id": job_id, "status": "queued"}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str, authorization: str = Header(...)) -> dict:
    _require_api_key(authorization)
    job = _jobs.get(job_id)
    if job is not None:
        return job
    loop = asyncio.get_event_loop()
    try:
        data = await loop.run_in_executor(None, _job_blob(job_id).download_as_bytes)
    except NotFound:
        raise HTTPException(status_code=404, detail="job not found")
    except Exception as exc:
        raise HTTPException(status_code=502,
                            detail=safe_error(exc, context="job lookup")) from exc
    job = json.loads(data)
    _jobs[job_id] = job
    return job


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "pipeline": "garment-forge@1",
        "refbody_loaded": _refbody is not None,
        "mesh_backends": MESH_WORKER_URLS,
        "rig_url": RIG_URL,
        "active_jobs": sum(1 for j in _jobs.values()
                           if j.get("status") in ("queued", "running")),
    }
