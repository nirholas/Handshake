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
  2. Render depth maps from 8 canonical viewpoints using pyrender
  3. For each view: run SDXL Img2Img + ControlNet-Depth to generate textures
  4. Back-project each generated image onto the mesh UV map (pytorch3d)
  5. Blend overlapping UV regions by confidence (distance-weighted)
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
    texture_size?: int # 512|1024|2048 (default: 1024)
  } → 202 { task_id, status }

  POST /retexture_region {
    mesh: url,          # https GLB URL with an existing texture (required)
    prompt: str,        # what to paint into the region (required unless color set)
    mask_b64?: str,     # UV-space mask PNG, base64 (white = edit). Either this …
    mask?: url,         # … or a public https URL to the mask PNG.
    color?: str,        # optional "#rrggbb" target colour for the region
    negative_prompt?: str,
    texture_size?: int, # 512|1024|2048 working/output atlas size (default: 1024)
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
  WEIGHTS_DIR          — local cache dir for model weights (default: /weights)
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


def _load_pipeline() -> None:
    global _pipe
    from diffusers import StableDiffusionXLControlNetPipeline, ControlNetModel, AutoencoderKL

    log.info("Loading ControlNet model: %s", CONTROLNET_MODEL)
    controlnet = ControlNetModel.from_pretrained(
        CONTROLNET_MODEL,
        torch_dtype=torch.float16,
        use_safetensors=True,
        cache_dir=WEIGHTS_DIR,
    )

    log.info("Loading SDXL model: %s", SDXL_MODEL)
    vae = AutoencoderKL.from_pretrained(
        "madebyollin/sdxl-vae-fp16-fix",
        torch_dtype=torch.float16,
        cache_dir=WEIGHTS_DIR,
    )
    _pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
        SDXL_MODEL,
        controlnet=controlnet,
        vae=vae,
        torch_dtype=torch.float16,
        use_safetensors=True,
        cache_dir=WEIGHTS_DIR,
    )
    _pipe.to("cuda")
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

        log.info("Loading SDXL inpaint model: %s", SDXL_INPAINT_MODEL)
        vae = AutoencoderKL.from_pretrained(
            "madebyollin/sdxl-vae-fp16-fix",
            torch_dtype=torch.float16,
            cache_dir=WEIGHTS_DIR,
        )
        pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
            SDXL_INPAINT_MODEL,
            vae=vae,
            torch_dtype=torch.float16,
            use_safetensors=True,
            cache_dir=WEIGHTS_DIR,
        )
        pipe.to("cuda")
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

def _render_depth(mesh, azimuth_deg: float, elevation_deg: float, size: int = 512) -> Image.Image:
    """Render an orthographic depth map from a given viewpoint."""
    import pyrender
    import trimesh
    import math

    az = math.radians(azimuth_deg)
    el = math.radians(elevation_deg)

    # Camera position on unit sphere
    cx = math.cos(el) * math.sin(az)
    cy = math.sin(el)
    cz = math.cos(el) * math.cos(az)
    dist = mesh.bounding_sphere.primitive.radius * 2.5
    eye = np.array([cx, cy, cz]) * dist + mesh.bounding_sphere.primitive.center

    # Look-at matrix
    up = np.array([0, 1, 0])
    center = mesh.bounding_sphere.primitive.center
    forward = center - eye
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, up)
    right /= np.linalg.norm(right) + 1e-9
    up = np.cross(right, forward)
    camera_pose = np.eye(4)
    camera_pose[:3, 0] = right
    camera_pose[:3, 1] = up
    camera_pose[:3, 2] = -forward
    camera_pose[:3, 3] = eye

    scene = pyrender.Scene(ambient_light=[0.5, 0.5, 0.5])
    py_mesh = pyrender.Mesh.from_trimesh(mesh, smooth=False)
    scene.add(py_mesh)
    camera = pyrender.OrthographicCamera(xmag=dist * 0.6, ymag=dist * 0.6)
    scene.add(camera, pose=camera_pose)

    renderer = pyrender.OffscreenRenderer(size, size)
    try:
        _, depth = renderer.render(scene)
    finally:
        renderer.delete()

    # Normalize depth to [0, 255]
    valid = depth[depth > 0]
    if len(valid) == 0:
        return Image.fromarray(np.zeros((size, size), dtype=np.uint8))
    d_min, d_max = valid.min(), valid.max()
    depth_norm = np.zeros_like(depth, dtype=np.float32)
    mask = depth > 0
    depth_norm[mask] = (depth[mask] - d_min) / (d_max - d_min + 1e-9)
    depth_u8 = (depth_norm * 255).clip(0, 255).astype(np.uint8)
    depth_rgb = np.stack([depth_u8] * 3, axis=-1)
    return Image.fromarray(depth_rgb)


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
    view_images: list[Image.Image],
    viewpoints: list[tuple[float, float]],
    texture_size: int,
) -> Image.Image:
    """
    Back-project each view image onto the mesh UV map using rasterization.
    Blends overlaps by confidence (cos(angle between view direction and face normal)).
    """
    import trimesh
    import math

    uv = mesh.visual.uv  # (N_verts, 2)
    faces = mesh.faces   # (N_faces, 3)
    verts = mesh.vertices

    canvas = np.zeros((texture_size, texture_size, 3), dtype=np.float32)
    weights = np.zeros((texture_size, texture_size), dtype=np.float32)

    for (az_deg, el_deg), view_img in zip(viewpoints, view_images):
        az = math.radians(az_deg)
        el = math.radians(el_deg)
        view_dir = -np.array([
            math.cos(el) * math.sin(az),
            math.sin(el),
            math.cos(el) * math.cos(az),
        ])

        img_arr = np.array(view_img.resize((texture_size, texture_size))).astype(np.float32)

        # For each face, compute confidence = max(0, dot(face_normal, view_dir))
        face_normals = mesh.face_normals
        face_confidence = np.clip(face_normals @ view_dir, 0, 1)

        # For each visible face, scatter view pixels onto UV space
        for fi, (f, conf) in enumerate(zip(faces, face_confidence)):
            if conf < 0.1:
                continue
            # UV coords of the 3 face vertices → pixel coords in texture atlas
            uvs_face = uv[f]  # (3, 2)
            px = (uvs_face[:, 0] * (texture_size - 1)).astype(int).clip(0, texture_size - 1)
            py = ((1 - uvs_face[:, 1]) * (texture_size - 1)).astype(int).clip(0, texture_size - 1)

            # Sample the view image at those projected pixels and write to canvas
            for px_i, py_i in zip(px, py):
                canvas[py_i, px_i] += img_arr[py_i, px_i] * conf
                weights[py_i, px_i] += conf

    # Normalize
    mask = weights > 0
    canvas[mask] /= weights[mask, np.newaxis]
    # Fill gaps with nearest-neighbour
    from scipy.ndimage import distance_transform_edt
    gap = ~mask
    if gap.any():
        _, indices = distance_transform_edt(gap, return_indices=True)
        canvas[gap] = canvas[tuple(indices[:, gap])]

    return Image.fromarray(canvas.clip(0, 255).astype(np.uint8))


# ── Full pipeline ────────────────────────────────────────────────────────────────

def _run_texturing(
    mesh_url: str,
    prompt: str,
    negative_prompt: str,
    num_views: int,
    texture_size: int,
) -> bytes:
    import trimesh

    mesh = _load_mesh(mesh_url)
    viewpoints = VIEWPOINTS_8 if num_views >= 8 else VIEWPOINTS_4

    log.info("Rendering %d depth maps at %dpx", len(viewpoints), texture_size)
    depth_maps = [
        _render_depth(mesh, az, el, size=texture_size)
        for az, el in viewpoints
    ]

    log.info("Generating texture views with SDXL+ControlNet")
    view_images = [
        _generate_view_texture(d, prompt, negative_prompt, texture_size, seed=i * 42)
        for i, d in enumerate(depth_maps)
    ]

    log.info("Projecting views onto UV atlas (%dpx)", texture_size)
    texture_atlas = _project_texture_onto_uv(mesh, view_images, viewpoints, texture_size)

    log.info("Baking textured GLB")
    material = trimesh.visual.material.PBRMaterial(
        baseColorTexture=texture_atlas,
        metallicFactor=0.0,
        roughnessFactor=0.8,
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
) -> None:
    await _run_task(
        task_id,
        lambda: _run_texturing(mesh_url, prompt, negative_prompt, num_views, texture_size),
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

    @field_validator("texture_size")
    @classmethod
    def validate_size(cls, v: int) -> int:
        if v not in (512, 1024, 2048):
            raise ValueError("texture_size must be 512, 1024, or 2048")
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
