"""Core-path smoke test: runs a real cutout through the real models.

    API_KEY=x GCS_BUCKET=x python3 workers/rembg/test_rembg_smoke.py

Needs the deps from requirements.txt and the ONNX weights in ~/.u2net (the
Docker image bakes both, and runs this file as a build gate), but no GPU, no
network and no GCP credentials: it exercises decode plus removal, not upload.

It builds a subject on a plain background, removes the background with both
baked-in models, and asserts the corners came back transparent while the
subject stayed opaque. That is the whole product in four lines, and it is what
silently breaks when a model name, a weights path, or the image handoff to
rembg regresses.
"""

from __future__ import annotations

import base64
import io
import os
import sys
import time

os.environ.setdefault("API_KEY", "smoke-test")
os.environ.setdefault("GCS_BUCKET", "smoke-test")

from PIL import Image, ImageDraw  # noqa: E402

import main  # noqa: E402
from rembg_policy import SourceImageError  # noqa: E402

PASS = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS
    if not condition:
        print(f"FAIL  {name}  {detail}")
        sys.exit(1)
    PASS += 1
    print(f"ok    {name}")


def subject_on_plain_background(size=(640, 480)) -> Image.Image:
    """A head-and-shoulders silhouette: enough salience for the detectors to
    find a subject, with corners that are unambiguously background."""
    img = Image.new("RGB", size, (232, 236, 240))
    draw = ImageDraw.Draw(img)
    draw.ellipse([220, 60, 420, 250], fill=(198, 86, 60))
    draw.rounded_rectangle([190, 240, 450, 460], radius=40, fill=(44, 90, 156))
    return img


source = subject_on_plain_background()

# ── decode ──────────────────────────────────────────────────────────────────

buf = io.BytesIO()
source.save(buf, format="PNG")
data_uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
decoded = main._decode_image(data_uri)
check("data URI decodes to RGBA", decoded.mode == "RGBA", decoded.mode)
check("data URI keeps the source size", decoded.size == source.size, str(decoded.size))

for bad, label in (
    ("data:image/png;base64,not-base64!!", "invalid base64"),
    ("data:image/png;base64," + base64.b64encode(b"plain text, not an image").decode(), "non-image bytes"),
    ("ftp://example.com/cat.png", "unsupported scheme"),
):
    try:
        main._decode_image(bad)
        check(f"{label} is rejected", False, "no error raised")
    except SourceImageError as exc:
        check(f"{label} is rejected with a caller-readable reason", bool(str(exc)), str(exc))

# ── removal, on every model the image bakes in ──────────────────────────────

for model in ("isnet-general-use", "u2net"):
    started = time.time()
    cut = main._run_removal(decoded, model)
    elapsed = time.time() - started

    check(f"{model}: returns an image", isinstance(cut, Image.Image), type(cut).__name__)
    check(f"{model}: returns RGBA", cut.mode == "RGBA", cut.mode)
    check(f"{model}: preserves the source size", cut.size == source.size, str(cut.size))

    corners = [
        cut.getpixel((0, 0))[3],
        cut.getpixel((cut.width - 1, 0))[3],
        cut.getpixel((0, cut.height - 1))[3],
        cut.getpixel((cut.width - 1, cut.height - 1))[3],
    ]
    check(f"{model}: corners are transparent", max(corners) <= 16, str(corners))

    subject_alpha = cut.getpixel((320, 150))[3]
    check(f"{model}: the subject stays opaque", subject_alpha >= 200, str(subject_alpha))

    alpha = cut.getchannel("A").histogram()
    check(f"{model}: the cutout is not all-or-nothing",
          alpha[0] > 0 and sum(alpha[200:]) > 0,
          f"transparent={alpha[0]} opaque={sum(alpha[200:])}")

    # The result is what gets uploaded; make sure it survives a PNG round trip
    # with its alpha intact rather than flattening to an opaque rectangle.
    out = io.BytesIO()
    cut.save(out, format="PNG")
    reopened = Image.open(io.BytesIO(out.getvalue()))
    check(f"{model}: PNG round trip keeps the alpha channel",
          reopened.mode == "RGBA" and reopened.getpixel((0, 0))[3] <= 16,
          reopened.mode)

    print(f"      {model}: {elapsed:.2f}s at {cut.width}x{cut.height}")

check("both models are cached after use", set(main._sessions) == {"isnet-general-use", "u2net"},
      str(sorted(main._sessions)))

print(f"\n{PASS} checks passed")
