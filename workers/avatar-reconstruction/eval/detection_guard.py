"""
Safety audit — what does the pipeline do with inputs that are NOT this person's face?

`tune_morph` and `robustness` both assume the detector found the right face.
This checks that assumption. It runs the reference set and the adversarial set
([`make_adversarial.py`](make_adversarial.py)) through the detector and the morph,
and reports, per input: did it detect, how far is it turned, and how far does the
resulting head move from the template.

What this measured (2026-07-25, 40 refs + 16 adversarial), and why the guard ended
up where it did:

**A face-plausibility gate does not work — do not rebuild one.** The obvious design
is to align the landmarks to the canonical face and reject a large residual. It
fails, because MediaPipe FaceMesh is a *fitted model*: it does not decide whether
something is a face, it reports where a face would be. A golden retriever scored
0.4758 — a *better* canonical fit than all 40 real humans (0.5035-0.5238). Any
threshold separating them would reject real people first.

**The catastrophic failure mode does not exist here.** Head displacement from the
template: real faces 0.2713-0.2839, every detected adversarial input
0.2586-0.2929. A dog photo does not yield a monstrous head, it yields a slightly
unusual *human* one. Four mechanisms compose to guarantee it — canonical
alignment removes pose and scale, `strength` damps the residual, the per-point
clamp bounds outliers, and the TPS off-face mask confines deformation to the face
region. Guarding the mesh against wrong detections is therefore unnecessary.

**Yaw is the one thing worth gating.** Real frontals peak at 2.7°; a near-profile
reads 58.6° and is the only input that pushes the head outside the real-face band.
Past roughly a third of a turn the far side of the face is self-occluded, so
MediaPipe's depth there is extrapolation and the morph fits it as bone structure.
`face_pipeline.MAX_MORPH_YAW_DEG` (35°) skips the morph and keeps texture transfer
in that case. Photos of photos (poster, phone screen, painting) sit at 9-18°,
already produce in-band heads, and are deliberately left alone.

A non-detection is always the safe outcome: the job falls back to texture-only
rather than morphing to garbage.

Usage
-----
    python -m eval.detection_guard --photos eval/refs --adversarial eval/adversarial
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import face_geometry as fg  # noqa: E402
import glb_ops  # noqa: E402

PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
_EYE_L, _EYE_R = 33, 263


def probe(path: Path, base: np.ndarray, face_map: fg.FaceMap, interocular: float) -> dict:
    """Detect, measure yaw, morph, and report how far the head travelled."""
    import face_pipeline as fp

    img = Image.open(path).convert("RGB")
    landmarks = fp._get_landmarks(img) or fp._get_landmarks_small_face(img)
    if landmarks is None:
        return {"name": path.stem, "detected": False}

    detected = fg.landmarks_to_array(landmarks, *img.size)
    yaw = fg.estimate_yaw_deg(detected, face_map)
    morphed = fg.morph_head_to_landmarks(base, face_map, detected).astype(np.float64)
    idx = face_map.landmark_vtx
    displacement = float(np.linalg.norm(morphed[idx] - base[idx], axis=1).mean() / interocular)
    return {
        "name": path.stem,
        "detected": True,
        "yaw_deg": yaw,
        "displacement": displacement,
        "gated": yaw > float(fp.MAX_MORPH_YAW_DEG),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--photos", type=Path, default=Path("eval/refs"))
    ap.add_argument("--adversarial", type=Path, default=Path("eval/adversarial"))
    ap.add_argument("--template", type=Path, default=Path("templates/default.glb"))
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    face_map = fg.FaceMap.load()
    if face_map is None:
        print("error: face_uv_map.json has no geometry fields", file=sys.stderr)
        return 1

    glb = glb_ops.load_glb(args.template.read_bytes())
    base, _, _ = glb_ops.get_head_mesh_data(glb)
    base = base.astype(np.float64)
    idx = face_map.landmark_vtx
    interocular = float(np.linalg.norm(base[idx[_EYE_L]] - base[idx[_EYE_R]]))

    import face_pipeline as fp
    print(f"morph yaw gate: {fp.MAX_MORPH_YAW_DEG:.0f}°\n")

    real = [probe(p, base, face_map, interocular)
            for p in sorted(args.photos.iterdir()) if p.suffix.lower() in PHOTO_SUFFIXES]
    seen = [r for r in real if r["detected"]]
    if not seen:
        print("error: no face detected in any reference photo", file=sys.stderr)
        return 1

    yaws = [r["yaw_deg"] for r in seen]
    disps = [r["displacement"] for r in seen]
    band = (min(disps), max(disps))
    print(f"REFERENCE ({len(seen)}/{len(real)} detected)")
    print(f"  yaw          mean {statistics.fmean(yaws):.1f}°  worst {max(yaws):.1f}°")
    print(f"  displacement {band[0]:.4f} – {band[1]:.4f}")
    gated_real = [r for r in seen if r["gated"]]
    print(f"  gated by the yaw threshold: {len(gated_real)}"
          + (" ← a real face was rejected, the threshold is too tight"
             if gated_real else " (none — good)"))

    adversarial = [probe(p, base, face_map, interocular)
                   for p in sorted(args.adversarial.iterdir()) if p.suffix.lower() in PHOTO_SUFFIXES]
    print(f"\nADVERSARIAL ({sum(a['detected'] for a in adversarial)}/{len(adversarial)} detected)")
    print(f"  {'input':<38} {'yaw':>7}  {'displacement':>12}  verdict")
    for a in adversarial:
        if not a["detected"]:
            print(f"  {a['name'][:38]:<38} {'—':>7}  {'—':>12}  no detection (safe: texture-only)")
            continue
        # Only displacement ABOVE the real-face band is a concern. Below it means
        # the head moved *less* than any genuine face does, i.e. the result sits
        # closer to the untouched template — the conservative direction, and the
        # same place a non-detection lands. Treating the two tails alike would
        # report the safest outcomes as failures.
        if a["gated"]:
            verdict = "GATED — morph skipped"
        elif a["displacement"] > band[1]:
            verdict = "ABOVE real-face band ← distorts more than any real face"
        elif a["displacement"] < band[0]:
            verdict = "below band (benign: closer to template than a real face)"
        else:
            verdict = "in real-face band (bounded)"
        print(f"  {a['name'][:38]:<38} {a['yaw_deg']:>6.1f}°  {a['displacement']:>12.4f}  {verdict}")

    escaped = [a for a in adversarial
               if a["detected"] and not a["gated"] and a["displacement"] > band[1]]
    print(f"\n{len(escaped)} adversarial input(s) ungated AND distorting more than any real face")
    if escaped:
        for a in escaped:
            print(f"  {a['name']}: yaw {a['yaw_deg']:.1f}°, displacement {a['displacement']:.4f}")
    else:
        print("  (none — every ungated adversarial input stays at or below real-face "
              "distortion, which is what the clamp + damping + off-face mask guarantee)")

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(
            {"yaw_gate_deg": fp.MAX_MORPH_YAW_DEG, "real_band": band,
             "reference": real, "adversarial": adversarial}, indent=2))
        print(f"→ {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
