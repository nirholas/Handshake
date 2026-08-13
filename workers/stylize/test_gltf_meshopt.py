"""Tests for gltf_meshopt.py, the shared EXT_meshopt_compression decoder.

Vendored byte-identical into every worker that ships gltf_meshopt.py, exactly
like the module itself, and run as a Docker build gate in each of them:

    python3 test_gltf_meshopt.py

The round-trip section needs the `gltfpack` binary (present in every worker
image, pinned in the Dockerfile). Without it the suite still runs and pins the
readable failure a caller gets instead, so a laptop run stays green.
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import trimesh  # noqa: E402

import gltf_meshopt  # noqa: E402

PASS = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS
    if not condition:
        print(f"FAIL  {name}  {detail}")
        sys.exit(1)
    PASS += 1
    print(f"ok    {name}")


plain_glb = trimesh.Scene({"a": trimesh.creation.icosphere(subdivisions=2)}).export(file_type="glb")

# ── document parsing ────────────────────────────────────────────────────────────

doc = gltf_meshopt.gltf_document(plain_glb, ".glb")
check("a glb's json chunk parses", isinstance(doc, dict) and "asset" in doc, str(type(doc)))
check(
    "a gltf json payload parses",
    isinstance(gltf_meshopt.gltf_document(b'{"asset":{"version":"2.0"}}', ".gltf"), dict),
)
for payload, suffix, label in (
    (b"ply\nformat ascii 1.0\n", ".ply", "a ply"),
    (b"not json at all", ".gltf", "malformed gltf json"),
    (b"glTF" + b"\x00" * 4, ".glb", "a truncated glb"),
    (b"solid mesh\n", ".stl", "an stl"),
):
    check(f"{label} yields no gltf document", gltf_meshopt.gltf_document(payload, suffix) is None)

# ── extension detection ─────────────────────────────────────────────────────────

check("a plain glb needs no decode", not gltf_meshopt.uses_meshopt(doc))
check("an empty document needs no decode", not gltf_meshopt.uses_meshopt(None))
for declared in ("extensionsRequired", "extensionsUsed"):
    check(
        f"{declared} announcing {gltf_meshopt.MESHOPT_EXTENSION} needs a decode",
        gltf_meshopt.uses_meshopt({declared: [gltf_meshopt.MESHOPT_EXTENSION]}),
    )
check(
    "an unrelated extension needs no decode",
    not gltf_meshopt.uses_meshopt({"extensionsUsed": ["KHR_materials_unlit"]}),
)
check(
    "an uncompressed payload passes through decode_if_meshopt untouched",
    gltf_meshopt.decode_if_meshopt(plain_glb, ".glb") == (plain_glb, ".glb"),
)

# ── the real decode ─────────────────────────────────────────────────────────────

if shutil.which(gltf_meshopt.GLTFPACK_BIN):
    with tempfile.TemporaryDirectory() as packdir:
        raw = Path(packdir) / "raw.glb"
        packed = Path(packdir) / "packed.glb"
        raw.write_bytes(plain_glb)
        subprocess.run(
            [gltf_meshopt.GLTFPACK_BIN, "-i", str(raw), "-o", str(packed), "-cc"],
            capture_output=True,
            check=True,
            timeout=gltf_meshopt.GLTFPACK_TIMEOUT_S,
        )
        packed_bytes = packed.read_bytes()

    check(
        "a gltfpack-compressed glb is detected",
        gltf_meshopt.uses_meshopt(gltf_meshopt.gltf_document(packed_bytes, ".glb")),
    )

    # The bug this module exists for: trimesh dies on the compressed asset's
    # fallback buffer, which is why every worker loading one failed.
    try:
        trimesh.load(io.BytesIO(packed_bytes), file_type="glb", force="mesh", process=False)
        raw_load_failed = False
    except Exception:  # noqa: BLE001: the exact trimesh error is not the contract
        raw_load_failed = True
    check("trimesh alone cannot read a meshopt glb", raw_load_failed)

    decoded, suffix = gltf_meshopt.decode_if_meshopt(packed_bytes, ".glb")
    check("the decode returns a glb", suffix == ".glb" and decoded[:4] == b"glTF", suffix)
    check("the decode is not a passthrough", decoded != packed_bytes)
    check(
        "the decoded asset no longer declares the extension",
        not gltf_meshopt.uses_meshopt(gltf_meshopt.gltf_document(decoded, ".glb")),
    )

    mesh = trimesh.load(io.BytesIO(decoded), file_type="glb", force="mesh", process=False)
    check(
        "the decoded asset loads as real geometry",
        len(mesh.faces) > 0 and len(mesh.vertices) > 0,
        f"faces={len(mesh.faces)}",
    )
    source = trimesh.load(io.BytesIO(plain_glb), file_type="glb", force="mesh", process=False)
    check(
        "the decoded geometry matches the source face count",
        len(mesh.faces) == len(source.faces),
        f"{len(mesh.faces)} vs {len(source.faces)}",
    )
else:
    original_bin = gltf_meshopt.GLTFPACK_BIN
    try:
        gltf_meshopt.GLTFPACK_BIN = "gltfpack-not-installed"
        gltf_meshopt.transcode_meshopt(plain_glb, ".glb")
        check("a missing gltfpack is a readable error", False, "no ValueError raised")
    except ValueError as exc:
        check(
            "a missing gltfpack is a readable error",
            gltf_meshopt.MESHOPT_EXTENSION in str(exc),
            str(exc),
        )
    finally:
        gltf_meshopt.GLTFPACK_BIN = original_bin

print(f"\n{PASS} checks passed")
