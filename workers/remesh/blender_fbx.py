"""
Headless Blender → FBX converter for the remesh worker.

trimesh and assimp cannot write FBX with a skeleton: trimesh has no FBX
exporter at all, and pyassimp/assimp's FBX writer does not round-trip armatures,
skin weights, or blendshapes. Blender's `io_scene_fbx` exporter is the
industry-standard path that Unity and Unreal users implicitly rely on — it reads
a GLB's armature, per-vertex skin weights, and shape keys, and writes them back
out as a proper FBX bone hierarchy with blendshapes.

We run this as a one-shot subprocess (never in-process in the FastAPI worker):
`bpy` keeps a single global Blender context, is not thread-safe, and accumulates
data across operations. A fresh process per conversion gives a clean scene,
thread safety under the worker's concurrency, and reclaimed memory on exit.

Usage:
    python blender_fbx.py <input> <output.fbx> [--static]

`--static` skips animation baking — used when the upstream geometry op
(simplify/repair) has already discarded any rig, so the FBX is a plain mesh.

On success, prints `FACE_COUNT:<n>` to stdout (polygons across all mesh objects).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import bpy


def _leave(code: int, message: str = "") -> None:
    """Exit without running interpreter finalization.

    Tearing down the `bpy` module segfaults in the Cloud Run container once a
    scene has been imported: the FBX is written, `export finished` is printed,
    and the process then dies with SIGSEGV in Blender's own shutdown. The worker
    read that exit code as a failed export and discarded a perfectly good file,
    so every `output_format: "fbx"` request failed. Nothing here needs
    finalization, so skip it and report the real result."""
    if message:
        print(message, file=sys.stderr)
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


# Input extensions whose importers ship in the standalone `bpy` wheel. `.dae`
# (Collada) and `.off` are excluded — the wheel doesn't bundle the Collada
# importer and has no OFF importer, so the worker bridges those through a
# trimesh-written GLB before calling us.
_IMPORTERS = {".glb", ".gltf", ".fbx", ".obj", ".stl", ".ply"}


def _reset_scene() -> None:
    """Start from a truly empty file — no default cube, camera, or light."""
    bpy.ops.wm.read_factory_settings(use_empty=True)


def _enable_addon(module: str) -> None:
    try:
        bpy.ops.preferences.addon_enable(module=module)
    except Exception:
        # Bundled importers/exporters are enabled by default in the bpy module;
        # a failure here is non-fatal because the operator is still registered.
        pass


def _import_source(path: Path) -> None:
    suffix = path.suffix.lower()
    if suffix in (".glb", ".gltf"):
        _enable_addon("io_scene_gltf2")
        bpy.ops.import_scene.gltf(filepath=str(path), import_pack_images=True)
    elif suffix == ".fbx":
        _enable_addon("io_scene_fbx")
        bpy.ops.import_scene.fbx(filepath=str(path))
    elif suffix == ".obj":
        bpy.ops.wm.obj_import(filepath=str(path))
    elif suffix == ".stl":
        bpy.ops.wm.stl_import(filepath=str(path))
    elif suffix == ".ply":
        bpy.ops.wm.ply_import(filepath=str(path))
    else:
        raise SystemExit(f"blender_fbx: unsupported input format '{suffix}'")


def _face_count() -> int:
    total = 0
    for obj in bpy.data.objects:
        if obj.type == "MESH" and obj.data is not None:
            total += len(obj.data.polygons)
    return total


def _export_fbx(path: Path, static: bool) -> None:
    _enable_addon("io_scene_fbx")
    # path_mode='COPY' + embed_textures keeps the result a single self-contained
    # file. add_leaf_bones=False avoids the extra tip bones that make Unity warn.
    # use_armature_deform_only=False keeps every bone (control bones included).
    bpy.ops.export_scene.fbx(
        filepath=str(path),
        use_selection=False,
        apply_unit_scale=True,
        apply_scale_options="FBX_SCALE_NONE",
        use_mesh_modifiers=True,
        mesh_smooth_type="FACE",
        add_leaf_bones=False,
        use_armature_deform_only=False,
        bake_anim=not static,
        bake_anim_use_all_actions=not static,
        path_mode="COPY",
        embed_textures=True,
    )


def main() -> None:
    args = sys.argv[1:]
    static = "--static" in args
    positional = [a for a in args if not a.startswith("--")]
    if len(positional) != 2:
        _leave(2, "usage: blender_fbx.py <input> <output.fbx> [--static]")

    in_path = Path(positional[0])
    out_path = Path(positional[1])
    if in_path.suffix.lower() not in _IMPORTERS:
        _leave(2, f"blender_fbx: cannot import '{in_path.suffix}'")

    _reset_scene()
    _import_source(in_path)
    faces = _face_count()
    _export_fbx(out_path, static)

    if not out_path.exists() or out_path.stat().st_size == 0:
        _leave(1, "blender_fbx: exporter produced no output")

    # FACE_COUNT is the worker's completion marker: it is printed only after the
    # exporter returned and the file was confirmed non-empty.
    print(f"FACE_COUNT:{faces}")
    _leave(0)


if __name__ == "__main__":
    main()
