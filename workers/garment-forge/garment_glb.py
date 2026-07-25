"""
Pure glTF/geometry operations for the garment forge: no network, no GCP, no
GPU, so every function here is unit-testable (see test_garment_glb.py).

The pipeline (main.py) composes these into:

  1. compose_scene()    garment mesh + reference body → one GLB for model-rig.
                        The garment is scaled/placed into the region box its
                        wardrobe slot occupies on the reference body, so the
                        rigger predicts its weights with full-body context.
  2. extract_garment()  rigged composite → garment-only skinned GLB. Strips
                        the reference body, canonicalizes bone names, and
                        repacks the binary buffer so none of the body's
                        geometry or textures ship inside the published asset.
  3. skin_stats()       weight mass per canonical bone + bind coverage: the
                        number attachGarment() (src/avatar-garment.js) will
                        gate on at runtime.
  4. derive_occludes()  REGION_BONES weight mass → `occludes` declaration.
  5. validate_manifest() the 6 validation rules from specs/GARMENT_MANIFEST.md.

Geometry constants (slot boxes) are measured against the reference body baked
into this worker's image: public/avatars/parametric-base.glb, an A-pose,
1.667 m tall canonical humanoid whose front faces +Z.
"""

from __future__ import annotations

import hashlib
import io
import re

import numpy as np
import pygltflib
import trimesh

from canonical_bones import (
    BODY_REGIONS,
    CANONICAL_BONES,
    GARMENT_SLOTS,
    MIN_BIND_COVERAGE,
    canonicalize_bone_name,
    region_of_bone,
)

SPEC_URI = "https://three.ws/specs/garment-manifest-v1"

# SPDX identifiers the catalog accepts (validation rule 6: recognised SPDX,
# commercial use permitted). Kept in exact lockstep with COMMERCIAL_LICENSES
# in src/garment-catalog.js: publishing anything the runtime consumer would
# reject is a dead catalog entry.
COMMERCIAL_SPDX = frozenset({
    "CC0-1.0", "CC-BY-4.0", "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause",
})

# A region must carry at least this share of the garment's total skin weight
# to be declared in `occludes`. Weight share is a proxy for coverage, and a
# LOW threshold over-declares catastrophically: a shirt whose waistband picks
# up 1-2% of its weight on Hips would hide the avatar's entire pelvis and legs
# (verified live: the first seeded shirt amputated the lower body). 10%
# requires the garment to genuinely dress a region before hiding its skin;
# the per-slot plausibility clamp below is the second gate.
OCCLUDES_MIN_SHARE = 0.10

# Regions a garment in a given slot is ALLOWED to occlude, regardless of how
# its skin weight spreads. Evidence (weight share) decides within this set; a
# top can never hide feet no matter what the skinning says. `top` includes
# hips/upperLegs because dresses and long jackets ship under that slot.
SLOT_OCCLUDABLE = {
    "top": ("torso", "upperArms", "lowerArms", "neck", "hips", "upperLegs"),
    "outerwear": ("torso", "upperArms", "lowerArms", "neck", "hips", "upperLegs"),
    "bottom": ("hips", "upperLegs", "lowerLegs"),
    "footwear": ("feet", "lowerLegs"),
    "hair": ("scalp",),
    "headwear": ("scalp",),
    "glasses": (),
    "accessory": (),
}

# A canonical bone enters the manifest's rig.bones list above this weight
# share: enough to filter numeric noise without dropping real influences.
RIG_BONES_MIN_SHARE = 0.001

# ── Slot placement boxes on the reference body ──────────────────────────────
# center (x, y, z) and size (w, h, d) in reference-body meters; `fit` is the
# axis (0=x, 1=y) whose extent the garment is scaled to match. Height-fit for
# body-length garments, width-fit for items whose height varies wildly with
# style (shoes, hair, glasses).
SLOT_BOXES = {
    "top":       {"center": (0.0, 1.14, 0.03),  "size": (0.90, 0.56, 0.45), "fit": 1},
    "outerwear": {"center": (0.0, 1.05, 0.03),  "size": (1.00, 0.80, 0.50), "fit": 1},
    "bottom":    {"center": (0.0, 0.50, 0.02),  "size": (0.50, 0.90, 0.35), "fit": 1},
    "footwear":  {"center": (0.0, 0.09, 0.06),  "size": (0.60, 0.18, 0.32), "fit": 0},
    "hair":      {"center": (0.0, 1.58, 0.03),  "size": (0.30, 0.25, 0.30), "fit": 0},
    "headwear":  {"center": (0.0, 1.60, 0.03),  "size": (0.30, 0.22, 0.30), "fit": 0},
    "glasses":   {"center": (0.0, 1.547, 0.11), "size": (0.18, 0.08, 0.12), "fit": 0},
    "accessory": {"center": (0.0, 1.20, 0.05),  "size": (0.35, 0.35, 0.25), "fit": 0},
}

GARMENT_PREFIX = "garment"
REFBODY_PREFIX = "refbody"

# glTF componentType → numpy dtype / byte size.
_COMPONENT_DTYPES = {
    5120: np.int8, 5121: np.uint8, 5122: np.int16,
    5123: np.uint16, 5125: np.uint32, 5126: np.float32,
}
_TYPE_COUNTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}


# ────────────────────────────────────────────────────────────────────────────
# Scene composition
# ────────────────────────────────────────────────────────────────────────────

def _scene_meshes(data: bytes) -> list[trimesh.Trimesh]:
    """Load a GLB into world-space trimesh geometries (transforms baked)."""
    loaded = trimesh.load(io.BytesIO(data), file_type="glb", process=False)
    if isinstance(loaded, trimesh.Trimesh):
        return [loaded]
    meshes = []
    for node_name in loaded.graph.nodes_geometry:
        transform, geom_name = loaded.graph[node_name]
        geom = loaded.geometry[geom_name]
        if not isinstance(geom, trimesh.Trimesh):
            continue
        mesh = geom.copy()
        mesh.apply_transform(transform)
        meshes.append(mesh)
    if not meshes:
        raise ValueError("GLB contains no triangle meshes")
    return meshes


def _bounds(meshes: list[trimesh.Trimesh]) -> tuple[np.ndarray, np.ndarray]:
    lo = np.min([m.bounds[0] for m in meshes], axis=0)
    hi = np.max([m.bounds[1] for m in meshes], axis=0)
    return lo, hi


def garment_placement(meshes: list[trimesh.Trimesh], slot: str, yaw_deg: float = 0.0) -> np.ndarray:
    """4x4 transform that carries a normalized generator-output garment into
    its slot's region box on the reference body: yaw to face +Z, uniform
    scale to the slot's fit-axis extent, translate to the box center."""
    box = SLOT_BOXES[slot]
    rot = trimesh.transformations.rotation_matrix(np.radians(yaw_deg), [0, 1, 0])

    rotated = [m.copy() for m in meshes]
    for m in rotated:
        m.apply_transform(rot)
    lo, hi = _bounds(rotated)
    extent = hi - lo
    fit = box["fit"]
    if extent[fit] <= 1e-9:
        raise ValueError(f"degenerate garment mesh (zero extent on fit axis {fit})")
    scale = box["size"][fit] / extent[fit]

    center = (lo + hi) / 2.0
    target = np.array(box["center"], dtype=np.float64)
    move = trimesh.transformations.translation_matrix(target - center * scale)
    scale_m = np.eye(4)
    scale_m[:3, :3] *= scale
    return move @ scale_m @ rot


def compose_scene(garment_bytes: bytes, refbody_bytes: bytes, slot: str,
                  yaw_deg: float = 0.0) -> bytes:
    """One GLB holding the reference body plus the garment placed into its
    slot box. Mesh names carry the garment/refbody split through the rigger,
    which preserves names, so extract_garment() can tell them apart."""
    if slot not in SLOT_BOXES:
        raise ValueError(f"unknown slot: {slot}")
    garment = _scene_meshes(garment_bytes)
    body = _scene_meshes(refbody_bytes)

    placement = garment_placement(garment, slot, yaw_deg)
    scene = trimesh.Scene()
    for i, m in enumerate(body):
        scene.add_geometry(m, node_name=f"{REFBODY_PREFIX}_{i}", geom_name=f"{REFBODY_PREFIX}_{i}")
    for i, m in enumerate(garment):
        placed = m.copy()
        placed.apply_transform(placement)
        scene.add_geometry(placed, node_name=f"{GARMENT_PREFIX}_{i}", geom_name=f"{GARMENT_PREFIX}_{i}")
    return scene.export(file_type="glb")


# ────────────────────────────────────────────────────────────────────────────
# glTF accessor plumbing
# ────────────────────────────────────────────────────────────────────────────

def _accessor_array(glb: pygltflib.GLTF2, blob: bytes, idx: int) -> np.ndarray:
    """Decode accessor `idx` to a (count, components) float/int array. Handles
    tightly packed and interleaved (byteStride) layouts."""
    acc = glb.accessors[idx]
    dtype = _COMPONENT_DTYPES[acc.componentType]
    ncomp = _TYPE_COUNTS[acc.type]
    elem = np.dtype(dtype).itemsize * ncomp
    bv = glb.bufferViews[acc.bufferView]
    base = (bv.byteOffset or 0) + (acc.byteOffset or 0)
    stride = bv.byteStride or elem
    if stride == elem:
        raw = np.frombuffer(blob, dtype=dtype, count=acc.count * ncomp, offset=base)
        return raw.reshape(acc.count, ncomp)
    rows = np.frombuffer(blob, dtype=np.uint8, count=stride * acc.count, offset=base)
    rows = rows.reshape(acc.count, stride)[:, :elem].copy()
    return rows.view(dtype).reshape(acc.count, ncomp)


def _accessor_bytes(glb: pygltflib.GLTF2, blob: bytes, idx: int) -> bytes:
    """Raw, tightly packed bytes of accessor `idx` (de-interleaved if needed)."""
    return np.ascontiguousarray(_accessor_array(glb, blob, idx)).tobytes()


def _prim_attribute_indices(prim) -> dict[str, int]:
    """Attribute name → accessor index for every set attribute of a primitive."""
    out = {}
    for name, value in vars(prim.attributes).items():
        if isinstance(value, int):
            out[name] = value
    return out


def _material_texture_slots(material) -> list:
    """The texture-info objects a standard PBR material can reference."""
    slots = []
    if material.pbrMetallicRoughness:
        slots += [material.pbrMetallicRoughness.baseColorTexture,
                  material.pbrMetallicRoughness.metallicRoughnessTexture]
    slots += [material.normalTexture, material.occlusionTexture, material.emissiveTexture]
    return [s for s in slots if s is not None]


# ────────────────────────────────────────────────────────────────────────────
# Garment extraction (strip reference body + repack)
# ────────────────────────────────────────────────────────────────────────────

def extract_garment(rigged_bytes: bytes, keep_prefix: str = GARMENT_PREFIX) -> bytes:
    """From a rigged composite GLB, keep only the garment meshes, the skeleton
    and its skin, and the resources they reference. Joint node names are
    canonicalized (mixamorig:LeftArm → LeftArm). The binary buffer is rebuilt
    from scratch so none of the reference body's geometry or textures survive
    into the published asset."""
    glb = pygltflib.GLTF2.load_from_bytes(rigged_bytes)
    blob = glb.binary_blob() or b""

    keep_meshes = {i for i, m in enumerate(glb.meshes)
                   if (m.name or "").startswith(keep_prefix)}
    if not keep_meshes:
        raise ValueError(f"no mesh named '{keep_prefix}*' in rigged GLB")

    # Skins still referenced once the body meshes are gone.
    keep_skins = set()
    for node in glb.nodes:
        if node.mesh in keep_meshes and node.skin is not None:
            keep_skins.add(node.skin)
    if not keep_skins:
        raise ValueError("garment mesh carries no skin: rigging did not bind it")

    # ── collect used resources ──
    used_accessors: set[int] = set()
    used_materials: set[int] = set()
    for mi in keep_meshes:
        for prim in glb.meshes[mi].primitives:
            used_accessors.update(_prim_attribute_indices(prim).values())
            if prim.indices is not None:
                used_accessors.add(prim.indices)
            if prim.material is not None:
                used_materials.add(prim.material)
            for target in (prim.targets or []):
                for value in vars(target).values():
                    if isinstance(value, int):
                        used_accessors.add(value)
    for si in keep_skins:
        if glb.skins[si].inverseBindMatrices is not None:
            used_accessors.add(glb.skins[si].inverseBindMatrices)

    used_textures: set[int] = set()
    for mati in used_materials:
        for slot in _material_texture_slots(glb.materials[mati]):
            used_textures.add(slot.index)
    used_images: set[int] = set()
    used_samplers: set[int] = set()
    for ti in used_textures:
        tex = glb.textures[ti]
        if tex.source is not None:
            used_images.add(tex.source)
        if tex.sampler is not None:
            used_samplers.add(tex.sampler)

    # ── rebuild the binary buffer: one tight bufferView per used accessor,
    #    plus one per used embedded image ──
    new_blob = bytearray()
    new_views: list[pygltflib.BufferView] = []
    new_accessors: list[pygltflib.Accessor] = []
    accessor_remap: dict[int, int] = {}

    def _append_view(data: bytes, target: int | None = None) -> int:
        while len(new_blob) % 4:
            new_blob.append(0)
        view = pygltflib.BufferView(buffer=0, byteOffset=len(new_blob), byteLength=len(data))
        if target is not None:
            view.target = target
        new_blob.extend(data)
        new_views.append(view)
        return len(new_views) - 1

    for old_idx in sorted(used_accessors):
        acc = glb.accessors[old_idx]
        clone = pygltflib.Accessor(
            componentType=acc.componentType, count=acc.count, type=acc.type,
            normalized=acc.normalized, min=acc.min, max=acc.max, name=acc.name,
        )
        if acc.bufferView is not None:
            old_target = glb.bufferViews[acc.bufferView].target
            clone.bufferView = _append_view(_accessor_bytes(glb, blob, old_idx), old_target)
            clone.byteOffset = 0
        accessor_remap[old_idx] = len(new_accessors)
        new_accessors.append(clone)

    image_remap: dict[int, int] = {}
    new_images = []
    for old_idx in sorted(used_images):
        img = glb.images[old_idx]
        clone = pygltflib.Image(mimeType=img.mimeType, name=img.name)
        if img.bufferView is not None:
            bv = glb.bufferViews[img.bufferView]
            start = bv.byteOffset or 0
            clone.bufferView = _append_view(bytes(blob[start:start + bv.byteLength]))
        elif img.uri:
            clone.uri = img.uri
        image_remap[old_idx] = len(new_images)
        new_images.append(clone)

    sampler_remap = {old: new for new, old in enumerate(sorted(used_samplers))}
    new_samplers = [glb.samplers[i] for i in sorted(used_samplers)]

    texture_remap: dict[int, int] = {}
    new_textures = []
    for old_idx in sorted(used_textures):
        tex = glb.textures[old_idx]
        clone = pygltflib.Texture(
            source=image_remap.get(tex.source) if tex.source is not None else None,
            sampler=sampler_remap.get(tex.sampler) if tex.sampler is not None else None,
            name=tex.name,
        )
        texture_remap[old_idx] = len(new_textures)
        new_textures.append(clone)

    material_remap: dict[int, int] = {}
    new_materials = []
    for old_idx in sorted(used_materials):
        mat = glb.materials[old_idx]
        for slot in _material_texture_slots(mat):
            slot.index = texture_remap[slot.index]
        material_remap[old_idx] = len(new_materials)
        new_materials.append(mat)

    mesh_remap: dict[int, int] = {}
    new_meshes = []
    for old_idx in sorted(keep_meshes):
        mesh = glb.meshes[old_idx]
        for prim in mesh.primitives:
            for name, value in _prim_attribute_indices(prim).items():
                setattr(prim.attributes, name, accessor_remap[value])
            if prim.indices is not None:
                prim.indices = accessor_remap[prim.indices]
            if prim.material is not None:
                prim.material = material_remap[prim.material]
            for target in (prim.targets or []):
                for name, value in list(vars(target).items()):
                    if isinstance(value, int):
                        setattr(target, name, accessor_remap[value])
        mesh_remap[old_idx] = len(new_meshes)
        new_meshes.append(mesh)

    skin_remap: dict[int, int] = {}
    new_skins = []
    for old_idx in sorted(keep_skins):
        skin = glb.skins[old_idx]
        if skin.inverseBindMatrices is not None:
            skin.inverseBindMatrices = accessor_remap[skin.inverseBindMatrices]
        skin_remap[old_idx] = len(new_skins)
        new_skins.append(skin)

    # ── nodes: drop mesh/skin refs to removed resources, remap the kept ones,
    #    canonicalize joint names. Node indices are untouched (joint hierarchy,
    #    scene lists and skin.joints stay valid). ──
    joint_nodes = set()
    for skin in new_skins:
        joint_nodes.update(skin.joints or [])
    for ni, node in enumerate(glb.nodes):
        if node.mesh is not None:
            node.mesh = mesh_remap.get(node.mesh)
            if node.mesh is None:
                node.skin = None
        if node.skin is not None:
            node.skin = skin_remap.get(node.skin)
        if ni in joint_nodes:
            canonical = canonicalize_bone_name(node.name)
            if canonical:
                node.name = canonical

    glb.meshes = new_meshes
    glb.skins = new_skins
    glb.materials = new_materials
    glb.textures = new_textures
    glb.images = new_images
    glb.samplers = new_samplers
    glb.accessors = new_accessors
    glb.bufferViews = new_views
    glb.animations = []

    glb.set_binary_blob(bytes(new_blob))
    if not glb.buffers:
        glb.buffers.append(pygltflib.Buffer())
    glb.buffers = [glb.buffers[0]]
    glb.buffers[0].byteLength = len(new_blob)
    glb.buffers[0].uri = None
    out = glb.save_to_bytes()
    return b"".join(out) if isinstance(out, (list, tuple)) else out


# ────────────────────────────────────────────────────────────────────────────
# Skin statistics, coverage, occlusion
# ────────────────────────────────────────────────────────────────────────────

def skin_stats(glb_bytes: bytes) -> dict:
    """Weight mass per canonical bone across every skinned primitive, plus the
    bind coverage the runtime will measure: the share of total skin weight
    carried by joints that canonicalize into CANONICAL_BONES."""
    glb = pygltflib.GLTF2.load_from_bytes(glb_bytes)
    blob = glb.binary_blob() or b""

    bone_mass: dict[str, float] = {}
    unresolved_mass = 0.0
    total_mass = 0.0
    triangles = 0

    for mesh in glb.meshes:
        for prim in mesh.primitives:
            attrs = _prim_attribute_indices(prim)
            if "POSITION" in attrs:
                if prim.indices is not None:
                    triangles += glb.accessors[prim.indices].count // 3
                else:
                    triangles += glb.accessors[attrs["POSITION"]].count // 3
            if "JOINTS_0" not in attrs or "WEIGHTS_0" not in attrs:
                continue

            node_skin = None
            for node in glb.nodes:
                if node.mesh is not None and glb.meshes[node.mesh] is mesh and node.skin is not None:
                    node_skin = glb.skins[node.skin]
                    break
            if node_skin is None:
                continue
            joint_names = [glb.nodes[j].name or "" for j in node_skin.joints]
            canonical = [canonicalize_bone_name(n) for n in joint_names]

            joints = _accessor_array(glb, blob, attrs["JOINTS_0"]).astype(np.int64)
            weights = _accessor_array(glb, blob, attrs["WEIGHTS_0"]).astype(np.float64)
            acc = glb.accessors[attrs["WEIGHTS_0"]]
            if acc.componentType == 5121:
                weights /= 255.0
            elif acc.componentType == 5123:
                weights /= 65535.0

            flat_j = joints.reshape(-1)
            flat_w = weights.reshape(-1)
            positive = flat_w > 0
            per_joint = np.bincount(flat_j[positive], weights=flat_w[positive],
                                    minlength=len(joint_names))
            for ji, mass in enumerate(per_joint):
                if mass <= 0:
                    continue
                total_mass += float(mass)
                name = canonical[ji] if ji < len(canonical) else None
                if name:
                    bone_mass[name] = bone_mass.get(name, 0.0) + float(mass)
                else:
                    unresolved_mass += float(mass)

    coverage = (total_mass - unresolved_mass) / total_mass if total_mass > 0 else 0.0
    return {
        "coverage": coverage,
        "total_mass": total_mass,
        "bone_mass": bone_mass,
        "unresolved_mass": unresolved_mass,
        "triangle_count": triangles,
    }


def derive_occludes(bone_mass: dict[str, float], total_mass: float,
                    min_share: float = OCCLUDES_MIN_SHARE,
                    slot: str | None = None) -> list[str]:
    """Body regions this garment hides, in BODY_REGIONS order. Two gates:
    evidence (the region's bones carry ≥ min_share of the garment's skin
    weight — weight is a proxy for where the cloth actually sits) and
    plausibility (the region is in SLOT_OCCLUDABLE for the slot — a shirt
    whose waistband grazes the hip bones must not amputate the legs)."""
    if total_mass <= 0:
        return []
    region_mass: dict[str, float] = {}
    for bone, mass in bone_mass.items():
        region = region_of_bone(bone)
        if region:
            region_mass[region] = region_mass.get(region, 0.0) + mass
    allowed = set(SLOT_OCCLUDABLE.get(slot, BODY_REGIONS)) if slot else set(BODY_REGIONS)
    return [r for r in BODY_REGIONS
            if r in allowed and region_mass.get(r, 0.0) / total_mass >= min_share]


def weighted_bones(bone_mass: dict[str, float], total_mass: float,
                   min_share: float = RIG_BONES_MIN_SHARE) -> list[str]:
    """Canonical bones carrying a real share of skin weight, in canonical order
   : the manifest's rig.bones list."""
    if total_mass <= 0:
        return []
    return [b for b in CANONICAL_BONES if bone_mass.get(b, 0.0) / total_mass >= min_share]


# ────────────────────────────────────────────────────────────────────────────
# Manifest
# ────────────────────────────────────────────────────────────────────────────

def slugify(text: str, max_words: int = 5) -> str:
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    return "-".join(words[:max_words]) or "garment"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def validate_manifest(manifest: dict, glb_bytes: bytes) -> dict:
    """Enforce all 6 validation rules from specs/GARMENT_MANIFEST.md.
    Returns {ok, failures, coverage}; a garment failing any rule must not be
    published."""
    failures: list[str] = []

    if manifest.get("spec") != SPEC_URI:
        failures.append(f"rule 1: spec is not {SPEC_URI}")
    if manifest.get("slot") not in GARMENT_SLOTS:
        failures.append(f"rule 2: slot {manifest.get('slot')!r} not in {GARMENT_SLOTS}")
    bad_regions = [r for r in manifest.get("occludes", []) if r not in BODY_REGIONS]
    if bad_regions:
        failures.append(f"rule 3: unknown occludes regions {bad_regions}")
    declared = (manifest.get("model") or {}).get("sha256")
    if declared != sha256_hex(glb_bytes):
        failures.append("rule 4: model.sha256 does not match the GLB bytes")

    coverage = 0.0
    try:
        stats = skin_stats(glb_bytes)
        coverage = stats["coverage"]
        if stats["total_mass"] <= 0:
            failures.append("rule 5: GLB has no skinned mesh")
        elif coverage < MIN_BIND_COVERAGE:
            failures.append(
                f"rule 5: bind coverage {coverage:.3f} below MIN_BIND_COVERAGE {MIN_BIND_COVERAGE}")
    except Exception as exc:  # noqa: BLE001: a GLB that fails to parse fails rule 5
        failures.append(f"rule 5: GLB does not load ({exc})")

    if manifest.get("license") not in COMMERCIAL_SPDX:
        failures.append(
            f"rule 6: license {manifest.get('license')!r} is not a recognised "
            "commercial-use SPDX identifier")

    return {"ok": not failures, "failures": failures, "coverage": coverage}


def build_manifest(*, garment_id: str, name: str, slot: str, version: int,
                   model_uri: str, glb_bytes: bytes, triangle_count: int,
                   bones: list[str], occludes: list[str], prompt: str,
                   mesh_model: str, thumb_uri: str) -> dict:
    return {
        "spec": SPEC_URI,
        "id": garment_id,
        "name": name,
        "slot": slot,
        "version": version,
        "model": {
            "uri": model_uri,
            "format": "gltf-binary",
            "sha256": sha256_hex(glb_bytes),
            "sizeBytes": len(glb_bytes),
            "triangleCount": triangle_count,
        },
        "rig": {
            "skeleton": "three.ws-canonical-v1",
            "bindPose": "a-pose",
            "bones": bones,
        },
        "occludes": occludes,
        "materials": {"tintable": False, "palette": "garment"},
        "license": "CC0-1.0",
        "source": {
            "kind": "generated",
            "prompt": prompt,
            "model": mesh_model,
            "pipeline": "garment-forge@1",
        },
        "preview": {"thumbnail": thumb_uri},
    }
