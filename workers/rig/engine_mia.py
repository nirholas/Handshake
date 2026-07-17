"""
Make-It-Animatable driver: mesh in, skeleton + skinning weights out.

Wraps jasongzy/Make-It-Animatable (MIT, CVPR 2025) as a pure predictor. We run
its prepare/preprocess/infer/vis stages headlessly and read the results off
its DB state object; we deliberately do NOT run its Blender/FBX export stage.
The visual mesh never round-trips through Blender, so the original GLB's
materials and PBR textures survive untouched; rig_glb.py grafts the predicted
skeleton straight into the original bytes.

MIA specifics this module encodes:
  - init must happen on the MAIN thread: importing MIA's app module builds the
    Mixamo kinematic tree through bpy, and bpy crashes when scene data is
    touched from a child thread. Per-job prediction never touches bpy.
  - MIA normalizes the input into its own working frame and composes the
    transform onto db.global_transform; we invert it to bring joints and
    working vertices back into the caller's GLB space.
  - Output skeleton is the 65-bone Mixamo hierarchy (fingers included), names
    prefixed "mixamorig:". The platform's glb-canonicalize maps these onto the
    canonical clip skeleton at ingest, so every clip in the library retargets.

Environment:
  MIA_DIR  path to the Make-It-Animatable checkout (default /app/mia); its
           output/best/new/*.pth weights and data/Mixamo/bones.fbx template
           must be in place before init() (see stage_assets.py).
"""

from __future__ import annotations

import logging
import os
import sys

import numpy as np

log = logging.getLogger("rig.engine_mia")

MIA_DIR = os.environ.get("MIA_DIR", "/app/mia")

_mia = None
_names: list[str] | None = None
_parents: list[int] | None = None


def init() -> None:
    """Import MIA and load its six checkpoints. Main thread only; ~seconds."""
    global _mia, _names, _parents
    if _mia is not None:
        return
    if not os.path.isdir(MIA_DIR):
        raise RuntimeError(f"MIA_DIR not found: {MIA_DIR}")
    sys.path.insert(0, MIA_DIR)

    import app as mia_app  # noqa: PLC0415  (heavy import by design, once)

    mia_app.init_models()
    # The stage functions return Gradio component-update dicts keyed by UI
    # globals that only exist after init_blocks(); build the (unlaunched)
    # Blocks so those names resolve. No server is started here.
    mia_app.init_blocks()

    from util.dataset_mixamo import BONES_IDX_DICT, KINEMATIC_TREE  # noqa: PLC0415

    ordered = sorted(BONES_IDX_DICT.items(), key=lambda kv: kv[1])
    _names = [name for name, _ in ordered]
    _parents = list(KINEMATIC_TREE.parent_indices)
    if len(_parents) != len(_names):
        raise RuntimeError(
            f"kinematic tree size {len(_parents)} != bone count {len(_names)}"
        )
    _mia = mia_app
    log.info("MIA ready: %d bones, root=%s", len(_names), _names[0])


def is_ready() -> bool:
    return _mia is not None


def joint_names() -> list[str]:
    if _names is None:
        raise RuntimeError("engine not initialized")
    return list(_names)


def predict(glb_path: str) -> dict:
    """Run MIA on a GLB file and return predictions in the GLB's own space.

    Returns:
      verts    (V,3) MIA's working vertices, back in input space (weight rows
               align to these; rig_glb KD-trees them onto the GLB primitives)
      weights  (V,J)
      joints   (J,3) bone heads, input space
      joints_tail (J,3)
      parents  (J,) with -1 for the root
      names    [J] "mixamorig:*" bone names
    """
    if _mia is None:
        raise RuntimeError("engine not initialized")
    import shutil  # noqa: PLC0415
    import torch  # noqa: PLC0415

    db = _mia.DB()
    try:
        _mia.prepare_input(glb_path, False, 0.0, db, export_temp=True)
        _mia.preprocess(db)
        _mia.infer(False, db)
        # bw_fix applies MIA's weight post-process (head/finger cleanups);
        # vis also converts db fields to numpy and fills joints_tail.
        _mia.vis(True, "LeftArm", False, db)
    finally:
        # MIA caches GPU tensors on the DB and writes stage visualizations into
        # a per-job temp dir; drop both even on failure so a poison mesh cannot
        # leak VRAM or disk across jobs.
        torch.cuda.empty_cache()
        if db.output_dir:
            shutil.rmtree(db.output_dir, ignore_errors=True)

    if db.bw is None or db.joints is None or db.joints_tail is None:
        raise RuntimeError("MIA produced no rig prediction")

    # db.global_transform maps input space -> MIA's normalized frame (it was
    # composed across prepare_input and infer); invert to go home.
    inv = db.global_transform.inverse()

    def _back(points: np.ndarray) -> np.ndarray:
        t = torch.as_tensor(np.asarray(points, dtype=np.float32)).reshape(1, -1, 3)
        return inv.transform_points(t).squeeze(0).cpu().numpy().astype(np.float32)

    verts = _back(db.verts)
    joints = _back(db.joints)
    joints_tail = _back(db.joints_tail)
    weights = np.asarray(db.bw, dtype=np.float32)

    if weights.shape[0] != verts.shape[0]:
        raise RuntimeError(
            f"weights ({weights.shape[0]}) misaligned with working verts ({verts.shape[0]})"
        )
    if weights.shape[1] != len(_names):
        raise RuntimeError(
            f"weight columns ({weights.shape[1]}) != bone count ({len(_names)})"
        )

    return {
        "verts": verts,
        "weights": weights,
        "joints": joints,
        "joints_tail": joints_tail,
        "parents": np.asarray(_parents, dtype=np.int64),
        "names": list(_names),
    }
