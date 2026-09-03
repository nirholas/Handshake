"""
TRELLIS inference service — single-image to textured 3D mesh via structured
latent representations (Microsoft, MIT license).

API contract (consumed by the Pipeline Controller):
  POST /infer   { images: [data-uri|url, ...], body_type?: str, job_id?: str,
                  seed?: int, quality?: {…}, tier?: str, matte?: bool,
                  rembg_model?: str }
             →  202 { task_id, status: "queued" }

  Multiple images are FUSED as multi-view conditioning of one asset
  (TrellisImageTo3DPipeline.run_multi_image): send turnaround views
  (front/side/back) of the same subject, not unrelated photos.

  tier selects a named quality preset (draft | standard | high | max); an
  explicit `quality` dict still overrides individual fields on top. matte runs
  the subject through the sibling rembg-service first (defaults on for tier=max)
  so the background stops bleeding into the mesh. Both are additive: with no
  tier and no matte the behaviour is byte-for-byte the historical default.

  GET  /tasks/:id → { task_id, status, result_gcs_url?, tier?, matted_views?,
                      quality?, error? }

  GET  /health    → { ok, model, gpu_available, tiers, rembg_matte }

  GET  /          → { service, model, ready, endpoints }. Unauthenticated
                    service descriptor for the platform's warmth probe.

Model weights pre-population:
  pip install huggingface_hub
  huggingface-cli download microsoft/TRELLIS-image-large --local-dir /tmp/trellis-large
  gsutil -m cp -r /tmp/trellis-large gs://three-ws-model-weights/trellis-large/

Environment variables (README.md carries the full table):
  API_KEY               shared bearer secret
  GCS_BUCKET            Cloud Storage bucket for output meshes
  WEIGHTS_DIR           local path to weights (default: /weights/trellis-large)
  WEIGHTS_GCS_URI       optional gs:// tree staged to local disk at startup
  WEIGHTS_LOCAL_DIR     where that staging lands (default: /tmp/trellis-weights)
  MAX_CONCURRENT        max parallel inferences (default: 1)
  REMBG_SERVICE_URL     sibling rembg worker for the matte pre-step
  REMBG_MODEL           default rembg model (default: isnet-general-use)
  REMBG_TIMEOUT_S       matte round-trip budget (default: 90)
  IMAGE_FETCH_TIMEOUT_S per-attempt image fetch timeout (default: 30)
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

import httpx

# TRELLIS reads its attention + sparse-conv backends from the environment at
# import time. The Dockerfile sets these as ENV; default them here too so the
# service still loads correctly if deployed with a bare env. xformers is chosen
# over flash-attn (no source compile) and runs well on the L4.
os.environ.setdefault("ATTN_BACKEND", "xformers")
os.environ.setdefault("SPCONV_ALGO", "native")
from contextlib import asynccontextmanager
from typing import Optional
from urllib.parse import urlsplit

import torch
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks, Response
from google.api_core.exceptions import NotFound
from google.cloud import storage
from PIL import Image
from pydantic import BaseModel, Field

from request_policy import (
    FETCH_ATTEMPTS,
    QUALITY_DEFAULTS,
    TIER_PRESETS,
    call_with_retry,
    clamped_quality,
    matte_enabled,
    normalize_tier,
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
log = logging.getLogger("trellis")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
WEIGHTS_DIR = os.environ.get("WEIGHTS_DIR", "/weights/trellis-large")
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "1"))
# Optional: stage the ~3 GB weight tree from GCS to fast local disk at startup,
# then load from there instead of the Cloud Storage FUSE mount. The FUSE mount
# serves the model's random-access reads over the network, and a cold load
# routinely stalls on it ("stalled read-req cancelled", "context deadline
# exceeded") — turning a ~50s warm load into 15+ minutes, or a hard timeout. The
# storage client streams each object with a plain sequential HTTP GET, which does
# not suffer that stall. When WEIGHTS_GCS_URI is unset, or staging fails for any
# reason, the loader falls back to WEIGHTS_DIR unchanged — this can only add
# reliability, never remove the existing path.
WEIGHTS_GCS_URI = os.environ.get("WEIGHTS_GCS_URI", "")  # e.g. gs://bucket/trellis-large
WEIGHTS_LOCAL_DIR = os.environ.get("WEIGHTS_LOCAL_DIR", "/tmp/trellis-weights")
# Optional sibling background-removal worker (workers/rembg). When set, the
# image path can matte the subject before reconstruction so the background stops
# leaking into the mesh. It shares this worker's bearer secret (both read the
# `avatar-reconstruction-key` Secret Manager value) and writes its cutout PNG to
# the same GCS bucket, served back as a public https URL we re-fetch. Unset, or
# unreachable, the pre-matte is skipped and TRELLIS's own internal preprocessing
# (preprocess_image=True) still removes the background — the pre-matte only ever
# improves the cut, never gates the reconstruction.
REMBG_SERVICE_URL = os.environ.get("REMBG_SERVICE_URL", "").rstrip("/")
REMBG_DEFAULT_MODEL = os.environ.get("REMBG_MODEL", "isnet-general-use")
REMBG_TIMEOUT_S = float(os.environ.get("REMBG_TIMEOUT_S", "90"))
# The model load is retried before it is treated as terminal. Every failure that
# has actually hit this path was transient upstream state (a rate-limited weight
# fetch, a stalled GCS read), not a code fault, so a single exception must not
# decide the fate of the instance. See _load_pipeline_bg for the incident this
# encodes.
MODEL_LOAD_ATTEMPTS = int(os.environ.get("MODEL_LOAD_ATTEMPTS", "4"))
MODEL_LOAD_RETRY_BASE_S = float(os.environ.get("MODEL_LOAD_RETRY_BASE_S", "15"))
MODEL_LOAD_RETRY_CAP_S = float(os.environ.get("MODEL_LOAD_RETRY_CAP_S", "120"))
# TRELLIS's image conditioner (pipeline.json: image_cond_model=dinov2_vitl14_reg)
# is baked into the image here so loading it never reaches the public internet.
DINOV2_LOCAL_DIR = os.environ.get("DINOV2_LOCAL_DIR", "/opt/dinov2")
DINOV2_HUB_REPO = "facebookresearch/dinov2"

_pipeline = None
_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_ready: Optional[asyncio.Event] = None
_load_error: Optional[str] = None
_load_attempts = 0
_dinov2_pinned = False
# In-memory cache only — Cloud Run runs this service across up to _MAX_INSTANCES
# containers with no session affinity, so a POST /infer and a later GET
# /tasks/:id can land on different instances. The durable source of truth is
# the `tasks/{task_id}.json` blob in GCS (see _update_task / get_task); this
# dict just avoids a GCS round-trip when a poll happens to hit the same warm
# instance that ran the job.
_tasks: dict[str, dict] = {}


def _stage_weights_local() -> Optional[str]:
    """Download the weight tree from GCS to local disk with the storage client,
    bypassing the FUSE mount. Returns the local dir on success, or None to signal
    "load from WEIGHTS_DIR as before". Never raises — a staging failure must
    degrade to the existing FUSE-mount load, not crash the loader."""
    if not WEIGHTS_GCS_URI.startswith("gs://"):
        return None
    try:
        from concurrent.futures import ThreadPoolExecutor

        bucket_name, _, prefix = WEIGHTS_GCS_URI[len("gs://"):].partition("/")
        client = storage.Client()
        blobs = [b for b in client.list_blobs(bucket_name, prefix=prefix) if not b.name.endswith("/")]
        if not blobs:
            log.warning("weights staging: no objects under %s; using FUSE mount", WEIGHTS_GCS_URI)
            return None

        def _download(blob) -> int:
            rel = blob.name[len(prefix):].lstrip("/")
            dest = os.path.join(WEIGHTS_LOCAL_DIR, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            # Reuse an already-staged object (same-instance warm restart) when its
            # size matches, so a reload doesn't re-pull 3 GB.
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


def _pin_dinov2_to_local_checkout() -> bool:
    """Resolve TRELLIS's image conditioner from the image-baked dinov2 checkout.

    TRELLIS builds that conditioner with torch.hub.load("facebookresearch/dinov2",
    ...), passing no branch. torch.hub therefore calls github.com on EVERY load
    just to discover the repo's default branch, and it re-raises any non-404 HTTP
    error out of that probe before it ever consults its own cache. Cloud Run
    egresses from shared Google IPs that GitHub rate-limits hard, so that probe
    is a standing outage risk: one "HTTP Error 403: rate limit exceeded" on
    2026-09-02 failed the load, and the latched error then took the default free
    image lane down for 12 hours. The repo and its checkpoint are baked into the
    image (see the Dockerfile), so point torch.hub at the local checkout and drop
    the network dependency entirely.

    Returns False when the checkout is absent, which leaves the historical GitHub
    path exactly as it was: this can only remove a failure mode, never add one.
    """
    global _dinov2_pinned
    if _dinov2_pinned:
        return True
    if not os.path.isfile(os.path.join(DINOV2_LOCAL_DIR, "hubconf.py")):
        log.warning(
            "dinov2 checkout missing at %s; torch.hub will resolve it over the network",
            DINOV2_LOCAL_DIR,
        )
        return False
    original_load = torch.hub.load

    def _load_local_first(repo_or_dir, model, *args, **kwargs):
        if isinstance(repo_or_dir, str) and repo_or_dir.startswith(DINOV2_HUB_REPO):
            kwargs["source"] = "local"
            return original_load(DINOV2_LOCAL_DIR, model, *args, **kwargs)
        return original_load(repo_or_dir, model, *args, **kwargs)

    torch.hub.load = _load_local_first
    _dinov2_pinned = True
    log.info("dinov2 pinned to the local checkout at %s", DINOV2_LOCAL_DIR)
    return True


def _load_pipeline():
    global _pipeline
    from trellis.pipelines import TrellisImageTo3DPipeline

    weights_path = _stage_weights_local() or WEIGHTS_DIR
    log.info("Loading TRELLIS pipeline from %s", weights_path)
    _pipeline = TrellisImageTo3DPipeline.from_pretrained(weights_path)
    # TRELLIS exposes .cuda() (not .to()) to move every sub-model to the GPU.
    _pipeline.cuda()
    log.info("TRELLIS pipeline loaded")


async def _load_pipeline_bg():
    """Load the pipeline off the request path and signal readiness when done.

    Runs the blocking, GPU-bound load in a worker thread so the event loop (and
    the HTTP port) stay live.

    The load is RETRIED with exponential backoff, and _load_error stays unset
    while attempts remain, so a job that arrives mid-retry waits on _ready
    instead of failing against a half-written verdict. Latching the very first
    exception is what turned a single transient 403 into a 12-hour outage on
    2026-09-02: the error was cached in memory, every later task failed against
    it instantly, and minScale=1 kept that dead instance resident and in
    rotation. Only once the whole budget is spent does the error latch, and from
    there /health answers 503 and /infer refuses new work, so the instance is
    reported down and the caller fails over instead of queueing behind a corpse.
    """
    global _load_error, _load_attempts
    loop = asyncio.get_event_loop()
    attempts = max(1, MODEL_LOAD_ATTEMPTS)
    for attempt in range(1, attempts + 1):
        _load_attempts = attempt
        try:
            await loop.run_in_executor(None, _load_pipeline)
            _load_error = None
            _ready.set()
            log.info("TRELLIS pipeline ready (attempt %d)", attempt)
            return
        except Exception as exc:  # noqa: BLE001 - surfaced via /health + task status
            if attempt >= attempts:
                _load_error = safe_error(exc, context="model load")
                log.error("TRELLIS pipeline load FAILED after %d attempt(s): %s", attempt, exc)
                return
            delay = min(MODEL_LOAD_RETRY_BASE_S * (2 ** (attempt - 1)), MODEL_LOAD_RETRY_CAP_S)
            log.warning(
                "TRELLIS pipeline load attempt %d/%d failed (%s); retrying in %.0fs",
                attempt, attempts, exc, delay,
            )
            await asyncio.sleep(delay)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem, _ready
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    _ready = asyncio.Event()
    # Load the ~3 GB pipeline in the BACKGROUND and yield immediately. uvicorn
    # runs the ASGI lifespan BEFORE it binds the socket, so a blocking load here
    # would delay the port past Cloud Run's startup TCP-probe window (the model
    # load + GPU transfer runs minutes on a cold instance) and the revision would
    # be marked failed. Backgrounding lets the port open at once; requests that
    # arrive before the load completes wait on _ready (see _run_inference).
    _pin_dinov2_to_local_checkout()
    asyncio.create_task(_load_pipeline_bg())
    log.info("Service starting — pipeline loading in background (max_concurrent=%d)", MAX_CONCURRENT)
    yield


app = FastAPI(title="model-trellis", lifespan=lifespan)


def _require_api_key(authorization: str) -> None:
    try:
        require_api_key(authorization, API_KEY)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


class ImageSourceError(ValueError):
    """A caller-supplied image could not be read.

    Distinct from an internal failure: the cause is the request's own `images`
    entry (unreachable host, rejected target, undecodable bytes), so the message
    is safe and useful to hand back verbatim instead of an opaque error ref.
    """


IMAGE_FETCH_TIMEOUT_S = float(os.environ.get("IMAGE_FETCH_TIMEOUT_S", "30"))


def _source_label(src: str) -> str:
    """Short, non-leaking identifier for an image source, for error messages."""
    if src.startswith("data:image"):
        return "inline data uri"
    host = urlsplit(src).hostname
    return host or src[:60]


def _fetch_image_bytes(src: str) -> bytes:
    """Fetch one https image source, retrying transient network failures.

    A single read timeout against a public image host used to fail the entire
    generation (observed live 2026-08-10). The fetch itself stays SSRF-hardened:
    https-only, private/loopback/link-local/metadata IPs rejected after DNS
    resolution, redirects re-validated per hop, response size bounded.
    """
    label = _source_label(src)

    def attempt() -> bytes:
        return fetch_remote_bytes(src, timeout=IMAGE_FETCH_TIMEOUT_S)

    def note_retry(number: int, delay: float, exc: BaseException) -> None:
        log.warning(
            "image fetch attempt %d/%d for %s failed (%s); retrying in %.1fs",
            number, FETCH_ATTEMPTS, label, type(exc).__name__, delay,
        )

    try:
        return call_with_retry(attempt, sleep=time.sleep, on_retry=note_retry)
    except UnsafeUrlError as exc:
        raise ImageSourceError(f"refused to fetch image source ({label}): {exc}") from exc
    except httpx.HTTPStatusError as exc:
        raise ImageSourceError(
            f"image source {label} returned HTTP {exc.response.status_code}"
        ) from exc
    except httpx.HTTPError as exc:
        raise ImageSourceError(
            f"image source {label} unreachable after {FETCH_ATTEMPTS} attempts "
            f"({type(exc).__name__}); check the URL is publicly readable"
        ) from exc
    except ValueError as exc:
        # The guard's own size ceiling. Caught after UnsafeUrlError (a ValueError
        # subclass) so the more specific message wins.
        raise ImageSourceError(f"image source {label} rejected: {exc}") from exc


def _decode_image(src: str, keep_alpha: bool = False) -> Image.Image:
    # keep_alpha=True preserves an RGBA cutout's transparency so TRELLIS uses the
    # supplied alpha as the subject mask (its preprocess_image path respects an
    # existing alpha channel and only falls back to internal rembg for RGB). The
    # text/free lane keeps the historical RGB decode.
    mode = "RGBA" if keep_alpha else "RGB"
    if src.startswith("data:image"):
        b64 = src.split(",", 1)[1]
        try:
            raw = base64.b64decode(b64)
        except Exception as exc:  # noqa: BLE001 - caller's own payload, report it as such
            raise ImageSourceError(f"inline data uri is not valid base64: {exc}") from exc
        return _open_image(raw, mode, "inline data uri")
    if src.startswith("https://"):
        return _open_image(_fetch_image_bytes(src), mode, _source_label(src))
    raise ImageSourceError(f"unsupported image source: {src[:60]}")


def _open_image(data: bytes, mode: str, label: str) -> Image.Image:
    try:
        return Image.open(io.BytesIO(data)).convert(mode)
    except Exception as exc:  # noqa: BLE001 - undecodable caller input, not an internal fault
        raise ImageSourceError(
            f"image source {label} is not a decodable image ({type(exc).__name__})"
        ) from exc


async def _matte_via_rembg(src: str, model: str) -> tuple[str, bool]:
    """Send one image to the sibling rembg-service, poll it to completion, and
    return (cutout_https_url, True). On any failure return (src, False) so the
    caller reconstructs from the original image — matting is a fidelity boost,
    never a hard dependency. Never raises."""
    if not REMBG_SERVICE_URL:
        return src, False
    headers = {"Authorization": f"Bearer {API_KEY}"}
    deadline = time.time() + REMBG_TIMEOUT_S
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{REMBG_SERVICE_URL}/remove",
                headers=headers,
                json={"image": src, "model": model},
            )
            resp.raise_for_status()
            task_id = resp.json()["task_id"]
            while time.time() < deadline:
                await asyncio.sleep(2)
                poll = await client.get(
                    f"{REMBG_SERVICE_URL}/tasks/{task_id}", headers=headers
                )
                poll.raise_for_status()
                state = poll.json()
                status = state.get("status")
                if status == "done":
                    url = state.get("result_url")
                    if url:
                        log.info("rembg matte ok -> %s", url)
                        return url, True
                    return src, False
                if status == "failed":
                    log.warning("rembg matte failed (%s); using original image", state.get("error"))
                    return src, False
    except Exception as exc:  # noqa: BLE001 — degrade to the un-matted image
        log.warning("rembg matte error (%s); using original image", exc)
    return src, False


def _task_blob(task_id: str):
    return _bucket.blob(f"tasks/{task_id}.json")


async def _update_task(task_id: str, **fields) -> dict:
    """Merge `fields` into the task, then persist to GCS as the source of truth
    (see the comment on `_tasks`)."""
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
# longest real generation with margin; expiring it turns an endless client
# poll into a designed failure the router's poll-time failover can act on.
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


# Quality tiers, clamps, and the matte default live in request_policy.py so the
# decision logic that shapes every generation can be unit tested without torch,
# CUDA, or the TRELLIS source tree (see test_request_policy.py).


async def _run_inference(
    task_id: str,
    images: list[str],
    body_type: str,
    quality: dict | None = None,
    seed: int | None = None,
    tier: str | None = None,
    matte: bool | None = None,
    rembg_model: str | None = None,
) -> None:
    # Wait for the background pipeline load before touching the GPU. Warm
    # instances pass instantly; a cold one waits out the load rather than
    # NoneType-crashing. A failed load surfaces as a designed task error.
    if _load_error:
        await _update_task(task_id, status="failed", error=f"pipeline unavailable: {_load_error}")
        return
    try:
        await asyncio.wait_for(_ready.wait(), timeout=600)
    except asyncio.TimeoutError:
        await _update_task(task_id, status="failed", error="pipeline not ready (model load timed out)")
        return
    if _load_error:
        await _update_task(task_id, status="failed", error=f"pipeline unavailable: {_load_error}")
        return

    q = clamped_quality(quality, tier)
    # Matting defaults on for the MAX tier (paired for maximum fidelity) and off
    # everywhere else, preserving the free/default lane. An explicit `matte`
    # value always wins. It only actually runs when REMBG_SERVICE_URL is set.
    tier_key = normalize_tier(tier)
    do_matte = matte_enabled(matte, tier_key)

    async with _sem:
        await _update_task(task_id, status="running")
        loop = asyncio.get_event_loop()
        t0 = time.time()
        try:
            matted_count = 0
            sources = list(images)
            if do_matte and REMBG_SERVICE_URL:
                model = rembg_model or REMBG_DEFAULT_MODEL
                imgs = []
                for src in sources:
                    cutout, ok = await _matte_via_rembg(src, model)
                    if ok:
                        # A successful cutout decodes as RGBA so its alpha is the
                        # subject mask.
                        try:
                            imgs.append(
                                await loop.run_in_executor(None, _decode_image, cutout, True)
                            )
                            matted_count += 1
                            continue
                        except ImageSourceError as exc:
                            # Matting is a fidelity boost, never a gate. If the
                            # cutout cannot be read back, reconstruct from the
                            # image the caller actually sent.
                            log.warning(
                                "matted cutout unreadable (%s); using the original image", exc
                            )
                    imgs.append(await loop.run_in_executor(None, _decode_image, src))
            else:
                imgs = [await loop.run_in_executor(None, _decode_image, src) for src in sources]

            def _generate():
                # GLB export lives in trellis.utils.postprocessing_utils.to_glb —
                # it fuses the Gaussian appearance onto the extracted mesh and bakes
                # a texture. It is NOT a pipeline method (the pipeline only .run()s
                # the structured-latent generation).
                from trellis.utils import postprocessing_utils

                sampler_kwargs = dict(
                    seed=seed if seed is not None else 42,
                    formats=["gaussian", "mesh"],
                    preprocess_image=True,
                    sparse_structure_sampler_params={"steps": q["ss_steps"], "cfg_strength": q["ss_cfg"]},
                    slat_sampler_params={"steps": q["slat_steps"], "cfg_strength": q["slat_cfg"]},
                )
                if len(imgs) > 1:
                    # Turnaround views of one subject fuse into a single asset:
                    # geometry the primary view can't see (backs, sides) stops
                    # being hallucinated. 'stochastic' is upstream's default and
                    # the cheaper of the two fusion modes.
                    outputs = _pipeline.run_multi_image(imgs, mode="stochastic", **sampler_kwargs)
                else:
                    outputs = _pipeline.run(imgs[0], **sampler_kwargs)
                glb = postprocessing_utils.to_glb(
                    outputs["gaussian"][0],
                    outputs["mesh"][0],
                    simplify=q["simplify"],
                    texture_size=q["texture_size"],
                )
                return glb.export(file_type="glb")

            glb_bytes = await loop.run_in_executor(None, _generate)

            blob_name = f"raw-meshes/trellis/{task_id}.glb"
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
                views_used=len(imgs),
                tier=tier_key or "default",
                matted_views=matted_count,
                quality=q,
                elapsed_ms=int(elapsed * 1000),
            )
            log.info(
                "[%s] done in %.1fs (tier=%s matted=%d q=%s) — %d bytes -> %s",
                task_id, elapsed, tier_key or "default", matted_count, q, len(glb_bytes), gcs_url,
            )

        except ImageSourceError as exc:
            # The request's own `images` entry is at fault, so hand the reason
            # back verbatim: an opaque error ref would tell the caller nothing
            # and leaves the router retrying a URL that can never work.
            log.warning("[%s] image source rejected: %s", task_id, exc)
            await _update_task(
                task_id,
                status="failed",
                error=str(exc),
                elapsed_ms=int((time.time() - t0) * 1000),
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
    body_type: str = "neutral"
    job_id: str | None = None
    # Optional per-request override of the resolved tier (ss_steps, slat_steps,
    # ss_cfg, slat_cfg, simplify, texture_size), see request_policy. Omitted
    # or partial fields fall back to the platform quality-bar defaults.
    quality: dict | None = None
    # Named quality tier: draft | standard | high | max. Seeds the base quality
    # preset; an explicit `quality` dict still overrides individual fields. Omitted
    # keeps the historical default (equivalent to "high").
    tier: str | None = None
    # Run the subject through the sibling rembg-service before reconstruction.
    # Omitted defaults on for tier="max", off otherwise. A matted (RGBA) cutout
    # reconstructs with far less background bleed. Requires REMBG_SERVICE_URL.
    matte: bool | None = None
    # rembg model for the pre-matte: isnet-general-use (default), u2net,
    # u2net_human_seg (better for people/portraits), or silueta.
    rembg_model: str | None = None
    # Deterministic sampling seed; omitted keeps the historical default (42).
    seed: int | None = None


@app.post("/infer", status_code=202)
async def infer(
    body: InferRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(...),
) -> dict:
    _require_api_key(authorization)
    # A latched load failure means this instance can never serve this job, so
    # refuse it at submit time. 503 is what the caller's lane failover reads
    # (api/forge.js isUpstreamUnavailable -> markLaneUnhealthy), which routes the
    # request to another backend. Accepting the job and only failing it minutes
    # later during polling bypasses that failover entirely: it is how 70
    # generations went terminal in the 24 h to 2026-09-03 while the catalog and
    # the health report both still called this lane healthy.
    if _load_error:
        raise HTTPException(
            status_code=503,
            detail=f"pipeline unavailable: {_load_error}",
        )
    task_id = str(uuid.uuid4())
    # Persist the "queued" record before responding — a poll can reach a
    # different instance than this one the moment the 202 lands, and that
    # instance has nothing in its local `_tasks` dict to fall back on.
    await _update_task(task_id, status="queued", model="trellis-large")
    background_tasks.add_task(
        _run_inference,
        task_id,
        body.images,
        body.body_type,
        body.quality,
        body.seed,
        body.tier,
        body.matte,
        body.rembg_model,
    )
    return {"task_id": task_id, "status": "queued"}


@app.get("/tasks/{task_id}")
async def get_task(task_id: str, authorization: str = Header(...)) -> dict:
    _require_api_key(authorization)
    return await _resolve_task(task_id)


@app.get("/")
async def root() -> dict:
    """Service descriptor, and the answer to the platform's warmth ping.

    api/cron/gpu-keepwarm.js holds a scale-to-zero lane resident with an
    authenticated GET against the worker root and treats any status below 500 as
    "the container is up". With no route here that ping, and every other probe
    that ever hit the root, logged a 404 at WARNING severity: 257 of them in the
    24 h to 2026-08-11, against exactly two real error events, so the noise
    buried the signal. Answering 200 costs nothing and keeps the log honest.
    Routing itself reads /health, which carries the load state this cannot.
    Unauthenticated, exposing exactly what /health already does.
    """
    return {
        "service": "model-trellis",
        "model": "trellis-image-large",
        "ready": bool(_ready and _ready.is_set()),
        "endpoints": ["POST /infer", "GET /tasks/{task_id}", "GET /health"],
    }


@app.get("/health")
async def health(response: Response) -> dict:
    """Readiness, answered honestly.

    This used to return ok:true unconditionally, including while the pipeline
    was permanently dead, so nothing upstream could tell a working instance from
    a poisoned one. A spent load budget now answers 503: the platform health
    probe reads that as down (api/_lib/forge-health.js), and a Cloud Run liveness
    probe pointed here recycles the container instead of leaving it resident.
    A load still in progress stays 200 so an ordinary cold start is never killed
    mid-load.
    """
    dead = _load_error is not None
    if dead:
        response.status_code = 503
    return {
        "ok": not dead,
        "model": "trellis-image-large",
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "pipeline_loaded": _pipeline is not None,
        "ready": bool(_ready and _ready.is_set()),
        "load_error": _load_error,
        "load_attempts": _load_attempts,
        "tiers": list(TIER_PRESETS),
        "default_quality": QUALITY_DEFAULTS,
        "rembg_matte": bool(REMBG_SERVICE_URL),
    }
