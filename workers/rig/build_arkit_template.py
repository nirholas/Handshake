"""
Bake the ICT-FaceKit expression set into arkit_template.npz for blendshapes.py.

ICT-FaceKit (https://github.com/ICT-VGL/ICT-FaceKit, MIT) ships a generic
neutral head (FaceXModel/generic_neutral_mesh.obj) plus one OBJ per FACS
expression shape following Apple ARKit naming with _L/_R suffixes
(e.g. browDown_L.obj). This script maps them onto the canonical ARKit-52 list
(combining the _L/_R pairs ARKit treats as a single shape, like browInnerUp)
and writes a single npz the worker loads at startup.

Run once during asset staging (see stage-assets.sh), not at runtime:

  git clone --depth 1 https://github.com/ICT-VGL/ICT-FaceKit /tmp/ict-facekit
  python build_arkit_template.py --facekit /tmp/ict-facekit --out arkit_template.npz

Output npz: names [K] (ARKit-52 order), verts (V,3) neutral head centered on
its centroid (Y-up, +Z facing, ICT's native orientation), deltas (K,V,3).
Shapes ICT does not provide (tongueOut has no ICT source mesh in some
releases) are written as zero deltas so the full 52-name contract holds.
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np

# ARKit-52 name -> ICT-FaceKit source shape(s). Multi-source entries are
# summed (the regions are disjoint halves of one ARKit shape).
ICT_SOURCES = {
    "browDownLeft": ["browDown_L"],
    "browDownRight": ["browDown_R"],
    "browInnerUp": ["browInnerUp_L", "browInnerUp_R"],
    "browOuterUpLeft": ["browOuterUp_L"],
    "browOuterUpRight": ["browOuterUp_R"],
    "cheekPuff": ["cheekPuff_L", "cheekPuff_R"],
    "cheekSquintLeft": ["cheekSquint_L"],
    "cheekSquintRight": ["cheekSquint_R"],
    "eyeBlinkLeft": ["eyeBlink_L"],
    "eyeBlinkRight": ["eyeBlink_R"],
    "eyeLookDownLeft": ["eyeLookDown_L"],
    "eyeLookDownRight": ["eyeLookDown_R"],
    "eyeLookInLeft": ["eyeLookIn_L"],
    "eyeLookInRight": ["eyeLookIn_R"],
    "eyeLookOutLeft": ["eyeLookOut_L"],
    "eyeLookOutRight": ["eyeLookOut_R"],
    "eyeLookUpLeft": ["eyeLookUp_L"],
    "eyeLookUpRight": ["eyeLookUp_R"],
    "eyeSquintLeft": ["eyeSquint_L"],
    "eyeSquintRight": ["eyeSquint_R"],
    "eyeWideLeft": ["eyeWide_L"],
    "eyeWideRight": ["eyeWide_R"],
    "jawForward": ["jawForward"],
    "jawLeft": ["jawLeft"],
    "jawOpen": ["jawOpen"],
    "jawRight": ["jawRight"],
    "mouthClose": ["mouthClose"],
    "mouthDimpleLeft": ["mouthDimple_L"],
    "mouthDimpleRight": ["mouthDimple_R"],
    "mouthFrownLeft": ["mouthFrown_L"],
    "mouthFrownRight": ["mouthFrown_R"],
    "mouthFunnel": ["mouthFunnel"],
    "mouthLeft": ["mouthLeft"],
    "mouthLowerDownLeft": ["mouthLowerDown_L"],
    "mouthLowerDownRight": ["mouthLowerDown_R"],
    "mouthPressLeft": ["mouthPress_L"],
    "mouthPressRight": ["mouthPress_R"],
    "mouthPucker": ["mouthPucker"],
    "mouthRight": ["mouthRight"],
    "mouthRollLower": ["mouthRollLower"],
    "mouthRollUpper": ["mouthRollUpper"],
    "mouthShrugLower": ["mouthShrugLower"],
    "mouthShrugUpper": ["mouthShrugUpper"],
    "mouthSmileLeft": ["mouthSmile_L"],
    "mouthSmileRight": ["mouthSmile_R"],
    "mouthStretchLeft": ["mouthStretch_L"],
    "mouthStretchRight": ["mouthStretch_R"],
    "mouthUpperUpLeft": ["mouthUpperUp_L"],
    "mouthUpperUpRight": ["mouthUpperUp_R"],
    "noseSneerLeft": ["noseSneer_L"],
    "noseSneerRight": ["noseSneer_R"],
    "tongueOut": ["tongueOut"],
}


def _load_obj_vertices(path: str) -> np.ndarray:
    """Minimal OBJ vertex reader; ICT shapes share the neutral's topology so
    only the `v` lines matter and vertex order is the correspondence."""
    verts = []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("v "):
                parts = line.split()
                verts.append((float(parts[1]), float(parts[2]), float(parts[3])))
    if not verts:
        raise RuntimeError(f"no vertices in {path}")
    return np.asarray(verts, dtype=np.float32)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--facekit", required=True, help="path to a clone of ICT-VGL/ICT-FaceKit")
    ap.add_argument("--out", default="arkit_template.npz")
    args = ap.parse_args()

    model_dir = os.path.join(args.facekit, "FaceXModel")
    neutral_path = os.path.join(model_dir, "generic_neutral_mesh.obj")
    if not os.path.isfile(neutral_path):
        print(f"error: {neutral_path} not found; is --facekit a full clone?", file=sys.stderr)
        return 1

    neutral = _load_obj_vertices(neutral_path)
    center = neutral.mean(axis=0)
    verts = neutral - center

    names, deltas, missing = [], [], []
    for arkit_name, sources in ICT_SOURCES.items():
        delta = np.zeros_like(neutral)
        found_any = False
        for src in sources:
            src_path = os.path.join(model_dir, f"{src}.obj")
            if not os.path.isfile(src_path):
                continue
            shape = _load_obj_vertices(src_path)
            if shape.shape != neutral.shape:
                raise RuntimeError(
                    f"{src}.obj vertex count {shape.shape[0]} != neutral {neutral.shape[0]}"
                )
            delta += shape - neutral
            found_any = True
        if not found_any:
            missing.append(arkit_name)
        names.append(arkit_name)
        deltas.append(delta)

    deltas = np.stack(deltas, axis=0).astype(np.float32)
    np.savez_compressed(args.out, names=np.array(names), verts=verts, deltas=deltas)

    print(f"wrote {args.out}: {len(names)} shapes over {verts.shape[0]} verts")
    if missing:
        # tongueOut is the only expected absentee; anything else means the
        # FaceXModel layout changed and the bake must be fixed, not shipped.
        print(f"zero-filled (no ICT source found): {', '.join(missing)}")
        unexpected = [m for m in missing if m != "tongueOut"]
        if unexpected:
            print(f"error: unexpected missing shapes: {unexpected}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
