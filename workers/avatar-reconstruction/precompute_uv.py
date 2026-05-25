"""
Pre-computation: canonical MediaPipe face model → Wolf3D_Skin UV coordinates.

Runs ONCE at Docker image build time and writes face_uv_map.json.

Algorithm:
  1. Download MediaPipe canonical face model OBJ (468 vertices in face-space).
  2. Load Wolf3D_Head mesh from the template GLB.
  3. Align both meshes to a common normalised coordinate system (centroid +
     uniform scale so the face fits in a unit cube).
  4. For each of the 468 canonical landmarks, find the nearest Wolf3D vertex
     by Euclidean distance in 3D (KD-tree).
  5. Map that vertex's UV coordinates to pixel coordinates in the skin texture.
  6. Persist the mapping as face_uv_map.json next to this file.

Output JSON schema:
  {
    "texture_width":  <int>,
    "texture_height": <int>,
    "landmarks": [            # 468 entries, one per MediaPipe landmark index
      {"u": <float>, "v": <float>, "px": <float>, "py": <float>},
      ...
    ],
    "face_oval_indices": [<int>, ...],   # subset used for the face-oval mask
    "skin_sample_indices": [<int>, ...]  # landmarks inside the cheek/forehead region
  }
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import requests
from scipy.spatial import cKDTree

# ── paths ──────────────────────────────────────────────────────────────────────

HERE = Path(__file__).parent
TEMPLATE_GLB = HERE / "templates" / "default.glb"
OUTPUT_JSON = HERE / "face_uv_map.json"

CANONICAL_OBJ_URL = (
    "https://raw.githubusercontent.com/google/mediapipe/master"
    "/mediapipe/modules/face_geometry/data/canonical_face_model.obj"
)

# MediaPipe face-oval landmark indices (silhouette of the face in the mesh).
# These 36 indices form the boundary used for the alpha mask.
FACE_OVAL_INDICES = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
    397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
    172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
]

# Landmarks that sample the skin tone (cheeks + forehead, away from eyes/mouth).
SKIN_SAMPLE_INDICES = [
    116, 117, 118, 119, 120, 121, 50,   # left cheek
    345, 346, 347, 348, 349, 350, 280,  # right cheek
    10, 9, 8, 107, 336,                 # forehead
]


# ── canonical OBJ parser ───────────────────────────────────────────────────────

def _load_canonical_obj(url: str) -> np.ndarray:
    """Download and parse the MediaPipe canonical face model OBJ.
    Returns (468, 3) float32 array of vertex positions."""
    print(f"Downloading canonical face model from {url} …")
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    vertices = []
    for line in resp.text.splitlines():
        if line.startswith("v "):
            parts = line.split()
            vertices.append([float(parts[1]), float(parts[2]), float(parts[3])])
    arr = np.array(vertices, dtype=np.float32)
    print(f"  Loaded {len(arr)} canonical vertices")
    return arr


# ── GLB mesh loading ───────────────────────────────────────────────────────────

def _load_wolf3d_head(glb_path: Path) -> tuple[np.ndarray, np.ndarray]:
    """Return (positions (N,3), uvs (N,2)) for Wolf3D_Head from a GLB file."""
    import pygltflib
    from glb_ops import get_head_mesh_data

    data = glb_path.read_bytes()
    glb = pygltflib.GLTF2().load_from_bytes(data)
    positions, uvs, _ = get_head_mesh_data(glb)
    print(f"  Wolf3D_Head: {len(positions)} vertices")
    return positions, uvs


# ── alignment ─────────────────────────────────────────────────────────────────

def _normalise(pts: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Translate to centroid, scale to unit cube. Returns (normalised, centroid, scale)."""
    centroid = pts.mean(axis=0)
    shifted = pts - centroid
    scale = np.abs(shifted).max()
    return shifted / scale, centroid, scale


def _filter_face_vertices(positions: np.ndarray) -> np.ndarray:
    """
    Heuristic: keep only Wolf3D_Head vertices that are on the visible face
    (front hemisphere, above the chin).  The canonical model covers only the
    face, so restricting the KD-tree to face vertices gives better matches.
    """
    # In Wolf3D local space Y is up, face points forward (+Z) and is centred
    # around the origin.  Filter: z > median_z (front half) AND
    # y > 10th-percentile_y (above chin).
    z_thresh = np.median(positions[:, 2])
    y_thresh = np.percentile(positions[:, 1], 10)
    mask = (positions[:, 2] > z_thresh) & (positions[:, 1] > y_thresh)
    return mask


# ── texture dimensions ─────────────────────────────────────────────────────────

def _get_skin_texture_size(glb_path: Path) -> tuple[int, int]:
    """Return (width, height) of the Wolf3D_Skin base-colour texture."""
    import io
    import pygltflib
    from PIL import Image

    data = glb_path.read_bytes()
    glb = pygltflib.GLTF2().load_from_bytes(data)

    mat = next(m for m in glb.materials if m.name == "Wolf3D_Skin")
    tex_idx = mat.pbrMetallicRoughness.baseColorTexture.index
    img_idx = glb.textures[tex_idx].source
    img_obj = glb.images[img_idx]

    bv = glb.bufferViews[img_obj.bufferView]
    blob = glb.binary_blob()
    img_bytes = blob[bv.byteOffset : bv.byteOffset + bv.byteLength]
    img = Image.open(io.BytesIO(img_bytes))
    return img.size  # (width, height)


# ── main ──────────────────────────────────────────────────────────────────────

def precompute(glb_path: Path = TEMPLATE_GLB, out_path: Path = OUTPUT_JSON) -> None:
    print("=== UV pre-computation ===")

    canonical = _load_canonical_obj(CANONICAL_OBJ_URL)       # (468, 3)
    positions, uvs = _load_wolf3d_head(glb_path)              # (N, 3), (N, 2)
    tex_w, tex_h = _get_skin_texture_size(glb_path)
    print(f"  Skin texture: {tex_w}×{tex_h}")

    # Normalise both meshes to unit-cube face space.
    canon_norm, _, _ = _normalise(canonical)

    face_mask = _filter_face_vertices(positions)
    face_positions = positions[face_mask]
    face_uvs = uvs[face_mask]
    face_norm, _, _ = _normalise(face_positions)

    # KD-tree on normalised Wolf3D face vertices.
    tree = cKDTree(face_norm)

    # Query: for each of the 468 canonical landmarks, find nearest Wolf3D vertex.
    distances, nn_indices = tree.query(canon_norm, k=1)

    print(f"  Mean NN distance: {distances.mean():.4f}  Max: {distances.max():.4f}")

    # Convert UV coords → pixel coords.
    # glTF UV convention: (0,0) = top-left, (1,1) = bottom-right.
    landmarks = []
    for i, nn_idx in enumerate(nn_indices):
        u, v = float(face_uvs[nn_idx, 0]), float(face_uvs[nn_idx, 1])
        px = u * tex_w
        py = v * tex_h
        landmarks.append({"u": u, "v": v, "px": px, "py": py})

    result = {
        "texture_width": tex_w,
        "texture_height": tex_h,
        "landmarks": landmarks,
        "face_oval_indices": FACE_OVAL_INDICES,
        "skin_sample_indices": SKIN_SAMPLE_INDICES,
    }

    out_path.write_text(json.dumps(result, indent=2))
    print(f"  Written → {out_path}")
    print("=== done ===")


if __name__ == "__main__":
    glb = Path(sys.argv[1]) if len(sys.argv) > 1 else TEMPLATE_GLB
    precompute(glb_path=glb)
