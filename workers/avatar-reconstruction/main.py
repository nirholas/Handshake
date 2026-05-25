"""
Avatar reconstruction service — Phase 1: face texture transfer.

Same external API contract as the original InstantMesh service so the
Vercel backend (api/_providers/gcp.js) requires zero changes:

  POST /reconstruct   { images: [data-uri|https-url, ...], job_id?: str }
                   →  202 { job_id, status: "queued" }

  GET  /jobs/:id    → { job_id, status, glb_url?, error?, updated_at }

  GET  /health      → { ok, pipeline, model_loaded }

Environment variables (all required unless noted):
  API_KEY               — shared bearer secret (set via GCP Secret Manager)
  GCS_BUCKET            — Cloud Storage bucket for output GLBs
  FIRESTORE_PROJECT     — GCP project hosting Firestore
  MAX_CONCURRENT_JOBS   — parallel jobs (default: 2; CPU-only pipeline)
"""

from __future__ import annotations

import asyncio
import logging
import os
import traceback
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from fastapi.responses import JSONResponse
from google.cloud import firestore, storage
from pydantic import BaseModel, Field

import face_pipeline

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("main")

# ── config ─────────────────────────────────────────────────────────────────────

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
FIRESTORE_PROJECT = os.environ["FIRESTORE_PROJECT"]
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT_JOBS", "2"))

# ── global state ───────────────────────────────────────────────────────────────

_db: firestore.Client | None = None
_bucket: storage.Bucket | None = None
_job_sem: asyncio.Semaphore | None = None


# ── lifespan ───────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db, _bucket, _job_sem

    _job_sem = asyncio.Semaphore(MAX_CONCURRENT)

    # Warm up the UV map and template GLBs on startup (loads them into memory).
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, face_pipeline._get_uv_map)

    _db = firestore.Client(project=FIRESTORE_PROJECT)
    _bucket = storage.Client().bucket(GCS_BUCKET)

    log.info("Server ready — pipeline=face_texture_transfer, max_concurrent=%d", MAX_CONCURRENT)
    yield


app = FastAPI(title="avatar-reconstruction", lifespan=lifespan)


# ── auth ───────────────────────────────────────────────────────────────────────

def _require_api_key(authorization: str) -> None:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    if authorization[len("Bearer "):].strip() != API_KEY:
        raise HTTPException(status_code=401, detail="invalid api key")


# ── Firestore helpers ──────────────────────────────────────────────────────────

def _set_job(job_id: str, data: dict) -> None:
    _db.collection("avatar_reconstruction_jobs").document(job_id).set(
        {**data, "updated_at": datetime.now(timezone.utc)},
        merge=True,
    )


def _get_job(job_id: str) -> dict | None:
    doc = _db.collection("avatar_reconstruction_jobs").document(job_id).get()
    return doc.to_dict() if doc.exists else None


# ── job worker ─────────────────────────────────────────────────────────────────

async def _process_job(job_id: str, image_sources: list[str], body_type: str) -> None:
    async with _job_sem:
        _set_job(job_id, {"status": "running"})
        loop = asyncio.get_event_loop()
        try:
            log.info("[%s] running pipeline", job_id)

            glb_bytes = await loop.run_in_executor(
                None,
                lambda: face_pipeline.process(job_id, image_sources, body_type),
            )

            log.info("[%s] uploading %d bytes to GCS", job_id, len(glb_bytes))
            blob_name = f"avatars/{job_id}.glb"
            blob = _bucket.blob(blob_name)
            await loop.run_in_executor(
                None,
                lambda: blob.upload_from_string(glb_bytes, content_type="model/gltf-binary"),
            )
            glb_url = f"https://storage.googleapis.com/{GCS_BUCKET}/{blob_name}"

            _set_job(job_id, {"status": "done", "glb_url": glb_url})
            log.info("[%s] done → %s", job_id, glb_url)

        except Exception:
            err = traceback.format_exc()
            log.exception("[%s] pipeline failed", job_id)
            _set_job(job_id, {"status": "failed", "error": err})


# ── routes ─────────────────────────────────────────────────────────────────────

class ReconstructRequest(BaseModel):
    images: list[str] = Field(..., min_length=1, max_length=6)
    job_id: str | None = None
    body_type: str = "neutral"  # 'male' | 'female' | 'neutral'


@app.post("/reconstruct", status_code=202)
async def reconstruct(
    body: ReconstructRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(...),
) -> dict:
    _require_api_key(authorization)
    job_id = body.job_id or str(uuid.uuid4())
    _set_job(job_id, {
        "job_id": job_id,
        "status": "queued",
        "image_count": len(body.images),
        "body_type": body.body_type,
        "created_at": datetime.now(timezone.utc),
    })
    background_tasks.add_task(_process_job, job_id, body.images, body.body_type)
    return {"job_id": job_id, "status": "queued"}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str, authorization: str = Header(...)) -> dict:
    _require_api_key(authorization)
    job = _get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    for k, v in job.items():
        if hasattr(v, "isoformat"):
            job[k] = v.isoformat()
    return job


@app.get("/health")
async def health() -> dict:
    uv_ready = (face_pipeline.HERE / "face_uv_map.json").exists()
    return {
        "ok": True,
        "pipeline": "face_texture_transfer_v1",
        "model_loaded": uv_ready,
        "uv_map_ready": uv_ready,
    }
