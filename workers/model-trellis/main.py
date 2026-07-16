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

Model weights pre-population:
  pip install huggingface_hub
  huggingface-cli download microsoft/TRELLIS-image-large --local-dir /tmp/trellis-large
  gsutil -m cp -r /tmp/trellis-large gs://three-ws-model-weights/trellis-large/

Environment variables:
  API_KEY           — shared bearer secret
  GCS_BUCKET        — Cloud Storage bucket for output meshes
  WEIGHTS_DIR       — local path to model weights (default: /weights/trellis-large)
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

import httpx

# TRELLIS reads its attention + sparse-conv backends from the environment at
# import time. The Dockerfile sets these as ENV; default them here too so the
# service still loads correctly if deployed with a bare env. xformers is chosen
# over flash-attn (no source compile) and runs well on the L4.
os.environ.setdefault("ATTN_BACKEND", "xformers")
os.environ.setdefault("SPCONV_ALGO", "native")
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

_pipeline = None
_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_ready: Optional[asyncio.Event] = None
_load_error: Optional[str] = None
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
    the HTTP port) stay live. On failure the error is recorded and surfaced via
    /health and per-task, rather than crash-looping the container.
    """
    global _load_error
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, _load_pipeline)
        _ready.set()
        log.info("TRELLIS pipeline ready")
    except Exception as exc:  # noqa: BLE001 — surfaced via /health + task status
        _load_error = safe_error(exc, context="model load")
        log.error("TRELLIS pipeline load FAILED: %s", exc)


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
    asyncio.create_task(_load_pipeline_bg())
    log.info("Service starting — pipeline loading in background (max_concurrent=%d)", MAX_CONCURRENT)
    yield


app = FastAPI(title="model-trellis", lifespan=lifespan)


def _require_api_key(authorization: str) -> None:
    try:
        require_api_key(authorization, API_KEY)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


def _decode_image(src: str, keep_alpha: bool = False) -> Image.Image:
    # keep_alpha=True preserves an RGBA cutout's transparency so TRELLIS uses the
    # supplied alpha as the subject mask (its preprocess_image path respects an
    # existing alpha channel and only falls back to internal rembg for RGB). The
    # text/free lane keeps the historical RGB decode.
    mode = "RGBA" if keep_alpha else "RGB"
    if src.startswith("data:image"):
        b64 = src.split(",", 1)[1]
        return Image.open(io.BytesIO(base64.b64decode(b64))).convert(mode)
    if src.startswith("https://"):
        # SSRF-hardened: https-only, private/loopback/link-local/metadata IPs
        # rejected after DNS resolution, redirects re-validated per hop, bounded.
        try:
            data = fetch_remote_bytes(src, timeout=30)
        except UnsafeUrlError as exc:
            raise ValueError(f"refused to fetch image source: {exc}") from exc
        return Image.open(io.BytesIO(data)).convert(mode)
    raise ValueError(f"unsupported image source: {src[:60]}")


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
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: _task_blob(task_id).upload_from_string(
            json.dumps(task), content_type="application/json"
        ),
    )
    return task


# Per-request quality knobs, clamped to safe envelopes for a 24 GB L4.
# Defaults are the platform's production quality bar, not the TRELLIS demo's
# (steps=12, simplify=0.95, texture_size=1024): GPU time is cheap against the
# platform's GCP credit budget ($100k+ provisioned, owner has explicitly signed
# off on spending it here), so both diffusion stages run well past the demo
# step count and the texture bake runs at the model's max resolution by
# default. Callers may still override per request (e.g. a lower-cost preview
# lane). Measured warm cost at the PRIOR defaults (steps=25/25, texture=2048,
# simplify=0.90) was ~50s/asset (docs/ops/gcp-credits.md) against a 300s client
# poll budget (src/home-forge.js MAX_POLL_MS) — ample headroom to push further:
#   - ss_steps/slat_steps 25→40: sharper structure and surface detail. Cost
#     scales roughly linearly with steps, so ~1.6x the diffusion time.
#   - texture_size 2048→4096 (the clamp ceiling): texture baking is a
#     resize/encode pass, not a diffusion stage, so this is a small time cost
#     for a large perceptual win — resolution is one of the single biggest
#     levers on whether a result reads as "real" vs "generated."
#   - simplify 0.90→0.75: keeps meaningfully more geometry (25% of triangles
#     removed instead of 90%) — low-poly faceting is one of the most obvious
#     tells of AI-generated 3D, and this is otherwise-idle GPU decimation cost.
# Together these land well inside the poll budget (est. ~90-120s warm) while
# meaningfully closing the gap toward a photograph-real result.
# `simplify` is the FRACTION OF TRIANGLES REMOVED by to_glb's decimation —
# lower keeps more geometry. Raising steps sharpens structure and appearance
# at roughly linear GPU-time cost; the L4 has headroom (MAX_CONCURRENT=1).
_QUALITY_DEFAULTS = {
    "ss_steps": 40,
    "slat_steps": 40,
    "ss_cfg": 7.5,
    "slat_cfg": 3.0,
    "simplify": 0.75,
    "texture_size": 4096,
}

# Named quality tiers. A caller sends `tier` to pick one preset; an explicit
# `quality` dict still overrides individual fields on top of it. When no tier is
# sent the base stays _QUALITY_DEFAULTS, so the existing lane's behaviour is
# byte-for-byte unchanged — tiers are purely additive.
#   draft    — latency lane: demo-grade steps, aggressive decimation, 1K texture.
#   standard — the platform's prior default (steps 25, 2K texture, simplify 0.90).
#   high     — the current default (steps 40, 4K texture, simplify 0.75).
#   max      — maximum fidelity: steps at the sampler ceiling, near-zero geometry
#              decimation (keep ~all triangles), firmer guidance, 4K texture.
# `simplify` is the FRACTION OF TRIANGLES REMOVED, so a lower value keeps MORE
# geometry. texture_size caps at 4096 (the clamp ceiling and TRELLIS's practical
# bake limit on the L4). max is meant to be paired with rembg pre-matting.
_TIER_PRESETS = {
    "draft":    {"ss_steps": 12, "slat_steps": 12, "ss_cfg": 7.5, "slat_cfg": 3.0, "simplify": 0.95, "texture_size": 1024},
    "standard": {"ss_steps": 25, "slat_steps": 25, "ss_cfg": 7.5, "slat_cfg": 3.0, "simplify": 0.90, "texture_size": 2048},
    "high":     {"ss_steps": 40, "slat_steps": 40, "ss_cfg": 7.5, "slat_cfg": 3.0, "simplify": 0.75, "texture_size": 4096},
    "max":      {"ss_steps": 50, "slat_steps": 50, "ss_cfg": 8.5, "slat_cfg": 4.5, "simplify": 0.50, "texture_size": 4096},
}


def _clamped_quality(q: dict | None, tier: str | None = None) -> dict:
    # Base = the named tier preset when a valid one is given, else the historical
    # defaults. An explicit `quality` dict then overrides field-by-field.
    base = dict(_QUALITY_DEFAULTS)
    if tier:
        preset = _TIER_PRESETS.get(str(tier).strip().lower())
        if preset:
            base = dict(preset)
    src = {**base, **(q or {})}

    def num(key, lo, hi, cast=float):
        raw = src.get(key)
        try:
            val = cast(raw)
        except (TypeError, ValueError):
            return base[key]
        return max(lo, min(hi, val))

    return {
        "ss_steps": num("ss_steps", 8, 50, int),
        "slat_steps": num("slat_steps", 8, 50, int),
        "ss_cfg": num("ss_cfg", 1.0, 15.0),
        "slat_cfg": num("slat_cfg", 1.0, 10.0),
        "simplify": num("simplify", 0.5, 0.98),
        "texture_size": num("texture_size", 512, 4096, int),
    }


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

    q = _clamped_quality(quality, tier)
    # Matting defaults on for the MAX tier (paired for maximum fidelity) and off
    # everywhere else, preserving the free/default lane. An explicit `matte`
    # value always wins. It only actually runs when REMBG_SERVICE_URL is set.
    tier_key = str(tier).strip().lower() if tier else None
    do_matte = matte if matte is not None else (tier_key == "max")

    async with _sem:
        await _update_task(task_id, status="running")
        loop = asyncio.get_event_loop()
        t0 = time.time()
        try:
            matted_count = 0
            sources = list(images)
            if do_matte and REMBG_SERVICE_URL:
                model = rembg_model or REMBG_DEFAULT_MODEL
                resolved = []
                for src in sources:
                    new_src, ok = await _matte_via_rembg(src, model)
                    resolved.append((new_src, ok))
                    matted_count += 1 if ok else 0
                sources = [s for s, _ in resolved]
                # Decode a successful cutout as RGBA (its alpha is the mask);
                # anything that fell back to the original stays RGB.
                imgs = [
                    await loop.run_in_executor(None, _decode_image, s, ok)
                    for (s, ok) in resolved
                ]
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
    # Optional per-request override of _QUALITY_DEFAULTS (ss_steps, slat_steps,
    # ss_cfg, slat_cfg, simplify, texture_size) — see _clamped_quality. Omitted
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
    task = _tasks.get(task_id)
    if task is not None:
        return task
    # Not in this instance's local cache — fall back to the durable GCS
    # record, which every instance writes to on every state transition.
    loop = asyncio.get_event_loop()
    try:
        data = await loop.run_in_executor(None, _task_blob(task_id).download_as_bytes)
    except NotFound:
        raise HTTPException(status_code=404, detail="task not found")
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=safe_error(exc, context="task lookup")
        ) from exc
    task = json.loads(data)
    _tasks[task_id] = task
    return task


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "model": "trellis-image-large",
        "gpu_available": torch.cuda.is_available(),
        "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "pipeline_loaded": _pipeline is not None,
        "ready": bool(_ready and _ready.is_set()),
        "load_error": _load_error,
        "tiers": list(_TIER_PRESETS),
        "default_quality": _QUALITY_DEFAULTS,
        "rembg_matte": bool(REMBG_SERVICE_URL),
    }
