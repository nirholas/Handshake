"""
Avatar reconstruction service powered by InstantMesh.

Accepts 1–6 photos (frontal, left, right, …), generates a rigged GLB using
Zero123++ multi-view synthesis + InstantMesh reconstruction, uploads the result
to Cloud Storage, and tracks job state in Firestore.

Environment variables (all required unless noted):
  API_KEY               — shared bearer secret; set this in Cloud Run secrets
  GCS_BUCKET            — Cloud Storage bucket for output GLBs
  FIRESTORE_PROJECT     — GCP project that hosts the Firestore database
  HF_TOKEN              — HuggingFace access token (optional, for gated models)
  MODEL_CACHE           — local dir to cache downloaded weights (default: /models)
  DEVICE                — 'cuda' or 'cpu' (auto-detected from torch if not set)
  MAX_CONCURRENT_JOBS   — jobs processed at once (default: 1 on GPU)
"""

import asyncio
import base64
import io
import logging
import os
import sys
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import requests
import torch
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from fastapi.responses import JSONResponse
from google.cloud import firestore, storage
from PIL import Image
from pydantic import BaseModel, Field

# InstantMesh is cloned to /opt/instantmesh in the Docker image.
sys.path.insert(0, "/opt/instantmesh")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("avatar-reconstruction")

# ── Config ────────────────────────────────────────────────────────────────────

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
FIRESTORE_PROJECT = os.environ["FIRESTORE_PROJECT"]
MODEL_CACHE = Path(os.environ.get("MODEL_CACHE", "/models"))
HF_TOKEN = os.environ.get("HF_TOKEN")
DEVICE = os.environ.get("DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT_JOBS", "1"))

# ── Global state ──────────────────────────────────────────────────────────────

_zero123_pipe = None
_instantmesh_model = None
_rembg_session = None
_db: firestore.Client | None = None
_bucket: storage.Bucket | None = None
_job_sem: asyncio.Semaphore | None = None

# ── Model loading ─────────────────────────────────────────────────────────────


def _load_models() -> None:
    global _zero123_pipe, _instantmesh_model, _rembg_session

    log.info("Loading rembg background remover…")
    import rembg
    _rembg_session = rembg.new_session()

    log.info("Loading Zero123++ diffusion pipeline…")
    from diffusers import DiffusionPipeline, EulerAncestralDiscreteScheduler

    _zero123_pipe = DiffusionPipeline.from_pretrained(
        "sudo-ai/zero123plus-v1.2",
        custom_pipeline="zero123plus",
        torch_dtype=torch.float16,
        cache_dir=MODEL_CACHE / "zero123plus",
        token=HF_TOKEN,
    )
    _zero123_pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(
        _zero123_pipe.scheduler.config, timestep_spacing="trailing"
    )
    _zero123_pipe.to(DEVICE)

    log.info("Loading InstantMesh model…")
    from omegaconf import OmegaConf
    from src.utils.train_util import instantiate_from_config
    from huggingface_hub import hf_hub_download

    config_path = Path("/opt/instantmesh/configs/instant-mesh-large.yaml")
    config = OmegaConf.load(config_path)
    _instantmesh_model = instantiate_from_config(config.model_config)

    ckpt_path = hf_hub_download(
        repo_id="TencentARC/InstantMesh",
        filename="instant-mesh-large.ckpt",
        cache_dir=MODEL_CACHE / "instantmesh",
        token=HF_TOKEN,
    )
    state = torch.load(ckpt_path, map_location="cpu")
    _instantmesh_model.load_state_dict(state, strict=True)
    _instantmesh_model = _instantmesh_model.to(DEVICE)
    _instantmesh_model.eval()

    log.info("All models loaded — device=%s", DEVICE)


# ── Lifespan ──────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db, _bucket, _job_sem

    _job_sem = asyncio.Semaphore(MAX_CONCURRENT)

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _load_models)

    _db = firestore.Client(project=FIRESTORE_PROJECT)
    _bucket = storage.Client().bucket(GCS_BUCKET)

    log.info("Server ready")
    yield


app = FastAPI(title="avatar-reconstruction", lifespan=lifespan)

# ── Auth ──────────────────────────────────────────────────────────────────────


def _require_api_key(authorization: str) -> None:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization[len("Bearer "):].strip()
    if token != API_KEY:
        raise HTTPException(status_code=401, detail="invalid api key")


# ── Image helpers ─────────────────────────────────────────────────────────────


def _decode_image(src: str) -> Image.Image:
    if src.startswith("data:image"):
        b64 = src.split(",", 1)[1]
        return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
    if src.startswith("http://") or src.startswith("https://"):
        resp = requests.get(src, timeout=30)
        resp.raise_for_status()
        return Image.open(io.BytesIO(resp.content)).convert("RGB")
    raise ValueError(f"unsupported image source (must be data URI or https URL): {src[:60]}")


def _prepare_input(image: Image.Image) -> Image.Image:
    """Remove background and fit image to 320×320 with grey fill."""
    import rembg
    from src.utils.infer_util import remove_background, resize_foreground

    rgba = remove_background(image, _rembg_session)
    rgba = resize_foreground(rgba, ratio=0.85)

    canvas = Image.new("RGBA", (320, 320), (127, 127, 127, 255))
    offset = ((320 - rgba.width) // 2, (320 - rgba.height) // 2)
    canvas.paste(rgba, offset, mask=rgba.split()[3])

    result = Image.new("RGB", (320, 320), (127, 127, 127))
    result.paste(canvas, mask=canvas.split()[3])
    return result


def _generate_multiview(primary: Image.Image) -> list[Image.Image]:
    """Run Zero123++ to produce 6 synthetic views from a single image."""
    with torch.no_grad():
        output_grid = _zero123_pipe(primary, num_inference_steps=75).images[0]

    # Zero123++ outputs a 2-column × 3-row grid of 320×320 tiles.
    w, h = output_grid.size
    tile_w, tile_h = w // 2, h // 3
    views = []
    for row in range(3):
        for col in range(2):
            box = (col * tile_w, row * tile_h, (col + 1) * tile_w, (row + 1) * tile_h)
            views.append(output_grid.crop(box))
    return views


def _reconstruct_glb(views: list[Image.Image]) -> bytes:
    """Run InstantMesh on 6 multi-view images and return a GLB file as bytes."""
    import tempfile
    from torchvision import transforms
    from src.utils.camera_util import get_zero123plus_input_cameras

    transform = transforms.Compose([
        transforms.Resize((320, 320)),
        transforms.ToTensor(),
        transforms.Normalize([0.5], [0.5]),
    ])

    view_tensor = torch.stack([transform(v) for v in views]).unsqueeze(0).to(DEVICE)
    cameras = get_zero123plus_input_cameras(batch_size=1, fov=30.0).to(DEVICE)

    with torch.no_grad():
        planes = _instantmesh_model.forward_planes(view_tensor, cameras)
        mesh = _instantmesh_model.extract_mesh(planes, use_texture_map=True)

    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "avatar.glb"
        mesh.export(str(out))
        return out.read_bytes()


# ── Firestore helpers ─────────────────────────────────────────────────────────


def _set_job(job_id: str, data: dict) -> None:
    _db.collection("avatar_reconstruction_jobs").document(job_id).set(
        {**data, "updated_at": datetime.now(timezone.utc)},
        merge=True,
    )


def _get_job(job_id: str) -> dict | None:
    doc = _db.collection("avatar_reconstruction_jobs").document(job_id).get()
    return doc.to_dict() if doc.exists else None


# ── Job worker ────────────────────────────────────────────────────────────────


async def _process_job(job_id: str, image_sources: list[str]) -> None:
    async with _job_sem:
        _set_job(job_id, {"status": "running"})
        loop = asyncio.get_event_loop()
        try:
            log.info("[%s] decoding %d image(s)…", job_id, len(image_sources))
            images = await loop.run_in_executor(
                None, lambda: [_decode_image(s) for s in image_sources]
            )

            log.info("[%s] preparing primary input…", job_id)
            primary = await loop.run_in_executor(None, lambda: _prepare_input(images[0]))

            log.info("[%s] generating multi-view…", job_id)
            views = await loop.run_in_executor(None, lambda: _generate_multiview(primary))

            log.info("[%s] reconstructing mesh…", job_id)
            glb_bytes = await loop.run_in_executor(None, lambda: _reconstruct_glb(views))

            log.info("[%s] uploading GLB (%d bytes)…", job_id, len(glb_bytes))
            blob_name = f"reconstructions/{job_id}.glb"
            blob = _bucket.blob(blob_name)
            await loop.run_in_executor(
                None,
                lambda: blob.upload_from_string(glb_bytes, content_type="model/gltf-binary"),
            )
            glb_url = f"https://storage.googleapis.com/{GCS_BUCKET}/{blob_name}"

            _set_job(job_id, {"status": "done", "glb_url": glb_url})
            log.info("[%s] done → %s", job_id, glb_url)

        except Exception:
            log.exception("[%s] reconstruction failed", job_id)
            import traceback
            _set_job(job_id, {"status": "failed", "error": traceback.format_exc()})


# ── Routes ────────────────────────────────────────────────────────────────────


class ReconstructRequest(BaseModel):
    images: list[str] = Field(..., min_length=1, max_length=6)
    job_id: str | None = None


@app.post("/reconstruct", status_code=202)
async def reconstruct(
    body: ReconstructRequest,
    authorization: str = Header(...),
) -> dict:
    _require_api_key(authorization)
    job_id = body.job_id or str(uuid.uuid4())
    _set_job(job_id, {
        "job_id": job_id,
        "status": "queued",
        "image_count": len(body.images),
        "created_at": datetime.now(timezone.utc),
    })
    asyncio.create_task(_process_job(job_id, body.images))
    return {"job_id": job_id, "status": "queued"}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str, authorization: str = Header(...)) -> dict:
    _require_api_key(authorization)
    job = _get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    # Convert Firestore timestamps to ISO strings for JSON serialisation.
    for k, v in job.items():
        if hasattr(v, "isoformat"):
            job[k] = v.isoformat()
    return job


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "device": DEVICE,
        "model_loaded": _instantmesh_model is not None,
        "cuda_available": torch.cuda.is_available(),
    }
