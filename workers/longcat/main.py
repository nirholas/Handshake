"""
LongCat Video Avatar service — audio-driven talking avatar video generation.

  POST /generate  { image_url, audio_url, prompt?, job_id? }
               →  202 { job_id, status: "queued" }

  GET  /jobs/:id  → { job_id, status, progress?, video_url?, error?, updated_at }

  GET  /health    → { ok, model_loaded }

Environment variables (all required unless noted):
  API_KEY           — shared bearer secret (set via GCP Secret Manager)
  GCS_BUCKET        — Cloud Storage bucket for output MP4s
  FIRESTORE_PROJECT — GCP project hosting Firestore
  WEIGHTS_DIR       — path to LongCat model weights (default: /weights)
  LONGCAT_REPO_DIR  — path to cloned LongCat repo (default: /longcat)
  MAX_CONCURRENT    — parallel inference jobs (default: 1; GPU-bound)
  RESOLUTION        — 480p or 720p (default: 720p)
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import traceback
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException, Header
from google.cloud import firestore, storage
from pydantic import BaseModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("main")

# ── config ─────────────────────────────────────────────────────────────────────

API_KEY           = os.environ["API_KEY"]
GCS_BUCKET        = os.environ["GCS_BUCKET"]
FIRESTORE_PROJECT = os.environ["FIRESTORE_PROJECT"]
WEIGHTS_DIR       = Path(os.environ.get("WEIGHTS_DIR", "/weights"))
LONGCAT_REPO_DIR  = Path(os.environ.get("LONGCAT_REPO_DIR", "/longcat"))
MAX_CONCURRENT    = int(os.environ.get("MAX_CONCURRENT", "1"))
RESOLUTION        = os.environ.get("RESOLUTION", "720p")

WEIGHTS_SUBDIR    = WEIGHTS_DIR / "LongCat-Video-Avatar"

# Progress line patterns, tried in order. Each yields a 0–1 float.
# Covers tqdm bars ("42%|"), "frame X/Y", "step X/Y", and bare "X%".
_PROGRESS_PATTERNS: list[tuple[re.Pattern, callable]] = [
    # tqdm: "42%|████..." or "42it [" (no denominator → skip)
    (re.compile(r'^\s*(\d+)%\|'), lambda m: float(m.group(1)) / 100),
    # "frame(s) X / Y" or "frame X/Y"
    (re.compile(r'frames?\s+(\d+)\s*/\s*(\d+)', re.IGNORECASE),
     lambda m: int(m.group(1)) / int(m.group(2)) if int(m.group(2)) > 0 else None),
    # "step(s) X / Y"
    (re.compile(r'steps?\s+(\d+)\s*/\s*(\d+)', re.IGNORECASE),
     lambda m: int(m.group(1)) / int(m.group(2)) if int(m.group(2)) > 0 else None),
    # bare percentage anywhere in the line
    (re.compile(r'\b(\d{1,3})%'), lambda m: min(float(m.group(1)) / 100, 1.0)),
]


def _parse_progress(line: str) -> float | None:
    for pattern, extractor in _PROGRESS_PATTERNS:
        m = pattern.search(line)
        if m:
            try:
                val = extractor(m)
                if val is not None and 0.0 <= val <= 1.0:
                    return val
            except (ZeroDivisionError, ValueError):
                continue
    return None


# ── global state ───────────────────────────────────────────────────────────────

_db:      firestore.Client | None = None
_bucket:  storage.Bucket   | None = None
_job_sem: asyncio.Semaphore | None = None
_http:    httpx.AsyncClient | None = None


# ── lifespan ───────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db, _bucket, _job_sem, _http

    _job_sem = asyncio.Semaphore(MAX_CONCURRENT)
    _http    = httpx.AsyncClient(follow_redirects=True, timeout=300)

    _db     = firestore.Client(project=FIRESTORE_PROJECT)
    _bucket = storage.Client().bucket(GCS_BUCKET)

    if not WEIGHTS_SUBDIR.exists():
        log.warning(
            "Model weights not found at %s — downloading from HuggingFace Hub...",
            WEIGHTS_SUBDIR,
        )
        _download_weights()
    else:
        log.info("Model weights found at %s", WEIGHTS_SUBDIR)

    log.info(
        "Server ready — resolution=%s, max_concurrent=%d, weights=%s",
        RESOLUTION, MAX_CONCURRENT, WEIGHTS_SUBDIR,
    )
    yield

    await _http.aclose()


def _download_weights() -> None:
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "python", "-c",
            (
                "from huggingface_hub import snapshot_download; "
                "snapshot_download("
                "  'meituan-longcat/LongCat-Video-Avatar-1.5',"
                f"  local_dir='{WEIGHTS_SUBDIR}',"
                "  ignore_patterns=['*.pt']"
                ")"
            ),
        ],
        check=True,
    )
    log.info("Weights downloaded to %s", WEIGHTS_SUBDIR)


app = FastAPI(title="longcat-video-avatar", lifespan=lifespan)


# ── auth ───────────────────────────────────────────────────────────────────────

def _require_api_key(authorization: str) -> None:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    if authorization[len("Bearer "):].strip() != API_KEY:
        raise HTTPException(status_code=401, detail="invalid api key")


# ── Firestore helpers ──────────────────────────────────────────────────────────

def _set_job(job_id: str, data: dict) -> None:
    _db.collection("longcat_video_jobs").document(job_id).set(
        {**data, "updated_at": datetime.now(timezone.utc)},
        merge=True,
    )


def _get_job(job_id: str) -> dict | None:
    doc = _db.collection("longcat_video_jobs").document(job_id).get()
    return doc.to_dict() if doc.exists else None


# ── inference worker ───────────────────────────────────────────────────────────

async def _process_job(
    job_id: str,
    image_url: str,
    audio_url: str,
    prompt: str,
) -> None:
    async with _job_sem:
        _set_job(job_id, {"status": "running", "progress": 0.0})
        workdir = Path(tempfile.mkdtemp(prefix=f"longcat_{job_id}_"))
        try:
            log.info("[%s] downloading inputs", job_id)

            image_path = workdir / "ref_image.png"
            audio_path = workdir / "audio.wav"
            output_dir = workdir / "output"
            output_dir.mkdir()

            await _download_file(image_url, image_path)
            await _download_file(audio_url, audio_path)

            config = {
                "prompt": prompt,
                "cond_image": str(image_path),
                "cond_audio": {"person1": str(audio_path)},
            }
            config_path = workdir / "config.json"
            config_path.write_text(json.dumps(config))

            log.info("[%s] starting inference", job_id)
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: _run_inference(job_id, config_path, output_dir),
            )

            # Find the generated MP4
            mp4_files = list(output_dir.glob("**/*.mp4"))
            if not mp4_files:
                raise RuntimeError("No MP4 output found after inference")
            mp4_path = mp4_files[0]

            log.info("[%s] uploading %d bytes to GCS", job_id, mp4_path.stat().st_size)
            blob_name = f"avatar-videos/{job_id}.mp4"
            blob = _bucket.blob(blob_name)
            blob.content_type = "video/mp4"
            await loop.run_in_executor(
                None,
                lambda: blob.upload_from_filename(str(mp4_path)),
            )
            video_url = f"https://storage.googleapis.com/{GCS_BUCKET}/{blob_name}"

            _set_job(job_id, {"status": "done", "progress": 1.0, "video_url": video_url})
            log.info("[%s] done → %s", job_id, video_url)

        except Exception:
            err = traceback.format_exc()
            log.exception("[%s] pipeline failed", job_id)
            _set_job(job_id, {"status": "failed", "error": err})

        finally:
            shutil.rmtree(workdir, ignore_errors=True)


def _run_inference(job_id: str, config_path: Path, output_dir: Path) -> None:
    cmd = [
        "torchrun",
        "--nproc_per_node=1",
        "run_demo_avatar_single_audio_to_video.py",
        "--input_json",    str(config_path),
        "--output_dir",    str(output_dir),
        "--checkpoint_dir", str(WEIGHTS_SUBDIR),
        "--resolution",    RESOLUTION,
        "--model_type",    "avatar-v1.5",
        "--use_distill",
        "--use_int8",
        "--num_inference_steps", "8",
    ]
    log.info("[%s] cmd: %s", job_id, " ".join(cmd))

    # Stream stdout+stderr so we can parse progress in real time.
    process = subprocess.Popen(
        cmd,
        cwd=str(LONGCAT_REPO_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    stdout_lines: list[str] = []
    last_progress: float | None = None

    for raw_line in process.stdout:
        line = raw_line.rstrip()
        stdout_lines.append(line)
        log.info("[%s] %s", job_id, line)

        progress = _parse_progress(line)
        if progress is not None and progress != last_progress:
            last_progress = progress
            _set_job(job_id, {"progress": progress})

    process.wait()
    if process.returncode != 0:
        tail = "\n".join(stdout_lines[-100:])
        raise RuntimeError(
            f"torchrun failed (exit {process.returncode}):\n{tail}"
        )


async def _download_file(url: str, dest: Path) -> None:
    if url.startswith("data:"):
        # Inline data URI — decode base64 directly, no HTTP request needed.
        try:
            _, encoded = url.split(",", 1)
            dest.write_bytes(base64.b64decode(encoded))
        except Exception as exc:
            raise RuntimeError(f"failed to decode data URI: {exc}") from exc
        return
    async with _http.stream("GET", url) as r:
        r.raise_for_status()
        with dest.open("wb") as f:
            async for chunk in r.aiter_bytes(65536):
                f.write(chunk)


# ── routes ─────────────────────────────────────────────────────────────────────

class GenerateRequest(BaseModel):
    image_url: str
    audio_url: str
    prompt: str = "A person talking naturally."
    job_id: str | None = None


@app.post("/generate", status_code=202)
async def generate(
    body: GenerateRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(...),
) -> dict:
    _require_api_key(authorization)
    job_id = body.job_id or str(uuid.uuid4())
    _set_job(job_id, {
        "job_id":    job_id,
        "status":    "queued",
        "progress":  None,
        "image_url": body.image_url,
        "audio_url": body.audio_url,
        "prompt":    body.prompt,
        "created_at": datetime.now(timezone.utc),
    })
    background_tasks.add_task(
        _process_job, job_id, body.image_url, body.audio_url, body.prompt,
    )
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
    return {
        "ok": True,
        "pipeline": "longcat-avatar-1.5",
        "model_loaded": WEIGHTS_SUBDIR.exists(),
        "weights_dir": str(WEIGHTS_SUBDIR),
        "resolution": RESOLUTION,
    }
