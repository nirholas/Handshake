"""
Core-path smoke test: a real photo through the whole pipeline to a real GLB.

Run: python3 smoke_test.py [photo-url-or-path]

The other test files here pin individual stages in isolation (tint maths,
geometry morph, camera fit). None of them runs `face_pipeline.process`, which is
the only thing the service actually calls, and every production failure this
worker has had lived in that gap: a module missing from the image, a stage that
crashes only on a real photograph, an output GLB whose rig no longer loads. Each
took a full build-and-deploy cycle to discover. This closes it.

The photo is a real image fetched over HTTPS from the benchmark reference set
(`eval/README.md`), so the SSRF-hardened fetch, the decoder, background removal,
landmark detection, the TPS warp, the geometry morph and projective texturing all
run exactly as they do for a user's upload. Pass a URL or a local path to use a
different one.

What it asserts, and why each one is the thing that breaks:

  1. The output parses as a GLB with an intact binary blob.
  2. The head keeps its exact vertex count and order. Everything below depends
     on this: the 52 ARKit blendshapes and the skin weights are stored as
     indices into it, so a single added or reordered vertex silently detaches
     the whole rig.
  3. Every morph target survives, with the same target count as the template.
     An avatar that cannot blink or speak is not shippable, and the morph writes
     POSITION in place precisely so they stay attached.
  4. Skinning (JOINTS_0 / WEIGHTS_0) and the skeleton are still present.
  5. The skin texture actually changed, proof the photo landed rather than the
     template being returned untouched.
  6. The head geometry actually moved, proof the identity morph ran.
  7. A faceless photo is rejected as an InputError carrying a caller-facing
     reason, not as an opaque internal error. That distinction is what decides
     whether the user is told to reword their prompt or shown "Generation
     failed" (see `face_pipeline.InputError`).
"""

from __future__ import annotations

import base64
import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image

import face_pipeline
import glb_ops

HERE = Path(__file__).parent

# One face from the benchmark reference set, mirrored to the worker's own bucket
# and publicly readable (eval/README.md). Deliberately a URL, not a bundled file:
# the HTTPS branch of `_decode_image` is the one every production job takes.
DEFAULT_PHOTO = (
    "https://storage.googleapis.com/three-ws-avatar-reconstructions"
    "/eval-refs/black-caribbean-adult-woman-clean.png"
)


def _photo_source(argv: list[str]) -> str:
    """Resolve the photo argument to something `process` accepts."""
    if not argv:
        return DEFAULT_PHOTO
    arg = argv[0]
    if arg.startswith("https://") or arg.startswith("data:image"):
        return arg
    path = Path(arg)
    if not path.exists():
        raise SystemExit(f"photo not found: {path}")
    suffix = path.suffix.lstrip(".").lower() or "png"
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/{suffix};base64,{b64}"


def _morph_target_count(glb) -> int:
    prim = glb_ops._find_head_prim(glb)
    return len(prim.targets or [])


def _head_texture(glb) -> Image.Image:
    tex = glb_ops.get_material_texture(glb, "Wolf3D_Skin")
    if tex is None:
        raise AssertionError("Wolf3D_Skin texture missing from the GLB")
    return tex.convert("RGB")


def main(argv: list[str]) -> int:
    source = _photo_source(argv)
    print(f"photo: {source[:90]}{'…' if len(source) > 90 else ''}")

    template = glb_ops.load_glb((HERE / "templates" / "default.glb").read_bytes())
    tpl_positions, _, _ = glb_ops.get_head_mesh_data(template)
    tpl_targets = _morph_target_count(template)
    tpl_texture = np.array(_head_texture(template), dtype=np.int16)
    print(f"template: {len(tpl_positions)} head vertices, {tpl_targets} morph targets")

    # ── 1. the core path ──────────────────────────────────────────────────────
    glb_bytes = face_pipeline.process("smoke", [source], "neutral")
    assert glb_bytes[:4] == b"glTF", "output is not a GLB container"
    print(f"ok  pipeline returned a {len(glb_bytes)} byte GLB")

    out = glb_ops.load_glb(glb_bytes)
    assert out.binary_blob(), "output GLB has no binary blob"

    # ── 2. fixed topology ─────────────────────────────────────────────────────
    positions, _, faces = glb_ops.get_head_mesh_data(out)
    assert positions.shape == tpl_positions.shape, (
        f"head vertex count changed: {positions.shape[0]} vs template "
        f"{tpl_positions.shape[0]}, skinning and blendshapes are now detached"
    )
    assert int(faces.max()) < positions.shape[0], "a face indexes past the vertex array"
    print(f"ok  head topology preserved ({positions.shape[0]} vertices, {len(faces)} tris)")

    # ── 3. blendshapes ────────────────────────────────────────────────────────
    targets = _morph_target_count(out)
    assert targets == tpl_targets, f"morph targets lost: {targets} vs template {tpl_targets}"
    assert targets >= 52, f"expected at least the 52 ARKit blendshapes, found {targets}"
    print(f"ok  all {targets} morph targets intact (ARKit blendshapes + visemes)")

    # ── 4. rig ────────────────────────────────────────────────────────────────
    prim = glb_ops._find_head_prim(out)
    assert prim.attributes.JOINTS_0 is not None, "JOINTS_0 gone, head is no longer skinned"
    assert prim.attributes.WEIGHTS_0 is not None, "WEIGHTS_0 gone, head is no longer skinned"
    assert out.skins, "no skin in the output GLB, the avatar cannot be animated"
    joint_count = len(out.skins[0].joints or [])
    assert joint_count > 0, "skeleton has no joints"
    print(f"ok  rig intact (skinned head, {joint_count} joints)")

    # ── 5. the photo landed ───────────────────────────────────────────────────
    texture = np.array(_head_texture(out), dtype=np.int16)
    assert texture.shape == tpl_texture.shape, "skin texture changed size"
    changed = float(np.mean(np.abs(texture - tpl_texture) > 6))
    assert changed > 0.02, (
        f"only {changed * 100:.2f}% of skin texels differ from the template, "
        "the photograph did not reach the texture"
    )
    print(f"ok  skin texture repainted ({changed * 100:.1f}% of texels moved)")

    # ── 6. the identity morph ran ─────────────────────────────────────────────
    moved = float(np.linalg.norm(positions - tpl_positions, axis=1).max())
    assert moved > 1e-4, (
        "head geometry is byte-identical to the template, the identity morph "
        "did not run (check GEOMETRY_MORPH and the yaw gate)"
    )
    print(f"ok  head geometry morphed to the face (max vertex move {moved * 1000:.1f} mm)")

    # ── 7. a faceless photo is a caller error, not an internal one ─────────────
    # Synthesised on purpose: the assertion is about the *classification* of a
    # rejection, and a plain gradient is unambiguously faceless in a way no
    # collected photograph can be guaranteed to stay.
    grad = np.tile(
        np.linspace(40, 210, 384, dtype=np.uint8)[:, None, None], (1, 384, 3)
    )
    buf = io.BytesIO()
    Image.fromarray(grad, "RGB").save(buf, format="PNG")
    faceless = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    try:
        face_pipeline.process("smoke-faceless", [faceless], "neutral")
    except face_pipeline.InputError as exc:
        assert "face" in str(exc).lower(), f"unhelpful rejection reason: {exc}"
        print(f"ok  faceless photo rejected as an input error ({exc})")
    else:
        raise AssertionError("a faceless photo produced an avatar instead of a rejection")

    print("\nall 7 smoke assertions passed, core path is healthy")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except AssertionError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1)
