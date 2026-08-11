"""
Image preparation for the TripoSR worker: decode, matte, and output naming.

Deliberately free of torch, FastAPI and google-cloud so the whole pre-inference
path can run on a CPU box and be gated at Docker build time (see
test_image_prep.py). main.py is the only caller; it supplies the SSRF-hardened
fetcher from worker_security so this module never opens a socket itself.
"""

from __future__ import annotations

import base64
import binascii
import io
from typing import Callable

from PIL import Image, UnidentifiedImageError

# TripoSR's tokenizer normalizes with a 3-channel mean/std (tsr/models/
# tokenizers/image.py) and errors on a 4-channel RGBA tensor ("size of tensor a
# (4) must match ... b (3)"). Upstream's demo (run.py) fills the matted-out
# background with mid-gray before flattening to RGB; MATTE_FILL is that gray.
MATTE_FILL = (127, 127, 127)

BLOB_PREFIX = "raw-meshes/triposr"


def decode_data_uri(src: str) -> bytes:
    """Return the bytes carried by a ``data:image/...;base64,...`` URI."""
    if "," not in src:
        raise ValueError("malformed data URI: no payload separator")
    header, payload = src.split(",", 1)
    if "base64" not in header:
        raise ValueError("unsupported data URI: only base64 payloads are accepted")
    try:
        return base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("malformed data URI: payload is not valid base64") from exc


def open_rgb(data: bytes) -> Image.Image:
    """Decode image bytes to an RGB PIL image, or raise ValueError."""
    try:
        return Image.open(io.BytesIO(data)).convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("image bytes could not be decoded") from exc


def decode_image(src: str, *, fetch: Callable[[str], bytes]) -> Image.Image:
    """Turn one caller-supplied image source into an RGB image.

    ``data:image/...`` URIs are decoded in-process. ``https://`` URLs are handed
    to ``fetch``, which main.py binds to the SSRF-hardened fetcher in
    worker_security (https-only, private/loopback/link-local/metadata IPs
    rejected after DNS, redirects re-validated per hop, bounded body). Every
    other scheme is refused here rather than reaching the network at all.
    """
    if src.startswith("data:image"):
        return open_rgb(decode_data_uri(src))
    if src.startswith("https://"):
        return open_rgb(fetch(src))
    raise ValueError(f"unsupported image source: {src[:60]}")


def flatten_to_rgb(img: Image.Image, fill: tuple[int, int, int] = MATTE_FILL) -> Image.Image:
    """Composite ``img`` onto a flat ``fill`` background and return RGB.

    Background removal yields RGBA; feeding that straight to TripoSR raises a
    channel-count error, so the alpha is resolved here. Images with no alpha
    are converted, not composited.
    """
    if img.mode not in ("RGBA", "LA", "PA"):
        return img.convert("RGB")
    rgba = img.convert("RGBA")
    background = Image.new("RGB", rgba.size, fill)
    background.paste(rgba, mask=rgba.split()[3])
    return background


def mesh_blob_name(task_id: str) -> str:
    """Object name of the GLB this task uploads, inside the output bucket."""
    if not task_id:
        raise ValueError("task_id is required")
    return f"{BLOB_PREFIX}/{task_id}.glb"


def mesh_public_url(bucket: str, blob_name: str) -> str:
    """Public https URL of an uploaded object, as returned in result_gcs_url."""
    return f"https://storage.googleapis.com/{bucket}/{blob_name}"
