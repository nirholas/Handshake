"""
Selfie → Wolf3D GLB pipeline (Phase 1: face texture transfer).

Steps:
  1. Decode and select the best frontal photo.
  2. Background removal (rembg).
  3. MediaPipe FaceLandmarker → 468 normalised (x, y) landmarks.
  4. Load pre-computed UV map (face_uv_map.json).
  5. TPS warp: map user's face into Wolf3D_Skin texture UV space.
  6. Composite warped face onto existing skin texture using face-oval alpha mask.
  7. Extract dominant skin tone → tint the unmasked skin regions for consistency.
  8. Extract dominant hair colour → tint Wolf3D_Hair texture.
  9. Detect eye colour → adjust Wolf3D_Eye baseColorFactor.
 10. Return modified GLB bytes.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

import cv2
import mediapipe as mp
import numpy as np
import requests
from PIL import Image, ImageFilter
from scipy.interpolate import RBFInterpolator

import glb_ops
import pygltflib

log = logging.getLogger("face_pipeline")

# ── paths ──────────────────────────────────────────────────────────────────────

HERE = Path(__file__).parent
UV_MAP_PATH = HERE / "face_uv_map.json"
TEMPLATES_DIR = HERE / "templates"

# ── MediaPipe setup ────────────────────────────────────────────────────────────

_mp_face_mesh = mp.solutions.face_mesh

# The 36 landmark indices that form the face oval in MediaPipe's topology.
_FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
    397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
    172,  58, 132,  93, 234, 127, 162,  21,  54, 103,  67, 109,
]

# ── UV map (loaded once at module import) ──────────────────────────────────────

def _load_uv_map() -> dict:
    if not UV_MAP_PATH.exists():
        raise FileNotFoundError(
            f"face_uv_map.json not found at {UV_MAP_PATH}. "
            "Run precompute_uv.py during Docker build."
        )
    return json.loads(UV_MAP_PATH.read_text())


_UV_MAP: Optional[dict] = None


def _get_uv_map() -> dict:
    global _UV_MAP
    if _UV_MAP is None:
        _UV_MAP = _load_uv_map()
    return _UV_MAP


# ── image decoding ─────────────────────────────────────────────────────────────

def _decode_image(src: str) -> Image.Image:
    if src.startswith("data:image"):
        b64 = src.split(",", 1)[1]
        return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
    if src.startswith("http://") or src.startswith("https://"):
        resp = requests.get(src, timeout=30)
        resp.raise_for_status()
        return Image.open(io.BytesIO(resp.content)).convert("RGB")
    raise ValueError(f"unsupported image source: {src[:60]}")


def _select_best_photo(images: list[Image.Image]) -> tuple[Image.Image, list]:
    """
    Run MediaPipe on each image and return the one with the largest,
    most frontal face (highest detection confidence, closest to neutral pose).
    Also returns the face landmarks for the selected image.
    """
    best_img = images[0]
    best_landmarks = None
    best_score = -1.0

    with _mp_face_mesh.FaceMesh(
        static_image_mode=True,
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.4,
    ) as fm:
        for img in images:
            arr = np.array(img)
            result = fm.process(arr)
            if not result.multi_face_landmarks:
                continue
            lm = result.multi_face_landmarks[0].landmark

            # Face size heuristic: bounding box area in image coords.
            xs = [l.x for l in lm]
            ys = [l.y for l in lm]
            area = (max(xs) - min(xs)) * (max(ys) - min(ys))

            # Frontality heuristic: nose tip z should be near 0 (facing camera).
            nose_z = abs(lm[4].z)  # landmark 4 = nose tip
            frontality = 1.0 / (1.0 + nose_z * 10)

            score = area * frontality
            if score > best_score:
                best_score = score
                best_img = img
                best_landmarks = lm

    return best_img, best_landmarks


def _get_landmarks(img: Image.Image) -> Optional[list]:
    """Run MediaPipe on a single image, return landmark list or None."""
    with _mp_face_mesh.FaceMesh(
        static_image_mode=True,
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.4,
    ) as fm:
        result = fm.process(np.array(img))
        if result.multi_face_landmarks:
            return result.multi_face_landmarks[0].landmark
    return None


# ── background removal ─────────────────────────────────────────────────────────

def _remove_background(img: Image.Image) -> Image.Image:
    """Return RGBA image with background removed."""
    try:
        import rembg
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        out = rembg.remove(buf.getvalue())
        return Image.open(io.BytesIO(out)).convert("RGBA")
    except Exception as exc:
        log.warning("rembg failed (%s) — using original image", exc)
        return img.convert("RGBA")


# ── face oval mask ─────────────────────────────────────────────────────────────

def _make_face_oval_mask(landmarks: list, img_w: int, img_h: int) -> np.ndarray:
    """
    Build a soft alpha mask (H×W float32, 0–1) around the face oval.
    Hard boundary at the oval, feathered inward by ~2% of image width.
    """
    pts = np.array(
        [[int(landmarks[i].x * img_w), int(landmarks[i].y * img_h)] for i in _FACE_OVAL],
        dtype=np.int32,
    )
    mask = np.zeros((img_h, img_w), dtype=np.uint8)
    cv2.fillPoly(mask, [pts], 255)

    # Feather: erode then blur.
    kernel_px = max(3, int(img_w * 0.015))
    if kernel_px % 2 == 0:
        kernel_px += 1
    kernel = np.ones((kernel_px, kernel_px), np.uint8)
    mask = cv2.erode(mask, kernel, iterations=1)
    mask = cv2.GaussianBlur(mask, (kernel_px * 2 + 1, kernel_px * 2 + 1), 0)
    return mask.astype(np.float32) / 255.0


# ── colour analysis ────────────────────────────────────────────────────────────

def _dominant_colour(img_rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Return the mean RGB colour of pixels where mask > 0.5."""
    m = mask > 0.5
    if m.sum() == 0:
        return np.array([200, 170, 140], dtype=np.float32)
    pixels = img_rgb[m]
    return pixels.mean(axis=0)


def _extract_skin_tone(img_rgb: np.ndarray, landmarks: list, img_w: int, img_h: int) -> np.ndarray:
    """
    Sample skin colour from cheek and forehead regions (avoids eyes & mouth).
    Returns mean RGB as float32 array.
    """
    # Cheek + forehead landmark indices (see precompute_uv.py SKIN_SAMPLE_INDICES).
    sample_indices = [
        116, 117, 118, 119, 120, 121, 50,
        345, 346, 347, 348, 349, 350, 280,
        10, 9, 8, 107, 336,
    ]
    pts = [(int(landmarks[i].x * img_w), int(landmarks[i].y * img_h)) for i in sample_indices]
    mask = np.zeros((img_h, img_w), dtype=np.float32)
    for (x, y) in pts:
        cv2.circle(mask, (x, y), max(4, img_w // 60), 1.0, -1)
    mask = cv2.GaussianBlur(mask, (15, 15), 0)
    return _dominant_colour(img_rgb, mask)


def _extract_hair_colour(img_rgb: np.ndarray, landmarks: list, img_w: int, img_h: int) -> np.ndarray:
    """Sample the region above the forehead to get hair colour."""
    top_y = int(min(landmarks[i].y for i in [10, 21, 251]) * img_h)
    strip_h = max(20, top_y // 3)
    strip = img_rgb[max(0, top_y - strip_h) : top_y, :]
    if strip.size == 0:
        return np.array([80, 60, 40], dtype=np.float32)
    return strip.reshape(-1, 3).mean(axis=0)


def _extract_eye_colour(img_rgb: np.ndarray, landmarks: list, img_w: int, img_h: int) -> np.ndarray:
    """Sample the iris region of the left eye."""
    # Landmark 468 = left iris centre (requires refine_landmarks=True).
    # Fall back to landmark 33 (left eye inner corner) if iris not available.
    try:
        lx = int(landmarks[468].x * img_w)
        ly = int(landmarks[468].y * img_h)
    except IndexError:
        lx = int(landmarks[33].x * img_w)
        ly = int(landmarks[33].y * img_h)
    r = max(4, img_w // 80)
    patch = img_rgb[max(0, ly - r): ly + r, max(0, lx - r): lx + r]
    if patch.size == 0:
        return np.array([100, 130, 160], dtype=np.float32)
    return patch.reshape(-1, 3).mean(axis=0)


def _tint_texture(base: Image.Image, target_rgb: np.ndarray, strength: float = 0.35) -> Image.Image:
    """
    Colour-grade a texture toward target_rgb.
    Blends the texture's luminance with target colour at given strength.
    """
    arr = np.array(base.convert("RGB"), dtype=np.float32)
    mean = arr.mean(axis=(0, 1))
    shift = (target_rgb - mean) * strength
    tinted = np.clip(arr + shift, 0, 255).astype(np.uint8)
    return Image.fromarray(tinted)


# ── TPS face warp ──────────────────────────────────────────────────────────────

def _warp_face_to_uv(
    face_img: Image.Image,
    landmarks: list,
    uv_map: dict,
) -> tuple[Image.Image, np.ndarray]:
    """
    Warp the user's face photo into Wolf3D_Skin UV texture space using TPS.

    Returns:
        warped_face  — PIL Image (tex_w × tex_h, RGBA) with the face in UV space.
        face_mask_uv — float32 mask (tex_h × tex_w) indicating valid face pixels.
    """
    tex_w = uv_map["texture_width"]
    tex_h = uv_map["texture_height"]
    lm_data = uv_map["landmarks"]
    oval_indices = uv_map["face_oval_indices"]

    img_w, img_h = face_img.size
    img_arr = np.array(face_img.convert("RGBA"), dtype=np.float32)

    # Build control point arrays.
    # Source: landmark positions in user's IMAGE space (pixel coords).
    # Dest  : corresponding positions in UV TEXTURE space (pixel coords).
    src_pts = []  # image pixel coords
    dst_pts = []  # texture pixel coords

    for idx, entry in enumerate(lm_data):
        lm = landmarks[idx]
        src_pts.append([lm.x * img_w, lm.y * img_h])
        dst_pts.append([entry["px"], entry["py"]])

    src_pts = np.array(src_pts, dtype=np.float64)
    dst_pts = np.array(dst_pts, dtype=np.float64)

    # TPS: for each UV pixel, find corresponding image pixel.
    # We train TPS in the direction UV→Image (inverse warp for texture sampling).
    tps_uv_to_img = RBFInterpolator(dst_pts, src_pts, kernel="thin_plate_spline", smoothing=0.5)

    # Build a grid of UV pixel centres to sample.
    # Only sample within the bounding box of the face-oval landmarks in UV space.
    oval_uv = np.array([[lm_data[i]["px"], lm_data[i]["py"]] for i in oval_indices])
    x_min, y_min = oval_uv.min(axis=0)
    x_max, y_max = oval_uv.max(axis=0)
    margin = int(tex_w * 0.02)
    x_min = max(0, int(x_min) - margin)
    x_max = min(tex_w, int(x_max) + margin)
    y_min = max(0, int(y_min) - margin)
    y_max = min(tex_h, int(y_max) + margin)

    gy, gx = np.mgrid[y_min:y_max, x_min:x_max]
    grid_pts = np.stack([gx.ravel().astype(np.float64), gy.ravel().astype(np.float64)], axis=1)

    img_coords = tps_uv_to_img(grid_pts)  # (n, 2) — x, y in image space
    img_x = img_coords[:, 0].reshape(gy.shape)
    img_y = img_coords[:, 1].reshape(gy.shape)

    # Sample face image at computed coordinates (bilinear).
    map_x = img_x.astype(np.float32)
    map_y = img_y.astype(np.float32)
    face_np = np.array(face_img.convert("RGBA"), dtype=np.uint8)
    warped_patch = cv2.remap(
        face_np, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT
    )

    # Build face-oval mask in UV space.
    oval_uv_pts = oval_uv.astype(np.int32)
    face_mask_uv = np.zeros((tex_h, tex_w), dtype=np.float32)
    cv2.fillPoly(face_mask_uv, [oval_uv_pts], 1.0)

    # Feather the mask.
    k = max(3, int(tex_w * 0.015)) | 1  # ensure odd
    face_mask_uv = cv2.GaussianBlur(face_mask_uv, (k * 4 + 1, k * 4 + 1), 0)

    # Composite warped patch into a full-texture canvas.
    warped_full = np.zeros((tex_h, tex_w, 4), dtype=np.uint8)
    warped_full[y_min:y_max, x_min:x_max] = warped_patch

    return Image.fromarray(warped_full, "RGBA"), face_mask_uv


def _composite_face_onto_skin(
    skin_tex: Image.Image,
    warped_face: Image.Image,
    face_mask_uv: np.ndarray,
) -> Image.Image:
    """
    Alpha-composite the warped face onto the existing Wolf3D_Skin texture
    using the face-oval mask.  Preserves neck/hand regions completely.
    """
    skin_arr = np.array(skin_tex.convert("RGB"), dtype=np.float32)
    face_arr = np.array(warped_face.convert("RGB"), dtype=np.float32)

    mask3 = face_mask_uv[:, :, np.newaxis]  # broadcast over channels
    composited = skin_arr * (1.0 - mask3) + face_arr * mask3
    return Image.fromarray(np.clip(composited, 0, 255).astype(np.uint8))


# ── template loading ───────────────────────────────────────────────────────────

def _load_template(body_type: str) -> bytes:
    """
    Load the appropriate template GLB.
    body_type: 'male' | 'female' | 'neutral' (default).
    """
    candidates = {
        "male":    TEMPLATES_DIR / "male.glb",
        "female":  TEMPLATES_DIR / "female.glb",
        "neutral": TEMPLATES_DIR / "default.glb",
    }
    path = candidates.get(body_type, TEMPLATES_DIR / "default.glb")
    if not path.exists():
        path = TEMPLATES_DIR / "default.glb"
    return path.read_bytes()


# ── main pipeline ──────────────────────────────────────────────────────────────

def process(
    job_id: str,
    image_sources: list[str],
    body_type: str = "neutral",
) -> bytes:
    """
    Full selfie → rigged GLB pipeline.

    Args:
        job_id:        Identifier used for logging.
        image_sources: List of image data URIs or HTTPS URLs (1–6 items).
        body_type:     'male' | 'female' | 'neutral'.

    Returns:
        GLB file bytes ready to upload to GCS.
    """
    t0 = time.time()
    log.info("[%s] starting pipeline (body_type=%s, images=%d)", job_id, body_type, len(image_sources))

    # 1. Decode images.
    images = [_decode_image(s) for s in image_sources]
    log.info("[%s] decoded %d images (%.1fs)", job_id, len(images), time.time() - t0)

    # 2. Select best frontal photo and get its landmarks.
    best_img, landmarks = _select_best_photo(images)
    if landmarks is None:
        # No face detected in any image — try harder on the first image.
        landmarks = _get_landmarks(images[0])
    if landmarks is None:
        raise ValueError("no face detected in any of the provided photos")
    log.info("[%s] face selected (%.1fs)", job_id, time.time() - t0)

    img_w, img_h = best_img.size
    img_arr = np.array(best_img.convert("RGB"))

    # 3. Background removal.
    fg_img = _remove_background(best_img)
    log.info("[%s] background removed (%.1fs)", job_id, time.time() - t0)

    # 4. Load UV map.
    uv_map = _get_uv_map()

    # 5. Warp face into UV space.
    warped_face, face_mask_uv = _warp_face_to_uv(fg_img, landmarks, uv_map)
    log.info("[%s] face warped to UV space (%.1fs)", job_id, time.time() - t0)

    # 6. Load template GLB.
    glb_bytes = _load_template(body_type)
    glb = glb_ops.load_glb(glb_bytes)

    # 7. Get existing skin texture and composite.
    skin_tex = glb_ops.get_material_texture(glb, "Wolf3D_Skin")
    if skin_tex is None:
        raise ValueError("Wolf3D_Skin material or texture not found in template GLB")

    new_skin = _composite_face_onto_skin(skin_tex, warped_face, face_mask_uv)
    log.info("[%s] face composited onto skin texture (%.1fs)", job_id, time.time() - t0)

    # 8. Skin-tone tint: ensure neck/hands roughly match face colour.
    skin_tone = _extract_skin_tone(img_arr, landmarks, img_w, img_h)
    new_skin = _tint_texture(new_skin, skin_tone, strength=0.25)

    glb_ops.set_material_texture(glb, "Wolf3D_Skin", new_skin)

    # 9. Hair colour tint.
    hair_colour = _extract_hair_colour(img_arr, landmarks, img_w, img_h)
    hair_tex = glb_ops.get_material_texture(glb, "Wolf3D_Hair")
    if hair_tex:
        tinted_hair = _tint_texture(hair_tex, hair_colour, strength=0.6)
        glb_ops.set_material_texture(glb, "Wolf3D_Hair", tinted_hair)

    # 10. Eye colour — adjust baseColorFactor of Wolf3D_Eye material.
    eye_colour = _extract_eye_colour(img_arr, landmarks, img_w, img_h)
    eye_rgb_norm = (eye_colour / 255.0).tolist()
    glb_ops.set_material_base_color(glb, "Wolf3D_Eye", eye_rgb_norm + [1.0])

    # 11. Serialize.
    result = glb_ops.save_glb(glb)
    log.info("[%s] pipeline done in %.1fs — %d bytes", job_id, time.time() - t0, len(result))
    return result
