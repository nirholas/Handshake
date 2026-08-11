"""Smoke test for the served contract, run INSIDE the built image (it needs
torch, diffusers, FastAPI, and the cloned TripoSG tree on PYTHONPATH):

    docker build -t model-triposg workers/model-triposg
    docker run --rm model-triposg python3 test_app_contract.py

It needs no GPU, no weights, and no GCP credentials: the ASGI lifespan (which
opens the GCS client and starts the model load) is deliberately not run, so
every assertion below is about request handling, not inference.

What it proves, and why each line earns its place:

  1. The whole import chain resolves. Revisions 00001 and 00002 of this service
     died at import time on a bad transitive resolve of transformers / diffusers
     / peft, crashing before the container could bind $PORT, which reads as an
     opaque Cloud Run startup-probe failure. Importing the two pipelines and the
     preprocessing helpers here turns that into a build-time test failure.
  2. The auth boundary rejects a wrong bearer on both authenticated routes.
  3. The scribble prompt gate returns 422 instead of silently generating a blob.
  4. The unauthenticated probe surfaces (/ and /health) answer, which is what
     the platform's liveness probes read.
  5. The real sketch preprocessing flattens alpha onto white, and the image
     fetcher refuses a non-https or private-network source (the SSRF guard).
"""

from __future__ import annotations

import base64
import io
import os
import sys

os.environ.setdefault("API_KEY", "smoke-test-key")
os.environ.setdefault("GCS_BUCKET", "smoke-test-bucket")

KEY = os.environ["API_KEY"]

PASSED = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED
    if not condition:
        print(f"FAIL  {name}  {detail}")
        sys.exit(1)
    PASSED += 1
    print(f"ok    {name}")


def png_data_uri(color=(20, 20, 20, 255), size=(24, 24)) -> str:
    from PIL import Image

    img = Image.new("RGBA", size, color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def main() -> int:
    # 1. Import chain: the pipelines and preprocessing helpers the loader uses.
    from triposg.pipelines.pipeline_triposg import TripoSGPipeline
    from triposg.pipelines.pipeline_triposg_scribble import TripoSGScribblePipeline
    from briarmbg import BriaRMBG
    from image_process import prepare_image

    check("triposg pipelines import", all(
        callable(getattr(cls, "from_pretrained", None))
        for cls in (TripoSGPipeline, TripoSGScribblePipeline)
    ))
    check("preprocessing helpers import", callable(prepare_image) and BriaRMBG is not None)

    import main as service
    from fastapi.testclient import TestClient

    client = TestClient(service.app)
    auth = {"authorization": f"Bearer {KEY}"}

    # 2. Unauthenticated probe surfaces.
    root = client.get("/")
    check("GET / is 200", root.status_code == 200, root.text)
    check("GET / names the service", root.json()["service"] == "model-triposg", root.text)
    check("GET / lists both modes", root.json()["modes"] == ["image", "scribble"], root.text)

    health = client.get("/health")
    check("GET /health is 200", health.status_code == 200, health.text)
    body = health.json()
    check("health reports ok with no load error", body["ok"] is True and body["load_error"] is None, health.text)
    check("health reports not-ready before the load", body["ready"] is False, health.text)
    check("health reports gpu availability", isinstance(body["gpu_available"], bool), health.text)

    # 3. Auth boundary.
    bad = client.post("/infer", json={"images": [png_data_uri()]}, headers={"authorization": "Bearer wrong"})
    check("POST /infer rejects a wrong bearer", bad.status_code == 401, bad.text)
    bad_task = client.get("/tasks/whatever", headers={"authorization": "Bearer wrong"})
    check("GET /tasks rejects a wrong bearer", bad_task.status_code == 401, bad_task.text)

    # 4. Request validation, all of it decided before any GPU or GCS work.
    no_prompt = client.post(
        "/infer", json={"images": [png_data_uri()], "mode": "scribble"}, headers=auth
    )
    check("scribble without a prompt is 422", no_prompt.status_code == 422, no_prompt.text)
    check(
        "the 422 explains the prompt gate",
        "prompt" in no_prompt.json()["detail"],
        no_prompt.text,
    )

    no_images = client.post("/infer", json={"images": []}, headers=auth)
    check("an empty images list is 422", no_images.status_code == 422, no_images.text)

    over_budget = client.post(
        "/infer", json={"images": [png_data_uri()], "target_polycount": 12}, headers=auth
    )
    check("a below-floor target_polycount is 422", over_budget.status_code == 422, over_budget.text)

    # 5. Real preprocessing and the SSRF guard.
    sketch = service._prepare_sketch(png_data_uri(color=(0, 0, 0, 0)))
    check("sketch preprocessing returns RGB", sketch.mode == "RGB")
    check("transparent sketch pixels flatten to white", sketch.getpixel((0, 0)) == (255, 255, 255))

    for refused in ("http://example.com/a.png", "https://127.0.0.1/a.png", "ftp://x/a.png"):
        try:
            service._decode_image_bytes(refused)
        except ValueError:
            continue
        check(f"refuses {refused}", False, "the fetch was not refused")
    check("refuses non-https and private-network image sources", True)

    print(f"\n{PASSED} passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
