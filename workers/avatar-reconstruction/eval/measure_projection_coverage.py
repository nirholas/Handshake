"""
Measure how much of the head's skin atlas actually carries photographic colour,
before and after projective texturing.

This is the number the whole Track 2 exercise is judged on. The face-oval warp
covers 10.4% of the head's texels; the claim for projection is that it reaches a
large share of the remaining ~90% (ears, jawline, neck, forehead to the
hairline) from the same single photo. A claim like that is worth nothing
unless it is measured on the real template mesh with a real face, so this script
does exactly that and prints the split.

Usage:
    python3 -m eval.measure_projection_coverage [image.png ...]

With no arguments it sweeps the reference face set in eval/refs/. Requires the
worker's runtime deps (cv2, mediapipe, pygltflib) and the template GLBs.
"""

import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import face_geometry as fg  # noqa: E402
import face_pipeline as fp  # noqa: E402
import face_projection as fpr  # noqa: E402
import glb_ops  # noqa: E402


def measure(image_path: str) -> dict | None:
    """Run the texture stages for one photo and report UV coverage."""
    img = Image.open(image_path).convert("RGB")
    landmarks = fp._get_landmarks(img)
    if landmarks is None:
        landmarks = fp._get_landmarks_small_face(img)
    if landmarks is None:
        return None

    img_w, img_h = img.size
    fg_img = fp._remove_background(img)
    uv_map = fp._get_uv_map()

    _, face_mask_uv = fp._warp_face_to_uv(fg_img, landmarks, uv_map)

    glb = glb_ops.load_glb(fp._load_template("neutral"))
    positions, uvs, faces = glb_ops.get_head_mesh_data(glb)
    normals = glb_ops.recompute_vertex_normals(positions, faces)

    tex = glb_ops.get_material_texture(glb, "Wolf3D_Skin")
    tex_w, tex_h = tex.size

    lm_idx = np.asarray(uv_map["landmark_vtx"], dtype=np.int64)
    detected = fg.landmarks_to_array(landmarks, img_w, img_h)

    fg_alpha = np.array(fg_img.convert("RGBA"), dtype=np.uint8)[:, :, 3].astype(np.float32) / 255.0
    out = fpr.project_photo_to_uv(
        photo_rgb=np.array(fg_img.convert("RGB"), dtype=np.uint8),
        foreground_mask=fg_alpha,
        positions=positions,
        normals=normals,
        uvs=uvs,
        faces=faces,
        landmarks_3d=detected,
        vertex_indices=lm_idx,
        tex_w=tex_w,
        tex_h=tex_h,
    )
    if out is None:
        return {"name": os.path.basename(image_path), "pose": False}

    _, weight, covered = out
    # Only texels the head mesh actually uses count as denominator (see
    # project_photo_to_uv), so the figure is not flattered by body-only texels.
    head_texels = int(covered.sum())
    if head_texels == 0:
        return None
    oval = (face_mask_uv > 0.5) & covered
    painted = (weight > 0.01) & covered
    return {
        "name": os.path.basename(image_path),
        "pose": True,
        "head_texels": head_texels,
        "oval": oval.sum() / head_texels,
        "projected": painted.sum() / head_texels,
        "new": (painted & ~oval).sum() / head_texels,
        "mean_weight": float(weight[painted].mean()) if painted.any() else 0.0,
    }


def main(argv: list[str]) -> int:
    paths = argv[1:]
    if not paths:
        refs = os.path.join(os.path.dirname(os.path.abspath(__file__)), "refs")
        if not os.path.isdir(refs):
            print(f"no reference set at {refs}; pass image paths explicitly")
            return 1
        paths = [os.path.join(refs, f) for f in sorted(os.listdir(refs))
                 if f.lower().endswith((".png", ".jpg", ".jpeg"))]

    rows = []
    for p in paths:
        try:
            r = measure(p)
        except Exception as exc:  # noqa: BLE001 — one bad face must not stop the sweep
            print(f"  {os.path.basename(p)}: FAILED ({exc})")
            continue
        if r is None:
            print(f"  {os.path.basename(p)}: no face detected")
            continue
        if not r["pose"]:
            print(f"  {r['name']}: camera pose did not solve")
            continue
        rows.append(r)
        print(
            f"  {r['name'][:42]:42s} oval {r['oval']:6.1%}  "
            f"projected {r['projected']:6.1%}  new {r['new']:6.1%}  "
            f"mean w {r['mean_weight']:.2f}"
        )

    if not rows:
        print("\nno usable measurements")
        return 1

    oval = np.mean([r["oval"] for r in rows])
    proj = np.mean([r["projected"] for r in rows])
    new = np.mean([r["new"] for r in rows])
    print(f"\n{len(rows)} faces")
    print(f"  face-oval warp reaches     : {oval:.1%} of the head atlas")
    print(f"  projection reaches         : {proj:.1%}")
    print(f"  NEW surface from projection: {new:.1%}")
    print(f"  total photographic coverage: {oval + new:.1%} "
          f"(was {oval:.1%}, a {((oval + new) / oval):.1f}x increase)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
