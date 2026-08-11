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
import httpx
import mediapipe as mp
import numpy as np
from PIL import Image, ImageFilter
from scipy.interpolate import RBFInterpolator

import glb_ops
import face_geometry
import face_projection
import pygltflib
from worker_security import UnsafeUrlError, fetch_remote_bytes

log = logging.getLogger("face_pipeline")


# ── error classification ───────────────────────────────────────────────────────

class InputError(ValueError):
    """The submitted photos cannot be reconstructed, and no retry will change that.

    Distinct from every other exception the pipeline can raise, because the two
    need opposite treatment. An internal fault is an operator's problem: it is
    logged with a traceback and reported to the caller as an opaque
    correlation id (``worker_security.safe_error``), since its message can carry
    paths, library internals and upstream response fragments.

    An input rejection is the *user's* problem and its message is the only thing
    that lets them fix it. "no face detected in any of the provided photos" is
    safe to hand back verbatim, and the site's job-error mapping keys off exactly
    that wording (`src/create-prompt.js` / `src/forge-studio/create-prompt.js`
    match "face" + "detect" to tell the user to reword their prompt). Routing it
    through the opaque path instead stranded those users on a generic
    "Generation failed", and buried a legitimate rejection in the ERROR log next
    to real outages.
    """


# ── paths ──────────────────────────────────────────────────────────────────────

HERE = Path(__file__).parent
UV_MAP_PATH = HERE / "face_uv_map.json"
TEMPLATES_DIR = HERE / "templates"

# Phase 2: reshape the head to the person's actual face structure (not just paint
# the texture). Default on; set GEOMETRY_MORPH=0 to fall back to texture-only.
GEOMETRY_MORPH_ENABLED = os.environ.get("GEOMETRY_MORPH", "1") != "0"

# Skip the geometry morph (keep texture transfer) above this head yaw. A single
# photo cannot constrain the self-occluded half of a turned face, so MediaPipe's
# depth there is extrapolation and the morph would fit it as bone structure.
#
# 35° is deliberately generous. Benchmark evidence (`eval/adversarial`): the 40
# clean reference faces peak at 2.7°; photos *of* photos — a poster, a phone
# screen, a framed painting — read 9-18° and already produce heads inside the
# real-face displacement band, so they need no blocking; a near-profile shot reads
# 58.6° and is the sole input that pushes the head outside that band. The gate
# therefore clears every genuine frontal by ~13x and still catches the one case
# that measurably misbehaves. Raising it would admit unconstrained geometry;
# lowering it risks rejecting real users, who (unlike this benchmark) do not shoot
# perfect frontals.
MAX_MORPH_YAW_DEG = float(os.environ.get("MAX_MORPH_YAW_DEG", "35"))

# Projective texturing (step 10c). On by default; set PROJECTIVE_TEXTURE=0 to
# fall back to warp-only skin, which is what shipped before this landed.
PROJECTIVE_TEXTURE_ENABLED = os.environ.get("PROJECTIVE_TEXTURE", "1") != "0"

_FACE_MAP: Optional[face_geometry.FaceMap] = None
_FACE_MAP_LOADED = False


def _get_face_map() -> Optional[face_geometry.FaceMap]:
    global _FACE_MAP, _FACE_MAP_LOADED
    if not _FACE_MAP_LOADED:
        _FACE_MAP = face_geometry.FaceMap.load()
        _FACE_MAP_LOADED = True
    return _FACE_MAP

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
        try:
            return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
        except Exception as exc:
            raise InputError("an inline image could not be decoded") from exc
    if src.startswith("https://"):
        # SSRF-hardened: https-only, private/loopback/link-local/metadata IPs
        # rejected after DNS resolution, redirects re-validated per hop, bounded.
        try:
            data = fetch_remote_bytes(src, timeout=30)
        except UnsafeUrlError as exc:
            raise InputError(f"refused to fetch image source: {exc}") from exc
        except httpx.HTTPStatusError as exc:
            # The caller chose this URL, so its status belongs in their message.
            raise InputError(
                f"image source returned HTTP {exc.response.status_code}"
            ) from exc
        except httpx.HTTPError as exc:
            raise InputError(f"could not fetch image source: {type(exc).__name__}") from exc
        try:
            return Image.open(io.BytesIO(data)).convert("RGB")
        except Exception as exc:
            raise InputError("a fetched image could not be decoded") from exc
    raise InputError(f"unsupported image source: {src[:60]}")


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


class _Landmark:
    """Minimal stand-in for a MediaPipe NormalizedLandmark (x, y, z attributes)."""

    __slots__ = ("x", "y", "z")

    def __init__(self, x: float, y: float, z: float):
        self.x, self.y, self.z = x, y, z


def _get_landmarks_small_face(img: Image.Image) -> Optional[list]:
    """
    Rescue pass for images whose face is too small for FaceMesh's built-in
    detector: full-body renders (the text-to-avatar lane generates head-to-feet
    reference images) and selfies taken at a distance. BlazeFace's full-range
    model still finds those small faces; crop around its box with generous
    margin, upscale the crop to a size FaceMesh is reliable at, run FaceMesh on
    the crop, then map the landmarks back to full-image normalised coordinates
    so every downstream consumer (UV warp, skin/hair/eye sampling) is untouched.
    """
    arr = np.array(img)
    with mp.solutions.face_detection.FaceDetection(
        model_selection=1,  # full-range model: small faces in wide shots
        min_detection_confidence=0.3,
    ) as fd:
        det = fd.process(arr)
    if not det.detections:
        return None
    box = max(det.detections, key=lambda d: d.score[0]).location_data.relative_bounding_box

    img_w, img_h = img.size
    # FaceMesh needs forehead / chin / ear context around the raw face box.
    margin = 0.75
    left = int(max(0.0, box.xmin - box.width * margin) * img_w)
    top = int(max(0.0, box.ymin - box.height * margin) * img_h)
    right = int(min(1.0, box.xmin + box.width * (1 + margin)) * img_w)
    bottom = int(min(1.0, box.ymin + box.height * (1 + margin)) * img_h)
    crop_w, crop_h = right - left, bottom - top
    if crop_w < 8 or crop_h < 8:
        return None

    crop = img.crop((left, top, right, bottom))
    scale = 512 / min(crop_w, crop_h)
    if scale > 1.0:
        crop = crop.resize(
            (max(1, round(crop_w * scale)), max(1, round(crop_h * scale))),
            Image.LANCZOS,
        )

    crop_landmarks = _get_landmarks(crop)
    if crop_landmarks is None:
        return None
    # Landmark coords are normalised to the crop; renormalise to the full image.
    # z is normalised by image width like x, so rescale it proportionally (it is
    # only used for the frontality heuristic, never for geometry).
    return [
        _Landmark(
            (left + lm.x * crop_w) / img_w,
            (top + lm.y * crop_h) / img_h,
            lm.z * (crop_w / img_w),
        )
        for lm in crop_landmarks
    ]


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


def _tint_texture(
    base: Image.Image,
    target_rgb: np.ndarray,
    strength: float = 0.35,
    protect_mask: Optional[np.ndarray] = None,
) -> Image.Image:
    """
    Colour-grade a texture toward target_rgb.
    Blends the texture's luminance with target colour at given strength.

    `protect_mask` (float 0..1, texture-shaped) fades the tint out where it is 1.
    Pass the face mask when tinting the skin: the face oval has just been
    composited from the user's actual photograph and is the only region of the
    model carrying true photographic colour, so shifting it toward a *sampled
    average* of itself can only move it away from the truth. The tint exists to
    pull the template's neck/ears/scalp toward the person's complexion — regions
    the camera never saw — and that is exactly where it should apply.
    """
    arr = np.array(base.convert("RGB"), dtype=np.float32)
    mean = arr.mean(axis=(0, 1))
    shift = (target_rgb - mean) * strength
    if protect_mask is not None:
        # Broadcast (h,w) → (h,w,1) so the tint fades smoothly across the mask's
        # feathered edge rather than leaving a hard seam at the oval boundary.
        weight = np.clip(1.0 - protect_mask.astype(np.float32), 0.0, 1.0)[..., None]
        shift = shift * weight
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

    Only `default.glb` ships today, so every body_type resolves to it. A template
    is not just any avatar: the whole pipeline addresses it by name (a
    `Wolf3D_Head` mesh with the 52 ARKit blendshapes, and `Wolf3D_Skin` /
    `Wolf3D_Hair` / `Wolf3D_Eye` materials), and `face_uv_map.json` is
    precomputed against that exact mesh. A GLB without those, or with a different
    head topology, cannot be added to this map without regenerating the UV map
    for it.
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
        # Small-face rescue: full-body renders and distant selfies defeat
        # FaceMesh's detector but not BlazeFace's full-range model. Crop, zoom,
        # and retry on each image until one yields landmarks.
        for idx, img in enumerate(images):
            landmarks = _get_landmarks_small_face(img)
            if landmarks is not None:
                best_img = img
                log.info("[%s] small-face rescue succeeded on image %d", job_id, idx)
                break
    if landmarks is None:
        raise InputError("no face detected in any of the provided photos")
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

    # 8. Skin-tone tint: pull the neck, ears and scalp toward the person's
    # complexion. The face oval the selfie covers is only 10.4% of the head's
    # texels (9.4% of its surface area), so before projective texturing landed
    # this tint was the only thing personalising the other ~90%. Protect the oval
    # itself: those pixels came straight from the photograph, so tinting them
    # toward an average of themselves can only degrade the one region with true
    # photographic colour.
    skin_tone = _extract_skin_tone(img_arr, landmarks, img_w, img_h)
    new_skin = _tint_texture(new_skin, skin_tone, strength=0.25, protect_mask=face_mask_uv)

    # The skin texture is written after the geometry morph (step 10c), because
    # projective texturing needs the head's final shape to know where each texel
    # lands in the photo.

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

    # 10b. Geometry morph — reshape the head to the person's actual face structure
    # (face width, jaw, nose projection, brow), so the avatar reads as the same
    # person rather than the user's texture on a generic head. Runs last because
    # it overwrites POSITION/NORMAL in place; texture edits above already settled
    # the blob. Degrades cleanly to texture-only if the map lacks geometry fields
    # or anything goes wrong — never fails a job over the shape refinement.
    if GEOMETRY_MORPH_ENABLED:
        try:
            fmap = _get_face_map()
            if fmap is not None:
                base_pos, _, faces = glb_ops.get_head_mesh_data(glb)
                detected = face_geometry.landmarks_to_array(
                    landmarks, *best_img.size
                )
                yaw = (
                    face_geometry.estimate_yaw_deg(detected, fmap)
                    if detected.shape[0] >= fmap.canonical_norm.shape[0]
                    else 0.0
                )
                if detected.shape[0] < fmap.canonical_norm.shape[0]:
                    log.warning("[%s] only %d landmarks — skipping geometry morph",
                                job_id, detected.shape[0])
                elif yaw > MAX_MORPH_YAW_DEG:
                    # Too far turned for a single view to constrain the far side of
                    # the face: MediaPipe's depth there is extrapolated, and morphing
                    # would fit that guesswork into the skull. Texture transfer still
                    # works from an angled shot, so keep it and leave the shape alone.
                    log.warning("[%s] head yaw %.1f° > %.0f° — skipping geometry morph, "
                                "keeping texture (single view cannot constrain the "
                                "occluded side)", job_id, yaw, MAX_MORPH_YAW_DEG)
                else:
                    morphed = face_geometry.morph_head_to_landmarks(base_pos, fmap, detected)
                    glb_ops.set_head_geometry(glb, morphed, faces=faces)
                    log.info("[%s] head geometry morphed to face identity, yaw %.1f° (%.1fs)",
                             job_id, yaw, time.time() - t0)
        except Exception as exc:  # noqa: BLE001 — refinement must never fail the job
            log.warning("[%s] geometry morph failed (%s) — keeping template shape",
                        job_id, exc)

    # 10c. Projective texturing: paint the photo onto the ~90% of the head the
    # face-oval warp cannot reach (ears, jawline, neck, forehead to the
    # hairline). Measured on the shipped template, this lifts photographic
    # coverage of the head from 10.4% to 37.5%, a 3.6x increase.
    #
    # Runs after the morph so it projects onto the head's FINAL shape; projecting
    # onto the template and then morphing would slide the texture off the very
    # features it was sampled from. Gated on facing, occlusion and the foreground
    # mask, and blended UNDER the face-oval composite, which stays authoritative
    # where the landmark warp already applies.
    if PROJECTIVE_TEXTURE_ENABLED:
        try:
            positions, mesh_uvs, mesh_faces = glb_ops.get_head_mesh_data(glb)
            normals = glb_ops.recompute_vertex_normals(positions, mesh_faces)
            # Only landmark_vtx is needed here: projection locates the camera and
            # then works off the mesh, so the canonical face map the morph needs
            # is irrelevant and must not gate this stage.
            lm_vtx = uv_map.get("landmark_vtx")
            if lm_vtx:
                lm_idx = np.asarray(lm_vtx, dtype=np.int64)
                # The same isotropic pixel frame the morph aligns in. Passing the
                # image size matters: MediaPipe normalises x by width and y by
                # height, so without it a non-square photo yields an anisotropic
                # cloud and the uniform-scale fit bakes the aspect ratio in.
                detected = face_geometry.landmarks_to_array(landmarks, *best_img.size)
                fg_arr = np.array(fg_img.convert("RGBA"), dtype=np.uint8)
                fg_alpha = fg_arr[:, :, 3].astype(np.float32) / 255.0
                projected = face_projection.project_photo_to_uv(
                    photo_rgb=np.array(fg_img.convert("RGB"), dtype=np.uint8),
                    foreground_mask=fg_alpha,
                    positions=positions,
                    normals=normals,
                    uvs=mesh_uvs,
                    faces=mesh_faces,
                    landmarks_3d=detected,
                    vertex_indices=lm_idx,
                    tex_w=new_skin.width,
                    tex_h=new_skin.height,
                )
                if projected is not None:
                    proj_rgb, proj_weight, proj_covered = projected
                    coverage = face_projection.coverage_fraction(proj_weight, proj_covered)
                    blended = face_projection.blend_projection(
                        np.array(new_skin.convert("RGB"), dtype=np.uint8),
                        proj_rgb,
                        proj_weight,
                        protect=face_mask_uv,
                    )
                    new_skin = Image.fromarray(blended, "RGB")
                    log.info(
                        "[%s] projective texturing painted %.1f%% of the head "
                        "(face-oval warp alone reaches ~10%%) (%.1fs)",
                        job_id, coverage * 100.0, time.time() - t0,
                    )
                else:
                    log.info("[%s] projective texturing skipped: camera fit rejected", job_id)
        except Exception as exc:  # noqa: BLE001 — enrichment must never fail the job
            log.warning("[%s] projective texturing failed (%s) — keeping warp-only skin",
                        job_id, exc)

    glb_ops.set_material_texture(glb, "Wolf3D_Skin", new_skin)

    # 11. Serialize.
    result = glb_ops.save_glb(glb)
    log.info("[%s] pipeline done in %.1fs — %d bytes", job_id, time.time() - t0, len(result))
    return result
