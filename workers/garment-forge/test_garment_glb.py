"""
Unit tests for the pure glTF pipeline in garment_glb.py: no GPU, no network,
no GCP. Runs as a Docker build gate (see Dockerfile) and locally:

    python3 workers/garment-forge/test_garment_glb.py

Covers, in pipeline order:
  - bone-name canonicalization (the Mixamo-scope port),
  - slot placement math (scale + translation into the slot box),
  - scene composition (garment + reference body, names preserved, textures
    survive the trimesh round-trip),
  - garment extraction from a rigged composite (body stripped, buffer
    repacked, joints canonicalized, garment texture kept),
  - skin statistics / coverage / occludes derivation,
  - all 6 manifest validation rules, each failing for its own reason.
"""

from __future__ import annotations

import io
import struct
import sys

import numpy as np
import pygltflib
import trimesh
from PIL import Image

from canonical_bones import canonicalize_bone_name
from garment_glb import (
    GARMENT_PREFIX,
    MIN_BIND_COVERAGE,
    REFBODY_PREFIX,
    SLOT_BOXES,
    SPEC_URI,
    build_manifest,
    compose_scene,
    derive_occludes,
    extract_garment,
    garment_placement,
    sha256_hex,
    skin_stats,
    slugify,
    validate_manifest,
    weighted_bones,
)

PASS = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS
    if not condition:
        print(f"FAIL  {name}  {detail}")
        sys.exit(1)
    PASS += 1
    print(f"ok    {name}")


# ── fixtures ────────────────────────────────────────────────────────────────

def textured_box_glb() -> bytes:
    """A box with a real baseColorTexture, exported through trimesh."""
    mesh = trimesh.creation.box(extents=(1.0, 2.0, 0.5))
    img = Image.new("RGB", (8, 8), (200, 40, 40))
    uv = np.zeros((len(mesh.vertices), 2), dtype=np.float64)
    mesh.visual = trimesh.visual.TextureVisuals(
        uv=uv, material=trimesh.visual.material.PBRMaterial(baseColorTexture=img))
    scene = trimesh.Scene()
    scene.add_geometry(mesh, node_name="src", geom_name="src")
    return scene.export(file_type="glb")


def plain_body_glb() -> bytes:
    scene = trimesh.Scene()
    scene.add_geometry(trimesh.creation.capsule(radius=0.2, height=1.2),
                       node_name="body", geom_name="body")
    return scene.export(file_type="glb")


def _pack_floats(values) -> bytes:
    return struct.pack(f"<{len(values)}f", *values)


def build_rigged_composite(garment_joint_weights, body_texture: bool = True) -> bytes:
    """A minimal rigged composite the way model-rig would emit it: a mixamorig
    joint chain, one skin, a `garment_0` mesh and a `refbody_0` mesh, both
    skinned, the garment with a real embedded texture.

    garment_joint_weights: list of (joint_index, weight) rows, one per garment
    vertex (3 vertices required), letting tests steer coverage/occludes.
    """
    glb = pygltflib.GLTF2()
    blob = bytearray()

    def append_view(data: bytes, target=None) -> int:
        while len(blob) % 4:
            blob.append(0)
        view = pygltflib.BufferView(buffer=0, byteOffset=len(blob), byteLength=len(data))
        if target is not None:
            view.target = target
        blob.extend(data)
        glb.bufferViews.append(view)
        return len(glb.bufferViews) - 1

    def add_accessor(view, comp, count, typ, mn=None, mx=None) -> int:
        acc = pygltflib.Accessor(bufferView=view, componentType=comp, count=count, type=typ)
        if mn is not None:
            acc.min, acc.max = mn, mx
        glb.accessors.append(acc)
        return len(glb.accessors) - 1

    # Joints: Hips(0) → Spine(1) → LeftArm(2), plus a helper the canonical set
    # lacks (3) to exercise unresolved-mass accounting.
    joint_names = ["mixamorig:Hips", "mixamorig:Spine", "mixamorig:LeftArm",
                   "mixamorig:WeirdHelper"]
    for i, name in enumerate(joint_names):
        glb.nodes.append(pygltflib.Node(name=name, translation=[0, 0.3 * i, 0]))
    glb.nodes[0].children = [1]
    glb.nodes[1].children = [2, 3]

    ibm = np.tile(np.eye(4, dtype=np.float32).T.reshape(-1), (len(joint_names), 1))
    ibm_acc = add_accessor(append_view(ibm.tobytes()), 5126, len(joint_names), "MAT4")
    glb.skins.append(pygltflib.Skin(joints=[0, 1, 2, 3], inverseBindMatrices=ibm_acc,
                                    skeleton=0))

    def add_skinned_mesh(name: str, rows, material=None) -> int:
        pos = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float32)
        pos_acc = add_accessor(append_view(pos.tobytes(), 34962), 5126, 3, "VEC3",
                               mn=pos.min(axis=0).tolist(), mx=pos.max(axis=0).tolist())
        joints = np.zeros((3, 4), dtype=np.uint8)
        weights = np.zeros((3, 4), dtype=np.float32)
        for vi, (ji, w) in enumerate(rows):
            joints[vi, 0] = ji
            weights[vi, 0] = w
            rest = 1.0 - w
            if rest > 0:
                joints[vi, 1] = 0
                weights[vi, 1] = rest
        j_acc = add_accessor(append_view(joints.tobytes(), 34962), 5121, 3, "VEC4")
        w_acc = add_accessor(append_view(weights.tobytes(), 34962), 5126, 3, "VEC4")
        idx = np.array([0, 1, 2], dtype=np.uint16)
        i_acc = add_accessor(append_view(idx.tobytes(), 34963), 5123, 3, "SCALAR")
        prim = pygltflib.Primitive(
            attributes=pygltflib.Attributes(POSITION=pos_acc, JOINTS_0=j_acc,
                                            WEIGHTS_0=w_acc),
            indices=i_acc, material=material)
        glb.meshes.append(pygltflib.Mesh(name=name, primitives=[prim]))
        node = pygltflib.Node(name=name, mesh=len(glb.meshes) - 1, skin=0)
        glb.nodes.append(node)
        return len(glb.nodes) - 1

    # Garment texture: a real PNG embedded in the buffer.
    png = io.BytesIO()
    Image.new("RGB", (4, 4), (10, 200, 10)).save(png, format="PNG")
    img_view = append_view(png.getvalue())
    glb.images.append(pygltflib.Image(bufferView=img_view, mimeType="image/png"))
    glb.samplers.append(pygltflib.Sampler())
    glb.textures.append(pygltflib.Texture(source=0, sampler=0))
    glb.materials.append(pygltflib.Material(
        name="garment-mat",
        pbrMetallicRoughness=pygltflib.PbrMetallicRoughness(
            baseColorTexture=pygltflib.TextureInfo(index=0))))

    # Body texture: a second PNG that extraction must drop.
    body_mat = None
    if body_texture:
        png2 = io.BytesIO()
        Image.new("RGB", (4, 4), (10, 10, 200)).save(png2, format="PNG")
        img_view2 = append_view(png2.getvalue())
        glb.images.append(pygltflib.Image(bufferView=img_view2, mimeType="image/png"))
        glb.textures.append(pygltflib.Texture(source=1, sampler=0))
        glb.materials.append(pygltflib.Material(
            name="body-mat",
            pbrMetallicRoughness=pygltflib.PbrMetallicRoughness(
                baseColorTexture=pygltflib.TextureInfo(index=1))))
        body_mat = 1

    garment_node = add_skinned_mesh(f"{GARMENT_PREFIX}_0", garment_joint_weights, 0)
    body_node = add_skinned_mesh(f"{REFBODY_PREFIX}_0",
                                 [(0, 1.0), (0, 1.0), (1, 1.0)], body_mat)

    glb.scenes.append(pygltflib.Scene(nodes=[0, garment_node, body_node]))
    glb.scene = 0
    glb.buffers.append(pygltflib.Buffer(byteLength=len(blob)))
    glb.set_binary_blob(bytes(blob))
    out = glb.save_to_bytes()
    return b"".join(out) if isinstance(out, (list, tuple)) else out


# ── canonicalization ────────────────────────────────────────────────────────

check("mixamorig namespace strips", canonicalize_bone_name("mixamorig:LeftArm") == "LeftArm")
check("numbered namespace strips", canonicalize_bone_name("mixamorig1:Spine2") == "Spine2")
check("glued mixamo prefix strips", canonicalize_bone_name("mixamorigRightFoot") == "RightFoot")
check("canonical passes through", canonicalize_bone_name("LeftHandIndex2") == "LeftHandIndex2")
check("separators normalize", canonicalize_bone_name("left_fore_arm") == "LeftForeArm")
check("non-humanoid rejects", canonicalize_bone_name("tentacle_tip") is None)

# ── placement ───────────────────────────────────────────────────────────────

box_glb = textured_box_glb()
loaded = trimesh.load(io.BytesIO(box_glb), file_type="glb", process=False)
meshes = [g.copy() for g in loaded.geometry.values()]
placement = garment_placement(meshes, "top")
placed = meshes[0].copy()
placed.apply_transform(placement)
top = SLOT_BOXES["top"]
height = placed.bounds[1][1] - placed.bounds[0][1]
center_y = (placed.bounds[1][1] + placed.bounds[0][1]) / 2
check("placement fits slot height", abs(height - top["size"][1]) < 1e-6, f"height={height}")
check("placement centers on slot", abs(center_y - top["center"][1]) < 1e-6, f"cy={center_y}")

# ── composition ─────────────────────────────────────────────────────────────

composite = compose_scene(box_glb, plain_body_glb(), "top")
comp_glb = pygltflib.GLTF2.load_from_bytes(composite)
names = sorted(m.name or "" for m in comp_glb.meshes)
check("composite keeps both parts",
      any(n.startswith(GARMENT_PREFIX) for n in names)
      and any(n.startswith(REFBODY_PREFIX) for n in names), str(names))
check("composite garment textured", len(comp_glb.images) >= 1)

# ── extraction ──────────────────────────────────────────────────────────────

# Garment weighted: Spine 100%, Spine 80%/Hips 20%, LeftArm 100%.
rigged = build_rigged_composite([(1, 1.0), (1, 0.8), (2, 1.0)])
garment_only = extract_garment(rigged)
out = pygltflib.GLTF2.load_from_bytes(garment_only)

check("extraction drops body mesh",
      [m.name for m in out.meshes] == [f"{GARMENT_PREFIX}_0"],
      str([m.name for m in out.meshes]))
check("extraction keeps the skin", len(out.skins) == 1)
check("extraction drops body texture", len(out.images) == 1 and len(out.materials) == 1,
      f"images={len(out.images)} materials={len(out.materials)}")
check("extraction shrinks the buffer", len(garment_only) < len(rigged))
joint_names = [out.nodes[j].name for j in out.skins[0].joints]
check("joints canonicalized", joint_names[:3] == ["Hips", "Spine", "LeftArm"],
      str(joint_names))
check("unmappable joint keeps its name", joint_names[3] == "mixamorig:WeirdHelper")
kept_png = None
for img in out.images:
    view = out.bufferViews[img.bufferView]
    blob = out.binary_blob()
    kept_png = bytes(blob[view.byteOffset:view.byteOffset + view.byteLength])
check("kept texture is the garment's",
      kept_png is not None and Image.open(io.BytesIO(kept_png)).getpixel((0, 0))[1] > 150)

# ── stats / coverage / occludes ─────────────────────────────────────────────

stats = skin_stats(garment_only)
check("full coverage when all joints resolve", abs(stats["coverage"] - 1.0) < 1e-9,
      f"coverage={stats['coverage']}")
occ = derive_occludes(stats["bone_mass"], stats["total_mass"])
check("occludes torso from Spine mass", "torso" in occ, str(occ))
check("occludes upperArms from LeftArm mass", "upperArms" in occ, str(occ))
# The synthetic's Hips mass is 0.2 of one vertex = 6.7% of total garment
# weight — a waistband graze. Under the evidence threshold (10%) a graze must
# NOT hide the pelvis; that exact over-declaration amputated the avatar's
# lower body with the first live-seeded shirt.
check("6.7% hip graze does not occlude hips", "hips" not in occ, str(occ))
check("no phantom regions", all(r in ("torso", "upperArms") for r in occ), str(occ))
# Slot plausibility clamp: evidence alone is not enough. The same weight
# spread on a footwear-slot garment must not hide torso or hips, and a shirt
# whose waistband carries a trace of Hips mass must not amputate the legs.
occ_clamped = derive_occludes(stats["bone_mass"], stats["total_mass"], slot="footwear")
check("slot clamp: footwear cannot occlude torso/hips", occ_clamped == [], str(occ_clamped))
occ_top = derive_occludes(stats["bone_mass"], stats["total_mass"], slot="top")
check("slot clamp: top keeps its evidenced regions", occ_top == occ, f"{occ_top} vs {occ}")
trace = {"Spine": 0.97, "Hips": 0.03}
occ_trace = derive_occludes(trace, 1.0, slot="top")
check("3% hip graze does not hide the pelvis", occ_trace == ["torso"], str(occ_trace))
bones = weighted_bones(stats["bone_mass"], stats["total_mass"])
check("rig.bones in canonical order", bones == ["Hips", "Spine", "LeftArm"], str(bones))

# Low coverage: 70% of weight on the helper joint that cannot canonicalize.
low = extract_garment(build_rigged_composite([(3, 0.7), (3, 0.7), (3, 0.7)]))
low_stats = skin_stats(low)
check("unresolved joints lower coverage", low_stats["coverage"] < MIN_BIND_COVERAGE,
      f"coverage={low_stats['coverage']}")

# ── manifest validation ─────────────────────────────────────────────────────

manifest = build_manifest(
    garment_id="test-shirt-abc123", name="Test shirt", slot="top", version=1,
    model_uri="https://storage.googleapis.com/bucket/garments/top/test/v1/garment.glb",
    glb_bytes=garment_only, triangle_count=stats["triangle_count"],
    bones=bones, occludes=occ, prompt="test shirt", mesh_model="hunyuan3d-2.1",
    thumb_uri="https://storage.googleapis.com/bucket/garments/top/test/v1/thumb.webp")
verdict = validate_manifest(manifest, garment_only)
check("valid manifest passes all 6 rules", verdict["ok"], str(verdict["failures"]))
check("manifest pins the spec URI", manifest["spec"] == SPEC_URI)

bad = dict(manifest, spec="https://example.com/other-spec")
check("rule 1 rejects unknown spec", not validate_manifest(bad, garment_only)["ok"])
bad = dict(manifest, slot="cape")
check("rule 2 rejects unknown slot", not validate_manifest(bad, garment_only)["ok"])
bad = dict(manifest, occludes=["torso", "tail"])
check("rule 3 rejects unknown region", not validate_manifest(bad, garment_only)["ok"])
bad = dict(manifest, model=dict(manifest["model"], sha256="0" * 64))
check("rule 4 rejects a hash mismatch", not validate_manifest(bad, garment_only)["ok"])
low_manifest = dict(manifest, model=dict(manifest["model"], sha256=sha256_hex(low)))
check("rule 5 rejects low coverage", not validate_manifest(low_manifest, low)["ok"])
bad = dict(manifest, license="CC-BY-NC-4.0")
check("rule 6 rejects non-commercial license", not validate_manifest(bad, garment_only)["ok"])

# ── slug ────────────────────────────────────────────────────────────────────

check("slugify", slugify("A White Oxford Shirt, long sleeves!") == "a-white-oxford-shirt-long")

print(f"\nall {PASS} checks passed")
