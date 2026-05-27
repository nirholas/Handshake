"""
Avatar Pipeline Controller — orchestrates mesh generation + auto-rigging.

Same external API contract as the original avatar-reconstruction service so
the Vercel backend (api/_providers/gcp.js) needs zero changes:

  POST /reconstruct   { images: [...], body_type?: str }
                   →  202 { job_id, status: "queued" }

  GET  /jobs/:id    → { job_id, status, glb_url?, error?, updated_at, model }

  GET  /health      → { ok, models, router }

Internally the controller:
  1. Picks a model backend (Hunyuan3D / TRELLIS / TripoSR) via weighted random.
  2. POSTs images to the chosen backend's /infer endpoint.
  3. Polls backend until the raw mesh is ready.
  4. POSTs the raw mesh to UniRig for skeleton + skinning + blendshapes.
  5. Uploads the final rigged GLB to GCS.
  6. Updates Firestore with the final status + glb_url.

Environment variables:
  API_KEY               — shared bearer secret
  GCS_BUCKET            — Cloud Storage bucket for output GLBs
  FIRESTORE_PROJECT     — GCP project hosting Firestore
  MODEL_HUNYUAN3D_URL   — URL of the Hunyuan3D Cloud Run service (optional)
  MODEL_TRELLIS_URL     — URL of the TRELLIS Cloud Run service (optional)
  MODEL_TRIPOSR_URL     — URL of the TripoSR Cloud Run service (optional)
  UNIRIG_URL            — URL of the UniRig Cloud Run service (optional)
  MODEL_WEIGHTS         — JSON routing weights, e.g. '{"hunyuan3d":0.5,"trellis":0.3,"triposr":0.2}'
  SKIP_RIGGING          — set to "true" to skip the UniRig stage (for testing)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import time
import traceback
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from google.cloud import firestore, storage
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("controller")

# ── config ────────────────────────────────────────────────────────────────────

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
FIRESTORE_PROJECT = os.environ["FIRESTORE_PROJECT"]
SKIP_RIGGING = os.environ.get("SKIP_RIGGING", "").lower() == "true"

BACKENDS = {}
for name, env_key in [
    ("hunyuan3d", "MODEL_HUNYUAN3D_URL"),
    ("trellis", "MODEL_TRELLIS_URL"),
    ("triposr", "MODEL_TRIPOSR_URL"),
]:
    url = os.environ.get(env_key, "").strip().rstrip("/")
    if url:
        BACKENDS[name] = url

UNIRIG_URL = os.environ.get("UNIRIG_URL", "").strip().rstrip("/")

MODEL_WEIGHTS: dict[str, float] = {}
_raw_weights = os.environ.get("MODEL_WEIGHTS", "").strip()
if _raw_weights:
    try:
        MODEL_WEIGHTS = json.loads(_raw_weights)
    except json.JSONDecodeError:
        log.warning("MODEL_WEIGHTS is not valid JSON, ignoring: %s", _raw_weights)

# Fall back to equal weights for all configured backends.
if not MODEL_WEIGHTS:
    n = len(BACKENDS)
    MODEL_WEIGHTS = {k: 1.0 / max(n, 1) for k in BACKENDS}

# Normalize weights to configured backends only.
_active = {k: v for k, v in MODEL_WEIGHTS.items() if k in BACKENDS}
_total = sum(_active.values()) or 1.0
MODEL_WEIGHTS = {k: v / _total for k, v in _active.items()}

# ── global state ──────────────────────────────────────────────────────────────

_db: Optional[firestore.Client] = None
_bucket: Optional[storage.Bucket] = None
_http: Optional[httpx.AsyncClient] = None

COLLECTION = "avatar_pipeline_jobs"

MESH_POLL_INTERVAL = 3.0
MESH_POLL_TIMEOUT = 300.0
RIG_POLL_INTERVAL = 3.0
RIG_POLL_TIMEOUT = 180.0


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db, _bucket, _http
    _db = firestore.Client(project=FIRESTORE_PROJECT)
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _http = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=300.0))
    log.info(
        "Controller ready — backends=%s, weights=%s, unirig=%s, skip_rigging=%s",
        list(BACKENDS.keys()), MODEL_WEIGHTS, bool(UNIRIG_URL), SKIP_RIGGING,
    )
    yield
    await _http.aclose()


app = FastAPI(title="avatar-pipeline-controller", lifespan=lifespan)


# ── auth ──────────────────────────────────────────────────────────────────────

def _require_api_key(authorization: str) -> None:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    if authorization[len("Bearer "):].strip() != API_KEY:
        raise HTTPException(status_code=401, detail="invalid api key")


# ── Firestore helpers ─────────────────────────────────────────────────────────

def _set_job(job_id: str, data: dict) -> None:
    _db.collection(COLLECTION).document(job_id).set(
        {**data, "updated_at": datetime.now(timezone.utc)},
        merge=True,
    )


def _get_job(job_id: str) -> dict | None:
    doc = _db.collection(COLLECTION).document(job_id).get()
    return doc.to_dict() if doc.exists else None


# ── model routing ─────────────────────────────────────────────────────────────

def _pick_model(requested: str | None = None) -> str:
    if requested and requested in BACKENDS:
        return requested
    if not MODEL_WEIGHTS:
        raise HTTPException(status_code=503, detail="no model backends configured")
    models = list(MODEL_WEIGHTS.keys())
    weights = [MODEL_WEIGHTS[m] for m in models]
    return random.choices(models, weights=weights, k=1)[0]


# ── pipeline worker ───────────────────────────────────────────────────────────

async def _run_pipeline(
    job_id: str,
    images: list[str],
    body_type: str,
    model_name: str,
) -> None:
    t0 = time.time()
    backend_url = BACKENDS[model_name]

    try:
        # ── Stage 1: Mesh generation ──────────────────────────────────────
        _set_job(job_id, {"status": "running", "stage": "mesh_generation"})
        log.info("[%s] submitting to %s", job_id, model_name)

        resp = await _http.post(
            f"{backend_url}/infer",
            json={"images": images, "body_type": body_type, "job_id": job_id},
            headers={"authorization": f"Bearer {API_KEY}"},
        )
        if resp.status_code != 202:
            detail = resp.json().get("detail", resp.text) if resp.status_code < 500 else resp.text
            raise RuntimeError(f"{model_name} rejected job: {resp.status_code} — {detail}")

        task = resp.json()
        task_id = task["task_id"]
        log.info("[%s] %s accepted — task_id=%s", job_id, model_name, task_id)

        # Poll for mesh completion.
        mesh_gcs_url = await _poll_backend(
            backend_url, task_id, MESH_POLL_INTERVAL, MESH_POLL_TIMEOUT, job_id, "mesh",
        )
        mesh_time = time.time() - t0
        _set_job(job_id, {"mesh_time_ms": int(mesh_time * 1000), "mesh_gcs_url": mesh_gcs_url})
        log.info("[%s] mesh ready in %.1fs — %s", job_id, mesh_time, mesh_gcs_url)

        # ── Stage 2: Auto-rigging (optional) ──────────────────────────────
        rigged_gcs_url = mesh_gcs_url
        if UNIRIG_URL and not SKIP_RIGGING:
            _set_job(job_id, {"stage": "rigging"})
            log.info("[%s] submitting to UniRig", job_id)

            rig_resp = await _http.post(
                f"{UNIRIG_URL}/rig",
                json={
                    "mesh_gcs_url": mesh_gcs_url,
                    "template": "wolf3d_neutral",
                    "blendshapes": True,
                    "job_id": job_id,
                },
                headers={"authorization": f"Bearer {API_KEY}"},
            )
            if rig_resp.status_code == 202:
                rig_task = rig_resp.json()
                rigged_gcs_url = await _poll_backend(
                    UNIRIG_URL, rig_task["task_id"],
                    RIG_POLL_INTERVAL, RIG_POLL_TIMEOUT, job_id, "rig",
                )
                rig_time = time.time() - t0 - mesh_time
                _set_job(job_id, {"rig_time_ms": int(rig_time * 1000)})
                log.info("[%s] rigging done in %.1fs", job_id, rig_time)
            else:
                log.warning("[%s] UniRig rejected (%d) — using unrigged mesh", job_id, rig_resp.status_code)
        else:
            log.info("[%s] skipping rigging (unirig_url=%s, skip=%s)", job_id, bool(UNIRIG_URL), SKIP_RIGGING)

        # ── Stage 3: Copy final GLB to the output bucket ─────────────────
        _set_job(job_id, {"stage": "finalizing"})
        final_url = await _copy_to_output(job_id, rigged_gcs_url)

        total_time = time.time() - t0
        _set_job(job_id, {
            "status": "done",
            "stage": "done",
            "glb_url": final_url,
            "total_time_ms": int(total_time * 1000),
        })
        log.info("[%s] pipeline done in %.1fs — %s", job_id, total_time, final_url)

    except Exception:
        err = traceback.format_exc()
        log.exception("[%s] pipeline failed", job_id)
        _set_job(job_id, {
            "status": "failed",
            "stage": "failed",
            "error": err,
            "total_time_ms": int((time.time() - t0) * 1000),
        })


async def _poll_backend(
    base_url: str,
    task_id: str,
    interval: float,
    timeout: float,
    job_id: str,
    stage_label: str,
) -> str:
    """Poll a backend's /tasks/:id endpoint until done. Returns the GCS URL."""
    deadline = time.time() + timeout
    attempt = 0
    while time.time() < deadline:
        await asyncio.sleep(interval if attempt > 0 else 1.5)
        attempt += 1
        try:
            resp = await _http.get(
                f"{base_url}/tasks/{task_id}",
                headers={"authorization": f"Bearer {API_KEY}"},
            )
        except httpx.RequestError as exc:
            log.warning("[%s] %s poll %d failed: %s", job_id, stage_label, attempt, exc)
            continue

        if resp.status_code == 404:
            raise RuntimeError(f"{stage_label} task {task_id} vanished")
        if resp.status_code != 200:
            continue

        data = resp.json()
        status = data.get("status", "")
        if status == "done":
            url = data.get("result_gcs_url") or data.get("rigged_gcs_url") or data.get("glb_url")
            if not url:
                raise RuntimeError(f"{stage_label} returned done but no URL in response: {data}")
            return url
        if status == "failed":
            raise RuntimeError(data.get("error", f"{stage_label} failed without details"))

    raise RuntimeError(f"{stage_label} timed out after {timeout}s")


async def _copy_to_output(job_id: str, source_gcs_url: str) -> str:
    """Copy a GLB from a backend's GCS path to the controller's output bucket."""
    loop = asyncio.get_event_loop()

    # If the source is already in our output bucket, just return it.
    expected_prefix = f"https://storage.googleapis.com/{GCS_BUCKET}/"
    if source_gcs_url.startswith(expected_prefix):
        return source_gcs_url

    # Download from source and re-upload to output bucket.
    resp = await _http.get(source_gcs_url)
    resp.raise_for_status()
    glb_bytes = resp.content

    blob_name = f"avatars/{job_id}.glb"
    blob = _bucket.blob(blob_name)
    await loop.run_in_executor(
        None,
        lambda: blob.upload_from_string(glb_bytes, content_type="model/gltf-binary"),
    )
    return f"https://storage.googleapis.com/{GCS_BUCKET}/{blob_name}"


# ── routes ────────────────────────────────────────────────────────────────────

class ReconstructRequest(BaseModel):
    images: list[str] = Field(..., min_length=1, max_length=6)
    job_id: str | None = None
    body_type: str = "neutral"
    model: str | None = None


@app.post("/reconstruct", status_code=202)
async def reconstruct(
    body: ReconstructRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(...),
) -> dict:
    _require_api_key(authorization)

    model_name = _pick_model(body.model)
    job_id = body.job_id or str(uuid.uuid4())

    _set_job(job_id, {
        "job_id": job_id,
        "status": "queued",
        "stage": "queued",
        "model": model_name,
        "image_count": len(body.images),
        "body_type": body.body_type,
        "created_at": datetime.now(timezone.utc),
    })

    background_tasks.add_task(_run_pipeline, job_id, body.images, body.body_type, model_name)
    return {"job_id": job_id, "status": "queued", "model": model_name}


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
    return {
        "ok": True,
        "pipeline": "avatar_pipeline_controller_v2",
        "backends": list(BACKENDS.keys()),
        "weights": MODEL_WEIGHTS,
        "unirig": bool(UNIRIG_URL),
        "skip_rigging": SKIP_RIGGING,
    }
