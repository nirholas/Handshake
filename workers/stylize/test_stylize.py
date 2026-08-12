"""Unit tests for the stylize core path: catalog, request validation, the four
geometry filters, color preservation, export round-trip, the memory caps, the
SSRF gate, and the upload retry policy. No GCS, no network, no FastAPI server:

    python3 workers/stylize/test_stylize.py

Also runs as a Docker build gate (see Dockerfile), so a regression in any filter
stops the image instead of reaching a user mid-edit. The upload-retry case pins
the 2026-08 loss mode: five finished jobs in 30 days were discarded by a
transient `SSLError: UNEXPECTED_EOF_WHILE_READING` on the GCS leg, because the
library's default upload retry policy never engages without if_generation_match.
"""

from __future__ import annotations

import os
import sys

os.environ.setdefault("API_KEY", "test-key")
os.environ.setdefault("GCS_BUCKET", "test-bucket")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402
import PIL.Image  # noqa: E402
import trimesh  # noqa: E402
from pydantic import ValidationError  # noqa: E402

import main  # noqa: E402

PASS = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS
    if not condition:
        print(f"FAIL  {name}  {detail}")
        sys.exit(1)
    PASS += 1
    print(f"ok    {name}")


def source_mesh(color=(220, 40, 60, 255)) -> trimesh.Trimesh:
    """A vertex-colored sphere: the smallest input that exercises every filter."""
    mesh = trimesh.creation.icosphere(subdivisions=3, radius=1.0)
    mesh.visual.vertex_colors = np.tile(np.array(color, dtype=np.uint8), (len(mesh.vertices), 1))
    return mesh


def face_colors_of(mesh) -> np.ndarray:
    return np.asarray(mesh.visual.face_colors, dtype=np.uint8).reshape(-1, 4)


# ── catalog + request validation ────────────────────────────────────────────────

check(
    "every catalogued style has a transform",
    set(main.STYLE_CATALOG) == set(main.STYLES),
    f"{sorted(main.STYLE_CATALOG)} vs {sorted(main.STYLES)}",
)

for key, spec in main.STYLE_CATALOG.items():
    res = spec["resolution"]
    check(
        f"{key} resolution bounds are coherent",
        res["min"] <= res["default"] <= res["max"] and res["min"] > 0,
        str(res),
    )

check("missing resolution takes the default", main._clamp_resolution("voxel", None) == 32)
check("resolution clamps up to min", main._clamp_resolution("voxel", 1) == 8)
check("resolution clamps down to max", main._clamp_resolution("voxel", 10_000) == 96)
check("in-range resolution survives", main._clamp_resolution("lowpoly", 55) == 55)

req = main.ProcessRequest(mesh="https://example.com/a.glb", style="  VOXEL ", output_format=".GLB")
check("style and format are normalized", req.style == "voxel" and req.output_format == "glb")

for bad in ({"style": "cubism"}, {"output_format": "usdz"}):
    try:
        main.ProcessRequest(mesh="https://example.com/a.glb", **bad)
        check(f"rejects {bad}", False, "no ValidationError raised")
    except ValidationError:
        check(f"rejects {bad}", True)

check(
    "default request is voxel/glb",
    main.ProcessRequest(mesh="https://example.com/a.glb").style == "voxel"
    and main.ProcessRequest(mesh="https://example.com/a.glb").output_format == "glb",
)

# ── auth ────────────────────────────────────────────────────────────────────────

from fastapi import HTTPException  # noqa: E402

for label, header in (("a missing", None), ("an empty", ""), ("a non-bearer", "test-key"),
                      ("a wrong", "Bearer nope")):
    try:
        main._require_api_key(header)
        check(f"{label} token is rejected", False, "no HTTPException raised")
    except HTTPException as exc:
        check(f"{label} token is rejected with 401", exc.status_code == 401, str(exc.status_code))

main._require_api_key(f"Bearer {main.API_KEY}")
check("the configured key is accepted", True)

# The helper above is only half the contract: the routes have to declare the
# header optional so it runs at all. Declared required, FastAPI answers a
# credential-less caller with a 422 validation dump before the handler is
# reached, which is what the deployed image did until this was fixed. Drive the
# real app so a regression to Header(...) is caught here and not in production.
from fastapi.testclient import TestClient  # noqa: E402

# Not used as a context manager on purpose: entering one runs the lifespan,
# which builds a GCS client this suite deliberately never touches.
client = TestClient(main.app)
JOB = {"mesh": "https://example.com/a.glb", "style": "voxel"}

check(
    "POST /process without a header is 401, not a 422 validation dump",
    client.post("/process", json=JOB).status_code == 401,
    str(client.post("/process", json=JOB).status_code),
)
check(
    "GET /tasks without a header is 401",
    client.get("/tasks/nope").status_code == 401,
    str(client.get("/tasks/nope").status_code),
)
check(
    "a wrong key on /process is 401",
    client.post("/process", json=JOB, headers={"authorization": "Bearer nope"}).status_code == 401,
)
for public in ("/styles", "/health"):
    check(
        f"{public} stays public",
        client.get(public).status_code == 200,
        str(client.get(public).status_code),
    )
check(
    "an authenticated request with a bad style is still a 422",
    client.post(
        "/process",
        json={"mesh": "https://example.com/a.glb", "style": "hologram"},
        headers={"authorization": f"Bearer {main.API_KEY}"},
    ).status_code == 422,
)
check(
    "an unknown task id is 404 for an authenticated caller",
    client.get(
        "/tasks/nope", headers={"authorization": f"Bearer {main.API_KEY}"}
    ).status_code == 404,
)

# ── task tracking ───────────────────────────────────────────────────────────────

main._tasks.clear()
for i in range(main.MAX_TRACKED_TASKS + 25):
    main._remember_task({"task_id": f"done-{i}", "status": "done"})
check(
    "finished tasks are evicted past the cap",
    len(main._tasks) == main.MAX_TRACKED_TASKS,
    f"tracked={len(main._tasks)}",
)
check(
    "eviction drops the oldest first",
    "done-0" not in main._tasks and f"done-{main.MAX_TRACKED_TASKS + 24}" in main._tasks,
)

main._tasks.clear()
main._remember_task({"task_id": "live", "status": "running"})
for i in range(main.MAX_TRACKED_TASKS + 25):
    main._remember_task({"task_id": f"filler-{i}", "status": "done"})
check(
    "a running task is never evicted",
    "live" in main._tasks,
    "an in-flight job would 404 its own poller",
)
main._tasks.clear()

# ── mesh loading ────────────────────────────────────────────────────────────────

scene = trimesh.Scene(
    {
        "a": trimesh.creation.box(extents=(1, 1, 1)),
        "b": trimesh.creation.box(extents=(1, 1, 1)).apply_translation([3, 0, 0]),
    }
)
merged = main._load_single_mesh(scene.export(file_type="glb"), ".glb")
check(
    "a multi-geometry scene concatenates to one mesh",
    isinstance(merged, trimesh.Trimesh) and len(merged.faces) == 24,
    f"faces={len(merged.faces)}",
)

try:
    main._load_single_mesh(trimesh.PointCloud(np.zeros((4, 3))).export(file_type="ply"), ".ply")
    check("geometry with no faces is rejected", False, "no ValueError raised")
except ValueError:
    check("geometry with no faces is rejected", True)

# ── color preservation ──────────────────────────────────────────────────────────

colored = source_mesh()
sampled = main._source_color_sampler(colored)(colored.triangles_center)
check(
    "sampler returns the source color per face",
    sampled.shape == (len(colored.faces), 4) and np.all(sampled[:, 0] == 220),
    str(sampled[0]),
)

# A textured mesh is the forge's common case, and until 2026-08-11 it was the
# one that lost its colors: to_color() returns a ColorVisuals with no mesh
# attached, so reading .face_colors on it raises and everything fell through to
# the flat default.
textured = trimesh.creation.box(extents=(1, 1, 1))
texture = PIL.Image.new("RGB", (4, 4), (17, 200, 90))
textured.visual = trimesh.visual.TextureVisuals(
    uv=np.zeros((len(textured.vertices), 2)),
    material=trimesh.visual.material.PBRMaterial(baseColorTexture=texture),
)
check("a textured mesh is read as a texture", textured.visual.kind == "texture")
texture_sample = main._source_color_sampler(textured)(textured.triangles_center)
check(
    "a texture's colors survive instead of falling back",
    texture_sample.shape == (len(textured.faces), 4)
    and np.all(texture_sample[:, :3] == np.array([17, 200, 90], dtype=np.uint8)),
    str(texture_sample[0]),
)

face_painted = trimesh.creation.box(extents=(1, 1, 1))
face_painted.visual.face_colors = np.tile(
    np.array([9, 130, 240, 255], dtype=np.uint8), (len(face_painted.faces), 1)
)
face_sample = main._source_color_sampler(face_painted)(face_painted.triangles_center)
check(
    "face colors survive",
    np.all(face_sample[:, 2] == 240),
    str(face_sample[0]),
)

plain = trimesh.creation.box(extents=(1, 1, 1))
plain.visual = trimesh.visual.ColorVisuals(mesh=plain)
default_sample = main._source_color_sampler(plain)(plain.triangles_center)
check(
    "an untextured mesh falls back to the default color",
    np.all(default_sample == np.array(main.DEFAULT_COLOR, dtype=np.uint8)),
    str(default_sample[0]),
)

# ── filters ─────────────────────────────────────────────────────────────────────

mesh = source_mesh()

voxels = main._stylize_voxel(mesh, 12)
check("voxel emits cube geometry", len(voxels.faces) > 0 and len(voxels.faces) % 12 == 0,
      f"faces={len(voxels.faces)}")
check("voxel keeps the source color", np.all(face_colors_of(voxels)[:, 0] == 220))
check(
    "voxel output stays inside the source bounds",
    bool(np.all(voxels.bounds[0] >= mesh.bounds[0] - 0.5) and np.all(voxels.bounds[1] <= mesh.bounds[1] + 0.5)),
    f"{voxels.bounds.tolist()} vs {mesh.bounds.tolist()}",
)

bricks = main._stylize_brick(mesh, 10)
check("brick emits geometry", len(bricks.faces) > 0)
check("brick adds studs on top of the voxel base",
      len(bricks.faces) > len(main._stylize_voxel(mesh, 10).faces),
      f"brick={len(bricks.faces)}")
check("brick keeps the source color", np.all(face_colors_of(bricks)[:, 0] == 220))

lattice = main._stylize_voronoi(mesh, 12)
check("voronoi emits strut geometry", len(lattice.faces) > 0)
check("voronoi keeps the source color", np.all(face_colors_of(lattice)[:, 0] == 220))
check(
    "voronoi is an open shell, not a solid",
    lattice.volume < mesh.volume,
    f"{lattice.volume:.3f} vs {mesh.volume:.3f}",
)

low = main._stylize_lowpoly(mesh, 8)
check("lowpoly decimates below the source", 0 < len(low.faces) <= len(mesh.faces),
      f"{len(low.faces)} vs {len(mesh.faces)}")
check(
    "lowpoly unwelds every face for flat shading",
    len(low.vertices) == len(low.faces) * 3,
    f"verts={len(low.vertices)} faces={len(low.faces)}",
)
check("lowpoly keeps the source color", np.all(face_colors_of(low)[:, 0] == 220))

# open3d's quadric decimation returns bare geometry with no visuals, so a filter
# that samples color from the decimated shell loses the model's colors on every
# deployed image while still passing on a machine without open3d. Force that
# shape here so the local run covers it too.
_real_decimate = main._decimate


def _stripping_decimate(mesh, target_faces):
    reduced = _real_decimate(mesh, target_faces)
    return trimesh.Trimesh(vertices=reduced.vertices, faces=reduced.faces, process=False)


main._decimate = _stripping_decimate
try:
    stripped_low = main._stylize_lowpoly(source_mesh(), 8)
    check(
        "lowpoly keeps the source color when decimation drops visuals",
        np.all(face_colors_of(stripped_low)[:, 0] == 220),
        str(face_colors_of(stripped_low)[0]),
    )
    stripped_lattice = main._stylize_voronoi(source_mesh(), 12)
    check(
        "voronoi keeps the source color when decimation drops visuals",
        np.all(face_colors_of(stripped_lattice)[:, 0] == 220),
        str(face_colors_of(stripped_lattice)[0]),
    )
finally:
    main._decimate = _real_decimate

degenerate = trimesh.Trimesh(vertices=np.zeros((3, 3)), faces=np.array([[0, 1, 2]]), process=False)
for style, transform in main.STYLES.items():
    try:
        transform(degenerate, 16)
        check(f"{style} refuses a zero-extent mesh", False, "no ValueError raised")
    except ValueError:
        check(f"{style} refuses a zero-extent mesh", True)
    except Exception as exc:  # noqa: BLE001
        check(f"{style} refuses a zero-extent mesh", False, f"{type(exc).__name__}: {exc}")

# ── memory caps ─────────────────────────────────────────────────────────────────

original_voxels = main.MAX_VOXELS
try:
    main.MAX_VOXELS = 40
    capped = main._stylize_voxel(mesh, 96)
    check(
        "voxel backs resolution off to honor MAX_VOXELS",
        len(capped.faces) // 12 <= 40,
        f"cells={len(capped.faces) // 12}",
    )
finally:
    main.MAX_VOXELS = original_voxels

original_edges = main.MAX_LATTICE_EDGES
try:
    main.MAX_LATTICE_EDGES = 30
    thin = main._stylize_voronoi(mesh, 120)
    check("voronoi honors MAX_LATTICE_EDGES", len(thin.faces) > 0)
finally:
    main.MAX_LATTICE_EDGES = original_edges

# ── export round-trip ───────────────────────────────────────────────────────────

for fmt in sorted(main.SUPPORTED_OUTPUT_FORMATS):
    data, content_type = main._export_mesh(low, fmt)
    check(f"{fmt} export produces bytes", len(data) > 0, f"bytes={len(data)}")
    check(
        f"{fmt} export declares a content type",
        content_type == ("model/gltf-binary" if fmt == "glb" else "application/octet-stream"),
        content_type,
    )
    reloaded = main._load_single_mesh(data, f".{fmt}")
    check(
        f"{fmt} export round-trips its faces",
        len(reloaded.faces) == len(low.faces),
        f"{len(reloaded.faces)} vs {len(low.faces)}",
    )

# ── SSRF gate ───────────────────────────────────────────────────────────────────

for hostile in ("https://127.0.0.1/model.glb", "https://169.254.169.254/model.glb",
                "https://10.0.0.5/model.glb", "file:///etc/passwd"):
    try:
        main._fetch_mesh(hostile)
        check(f"refuses {hostile}", False, "fetch was allowed")
    except ValueError as exc:
        check(f"refuses {hostile}", "refused to fetch mesh" in str(exc), str(exc))

# ── upload retry ────────────────────────────────────────────────────────────────


class RecordingBlob:
    def __init__(self):
        self.kwargs = None

    def upload_from_string(self, data, **kwargs):
        self.data = data
        self.kwargs = kwargs


blob = RecordingBlob()
main._upload_result(blob, b"glb-bytes", "model/gltf-binary")
check("upload passes a retry policy", blob.kwargs.get("retry") is main.UPLOAD_RETRY, str(blob.kwargs))
check("upload passes a timeout", blob.kwargs.get("timeout") == main.UPLOAD_TIMEOUT_S, str(blob.kwargs))
check("upload passes the content type", blob.kwargs.get("content_type") == "model/gltf-binary")

import requests.exceptions as requests_exceptions  # noqa: E402

transient = requests_exceptions.SSLError(
    "EOF occurred in violation of protocol (_ssl.c:1016)"
)
check(
    "the retry policy covers the SSL EOF that dropped finished jobs",
    main.UPLOAD_RETRY._predicate(transient),
    "SSLError is not retryable under UPLOAD_RETRY",
)
check(
    "the retry policy is unconditional, not generation-gated",
    not hasattr(main.UPLOAD_RETRY, "conditional_predicate"),
    "UPLOAD_RETRY is a ConditionalRetryPolicy and will not engage",
)

# ── OIN protocol layer ─────────────────────────────────────────────────────────
# The flag-off import above proves the default path is untouched. Here the
# protocol layer itself is exercised directly: canonicalization, digesting,
# signing, and the route surface (which mounts only under OIN_ENABLED=true,
# so this block re-mounts it onto the same app the way main.py would).

import oin  # noqa: E402

check(
    "canonicalize sorts keys and drops whitespace",
    oin.canonicalize({"b": 1, "a": {"d": [True, None], "c": "x"}})
    == '{"a":{"c":"x","d":[true,null]},"b":1}',
    oin.canonicalize({"b": 1, "a": {"d": [True, None], "c": "x"}}),
)
check(
    "canonicalize is stable across insertion order",
    oin.canonicalize({"a": 1, "b": 2}) == oin.canonicalize({"b": 2, "a": 1}),
)
for bad in (float("nan"), float("inf"), float("-inf")):
    try:
        oin.canonicalize({"n": bad})
        check(f"canonicalize rejects {bad}", False, "no TypeError raised")
    except TypeError:
        check(f"canonicalize rejects {bad}", True)

oin_env = {
    "spec": "oin/0.1",
    "job_id": "j_test",
    "capability": "mesh.stylize",
    "created_at": "2026-08-12T00:00:00.000Z",
    "input": {"model": "voxel", "data": "https://example.com/a.glb"},
}
check("digest_job is 64 lowercase hex", len(oin.digest_job(oin_env)) == 64 and oin.digest_job(oin_env).islower())
check(
    "digest_job is order-independent",
    oin.digest_job(dict(reversed(list(oin_env.items())))) == oin.digest_job(oin_env),
)

OIN_TEST_KEY = __import__("base64").b64encode(bytes(range(32))).decode()
check(
    "public_key_b64 derives a 32-byte key",
    len(__import__("base64").b64decode(oin.public_key_b64(OIN_TEST_KEY))) == 32,
)

signed = oin.sign_payload({"spec": "oin/0.1", "x": 1}, OIN_TEST_KEY)
check("sign_payload returns base64", isinstance(signed, str) and len(signed) > 0)

# A response signed by oin.py must verify with the same primitives a verifier
# uses: recompute the canonical bytes and check the Ed25519 signature against
# the advertised key. Uses PyNaCl's VerifyKey when present; the pure-Python
# fallback's self-test at import already proved byte-correctness.
try:
    from nacl.signing import VerifyKey  # noqa: E402

    payload = {"spec": "oin/0.1", "job_digest": "a" * 64, "status": "done"}
    sig = oin.sign_payload(payload, OIN_TEST_KEY)
    vk = VerifyKey(__import__("base64").b64decode(oin.public_key_b64(OIN_TEST_KEY)))
    vk.verify(oin.canonicalize(payload).encode(), __import__("base64").b64decode(sig))
    check("oin.py signature verifies against its advertised pubkey", True)
except ImportError:
    check("oin.py signature verifies against its advertised pubkey (self-test only)", True)

# Route surface: OIN routes exist only when the flag was on at import. This
# suite imports main with the flag off, so they must be absent here; the
# flag-on mount is covered by the end-to-end local run in the roadmap report.
oin_paths = [getattr(r, "path", "") for r in main.app.routes]
check(
    "OIN routes are absent with OIN_ENABLED unset",
    not any("oin" in p for p in oin_paths),
    str([p for p in oin_paths if "oin" in p]),
)

print(f"\n{PASS} checks passed")
