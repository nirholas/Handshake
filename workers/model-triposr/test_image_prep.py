"""Unit tests for the pre-inference path: image_prep.py plus the worker's
auth and SSRF guards in worker_security.py. Pure PIL and stdlib, no GPU, no
model runtime, no network egress. Runs locally and as a Docker build gate:

    python3 workers/model-triposr/test_image_prep.py

These pin two failures that reached production. 2026-07-08: background removal
handed TripoSR a 4-channel RGBA tensor and every job died with "size of tensor
a (4) must match the size of tensor b (3)" (fixed by flattening onto the
mid-gray matte). And the SSRF guard, which is the only thing standing between
a caller-supplied `images` URL and the Cloud Run metadata server.
"""

from __future__ import annotations

import base64
import io
import sys

from PIL import Image

from image_prep import (
    MATTE_FILL,
    decode_data_uri,
    decode_image,
    flatten_to_rgb,
    mesh_blob_name,
    mesh_public_url,
    open_rgb,
)
from worker_security import UnsafeUrlError, assert_safe_url, require_api_key

PASS = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS
    if not condition:
        print(f"FAIL  {name}  {detail}")
        sys.exit(1)
    PASS += 1
    print(f"ok    {name}")


def raises(exc_type, fn, *args, **kwargs) -> bool:
    try:
        fn(*args, **kwargs)
    except exc_type:
        return True
    except Exception:
        return False
    return False


def png_bytes(mode: str, size=(8, 8), color=(200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new(mode, size, color).save(buf, format="PNG")
    return buf.getvalue()


def data_uri(payload: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(payload).decode("ascii")


def refuse_fetch(url: str) -> bytes:
    raise AssertionError(f"decode_image reached the network for {url}")


# ── decoding ────────────────────────────────────────────────────────────────

img = decode_image(data_uri(png_bytes("RGB")), fetch=refuse_fetch)
check("data URI decodes to RGB", img.mode == "RGB", img.mode)
check("data URI keeps its size", img.size == (8, 8), str(img.size))

rgba_uri = data_uri(png_bytes("RGBA", color=(10, 20, 30, 255)))
check(
    "RGBA data URI is converted on decode",
    decode_image(rgba_uri, fetch=refuse_fetch).mode == "RGB",
)

check(
    "http:// is refused without a fetch",
    raises(ValueError, decode_image, "http://example.com/a.png", fetch=refuse_fetch),
)
check(
    "file path is refused",
    raises(ValueError, decode_image, "/etc/passwd", fetch=refuse_fetch),
)
check(
    "gs:// is refused",
    raises(ValueError, decode_image, "gs://bucket/a.png", fetch=refuse_fetch),
)
check(
    "https:// is routed to the injected fetcher",
    decode_image(
        "https://example.invalid/a.png", fetch=lambda _url: png_bytes("RGB")
    ).mode
    == "RGB",
)

check(
    "non-base64 data URI is refused",
    raises(ValueError, decode_data_uri, "data:image/png,rawbytes"),
)
check(
    "truncated base64 is refused",
    raises(ValueError, decode_data_uri, "data:image/png;base64,!!!!"),
)
check("payload-less data URI is refused", raises(ValueError, decode_data_uri, "data:image/png"))
check("garbage bytes are refused", raises(ValueError, open_rgb, b"not-an-image"))

# ── matting (the 2026-07-08 regression) ─────────────────────────────────────

cutout = Image.new("RGBA", (4, 2), (0, 0, 0, 0))
cutout.putpixel((0, 0), (250, 40, 60, 255))
flat = flatten_to_rgb(cutout)
check("matted image is 3-channel RGB", flat.mode == "RGB", flat.mode)
check("matted image keeps its size", flat.size == (4, 2), str(flat.size))
check("subject pixel survives matting", flat.getpixel((0, 0)) == (250, 40, 60), str(flat.getpixel((0, 0))))
check(
    "removed background becomes the mid-gray matte",
    flat.getpixel((3, 1)) == MATTE_FILL,
    str(flat.getpixel((3, 1))),
)

half = Image.new("RGBA", (2, 1), (0, 200, 0, 128))
blended = flatten_to_rgb(half).getpixel((0, 0))
check(
    "semi-transparent pixels blend toward the matte",
    blended != (0, 200, 0) and all(0 <= c <= 255 for c in blended),
    str(blended),
)

opaque = Image.new("RGB", (3, 3), (1, 2, 3))
kept = flatten_to_rgb(opaque)
check("an RGB frame passes through unmatted", kept.mode == "RGB" and kept.getpixel((1, 1)) == (1, 2, 3))
check("a grayscale frame is converted, not rejected", flatten_to_rgb(Image.new("L", (2, 2), 90)).mode == "RGB")
check("an LA frame is matted", flatten_to_rgb(Image.new("LA", (2, 2), (90, 0))).getpixel((0, 0)) == MATTE_FILL)

# ── output naming (the contract the controller polls) ───────────────────────

check(
    "blob name is namespaced per model",
    mesh_blob_name("abc-123") == "raw-meshes/triposr/abc-123.glb",
    mesh_blob_name("abc-123"),
)
check("empty task id is refused", raises(ValueError, mesh_blob_name, ""))
check(
    "result url points at the output bucket",
    mesh_public_url("three-ws-avatar-reconstructions", mesh_blob_name("t1"))
    == "https://storage.googleapis.com/three-ws-avatar-reconstructions/raw-meshes/triposr/t1.glb",
)

# ── auth ────────────────────────────────────────────────────────────────────

require_api_key("Bearer s3cret", "s3cret")
PASS += 1
print("ok    valid bearer token is accepted")

check("wrong token is rejected", raises(PermissionError, require_api_key, "Bearer nope", "s3cret"))
check("missing header is rejected", raises(PermissionError, require_api_key, None, "s3cret"))
check("bare token without the scheme is rejected", raises(PermissionError, require_api_key, "s3cret", "s3cret"))
check("basic auth is rejected", raises(PermissionError, require_api_key, "Basic s3cret", "s3cret"))

# ── SSRF guard ──────────────────────────────────────────────────────────────

check("cleartext http is refused", raises(UnsafeUrlError, assert_safe_url, "http://example.com/a.png"))
check("file scheme is refused", raises(UnsafeUrlError, assert_safe_url, "file:///etc/passwd"))
check("loopback is refused", raises(UnsafeUrlError, assert_safe_url, "https://127.0.0.1/a.png"))
check("localhost is refused", raises(UnsafeUrlError, assert_safe_url, "https://localhost/a.png"))
check(
    "the GCP metadata server is refused",
    raises(UnsafeUrlError, assert_safe_url, "https://169.254.169.254/computeMetadata/v1/"),
)
check("RFC1918 addresses are refused", raises(UnsafeUrlError, assert_safe_url, "https://10.128.0.7/a.png"))
check("IPv6 loopback is refused", raises(UnsafeUrlError, assert_safe_url, "https://[::1]/a.png"))
check(
    "an IPv4-mapped private address is refused",
    raises(UnsafeUrlError, assert_safe_url, "https://[::ffff:10.0.0.1]/a.png"),
)
check("a hostless url is refused", raises(UnsafeUrlError, assert_safe_url, "https:///a.png"))

print(f"\n{PASS} checks passed")
