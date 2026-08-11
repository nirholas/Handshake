"""
Stylize service — one-click geometric stylization filters for 3D meshes.

Turns any input mesh into a stylized variant using pure geometry processing
(trimesh + numpy + scipy). No model inference, no GPU — fast and cheap on CPU.

Filters (extensible — register more in STYLES):
  - voxel    : voxelize to a grid, rebuild the surface as solid cubes.
  - brick    : voxel grid + cylindrical studs on every top face (LEGO-like).
  - voronoi  : decimate to a coarse shell, thicken its edges into an open
               strut lattice with spherical nodes (Voronoi/wireframe shell).
  - lowpoly  : quadric-decimate, then hard flat-shade for a faceted look.

Source color/material is preserved where the style allows by sampling the
nearest source-surface face color per output element; otherwise a tasteful
default material is applied.

API contract:
  POST /process  {
    mesh: url,                       # https GLB/OBJ/FBX/STL/PLY URL (required)
    style: "voxel"|"brick"|"voronoi"|"lowpoly",   # default: "voxel"
    resolution?: int,                # style-specific density (see /styles)
    output_format?: "glb"|"obj"|"stl"|"ply",      # default: "glb"
  } → 202 { task_id, status }

  GET /tasks/:id → { task_id, status, result_url?, face_count?, style?, error? }

  GET /styles    → { styles: [ { key, name, description, resolution: {...} } ] }

  GET /health    → { ok }

Environment variables:
  API_KEY        — bearer secret (required)
  GCS_BUCKET     — output bucket (required)
  MAX_CONCURRENT — default 2
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Callable, Optional

from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from google.cloud import storage
from google.cloud.storage.retry import DEFAULT_RETRY
from pydantic import BaseModel, Field, field_validator

from worker_security import (
    UnsafeUrlError,
    fetch_remote_bytes,
    require_api_key,
    safe_error,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("stylize")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "2"))

_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_tasks: dict[str, dict] = {}

# Instances are kept warm (min-instances=1), so an unbounded task dict would grow
# for the life of the instance. At ten seconds a job this is hours of history,
# far beyond any caller's poll window, and the results themselves live in GCS.
MAX_TRACKED_TASKS = 500

SUPPORTED_INPUT_FORMATS = {".glb", ".gltf", ".obj", ".stl", ".ply", ".fbx", ".off", ".dae"}
SUPPORTED_OUTPUT_FORMATS = {"glb", "obj", "stl", "ply"}
MAX_MESH_BYTES = 128 * 1024 * 1024

# Hard safety caps so a hostile/huge input can never exhaust memory.
MAX_VOXELS = 60_000          # occupied surface cells rebuilt as cubes
MAX_LATTICE_EDGES = 6_000    # struts emitted for the voronoi shell
DEFAULT_COLOR = [196, 198, 214, 255]  # tasteful cool-neutral when source has none

# google-cloud-storage defaults uploads to a ConditionalRetryPolicy that only
# engages when the caller passes if_generation_match, so out of the box a
# transient TLS blip on the upload leg discards a job whose geometry work already
# succeeded (five such losses in the 30 days to 2026-08-11, every one an
# SSLError: UNEXPECTED_EOF_WHILE_READING). Each result blob is a fresh uuid, so
# re-sending it is idempotent: retry unconditionally instead.
UPLOAD_RETRY = DEFAULT_RETRY
UPLOAD_TIMEOUT_S = 120


# ── style catalog ────────────────────────────────────────────────────────────────
# A single source of truth for the available filters: their human-facing copy and
# the bounds + default of their one density knob. Adding a new filter is a matter
# of describing it here and registering its transform in STYLES below.

STYLE_CATALOG = {
    "voxel": {
        "name": "Voxel",
        "description": "Blocky cubes snapped to a 3D grid — a clean Minecraft-style rebuild of the surface.",
        "resolution": {"label": "Grid resolution", "default": 32, "min": 8, "max": 96},
    },
    "brick": {
        "name": "Brick",
        "description": "Voxel grid topped with studs on every up-facing block — a buildable, toy-brick look.",
        "resolution": {"label": "Brick resolution", "default": 24, "min": 8, "max": 64},
    },
    "voronoi": {
        "name": "Voronoi shell",
        "description": "An open lattice of struts and nodes traced over the surface — light, sculptural, 3D-print ready.",
        "resolution": {"label": "Cell density", "default": 48, "min": 12, "max": 120},
    },
    "lowpoly": {
        "name": "Low-poly",
        "description": "Decimated to crisp facets with hard flat shading — the classic stylized game-asset aesthetic.",
        "resolution": {"label": "Detail", "default": 40, "min": 8, "max": 120},
    },
}


def _remember_task(task: dict) -> None:
    """Track a task, evicting the oldest finished ones past MAX_TRACKED_TASKS.

    Eviction never touches a queued or running job: a caller polling live work
    must not get a 404 because someone else's job pushed theirs out.
    """
    _tasks[task["task_id"]] = task
    if len(_tasks) <= MAX_TRACKED_TASKS:
        return
    for task_id, tracked in list(_tasks.items()):
        if len(_tasks) <= MAX_TRACKED_TASKS:
            break
        if tracked.get("status") in ("done", "failed"):
            del _tasks[task_id]


def _clamp_resolution(style: str, resolution: Optional[int]) -> int:
    spec = STYLE_CATALOG[style]["resolution"]
    if resolution is None:
        return spec["default"]
    return max(spec["min"], min(spec["max"], int(resolution)))


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    import trimesh
    log.info("stylize service ready — trimesh %s, styles=%s", trimesh.__version__, ",".join(STYLE_CATALOG))
    yield


app = FastAPI(title="stylize-service", lifespan=lifespan)


def _require_api_key(authorization: Optional[str]) -> None:
    """Reject a missing or wrong bearer token with 401.

    The header is declared optional on the routes so this runs on a missing one
    too: with `Header(...)` FastAPI answers a credential-less caller with a 422
    validation dump instead of the 401 the contract promises.
    """
    try:
        require_api_key(authorization, API_KEY)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


# ── mesh IO ───────────────────────────────────────────────────────────────────────


def _fetch_mesh(url: str) -> tuple[bytes, str]:
    try:
        data = fetch_remote_bytes(url, timeout=60, max_bytes=MAX_MESH_BYTES)
    except UnsafeUrlError as exc:
        raise ValueError(f"refused to fetch mesh: {exc}") from exc
    suffix = Path(url.split("?")[0]).suffix.lower()
    if suffix not in SUPPORTED_INPUT_FORMATS:
        suffix = ".glb"
    return data, suffix


def _load_single_mesh(data: bytes, suffix: str):
    """Load to a single concatenated Trimesh, keeping visual/color where present."""
    import trimesh

    loaded = trimesh.load(io.BytesIO(data), file_type=suffix.lstrip("."), force="mesh", process=False)
    if isinstance(loaded, trimesh.Scene):
        meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not meshes:
            raise ValueError("no renderable geometry found in scene")
        loaded = trimesh.util.concatenate(meshes)
    if not hasattr(loaded, "faces") or len(loaded.faces) == 0:
        raise ValueError("input has no triangular faces to stylize")
    return loaded


# ── color preservation ─────────────────────────────────────────────────────────────


def _source_color_sampler(mesh) -> Callable:
    """Return color_at(points)->(N,4) uint8 sampling the nearest source face color.

    Resolves a usable per-face color from whatever the source carries — vertex
    colors, a texture (converted via to_color), or a material base color —
    falling back to a tasteful default when the mesh is untextured. The returned
    closure is what each filter calls to tint its output elements.
    """
    import numpy as np
    from scipy.spatial import cKDTree

    n_faces = len(mesh.faces)
    face_colors = None
    try:
        visual = getattr(mesh, "visual", None)
        if visual is not None:
            kind = getattr(visual, "kind", None)
            if kind == "texture" or visual.__class__.__name__ == "TextureVisuals":
                visual = visual.to_color()
            # `defined` is False when trimesh is only synthesizing its stock gray
            # for a mesh that carries no color of its own. Reading face_colors
            # regardless would hand every untextured input that flat 102-gray and
            # leave DEFAULT_COLOR unreachable.
            if getattr(visual, "defined", True):
                fc = getattr(visual, "face_colors", None)
                if fc is not None and len(fc) == n_faces:
                    face_colors = np.asarray(fc, dtype=np.uint8).reshape(-1, 4)
    except Exception as exc:  # noqa: BLE001 — any visual quirk falls back to default
        log.info("color extraction fell back to default: %s", exc)

    if face_colors is None:
        face_colors = np.tile(np.array(DEFAULT_COLOR, dtype=np.uint8), (n_faces, 1))

    centroids = mesh.triangles_center
    tree = cKDTree(centroids)

    def color_at(points):
        pts = np.asarray(points, dtype=np.float64).reshape(-1, 3)
        _, idx = tree.query(pts)
        return face_colors[idx]

    return color_at


# ── filters ─────────────────────────────────────────────────────────────────────


def _require_extent(mesh) -> float:
    """Largest bounding-box dimension, refusing a mesh that has no size at all.

    Every filter derives its feature size (voxel pitch, strut radius) from this,
    and at zero they all degrade into invisible or empty geometry. Failing the
    task with a readable reason beats uploading a blob the caller cannot see.
    """
    extent = float(mesh.extents.max())
    if extent <= 0:
        raise ValueError("mesh has zero extent")
    return extent


def _stylize_voxel(mesh, resolution: int):
    """Voxelize the surface and rebuild it as a mesh of solid, source-colored cubes."""
    import numpy as np

    extent = _require_extent(mesh)
    pitch = extent / max(1, resolution)

    voxel = mesh.voxelized(pitch=pitch)
    n = len(voxel.points)
    if n == 0:
        raise ValueError("voxelization produced no cells — try a higher resolution")
    # Back off resolution if the grid is dangerously dense.
    while n > MAX_VOXELS and pitch < extent:
        pitch *= 1.3
        voxel = mesh.voxelized(pitch=pitch)
        n = len(voxel.points)

    color_at = _source_color_sampler(mesh)
    colors = color_at(voxel.points)  # (N,4), one per occupied cell
    boxes = voxel.as_boxes()
    # as_boxes emits exactly 12 faces per cell in `points` order; tint each cube
    # by repeating its source color across its faces. (Passing colors= directly
    # is silently dropped by this trimesh version.)
    per_face = len(boxes.faces) // len(voxel.points)
    boxes.visual.face_colors = np.repeat(colors, per_face, axis=0)
    return boxes


def _stylize_brick(mesh, resolution: int):
    """Voxel grid plus a stud on each column's top voxel — a toy-brick rebuild."""
    import numpy as np
    import trimesh

    extent = _require_extent(mesh)
    pitch = extent / max(1, resolution)

    voxel = mesh.voxelized(pitch=pitch)
    n = len(voxel.points)
    if n == 0:
        raise ValueError("voxelization produced no cells — try a higher resolution")
    while n > MAX_VOXELS and pitch < extent:
        pitch *= 1.3
        voxel = mesh.voxelized(pitch=pitch)
        n = len(voxel.points)

    color_at = _source_color_sampler(mesh)
    centers = np.asarray(voxel.points, dtype=np.float64)
    colors = color_at(centers)

    base = voxel.as_boxes()
    per_face = len(base.faces) // len(centers)
    base.visual.face_colors = np.repeat(colors, per_face, axis=0)

    # Find the top voxel of each (x,y) column (grid up-axis = Z) and cap it with a
    # cylindrical stud sitting on the block's top face.
    grid = np.asarray(voxel.sparse_indices, dtype=np.int64)  # (N,3) integer cells
    column_top: dict[tuple, int] = {}
    for i in range(len(grid)):
        key = (int(grid[i, 0]), int(grid[i, 1]))
        if key not in column_top or grid[i, 2] > grid[column_top[key], 2]:
            column_top[key] = i

    stud_r = pitch * 0.30
    stud_h = pitch * 0.42
    studs = []
    for idx in column_top.values():
        c = centers[idx]
        cyl = trimesh.creation.cylinder(radius=stud_r, height=stud_h, sections=12)
        cyl.apply_translation([c[0], c[1], c[2] + pitch * 0.5 + stud_h * 0.5])
        cyl.visual.face_colors = np.tile(colors[idx], (len(cyl.faces), 1))
        studs.append(cyl)

    if studs:
        return trimesh.util.concatenate([base, *studs])
    return base


def _decimate(mesh, target_faces: int):
    """Quadric decimation via open3d, with a trimesh fallback. Used by lattice/lowpoly."""
    import numpy as np
    import trimesh

    if len(mesh.faces) <= target_faces:
        return mesh
    try:
        import open3d as o3d

        om = o3d.geometry.TriangleMesh()
        om.vertices = o3d.utility.Vector3dVector(mesh.vertices.astype(np.float64))
        om.triangles = o3d.utility.Vector3iVector(mesh.faces.astype(np.int32))
        simplified = om.simplify_quadric_decimation(int(target_faces))
        return trimesh.Trimesh(
            vertices=np.asarray(simplified.vertices),
            faces=np.asarray(simplified.triangles),
            process=False,
        )
    except Exception as exc:  # noqa: BLE001
        log.info("open3d decimation fell back to trimesh: %s", exc)
        try:
            return mesh.simplify_quadric_decimation(face_count=int(target_faces))
        except Exception:
            return mesh


def _stylize_voronoi(mesh, resolution: int):
    """Thicken a decimated shell's edges into an open strut-and-node lattice."""
    import numpy as np
    import trimesh

    _require_extent(mesh)
    target_faces = int(np.clip(resolution * 40, 200, 4000))
    shell = _decimate(mesh, target_faces)

    edges = shell.edges_unique  # (E,2) vertex index pairs
    verts = np.asarray(shell.vertices, dtype=np.float64)
    if len(edges) == 0:
        raise ValueError("mesh has no edges to latticize")

    # Cap strut count by decimating further if needed.
    if len(edges) > MAX_LATTICE_EDGES:
        ratio = MAX_LATTICE_EDGES / len(edges)
        shell = _decimate(shell, max(60, int(len(shell.faces) * ratio)))
        edges = shell.edges_unique
        verts = np.asarray(shell.vertices, dtype=np.float64)
    # Hard backstop: if decimation was unavailable and the edge set is still over
    # budget, keep a deterministic uniform stride so output stays bounded.
    if len(edges) > MAX_LATTICE_EDGES:
        stride = int(np.ceil(len(edges) / MAX_LATTICE_EDGES))
        edges = edges[::stride]

    diag = float(np.linalg.norm(mesh.extents))
    strut_r = max(diag * 0.004, diag / max(resolution, 1) * 0.18)

    color_at = _source_color_sampler(mesh)
    mids = (verts[edges[:, 0]] + verts[edges[:, 1]]) * 0.5
    edge_colors = color_at(mids)

    parts = []
    for i, (a, b) in enumerate(edges):
        seg = verts[[a, b]]
        length = float(np.linalg.norm(seg[1] - seg[0]))
        if length <= 1e-9:
            continue
        strut = trimesh.creation.cylinder(radius=strut_r, segment=seg, sections=6)
        strut.visual.face_colors = np.tile(edge_colors[i], (len(strut.faces), 1))
        parts.append(strut)

    # Spherical nodes weld the struts at each used vertex.
    used = np.unique(edges)
    node_colors = color_at(verts[used])
    for j, vi in enumerate(used):
        node = trimesh.creation.icosphere(subdivisions=0, radius=strut_r * 1.45)
        node.apply_translation(verts[vi])
        node.visual.face_colors = np.tile(node_colors[j], (len(node.faces), 1))
        parts.append(node)

    if not parts:
        raise ValueError("lattice generation produced no geometry")
    return trimesh.util.concatenate(parts)


def _stylize_lowpoly(mesh, resolution: int):
    """Decimate hard, then split every face onto its own vertices for flat shading."""
    import numpy as np
    import trimesh

    _require_extent(mesh)
    target_faces = int(np.clip(resolution * 60, 80, 20_000))
    deci = _decimate(mesh, target_faces)

    # Sample the SOURCE, not the decimated shell: open3d's quadric decimation
    # (the path taken whenever open3d imports, which is every deployed image)
    # returns bare vertices and triangles with no visuals at all, so sampling
    # `deci` painted every facet the fallback color and threw the model's own
    # colors away. Voronoi already samples the source for the same reason.
    color_at = _source_color_sampler(mesh)
    face_colors = color_at(deci.triangles_center)  # (F,4)

    # Unweld: each triangle gets three unique vertices so normals are per-face,
    # producing crisp facets instead of smooth Gouraud shading.
    tri_verts = deci.vertices[deci.faces].reshape(-1, 3)
    new_faces = np.arange(len(tri_verts)).reshape(-1, 3)
    vertex_colors = np.repeat(face_colors, 3, axis=0)

    faceted = trimesh.Trimesh(vertices=tri_verts, faces=new_faces, process=False)
    faceted.visual.vertex_colors = vertex_colors
    return faceted


STYLES: dict[str, Callable] = {
    "voxel": _stylize_voxel,
    "brick": _stylize_brick,
    "voronoi": _stylize_voronoi,
    "lowpoly": _stylize_lowpoly,
}


# ── export + pipeline ───────────────────────────────────────────────────────────────


def _export_mesh(mesh, output_format: str) -> tuple[bytes, str]:
    import trimesh

    fmt = output_format.lower()
    with tempfile.TemporaryDirectory() as tmpdir:
        out_path = Path(tmpdir) / f"output.{fmt}"
        if fmt == "glb":
            scene = trimesh.scene.scene.Scene(geometry={"stylized": mesh})
            scene.export(str(out_path))
        else:
            mesh.export(str(out_path))
        data = out_path.read_bytes()
    return data, ("model/gltf-binary" if fmt == "glb" else "application/octet-stream")


def _upload_result(blob, data: bytes, content_type: str) -> None:
    """Upload a finished mesh, retrying the transient transport failures.

    Split out from the request path so the retry policy is directly testable:
    see test_stylize.py, which pins that an SSLError is retryable under it.
    """
    blob.upload_from_string(
        data, content_type=content_type, retry=UPLOAD_RETRY, timeout=UPLOAD_TIMEOUT_S
    )


def _run_processing(mesh_url: str, style: str, resolution: int, output_format: str):
    data, suffix = _fetch_mesh(mesh_url)
    mesh = _load_single_mesh(data, suffix)

    transform = STYLES[style]
    styled = transform(mesh, resolution)

    out_bytes, content_type = _export_mesh(styled, output_format)
    face_count = int(len(styled.faces)) if hasattr(styled, "faces") else 0
    return out_bytes, face_count, content_type


async def _process(task_id: str, mesh_url: str, style: str, resolution: int, output_format: str) -> None:
    async with _sem:
        _tasks[task_id]["status"] = "running"
        loop = asyncio.get_event_loop()
        t0 = time.time()
        try:
            out_bytes, face_count, content_type = await loop.run_in_executor(
                None, _run_processing, mesh_url, style, resolution, output_format
            )

            blob_name = f"stylize/{task_id}.{output_format}"
            blob = _bucket.blob(blob_name)
            await loop.run_in_executor(
                None, lambda: _upload_result(blob, out_bytes, content_type)
            )
            result_url = f"https://storage.googleapis.com/{GCS_BUCKET}/{blob_name}"

            elapsed = time.time() - t0
            _tasks[task_id].update({
                "status": "done",
                "result_url": result_url,
                "face_count": face_count,
                "style": style,
                "resolution": resolution,
                "output_format": output_format,
                "bytes": len(out_bytes),
                "elapsed_ms": int(elapsed * 1000),
            })
            log.info(
                "[%s] %s done in %.2fs — %d faces, %d bytes → %s",
                task_id, style, elapsed, face_count, len(out_bytes), result_url,
            )
        except Exception as exc:  # noqa: BLE001
            _tasks[task_id].update({
                "status": "failed",
                "error": safe_error(exc, context=f"[{task_id}] stylize {style}"),
                "elapsed_ms": int((time.time() - t0) * 1000),
            })


class ProcessRequest(BaseModel):
    mesh: str = Field(..., description="https URL to input mesh (GLB/OBJ/FBX/STL/PLY)")
    style: str = Field(default="voxel", description="|".join(STYLE_CATALOG))
    resolution: Optional[int] = Field(default=None, description="Style-specific density; see /styles")
    output_format: str = Field(default="glb")

    @field_validator("style")
    @classmethod
    def validate_style(cls, v: str) -> str:
        v = v.lower().strip()
        if v not in STYLE_CATALOG:
            raise ValueError(f"unknown style: {v}. Choose from {sorted(STYLE_CATALOG)}")
        return v

    @field_validator("output_format")
    @classmethod
    def validate_format(cls, v: str) -> str:
        v = v.lower().lstrip(".")
        if v not in SUPPORTED_OUTPUT_FORMATS:
            raise ValueError(f"unsupported output format: {v}. Choose from {sorted(SUPPORTED_OUTPUT_FORMATS)}")
        return v


@app.post("/process", status_code=202)
async def process_mesh(
    body: ProcessRequest,
    background_tasks: BackgroundTasks,
    authorization: Optional[str] = Header(default=None),
) -> dict:
    _require_api_key(authorization)
    resolution = _clamp_resolution(body.style, body.resolution)
    task_id = str(uuid.uuid4())
    _remember_task({
        "task_id": task_id,
        "status": "queued",
        "style": body.style,
        "resolution": resolution,
        "output_format": body.output_format,
    })
    background_tasks.add_task(
        _process, task_id, body.mesh, body.style, resolution, body.output_format
    )
    return {"task_id": task_id, "status": "queued", "style": body.style, "resolution": resolution}


@app.get("/tasks/{task_id}")
async def get_task(task_id: str, authorization: Optional[str] = Header(default=None)) -> dict:
    _require_api_key(authorization)
    task = _tasks.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return task


@app.get("/styles")
async def list_styles() -> dict:
    """Public filter catalog — drives the UI gallery and documents the density knob."""
    return {
        "styles": [
            {"key": key, "name": spec["name"], "description": spec["description"], "resolution": spec["resolution"]}
            for key, spec in STYLE_CATALOG.items()
        ]
    }


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "service": "stylize", "styles": list(STYLE_CATALOG)}
