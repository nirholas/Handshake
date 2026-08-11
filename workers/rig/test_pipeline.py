"""
Core-path smoke test: the composition main.py._rig_sync actually performs.

test_rig_glb.py and test_blendshapes.py each exercise one stage in isolation
with a fabricated 3-bone spine. This test runs the two stages together the way
the service does, over the real 52-bone Mixamo skeleton and the real ARKit-52
name set, and asserts the contract the rest of the platform depends on:

  - the emitted bone names are exactly MIA's 52 Mixamo joints, in order, so
    src/glb-canonicalize.js retargets the whole clip library onto the result
    (tests/glb-canonicalize.test.js pins the same list from the JS side; the
    two must not drift)
  - the joint hierarchy is reproduced as glTF node children under one root
  - every drawn primitive carries JOINTS_0/WEIGHTS_0 summing to 1
  - the head primitive carries 52 ARKit morph targets and the body carries
    none, which is what makes lipsync and emotions work without bloating the
    body geometry
  - the original material texture survives byte-for-byte, the property the
    whole graft-instead-of-reexport design exists to protect
  - validate_input_mesh accepts real meshes and rejects the two input classes
    that used to crash the predictor in production

No GPU, no torch, no GCP: `python3 test_pipeline.py`.
"""

import io
import sys

import numpy as np
import pygltflib
import trimesh

from blendshapes import head_mask_from_weights, transfer_blendshapes
from rig_glb import (
    ARKIT_52_BLENDSHAPES,
    InvalidMeshError,
    build_rigged_glb,
    validate_input_mesh,
)

# MIA's MIXAMO_JOINTS (util/dataset_mixamo.py at the commit the Dockerfile
# pins), as {bone: parent}. Order matters: it is the column order of the
# predicted weight matrix. Hips is the root; HeadTop_End and the eye bones are
# deliberately absent upstream.
_FINGERS = ("Thumb", "Index", "Middle", "Ring", "Pinky")


def _mixamo_hierarchy():
    tree = [
        ("Hips", None),
        ("Spine", "Hips"),
        ("Spine1", "Spine"),
        ("Spine2", "Spine1"),
        ("Neck", "Spine2"),
        ("Head", "Neck"),
    ]
    for side in ("Left", "Right"):
        tree += [
            (f"{side}Shoulder", "Spine2"),
            (f"{side}Arm", f"{side}Shoulder"),
            (f"{side}ForeArm", f"{side}Arm"),
            (f"{side}Hand", f"{side}ForeArm"),
        ]
        for finger in _FINGERS:
            for seg in (1, 2, 3):
                parent = f"{side}Hand{finger}{seg - 1}" if seg > 1 else f"{side}Hand"
                tree.append((f"{side}Hand{finger}{seg}", parent))
    for side in ("Left", "Right"):
        tree += [
            (f"{side}UpLeg", "Hips"),
            (f"{side}Leg", f"{side}UpLeg"),
            (f"{side}Foot", f"{side}Leg"),
            (f"{side}ToeBase", f"{side}Foot"),
        ]
    names = [f"mixamorig:{n}" for n, _ in tree]
    index = {n: i for i, n in enumerate(names)}
    parents = np.array(
        [-1 if p is None else index[f"mixamorig:{p}"] for _, p in tree],
        dtype=np.int64,
    )
    return names, parents


MIXAMO_JOINT_NAMES, MIXAMO_PARENTS = _mixamo_hierarchy()
HEAD_JOINT = MIXAMO_JOINT_NAMES.index("mixamorig:Head")


def _check(cond, msg):
    if not cond:
        print(f"  FAIL {msg}")
        raise AssertionError(msg)
    print(f"  ok   {msg}")


def _textured_avatar_glb():
    """A head sphere over a body box, the head carrying a real PBR texture.

    Two geometries so the blendshape localization has a body primitive to skip,
    and a texture so material preservation is observable in the output bytes.
    """
    head = trimesh.creation.icosphere(subdivisions=2, radius=0.16)
    head.apply_translation((0.0, 1.62, 0.0))
    pixels = np.zeros((8, 8, 3), dtype=np.uint8)
    pixels[::2, ::2] = (210, 170, 140)
    pixels[1::2, 1::2] = (120, 90, 70)
    try:
        from PIL import Image  # noqa: PLC0415  (optional; skipped when absent)

        head.visual = trimesh.visual.TextureVisuals(
            uv=np.random.default_rng(7).random((len(head.vertices), 2)),
            image=Image.fromarray(pixels),
        )
    except ImportError:
        pass

    body = trimesh.creation.box(extents=(0.45, 1.45, 0.25))
    body.apply_translation((0.0, 0.73, 0.0))

    scene = trimesh.Scene()
    scene.add_geometry(head, node_name="head", geom_name="head")
    scene.add_geometry(body, node_name="body", geom_name="body")
    glb_bytes = scene.export(file_type="glb")
    merged = trimesh.load(io.BytesIO(glb_bytes), file_type="glb", force="mesh")
    return glb_bytes, merged


def _skeleton_for(mesh):
    """Place the 52 joints inside the mesh bounds and weight verts to the
    nearest one, the shape (not the accuracy) of a real prediction."""
    lo, hi = mesh.bounds
    height = float(hi[1] - lo[1])
    joints = np.zeros((len(MIXAMO_JOINT_NAMES), 3), dtype=np.float32)
    # Spread the chain vertically by depth so no two joints coincide, and pin
    # the head bone into the actual head sphere so the head mask is meaningful.
    depth = np.zeros(len(MIXAMO_JOINT_NAMES), dtype=np.int64)
    for i, p in enumerate(MIXAMO_PARENTS):
        depth[i] = 0 if p < 0 else depth[p] + 1
    for i, name in enumerate(MIXAMO_JOINT_NAMES):
        joints[i, 1] = lo[1] + height * (0.45 + 0.02 * depth[i])
        side = -0.06 if "Left" in name else (0.06 if "Right" in name else 0.0)
        joints[i, 0] = side
    joints[HEAD_JOINT] = (0.0, float(hi[1]) - 0.16, 0.0)

    verts = np.asarray(mesh.vertices, dtype=np.float32)
    d = np.linalg.norm(verts[:, None, :] - joints[None, :, :], axis=2)
    weights = np.zeros_like(d, dtype=np.float32)
    weights[np.arange(len(verts)), np.argmin(d, axis=1)] = 1.0
    return joints, weights


def _arkit_template(head_height):
    """A template head shaped like the target's, with a nonzero delta on every
    ARKit shape, so transfer output is checkable per shape."""
    rng = np.random.default_rng(11)
    pts = rng.normal(size=(400, 3)).astype(np.float32)
    pts /= np.linalg.norm(pts, axis=1, keepdims=True)
    verts = (pts * (head_height / 2.0)).astype(np.float32)
    deltas = np.zeros((52, verts.shape[0], 3), dtype=np.float32)
    for k in range(52):
        deltas[k, :, 1] = 0.01 * (k + 1)
    return {"names": list(ARKIT_52_BLENDSHAPES), "verts": verts, "deltas": deltas}


def _decode_u(glb, blob, acc_idx):
    acc = glb.accessors[acc_idx]
    dt = {5121: "<u1", 5123: "<u2", 5126: "<f4"}[acc.componentType]
    bv = glb.bufferViews[acc.bufferView]
    base = (bv.byteOffset or 0) + (acc.byteOffset or 0)
    width = np.dtype(dt).itemsize * 4
    raw = bytes(blob[base:base + width * acc.count])
    return np.frombuffer(raw, dtype=dt).reshape(acc.count, 4)


def _rig(glb_bytes, mesh):
    """Exactly what main.py._rig_sync composes, minus the GPU predictor."""
    validate_input_mesh(glb_bytes)
    joints, weights = _skeleton_for(mesh)
    verts = np.asarray(mesh.vertices, dtype=np.float32)

    mask = head_mask_from_weights(weights, MIXAMO_JOINT_NAMES)
    head_pts = verts[mask]
    template = _arkit_template(float(head_pts[:, 1].max() - head_pts[:, 1].min()))
    blend = transfer_blendshapes(template, verts, mask)

    return build_rigged_glb(
        glb_bytes, mesh, joints, MIXAMO_PARENTS, weights,
        blendshape_data=blend, joint_names=MIXAMO_JOINT_NAMES,
    ), mask


def test_mixamo_contract():
    print("test_mixamo_contract")
    glb_bytes, mesh = _textured_avatar_glb()
    out, _ = _rig(glb_bytes, mesh)
    glb = pygltflib.GLTF2.load_from_bytes(out)

    _check(len(glb.skins) == 1, "exactly one skin")
    skin = glb.skins[0]
    names = [glb.nodes[j].name for j in skin.joints]
    _check(len(names) == 52, f"52 joints emitted (got {len(names)})")
    _check(names == MIXAMO_JOINT_NAMES, "bone names are MIA's Mixamo set, in order")
    _check(all(n.startswith("mixamorig:") for n in names),
           "every bone carries the mixamorig: prefix the canonicalizer keys on")
    finger_bones = [n for n in names
                    if "Hand" in n and n not in ("mixamorig:LeftHand", "mixamorig:RightHand")]
    _check(len(finger_bones) == 30, "30 finger bones present (fingers are rigged)")

    # Hierarchy: every non-root joint must appear as a child of its parent node.
    orphans = [names[i] for i, p in enumerate(MIXAMO_PARENTS)
               if p >= 0 and skin.joints[i] not in (glb.nodes[skin.joints[int(p)]].children or [])]
    _check(not orphans, f"every joint is parented under its Mixamo parent ({orphans[:3]})")

    roots = [i for i, p in enumerate(MIXAMO_PARENTS) if p < 0]
    _check(len(roots) == 1 and names[roots[0]] == "mixamorig:Hips", "single root: Hips")
    scene = glb.scenes[glb.scene or 0]
    _check(skin.joints[roots[0]] in scene.nodes, "the root joint is in the scene")


def test_skin_and_blendshape_placement():
    print("test_skin_and_blendshape_placement")
    glb_bytes, mesh = _textured_avatar_glb()
    out, mask = _rig(glb_bytes, mesh)
    glb = pygltflib.GLTF2.load_from_bytes(out)
    blob = bytearray(glb.binary_blob())

    prims = [(mi, p) for mi, m in enumerate(glb.meshes) for p in m.primitives
             if getattr(p.attributes, "POSITION", None) is not None]
    _check(len(prims) >= 2, f"the avatar has head and body primitives ({len(prims)})")

    for _, prim in prims:
        _check(prim.attributes.JOINTS_0 is not None
               and prim.attributes.WEIGHTS_0 is not None,
               "primitive carries JOINTS_0 and WEIGHTS_0")
        w = _decode_u(glb, blob, prim.attributes.WEIGHTS_0).astype(np.float64)
        _check(np.allclose(w.sum(axis=1), 1.0, atol=1e-5),
               "every vertex weight set sums to 1 (no skinning collapse)")
        j = _decode_u(glb, blob, prim.attributes.JOINTS_0)
        _check(int(j.max()) < 52, "joint indices stay inside the skeleton")

    with_targets = [mi for mi, prim in prims if prim.targets]
    without = [mi for mi, prim in prims if not prim.targets]
    _check(len(with_targets) == 1, "exactly one primitive carries morph targets")
    _check(len(without) >= 1, "the body primitive carries none (no zero-target bloat)")

    head_mesh = glb.meshes[with_targets[0]]
    target_count = len(head_mesh.primitives[0].targets)
    _check(target_count == 52, f"52 ARKit morph targets on the head ({target_count})")
    _check(head_mesh.extras and head_mesh.extras.get("targetNames") == ARKIT_52_BLENDSHAPES,
           "targetNames are the ARKit-52 names lipsync and emotions look up")
    _check(head_mesh.weights == [0.0] * 52, "morph weights start neutral")
    _check(int(mask.sum()) > 0, "the head mask actually selected head vertices")


def test_materials_survive():
    print("test_materials_survive")
    glb_bytes, mesh = _textured_avatar_glb()
    src = pygltflib.GLTF2.load_from_bytes(glb_bytes)
    if not src.images:
        print("  skip texture check (Pillow absent; no image in the source GLB)")
    out, _ = _rig(glb_bytes, mesh)
    glb = pygltflib.GLTF2.load_from_bytes(out)

    _check(len(glb.materials) == len(src.materials),
           f"material count unchanged ({len(glb.materials)})")
    _check(len(glb.images) == len(src.images), "image count unchanged")

    if src.images:
        src_blob = bytearray(src.binary_blob())
        out_blob = bytearray(glb.binary_blob())

        def _image_bytes(g, blob, img):
            bv = g.bufferViews[img.bufferView]
            off = bv.byteOffset or 0
            return bytes(blob[off:off + bv.byteLength])

        before = _image_bytes(src, src_blob, src.images[0])
        after = _image_bytes(glb, out_blob, glb.images[0])
        _check(before == after and len(before) > 0,
               f"the PBR texture survived byte-for-byte ({len(before)} bytes)")

    verts_before = sum(a.count for a in src.accessors
                       if a.type == "VEC3" and a.componentType == 5126)
    _check(verts_before > 0, "source had float VEC3 geometry to preserve")


def test_output_is_a_loadable_glb():
    print("test_output_is_a_loadable_glb")
    glb_bytes, mesh = _textured_avatar_glb()
    out, _ = _rig(glb_bytes, mesh)

    validate_input_mesh(bytes(out))
    _check(True, "the rigged GLB passes the worker's own input validation")
    reloaded = trimesh.load(io.BytesIO(bytes(out)), file_type="glb", force="mesh")
    _check(len(reloaded.faces) == len(mesh.faces),
           f"geometry round-trips with the same face count ({len(reloaded.faces)})")


def test_bad_input_is_named_not_swallowed():
    print("test_bad_input_is_named_not_swallowed")
    # The 2026-08-05 production failure: a non-GLB body under a .glb URL.
    try:
        validate_input_mesh(b"<!doctype html><title>404 Not Found</title>")
        _check(False, "expected InvalidMeshError for a non-GLB body")
    except InvalidMeshError as exc:
        _check("not a binary glTF" in str(exc), f"non-GLB named clearly: {exc}")

    try:
        validate_input_mesh(b"glTF")
        _check(False, "expected InvalidMeshError for a truncated header")
    except InvalidMeshError as exc:
        _check("not a binary glTF" in str(exc), "truncated header rejected")

    # The 2026-07-31 production failure: a GLB with no triangles to sample.
    cloud = trimesh.PointCloud(np.random.default_rng(3).random((64, 3)))
    cloud_glb = trimesh.Scene(cloud).export(file_type="glb")
    try:
        validate_input_mesh(cloud_glb)
        _check(False, "expected InvalidMeshError for a triangle-free GLB")
    except InvalidMeshError as exc:
        _check("no triangles" in str(exc), f"point cloud named clearly: {exc}")

    glb_bytes, _ = _textured_avatar_glb()
    validate_input_mesh(glb_bytes)
    _check(True, "a real avatar GLB passes validation")


if __name__ == "__main__":
    try:
        test_mixamo_contract()
        test_skin_and_blendshape_placement()
        test_materials_survive()
        test_output_is_a_loadable_glb()
        test_bad_input_is_named_not_swallowed()
    except AssertionError:
        print("\nFAILED")
        sys.exit(1)
    print("\nALL PASSED")
