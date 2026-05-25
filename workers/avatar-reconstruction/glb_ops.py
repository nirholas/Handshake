"""
GLB texture extraction and in-place replacement using pygltflib.

Strategy: images embedded in the binary blob are extracted cleanly; when
replacing we write new JPEG bytes back into the blob and patch every
affected bufferView byte-offset so the file stays structurally valid.
"""

from __future__ import annotations

import base64
import io
import struct
from typing import Optional

import numpy as np
from PIL import Image
import pygltflib


# ── helpers ───────────────────────────────────────────────────────────────────

def load_glb(data: bytes) -> pygltflib.GLTF2:
    return pygltflib.GLTF2().load_from_bytes(data)


def save_glb(glb: pygltflib.GLTF2) -> bytes:
    return bytes(glb.save_to_bytes())


def _extract_image_bytes(glb: pygltflib.GLTF2, image_idx: int) -> bytes:
    img_obj = glb.images[image_idx]
    if img_obj.uri and img_obj.uri.startswith("data:"):
        _, b64 = img_obj.uri.split(",", 1)
        return base64.b64decode(b64)
    if img_obj.bufferView is not None:
        bv = glb.bufferViews[img_obj.bufferView]
        blob = glb.binary_blob()
        return bytes(blob[bv.byteOffset : bv.byteOffset + bv.byteLength])
    raise ValueError(f"cannot extract image {image_idx}: no uri and no bufferView")


def _replace_image_bytes_in_blob(
    glb: pygltflib.GLTF2, image_idx: int, new_bytes: bytes
) -> None:
    """
    Patch the binary blob in-place: replace the old image bytes with new ones,
    then fix all bufferView byte-offsets that sit after the patched region.
    Pads to 4-byte alignment as required by the glTF spec.
    """
    img_obj = glb.images[image_idx]

    if img_obj.bufferView is None:
        # Image was a data URI — convert to embedded.
        # Append to end of binary blob instead.
        old_blob = bytearray(glb.binary_blob() or b"")
        offset = len(old_blob)
        padded = bytearray(new_bytes)
        while len(padded) % 4:
            padded.append(0)
        old_blob.extend(padded)
        glb.set_binary_blob(bytes(old_blob))

        # Create a new bufferView for this image.
        bv = pygltflib.BufferView(
            buffer=0,
            byteOffset=offset,
            byteLength=len(new_bytes),
            target=None,
        )
        bv_idx = len(glb.bufferViews)
        glb.bufferViews.append(bv)
        img_obj.bufferView = bv_idx
        img_obj.uri = None
        if glb.buffers:
            glb.buffers[0].byteLength = len(old_blob)
        return

    bv_idx = img_obj.bufferView
    bv = glb.bufferViews[bv_idx]
    old_blob = bytearray(glb.binary_blob())
    offset = bv.byteOffset
    old_len = bv.byteLength

    # Compute padded lengths (4-byte alignment).
    old_padded = (old_len + 3) & ~3
    new_padded = (len(new_bytes) + 3) & ~3
    delta = new_padded - old_padded

    # Build new blob.
    padding = bytes(new_padded - len(new_bytes))
    new_blob = (
        bytes(old_blob[:offset])
        + new_bytes
        + padding
        + bytes(old_blob[offset + old_padded :])
    )
    glb.set_binary_blob(new_blob)

    # Update this bufferView.
    bv.byteLength = len(new_bytes)

    # Shift all bufferViews that start after the patched region.
    for other in glb.bufferViews:
        if other.byteOffset > offset:
            other.byteOffset += delta

    # Update buffer total length.
    if glb.buffers:
        glb.buffers[bv.buffer].byteLength += delta


# ── public API ────────────────────────────────────────────────────────────────

def find_material_image_idx(glb: pygltflib.GLTF2, material_name: str) -> Optional[int]:
    """Return the base-colour texture image index for a named material, or None."""
    mat = next((m for m in glb.materials if m.name == material_name), None)
    if mat is None:
        return None
    pbr = mat.pbrMetallicRoughness
    if pbr is None or pbr.baseColorTexture is None:
        return None
    tex = glb.textures[pbr.baseColorTexture.index]
    return tex.source


def get_material_texture(glb: pygltflib.GLTF2, material_name: str) -> Optional[Image.Image]:
    """Return the base-colour texture of a material as a PIL RGBA Image."""
    idx = find_material_image_idx(glb, material_name)
    if idx is None:
        return None
    data = _extract_image_bytes(glb, idx)
    return Image.open(io.BytesIO(data)).convert("RGBA")


def set_material_texture(
    glb: pygltflib.GLTF2,
    material_name: str,
    new_image: Image.Image,
    quality: int = 92,
) -> bool:
    """
    Replace the base-colour texture of a named material.
    Returns True on success, False if the material was not found.
    """
    idx = find_material_image_idx(glb, material_name)
    if idx is None:
        return False
    buf = io.BytesIO()
    new_image.convert("RGB").save(buf, format="JPEG", quality=quality)
    _replace_image_bytes_in_blob(glb, idx, buf.getvalue())
    return True


def get_material_base_color(glb: pygltflib.GLTF2, material_name: str) -> Optional[list]:
    """Return the baseColorFactor [r,g,b,a] of a named material, or None."""
    mat = next((m for m in glb.materials if m.name == material_name), None)
    if mat is None:
        return None
    pbr = mat.pbrMetallicRoughness
    if pbr is None:
        return None
    return pbr.baseColorFactor


def set_material_base_color(
    glb: pygltflib.GLTF2, material_name: str, rgba: list[float]
) -> bool:
    """Set the baseColorFactor of a named material. rgba values in [0,1]."""
    mat = next((m for m in glb.materials if m.name == material_name), None)
    if mat is None:
        return False
    if mat.pbrMetallicRoughness is None:
        mat.pbrMetallicRoughness = pygltflib.PbrMetallicRoughness()
    mat.pbrMetallicRoughness.baseColorFactor = list(rgba)
    return True


def get_head_mesh_data(glb: pygltflib.GLTF2) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Return (positions, uvs, face_indices) for the Wolf3D_Head mesh.
    positions: (N, 3) float32
    uvs:       (N, 2) float32  — TEXCOORD_0
    faces:     (F, 3) int32
    """
    mesh = next((m for m in glb.meshes if m.name == "Wolf3D_Head"), None)
    if mesh is None:
        raise ValueError("Wolf3D_Head mesh not found in GLB")

    prim = mesh.primitives[0]
    blob = glb.binary_blob()

    def read_accessor(acc_idx: int) -> np.ndarray:
        acc = glb.accessors[acc_idx]
        bv = glb.bufferViews[acc.bufferView]
        start = bv.byteOffset + (acc.byteOffset or 0)
        type_map = {
            "SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4,
            "MAT2": 4, "MAT3": 9, "MAT4": 16,
        }
        n_components = type_map[acc.type]
        component_map = {
            5120: np.int8, 5121: np.uint8, 5122: np.int16,
            5123: np.uint16, 5125: np.uint32, 5126: np.float32,
        }
        dtype = component_map[acc.componentType]
        n_items = acc.count * n_components
        data = np.frombuffer(blob[start : start + n_items * np.dtype(dtype).itemsize], dtype=dtype)
        return data.reshape(acc.count, n_components) if n_components > 1 else data

    positions = read_accessor(prim.attributes.POSITION).astype(np.float32)
    uvs = read_accessor(prim.attributes.TEXCOORD_0).astype(np.float32)
    indices_raw = read_accessor(prim.indices)
    faces = indices_raw.reshape(-1, 3).astype(np.int32)

    return positions, uvs, faces
