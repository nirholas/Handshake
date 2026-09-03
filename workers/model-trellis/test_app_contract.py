"""Smoke test for the served contract, run INSIDE the built image (it needs
torch, FastAPI, PIL, google-cloud-storage, and the cloned TRELLIS tree on
PYTHONPATH):

    docker build -t model-trellis workers/model-trellis
    docker run --rm model-trellis python3 test_app_contract.py

It needs no GPU, no weights, and no GCP credentials: the ASGI lifespan (which
opens the GCS client and starts the ~3 GB model load) is deliberately not run,
so every assertion below is about request handling, not inference.

What it proves, and why each line earns its place:

  1. The TRELLIS import chain resolves, including the FlexiCubes git submodule.
     A plain (non-recursive) clone leaves that path a bare gitlink, and the
     failure only surfaces at model load, minutes after the port opens, as a
     revision that answers /health with a load_error and can never generate.
     Importing it here turns that into a build failure.
  2. The whole app module imports, so a bad dependency resolve cannot reach a
     revision as an opaque Cloud Run startup-probe failure.
  3. The auth boundary rejects a wrong bearer on both authenticated routes.
  4. The unauthenticated probe surfaces (/ and /health) answer, which is what
     the keep-warm cron and the platform's routing health read.
  5. Request validation rejects an empty or oversized images array instead of
     queueing a job that can only fail on the GPU.
  6. The image decoder accepts a real data URI and refuses everything the SSRF
     guard should refuse, reporting it as an ImageSourceError (the caller-facing
     class) rather than an opaque internal error.
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
    # 1. The vendored TRELLIS tree, including the FlexiCubes submodule the mesh
    #    extractor imports. A ModuleNotFoundError here is the packaging bug this
    #    check exists for; any other exception is a GPU-less builder refusing to
    #    initialize a CUDA-backed module, which is not what is under test.
    try:
        from trellis.pipelines import TrellisImageTo3DPipeline  # noqa: F401
        from trellis.representations.mesh.flexicubes.flexicubes import FlexiCubes  # noqa: F401

        check("trellis import chain resolves", True)
    except ModuleNotFoundError as exc:
        check("trellis import chain resolves", False, str(exc))
    except Exception as exc:  # noqa: BLE001 - no GPU on the builder, see above
        print(f"skip  trellis import chain (no GPU on this host): {type(exc).__name__}: {exc}")

    # 2. The service module itself.
    import main as app_module
    from fastapi.testclient import TestClient

    client = TestClient(app_module.app)

    # 3. Auth boundary.
    bad = {"Authorization": "Bearer wrong-key"}
    res = client.get("/tasks/does-not-exist", headers=bad)
    check("GET /tasks rejects a wrong bearer", res.status_code == 401, f"got {res.status_code}")
    res = client.post("/infer", headers=bad, json={"images": [png_data_uri()]})
    check("POST /infer rejects a wrong bearer", res.status_code == 401, f"got {res.status_code}")

    # 4. Unauthenticated probe surfaces.
    res = client.get("/health")
    body = res.json()
    check("GET /health answers 200", res.status_code == 200, f"got {res.status_code}")
    check("health names the model", body.get("model") == "trellis-image-large", str(body)[:120])
    check(
        "health lists every tier",
        body.get("tiers") == ["draft", "standard", "high", "max"],
        str(body.get("tiers")),
    )
    check(
        "health publishes the default quality bar",
        body.get("default_quality", {}).get("texture_size") == 4096,
        str(body.get("default_quality")),
    )
    res = client.get("/")
    body = res.json()
    check("GET / answers 200 for the keep-warm ping", res.status_code == 200, f"got {res.status_code}")
    check("root names the service", body.get("service") == "model-trellis", str(body)[:120])
    check("root lists the working endpoints", "POST /infer" in body.get("endpoints", []), str(body)[:160])

    # 4b. A dead instance must SAY it is dead, on both surfaces.
    #
    #     This is the regression that took the default free image lane down for
    #     12 hours on 2026-09-02. A transient rate limit failed the model load;
    #     the error latched in memory; /health went on answering ok:true, so the
    #     platform health report and Cloud Run both still called the instance
    #     healthy; and /infer went on accepting jobs it could never run, which
    #     bypassed the caller's lane failover entirely and made every one of
    #     those 70 generations terminal. Both surfaces are asserted here, in the
    #     build, because neither failure is visible from outside until real user
    #     traffic is already being dropped.
    app_module._load_error = "internal error (ref deadbeefcafe)"
    try:
        res = client.get("/health")
        body = res.json()
        check("a dead pipeline makes /health answer 503", res.status_code == 503, f"got {res.status_code}")
        check("a dead pipeline makes /health report ok:false", body.get("ok") is False, str(body)[:160])
        check("health surfaces the load error", "deadbeefcafe" in str(body.get("load_error")), str(body)[:160])
        res = client.post("/infer", headers={"Authorization": f"Bearer {KEY}"}, json={"images": [png_data_uri()]})
        check(
            "a dead pipeline makes /infer refuse with 503 so the caller fails over",
            res.status_code == 503,
            f"got {res.status_code}",
        )
    finally:
        app_module._load_error = None
    res = client.get("/health")
    check("a live pipeline still answers /health 200", res.status_code == 200, f"got {res.status_code}")
    check("a live pipeline reports ok:true", res.json().get("ok") is True, str(res.json())[:160])

    # 4c. The image conditioner resolves locally, so the model load never depends
    #     on GitHub's rate limit for an anonymous shared Cloud Run egress IP.
    #     torch.hub.load() is given no branch by TRELLIS, so it calls github.com
    #     on every load and re-raises any non-404 before consulting its cache;
    #     that is the exact call that 403'd and started the outage above.
    check(
        "the dinov2 checkout is baked into the image",
        os.path.isfile(os.path.join(app_module.DINOV2_LOCAL_DIR, "hubconf.py")),
        f"missing hubconf.py under {app_module.DINOV2_LOCAL_DIR}",
    )
    import torch

    original_hub_load = torch.hub.load
    try:
        # Install the pin over a recorder, so the assertion is about what the
        # wrapper forwards rather than about building a ViT on a GPU-less builder.
        forwarded = {}

        def _record(repo_or_dir, model, *args, **kwargs):
            forwarded["repo"] = repo_or_dir
            forwarded["source"] = kwargs.get("source")
            return "recorded"

        app_module._dinov2_pinned = False
        torch.hub.load = _record
        check("the dinov2 pin installs", app_module._pin_dinov2_to_local_checkout() is True)
        torch.hub.load("facebookresearch/dinov2", "dinov2_vitl14_reg", pretrained=True)
        check(
            "torch.hub resolves dinov2 from the local checkout, never over the network",
            forwarded.get("repo") == app_module.DINOV2_LOCAL_DIR and forwarded.get("source") == "local",
            str(forwarded),
        )
        # Everything else must still reach the real loader untouched.
        forwarded.clear()
        torch.hub.load("pytorch/vision", "resnet18")
        check(
            "an unrelated torch.hub repo is left alone",
            forwarded.get("repo") == "pytorch/vision" and forwarded.get("source") is None,
            str(forwarded),
        )
    finally:
        torch.hub.load = original_hub_load
        app_module._dinov2_pinned = False

    # 5. Request validation, before anything reaches the GPU.
    good = {"Authorization": f"Bearer {KEY}"}
    res = client.post("/infer", headers=good, json={"images": []})
    check("POST /infer rejects an empty images array", res.status_code == 422, f"got {res.status_code}")
    res = client.post("/infer", headers=good, json={"images": [png_data_uri()] * 7})
    check("POST /infer rejects more than six views", res.status_code == 422, f"got {res.status_code}")

    # 6. The image decoder and the SSRF guard, through the real code path.
    img = app_module._decode_image(png_data_uri())
    check("data uri decodes to RGB", img.mode == "RGB" and img.size == (24, 24), f"{img.mode} {img.size}")
    img = app_module._decode_image(png_data_uri(), keep_alpha=True)
    check("matted cutout keeps its alpha mask", img.mode == "RGBA", img.mode)

    for label, src in [
        ("cleartext http", "http://example.com/a.png"),
        ("bare path", "/etc/passwd"),
        ("loopback https", "https://127.0.0.1/a.png"),
        ("cloud metadata", "https://169.254.169.254/latest/meta-data/"),
        ("corrupt data uri", "data:image/png;base64,not-base64!!"),
    ]:
        try:
            app_module._decode_image(src)
            check(f"refuses {label}", False, "no exception raised")
        except app_module.ImageSourceError:
            check(f"refuses {label}", True)
        except Exception as exc:  # noqa: BLE001 - must be the caller-facing class
            check(f"refuses {label}", False, f"raised {type(exc).__name__}: {exc}")

    print(f"\n{PASSED} contract assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
