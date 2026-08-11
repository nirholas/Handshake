"""
Mesh processing service — remesh, simplify, repair, retopologize, and convert 3D files.

Wraps trimesh + open3d + QuadriFlow + xatlas, with Blender (bpy) for FBX export.
No GPU required; runs on CPU. Handles:
  - Format conversion (GLB ↔ OBJ ↔ FBX ↔ STL ↔ PLY ↔ USDZ ↔ 3MF)
  - FBX export with skeletons — a `convert` of a rigged GLB keeps its bone
    hierarchy, skin weights, and blendshapes (via headless Blender; see
    blender_fbx.py). trimesh has no FBX writer, so this is the only path that
    round-trips a rig.
  - Triangle decimation (quadric error metric via open3d)
  - Quad remeshing (field-aligned quad-dominant topology via QuadriFlow, MIT)
  - Smart low-poly (silhouette-preserving decimation + UV re-unwrap + texture re-bake)
  - Mesh repair (fill holes, remove degenerate faces, fix normals)
  - Vertex deduplication and cleaning

Tooling / licensing:
  - QuadriFlow (https://github.com/hjwdzh/QuadriFlow) — MIT, commercial-OK. A scalable,
    robust field-aligned quadrangulation method. Invoked as a separate CLI process
    (built from source in the Dockerfile) so its permissively-licensed transitive deps
    never link into our code. Chosen over Instant Meshes (GPLv3) and Exoside Quad
    Remesher (paid, closed) precisely because MIT is unambiguously commercial-safe.
  - xatlas (https://github.com/jpcy/xatlas, via xatlas-python) — MIT. UV atlas
    generation used to re-unwrap remeshed geometry so a baked texture maps cleanly.

API contract:
  POST /process  {
    mesh: url,                       # https GLB/OBJ/FBX/STL URL (required)
    remesh_mode: "triangle"|"quad"|"lowpoly",   # default: "triangle"
    operation: "convert"|"simplify"|"repair"|"full",   # default: "full" (triangle mode only)
    target_faces?: int,              # default: 50000, range: 1000–500000
    texture_size?: int,              # 512|1024|2048, default 1024 (bake atlas size)
    output_format?: "glb"|"obj"|"stl"|"ply"|"usdz"|"3mf"|"fbx",  # default: "glb"
  } → 202 { task_id, status }

  GET /tasks/:id → {
    task_id, status, result_url?, texture_url?, mtl_url?,
    face_count?, quad_ratio?, mode?, textured?, error?
  }

  GET /health    → { ok }

Environment variables:
  API_KEY        — bearer secret (required)
  GCS_BUCKET     — output bucket (required)
  MAX_CONCURRENT — default 2
  QUADRIFLOW_BIN — path to the quadriflow executable (default: "quadriflow")
  BLENDER_TIMEOUT — seconds before a Blender FBX export is killed (default: 300)
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from google.cloud import storage
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
log = logging.getLogger("remesh")

API_KEY = os.environ["API_KEY"]
GCS_BUCKET = os.environ["GCS_BUCKET"]
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "2"))
QUADRIFLOW_BIN = os.environ.get("QUADRIFLOW_BIN", "quadriflow")

_bucket: Optional[storage.Bucket] = None
_sem: Optional[asyncio.Semaphore] = None
_tasks: dict[str, dict] = {}

SUPPORTED_INPUT_FORMATS = {".glb", ".gltf", ".obj", ".stl", ".ply", ".fbx", ".off", ".dae"}
SUPPORTED_OUTPUT_FORMATS = {"glb", "obj", "stl", "ply", "usdz", "3mf", "fbx"}
VALID_MODES = {"triangle", "quad", "lowpoly"}
VALID_TEXTURE_SIZES = {512, 1024, 2048}
MAX_MESH_BYTES = 128 * 1024 * 1024

# Headless-Blender FBX export. Blender is the only tool here that writes an FBX
# with a real skeleton; we run it as a one-shot subprocess (bpy holds global,
# non-thread-safe state — a fresh process per job is the safe pattern).
BLENDER_FBX_SCRIPT = Path(__file__).parent / "blender_fbx.py"
BLENDER_TIMEOUT = int(os.environ.get("BLENDER_TIMEOUT", "300"))
# Formats the `bpy` wheel imports reliably as a single self-contained file, so
# Blender can read (and keep) their rig directly. Excluded and bridged through a
# trimesh-written GLB instead:
#   .gltf — JSON with external .bin/texture refs a single fetched file can't carry
#   .dae  — Collada importer isn't bundled in the standalone bpy wheel
#   .off  — Blender has no OFF importer at all
BLENDER_IMPORT_FORMATS = {".glb", ".fbx", ".obj", ".stl", ".ply"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _bucket, _sem
    _bucket = storage.Client().bucket(GCS_BUCKET)
    _sem = asyncio.Semaphore(MAX_CONCURRENT)
    import trimesh
    import open3d
    quad = shutil.which(QUADRIFLOW_BIN) or QUADRIFLOW_BIN
    log.info(
        "remesh service ready — trimesh %s, open3d %s, quadriflow=%s",
        trimesh.__version__, open3d.__version__, quad,
    )
    yield


app = FastAPI(title="remesh-service", lifespan=lifespan)


def _require_api_key(authorization: str) -> None:
    try:
        require_api_key(authorization, API_KEY)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


# ── Loading ──────────────────────────────────────────────────────────────────

def _fetch_mesh(url: str) -> tuple[bytes, str]:
    try:
        data = fetch_remote_bytes(url, timeout=60, max_bytes=MAX_MESH_BYTES)
    except UnsafeUrlError as exc:
        raise ValueError(f"refused to fetch mesh: {exc}") from exc
    suffix = Path(url.split("?")[0]).suffix.lower()
    if suffix not in SUPPORTED_INPUT_FORMATS:
        suffix = ".glb"
    return data, suffix


def _load_concatenated(data: bytes, suffix: str):
    """Load a mesh, flattening any scene into one Trimesh. Drops materials —
    used by the triangle pipeline where texture transfer is not performed."""
    import trimesh
    mesh = trimesh.load(
        io.BytesIO(data), file_type=suffix.lstrip("."), force="mesh", process=False,
    )
    if isinstance(mesh, trimesh.Scene):
        meshes = [g for g in mesh.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not meshes:
            raise ValueError("no renderable geometry found in scene")
        mesh = trimesh.util.concatenate(meshes)
    return mesh


def _load_textured(data: bytes, suffix: str):
    """Load preserving UVs + texture for the quad/lowpoly pipelines. When the
    asset is a multi-mesh scene we keep the single largest textured submesh so
    its UV/material survives (concatenation would discard per-mesh textures)."""
    import trimesh
    loaded = trimesh.load(io.BytesIO(data), file_type=suffix.lstrip("."), process=False)

    if isinstance(loaded, trimesh.Trimesh):
        return loaded

    if isinstance(loaded, trimesh.Scene):
        meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
        if not meshes:
            raise ValueError("no renderable geometry found in scene")
        textured = [m for m in meshes if _source_texture(m)[1] is not None]
        if textured:
            return max(textured, key=lambda m: len(m.faces))
        # No textures anywhere — concatenating is lossless for geometry.
        return trimesh.util.concatenate(meshes)

    raise ValueError("unsupported mesh container")


def _source_texture(mesh):
    """Return (uv ndarray | None, PIL.Image | None) for a mesh's base texture."""
    import numpy as np
    visual = getattr(mesh, "visual", None)
    uv = getattr(visual, "uv", None)
    if uv is not None:
        uv = np.asarray(uv)
        if uv.ndim != 2 or len(uv) != len(mesh.vertices):
            uv = None
    image = None
    material = getattr(visual, "material", None)
    if material is not None:
        image = (
            getattr(material, "baseColorTexture", None)
            or getattr(material, "image", None)
        )
    return uv, image


# ── Repair / triangle decimation (existing behaviour) ────────────────────────

def _repair_mesh(mesh):
    import trimesh
    trimesh.repair.fill_holes(mesh)
    mask = mesh.nondegenerate_faces()
    mesh.update_faces(mask)
    trimesh.repair.fix_normals(mesh)
    mesh.merge_vertices()
    mesh.remove_unreferenced_vertices()
    return mesh


def _decimate(mesh, target_faces: int):
    """Quadric (QEM) triangle decimation via open3d, trimesh fallback.

    QEM preserves the silhouette far better than uniform clustering, which is
    exactly the property the low-poly preset relies on."""
    import open3d as o3d
    import numpy as np

    if len(mesh.faces) <= target_faces:
        return mesh

    try:
        o3d_mesh = o3d.geometry.TriangleMesh()
        o3d_mesh.vertices = o3d.utility.Vector3dVector(mesh.vertices.astype(np.float64))
        o3d_mesh.triangles = o3d.utility.Vector3iVector(mesh.faces.astype(np.int32))
        simplified = o3d_mesh.simplify_quadric_decimation(int(target_faces))
        simplified.remove_unreferenced_vertices()
        simplified.compute_vertex_normals()

        import trimesh
        return trimesh.Trimesh(
            vertices=np.asarray(simplified.vertices),
            faces=np.asarray(simplified.triangles),
            vertex_normals=np.asarray(simplified.vertex_normals),
            process=False,
        )
    except Exception as exc:
        log.warning("open3d decimation failed (%s), using trimesh fallback", exc)
        return mesh.simplify_quadric_decimation(int(target_faces))


# ── Quad remeshing (QuadriFlow) ──────────────────────────────────────────────

def _write_obj_geometry(mesh, path: Path) -> None:
    """Write a minimal v/f OBJ — QuadriFlow only consumes geometry."""
    import numpy as np
    v = np.asarray(mesh.vertices)
    f = np.asarray(mesh.faces)
    lines = [f"v {x:.6f} {y:.6f} {z:.6f}" for x, y, z in v]
    lines += [f"f {a + 1} {b + 1} {c + 1}" for a, b, c in f]
    path.write_text("\n".join(lines) + "\n")


def _parse_obj(path: Path):
    """Parse an OBJ into (vertices, faces) where faces preserve quad arity.

    Returns (np.ndarray[V,3], list[list[int]] 0-based). Polygons with >4 sides
    are fan-triangulated; tris and quads are kept verbatim so quad_ratio is real."""
    import numpy as np
    verts: list[list[float]] = []
    faces: list[list[int]] = []
    for raw in path.read_text().splitlines():
        if raw.startswith("v "):
            _, x, y, z = raw.split()[:4]
            verts.append([float(x), float(y), float(z)])
        elif raw.startswith("f "):
            idx = [int(tok.split("/")[0]) - 1 for tok in raw.split()[1:]]
            if len(idx) <= 4:
                faces.append(idx)
            else:
                for i in range(1, len(idx) - 1):
                    faces.append([idx[0], idx[i], idx[i + 1]])
    return np.asarray(verts, dtype=np.float64), faces


# QuadriFlow solver ladder, best topology first. `-mcf` (minimum-cost flow)
# gives the cleanest loops and the fewest singularities, but its index-map solve
# is fragile on meshes with open boundaries, which is most rigged character
# exports: on CesiumMan it aborts outright with "wrong init", and on denser
# inputs it is what ran past the timeout on 2026-08-06. Dropping to QuadriFlow's
# default solver still produces a genuine quad remesh with a real quad_ratio, so
# the caller gets what it asked for. Falling back to triangle soup never happens.
QUADRIFLOW_ATTEMPTS = (
    ("-mcf", "-sharp"),
    ("-sharp",),
    (),
)
QUADRIFLOW_BUDGET_S = 600.0


def _quad_remesh(mesh, target_faces: int):
    """Run QuadriFlow to produce quad-dominant topology.

    Returns (verts, polys, quad_ratio) where polys is a list of 0-based index
    lists (length 3 or 4). Walks QUADRIFLOW_ATTEMPTS until one succeeds, sharing
    a single wall-clock budget across them. Raises with an actionable message if
    the binary is missing or every solver fails."""
    binary = shutil.which(QUADRIFLOW_BIN) or QUADRIFLOW_BIN
    if shutil.which(QUADRIFLOW_BIN) is None and not os.path.isfile(binary):
        raise RuntimeError(
            "quad remesher unavailable: the quadriflow binary was not found. "
            "Build it from https://github.com/hjwdzh/QuadriFlow and set QUADRIFLOW_BIN."
        )

    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.obj"
        _write_obj_geometry(mesh, src)

        deadline = time.monotonic() + QUADRIFLOW_BUDGET_S
        last_error = "quad remesh produced no attempts"
        dst = None

        for attempt, flags in enumerate(QUADRIFLOW_ATTEMPTS):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                last_error = (
                    f"quad remesh ran out of its {int(QUADRIFLOW_BUDGET_S)}s budget; "
                    f"last solver said: {last_error}"
                )
                break

            candidate = Path(tmp) / f"out{attempt}.obj"
            cmd = [
                binary,
                "-i", str(src),
                "-o", str(candidate),
                "-f", str(max(1000, int(target_faces))),
                *flags,
            ]
            try:
                proc = subprocess.run(
                    cmd, capture_output=True, text=True, timeout=remaining, check=False,
                )
            except subprocess.TimeoutExpired:
                last_error = f"solver {flags or ('default',)} timed out"
                log.warning("quad remesh: %s, trying the next solver", last_error)
                continue

            if proc.returncode == 0 and candidate.exists():
                dst = candidate
                if attempt:
                    log.info("quad remesh: solver %s succeeded after a fallback", flags or ("default",))
                break

            tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-5:]
            last_error = f"solver {flags or ('default',)} failed: " + " | ".join(tail)
            log.warning("quad remesh: %s", last_error)

        if dst is None:
            raise RuntimeError("quad remesh failed: " + last_error)

        verts, polys = _parse_obj(dst)

    if not polys:
        raise RuntimeError("quad remesh produced empty output")
    quads = sum(1 for p in polys if len(p) == 4)
    quad_ratio = quads / len(polys)
    return verts, polys, quad_ratio


def _make_manifold(mesh):
    """Strip the topology QuadriFlow refuses, returning the input unchanged if
    the cleanup would leave nothing behind.

    QuadriFlow's index-map solve aborts with "wrong init" on a mesh whose edges
    are shared by more than two faces. Character exports hit that constantly:
    they are assembled from overlapping parts, so body and clothing seams meet on
    shared edges. `_repair_mesh` does not help here (trimesh has no non-manifold
    edge removal); open3d does."""
    import numpy as np
    import open3d as o3d
    import trimesh

    o3d_mesh = o3d.geometry.TriangleMesh()
    o3d_mesh.vertices = o3d.utility.Vector3dVector(
        np.asarray(mesh.vertices, dtype=np.float64)
    )
    o3d_mesh.triangles = o3d.utility.Vector3iVector(
        np.asarray(mesh.faces, dtype=np.int32)
    )
    o3d_mesh.remove_duplicated_vertices()
    o3d_mesh.remove_duplicated_triangles()
    o3d_mesh.remove_degenerate_triangles()
    o3d_mesh.remove_non_manifold_edges()
    o3d_mesh.remove_unreferenced_vertices()

    faces = np.asarray(o3d_mesh.triangles)
    if len(faces) == 0:
        log.warning("manifold cleanup removed every face; using the source mesh")
        return mesh
    return trimesh.Trimesh(
        vertices=np.asarray(o3d_mesh.vertices), faces=faces, process=False,
    )


def _triangulate_polys(verts, polys):
    """Triangulate a mixed tri/quad polygon list into a Trimesh (for GLB export
    and texture baking — glTF has no native quads)."""
    import numpy as np
    import trimesh
    tris: list[list[int]] = []
    for p in polys:
        if len(p) == 3:
            tris.append(p)
        elif len(p) == 4:
            tris.append([p[0], p[1], p[2]])
            tris.append([p[0], p[2], p[3]])
    mesh = trimesh.Trimesh(vertices=verts, faces=np.asarray(tris), process=False)
    mesh.remove_unreferenced_vertices()
    return mesh


# ── UV unwrap + texture baking ───────────────────────────────────────────────

def _unwrap(mesh):
    """Generate a clean UV atlas for `mesh` with xatlas.

    Returns (vertices, faces, uv) on xatlas' (possibly re-indexed) vertex set,
    or None if xatlas is unavailable."""
    try:
        import xatlas
    except Exception as exc:  # pragma: no cover - import guard
        log.warning("xatlas unavailable (%s); skipping UV unwrap", exc)
        return None
    import numpy as np
    vmapping, indices, uvs = xatlas.parametrize(
        np.asarray(mesh.vertices, dtype=np.float32),
        np.asarray(mesh.faces, dtype=np.uint32),
    )
    new_vertices = np.asarray(mesh.vertices)[vmapping]
    return new_vertices, np.asarray(indices, dtype=np.int64), np.asarray(uvs, dtype=np.float64)


def _dilate(img, mask, iters: int = 6):
    """Edge-pad a baked atlas so bilinear sampling at UV-island borders doesn't
    bleed background. Iteratively fills empty texels from filled 4-neighbours."""
    import numpy as np
    img = img.copy()
    mask = mask.copy()
    for _ in range(iters):
        if mask.all():
            break
        filled = mask
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            shifted = np.roll(filled, (dy, dx), axis=(0, 1))
            shifted_img = np.roll(img, (dy, dx), axis=(0, 1))
            take = shifted & ~mask
            img[take] = shifted_img[take]
            mask = mask | take
    return img


def _bake_texture(source_mesh, src_uv, src_img, verts, faces, uvs, tex_size: int):
    """Re-project the source texture onto a remeshed target's new UV atlas.

    For every texel covered by a target triangle we find its 3D position, query
    the closest point on the original textured surface, read the original UV
    there, and sample the original texture. This transfers the appearance even
    though topology and UVs changed completely."""
    import numpy as np
    import trimesh
    from PIL import Image

    src_arr = np.asarray(src_img.convert("RGB"))
    sh, sw = src_arr.shape[:2]
    src_faces = np.asarray(source_mesh.faces)
    src_tris = source_mesh.triangles  # (F,3,3)
    prox = trimesh.proximity.ProximityQuery(source_mesh)

    atlas = np.zeros((tex_size, tex_size, 3), dtype=np.uint8)
    written = np.zeros((tex_size, tex_size), dtype=bool)

    sample_pts: list = []
    sample_px: list = []  # (row, col)

    uv_px = uvs.copy()
    uv_px[:, 0] = np.clip(uvs[:, 0], 0.0, 1.0) * (tex_size - 1)
    uv_px[:, 1] = (1.0 - np.clip(uvs[:, 1], 0.0, 1.0)) * (tex_size - 1)

    for tri in faces:
        p = uv_px[tri]                       # 3×(col,row)
        v3 = verts[tri]                      # 3×3 world
        min_c = int(np.floor(p[:, 0].min())); max_c = int(np.ceil(p[:, 0].max()))
        min_r = int(np.floor(p[:, 1].min())); max_r = int(np.ceil(p[:, 1].max()))
        min_c = max(0, min_c); min_r = max(0, min_r)
        max_c = min(tex_size - 1, max_c); max_r = min(tex_size - 1, max_r)
        if max_c < min_c or max_r < min_r:
            continue

        cols, rows = np.meshgrid(
            np.arange(min_c, max_c + 1), np.arange(min_r, max_r + 1)
        )
        cols = cols.ravel(); rows = rows.ravel()

        # Barycentric coords of each texel centre against the UV triangle.
        x1, y1 = p[0]; x2, y2 = p[1]; x3, y3 = p[2]
        det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3)
        if abs(det) < 1e-9:
            continue
        px = cols + 0.5; py = rows + 0.5
        a = ((y2 - y3) * (px - x3) + (x3 - x2) * (py - y3)) / det
        b = ((y3 - y1) * (px - x3) + (x1 - x3) * (py - y3)) / det
        c = 1.0 - a - b
        inside = (a >= -1e-4) & (b >= -1e-4) & (c >= -1e-4)
        if not inside.any():
            continue

        bary = np.stack([a[inside], b[inside], c[inside]], axis=1)  # (k,3)
        pts3d = bary @ v3                                            # (k,3)
        sample_pts.append(pts3d)
        sample_px.append(np.stack([rows[inside], cols[inside]], axis=1))

    if not sample_pts:
        return uvs, None

    pts = np.concatenate(sample_pts, axis=0)
    px_idx = np.concatenate(sample_px, axis=0)

    closest, _dist, tri_ids = prox.on_surface(pts)
    closest_tris = src_tris[tri_ids]                                # (k,3,3)
    bary_src = trimesh.triangles.points_to_barycentric(closest_tris, closest)
    face_uv = src_uv[src_faces[tri_ids]]                            # (k,3,2)
    samp_uv = np.einsum("ij,ijk->ik", bary_src, face_uv)           # (k,2)

    sx = np.clip(samp_uv[:, 0], 0.0, 1.0) * (sw - 1)
    sy = (1.0 - np.clip(samp_uv[:, 1], 0.0, 1.0)) * (sh - 1)
    colors = src_arr[np.rint(sy).astype(int), np.rint(sx).astype(int)]

    atlas[px_idx[:, 0], px_idx[:, 1]] = colors
    written[px_idx[:, 0], px_idx[:, 1]] = True
    atlas = _dilate(atlas, written)

    return uvs, Image.fromarray(atlas, mode="RGB")


# ── Export ───────────────────────────────────────────────────────────────────

class Artifact:
    __slots__ = ("name", "data", "content_type", "role")

    def __init__(self, name: str, data: bytes, content_type: str, role: str):
        self.name = name
        self.data = data
        self.content_type = content_type
        self.role = role  # "model" | "texture" | "material"


def _build_textured_trimesh(verts, faces, uvs, image):
    import trimesh
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
    if uvs is not None and image is not None:
        mesh.visual = trimesh.visual.TextureVisuals(
            uv=uvs, image=image, material=trimesh.visual.material.SimpleMaterial(image=image),
        )
    return mesh


def _write_textured_quad_obj(verts, polys, uvs, image, task_id: str) -> list:
    """Write a true-quad OBJ that keeps quad faces and references a baked texture
    via a sibling .mtl + .png (relative names resolve from the same GCS prefix)."""
    import numpy as np
    mtl_name = f"{task_id}.mtl"
    png_name = f"{task_id}.png"

    lines = [f"mtllib {mtl_name}", "o remesh", "usemtl baked"]
    for x, y, z in verts:
        lines.append(f"v {x:.6f} {y:.6f} {z:.6f}")
    has_uv = uvs is not None and image is not None
    if has_uv:
        for u, v in uvs:
            lines.append(f"vt {u:.6f} {v:.6f}")
    for poly in polys:
        if has_uv:
            lines.append("f " + " ".join(f"{i + 1}/{i + 1}" for i in poly))
        else:
            lines.append("f " + " ".join(str(i + 1) for i in poly))
    obj_bytes = ("\n".join(lines) + "\n").encode("utf-8")

    artifacts = [Artifact(f"{task_id}.obj", obj_bytes, "model/obj", "model")]
    if has_uv:
        mtl = (
            "newmtl baked\nKa 1 1 1\nKd 1 1 1\nKs 0 0 0\n"
            f"map_Kd {png_name}\n"
        ).encode("utf-8")
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        artifacts.append(Artifact(mtl_name, mtl, "text/plain", "material"))
        artifacts.append(Artifact(png_name, buf.getvalue(), "image/png", "texture"))
    return artifacts


def _face_count_marker(stdout: str) -> Optional[int]:
    """Read blender_fbx.py's completion marker, or None when it never got there.

    The child prints `FACE_COUNT:<n>` only after the exporter returned and the
    written file was confirmed non-empty, which makes it a stronger success
    signal than the exit code."""
    for line in stdout.splitlines():
        if line.startswith("FACE_COUNT:"):
            try:
                return int(line.split(":", 1)[1].strip())
            except ValueError:
                return None
    return None


def _blender_to_fbx(in_path: Path, out_path: Path, static: bool) -> int:
    """Convert a local model file to FBX via headless Blender, preserving the
    skeleton, skin weights, and blendshapes when the input carries them.

    Returns the exported polygon count. Raises RuntimeError with a clipped log
    tail on failure. `static=True` skips animation baking (used when the upstream
    geometry op already discarded any rig).

    Completion is judged by the child's FACE_COUNT marker plus a non-empty file,
    not by its exit status. Blender can die in its own interpreter teardown after
    a fully written export (this is why every FBX request failed until
    2026-08-11), and throwing away a finished file over that is a bug, not
    caution. `blender_fbx.py` now exits before finalization, so the fallback
    should never fire; it stays as the guard that keeps a good export."""
    cmd = [sys.executable, str(BLENDER_FBX_SCRIPT), str(in_path), str(out_path)]
    if static:
        cmd.append("--static")
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=BLENDER_TIMEOUT, check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"FBX export timed out after {BLENDER_TIMEOUT}s") from exc

    faces = _face_count_marker(proc.stdout)
    written = out_path.exists() and out_path.stat().st_size > 0
    if faces is None or not written:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-6:]
        raise RuntimeError(
            f"FBX export failed (rc={proc.returncode}): " + " | ".join(tail)
        )

    if proc.returncode != 0:
        log.warning(
            "blender exited abnormally (rc=%s) after writing a complete %s-byte FBX; keeping it",
            proc.returncode, out_path.stat().st_size,
        )
    return faces


def _convert_to_fbx_preserving_rig(data: bytes, suffix: str, task_id: str) -> tuple[list, dict]:
    """`convert` → FBX without touching geometry, so a rigged GLB keeps its bone
    hierarchy, skin weights, and blendshapes. Blender imports the source
    directly when it can read it as one self-contained file; the rest
    (`.gltf`/`.dae`/`.off` — see BLENDER_IMPORT_FORMATS) are bridged through a
    trimesh-written GLB, which yields a static FBX."""
    with tempfile.TemporaryDirectory() as tmp:
        out_path = Path(tmp) / f"{task_id}.fbx"
        if suffix in BLENDER_IMPORT_FORMATS:
            src_path = Path(tmp) / f"input{suffix}"
            src_path.write_bytes(data)
            faces = _blender_to_fbx(src_path, out_path, static=False)
        else:
            import trimesh
            mesh = _load_concatenated(data, suffix)
            glb_path = Path(tmp) / "bridge.glb"
            trimesh.scene.scene.Scene(geometry={"mesh": mesh}).export(str(glb_path))
            faces = _blender_to_fbx(glb_path, out_path, static=True)
        fbx_bytes = out_path.read_bytes()
    meta = {"quad_ratio": 0.0, "textured": False, "face_count": faces}
    return [Artifact(f"{task_id}.fbx", fbx_bytes, "application/octet-stream", "model")], meta


def _write_usdz(mesh, task_id: str, out_path: Path) -> None:
    """Write a USDZ package with `pxr` (usd-core).

    trimesh has no USDZ writer, so the geometry is authored directly onto a USD
    stage and zipped with UsdUtils. A textured mesh gets a UsdPreviewSurface
    reading a sibling PNG, which the packager pulls into the archive. Y-up and
    metersPerUnit 1 are what AR Quick Look and Scene Viewer expect."""
    import numpy as np
    from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade, UsdUtils, Vt

    work = out_path.parent
    stage_path = work / f"{task_id}.usdc"
    stage = Usd.Stage.CreateNew(str(stage_path))
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)

    root = UsdGeom.Xform.Define(stage, "/Root")
    stage.SetDefaultPrim(root.GetPrim())
    usd_mesh = UsdGeom.Mesh.Define(stage, "/Root/Mesh")

    verts = np.ascontiguousarray(mesh.vertices, dtype=np.float32)
    faces = np.ascontiguousarray(mesh.faces, dtype=np.int32)
    usd_mesh.CreatePointsAttr(Vt.Vec3fArray.FromNumpy(verts))
    usd_mesh.CreateFaceVertexCountsAttr(
        Vt.IntArray.FromNumpy(np.full(len(faces), 3, dtype=np.int32))
    )
    usd_mesh.CreateFaceVertexIndicesAttr(Vt.IntArray.FromNumpy(faces.reshape(-1)))
    usd_mesh.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
    lo = verts.min(axis=0)
    hi = verts.max(axis=0)
    usd_mesh.CreateExtentAttr(
        Vt.Vec3fArray([Gf.Vec3f(*lo.tolist()), Gf.Vec3f(*hi.tolist())])
    )

    uv, image = _source_texture(mesh)
    if uv is not None and image is not None:
        texture_name = f"{task_id}.png"
        image.convert("RGB").save(work / texture_name, format="PNG")

        st = UsdGeom.PrimvarsAPI(usd_mesh).CreatePrimvar(
            "st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.vertex
        )
        st.Set(Vt.Vec2fArray.FromNumpy(np.ascontiguousarray(uv, dtype=np.float32)))

        material = UsdShade.Material.Define(stage, "/Root/Material")
        reader = UsdShade.Shader.Define(stage, "/Root/Material/stReader")
        reader.CreateIdAttr("UsdPrimvarReader_float2")
        reader.CreateInput("varname", Sdf.ValueTypeNames.Token).Set("st")
        reader_out = reader.CreateOutput("result", Sdf.ValueTypeNames.Float2)

        sampler = UsdShade.Shader.Define(stage, "/Root/Material/Texture")
        sampler.CreateIdAttr("UsdUVTexture")
        sampler.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(texture_name)
        sampler.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(reader_out)
        sampler_rgb = sampler.CreateOutput("rgb", Sdf.ValueTypeNames.Float3)

        surface = UsdShade.Shader.Define(stage, "/Root/Material/Surface")
        surface.CreateIdAttr("UsdPreviewSurface")
        surface.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(0.7)
        surface.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(0.0)
        surface.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(
            sampler_rgb
        )
        material.CreateSurfaceOutput().ConnectToSource(
            surface.CreateOutput("surface", Sdf.ValueTypeNames.Token)
        )
        UsdShade.MaterialBindingAPI.Apply(usd_mesh.GetPrim()).Bind(material)

    stage.GetRootLayer().Save()
    if not UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(str(stage_path)), str(out_path)):
        raise RuntimeError("usdz packaging failed")


def _export_simple(mesh, output_format: str, task_id: str) -> list:
    """Export a Trimesh to a single self-contained file (GLB embeds textures).

    Two formats have no trimesh writer. FBX is bridged through a temp GLB and
    handed to Blender; this path always yields a static FBX, because the Trimesh
    has already lost any rig by the time geometry ops produce it (the
    rig-preserving route is `_convert_to_fbx_preserving_rig`). USDZ is authored
    with `pxr` in `_write_usdz`."""
    import trimesh
    fmt = output_format.lower()
    with tempfile.TemporaryDirectory() as tmpdir:
        out_path = Path(tmpdir) / f"{task_id}.{fmt}"
        if fmt == "fbx":
            glb_path = Path(tmpdir) / f"{task_id}.glb"
            trimesh.scene.scene.Scene(geometry={"mesh": mesh}).export(str(glb_path))
            _blender_to_fbx(glb_path, out_path, static=True)
        elif fmt == "usdz":
            _write_usdz(mesh, task_id, out_path)
        elif fmt == "glb":
            trimesh.scene.scene.Scene(geometry={"mesh": mesh}).export(str(out_path))
        else:
            mesh.export(str(out_path))
        data = out_path.read_bytes()
    ct = {
        "glb": "model/gltf-binary",
        "usdz": "model/vnd.usdz+zip",
        "fbx": "application/octet-stream",
    }.get(fmt, "application/octet-stream")
    return [Artifact(f"{task_id}.{fmt}", data, ct, "model")]


# ── Pipelines ────────────────────────────────────────────────────────────────

def _process_triangle(mesh, operation: str, target_faces: int):
    if operation in ("repair", "full"):
        mesh = _repair_mesh(mesh)
    if operation in ("simplify", "full") and len(mesh.faces) > target_faces:
        mesh = _decimate(mesh, target_faces)
    return mesh, {"quad_ratio": 0.0, "textured": False}


def _process_quad(source, target_faces: int, output_format: str, tex_size: int, task_id: str):
    import trimesh
    src_uv, src_img = _source_texture(source)
    # QuadriFlow wants a clean watertight-ish triangle mesh as input.
    geom = source.copy()
    _repair_mesh(geom)
    geom = _make_manifold(geom)
    verts, polys, quad_ratio = _quad_remesh(geom, target_faces)

    tri_mesh = _triangulate_polys(verts, polys)
    unwrap = _unwrap(tri_mesh)
    baked_uv = baked_img = None
    if unwrap is not None and src_uv is not None and src_img is not None:
        u_verts, u_faces, u_uv = unwrap
        baked_uv, baked_img = _bake_texture(
            source, src_uv, src_img, u_verts, u_faces, u_uv, tex_size,
        )
        tri_mesh = trimesh.Trimesh(vertices=u_verts, faces=u_faces, process=False)

    # OBJ output preserves the true quad faces (geometry only — the re-unwrapped
    # UVs live on the triangulated atlas, not the quads, so a textured atlas is
    # delivered via GLB). Every other format triangulates and carries the bake.
    if output_format == "obj":
        meta = {
            "quad_ratio": round(quad_ratio, 4),
            "textured": False,
            "face_count": len(polys),
        }
        return _write_textured_quad_obj(verts, polys, None, None, task_id), meta

    meta = {
        "quad_ratio": round(quad_ratio, 4),
        "textured": baked_img is not None,
        "face_count": len(polys),
    }
    mesh = _build_textured_trimesh(
        tri_mesh.vertices, tri_mesh.faces, baked_uv, baked_img,
    )
    return _export_simple(mesh, output_format, task_id), meta


def _process_lowpoly(source, target_faces: int, output_format: str, tex_size: int, task_id: str):
    import trimesh
    src_uv, src_img = _source_texture(source)
    geom = source.copy()
    _repair_mesh(geom)
    low = _decimate(geom, target_faces)

    unwrap = _unwrap(low)
    baked_uv = baked_img = None
    if unwrap is not None and src_uv is not None and src_img is not None:
        u_verts, u_faces, u_uv = unwrap
        baked_uv, baked_img = _bake_texture(
            source, src_uv, src_img, u_verts, u_faces, u_uv, tex_size,
        )
        low = trimesh.Trimesh(vertices=u_verts, faces=u_faces, process=False)

    low.fix_normals()
    meta = {
        "quad_ratio": 0.0,
        "textured": baked_img is not None,
        "face_count": len(low.faces),
    }

    if output_format == "obj" and baked_img is not None:
        polys = [list(map(int, f)) for f in low.faces]
        return _write_textured_quad_obj(low.vertices, polys, baked_uv, baked_img, task_id), meta

    mesh = _build_textured_trimesh(low.vertices, low.faces, baked_uv, baked_img)
    return _export_simple(mesh, output_format, task_id), meta


def _run_processing(
    mesh_url: str,
    remesh_mode: str,
    operation: str,
    target_faces: int,
    output_format: str,
    texture_size: int,
    task_id: str,
) -> tuple[list, dict]:
    data, suffix = _fetch_mesh(mesh_url)

    # A plain `convert` to FBX must keep the skeleton, so it never enters the
    # trimesh pipelines (which flatten the scene and drop the rig) — Blender
    # reads the source directly. Geometry-changing FBX requests fall through to
    # the pipelines below and emit a static FBX via _export_simple.
    if output_format == "fbx" and remesh_mode == "triangle" and operation == "convert":
        return _convert_to_fbx_preserving_rig(data, suffix, task_id)

    if remesh_mode == "quad":
        source = _load_textured(data, suffix)
        return _process_quad(source, target_faces, output_format, texture_size, task_id)

    if remesh_mode == "lowpoly":
        source = _load_textured(data, suffix)
        return _process_lowpoly(source, target_faces, output_format, texture_size, task_id)

    # triangle (default) — legacy behaviour, geometry only.
    mesh = _load_concatenated(data, suffix)
    mesh, meta = _process_triangle(mesh, operation, target_faces)
    meta["face_count"] = len(mesh.faces)
    return _export_simple(mesh, output_format, task_id), meta


# ── Task orchestration ───────────────────────────────────────────────────────

async def _process(
    task_id: str,
    mesh_url: str,
    remesh_mode: str,
    operation: str,
    target_faces: int,
    output_format: str,
    texture_size: int,
) -> None:
    async with _sem:
        _tasks[task_id]["status"] = "running"
        loop = asyncio.get_event_loop()
        t0 = time.time()
        try:
            artifacts, meta = await loop.run_in_executor(
                None,
                _run_processing,
                mesh_url,
                remesh_mode,
                operation,
                target_faces,
                output_format,
                texture_size,
                task_id,
            )

            urls: dict[str, str] = {}
            for art in artifacts:
                blob = _bucket.blob(f"remesh/{art.name}")
                await loop.run_in_executor(
                    None,
                    lambda b=blob, a=art: b.upload_from_string(a.data, content_type=a.content_type),
                )
                url = f"https://storage.googleapis.com/{GCS_BUCKET}/remesh/{art.name}"
                urls[art.role] = url

            total_bytes = sum(len(a.data) for a in artifacts)
            elapsed = time.time() - t0
            _tasks[task_id].update({
                "status": "done",
                "result_url": urls.get("model"),
                "texture_url": urls.get("texture"),
                "mtl_url": urls.get("material"),
                "face_count": meta.get("face_count"),
                "quad_ratio": meta.get("quad_ratio"),
                "textured": meta.get("textured"),
                "mode": remesh_mode,
                "output_format": output_format,
                "bytes": total_bytes,
                "elapsed_ms": int(elapsed * 1000),
            })
            log.info(
                "[%s] done in %.2fs — mode=%s, %s faces, quad_ratio=%s, textured=%s → %s",
                task_id, elapsed, remesh_mode, meta.get("face_count"),
                meta.get("quad_ratio"), meta.get("textured"), urls.get("model"),
            )

        except Exception as exc:
            _tasks[task_id].update({
                "status": "failed",
                "error": safe_error(exc, context=f"[{task_id}] remesh"),
                "elapsed_ms": int((time.time() - t0) * 1000),
            })


class ProcessRequest(BaseModel):
    mesh: str = Field(..., description="https URL to input mesh (GLB/OBJ/FBX/STL/PLY)")
    remesh_mode: str = Field(default="triangle", description="triangle|quad|lowpoly")
    operation: str = Field(default="full", description="convert|simplify|repair|full")
    target_faces: int = Field(default=50_000, ge=1_000, le=500_000)
    texture_size: int = Field(default=1024)
    output_format: str = Field(default="glb")

    @field_validator("output_format")
    @classmethod
    def validate_format(cls, v: str) -> str:
        v = v.lower().lstrip(".")
        if v not in SUPPORTED_OUTPUT_FORMATS:
            raise ValueError(f"unsupported output format: {v}. Choose from {sorted(SUPPORTED_OUTPUT_FORMATS)}")
        return v

    @field_validator("operation")
    @classmethod
    def validate_op(cls, v: str) -> str:
        allowed = {"convert", "simplify", "repair", "full"}
        if v not in allowed:
            raise ValueError(f"operation must be one of {sorted(allowed)}")
        return v

    @field_validator("remesh_mode")
    @classmethod
    def validate_mode(cls, v: str) -> str:
        v = (v or "triangle").lower()
        if v not in VALID_MODES:
            raise ValueError(f"remesh_mode must be one of {sorted(VALID_MODES)}")
        return v

    @field_validator("texture_size")
    @classmethod
    def validate_texture_size(cls, v: int) -> int:
        if v not in VALID_TEXTURE_SIZES:
            raise ValueError(f"texture_size must be one of {sorted(VALID_TEXTURE_SIZES)}")
        return v


@app.post("/process", status_code=202)
async def process_mesh(
    body: ProcessRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(...),
) -> dict:
    _require_api_key(authorization)
    task_id = str(uuid.uuid4())
    _tasks[task_id] = {
        "task_id": task_id,
        "status": "queued",
        "mode": body.remesh_mode,
        "operation": body.operation,
        "output_format": body.output_format,
    }
    background_tasks.add_task(
        _process,
        task_id,
        body.mesh,
        body.remesh_mode,
        body.operation,
        body.target_faces,
        body.output_format,
        body.texture_size,
    )
    return {"task_id": task_id, "status": "queued", "mode": body.remesh_mode}


@app.get("/tasks/{task_id}")
async def get_task(task_id: str, authorization: str = Header(...)) -> dict:
    _require_api_key(authorization)
    task = _tasks.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return task


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "service": "remesh"}
