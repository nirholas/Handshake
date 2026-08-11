"""
End-to-end smoke test for the avatar-pipeline-controller core path.

Runs the real FastAPI app against a real HTTP backend (a threaded stdlib server
speaking the workers' `/infer` + `/tasks/:id` + `/rig` contract) over real
sockets, so the pipeline's HTTP calls, polling, bearer propagation, GLB copy and
Firestore writes are all exercised as written. Only the two managed GCP clients
(Firestore, Cloud Storage) are substituted with in-process stand-ins, because
they are the two things a test machine cannot reach.

No GPU, no GCP credentials, no network:  `python3 test_pipeline.py`

Covers:
  - POST /reconstruct → 202 → background pipeline → GET /jobs/:id reports done
    with mesh timing, rig timing and the final glb_url
  - the rig stage really is called, with the shared bearer secret, and its
    output URL wins over the raw mesh URL
  - a final GLB outside the output bucket is downloaded and re-uploaded to
    avatars/{job_id}.glb; one already in the bucket is passed through untouched
  - an oversized GLB is rejected instead of being read into memory unbounded
  - a rig worker that rejects the job degrades to the unrigged mesh, not failure
  - a failing mesh backend marks the job failed with an OPAQUE error (the
    upstream detail never reaches the caller)
  - auth: missing/!wrong bearer is 401, /health stays public
  - model routing honours an explicit backend and never returns an unwired one
"""

import asyncio
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

API_KEY = "test-secret-key"
BUCKET = "three-ws-avatar-reconstructions-test"
IN_BUCKET_GLB = f"https://storage.googleapis.com/{BUCKET}/rigs/already-there.glb"

RIGGED_BYTES = b"glTF" + b"\x02\x00\x00\x00" + b"R" * 4088  # 4096-byte stand-in GLB


# ── stub backend: one server plays both the mesh worker and the rig worker ────


class _BackendHandler(BaseHTTPRequestHandler):
    """Implements the worker task contract: POST /infer|/rig → 202 {task_id}."""

    calls: list = []

    def log_message(self, *args):  # keep the test output clean
        pass

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        if self.headers.get("authorization") != f"Bearer {API_KEY}":
            self._json(401, {"detail": "bad bearer"})
            return False
        return True

    def do_POST(self):
        if not self._authed():
            return
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        type(self).calls.append((self.path, body))

        if self.path == "/infer":
            mode = body["images"][0].rsplit("/", 1)[-1].split(".")[0]
            self._json(202, {"task_id": f"mesh-{mode}", "status": "queued"})
            return
        if self.path == "/rig":
            mode = self.server.rig_mode
            if mode == "reject":
                self._json(503, {"detail": "rig worker busy"})
                return
            self._json(202, {"task_id": f"rig-{mode}", "status": "queued"})
            return
        self._json(404, {"detail": "no such route"})

    def do_GET(self):
        if self.path.startswith("/assets/"):
            size = int(self.path.rsplit("/", 1)[-1].split(".")[0])
            blob = RIGGED_BYTES[:size]
            self.send_response(200)
            self.send_header("content-type", "model/gltf-binary")
            self.send_header("content-length", str(len(blob)))
            self.end_headers()
            self.wfile.write(blob)
            return

        if not self._authed():
            return
        m = re.fullmatch(r"/tasks/(mesh|rig)-(\w+)", self.path)
        if not m:
            self._json(404, {"detail": "no such task"})
            return
        kind, mode = m.groups()
        if kind == "mesh" and mode == "fail":
            self._json(200, {
                "status": "failed",
                "error": "CUDA OOM in /opt/models/hunyuan3d/pipeline.py line 412",
            })
            return
        if kind == "mesh":
            self._json(200, {"status": "done", "result_gcs_url": f"{self.server.base}/assets/2048.glb"})
            return
        # rig result: either already in the output bucket, or served locally so
        # the controller has to download + re-upload it.
        url = IN_BUCKET_GLB if mode == "inbucket" else f"{self.server.base}/assets/4096.glb"
        self._json(200, {"status": "done", "rigged_gcs_url": url})


def start_backend():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _BackendHandler)
    server.base = f"http://127.0.0.1:{server.server_address[1]}"
    server.rig_mode = "inbucket"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# ── in-process stand-ins for Firestore + Cloud Storage ────────────────────────


class _Doc:
    def __init__(self, store, key):
        self._store, self._key = store, key

    def set(self, data, merge=False):
        current = self._store.get(self._key, {}) if merge else {}
        self._store[self._key] = {**current, **data}

    def get(self):
        return self

    @property
    def exists(self):
        return self._key in self._store

    def to_dict(self):
        return dict(self._store[self._key])


class _Collection:
    def __init__(self, store):
        self._store = store

    def document(self, key):
        return _Doc(self._store, key)


class _Firestore:
    def __init__(self):
        self.docs = {}

    def collection(self, _name):
        return _Collection(self.docs)


class _Blob:
    def __init__(self, store, name):
        self._store, self.name = store, name

    def upload_from_string(self, data, content_type=None):
        self._store[self.name] = (data, content_type)


class _Bucket:
    def __init__(self):
        self.objects = {}

    def blob(self, name):
        return _Blob(self.objects, name)


# ── harness ───────────────────────────────────────────────────────────────────

FAILURES = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        FAILURES.append(label)


async def submit(client, images, model="trellis", **extra):
    resp = await client.post(
        "/reconstruct",
        json={"images": images, "model": model, **extra},
        headers={"authorization": f"Bearer {API_KEY}"},
    )
    return resp


async def fetch_job(client, job_id):
    return await client.get(f"/jobs/{job_id}", headers={"authorization": f"Bearer {API_KEY}"})


async def run(main, backend):
    transport = httpx.ASGITransport(app=main.app)
    # ASGITransport awaits the whole app call, so FastAPI background tasks (the
    # pipeline itself) have finished by the time POST /reconstruct returns.
    async with httpx.AsyncClient(transport=transport, base_url="http://controller") as client:
        print("health + auth")
        health = (await client.get("/health")).json()
        check("/health is public and reports both wired backends",
              sorted(health["backends"]) == ["hunyuan3d", "trellis"], health)
        check("/health weights normalize to 1",
              abs(sum(health["weights"].values()) - 1.0) < 1e-9, health["weights"])
        check("/health reports the rig stage as active", health["unirig"] is True and
              health["skip_rigging"] is False, health)
        check("wrong bearer on /jobs is 401",
              (await client.get("/jobs/x", headers={"authorization": "Bearer nope"})).status_code == 401)
        check("wrong bearer on /reconstruct is 401",
              (await client.post("/reconstruct", json={"images": ["https://x/a.jpg"]},
                                 headers={"authorization": "Bearer nope"})).status_code == 401)
        check("unknown job is 404",
              (await fetch_job(client, "no-such-job")).status_code == 404)

        print("model routing")
        check("an explicit wired backend is honoured", main._pick_model("hunyuan3d") == "hunyuan3d")
        check("an unwired backend falls back to the router",
              main._pick_model("triposr") in {"hunyuan3d", "trellis"})
        check("random routing never returns an unwired backend",
              all(main._pick_model() in {"hunyuan3d", "trellis"} for _ in range(200)))

        print("happy path: mesh -> rig -> finalize (rig output already in bucket)")
        backend.rig_mode = "inbucket"
        _BackendHandler.calls = []
        resp = await submit(client, ["https://example.invalid/ok.jpg"], tier="high",
                            target_polycount=50_000)
        check("POST /reconstruct returns 202", resp.status_code == 202, resp.text)
        job_id = resp.json()["job_id"]
        job = (await fetch_job(client, job_id)).json()
        check("job reaches done", job["status"] == "done", job)
        check("stage is done", job["stage"] == "done", job.get("stage"))
        check("glb_url is the rigged URL", job["glb_url"] == IN_BUCKET_GLB, job.get("glb_url"))
        check("raw mesh URL recorded", job["mesh_gcs_url"].endswith("/assets/2048.glb"), job)
        check("mesh + rig + total timings recorded",
              all(k in job for k in ("mesh_time_ms", "rig_time_ms", "total_time_ms")), job)
        check("tier provenance persisted", job["tier"] == "high" and job["path"] == "image", job)
        check("target_polycount forwarded to the mesh backend",
              _BackendHandler.calls[0][1].get("target_polycount") == 50_000,
              _BackendHandler.calls[0][1])
        rig_call = [c for c in _BackendHandler.calls if c[0] == "/rig"]
        check("rig worker was called with the mesh URL + blendshapes",
              len(rig_call) == 1
              and rig_call[0][1]["mesh_gcs_url"] == job["mesh_gcs_url"]
              and rig_call[0][1]["blendshapes"] is True, rig_call)
        check("in-bucket GLB is passed through, not re-uploaded",
              main._bucket.objects == {}, main._bucket.objects)

        print("finalize: GLB outside the output bucket is copied in")
        backend.rig_mode = "copy"
        resp = await submit(client, ["https://example.invalid/copy.jpg"])
        job_id = resp.json()["job_id"]
        job = (await fetch_job(client, job_id)).json()
        check("copied job reaches done", job["status"] == "done", job)
        check("glb_url points at the output bucket",
              job["glb_url"] == f"https://storage.googleapis.com/{BUCKET}/avatars/{job_id}.glb",
              job.get("glb_url"))
        stored = main._bucket.objects.get(f"avatars/{job_id}.glb")
        check("GLB bytes uploaded with the glTF content type",
              stored is not None and stored[0] == RIGGED_BYTES and stored[1] == "model/gltf-binary",
              stored[1] if stored else None)

        print("finalize: oversized GLB is rejected, not buffered")
        original_cap = main.MAX_GLB_BYTES
        main.MAX_GLB_BYTES = 1024
        try:
            resp = await submit(client, ["https://example.invalid/big.jpg"])
            job = (await fetch_job(client, resp.json()["job_id"])).json()
            check("oversized job fails", job["status"] == "failed", job)
            check("oversize error is opaque",
                  job["error"].startswith("internal error (ref "), job.get("error"))
        finally:
            main.MAX_GLB_BYTES = original_cap

        print("degradation: rig worker rejects the job")
        backend.rig_mode = "reject"
        resp = await submit(client, ["https://example.invalid/reject.jpg"])
        job = (await fetch_job(client, resp.json()["job_id"])).json()
        check("job still completes on rig rejection", job["status"] == "done", job)
        check("unrigged mesh is copied out as the result",
              job["glb_url"].startswith(f"https://storage.googleapis.com/{BUCKET}/avatars/"),
              job.get("glb_url"))
        check("no rig timing recorded when rigging was skipped", "rig_time_ms" not in job, job)

        print("failure: mesh backend fails")
        backend.rig_mode = "inbucket"
        resp = await submit(client, ["https://example.invalid/fail.jpg"])
        job = (await fetch_job(client, resp.json()["job_id"])).json()
        check("job is marked failed", job["status"] == "failed", job)
        check("stage is failed", job["stage"] == "failed", job.get("stage"))
        check("error is opaque and carries a correlation id",
              re.fullmatch(r"internal error \(ref [0-9a-f]{12}\)", job["error"] or ""), job.get("error"))
        check("upstream detail never leaks to the caller",
              "CUDA" not in json.dumps(job) and "pipeline.py" not in json.dumps(job), job)
        check("timing still recorded on failure", "total_time_ms" in job, job)


def main_():
    backend = start_backend()

    os.environ.update({
        "API_KEY": API_KEY,
        "GCS_BUCKET": BUCKET,
        "FIRESTORE_PROJECT": "test-project",
        "MODEL_TRELLIS_URL": backend.base,
        "MODEL_HUNYUAN3D_URL": backend.base,
        "UNIRIG_URL": backend.base,
        "MODEL_WEIGHTS": json.dumps({"trellis": 0.6, "hunyuan3d": 0.4, "triposr": 9.0}),
        "SKIP_RIGGING": "false",
    })

    import main as controller  # imported after the env is set: config is read at import

    controller._db = _Firestore()
    controller._bucket = _Bucket()
    controller._http = httpx.AsyncClient(timeout=httpx.Timeout(10.0))
    # Same code path, just without the production poll cadence in a test loop.
    controller.FIRST_POLL_DELAY = 0.02
    controller.MESH_POLL_INTERVAL = 0.02
    controller.RIG_POLL_INTERVAL = 0.02

    try:
        asyncio.run(run(controller, backend))
    finally:
        asyncio.run(controller._http.aclose())
        backend.shutdown()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed: {', '.join(FAILURES)}")
        return 1
    print("all controller pipeline checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main_())
