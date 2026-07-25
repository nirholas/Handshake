"""
Identity Shape Error (ISE) — does the reconstructed avatar's face actually have
*this person's* shape?

The texture-transfer pipeline paints a selfie onto a template head, so a purely
visual check flatters it: the render looks like the person from the front while
the underlying skull is still the template's. ISE ignores texture entirely and
measures geometry, which is the quantity the Phase-2 morph moves.

Method
------
1. MediaPipe gives 468 landmarks for the selfie: the person's face shape, in
   image space with unknown pose and scale.
2. `face_uv_map.json` gives, for each of those 468 landmarks, the head vertex it
   corresponds to. Reading those vertices out of a GLB yields the *avatar's*
   version of the same 468 points.
3. Both point sets are Umeyama-aligned onto MediaPipe's neutral canonical face
   using only the stable identity landmarks (face oval, nose, cheeks, brow, jaw
   — no eyes or lips, so a smile or a blink cannot register as identity).
   Alignment removes pose and scale; what remains is shape.
4. ISE = mean euclidean distance between the two aligned sets over the stable
   subset, divided by canonical interocular distance.

Dimensionless, so it compares across faces, image sizes and body types. Lower is
better. Because step 3 quotients out similarity transforms, a pipeline cannot
score well by making the head bigger or tilting it — only by matching shape.

Reference points for reading a score:
  • the *template floor* — the same measurement against the unmorphed template
    head — is what a texture-only pipeline scores. It is the number to beat.
  • `improvement` is the fraction of that floor the morph closes. The Phase-2
    morph applies `strength` (default 0.75) toward the person's shape, so the
    theoretical ceiling for the current implementation is ~0.75.

Usage
-----
    python -m eval.identity_eval --selfie a.jpg --glb out.glb
    python -m eval.identity_eval --selfie a.jpg --glb out.glb --json

Runs on the worker's existing dependencies (mediapipe, pygltflib, numpy) — no
GPU and no render, so it is cheap enough to gate every pipeline change.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import face_geometry  # noqa: E402
import glb_ops  # noqa: E402

# `face_pipeline` drags in mediapipe, cv2 and rembg. Scoring is pure geometry and
# needs none of that, so the detector is imported only when a selfie is actually
# read — the metric stays runnable (and testable) outside the GPU image.

# MediaPipe outer eye corners — the interocular span that normalises the score.
_EYE_L, _EYE_R = 33, 263

# Landmark groups, so a score can say *where* the shape is wrong. These are the
# same anatomical bands `face_geometry._STABLE_IDENTITY_INDICES` is built from;
# a region-level breakdown is what tells us whether the next fidelity push
# belongs in the nose, the jaw or the silhouette.
_REGIONS = {
    "oval": [
        10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
        397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
        172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
    ],
    "nose": [6, 197, 195, 5, 4, 1, 19, 94, 2, 98, 327, 129, 358],
    "cheeks": [50, 280, 116, 345, 117, 346, 118, 347, 205, 425],
    "brow": [107, 336, 66, 296, 105, 334, 63, 293],
    "jaw": [32, 262, 211, 431, 170, 395, 208, 428],
}


class EvalError(RuntimeError):
    """Raised when a sample cannot be scored (no face, no geometry map, …)."""


def _align_to_canonical(points: np.ndarray, canonical: np.ndarray, stable: np.ndarray) -> np.ndarray:
    """Similarity-align `points` onto the canonical face using the stable subset."""
    s, R, t = face_geometry.umeyama(points[stable], canonical[stable])
    return (s * (R @ points.T)).T + t


def selfie_landmarks(image_path: Path) -> np.ndarray:
    """Detect the 468 face landmarks for a selfie, as an (N,3) array."""
    import face_pipeline

    img = Image.open(image_path).convert("RGB")
    landmarks = face_pipeline._get_landmarks(img)
    if landmarks is None:
        landmarks = face_pipeline._get_landmarks_small_face(img)
    if landmarks is None:
        raise EvalError(f"no face detected in {image_path.name}")
    # Pixel dimensions matter: without them the landmark frame carries the photo's
    # aspect ratio as if it were face shape. See landmarks_to_array.
    return face_geometry.landmarks_to_array(landmarks, *img.size)


def head_landmark_points(glb_path: Path, face_map: face_geometry.FaceMap) -> np.ndarray:
    """Read the avatar's own version of the 468 landmark points out of a GLB."""
    glb = glb_ops.load_glb(glb_path.read_bytes())
    positions, _, _ = glb_ops.get_head_mesh_data(glb)
    idx = face_map.landmark_vtx
    if idx.max() >= positions.shape[0]:
        raise EvalError(
            f"{glb_path.name}: landmark map indexes vertex {int(idx.max())} but the head "
            f"has only {positions.shape[0]} — the GLB is not the template this map was built for"
        )
    return positions[idx].astype(np.float64)


def score(
    selfie_pts: np.ndarray,
    head_pts: np.ndarray,
    face_map: face_geometry.FaceMap,
) -> dict:
    """
    Compute ISE between a person's landmarks and an avatar head's landmark
    vertices. Both are aligned onto the canonical face first, so the result
    depends on shape alone.
    """
    canon = face_map.canonical_norm
    stable = face_map.stable_indices
    n = canon.shape[0]

    person = _align_to_canonical(np.asarray(selfie_pts, dtype=np.float64)[:n], canon, stable)
    avatar = _align_to_canonical(np.asarray(head_pts, dtype=np.float64)[:n], canon, stable)

    # Normalise by the canonical interocular span so the score is dimensionless
    # and comparable across faces.
    interocular = float(np.linalg.norm(canon[_EYE_L] - canon[_EYE_R]))
    if interocular <= 0:
        raise EvalError("canonical face has degenerate interocular distance")

    per_point = np.linalg.norm(person - avatar, axis=1) / interocular

    regions = {}
    for name, indices in _REGIONS.items():
        sel = [i for i in indices if i < n]
        if sel:
            regions[name] = float(per_point[sel].mean())

    return {
        "ise": float(per_point[stable].mean()),
        "ise_max": float(per_point[stable].max()),
        "regions": regions,
    }


def evaluate(selfie: Path, glb: Path, template: Path | None = None) -> dict:
    """
    Score one reconstruction, and (when a template is given) the texture-only
    floor it has to beat.
    """
    face_map = face_geometry.FaceMap.load()
    if face_map is None:
        raise EvalError(
            "face_uv_map.json has no geometry fields — rebuild it with precompute_uv.py "
            "(this is also the condition that silently disables the Phase-2 morph)"
        )

    selfie_pts = selfie_landmarks(selfie)
    result = {
        "selfie": selfie.name,
        "glb": glb.name,
        **score(selfie_pts, head_landmark_points(glb, face_map), face_map),
    }

    if template is not None:
        floor = score(selfie_pts, head_landmark_points(template, face_map), face_map)
        result["template_floor"] = floor["ise"]
        result["improvement"] = (
            (floor["ise"] - result["ise"]) / floor["ise"] if floor["ise"] > 0 else 0.0
        )

    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--selfie", type=Path, required=True, help="source photo")
    ap.add_argument("--glb", type=Path, required=True, help="reconstructed avatar GLB")
    ap.add_argument(
        "--template",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "templates" / "default.glb",
        help="unmorphed template GLB — the texture-only floor to beat",
    )
    ap.add_argument("--json", action="store_true", help="emit JSON only")
    args = ap.parse_args()

    template = args.template if args.template and args.template.exists() else None
    try:
        result = evaluate(args.selfie, args.glb, template)
    except EvalError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    print(f"{result['selfie']} → {result['glb']}")
    print(f"  ISE            {result['ise']:.4f}   (lower is better)")
    print(f"  worst point    {result['ise_max']:.4f}")
    if "template_floor" in result:
        print(f"  template floor {result['template_floor']:.4f}")
        print(f"  improvement    {result['improvement'] * 100:+.1f}%")
    print("  by region:")
    for name, value in sorted(result["regions"].items(), key=lambda kv: -kv[1]):
        print(f"    {name:8s} {value:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
