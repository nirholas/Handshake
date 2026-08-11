"""
Python mirror of the three.ws canonical humanoid bone contract.

CANONICAL_BONES / REGION_BONES / BODY_REGIONS / GARMENT_SLOTS are copied
verbatim from their JS sources of truth:

  - CANONICAL_BONES               src/glb-canonicalize.js
  - REGION_BONES / BODY_REGIONS   src/garment-taxonomy.js
  - GARMENT_SLOTS                 src/garment-taxonomy.js
  - MIN_BIND_COVERAGE             src/garment-taxonomy.js

(src/avatar-garment.js only re-exports the four taxonomy constants for its
own consumers; edit them in src/garment-taxonomy.js.) Nothing imports across
the language boundary, so the copies are held together by
tests/garment-forge-taxonomy-parity.test.js, which parses these literals and
compares them value for value. If it fails, THIS file is the side to fix.

canonicalize_bone_name() is deliberately a SUBSET of the JS canonicalizer:
this worker controls its whole pipeline, and the only skeleton that ever
reaches validation here is the one model-rig emits (Mixamo names, optionally
behind a `mixamorig:`/`mixamorigN:` namespace) or names that are already
canonical. Porting the full multi-vendor alias table would duplicate logic
the runtime already owns without ever being exercised.
"""

from __future__ import annotations

import re

CANONICAL_BONES = (
    "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "LeftHandIndex1", "LeftHandIndex2", "LeftHandIndex3",
    "LeftHandMiddle1", "LeftHandMiddle2", "LeftHandMiddle3",
    "LeftHandPinky1", "LeftHandPinky2", "LeftHandPinky3",
    "LeftHandRing1", "LeftHandRing2", "LeftHandRing3",
    "LeftHandThumb1", "LeftHandThumb2", "LeftHandThumb3",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
    "RightHandIndex1", "RightHandIndex2", "RightHandIndex3",
    "RightHandMiddle1", "RightHandMiddle2", "RightHandMiddle3",
    "RightHandPinky1", "RightHandPinky2", "RightHandPinky3",
    "RightHandRing1", "RightHandRing2", "RightHandRing3",
    "RightHandThumb1", "RightHandThumb2", "RightHandThumb3",
    "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
    "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
)

_CANONICAL_LOOKUP = {name.lower(): name for name in CANONICAL_BONES}

BODY_REGIONS = (
    "torso", "upperArms", "lowerArms", "hands",
    "hips", "upperLegs", "lowerLegs", "feet", "neck", "scalp",
)

REGION_BONES = {
    "torso": ("Spine", "Spine1", "Spine2"),
    "upperArms": ("LeftArm", "RightArm"),
    "lowerArms": ("LeftForeArm", "RightForeArm"),
    "hands": ("LeftHand", "RightHand"),
    "hips": ("Hips",),
    "upperLegs": ("LeftUpLeg", "RightUpLeg"),
    "lowerLegs": ("LeftLeg", "RightLeg"),
    "feet": ("LeftFoot", "RightFoot", "LeftToeBase", "RightToeBase"),
    "neck": ("Neck",),
    "scalp": ("Head",),
}

# Finger joints roll up into the hand for region accounting: a glove garment
# weighted to LeftHandIndex2 covers the "hands" region even though that joint
# is not listed in REGION_BONES (the runtime's mask is per-major-joint).
_BONE_TO_REGION = {}
for _region, _bones in REGION_BONES.items():
    for _b in _bones:
        _BONE_TO_REGION[_b] = _region
for _b in CANONICAL_BONES:
    if _b not in _BONE_TO_REGION and ("Hand" in _b):
        _BONE_TO_REGION[_b] = "hands"

GARMENT_SLOTS = (
    "top", "bottom", "footwear", "outerwear",
    "hair", "headwear", "glasses", "accessory",
)

MIN_BIND_COVERAGE = 0.6

_NAMESPACE_RE = re.compile(r"^.*:")          # `mixamorig:LeftArm` → `LeftArm`
_MIXAMO_GLUED_RE = re.compile(r"^mixamorig\d*", re.IGNORECASE)
_SEPARATORS_RE = re.compile(r"[-_.\s]+")


def canonicalize_bone_name(name: str | None) -> str | None:
    """Reduce a Mixamo/canonical bone name to its canonical three.ws form,
    or None when it is not a recognised humanoid bone."""
    if not name or not isinstance(name, str):
        return None
    stripped = _NAMESPACE_RE.sub("", name)
    stripped = _MIXAMO_GLUED_RE.sub("", stripped)
    key = _SEPARATORS_RE.sub("", stripped).lower()
    return _CANONICAL_LOOKUP.get(key)


def region_of_bone(canonical_name: str) -> str | None:
    """Body region a canonical bone belongs to, fingers rolled into hands."""
    return _BONE_TO_REGION.get(canonical_name)
