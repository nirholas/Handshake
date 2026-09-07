"""In-Blender job runner for @three-ws/blender-mcp.

Blender is launched once per tool call as:

    blender -b --factory-startup -noaudio --python runner.py -- <job.json> <result.json>

The job file carries a single ``{"op": ..., ...}`` object; the result file
receives a single JSON object. Results go to a FILE rather than stdout because
Blender writes progress, addon chatter, and render statistics to stdout, and
parsing a payload out of that stream is guesswork. If the result file is absent
after the process exits, Blender crashed and the Node side says so.

Only the Blender Python API is used, so this runs unmodified in Blender 3.x and
4.x: every operator is resolved by name with fallbacks, and every keyword is
filtered against the operator's own RNA before the call, which is what keeps the
importer/exporter renames across releases from breaking a tool.
"""

from __future__ import annotations

import contextlib
import io
import json
import math
import os
import sys
import traceback

import bpy
from mathutils import Vector

# Extension -> ordered candidate importer operators. The first one that exists
# in the running Blender wins, which covers the 3.x -> 4.x operator renames
# (obj/stl/ply moved from import_scene/import_mesh to wm.*).
IMPORTERS = {
    ".glb": ("import_scene.gltf",),
    ".gltf": ("import_scene.gltf",),
    ".fbx": ("import_scene.fbx",),
    ".obj": ("wm.obj_import", "import_scene.obj"),
    ".stl": ("wm.stl_import", "import_mesh.stl"),
    ".ply": ("wm.ply_import", "import_mesh.ply"),
    ".dae": ("wm.collada_import",),
    ".abc": ("wm.alembic_import",),
    ".x3d": ("import_scene.x3d",),
    ".usd": ("wm.usd_import",),
    ".usda": ("wm.usd_import",),
    ".usdc": ("wm.usd_import",),
    ".usdz": ("wm.usd_import",),
}

EXPORTERS = {
    ".glb": ("export_scene.gltf",),
    ".gltf": ("export_scene.gltf",),
    ".fbx": ("export_scene.fbx",),
    ".obj": ("wm.obj_export", "export_scene.obj"),
    ".stl": ("wm.stl_export", "export_mesh.stl"),
    ".ply": ("wm.ply_export", "export_mesh.ply"),
    ".dae": ("wm.collada_export",),
    ".abc": ("wm.alembic_export",),
    ".x3d": ("export_scene.x3d",),
    ".usd": ("wm.usd_export",),
    ".usda": ("wm.usd_export",),
    ".usdc": ("wm.usd_export",),
    ".usdz": ("wm.usd_export",),
}


class JobError(Exception):
    """A job failed for a reason the caller can act on."""

    def __init__(self, message, code="blender_error"):
        super().__init__(message)
        self.code = code


def resolve_op(name):
    """Return the ``bpy.ops`` callable for ``group.operator``, or None.

    ``bpy.ops`` resolves attributes lazily and hands back a callable stub for
    operators that do not exist in this build, so ``hasattr`` and ``getattr``
    both lie. Asking for the RNA type is what actually proves registration: a
    Blender shipped without USD, Collada, or Alembic raises KeyError here, and
    the format is then reported as unsupported up front instead of failing
    halfway through an export.
    """
    group_name, _, op_name = name.partition(".")
    group = getattr(bpy.ops, group_name, None)
    if group is None:
        return None
    op = getattr(group, op_name, None)
    if op is None:
        return None
    try:
        op.get_rna_type()
    except (KeyError, RuntimeError, AttributeError):
        return None
    return op


def first_op(candidates, kind, ext):
    for name in candidates:
        op = resolve_op(name)
        if op is not None:
            return op
    raise JobError(
        f"This Blender build has no {kind} for '{ext}'. Enable the matching add-on or use another format.",
        code="format_unsupported",
    )


def call_op(op, **kwargs):
    """Call an operator with only the keywords its RNA actually declares.

    Blender renames exporter properties between releases (``export_apply`` on
    the glTF exporter, ``use_mesh_modifiers`` on FBX, ``apply_modifiers`` on
    OBJ). Filtering here lets one caller pass the superset and stay correct on
    every version instead of guessing per release.
    """
    accepted = {prop.identifier for prop in op.get_rna_type().properties}
    return op(**{key: value for key, value in kwargs.items() if key in accepted})


def reset_scene():
    """Start from a genuinely empty scene (no default cube, camera, or light)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)


def load_input(path):
    """Open a .blend, or import any other supported file into an empty scene."""
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        raise JobError(f"Input file not found: {path}", code="input_not_found")
    ext = os.path.splitext(path)[1].lower()
    if ext == ".blend":
        bpy.ops.wm.open_mainfile(filepath=path)
        return path
    reset_scene()
    candidates = IMPORTERS.get(ext)
    if not candidates:
        raise JobError(
            f"Unsupported input format '{ext}'. Supported: {', '.join(sorted(IMPORTERS))}, .blend",
            code="format_unsupported",
        )
    op = first_op(candidates, "importer", ext)
    call_op(op, filepath=path)
    return path


def mesh_objects():
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def triangle_count(obj, depsgraph):
    """Evaluated triangle count, so modifiers and subdivision are included."""
    evaluated = obj.evaluated_get(depsgraph)
    try:
        mesh = evaluated.to_mesh()
    except RuntimeError:
        return 0, 0
    if mesh is None:
        return 0, 0
    try:
        mesh.calc_loop_triangles()
        return len(mesh.loop_triangles), len(mesh.vertices)
    finally:
        evaluated.to_mesh_clear()


def world_bounds(objects):
    """Axis-aligned world-space bounds of ``objects`` as (min, max, center, radius)."""
    corners = []
    for obj in objects:
        for corner in obj.bound_box:
            corners.append(obj.matrix_world @ Vector(corner))
    if not corners:
        return None
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    center = (lo + hi) / 2.0
    radius = max((corner - center).length for corner in corners)
    return lo, hi, center, radius


def scene_summary(include_objects=True):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    objects = []
    total_tris = 0
    total_verts = 0
    for obj in bpy.context.scene.objects:
        entry = {
            "name": obj.name,
            "type": obj.type,
            "parent": obj.parent.name if obj.parent else None,
            "location": [round(v, 6) for v in obj.location],
            "dimensions": [round(v, 6) for v in obj.dimensions],
            "modifiers": [m.type for m in obj.modifiers],
            "materials": [slot.material.name for slot in obj.material_slots if slot.material],
        }
        if obj.type == "MESH":
            tris, verts = triangle_count(obj, depsgraph)
            entry["triangles"] = tris
            entry["vertices"] = verts
            entry["uv_layers"] = [uv.name for uv in obj.data.uv_layers]
            entry["shape_keys"] = len(obj.data.shape_keys.key_blocks) if obj.data.shape_keys else 0
            total_tris += tris
            total_verts += verts
        if obj.type == "ARMATURE":
            entry["bones"] = [bone.name for bone in obj.data.bones]
        objects.append(entry)

    bounds = world_bounds([obj for obj in bpy.context.scene.objects if obj.type in {"MESH", "CURVE", "SURFACE"}])
    animations = []
    for action in bpy.data.actions:
        start, end = action.frame_range
        animations.append(
            {
                "name": action.name,
                "frame_start": round(start, 3),
                "frame_end": round(end, 3),
                "channels": len(action.fcurves),
            }
        )

    summary = {
        "scene": bpy.context.scene.name,
        "unit_system": bpy.context.scene.unit_settings.system,
        "frame_start": bpy.context.scene.frame_start,
        "frame_end": bpy.context.scene.frame_end,
        "counts": {
            "objects": len(bpy.context.scene.objects),
            "meshes": len(mesh_objects()),
            "armatures": len([o for o in bpy.context.scene.objects if o.type == "ARMATURE"]),
            "cameras": len([o for o in bpy.context.scene.objects if o.type == "CAMERA"]),
            "lights": len([o for o in bpy.context.scene.objects if o.type == "LIGHT"]),
            "materials": len(bpy.data.materials),
            "images": len(bpy.data.images),
            "actions": len(bpy.data.actions),
            "triangles": total_tris,
            "vertices": total_verts,
        },
        "materials": [mat.name for mat in bpy.data.materials],
        "animations": animations,
    }
    if bounds:
        lo, hi, center, radius = bounds
        summary["bounds"] = {
            "min": [round(v, 6) for v in lo],
            "max": [round(v, 6) for v in hi],
            "center": [round(v, 6) for v in center],
            "size": [round(hi[i] - lo[i], 6) for i in range(3)],
            "radius": round(radius, 6),
        }
    if include_objects:
        summary["objects"] = objects
    return summary


def op_scene_info(job):
    path = load_input(job["input"])
    summary = scene_summary(include_objects=job.get("include_objects", True))
    summary["input"] = path
    summary["input_bytes"] = os.path.getsize(path)
    return summary


def apply_scale(factor):
    if not factor or abs(factor - 1.0) < 1e-9:
        return
    for obj in bpy.context.scene.objects:
        if obj.parent is None:
            obj.scale = obj.scale * factor


def export_to(path, *, apply_modifiers=True):
    path = os.path.abspath(path)
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".blend":
        bpy.ops.wm.save_as_mainfile(filepath=path, copy=True)
        return path
    candidates = EXPORTERS.get(ext)
    if not candidates:
        raise JobError(
            f"Unsupported output format '{ext}'. Supported: {', '.join(sorted(EXPORTERS))}, .blend",
            code="format_unsupported",
        )
    op = first_op(candidates, "exporter", ext)
    call_op(
        op,
        filepath=path,
        export_format="GLB" if ext == ".glb" else "GLTF_SEPARATE",
        # Modifier application under the three names Blender's exporters use.
        export_apply=apply_modifiers,
        use_mesh_modifiers=apply_modifiers,
        apply_modifiers=apply_modifiers,
        check_existing=False,
    )
    if not os.path.isfile(path):
        raise JobError(f"The exporter reported success but wrote no file at {path}", code="export_failed")
    return path


def op_convert(job):
    load_input(job["input"])
    apply_scale(job.get("scale"))
    bpy.context.view_layer.update()
    output = export_to(job["output"], apply_modifiers=job.get("apply_modifiers", True))
    summary = scene_summary(include_objects=False)
    return {
        "input": os.path.abspath(job["input"]),
        "output": output,
        "output_bytes": os.path.getsize(output),
        "counts": summary["counts"],
        "bounds": summary.get("bounds"),
    }


# Engines worth probing for, best first. The static RNA enum is not a reliable
# list: on some distro builds Cycles is assignable while absent from the enum,
# so capability is decided by whether the assignment actually takes.
CANDIDATE_ENGINES = ("CYCLES", "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH")


def available_engines():
    scene = bpy.context.scene
    if scene is None:
        return []
    declared = [item.identifier for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    original = scene.render.engine
    found = []
    for name in list(CANDIDATE_ENGINES) + [e for e in declared if e not in CANDIDATE_ENGINES]:
        if name in found:
            continue
        try:
            scene.render.engine = name
        except (TypeError, ValueError):
            continue
        found.append(name)
    scene.render.engine = original
    return found


def enable_cycles():
    """Cycles ships as a bundled add-on, and --factory-startup leaves it off.

    Without this a headless container reports EEVEE as the only engine, and
    EEVEE needs a real GPU context that most containers do not have.
    """
    if "CYCLES" in available_engines():
        return True
    try:
        bpy.ops.preferences.addon_enable(module="cycles")
    except Exception:
        return False
    return "CYCLES" in available_engines()


def resolve_engine(requested):
    enable_cycles()
    engines = available_engines()
    if requested and requested != "auto":
        if requested in engines:
            return requested
        # EEVEE was renamed BLENDER_EEVEE_NEXT in Blender 4.2.
        alias = "BLENDER_EEVEE_NEXT" if requested == "BLENDER_EEVEE" else "BLENDER_EEVEE"
        if alias in engines:
            return alias
        raise JobError(
            f"Render engine '{requested}' is not available. This build offers: {', '.join(engines)}",
            code="engine_unavailable",
        )
    # CYCLES is the default because it renders on CPU. EEVEE needs a real GPU
    # context, which a headless container usually does not have.
    return "CYCLES" if "CYCLES" in engines else engines[0]


def ensure_camera(scene, target_objects):
    if scene.camera is not None:
        return scene.camera, False
    bounds = world_bounds(target_objects)
    camera_data = bpy.data.cameras.new("three_ws_camera")
    camera = bpy.data.objects.new("three_ws_camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    if bounds is None:
        camera.location = Vector((4.0, -4.0, 3.0))
        center = Vector((0.0, 0.0, 0.0))
    else:
        _lo, _hi, center, radius = bounds
        radius = max(radius, 1e-4)
        direction = Vector((1.0, -1.35, 0.75)).normalized()
        distance = (radius / math.sin(camera_data.angle / 2.0)) * 1.05
        camera.location = center + direction * distance
        camera_data.clip_start = max(distance / 1000.0, 1e-4)
        camera_data.clip_end = distance * 10.0
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    return camera, True


def ensure_lighting(scene):
    """Add a key light and a lit world only when the scene has neither."""
    added = []
    if not any(obj.type == "LIGHT" for obj in scene.objects):
        sun_data = bpy.data.lights.new("three_ws_key", type="SUN")
        sun_data.energy = 4.0
        sun = bpy.data.objects.new("three_ws_key", sun_data)
        scene.collection.objects.link(sun)
        sun.location = Vector((4.0, -6.0, 8.0))
        sun.rotation_euler = (Vector((0.0, 0.0, 0.0)) - sun.location).to_track_quat("-Z", "Y").to_euler()
        added.append("sun")
    if scene.world is None:
        scene.world = bpy.data.worlds.new("three_ws_world")
        added.append("world")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    if background is not None and not added:
        return added
    if background is not None:
        background.inputs[0].default_value = (0.05, 0.05, 0.06, 1.0)
        background.inputs[1].default_value = 1.0
    return added


def render_still(scene):
    """Render one frame, falling back to a denoiser-free pass if needed.

    Blender builds without OpenImageDenoise (several Linux distro packages) fail
    the whole render rather than the denoise step, so a preview that would
    otherwise be fine dies on a post-process nobody asked for. Retry once
    without it and report which pass produced the image.
    """
    try:
        bpy.ops.render.render(write_still=True)
        return bool(getattr(scene, "cycles", None) and scene.cycles.use_denoising)
    except RuntimeError as exc:
        if "denois" not in str(exc).lower() or not hasattr(scene, "cycles"):
            raise
        scene.cycles.use_denoising = False
        bpy.ops.render.render(write_still=True)
        return False


def op_render(job):
    load_input(job["input"])
    scene = bpy.context.scene
    engine = resolve_engine(job.get("engine", "auto"))
    scene.render.engine = engine

    samples = int(job.get("samples", 32))
    if engine == "CYCLES":
        scene.cycles.samples = samples
        scene.cycles.use_denoising = True
        scene.cycles.device = "CPU"
    elif hasattr(scene, "eevee"):
        scene.eevee.taa_render_samples = samples

    width, height = job.get("resolution", [960, 960])
    scene.render.resolution_x = int(width)
    scene.render.resolution_y = int(height)
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA" if job.get("transparent", False) else "RGB"
    scene.render.film_transparent = bool(job.get("transparent", False))

    camera, camera_added = ensure_camera(scene, mesh_objects())
    lights_added = ensure_lighting(scene)

    output = os.path.abspath(job["output"])
    parent = os.path.dirname(output)
    if parent:
        os.makedirs(parent, exist_ok=True)
    scene.render.filepath = output
    denoised = render_still(scene)
    if not os.path.isfile(output):
        raise JobError(f"Blender rendered but wrote no image at {output}", code="render_failed")
    return {
        "input": os.path.abspath(job["input"]),
        "output": output,
        "output_bytes": os.path.getsize(output),
        "engine": engine,
        "samples": samples,
        "resolution": [scene.render.resolution_x, scene.render.resolution_y],
        "camera": camera.name,
        "denoised": denoised,
        "camera_created": camera_added,
        "lights_created": lights_added,
    }


def op_exec(job):
    if job.get("input"):
        load_input(job["input"])
    else:
        reset_scene()
    captured = io.StringIO()
    namespace = {"bpy": bpy, "Vector": Vector, "math": math, "__name__": "three_ws_blender_mcp"}
    with contextlib.redirect_stdout(captured):
        exec(compile(job["code"], "<three-ws-blender-mcp>", "exec"), namespace)
    result = namespace.get("result")
    try:
        json.dumps(result)
    except TypeError:
        result = repr(result)
    payload = {"stdout": captured.getvalue(), "result": result, "counts": scene_summary(include_objects=False)["counts"]}
    if job.get("output"):
        payload["output"] = export_to(job["output"], apply_modifiers=job.get("apply_modifiers", True))
        payload["output_bytes"] = os.path.getsize(payload["output"])
    return payload


def op_probe(job):
    """Report what this Blender build can actually do. No scene is touched."""
    enable_cycles()
    return {
        "blender_version": bpy.app.version_string,
        "blender_version_tuple": list(bpy.app.version),
        "python_version": sys.version.split()[0],
        "binary": bpy.app.binary_path,
        "background": bpy.app.background,
        "render_engines": available_engines(),
        "import_formats": sorted(ext for ext, ops in IMPORTERS.items() if any(resolve_op(o) for o in ops)),
        "export_formats": sorted(ext for ext, ops in EXPORTERS.items() if any(resolve_op(o) for o in ops)),
    }


OPS = {
    "probe": op_probe,
    "scene_info": op_scene_info,
    "convert": op_convert,
    "render": op_render,
    "exec": op_exec,
}


def dispatch(job):
    op_name = job.get("op")
    handler = OPS.get(op_name)
    if handler is None:
        raise JobError(f"Unknown op '{op_name}'. Known ops: {', '.join(sorted(OPS))}", code="unknown_op")
    payload = handler(job)
    payload["ok"] = True
    payload.setdefault("blender_version", bpy.app.version_string)
    return payload


def main():
    argv = sys.argv
    if "--" not in argv:
        sys.stderr.write("runner.py expects: blender -b --python runner.py -- <job.json> <result.json>\n")
        raise SystemExit(2)
    args = argv[argv.index("--") + 1 :]
    if len(args) < 2:
        sys.stderr.write("runner.py expects a job path and a result path\n")
        raise SystemExit(2)
    job_path, result_path = args[0], args[1]
    with open(job_path, "r", encoding="utf-8") as handle:
        job = json.load(handle)
    try:
        payload = dispatch(job)
    except JobError as exc:
        payload = {"ok": False, "error": exc.code, "message": str(exc)}
    except Exception as exc:  # noqa: BLE001 - every failure must reach the caller as JSON
        payload = {
            "ok": False,
            "error": "blender_error",
            "message": f"{type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc(limit=8),
        }
    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)


main()
