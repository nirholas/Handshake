"""
Identity Stability — does a *worse photo of the same person* still give the same head?

ISE answers "is this the right face shape?" on clean portraits. It cannot answer
"what happens when the photo is bad", because the reference set has no bad
photos. That blind spot is not academic: `max_displacement_frac` exists purely
to reject landmark failures, so a benchmark without landmark failures will always
push it toward no clamping at all. Fidelity measured alone recommends a setting
that fidelity alone cannot see the cost of.

This closes that loop. Each reference face is degraded in ways real selfies
actually are — camera shake, a turned head, a hand or hair across the face, a dim
room, a low-resolution upload — and the question asked is not "is the shape
right" but **"is it the same shape we got from the clean photo?"**

    stability = mean vertex divergence between the avatar built from the clean
                photo and the avatar built from the degraded one, in the same
                interocular-normalised units as ISE. Lower is better.

The person did not change, so every bit of divergence is the pipeline reacting to
photo quality instead of to identity. Two failure modes it catches that ISE
cannot:

- a clamp so loose that a mis-detected landmark reshapes the skull, and
- a pipeline that silently produces a different person on a slightly worse photo,
  which users experience as "it doesn't look like me any more" on a retry.

Run it against `tune_morph`'s output to get the real tradeoff: fidelity wants a
loose clamp, stability wants a tight one, and the shipped value should be the
knee of that curve rather than either extreme.

Usage
-----
    python -m eval.robustness --photos eval/refs
    python -m eval.robustness --photos eval/refs --limit 10 --detail
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import face_geometry as fg  # noqa: E402
import glb_ops  # noqa: E402
from eval.identity_eval import EvalError  # noqa: E402

PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
CLAMPS = (0.18, 0.25, 0.35, 0.45, 0.55, 0.65, 0.8, 1.0)
_EYE_L, _EYE_R = 33, 263


# ── degradations ─────────────────────────────────────────────────────────────
# Each is a plausible real-world selfie defect, applied deterministically so a
# rerun scores the identical images.

def blurred(img: Image.Image) -> Image.Image:
    """Camera shake / missed focus."""
    return img.filter(ImageFilter.GaussianBlur(radius=max(img.width, img.height) / 220))


def turned(img: Image.Image) -> Image.Image:
    """Head not square to the camera — the most common real-world deviation."""
    return img.rotate(12, resample=Image.BICUBIC, expand=False, fillcolor=(128, 128, 128))


def occluded(img: Image.Image) -> Image.Image:
    """Hair, a hand or a mask across part of the face."""
    out = img.copy()
    w, h = out.size
    draw = ImageDraw.Draw(out)
    draw.rectangle([int(w * 0.55), int(h * 0.42), int(w * 0.95), int(h * 0.68)], fill=(60, 55, 52))
    return out


def dim(img: Image.Image) -> Image.Image:
    """Indoor evening lighting."""
    return ImageEnhance.Brightness(img).enhance(0.42)


def low_res(img: Image.Image) -> Image.Image:
    """Heavily downscaled or recompressed upload."""
    w, h = img.size
    small = img.resize((max(w // 6, 32), max(h // 6, 32)), Image.BILINEAR)
    return small.resize((w, h), Image.BILINEAR)


DEGRADATIONS = {
    "blurred": blurred,
    "turned": turned,
    "occluded": occluded,
    "dim": dim,
    "low_res": low_res,
}


def landmarks_of(img: Image.Image) -> np.ndarray:
    """Detect landmarks on an in-memory image, in the isotropic pixel frame."""
    import face_pipeline

    landmarks = face_pipeline._get_landmarks(img)
    if landmarks is None:
        landmarks = face_pipeline._get_landmarks_small_face(img)
    if landmarks is None:
        raise EvalError("no face detected")
    return fg.landmarks_to_array(landmarks, *img.size)


def divergence(a: np.ndarray, b: np.ndarray, face_map: fg.FaceMap) -> float:
    """
    Mean distance between two morphed heads at the landmark vertices, normalised
    by interocular span so it reads on the same scale as ISE.
    """
    idx = face_map.landmark_vtx
    interocular = float(np.linalg.norm(a[idx[_EYE_L]] - a[idx[_EYE_R]]))
    if interocular <= 0:
        raise EvalError("degenerate interocular distance on the reference head")
    return float(np.linalg.norm(a[idx] - b[idx], axis=1).mean() / interocular)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--photos", type=Path, default=Path("eval/refs"))
    ap.add_argument("--template", type=Path, default=Path("templates/default.glb"))
    ap.add_argument("--strength", type=float, default=0.6)
    ap.add_argument("--limit", type=int, help="use only the first N faces (detection is the slow part)")
    ap.add_argument("--detail", action="store_true", help="per-degradation breakdown")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    face_map = fg.FaceMap.load()
    if face_map is None:
        print("error: face_uv_map.json has no geometry fields", file=sys.stderr)
        return 1

    glb = glb_ops.load_glb(args.template.read_bytes())
    base, _, _ = glb_ops.get_head_mesh_data(glb)
    base = base.astype(np.float64)

    photos = sorted(p for p in args.photos.iterdir() if p.suffix.lower() in PHOTO_SUFFIXES)
    if args.limit:
        photos = photos[: args.limit]
    if not photos:
        print(f"error: no photos in {args.photos}", file=sys.stderr)
        return 1

    print(f"detecting landmarks: {len(photos)} faces x {len(DEGRADATIONS) + 1} versions …")
    samples: list[dict] = []
    undetected: list[str] = []
    for photo in photos:
        img = Image.open(photo).convert("RGB")
        try:
            clean = landmarks_of(img)
        except EvalError:
            undetected.append(f"{photo.name}/clean")
            continue
        variants = {}
        for name, fn in DEGRADATIONS.items():
            try:
                variants[name] = landmarks_of(fn(img))
            except EvalError:
                # A degradation that defeats detection entirely is a *safe*
                # failure — the job falls back to texture-only rather than
                # morphing to garbage — so it is recorded, not scored.
                undetected.append(f"{photo.name}/{name}")
        samples.append({"name": photo.name, "clean": clean, "variants": variants})

    if not samples:
        print("error: no face detected in any reference photo", file=sys.stderr)
        return 1

    scored = sum(len(s["variants"]) for s in samples)
    print(f"{len(samples)} faces, {scored} degraded versions detected, "
          f"{len(undetected)} undetectable (safe: those fall back to texture-only)\n")

    rows = []
    for clamp in CLAMPS:
        per_degradation: dict[str, list[float]] = {name: [] for name in DEGRADATIONS}
        for sample in samples:
            clean_head = fg.morph_head_to_landmarks(
                base, face_map, sample["clean"], strength=args.strength, max_displacement_frac=clamp
            ).astype(np.float64)
            for name, pts in sample["variants"].items():
                variant_head = fg.morph_head_to_landmarks(
                    base, face_map, pts, strength=args.strength, max_displacement_frac=clamp
                ).astype(np.float64)
                per_degradation[name].append(divergence(clean_head, variant_head, face_map))

        flat = [v for values in per_degradation.values() for v in values]
        rows.append({
            "clamp": clamp,
            "mean": statistics.fmean(flat),
            "worst": max(flat),
            "per_degradation": {k: statistics.fmean(v) for k, v in per_degradation.items() if v},
        })

    print("instability (lower = the same person keeps the same head)")
    print(f"{'clamp':>7}  {'mean':>8}  {'worst':>8}")
    for row in rows:
        marker = "  ← shipped" if row["clamp"] == 0.45 else ""
        print(f"{row['clamp']:>7}  {row['mean']:>8.4f}  {row['worst']:>8.4f}{marker}")

    if args.detail:
        print("\nby degradation (mean divergence):")
        names = sorted(DEGRADATIONS)
        print(f"{'clamp':>7}  " + "  ".join(f"{n:>9}" for n in names))
        for row in rows:
            print(f"{row['clamp']:>7}  " + "  ".join(
                f"{row['per_degradation'].get(n, float('nan')):>9.4f}" for n in names
            ))
        if undetected:
            print(f"\nundetectable ({len(undetected)}):")
            for item in undetected:
                print(f"  {item}")

    print("\nRead with eval.tune_morph: fidelity improves as the clamp loosens, "
          "stability degrades. Ship the knee, not either extreme.")

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps({"strength": args.strength, "rows": rows,
                                        "undetected": undetected}, indent=2))
        print(f"→ {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
