"""Core-path smoke tests for the Hunyuan3D 2.1 worker (app21.py).

Runs on any machine with the worker's non-CUDA dependencies installed, with no
GPU, no weights, and no network: app21 defers its `import torch` into the
loader thread precisely so the HTTP surface can come up (and be tested) without
the CUDA stack. The GPU inference itself is covered by the live deploy, not
here; what these pin is everything a caller touches before and after it.

    pip install pytest fastapi httpx pillow pydantic google-cloud-storage
    python3 workers/model-hunyuan3d/test_worker_api.py    # standalone
    python3 -m pytest -q workers/model-hunyuan3d/test_worker_api.py

What is pinned and why each one has bitten us:

  * `GET /` answers 200. The platform's forge health probe used to GET the
    service root, which no route served, so every deployment logged a 404
    warning once a minute forever while the probe still reported the worker
    healthy. Both halves are fixed (see api/_lib/forge-health.js); this holds
    the worker half.
  * `GET /health` publishes ready / pipeline_loaded / load_error. That probe
    now reads those fields to tell "up" apart from "up and able to generate",
    so their names are a wire contract, not an implementation detail.
  * Bearer auth gates every inference and task route.
  * The tier table matches the budgets the README documents.
  * The image decoder accepts data URIs and refuses SSRF targets.
  * A task record round-trips through the durable tasks/{id}.json blob, which
    is what lets a POST /infer and a later GET /tasks/:id land on different
    Cloud Run instances and still agree.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("API_KEY", "test-bearer-secret")
os.environ.setdefault("GCS_BUCKET", "test-bucket")

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

import app21  # noqa: E402

API_KEY = os.environ["API_KEY"]
AUTH = {"Authorization": f"Bearer {API_KEY}"}

# TestClient without a `with` block does not run the lifespan, so no GCS client
# is constructed and no loader thread starts. Routes that need worker state get
# exactly the state they need, set below.
client = TestClient(app21.app)


class RecordingBlob:
    """Stands in for a storage.Blob so the durable-record round trip can be
    exercised without a GCS project. Only the two methods app21 calls exist."""

    def __init__(self, store: dict, name: str):
        self._store = store
        self._name = name

    def upload_from_string(self, data, content_type=None):
        self._store[self._name] = data

    def download_as_bytes(self):
        from google.api_core.exceptions import NotFound

        if self._name not in self._store:
            raise NotFound(self._name)
        return self._store[self._name].encode()


class RecordingBucket:
    def __init__(self):
        self.objects: dict[str, str] = {}

    def blob(self, name: str) -> RecordingBlob:
        return RecordingBlob(self.objects, name)


def _png_data_uri(color=(200, 40, 40)) -> str:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def test_root_answers_with_the_health_pointer():
    res = client.get("/")
    assert res.status_code == 200, res.status_code
    body = res.json()
    assert body["service"] == "model-hunyuan3d-21"
    assert body["health"] == "/health"
    assert "GET /health" in body["endpoints"]


def test_health_publishes_the_readiness_contract():
    res = client.get("/health")
    assert res.status_code == 200, res.status_code
    body = res.json()
    # Field names the platform health probe reads. Renaming one silently turns
    # a failed model load back into a green backend.
    for field in ("ok", "model", "gpu_available", "pipeline_loaded", "ready", "load_error"):
        assert field in body, f"missing {field}"
    assert body["ok"] is True
    assert body["model"] == "hunyuan3d-2.1"
    # No lifespan ran, so nothing has loaded and nothing has failed.
    assert body["pipeline_loaded"] is False
    assert body["ready"] is False
    assert body["load_error"] is None


def test_health_surfaces_a_failed_model_load():
    app21._load_error = "internal error (ref deadbeef1234)"
    try:
        body = client.get("/health").json()
        assert body["ready"] is False
        assert body["load_error"] == "internal error (ref deadbeef1234)"
    finally:
        app21._load_error = None


def test_inference_routes_require_the_bearer_token():
    body = {"images": [_png_data_uri()]}
    # Missing header entirely: FastAPI rejects the required Header at 422.
    assert client.post("/infer", json=body).status_code == 422
    for headers in ({"Authorization": "Bearer wrong-secret"}, {"Authorization": "not-a-bearer"}):
        assert client.post("/infer", json=body, headers=headers).status_code == 401
        assert client.post("/reconstruct", json=body, headers=headers).status_code == 401
        assert client.get("/tasks/abc", headers=headers).status_code == 401
        assert client.get("/jobs/abc", headers=headers).status_code == 401


def test_infer_rejects_an_empty_or_oversized_image_list():
    assert client.post("/infer", json={"images": []}, headers=AUTH).status_code == 422
    assert client.post("/infer", json={"images": [_png_data_uri()] * 7}, headers=AUTH).status_code == 422


def test_tier_budgets_match_the_documented_table():
    assert app21._quality_for("draft") == {"steps": 30, "octree_resolution": 256, "views": 6, "resolution": 512}
    assert app21._quality_for("standard") == {"steps": 50, "octree_resolution": 384, "views": 6, "resolution": 512}
    assert app21._quality_for("high") == {"steps": 50, "octree_resolution": 512, "views": 6, "resolution": 768}
    # Unknown, blank, and absent tiers all fall back to high rather than erroring.
    for tier in (None, "", "  ", "ultra"):
        assert app21._quality_for(tier) == app21._quality_for("high")
    # Case and padding are normalised.
    assert app21._quality_for("  DRAFT ") == app21._quality_for("draft")
    # The caller gets a copy: mutating one job's budget cannot poison the table.
    q = app21._quality_for("draft")
    q["steps"] = 1
    assert app21._quality_for("draft")["steps"] == 30


def test_decode_image_accepts_a_data_uri():
    img = app21._decode_image(_png_data_uri((10, 20, 30)))
    assert img.mode == "RGB"
    assert img.size == (8, 8)
    assert img.getpixel((0, 0)) == (10, 20, 30)


def test_decode_image_refuses_unsafe_sources():
    # http, loopback, and the cloud metadata server are all refused before any
    # socket is opened for the fetch itself.
    for src in (
        "http://example.com/x.png",
        "https://127.0.0.1/x.png",
        "https://169.254.169.254/latest/meta-data/",
        "file:///etc/passwd",
        "ftp://example.com/x.png",
    ):
        try:
            app21._decode_image(src)
        except ValueError:
            continue
        raise AssertionError(f"expected a refusal for {src}")


def test_task_records_round_trip_through_the_durable_blob():
    bucket = RecordingBucket()
    app21._bucket = bucket
    app21._tasks.clear()
    try:
        asyncio.run(app21._update_task("task-1", status="queued", model="hunyuan3d-2.1"))
        asyncio.run(app21._update_task("task-1", status="done", result_gcs_url="https://example/x.glb"))

        # Every transition is persisted, so a poll on another instance sees the
        # latest state and not just the initial queue.
        stored = json.loads(bucket.objects["tasks/task-1.json"])
        assert stored == {
            "task_id": "task-1",
            "status": "done",
            "model": "hunyuan3d-2.1",
            "result_gcs_url": "https://example/x.glb",
        }

        # A cold instance (empty in-memory cache) resolves the same record, and
        # /jobs adds the controller's field aliases on top of it.
        app21._tasks.clear()
        job = client.get("/jobs/task-1", headers=AUTH).json()
        assert job["job_id"] == "task-1"
        assert job["glb_url"] == "https://example/x.glb"
        assert job["status"] == "done"

        assert client.get("/tasks/task-missing", headers=AUTH).status_code == 404
    finally:
        app21._bucket = None
        app21._tasks.clear()


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001, standalone runner reports, does not raise
            failed += 1
            print(f"FAIL  {fn.__name__}: {exc!r}")
        else:
            print(f"ok    {fn.__name__}")
    print(f"\n{len(tests) - failed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
