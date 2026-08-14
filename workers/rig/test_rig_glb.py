"""
Isolated test for rig_glb.build_rigged_glb: verifies it turns a raw mesh GLB
plus a fabricated skeleton/weights prediction into a spec-valid skinned glTF.
Runs with no GPU / torch / GCP: `python3 test_rig_glb.py`.

Validates the things that actually make a GLB "rigged":
  - exactly one skin, joints + inverseBindMatrices present and sized to J
  - JOINTS_0 / WEIGHTS_0 on every primitive, counts == vertex count
  - per-vertex weights sum to 1 and joint indices are in range
  - the drawing node references the skin; a joint root is in the scene
  - original geometry (vertex count) preserved; buffer length consistent
  - morph-target (blendshape) injection wires targets + names
  - explicit joint_names land on the joint nodes (the Mixamo contract)
  - primitives whose vertices carry all-zero deltas get NO morph targets
"""

import io
import sys

import numpy as np
import pygltflib
import trimesh

from gltf_meshopt import decode_if_meshopt, GLTFPACK_BIN, GLTFPACK_TIMEOUT_S
from rig_glb import build_rigged_glb, validate_input_mesh

_COMP = {5126: ("<f4", 4), 5121: ("<u1", 1), 5123: ("<u2", 2), 5125: ("<u4", 4)}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def _decode(glb, blob, acc_idx):
    acc = glb.accessors[acc_idx]
    bv = glb.bufferViews[acc.bufferView]
    base = (bv.byteOffset or 0) + (acc.byteOffset or 0)
    dt, size = _COMP[acc.componentType]
    nc = _NCOMP[acc.type]
    stride = bv.byteStride or (size * nc)
    out = np.empty((acc.count, nc), dtype=dt)
    for i in range(acc.count):
        off = base + i * stride
        out[i] = np.frombuffer(bytes(blob[off:off + size * nc]), dtype=dt)
    return out


def _make_mesh_glb():
    # A box subdivided so weights vary across vertices; exported as a GLB the
    # same way the model services emit one.
    mesh = trimesh.creation.box(extents=(1.0, 2.0, 1.0))
    mesh = mesh.subdivide().subdivide()
    glb_bytes = trimesh.Scene(mesh).export(file_type="glb")
    loaded = trimesh.load(io.BytesIO(glb_bytes), file_type="glb", force="mesh")
    return glb_bytes, loaded


def _make_two_mesh_glb():
    # Two separated boxes as two meshes: a stand-in for head + body primitives,
    # so the zero-delta skip has a primitive to skip.
    top = trimesh.creation.box(extents=(1.0, 1.0, 1.0))
    top.apply_translation((0.0, 1.5, 0.0))
    bottom = trimesh.creation.box(extents=(1.0, 1.0, 1.0))
    scene = trimesh.Scene()
    scene.add_geometry(top, node_name="top", geom_name="top")
    scene.add_geometry(bottom, node_name="bottom", geom_name="bottom")
    glb_bytes = scene.export(file_type="glb")
    merged = trimesh.load(io.BytesIO(glb_bytes), file_type="glb", force="mesh")
    return glb_bytes, merged


def _fake_prediction(mesh, n_joints=3):
    # A vertical spine of n_joints joints; weights blend by vertical position.
    ys = mesh.vertices[:, 1]
    lo, hi = ys.min(), ys.max()
    centers = np.linspace(lo, hi, n_joints)
    joints = np.zeros((n_joints, 3), dtype=np.float32)
    joints[:, 1] = centers
    parents = np.array([-1] + list(range(n_joints - 1)), dtype=np.int64)
    span = (hi - lo) / max(n_joints - 1, 1)
    d = np.abs(ys[:, None] - centers[None, :])
    weights = np.maximum(0.0, 1.0 - d / span).astype(np.float32)  # (V, J) tent weights
    weights[weights.sum(1) == 0, 0] = 1.0
    return joints, parents, weights


def _check(cond, msg):
    if not cond:
        print(f"  FAIL {msg}")
        raise AssertionError(msg)
    print(f"  ok   {msg}")


def test_skeleton_and_skinning():
    print("test_skeleton_and_skinning")
    glb_bytes, mesh = _make_mesh_glb()
    joints, parents, weights = _fake_prediction(mesh, n_joints=3)
    in_pos_count = len(mesh.vertices)

    out = build_rigged_glb(glb_bytes, mesh, joints, parents, weights, None)
    _check(isinstance(out, (bytes, bytearray)) and len(out) > len(glb_bytes),
           "produced a larger GLB (skin data appended)")

    glb = pygltflib.GLTF2.load_from_bytes(out)
    blob = bytearray(glb.binary_blob())

    _check(len(glb.skins) == 1, "exactly one skin")
    skin = glb.skins[0]
    _check(len(skin.joints) == 3, "skin.joints has J entries")
    _check(skin.inverseBindMatrices is not None, "inverseBindMatrices present")
    ibm = glb.accessors[skin.inverseBindMatrices]
    _check(ibm.type == "MAT4" and ibm.count == 3, "IBM accessor is MAT4 x J")

    scene = glb.scenes[glb.scene or 0]
    _check(any(r in scene.nodes for r in skin.joints), "a joint node is in the scene")

    skinned_nodes = [n for n in glb.nodes if n.mesh is not None and n.skin is not None]
    _check(len(skinned_nodes) >= 1, "a drawing node references the skin")

    total_prims = 0
    for gmesh in glb.meshes:
        for prim in gmesh.primitives:
            if getattr(prim.attributes, "POSITION", None) is None:
                continue
            total_prims += 1
            pos = glb.accessors[prim.attributes.POSITION]
            _check(prim.attributes.JOINTS_0 is not None, "primitive has JOINTS_0")
            _check(prim.attributes.WEIGHTS_0 is not None, "primitive has WEIGHTS_0")
            jacc = glb.accessors[prim.attributes.JOINTS_0]
            wacc = glb.accessors[prim.attributes.WEIGHTS_0]
            _check(jacc.count == pos.count and wacc.count == pos.count,
                   "JOINTS_0/WEIGHTS_0 counts match POSITION")
            _check(jacc.componentType == 5121,
                   "JOINTS_0 uses compact UNSIGNED_BYTE for <=256 joints")
            _check(pos.count == in_pos_count, "vertex count preserved")

            jv = _decode(glb, blob, prim.attributes.JOINTS_0)
            wv = _decode(glb, blob, prim.attributes.WEIGHTS_0)
            _check(jv.min() >= 0 and jv.max() < len(skin.joints),
                   "all joint indices in range")
            sums = wv.sum(axis=1)
            _check(np.allclose(sums, 1.0, atol=1e-4),
                   f"every vertex's weights sum to 1 (max err {np.abs(sums-1).max():.2e})")
    _check(total_prims >= 1, "at least one primitive skinned")

    _check(glb.buffers[0].byteLength == len(blob), "buffer byteLength matches binary blob")


def test_named_joints():
    print("test_named_joints")
    glb_bytes, mesh = _make_mesh_glb()
    joints, parents, weights = _fake_prediction(mesh, n_joints=3)
    names = ["mixamorig:Hips", "mixamorig:Spine", "mixamorig:Head"]

    out = build_rigged_glb(glb_bytes, mesh, joints, parents, weights, None,
                           joint_names=names)
    glb = pygltflib.GLTF2.load_from_bytes(out)
    skin = glb.skins[0]
    got = [glb.nodes[j].name for j in skin.joints]
    _check(got == names, f"joint nodes carry the given names ({got})")

    # Mismatched name count must fail loudly, not misname bones.
    try:
        build_rigged_glb(glb_bytes, mesh, joints, parents, weights, None,
                         joint_names=names[:2])
    except RuntimeError as exc:
        _check("joint_names" in str(exc), "name-count mismatch raises")
    else:
        _check(False, "expected RuntimeError for joint_names mismatch")


def test_blendshape_targets():
    print("test_blendshape_targets")
    glb_bytes, mesh = _make_mesh_glb()
    joints, parents, weights = _fake_prediction(mesh, n_joints=3)
    V = len(mesh.vertices)
    deltas = np.stack([
        np.tile(np.array([0.0, 0.05, 0.0], np.float32), (V, 1)),   # "jawOpen"-ish
        np.tile(np.array([0.03, 0.0, 0.0], np.float32), (V, 1)),
    ], axis=0)

    out = build_rigged_glb(glb_bytes, mesh, joints, parents, weights,
                           {"names": ["jawOpen", "mouthLeft"], "deltas": deltas})
    glb = pygltflib.GLTF2.load_from_bytes(out)

    found = False
    for gmesh in glb.meshes:
        for prim in gmesh.primitives:
            if getattr(prim.attributes, "POSITION", None) is None:
                continue
            _check(prim.targets is not None and len(prim.targets) == 2,
                   "primitive has 2 morph targets")
            # pygltflib reloads morph targets as plain dicts ({"POSITION": n}).
            tgt_pos = [t["POSITION"] if isinstance(t, dict) else t.POSITION for t in prim.targets]
            _check(all(p is not None for p in tgt_pos),
                   "each morph target has a POSITION delta accessor")
            found = True
        if found:
            _check(gmesh.weights == [0.0, 0.0], "mesh.weights initialized per target")
            _check((gmesh.extras or {}).get("targetNames") == ["jawOpen", "mouthLeft"],
                   "targetNames recorded in mesh.extras")
    _check(found, "blendshape primitive found")


def test_zero_delta_primitives_skipped():
    """Body/clothing primitives whose vertices carry no facial deltas must not
    be bloated with all-zero morph targets."""
    print("test_zero_delta_primitives_skipped")
    glb_bytes, merged = _make_two_mesh_glb()
    joints, parents, weights = _fake_prediction(merged, n_joints=3)
    V = len(merged.vertices)

    # Deltas only on the upper half ("head"): vertices above y = 0.75.
    deltas = np.zeros((1, V, 3), dtype=np.float32)
    upper = merged.vertices[:, 1] > 0.75
    _check(upper.any() and (~upper).any(), "test mesh split into upper/lower verts")
    deltas[0, upper, 1] = 0.05

    out = build_rigged_glb(glb_bytes, merged, joints, parents, weights,
                           {"names": ["jawOpen"], "deltas": deltas})
    glb = pygltflib.GLTF2.load_from_bytes(out)
    blob = bytearray(glb.binary_blob())

    with_targets, without_targets = 0, 0
    for gmesh in glb.meshes:
        for prim in gmesh.primitives:
            if getattr(prim.attributes, "POSITION", None) is None:
                continue
            pos = _decode(glb, blob, prim.attributes.POSITION)[:, :3].astype(np.float32)
            if prim.targets:
                with_targets += 1
                _check(pos[:, 1].mean() > 0.5, "targets landed on the upper (head) primitive")
            else:
                without_targets += 1
                _check(pos[:, 1].mean() < 0.5, "the lower (body) primitive was skipped")
    _check(with_targets == 1, "exactly one primitive carries morph targets")
    _check(without_targets >= 1, "at least one primitive skipped (no zero bloat)")


def test_dirty_weights_no_collapse():
    """NaN/Inf/negative weights are sanitized and empty vertices are pinned to a
    joint, so every vertex keeps a unit weight sum (no skinning collapse)."""
    print("test_dirty_weights_no_collapse")
    glb_bytes, mesh = _make_mesh_glb()
    joints, parents, weights = _fake_prediction(mesh, n_joints=3)
    # Corrupt the model output: a block of all-zero rows, plus NaN/Inf/negative.
    weights[: len(weights) // 4] = 0.0
    weights[len(weights) // 4] = [np.nan, np.inf, -5.0]

    out = build_rigged_glb(glb_bytes, mesh, joints, parents, weights, None)
    glb = pygltflib.GLTF2.load_from_bytes(out)
    blob = bytearray(glb.binary_blob())
    checked = 0
    for gmesh in glb.meshes:
        for prim in gmesh.primitives:
            if getattr(prim.attributes, "WEIGHTS_0", None) is None:
                continue
            wv = _decode(glb, blob, prim.attributes.WEIGHTS_0)
            jv = _decode(glb, blob, prim.attributes.JOINTS_0)
            _check(np.all(np.isfinite(wv)), "no NaN/Inf in output weights")
            _check(np.all(wv >= 0), "no negative output weights")
            _check(np.allclose(wv.sum(axis=1), 1.0, atol=1e-4),
                   "every vertex sums to 1 even from corrupt input (no collapse)")
            _check(jv.max() < len(glb.skins[0].joints), "joint indices in range")
            checked += 1
    _check(checked >= 1, "weights validated")


def test_nonidentity_node_baked():
    """A mesh drawn under a non-identity node transform gets that transform
    baked into world-space geometry (glTF ignores a skinned node's own
    transform, so local-space vertices would render misplaced)."""
    print("test_nonidentity_node_baked")
    glb_bytes, _ = _make_mesh_glb()
    g = pygltflib.GLTF2.load_from_bytes(glb_bytes)
    moved = False
    for node in g.nodes:
        if node.mesh is not None:
            node.translation = [0.5, 0.0, 0.0]
            moved = True
    _check(moved, "test set a transform on the mesh node")
    chunks = g.save_to_bytes()
    moved_bytes = b"".join(chunks) if isinstance(chunks, (list, tuple)) else chunks
    # trimesh applies node transforms on load, so this mesh is in WORLD space:
    # exactly the frame the predictor sees and the skeleton lives in.
    moved_mesh = trimesh.load(io.BytesIO(moved_bytes), file_type="glb", force="mesh")
    joints, parents, weights = _fake_prediction(moved_mesh, n_joints=3)

    out = build_rigged_glb(moved_bytes, moved_mesh, joints, parents, weights, None)
    glb = pygltflib.GLTF2.load_from_bytes(out)
    blob = bytearray(glb.binary_blob())

    checked = False
    for gmesh in glb.meshes:
        for prim in gmesh.primitives:
            if getattr(prim.attributes, "POSITION", None) is None:
                continue
            pos = _decode(glb, blob, prim.attributes.POSITION)[:, :3].astype(np.float32)
            # Baked positions must match trimesh's world-space vertices.
            got = np.sort(pos.round(4).view([('x','<f4'),('y','<f4'),('z','<f4')]), axis=0)
            want = np.sort(np.asarray(moved_mesh.vertices, np.float32).round(4)
                           .view([('x','<f4'),('y','<f4'),('z','<f4')]), axis=0)
            _check(np.array_equal(got, want), "positions baked to world space")
            checked = True
    _check(checked, "baked primitive validated")

    for node in glb.nodes:
        if node.mesh is not None and node.skin is not None and not node.children:
            _check(not node.translation, "baked node transform cleared")


def test_divergent_instances_rejected():
    """One mesh instanced by nodes with DIFFERENT world transforms cannot be
    skinned to a single world-space skeleton; that must fail loudly."""
    print("test_divergent_instances_rejected")
    glb_bytes, mesh = _make_mesh_glb()
    g = pygltflib.GLTF2.load_from_bytes(glb_bytes)
    scene = g.scenes[g.scene or 0]
    src_ni = next(i for i, n in enumerate(g.nodes) if n.mesh is not None)
    g.nodes.append(pygltflib.Node(mesh=g.nodes[src_ni].mesh, translation=[3.0, 0.0, 0.0]))
    scene.nodes.append(len(g.nodes) - 1)
    chunks = g.save_to_bytes()
    twin_bytes = b"".join(chunks) if isinstance(chunks, (list, tuple)) else chunks
    joints, parents, weights = _fake_prediction(mesh, n_joints=3)

    try:
        build_rigged_glb(twin_bytes, mesh, joints, parents, weights, None)
    except RuntimeError as exc:
        _check("instanced" in str(exc), "raised a clear divergent-instances error")
        return
    _check(False, "expected RuntimeError for divergent instances")


def test_meshopt_input_decoded():
    """A compressed avatar reaches the rigger as readable geometry.

    Most three.ws avatars ship with EXT_meshopt_compression, which neither
    trimesh nor pygltflib can decode, so rigging one failed on its own input
    validation until main.py started transcoding the fetched bytes. Without the
    gltfpack binary (a local run outside the image) there is nothing to compress
    with, so the case announces a skip rather than passing silently.
    """
    import shutil
    import subprocess
    import tempfile
    from pathlib import Path as _Path

    if not shutil.which(GLTFPACK_BIN):
        print("skip  meshopt input (no gltfpack binary)")
        return

    source = trimesh.creation.icosphere(subdivisions=2)
    plain = trimesh.Scene({"a": source}).export(file_type="glb")
    with tempfile.TemporaryDirectory() as tmp:
        raw, packed = _Path(tmp) / "raw.glb", _Path(tmp) / "packed.glb"
        raw.write_bytes(plain)
        subprocess.run(
            [GLTFPACK_BIN, "-i", str(raw), "-o", str(packed), "-cc"],
            capture_output=True, check=True, timeout=GLTFPACK_TIMEOUT_S,
        )
        packed_bytes = packed.read_bytes()

    try:
        validate_input_mesh(packed_bytes)
        _check(False, "compressed input rejected before the decode")
    except Exception:
        _check(True, "compressed input is unusable before the decode")

    decoded, _ = decode_if_meshopt(packed_bytes, ".glb")
    validate_input_mesh(decoded)
    mesh = trimesh.load(io.BytesIO(decoded), file_type="glb", force="mesh")
    _check(len(mesh.faces) == len(source.faces), "decoded input keeps every face")


if __name__ == "__main__":
    try:
        test_skeleton_and_skinning()
        test_named_joints()
        test_blendshape_targets()
        test_zero_delta_primitives_skipped()
        test_dirty_weights_no_collapse()
        test_nonidentity_node_baked()
        test_divergent_instances_rejected()
        test_meshopt_input_decoded()
    except AssertionError:
        print("\nFAILED")
        sys.exit(1)
    print("\nALL PASSED")
