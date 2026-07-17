"""
Pure glTF skin authoring: turns a raw mesh GLB plus a predicted skeleton and
skinning weights into a spec-valid rigged GLB.

Kept dependency-light on purpose (numpy / scipy / pygltflib / trimesh only, no
torch / CUDA / GCP) so it can be unit-tested without a GPU; see test_rig_glb.py.

What `build_rigged_glb` produces, preserving all original geometry/materials:
  - a joint-node hierarchy (parent-relative translations, identity bind rotations)
  - an inverseBindMatrices accessor
  - a `skin` bound to every node that draws a mesh
  - JOINTS_0 / WEIGHTS_0 vertex attributes (top-4 normalized influences) on each
    primitive, aligned to that primitive's exact vertex order via a KD-tree
    (the model's GLB vertex set need not match the predictor's working vertices)
  - optional ARKit-named morph targets from blendshape deltas; primitives whose
    vertices carry no deltas (body, clothes) are skipped so 52 zero targets do
    not bloat every primitive

Robustness: model output is sanitized (NaN/Inf/negative weights dropped), every
vertex is guaranteed a unit weight sum (no skinning collapse), JOINTS_0 uses the
smallest legal integer width, and a non-identity skinned-node transform (which
would silently misplace the skeleton) fails loudly instead of corrupting output.

This file began as workers/unirig/rig_glb.py and generalizes it: the caller
supplies explicit `joint_names` (the rig worker passes Mixamo names, which the
platform's glb-canonicalize maps onto the canonical clip skeleton).
"""

from __future__ import annotations

import logging

import numpy as np
import pygltflib
from scipy.spatial import cKDTree

log = logging.getLogger("rig.rig_glb")

ARKIT_52_BLENDSHAPES = [
    "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft",
    "browOuterUpRight", "cheekPuff", "cheekSquintLeft", "cheekSquintRight",
    "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft", "eyeLookDownRight",
    "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
    "eyeLookUpLeft", "eyeLookUpRight", "eyeSquintLeft", "eyeSquintRight",
    "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawOpen",
    "jawRight", "mouthClose", "mouthDimpleLeft", "mouthDimpleRight",
    "mouthFrownLeft", "mouthFrownRight", "mouthFunnel", "mouthLeft",
    "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft",
    "mouthPressRight", "mouthPucker", "mouthRight", "mouthRollLower",
    "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "mouthSmileLeft",
    "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight",
    "mouthUpperUpLeft", "mouthUpperUpRight", "noseSneerLeft", "noseSneerRight",
    "tongueOut",
]

# glTF constant codes (https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html).
_GLTF_FLOAT = 5126
_GLTF_UBYTE = 5121
_GLTF_USHORT = 5123
_GLTF_ARRAY_BUFFER = 34962
_MAX_INFLUENCES = 4  # glTF JOINTS_0/WEIGHTS_0 carry 4 influences per set


def _append_view(glb, blob: bytearray, data: bytes, target: int | None = None) -> int:
    """Append `data` to the GLB binary buffer (4-byte aligned) and return the
    index of a new bufferView covering it."""
    while len(blob) % 4 != 0:
        blob.append(0)
    offset = len(blob)
    blob.extend(data)
    bv = pygltflib.BufferView(buffer=0, byteOffset=offset, byteLength=len(data))
    if target is not None:
        bv.target = target
    glb.bufferViews.append(bv)
    return len(glb.bufferViews) - 1


def _add_accessor(glb, view: int, comp: int, count: int, typ: str,
                  mn=None, mx=None) -> int:
    acc = pygltflib.Accessor(
        bufferView=view, byteOffset=0, componentType=comp, count=count, type=typ,
    )
    if mn is not None:
        acc.min = mn
    if mx is not None:
        acc.max = mx
    glb.accessors.append(acc)
    return len(glb.accessors) - 1


def _read_positions(glb, blob: bytearray, acc_idx: int) -> np.ndarray:
    """Decode a VEC3/FLOAT POSITION accessor from the binary buffer. Handles
    both tightly packed and interleaved (byteStride) layouts, vectorized."""
    acc = glb.accessors[acc_idx]
    if acc.componentType != _GLTF_FLOAT or acc.type != "VEC3":
        raise RuntimeError(
            f"unsupported POSITION accessor (componentType={acc.componentType}, type={acc.type}); "
            "skinning expects float32 VEC3 positions"
        )
    bv = glb.bufferViews[acc.bufferView]
    base = (bv.byteOffset or 0) + (acc.byteOffset or 0)
    n = acc.count
    stride = bv.byteStride or 12
    if stride == 12:
        return np.frombuffer(bytes(blob[base:base + 12 * n]), dtype="<f4").reshape(n, 3).copy()
    # Interleaved: lift the first 12 bytes (the VEC3) out of each stride slot.
    raw = np.frombuffer(bytes(blob[base:base + stride * n]), dtype=np.uint8).reshape(n, stride)
    return raw[:, :12].copy().view("<f4").reshape(n, 3)


def _quat_to_mat3(x, y, z, w):
    n = x * x + y * y + z * z + w * w
    if n < 1e-12:
        return np.eye(3)
    s = 2.0 / n
    return np.array([
        [1 - s * (y * y + z * z), s * (x * y - z * w),     s * (x * z + y * w)],
        [s * (x * y + z * w),     1 - s * (x * x + z * z), s * (y * z - x * w)],
        [s * (x * z - y * w),     s * (y * z + x * w),     1 - s * (x * x + y * y)],
    ])


def _local_matrix(node) -> np.ndarray:
    if node.matrix:
        # glTF stores matrices column-major; transpose to math (row-major) form.
        return np.array(node.matrix, dtype=np.float64).reshape(4, 4).T
    m = np.eye(4)
    if node.rotation:
        m[:3, :3] = _quat_to_mat3(*node.rotation)
    if node.scale:
        m[:3, :3] = m[:3, :3] @ np.diag(node.scale)
    if node.translation:
        m[:3, 3] = node.translation
    return m


def _world_matrices(glb) -> list[np.ndarray]:
    """World transform of every node, composed down the hierarchy."""
    n = len(glb.nodes)
    local = [_local_matrix(glb.nodes[i]) for i in range(n)]
    parent = {}
    for i, nd in enumerate(glb.nodes):
        for c in (nd.children or []):
            parent[c] = i
    world: list[np.ndarray | None] = [None] * n

    def compute(i):
        if world[i] is None:
            p = parent.get(i)
            world[i] = local[i] if p is None else compute(p) @ local[i]
        return world[i]

    return [compute(i) for i in range(n)]


def _normalize_blendshapes(data):
    """Coerce blendshape output into (names, deltas[K,V,3]). Accepts a
    {name: (V,3)} dict, a {"names":[...], "deltas": array} dict, or a bare
    (K,V,3) array (named positionally from ARKIT_52_BLENDSHAPES)."""
    if isinstance(data, dict):
        if "deltas" in data:
            deltas = np.asarray(data["deltas"], dtype=np.float32)
            names = list(data.get("names") or ARKIT_52_BLENDSHAPES[: len(deltas)])
        else:
            names = list(data.keys())
            deltas = np.stack([np.asarray(data[k], dtype=np.float32) for k in names], axis=0)
    else:
        deltas = np.asarray(data, dtype=np.float32)
        names = list(ARKIT_52_BLENDSHAPES[: len(deltas)])
    if deltas.ndim != 3 or deltas.shape[-1] != 3:
        raise RuntimeError(f"blendshape deltas must be (K,V,3); got {deltas.shape}")
    if len(names) < len(deltas):
        names += [f"blendshape_{i}" for i in range(len(names), len(deltas))]
    return names[: len(deltas)], deltas


def _top_influences(weights, n_joints):
    """Sanitize the (V,J) weight matrix and reduce it to (V,4) joint indices +
    (V,4) normalized weights. Every vertex is guaranteed a unit weight sum: a
    vertex the model left empty is pinned to joint 0 rather than collapsing to
    the origin under linear-blend skinning."""
    w = np.nan_to_num(np.asarray(weights, dtype=np.float32),
                      nan=0.0, posinf=0.0, neginf=0.0)
    np.clip(w, 0.0, None, out=w)
    if w.shape[1] < _MAX_INFLUENCES:
        w = np.pad(w, ((0, 0), (0, _MAX_INFLUENCES - w.shape[1])))

    order = np.argsort(-w, axis=1)[:, :_MAX_INFLUENCES]
    top = np.take_along_axis(w, order, axis=1).astype(np.float32)

    empty = top.sum(axis=1) <= 0.0
    if empty.any():
        order[empty] = 0
        top[empty] = 0.0
        top[empty, 0] = 1.0

    top /= top.sum(axis=1, keepdims=True)
    joint_idx = np.clip(order, 0, max(n_joints - 1, 0))
    return joint_idx, top


def build_rigged_glb(mesh_bytes, mesh, joints, parents, weights,
                     blendshape_data=None, joint_names=None):
    """Author a fully rigged GLB from the raw mesh and the model's predictions.
    Returns the serialized GLB bytes. `mesh` is the trimesh (or any object with
    a .vertices array) the weights were computed over, in the SAME world space
    as the original GLB; `joints` (J,3) world-space, `parents` (J,) with -1 (or
    any out-of-range value) marking roots, `weights` (V,J). `joint_names` is an
    optional list of J bone names; unnamed joints fall back to joint_i."""
    glb = pygltflib.GLTF2.load_from_bytes(mesh_bytes)
    blob = bytearray(glb.binary_blob() or b"")

    joints = np.asarray(joints, dtype=np.float32).reshape(-1, 3)        # (J,3) world-space
    parents = np.asarray(parents).astype(np.int64).reshape(-1)          # (J,)
    n_joints = joints.shape[0]
    n_verts = len(mesh.vertices)
    weights = np.asarray(weights, dtype=np.float32)                     # (V,J)
    if parents.shape[0] != n_joints:
        raise RuntimeError(f"joints/parents length mismatch: {n_joints} vs {parents.shape[0]}")
    if weights.ndim != 2 or weights.shape[1] != n_joints:
        raise RuntimeError(f"skinning weights must be (V,{n_joints}); got {weights.shape}")
    if weights.shape[0] != n_verts:
        raise RuntimeError(
            f"weights rows ({weights.shape[0]}) != mesh vertices ({n_verts}); "
            "predictor output is not aligned to the input mesh"
        )
    if joint_names is not None and len(joint_names) != n_joints:
        raise RuntimeError(
            f"joint_names length ({len(joint_names)}) != joints ({n_joints})"
        )

    if not glb.scenes:
        glb.scenes.append(pygltflib.Scene(nodes=[]))
    scene = glb.scenes[glb.scene if glb.scene is not None else 0]

    # World transforms of the ORIGINAL nodes (before we add joint nodes), used
    # to (a) match weights in the same space the joints live in and (b) reject
    # a transformed skinned node whose bind pose we cannot honor.
    world_mats = _world_matrices(glb)

    # Joint nodes: parent-relative translations, identity bind rotations.
    base_node = len(glb.nodes)
    joint_nodes = [base_node + i for i in range(n_joints)]
    child_map: dict[int, list[int]] = {i: [] for i in range(n_joints)}
    for i in range(n_joints):
        p = int(parents[i])
        if 0 <= p < n_joints:
            child_map[p].append(joint_nodes[i])
    for i in range(n_joints):
        p = int(parents[i])
        origin = joints[p] if 0 <= p < n_joints else np.zeros(3, dtype=np.float32)
        local = (joints[i] - origin).astype(float)
        node = pygltflib.Node(
            name=str(joint_names[i]) if joint_names is not None else f"joint_{i}",
            translation=[local[0], local[1], local[2]],
        )
        if child_map[i]:
            node.children = child_map[i]
        glb.nodes.append(node)
    roots = [joint_nodes[i] for i in range(n_joints) if not 0 <= int(parents[i]) < n_joints]
    for r in roots:
        if r not in scene.nodes:
            scene.nodes.append(r)

    # inverseBindMatrices: inverse(world bind) = translate(-world), column-major.
    ibm = np.zeros((n_joints, 16), dtype=np.float32)
    ibm[:, 0] = ibm[:, 5] = ibm[:, 10] = ibm[:, 15] = 1.0
    ibm[:, 12] = -joints[:, 0]
    ibm[:, 13] = -joints[:, 1]
    ibm[:, 14] = -joints[:, 2]
    ibm_acc = _add_accessor(glb, _append_view(glb, blob, ibm.tobytes()), _GLTF_FLOAT, n_joints, "MAT4")

    skin = pygltflib.Skin(joints=joint_nodes, inverseBindMatrices=ibm_acc)
    if roots:
        skin.skeleton = roots[0]
    glb.skins.append(skin)
    skin_idx = len(glb.skins) - 1

    # Smallest legal integer width for joint indices (u8 covers 65 Mixamo joints).
    if n_joints <= 256:
        joint_comp, joint_dtype = _GLTF_UBYTE, np.uint8
    elif n_joints <= 65536:
        joint_comp, joint_dtype = _GLTF_USHORT, np.uint16
    else:
        raise RuntimeError(f"too many joints for glTF skinning: {n_joints}")

    joint_idx, top_w = _top_influences(weights, n_joints)   # (V,4) over mesh vertex order
    kdt = cKDTree(np.asarray(mesh.vertices, dtype=np.float32))
    blend = _normalize_blendshapes(blendshape_data) if blendshape_data is not None else None
    bs_deltas = blend[1] if blend else None

    # Map original nodes to meshes, so we can attach the skin to the right node.
    mesh_to_nodes: dict[int, list[int]] = {}
    for ni in range(base_node):
        node = glb.nodes[ni]
        if node.mesh is not None:
            mesh_to_nodes.setdefault(node.mesh, []).append(ni)

    skinned_any = False
    for mi, gmesh in enumerate(glb.meshes):
        nodes = mesh_to_nodes.get(mi, [])
        # Joints are world-space; if the drawing node carries a transform, the
        # primitive's local positions live in a different frame. Honor that for
        # weight matching, and refuse a non-identity transform we can't bake
        # into the bind pose (our generators export identity, so this is a
        # loud guard, not a silent corruption).
        wm = world_mats[nodes[0]] if nodes else np.eye(4)
        if not np.allclose(wm, np.eye(4), atol=1e-4):
            raise RuntimeError(
                f"mesh {mi} is drawn by a node with a non-identity transform; "
                "bake the transform into the geometry before rigging"
            )

        mesh_targets = 0
        for prim in gmesh.primitives:
            pos_acc = getattr(prim.attributes, "POSITION", None)
            if pos_acc is None:
                continue
            verts = _read_positions(glb, blob, pos_acc)            # (M,3) primitive order
            world_pos = verts @ wm[:3, :3].T + wm[:3, 3]
            _, nearest = kdt.query(world_pos, k=1)                 # (M,) -> mesh vertex index
            nearest = np.asarray(nearest).reshape(-1)

            j0 = np.ascontiguousarray(joint_idx[nearest].astype(joint_dtype))
            w0 = np.ascontiguousarray(top_w[nearest].astype(np.float32))
            prim.attributes.JOINTS_0 = _add_accessor(
                glb, _append_view(glb, blob, j0.tobytes(), _GLTF_ARRAY_BUFFER),
                joint_comp, verts.shape[0], "VEC4")
            prim.attributes.WEIGHTS_0 = _add_accessor(
                glb, _append_view(glb, blob, w0.tobytes(), _GLTF_ARRAY_BUFFER),
                _GLTF_FLOAT, verts.shape[0], "VEC4")

            if bs_deltas is not None:
                prim_deltas = bs_deltas[:, nearest, :]             # (K,M,3)
                # Morph targets are only meaningful where deltas exist (the
                # head). Skip primitives whose verts carry no deformation so
                # body/clothing primitives don't gain 52 all-zero targets.
                if np.abs(prim_deltas).max() > 1e-7:
                    targets = []
                    for d in prim_deltas:
                        d = np.ascontiguousarray(np.asarray(d, dtype=np.float32))
                        acc = _add_accessor(
                            glb, _append_view(glb, blob, d.tobytes(), _GLTF_ARRAY_BUFFER),
                            _GLTF_FLOAT, verts.shape[0], "VEC3",
                            mn=d.min(axis=0).tolist(), mx=d.max(axis=0).tolist())
                        targets.append(pygltflib.Attributes(POSITION=acc))
                    prim.targets = targets
                    mesh_targets = len(targets)
            skinned_any = True

        if mesh_targets:
            gmesh.weights = [0.0] * mesh_targets
            gmesh.extras = {**(gmesh.extras or {}), "targetNames": blend[0]}

        # Bind the skin to every node that draws this mesh (create one if none).
        if not nodes:
            new_ni = len(glb.nodes)
            glb.nodes.append(pygltflib.Node(mesh=mi, skin=skin_idx))
            scene.nodes.append(new_ni)
        else:
            for ni in nodes:
                glb.nodes[ni].skin = skin_idx

    if not skinned_any:
        raise RuntimeError("no mesh primitive with POSITION found; cannot rig")

    log.info(
        "Rigged GLB: %d joints (%s indices), 4 influences/vertex, %d morph targets",
        n_joints, "u8" if joint_comp == _GLTF_UBYTE else "u16",
        len(blend[0]) if blend else 0,
    )

    # Serialize (pygltflib 1.16.x returns a list of chunks).
    glb.set_binary_blob(bytes(blob))
    if not glb.buffers:
        glb.buffers.append(pygltflib.Buffer())
    glb.buffers[0].byteLength = len(blob)
    out = glb.save_to_bytes()
    return b"".join(out) if isinstance(out, (list, tuple)) else out
