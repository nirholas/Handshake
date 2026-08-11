"""
Text-guided texture generation service.

Two capabilities share one model server:

  • Full retexture (/texture) — takes an untextured (or poorly-textured) GLB and
    a text prompt, renders the mesh from N viewpoints, generates coherent texture
    views with SDXL + ControlNet (depth), and back-projects them onto the UV map.

  • Magic-brush region retexture (/retexture_region) — repaints ONLY a masked
    region of an existing texture from a prompt/colour, preserving the rest
    pixel-for-pixel and feathering the seam so the edit is invisible. This is the
    surgical counterpart to the all-or-nothing /texture pass and is safe to run
    repeatedly (each pass operates on the latest texture).

Full-retexture pipeline:
  1. Load mesh (trimesh), ensure UV mapping exists (auto-unwrap if missing)
  2. Render depth maps from 8 canonical orthographic viewpoints using pyrender
  3. For each view: run SDXL + ControlNet-Depth to generate a texture view
  4. Rasterize the mesh into UV space and back-project each generated view onto
     the atlas through the same camera it was rendered with (texture_projection)
  5. Blend overlapping UV regions by confidence (cos of the angle between the
     surface normal and the view axis), rejecting occluded texels against the
     rendered depth buffer
  6. Bake final texture atlas and export as textured GLB

Region-retexture pipeline (UV-space inpainting):
  1. Load the GLB WITHOUT repacking UVs and pull out its existing baseColour
     atlas — the frontend painted the mask in exactly this UV space, so we must
     not unwrap/concatenate or the mask would no longer align.
  2. Decode the caller's UV-space mask (white = repaint, black = keep).
  3. Run real SDXL inpainting on the atlas, regenerating only the masked region
     (optionally pre-tinted toward a target colour).
  4. Composite the inpaint output back over the original atlas through a
     feathered alpha so untouched texels are bit-identical and the seam ramps
     smoothly — invisible blend, no global quality loss across repeated passes.
  5. Re-export the GLB with the same mesh, UVs, and material (only baseColour
     swapped).

API contract:
  POST /texture  {
    mesh: url,         # https GLB URL (required)
    prompt: str,       # texture description, e.g. "worn leather, dark brown"
    negative_prompt?: str,
    num_views?: int,   # 4 or 8 (default: 8)
    texture_size?: int, # 512|1024|2048 (default: 2048)
    material_class?: str # person|metal|wood|fabric|plastic|glass — sets the
                          # baked roughness/metallic factors to measured
                          # real-world values instead of a flat guess, and
                          # nudges the SDXL prompt with material-appropriate
                          # descriptors (see MATERIAL_CLASS_PBR below).
  } → 202 { task_id, status }

  POST /retexture_region {
    mesh: url,          # https GLB URL with an existing texture (required)
    prompt: str,        # what to paint into the region (required unless color set)
    mask_b64?: str,     # UV-space mask PNG, base64 (white = edit). Either this …
    mask?: url,         # … or a public https URL to the mask PNG.
    color?: str,        # optional "#rrggbb" target colour for the region
    negative_prompt?: str,
    texture_size?: int, # 512|1024|2048 working/output atlas size (default: 2048)
    strength?: float,   # inpaint denoise strength 0.2–1.0 (default 0.85)
    feather?: int,      # seam feather radius in atlas px (default 24)
    seed?: int
  } → 202 { task_id, status }

  GET /tasks/:id → { task_id, status, result_url?, error? }
  GET /health    → { ok, gpu_available, model_loaded }

Environment variables:
  API_KEY              — bearer secret (required)
  GCS_BUCKET           — output bucket (required)
  SDXL_MODEL           — HuggingFace model id (default: stabilityai/stable-diffusion-xl-base-1.0)
  CONTROLNET_MODEL     — ControlNet depth model id
                         (default: diffusers/controlnet-depth-sdxl-1.0)
  SDXL_INPAINT_MODEL   — SDXL inpainting checkpoint for the magic brush
                         (default: diffusers/stable-diffusion-xl-1.0-inpainting-0.1)
  WEIGHT_VARIANT         checkpoint variant to resolve (default: fp16)
  WEIGHTS_DIR: cache dir used when GCS staging is off (default: /weights)
  WEIGHTS_GCS_URI: gs:// prefix holding the HuggingFace cache tree. When set,
                         weights are copied to local disk at load time instead of
                         being read through the FUSE mount (see _stage_weights_local).
  WEIGHTS_LOCAL_DIR: where that staged copy lands (default: /tmp/sdxl-texture)
  MAX_CONCURRENT       — default 1 (GPU-bound)
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
import logging
import os
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from google.cloud import storage
from PIL import Image, ImageFilter
from pydantic import BaseModel, Field, field_validator

import texture_projection as tp
from worker_security import (
    fetch_remote_bytes,
    require_api_key,
    safe_error,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("texture")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
WEIGHTS_DIR = os.environ.get("WEIGHTS_DIR", "/weights")
SDXL_MODEL = os.environ.get("SDXL_MODEL", "stabilityai/stable-diffusion-xl-base-1.0")
CONTROLNET_MODEL = os.environ.get(
    "CONTROLNET_MODEL", "diffusers/controlnet-depth-sdxl-1.0"
)
SDXL_INPAINT_MODEL = os.environ.get(
    "SDXL_INPAINT_MODEL", "diffusers/stable-diffusion-xl-1.0-inpainting-0.1"
)
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "1"))

# Every checkpoint here is loaded in half precision and run on an L4, so the
# fp16 variant of each repo is the only one this service ever uses. Naming it
# explicitly is not a micro-optimisation: without it diffusers resolves the
# full-precision safetensors, which is 44 GiB across the three SDXL repos
# against 15 GiB for the fp16 set. That is the difference between a cold start
# that can finish inside the 600 s request timeout and one that cannot, and it
# is also what the staged weights prefix and the image cache are built from, so
# changing it means restaging both.
WEIGHT_VARIANT = os.environ.get("WEIGHT_VARIANT", "fp16")

# Weight staging: copy the HuggingFace cache tree from GCS to local disk with the
# storage client before loading, instead of letting diffusers read ~15 GiB of
# SDXL weights through the Cloud Storage FUSE mount. FUSE stalls on the large
# sequential reads a safetensors load issues, which is what left the first
# request to burn the whole 600 s request timeout; a plain sequential GET per
# object does not stall. Same pattern as workers/model-hunyuan3d and
# workers/model-trellis. Unset WEIGHTS_GCS_URI, or any staging failure, falls
# back to loading from WEIGHTS_DIR unchanged.
WEIGHTS_GCS_URI = os.environ.get("WEIGHTS_GCS_URI", "")  # e.g. gs://bucket/sdxl-texture
WEIGHTS_LOCAL_DIR = os.environ.get("WEIGHTS_LOCAL_DIR", "/tmp/sdxl-texture")
# Resolved once by _resolve_cache_dir(); every from_pretrained cache_dir reads it
# so the text pipeline and the lazily-loaded inpaint pipeline share one staged copy.
_cache_dir: Optional[str] = None
_cache_dir_lock = threading.Lock()


def _stage_weights_local() -> Optional[str]:
    """Download the HuggingFace cache tree from GCS to local disk, bypassing the
    FUSE mount. Returns the local dir on success, or None to signal "load from
    WEIGHTS_DIR as before". Never raises: a staging failure must degrade to the
    FUSE-mount load, not crash the loader."""
    if not WEIGHTS_GCS_URI.startswith("gs://"):
        return None
    try:
        from concurrent.futures import ThreadPoolExecutor

        bucket_name, _, prefix = WEIGHTS_GCS_URI[len("gs://"):].partition("/")
        prefix = prefix.rstrip("/") + "/"
        client = storage.Client()
        blobs = [
            blob
            for blob in client.list_blobs(bucket_name, prefix=prefix)
            if blob.name[len(prefix):] and not blob.name.endswith("/")
        ]
        if not blobs:
            log.warning("weights staging: no objects under %s; using FUSE mount", WEIGHTS_GCS_URI)
            return None

        def _download(blob) -> int:
            rel = blob.name[len(prefix):]
            dest = os.path.join(WEIGHTS_LOCAL_DIR, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            # Reuse an already-staged object (same-instance warm restart) when its
            # size matches, so reloading the inpaint pipeline re-pulls nothing.
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
    except Exception as exc:  # noqa: BLE001, degrade to the FUSE mount, never crash
        log.warning("weights staging failed (%s); falling back to FUSE mount %s", exc, WEIGHTS_DIR)
        return None


def _resolve_cache_dir() -> str:
    """The directory every from_pretrained call reads. Stages from GCS on first
    use, then memoizes so the second pipeline reuses the staged copy."""
    global _cache_dir
    with _cache_dir_lock:
        if _cache_dir is None:
            _cache_dir = _stage_weights_local() or WEIGHTS_DIR
        return _cache_dir

# Hard caps for the region-retexture mask payload — a UV mask is a small 1-channel
# PNG; anything larger is malformed or hostile.
MAX_MASK_BYTES = 8 * 1024 * 1024
# SDXL inpainting is trained at 1024²; we always run inference there and resample
# to the working atlas size so fine texture detail outside the region survives.
INPAINT_INFER_SIZE = 1024

_pipe = None
_inpaint_pipe = None
_inpaint_lock = threading.Lock()
_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_tasks: dict[str, dict] = {}

# 8 canonical viewpoints: azimuth, elevation (degrees)
VIEWPOINTS_8 = [
    (0, 0),    # front
    (45, 15),
    (90, 0),   # right
    (135, 15),
    (180, 0),  # back
    (225, 15),
    (270, 0),  # left
    (315, 15),
]
VIEWPOINTS_4 = [(0, 0), (90, 0), (180, 0), (270, 0)]

# Measured-value PBR defaults per material class (see prompt 04's "material
# presets that match reality"). Keyed by the director's material
# classification (api/_lib/forge-director-prompts.js) — these are the same
# real-world roughness/metallic ranges @three-ws/viewer-presets uses for its
# skin/carPaint/brushedSteel/realGlass presets, applied here to the BAKED
# texture atlas so a lane that never runs Material Studio still ships a
# physically-plausible material out of the box instead of the flat
# metallic=0/roughness=0.8 guess every class used to get.
MATERIAL_CLASS_PBR = {
    "person": {"metallic": 0.0, "roughness": 0.52, "prompt_suffix": "realistic human skin texture, subtle pores, soft even lighting"},
    "metal": {"metallic": 0.9, "roughness": 0.35, "prompt_suffix": "brushed metal, subtle micro-scratches, realistic metallic reflections"},
    "wood": {"metallic": 0.0, "roughness": 0.72, "prompt_suffix": "natural wood grain, matte varnish, realistic wood texture"},
    "fabric": {"metallic": 0.0, "roughness": 0.88, "prompt_suffix": "woven fabric texture, soft matte cloth, visible weave"},
    "plastic": {"metallic": 0.0, "roughness": 0.35, "prompt_suffix": "smooth injection-molded plastic, slight glossy sheen"},
    "glass": {"metallic": 0.0, "roughness": 0.05, "prompt_suffix": "clear glass, subtle reflections, glossy transparent surface"},
}
DEFAULT_MATERIAL_PBR = {"metallic": 0.0, "roughness": 0.8, "prompt_suffix": ""}


def _resolve_material_pbr(material_class: Optional[str]) -> dict:
    return MATERIAL_CLASS_PBR.get((material_class or "").strip().lower(), DEFAULT_MATERIAL_PBR)


def _load_pipeline() -> None:
    global _pipe
    from diffusers import StableDiffusionXLControlNetPipeline, ControlNetModel, AutoencoderKL

    cache_dir = _resolve_cache_dir()
    log.info("Loading ControlNet model: %s", CONTROLNET_MODEL)
    controlnet = ControlNetModel.from_pretrained(
        CONTROLNET_MODEL,
        torch_dtype=torch.float16,
        use_safetensors=True,
        variant=WEIGHT_VARIANT,
        cache_dir=cache_dir,
    )

    log.info("Loading SDXL model: %s", SDXL_MODEL)
    vae = AutoencoderKL.from_pretrained(
        # No variant here: this VAE is published fp16-native as a single set of
        # files, so asking for an fp16 variant of it would look for names the
        # repo does not carry.
        "madebyollin/sdxl-vae-fp16-fix",
        torch_dtype=torch.float16,
        cache_dir=cache_dir,
    )
    _pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
        SDXL_MODEL,
        controlnet=controlnet,
        vae=vae,
        torch_dtype=torch.float16,
        use_safetensors=True,
        variant=WEIGHT_VARIANT,
        cache_dir=cache_dir,
    )
    # No .to("cuda") first: enable_model_cpu_offload moves the whole pipeline back
    # to CPU itself and then streams each submodule to the GPU as it is needed, so
    # an eager .to("cuda") only buys a full round trip of the weights over PCIe
    # during a cold start that already pays for the load.
    _pipe.enable_model_cpu_offload()
    _pipe.enable_xformers_memory_efficient_attention()
    log.info("Texture pipeline loaded")


def _load_inpaint_pipeline() -> None:
    """Lazily load the SDXL inpainting pipeline used by the magic brush.

    Kept separate from the depth-ControlNet text pipeline so the existing
    /texture path pays no extra startup cost or VRAM until a region edit is
    actually requested. Guarded by a lock — under the default MAX_CONCURRENT=1
    only one request runs at a time, but the lock keeps a future bump safe.
    """
    global _inpaint_pipe
    if _inpaint_pipe is not None:
        return
    with _inpaint_lock:
        if _inpaint_pipe is not None:
            return
        from diffusers import StableDiffusionXLInpaintPipeline, AutoencoderKL

        cache_dir = _resolve_cache_dir()
        log.info("Loading SDXL inpaint model: %s", SDXL_INPAINT_MODEL)
        vae = AutoencoderKL.from_pretrained(
            "madebyollin/sdxl-vae-fp16-fix",
            torch_dtype=torch.float16,
            cache_dir=cache_dir,
        )
        pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
            SDXL_INPAINT_MODEL,
            vae=vae,
            torch_dtype=torch.float16,
            use_safetensors=True,
            variant=WEIGHT_VARIANT,
            cache_dir=cache_dir,
        )
        pipe.enable_model_cpu_offload()
        try:
            pipe.enable_xformers_memory_efficient_attention()
        except Exception as exc:  # xformers is optional — never fatal
            log.warning("xformers unavailable for inpaint pipe: %s", exc)
        _inpaint_pipe = pipe
        log.info("Inpaint pipeline loaded")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _load_pipeline)
    log.info("Texture service ready")
    yield


app = FastAPI(title="texture-service", lifespan=lifespan)


def _require_api_key(authorization: str) -> None:
    try:
        require_api_key(authorization, API_KEY)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


# ── Mesh loading ────────────────────────────────────────────────────────────────

def _load_mesh(url: str):
    import trimesh
    data = fetch_remote_bytes(url, timeout=60, max_bytes=128 * 1024 * 1024)
    suffix = Path(url.split("?")[0]).suffix.lower() or ".glb"
    mesh = trimesh.load(io.BytesIO(data), file_type=suffix.lstrip("."), force="mesh", process=True)
    if isinstance(mesh, trimesh.Scene):
        meshes = [g for g in mesh.geometry.values() if isinstance(g, trimesh.Trimesh)]
        mesh = trimesh.util.concatenate(meshes)
    if not hasattr(mesh.visual, "uv") or mesh.visual.uv is None:
        # Auto-unwrap using trimesh's built-in UV generation
        mesh = mesh.unwrap()
    return mesh


# ── Depth rendering ─────────────────────────────────────────────────────────────

def _render_view_depth(mesh, view: tp.OrthographicView) -> Image.Image:
    """Render one viewpoint as the ControlNet conditioning image.

    Near is bright, background black. Only the ordering of the values matters
    here, which is just as well: pyrender un-projects its depth buffer with the
    perspective formula whatever camera drew it, so under an orthographic camera
    the numbers are a monotonic but nonlinear remap of true depth. That is fine
    for conditioning and useless for geometry, which is why the occlusion test in
    texture_projection builds its own z-buffer instead of reusing this render.
    """
    import pyrender

    scene = pyrender.Scene(ambient_light=[0.5, 0.5, 0.5])
    scene.add(pyrender.Mesh.from_trimesh(mesh, smooth=False))
    camera = pyrender.OrthographicCamera(
        xmag=view.xmag, ymag=view.ymag, znear=view.znear, zfar=view.zfar
    )
    scene.add(camera, pose=view.pose_matrix())

    renderer = pyrender.OffscreenRenderer(view.size, view.size)
    try:
        _, depth = renderer.render(scene)
    finally:
        renderer.delete()

    return Image.fromarray(tp.depth_to_control_image(np.asarray(depth, dtype=np.float32)))


# ── Texture generation ──────────────────────────────────────────────────────────

def _generate_view_texture(
    depth_img: Image.Image,
    prompt: str,
    negative_prompt: str,
    size: int,
    seed: int,
) -> Image.Image:
    generator = torch.Generator(device="cuda").manual_seed(seed)
    result = _pipe(
        prompt=prompt,
        negative_prompt=negative_prompt,
        image=depth_img.resize((size, size)),
        controlnet_conditioning_scale=0.6,
        # 20→35 steps: same lever as model-trellis's quality bump (docs/ops/
        # gcp-credits.md) — roughly linear GPU-time cost for a sharper,
        # less-noisy view per the model's usual diminishing-returns curve
        # past ~40-50. guidance_scale stays at SDXL's well-behaved default;
        # pushing it up (unlike steps) oversaturates and adds artifacts
        # rather than detail, so it is not part of this quality pass.
        num_inference_steps=35,
        guidance_scale=7.5,
        width=size,
        height=size,
        generator=generator,
    )
    return result.images[0]


# ── UV projection ────────────────────────────────────────────────────────────────

def _project_texture_onto_uv(
    mesh,
    views: list[tp.OrthographicView],
    view_images: list[Image.Image],
    texture_size: int,
) -> Image.Image:
    """Back-project the generated views onto the mesh's UV atlas.

    The geometry lives in texture_projection so it can be tested without a GPU;
    this is the trimesh adapter around it.
    """
    atlas, weight, covered = tp.project_views_to_uv(
        np.asarray(mesh.vertices, dtype=np.float32),
        np.asarray(mesh.vertex_normals, dtype=np.float32),
        np.asarray(mesh.visual.uv, dtype=np.float32),
        np.asarray(mesh.faces, dtype=np.int64),
        views,
        [np.asarray(img.convert("RGB")) for img in view_images],
        texture_size,
    )
    total = int(covered.sum())
    seen = int((weight > 0).sum())
    log.info(
        "UV coverage: %d/%d texels painted from the views (%.1f%%), rest filled from neighbours",
        seen, total, (100.0 * seen / total) if total else 0.0,
    )
    return Image.fromarray(atlas)


# ── Full pipeline ────────────────────────────────────────────────────────────────

def _run_texturing(
    mesh_url: str,
    prompt: str,
    negative_prompt: str,
    num_views: int,
    texture_size: int,
    material_class: Optional[str] = None,
) -> bytes:
    import trimesh

    pbr = _resolve_material_pbr(material_class)
    effective_prompt = f"{prompt}, {pbr['prompt_suffix']}" if pbr["prompt_suffix"] else prompt

    mesh = _load_mesh(mesh_url)
    viewpoints = VIEWPOINTS_8 if num_views >= 8 else VIEWPOINTS_4
    sphere = mesh.bounding_sphere.primitive
    views = tp.canonical_views(sphere.center, sphere.radius, viewpoints, texture_size)

    log.info("Rendering %d depth maps at %dpx", len(views), texture_size)
    depth_maps = [_render_view_depth(mesh, view) for view in views]

    log.info("Generating texture views with SDXL+ControlNet (material_class=%s)", material_class or "default")
    view_images = [
        _generate_view_texture(d, effective_prompt, negative_prompt, texture_size, seed=i * 42)
        for i, d in enumerate(depth_maps)
    ]

    log.info("Projecting views onto UV atlas (%dpx)", texture_size)
    texture_atlas = _project_texture_onto_uv(mesh, views, view_images, texture_size)

    log.info("Baking textured GLB with metallic=%.2f roughness=%.2f", pbr["metallic"], pbr["roughness"])
    material = trimesh.visual.material.PBRMaterial(
        baseColorTexture=texture_atlas,
        metallicFactor=pbr["metallic"],
        roughnessFactor=pbr["roughness"],
    )
    mesh.visual = trimesh.visual.TextureVisuals(uv=mesh.visual.uv, material=material)

    buf = io.BytesIO()
    scene = trimesh.scene.scene.Scene(geometry={"mesh": mesh})
    scene.export(buf, file_type="glb")
    return buf.getvalue()


# ── Region retexture (magic brush) ───────────────────────────────────────────────

def _parse_hex_color(value: Optional[str]) -> Optional[tuple[int, int, int]]:
    """Parse "#rrggbb" / "rrggbb" → (r, g, b). Returns None for falsy/invalid."""
    if not value:
        return None
    s = value.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        return None
    try:
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except ValueError:
        return None


def _decode_mask_bytes(mask_b64: Optional[str], mask_url: Optional[str]) -> bytes:
    """Resolve the UV mask payload from inline base64 or a public URL."""
    if mask_b64:
        raw = mask_b64.strip()
        # Tolerate a data: URL prefix from the browser canvas toDataURL().
        if raw.startswith("data:"):
            raw = raw.split(",", 1)[-1]
        try:
            data = base64.b64decode(raw, validate=False)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("mask_b64 is not valid base64") from exc
        if not data:
            raise ValueError("mask_b64 decoded to empty bytes")
        if len(data) > MAX_MASK_BYTES:
            raise ValueError("mask exceeds size limit")
        return data
    if mask_url:
        return fetch_remote_bytes(mask_url, timeout=30, max_bytes=MAX_MASK_BYTES)
    raise ValueError("a region mask is required (mask_b64 or mask)")


def _build_masks(
    mask_bytes: bytes, size: tuple[int, int], feather: int
) -> tuple[Image.Image, Image.Image]:
    """Turn a raw mask PNG into (inpaint_mask, blend_alpha) at `size`.

    inpaint_mask — a slightly dilated hard mask (white = regenerate). The dilation
      gives SDXL a margin past the painted edge so the new content transitions
      into the surrounding texture instead of butting hard against it.
    blend_alpha  — a feathered 0–255 ramp used to composite the inpaint result
      back over the untouched base, so the interior is fully replaced and the
      boundary fades out smoothly (invisible seam). Texels at alpha 0 are left
      bit-identical.
    """
    src = Image.open(io.BytesIO(mask_bytes)).convert("L").resize(size, Image.LANCZOS)
    arr = np.asarray(src, dtype=np.uint8)
    hard = (arr > 127).astype(np.uint8) * 255
    if not hard.any():
        raise ValueError("mask is empty — paint a region before applying")

    feather = max(1, int(feather))
    hard_img = Image.fromarray(hard, mode="L")

    # Dilate via MaxFilter (odd kernel) then a light blur for the inpaint mask.
    k = max(3, (feather // 2) * 2 + 1)
    inpaint_mask = hard_img.filter(ImageFilter.MaxFilter(min(k, 25)))
    inpaint_mask = inpaint_mask.point(lambda p: 255 if p > 40 else 0)

    # Feathered alpha for the final composite.
    blend_alpha = hard_img.filter(ImageFilter.GaussianBlur(radius=feather))
    return inpaint_mask, blend_alpha


def _load_textured_mesh(url: str):
    """Load a GLB preserving its original UVs/material (no unwrap, no repack).

    Region edits must operate in the exact UV space the caller painted against,
    so we deliberately avoid trimesh's processing/concatenation here. Returns
    (scene, geometry_name, mesh) — for a bare mesh we wrap it in a one-item
    scene so the export path is uniform.
    """
    import trimesh

    data = fetch_remote_bytes(url, timeout=60, max_bytes=128 * 1024 * 1024)
    suffix = Path(url.split("?")[0]).suffix.lower() or ".glb"
    loaded = trimesh.load(
        io.BytesIO(data), file_type=suffix.lstrip("."), process=False
    )

    if isinstance(loaded, trimesh.Scene):
        geoms = [
            (name, g)
            for name, g in loaded.geometry.items()
            if isinstance(g, trimesh.Trimesh)
        ]
        if not geoms:
            raise ValueError("GLB contains no mesh geometry")
        # Prefer a geometry that already carries UVs + a texture; among those
        # (or all, as a fallback) pick the largest by face count.
        textured = [
            (n, g)
            for n, g in geoms
            if getattr(g.visual, "uv", None) is not None
        ]
        name, mesh = max(textured or geoms, key=lambda ng: len(ng[1].faces))
        return loaded, name, mesh

    scene = trimesh.Scene(geometry={"mesh": loaded})
    return scene, "mesh", loaded


def _existing_base_texture(mesh, texture_size: int) -> Image.Image:
    """Pull the mesh's baseColour texture, or synthesize a flat base from its
    base-colour factor / vertex colours so unmasked regions stay coherent."""
    visual = mesh.visual
    mat = getattr(visual, "material", None)
    base_img = None
    if mat is not None:
        base_img = getattr(mat, "baseColorTexture", None) or getattr(mat, "image", None)

    if base_img is not None:
        return base_img.convert("RGB")

    # No texture present — fall back to a solid base from the material factor.
    color = (180, 180, 180)
    factor = getattr(mat, "baseColorFactor", None) if mat is not None else None
    if factor is not None and len(factor) >= 3:
        color = tuple(int(max(0.0, min(1.0, float(c))) * 255) for c in factor[:3])
    return Image.new("RGB", (texture_size, texture_size), color)


def _inpaint_region(
    base_rgb: Image.Image,
    inpaint_mask: Image.Image,
    blend_alpha: Image.Image,
    prompt: str,
    negative_prompt: str,
    color: Optional[tuple[int, int, int]],
    strength: float,
    seed: int,
) -> Image.Image:
    """Run SDXL inpainting on the masked region and composite it back over the
    base atlas through the feathered alpha. Returns the new full-size atlas."""
    work_size = base_rgb.size  # (w, h) of the working atlas

    init = base_rgb.copy()
    # A colour hint primes the region so SDXL respects the requested hue.
    if color is not None:
        tint = Image.new("RGB", work_size, color)
        init = Image.composite(tint, init, inpaint_mask)

    infer = (INPAINT_INFER_SIZE, INPAINT_INFER_SIZE)
    init_small = init.resize(infer, Image.LANCZOS)
    mask_small = inpaint_mask.resize(infer, Image.NEAREST)

    generator = torch.Generator(device="cuda").manual_seed(seed)
    result = _inpaint_pipe(
        prompt=prompt,
        negative_prompt=negative_prompt,
        image=init_small,
        mask_image=mask_small,
        strength=float(strength),
        num_inference_steps=40,  # 30→40, same steps-for-detail tradeoff as the full retexture pass above
        guidance_scale=7.5,
        width=infer[0],
        height=infer[1],
        generator=generator,
    )
    painted = result.images[0].resize(work_size, Image.LANCZOS).convert("RGB")

    # Composite: interior fully painted, boundary ramps, exterior untouched.
    return Image.composite(painted, base_rgb, blend_alpha.resize(work_size, Image.LANCZOS))


def _run_region_texturing(
    mesh_url: str,
    prompt: str,
    negative_prompt: str,
    mask_b64: Optional[str],
    mask_url: Optional[str],
    color_hex: Optional[str],
    texture_size: int,
    strength: float,
    feather: int,
    seed: int,
) -> bytes:
    import trimesh

    color = _parse_hex_color(color_hex)
    if not prompt and color is None:
        raise ValueError("provide a prompt and/or a color for the region")

    scene, geom_name, mesh = _load_textured_mesh(mesh_url)

    uv = getattr(mesh.visual, "uv", None)
    base_rgb = _existing_base_texture(mesh, texture_size)
    # Work at the larger of the requested size and the existing texture so we
    # never throw away detail the source already has outside the edit region.
    work = max(texture_size, min(max(base_rgb.size), 2048))
    base_rgb = base_rgb.resize((work, work), Image.LANCZOS)

    if uv is None:
        # No UVs at all — we can still texture, but the painted mask can't be
        # trusted to align, so unwrap and treat this as a flat fill of the region.
        mesh = mesh.unwrap()
        uv = mesh.visual.uv

    mask_bytes = _decode_mask_bytes(mask_b64, mask_url)
    inpaint_mask, blend_alpha = _build_masks(mask_bytes, (work, work), feather)

    log.info(
        "Region inpaint: atlas=%dpx feather=%d strength=%.2f color=%s",
        work, feather, strength, color_hex or "none",
    )
    _load_inpaint_pipeline()
    full_prompt = prompt
    if color is not None and prompt:
        full_prompt = f"{prompt}, predominantly {color_hex} colour"
    new_atlas = _inpaint_region(
        base_rgb, inpaint_mask, blend_alpha, full_prompt, negative_prompt,
        color, strength, seed,
    )

    # Preserve the existing material; swap only the baseColour texture.
    mat = getattr(mesh.visual, "material", None)
    if isinstance(mat, trimesh.visual.material.PBRMaterial):
        mat.baseColorTexture = new_atlas
    else:
        mat = trimesh.visual.material.PBRMaterial(
            baseColorTexture=new_atlas, metallicFactor=0.0, roughnessFactor=0.9
        )
    mesh.visual = trimesh.visual.TextureVisuals(uv=uv, material=mat)
    scene.geometry[geom_name] = mesh

    buf = io.BytesIO()
    scene.export(buf, file_type="glb")
    return buf.getvalue()


# ── Task runner ───────────────────────────────────────────────────────────────────

async def _run_task(task_id: str, runner: Callable[[], bytes], label: str) -> None:
    """Shared async wrapper: run a blocking GLB-producing job on the executor,
    upload the result to GCS, and record terminal status on the task."""
    async with _sem:
        _tasks[task_id]["status"] = "running"
        loop = asyncio.get_event_loop()
        t0 = time.time()
        try:
            glb_bytes = await loop.run_in_executor(None, runner)

            blob_name = f"textured/{task_id}.glb"
            blob = _bucket.blob(blob_name)
            await loop.run_in_executor(
                None,
                lambda: blob.upload_from_string(
                    glb_bytes, content_type="model/gltf-binary"
                ),
            )
            result_url = f"https://storage.googleapis.com/{GCS_BUCKET}/{blob_name}"

            elapsed = time.time() - t0
            _tasks[task_id].update({
                "status": "done",
                "result_url": result_url,
                "bytes": len(glb_bytes),
                "elapsed_ms": int(elapsed * 1000),
            })
            log.info("[%s] %s done in %.1fs — %d bytes", task_id, label, elapsed, len(glb_bytes))

        except Exception as exc:
            _tasks[task_id].update({
                "status": "failed",
                "error": safe_error(exc, context=f"[{task_id}] {label}"),
                "elapsed_ms": int((time.time() - t0) * 1000),
            })


async def _process(
    task_id: str,
    mesh_url: str,
    prompt: str,
    negative_prompt: str,
    num_views: int,
    texture_size: int,
    material_class: Optional[str] = None,
) -> None:
    await _run_task(
        task_id,
        lambda: _run_texturing(mesh_url, prompt, negative_prompt, num_views, texture_size, material_class),
        label="texture",
    )


async def _process_region(
    task_id: str,
    mesh_url: str,
    prompt: str,
    negative_prompt: str,
    mask_b64: Optional[str],
    mask_url: Optional[str],
    color_hex: Optional[str],
    texture_size: int,
    strength: float,
    feather: int,
    seed: int,
) -> None:
    await _run_task(
        task_id,
        lambda: _run_region_texturing(
            mesh_url, prompt, negative_prompt, mask_b64, mask_url,
            color_hex, texture_size, strength, feather, seed,
        ),
        label="retexture_region",
    )


class TextureRequest(BaseModel):
    mesh: str = Field(..., description="https URL to input GLB mesh")
    prompt: str = Field(..., min_length=3, max_length=500)
    negative_prompt: str = Field(default="blurry, low quality, distorted, watermark")
    num_views: int = Field(default=8, ge=4, le=8)
    # Default 1024→2048: this value drives BOTH the depth-render size and the
    # per-view SDXL+ControlNet generation resolution (see _run_texturing), not
    # just a post-hoc texture-bake resize — unlike model-trellis's texture_size,
    # this one costs real diffusion-model compute per step. 2048 is already a
    # validated, supported value (not a new untested path) and is within SDXL's
    # comfortably-generates-coherently range; going to 4096 here would mean 8
    # native SDXL generations per mesh at 4x the resolution the model was
    # trained at, risking both L4 VRAM headroom and per-view coherence, so it
    # is deliberately left off the accepted set below.
    texture_size: int = Field(default=2048)
    material_class: Optional[str] = Field(
        default=None,
        description="person|metal|wood|fabric|plastic|glass — measured-value roughness/metallic bake + prompt hint",
    )

    @field_validator("texture_size")
    @classmethod
    def validate_size(cls, v: int) -> int:
        if v not in (512, 1024, 2048):
            raise ValueError("texture_size must be 512, 1024, or 2048")
        return v

    @field_validator("material_class")
    @classmethod
    def validate_material_class(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v.strip().lower() not in MATERIAL_CLASS_PBR:
            raise ValueError(f"material_class must be one of {sorted(MATERIAL_CLASS_PBR)}")
        return v


@app.post("/texture", status_code=202)
async def texture_mesh(
    body: TextureRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(...),
) -> dict:
    _require_api_key(authorization)
    task_id = str(uuid.uuid4())
    _tasks[task_id] = {
        "task_id": task_id,
        "status": "queued",
        "prompt": body.prompt,
    }
    background_tasks.add_task(
        _process,
        task_id,
        body.mesh,
        body.prompt,
        body.negative_prompt,
        body.num_views,
        body.texture_size,
        body.material_class,
    )
    return {"task_id": task_id, "status": "queued"}


class RegionTextureRequest(BaseModel):
    mesh: str = Field(..., description="https URL to a textured GLB mesh")
    prompt: str = Field(default="", max_length=500, description="What to paint into the region")
    negative_prompt: str = Field(default="blurry, low quality, distorted, watermark, seam")
    mask_b64: Optional[str] = Field(default=None, description="UV-space mask PNG, base64 (white = edit)")
    mask: Optional[str] = Field(default=None, description="Public https URL to the UV mask PNG")
    color: Optional[str] = Field(default=None, max_length=9, description='Target colour "#rrggbb"')
    # Matches the /texture pass's new 2048 default so a magic-brush follow-up
    # edit works on an atlas of the same resolution as the mesh's full
    # retexture — the actual inpaint diffusion still runs at the fixed,
    # SDXL-native INPAINT_INFER_SIZE regardless of this value, so raising it
    # costs compositing/resize time only, not extra diffusion compute.
    texture_size: int = Field(default=2048)
    strength: float = Field(default=0.85, ge=0.2, le=1.0)
    feather: int = Field(default=24, ge=1, le=128)
    seed: int = Field(default=0, ge=0)

    @field_validator("texture_size")
    @classmethod
    def validate_size(cls, v: int) -> int:
        if v not in (512, 1024, 2048):
            raise ValueError("texture_size must be 512, 1024, or 2048")
        return v


@app.post("/retexture_region", status_code=202)
async def retexture_region(
    body: RegionTextureRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(...),
) -> dict:
    _require_api_key(authorization)
    if not body.mask_b64 and not body.mask:
        raise HTTPException(status_code=400, detail="a region mask is required (mask_b64 or mask)")
    if not body.prompt and not _parse_hex_color(body.color):
        raise HTTPException(status_code=400, detail="provide a prompt and/or a valid color")
    task_id = str(uuid.uuid4())
    _tasks[task_id] = {
        "task_id": task_id,
        "status": "queued",
        "prompt": body.prompt,
        "kind": "region",
    }
    background_tasks.add_task(
        _process_region,
        task_id,
        body.mesh,
        body.prompt,
        body.negative_prompt,
        body.mask_b64,
        body.mask,
        body.color,
        body.texture_size,
        body.strength,
        body.feather,
        body.seed,
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
        "service": "texture",
        "gpu_available": torch.cuda.is_available(),
        "model_loaded": _pipe is not None,
        "inpaint_loaded": _inpaint_pipe is not None,
    }
