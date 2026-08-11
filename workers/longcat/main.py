"""
LongCat Video Avatar service: audio-driven talking avatar video generation.

  POST /generate  { image_url, audio_url, prompt?, job_id? }
               ->  202 { job_id, status: "queued" }

  GET  /jobs/:id  -> { job_id, status, progress?, segments?, audio_seconds?,
                      video_url?, error?, updated_at }

  GET  /health    -> { ok, model_loaded, missing_weights, resolution, ... }

Environment variables (all required unless noted):
  API_KEY             shared bearer secret (set via GCP Secret Manager)
  GCS_BUCKET          Cloud Storage bucket for output MP4s
  FIRESTORE_PROJECT   GCP project hosting Firestore
  WEIGHTS_DIR         root holding both LongCat repos (default: /weights/longcat,
                      see model_weights.py for the required layout)
  LONGCAT_REPO_DIR    path to cloned LongCat repo (default: /longcat)
  MAX_CONCURRENT      parallel inference jobs (default: 1; GPU-bound)
  MAX_SEGMENTS        cap on generated segments (default: 8, about 26 s of video)
  RESOLUTION          480p or 720p (default: 720p)
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException, Header
from google.cloud import firestore, storage
from pydantic import BaseModel

import model_weights
from inference_plan import (
    ProgressTracker,
    segment_span_seconds,
    segments_for_audio,
    select_output_video,
)
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
log = logging.getLogger("main")

# ── config ─────────────────────────────────────────────────────────────────────

API_KEY           = os.environ["API_KEY"]
GCS_BUCKET        = os.environ["GCS_BUCKET"]
FIRESTORE_PROJECT = os.environ["FIRESTORE_PROJECT"]
WEIGHTS_DIR       = Path(os.environ.get("WEIGHTS_DIR", "/weights/longcat"))
LONGCAT_REPO_DIR  = Path(os.environ.get("LONGCAT_REPO_DIR", "/longcat"))
MAX_CONCURRENT    = max(1, int(os.environ.get("MAX_CONCURRENT", "1")))
MAX_SEGMENTS      = max(1, int(os.environ.get("MAX_SEGMENTS", "8")))
RESOLUTION        = os.environ.get("RESOLUTION", "720p")

# Upstream's argparse restricts --resolution to these two. Catching a typo here
# turns a 40-minute-late CUDA crash into a boot failure the deploy can see.
SUPPORTED_RESOLUTIONS = ("480p", "720p")
if RESOLUTION not in SUPPORTED_RESOLUTIONS:
    raise RuntimeError(
        f"RESOLUTION={RESOLUTION!r} is not supported; expected one of {SUPPORTED_RESOLUTIONS}"
    )

CHECKPOINT_DIR = model_weights.avatar_dir(WEIGHTS_DIR)
BASE_MODEL_DIR = model_weights.base_dir(WEIGHTS_DIR)

INFERENCE_SCRIPT = "run_demo_avatar_single_audio_to_video.py"


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
    # follow_redirects MUST stay False: redirect hops are re-validated against
    # the SSRF allow-rules by fetch_remote_bytes_async, not by httpx.
    _http    = httpx.AsyncClient(follow_redirects=False, timeout=300)

    _db     = firestore.Client(project=FIRESTORE_PROJECT)
    _bucket = storage.Client().bucket(GCS_BUCKET)

    missing = model_weights.missing_paths(WEIGHTS_DIR)
    if missing:
        # Deliberately not downloading here. The required set is ~45 GB across
        # two HuggingFace repos; pulling it inside the startup hook guarantees a
        # startup-probe timeout and re-pulls on every cold start. Weights are
        # staged into the GCS weights bucket once (stage-weights.sh) and mounted.
        log.error(
            "Model weights incomplete under %s: /generate will answer 503. Missing: %s. "
            "Stage them with workers/longcat/stage-weights.sh.",
            WEIGHTS_DIR,
            model_weights.describe_missing(missing),
        )
    else:
        log.info("Model weights complete under %s", WEIGHTS_DIR)

    log.info(
        "Server ready: resolution=%s, max_concurrent=%d, max_segments=%d, weights=%s",
        RESOLUTION, MAX_CONCURRENT, MAX_SEGMENTS, WEIGHTS_DIR,
    )
    yield

    await _http.aclose()


app = FastAPI(title="longcat-video-avatar", lifespan=lifespan)


# ── auth ───────────────────────────────────────────────────────────────────────

def _require_api_key(authorization: str | None) -> None:
    try:
        require_api_key(authorization, API_KEY)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


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

def _probe_audio_seconds(path: Path) -> float | None:
    """Duration of ``path`` per ffprobe, or None when it cannot be determined."""
    try:
        completed = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )
        return float(completed.stdout.strip())
    except (subprocess.SubprocessError, OSError, ValueError) as exc:
        # OSError covers a missing ffprobe binary. Sizing falls back to a single
        # segment, which is upstream's default: a shorter video beats a dead job.
        log.warning("ffprobe could not read a duration from %s: %s", path, exc)
        return None


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

            # One segment covers 3.72 s. Sizing from the real audio length is
            # what stops a 20-second voice clip rendering as a 4-second video.
            audio_seconds = await asyncio.get_event_loop().run_in_executor(
                None, lambda: _probe_audio_seconds(audio_path)
            )
            segments = segments_for_audio(audio_seconds, MAX_SEGMENTS)
            log.info(
                "[%s] audio=%.2fs → %d segment(s) covering %.2fs",
                job_id,
                audio_seconds if audio_seconds is not None else -1.0,
                segments,
                segment_span_seconds(segments),
            )
            _set_job(job_id, {"audio_seconds": audio_seconds, "segments": segments})

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
                lambda: _run_inference(job_id, config_path, output_dir, segments),
            )

            names = sorted(
                p.relative_to(output_dir).as_posix() for p in output_dir.rglob("*.mp4")
            )
            chosen = select_output_video(names)
            if chosen is None:
                raise RuntimeError(
                    f"inference produced no final MP4 (saw {len(names)} candidate file(s))"
                )
            mp4_path = output_dir / chosen

            log.info(
                "[%s] uploading %s (%d bytes) to GCS",
                job_id, chosen, mp4_path.stat().st_size,
            )
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

        except Exception as exc:
            _set_job(job_id, {
                "status": "failed",
                "error": safe_error(exc, context=f"[{job_id}] pipeline"),
            })

        finally:
            shutil.rmtree(workdir, ignore_errors=True)


def _run_inference(
    job_id: str,
    config_path: Path,
    output_dir: Path,
    segments: int,
) -> None:
    cmd = [
        "torchrun",
        "--nproc_per_node=1",
        INFERENCE_SCRIPT,
        "--input_json",    str(config_path),
        "--output_dir",    str(output_dir),
        "--checkpoint_dir", str(CHECKPOINT_DIR),
        "--resolution",    RESOLUTION,
        "--model_type",    "avatar-v1.5",
        # ai2v is audio-image-to-video: it consumes config.cond_image. at2v
        # ignores the reference image entirely, which is never what this service
        # wants. Upstream's default happens to be ai2v; pin it so an upstream
        # default change cannot silently drop the caller's avatar.
        "--stage_1",       "ai2v",
        "--num_segments",  str(segments),
        "--use_distill",
        "--use_int8",
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
    tracker = ProgressTracker(expected_segments=segments)

    for raw_line in process.stdout:
        line = raw_line.rstrip()
        stdout_lines.append(line)
        # Keep only enough tail for a failure report; a multi-segment 720p run
        # emits tens of thousands of tqdm lines.
        if len(stdout_lines) > 200:
            del stdout_lines[:100]
        log.info("[%s] %s", job_id, line)

        progress = tracker.update(line)
        if progress is not None:
            _set_job(job_id, {"progress": progress})

    process.wait()
    if process.returncode != 0:
        tail = "\n".join(stdout_lines[-100:])
        raise RuntimeError(
            f"torchrun failed (exit {process.returncode}):\n{tail}"
        )


async def _download_file(url: str, dest: Path) -> None:
    if url.startswith("data:"):
        # Inline data URI: decode base64 directly, no HTTP request needed.
        try:
            _, encoded = url.split(",", 1)
            dest.write_bytes(base64.b64decode(encoded))
        except Exception as exc:
            raise RuntimeError(f"failed to decode data URI: {exc}") from exc
        return
    # SSRF-hardened: https-only, private/loopback/link-local/metadata IPs are
    # rejected after DNS resolution, redirects are re-validated per hop, and the
    # response is size-bounded.
    try:
        data = await fetch_remote_bytes_async(_http, url)
    except UnsafeUrlError as exc:
        raise RuntimeError(f"refused to fetch url: {exc}") from exc
    dest.write_bytes(data)


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
    authorization: str | None = Header(default=None),
) -> dict:
    _require_api_key(authorization)

    # Fail fast and loudly instead of queueing a job that will spend two minutes
    # loading models and then die on a missing checkpoint.
    missing = model_weights.missing_paths(WEIGHTS_DIR)
    if missing:
        log.error(
            "rejecting /generate: weights incomplete under %s (%s)",
            WEIGHTS_DIR, model_weights.describe_missing(missing),
        )
        raise HTTPException(
            status_code=503,
            detail="model weights are not staged on this instance",
        )

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
async def get_job(
    job_id: str,
    authorization: str | None = Header(default=None),
) -> dict:
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
    missing = model_weights.missing_paths(WEIGHTS_DIR)
    return {
        "ok": True,
        "pipeline": "longcat-avatar-1.5",
        "model_loaded": not missing,
        "missing_weights": [str(path) for path in missing],
        "weights_dir": str(WEIGHTS_DIR),
        "checkpoint_dir": str(CHECKPOINT_DIR),
        "base_model_dir": str(BASE_MODEL_DIR),
        "resolution": RESOLUTION,
        "max_segments": MAX_SEGMENTS,
    }
