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

print(f"\n{PASS} checks passed")
