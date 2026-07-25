"""
Tune the identity morph's parameters against ISE, across the whole reference set.

`morph_head_to_landmarks` has three knobs — `strength`, `max_displacement_frac`
and `falloff` — whose shipped defaults were chosen before there was any way to
score the result. This sweeps them over every reference face and reports the
setting with the best mean ISE.

It runs **offline**: landmarks are detected once per face, then each parameter
combination is applied to the template head in-process. No worker, no GPU, no
GLB round-trip, so a full grid over 40 faces is a couple of minutes rather than
a day of job submissions.

Two cautions the output enforces:

- **Tuning on one face is overfitting.** The mean is reported alongside the
  worst face, and a setting that improves the mean while wrecking an individual
  face is not an improvement. `--detail` lists the per-face spread.
- **ISE cannot see `falloff`.** The metric samples the head at the landmark
  correspondence vertices, which are exactly the morph's control points, where
  the off-face mask is 1 by construction. `falloff` governs how the displacement
  decays *away* from the face — scalp, ears, neck — so it is invisible here and
  must be guarded by the back-of-head assertion in `test_face_geometry.py`.
  This tool deliberately does not sweep it.

Usage
-----
    python -m eval.tune_morph --photos eval/refs
    python -m eval.tune_morph --photos eval/refs --detail
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import face_geometry as fg  # noqa: E402
import glb_ops  # noqa: E402
from eval.identity_eval import EvalError, score, selfie_landmarks  # noqa: E402

PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
STRENGTHS = (0.5, 0.6, 0.7, 0.75, 0.85, 1.0)
CLAMPS = (0.18, 0.25, 0.35, 0.45, 0.55, 0.65, 0.8, 1.0)


def load_template(path: Path) -> np.ndarray:
    glb = glb_ops.load_glb(path.read_bytes())
    positions, _, _ = glb_ops.get_head_mesh_data(glb)
    return positions.astype(np.float64)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--photos", type=Path, default=Path("eval/refs"))
    ap.add_argument("--template", type=Path, default=Path("templates/default.glb"))
    ap.add_argument("--detail", action="store_true", help="per-face spread for the winner")
    ap.add_argument("--out", type=Path, help="write the full grid as JSON")
    args = ap.parse_args()

    face_map = fg.FaceMap.load()
    if face_map is None:
        print("error: face_uv_map.json has no geometry fields", file=sys.stderr)
        return 1

    base = load_template(args.template)
    photos = sorted(p for p in args.photos.iterdir() if p.suffix.lower() in PHOTO_SUFFIXES)
    if not photos:
        print(f"error: no photos in {args.photos}", file=sys.stderr)
        return 1

    print(f"detecting landmarks for {len(photos)} faces …")
    detected: dict[str, np.ndarray] = {}
    for photo in photos:
        try:
            detected[photo.name] = selfie_landmarks(photo)
        except EvalError as exc:
            print(f"  skip {photo.name}: {exc}")
    if not detected:
        print("error: no face detected in any reference photo", file=sys.stderr)
        return 1

    floors = {
        name: score(pts, base[face_map.landmark_vtx], face_map)["ise"]
        for name, pts in detected.items()
    }
    floor_mean = statistics.fmean(floors.values())
    print(f"{len(detected)} faces | template floor (texture-only) ISE {floor_mean:.4f}\n")

    grid = []
    header = "        " + "".join(f"{c:>8}" for c in CLAMPS)
    print("clamp →" + header[7:])
    for strength in STRENGTHS:
        row = []
        for clamp in CLAMPS:
            scores = [
                score(
                    pts,
                    fg.morph_head_to_landmarks(
                        base, face_map, pts, strength=strength, max_displacement_frac=clamp
                    )[face_map.landmark_vtx],
                    face_map,
                )["ise"]
                for pts in detected.values()
            ]
            entry = {
                "strength": strength,
                "clamp": clamp,
                "mean": statistics.fmean(scores),
                "worst": max(scores),
                "per_face": dict(zip(detected, scores)),
            }
            grid.append(entry)
            row.append(entry["mean"])
        print(f"s={strength:<5}" + "".join(f"{v:>8.4f}" for v in row))

    best = min(grid, key=lambda e: e["mean"])
    shipped = next(
        (e for e in grid if e["strength"] == 0.75 and e["clamp"] == 0.18), None
    )

    print(f"\nbest: strength={best['strength']} clamp={best['clamp']}")
    print(f"  mean ISE  {best['mean']:.4f}   ({(1 - best['mean'] / floor_mean) * 100:.1f}% below the template floor)")
    print(f"  worst face {best['worst']:.4f}")
    if shipped:
        delta = (1 - best["mean"] / shipped["mean"]) * 100
        print(f"  shipped default (0.75 / 0.18) mean ISE {shipped['mean']:.4f} → {delta:+.1f}%")
        regressed = [
            name
            for name, value in best["per_face"].items()
            if value > shipped["per_face"][name] * 1.02
        ]
        print(f"  faces made worse than the shipped default: {len(regressed)}")
        if regressed and args.detail:
            for name in regressed:
                print(f"    {name:45s} {shipped['per_face'][name]:.4f} → {best['per_face'][name]:.4f}")

    if args.detail:
        print("\nper-face at the winning setting (worst first):")
        for name, value in sorted(best["per_face"].items(), key=lambda kv: -kv[1]):
            print(f"  {name:45s} {value:.4f}  (floor {floors[name]:.4f})")

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps({"floor_mean": floor_mean, "grid": grid}, indent=2))
        print(f"\ngrid → {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
