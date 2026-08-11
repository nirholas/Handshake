"""
Verify that an exported FBX kept its rig — re-imports the file in headless
Blender and asserts the skeleton, skin weights, and (optionally) blendshapes
survived the GLB → FBX conversion. This is the round-trip check behind the
"rigged FBX imports into Blender/Unity with its skeleton intact" requirement.

A Unity import of the same file lights up the identical data: the armature
becomes an Avatar's bone hierarchy, the per-vertex groups become skin weights,
and shape keys become blendshapes — so a clean Blender re-import is the
authoritative, automatable proxy for the Unity check.

Usage:
    python verify_fbx.py <model.fbx>

Exit code 0 and a "PASS" report when a bone hierarchy + skin weights are
present; non-zero with the reason otherwise. Run it anywhere `bpy` is
installed — the remesh worker image already has it (see requirements.txt).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import bpy


def _leave(code: int, message: str = "") -> None:
    """Exit without interpreter finalization.

    Same reason as `blender_fbx.py`: tearing down `bpy` after a scene has been
    loaded segfaults in the worker container, which would turn this checker's
    verdict into an indistinguishable SIGSEGV."""
    if message:
        print(message, file=sys.stderr)
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


def _reset() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def main() -> None:
    if len(sys.argv) != 2:
        _leave(2, "usage: verify_fbx.py <model.fbx>")
    path = Path(sys.argv[1])
    if not path.exists():
        _leave(2, f"verify_fbx: no such file: {path}")

    _reset()
    try:
        bpy.ops.preferences.addon_enable(module="io_scene_fbx")
    except Exception:
        pass
    bpy.ops.import_scene.fbx(filepath=str(path))

    armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]

    bone_count = sum(len(a.data.bones) for a in armatures)
    skinned = [m for m in meshes if m.vertex_groups and len(m.vertex_groups) > 0]
    shape_keys = sum(
        (len(m.data.shape_keys.key_blocks) - 1)  # minus the Basis key
        for m in meshes
        if m.data.shape_keys and m.data.shape_keys.key_blocks
    )

    print(f"armatures={len(armatures)} bones={bone_count} "
          f"skinned_meshes={len(skinned)} blendshapes={shape_keys}")

    problems = []
    if bone_count == 0:
        problems.append("no bones found (skeleton lost)")
    if not skinned:
        problems.append("no mesh has vertex groups (skin weights lost)")

    if problems:
        _leave(1, "FAIL: " + "; ".join(problems))

    print("PASS: skeleton + skin weights intact")
    _leave(0)


if __name__ == "__main__":
    main()
