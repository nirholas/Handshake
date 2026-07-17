"""
Isolated test for blendshapes.py: template loading, head masking, and delta
transfer onto a synthetic humanoid head. No GPU / torch / GCP:
`python3 test_blendshapes.py`.

Uses a fabricated template (a small sphere with a known "jawOpen" delta) and a
synthetic target whose head is a displaced, rescaled copy of that sphere, so
the expected transferred deltas are known analytically.
"""

import os
import sys
import tempfile

import numpy as np

from blendshapes import head_mask_from_weights, load_template, transfer_blendshapes


def _check(cond, msg):
    if not cond:
        print(f"  FAIL {msg}")
        raise AssertionError(msg)
    print(f"  ok   {msg}")


def _sphere(n=400, radius=1.0, seed=7):
    rng = np.random.default_rng(seed)
    v = rng.normal(size=(n, 3))
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    return (v * radius).astype(np.float32)


def _write_template(path):
    verts = _sphere()
    verts -= verts.mean(axis=0)
    # One real shape (downward jaw delta on the lower hemisphere) and one
    # zero shape (like tongueOut when ICT lacks a source mesh).
    jaw = np.zeros_like(verts)
    lower = verts[:, 1] < 0
    jaw[lower, 1] = -0.1
    deltas = np.stack([jaw, np.zeros_like(verts)], axis=0)
    np.savez_compressed(path, names=np.array(["jawOpen", "tongueOut"]),
                        verts=verts, deltas=deltas)
    return verts, deltas


def test_load_template():
    print("test_load_template")
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "tpl.npz")
        _write_template(path)
        tpl = load_template(path)
        _check(tpl["names"] == ["jawOpen", "tongueOut"], "names round-trip")
        _check(tpl["verts"].shape[1] == 3 and tpl["deltas"].shape[0] == 2,
               "shapes round-trip")

        # A malformed template (delta/vert mismatch) must fail loudly.
        bad = os.path.join(tmp, "bad.npz")
        np.savez_compressed(bad, names=np.array(["a"]),
                            verts=np.zeros((10, 3), np.float32),
                            deltas=np.zeros((1, 9, 3), np.float32))
        try:
            load_template(bad)
        except RuntimeError:
            _check(True, "malformed template raises")
        else:
            _check(False, "expected RuntimeError for malformed template")


def test_head_mask():
    print("test_head_mask")
    names = ["mixamorig:Hips", "mixamorig:Spine", "mixamorig:Head",
             "mixamorig:LeftEye"]
    w = np.zeros((5, 4), np.float32)
    w[0, 0] = 1.0                    # hips vertex
    w[1, 2] = 0.9                    # head vertex
    w[2, 2] = 0.2                    # weak head influence: below threshold
    w[3, 3] = 0.8                    # eye vertex counts as head
    w[4, 1] = 1.0                    # spine vertex
    mask = head_mask_from_weights(w, names)
    _check(mask.tolist() == [False, True, False, True, False],
           f"head mask selects head+eye verts only ({mask.tolist()})")

    try:
        head_mask_from_weights(w, ["a", "b", "c", "d"])
    except RuntimeError:
        _check(True, "missing head bone raises")
    else:
        _check(False, "expected RuntimeError when no head bone present")


def test_transfer_geometry():
    print("test_transfer_geometry")
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "tpl.npz")
        tpl_verts, tpl_deltas = _write_template(path)
        tpl = load_template(path)

        # Target: body verts far below, head = the template sphere scaled 2x
        # and moved up to y ~ 3.
        scale, offset = 2.0, np.array([0.0, 3.0, 0.0], np.float32)
        head = tpl_verts * scale + offset
        body = _sphere(300, radius=0.8, seed=11) + np.array([0, 0.8, 0], np.float32)
        target = np.concatenate([body, head], axis=0)
        mask = np.zeros(len(target), dtype=bool)
        mask[len(body):] = True

        out = transfer_blendshapes(tpl, target, mask)
        deltas = out["deltas"]
        _check(deltas.shape == (2, len(target), 3), "output covers all verts")
        _check(np.abs(deltas[:, :len(body), :]).max() == 0.0,
               "body verts receive zero delta")

        # Head verts correspond 1:1 with template verts (exact overlap after
        # alignment), so the transferred jaw delta is the template's, scaled.
        head_deltas = deltas[0, len(body):, :]
        expected = tpl_deltas[0] * scale
        err = np.abs(head_deltas - expected).max()
        _check(err < 1e-3, f"jaw deltas transferred and scaled (max err {err:.2e})")
        _check(np.abs(deltas[1]).max() == 0.0, "zero template shape stays zero")


def test_transfer_falloff():
    print("test_transfer_falloff")
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "tpl.npz")
        _write_template(path)
        tpl = load_template(path)

        # Head region includes an outlier "hair" vertex far off the template
        # surface; falloff must zero it.
        head = tpl["verts"].copy()
        hair = np.array([[0.0, 5.0, 0.0]], np.float32)
        target = np.concatenate([head, hair], axis=0)
        mask = np.ones(len(target), dtype=bool)

        out = transfer_blendshapes(tpl, target, mask)
        _check(np.abs(out["deltas"][0, -1, :]).max() == 0.0,
               "far-off vertex receives zero delta (falloff)")


def test_tiny_head_skipped():
    print("test_tiny_head_skipped")
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "tpl.npz")
        _write_template(path)
        tpl = load_template(path)
        target = _sphere(100, seed=3)
        mask = np.zeros(len(target), dtype=bool)
        mask[:4] = True  # too few head verts to align against
        out = transfer_blendshapes(tpl, target, mask)
        _check(np.abs(out["deltas"]).max() == 0.0,
               "degenerate head yields all-zero deltas instead of garbage")


if __name__ == "__main__":
    try:
        test_load_template()
        test_head_mask()
        test_transfer_geometry()
        test_transfer_falloff()
        test_tiny_head_skipped()
    except AssertionError:
        print("\nFAILED")
        sys.exit(1)
    print("\nALL PASSED")
