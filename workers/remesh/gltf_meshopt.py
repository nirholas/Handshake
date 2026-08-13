"""EXT_meshopt_compression decoding for caller-supplied glTF input.

Vendored byte-identical into every worker that loads a mesh a caller handed it,
exactly like worker_security.py: each worker's Docker build context is its own
directory, so `../` is unreachable. `npm run check:vendored` fails if the copies
drift apart.

Why it exists: trimesh has no decoder for EXT_meshopt_compression. A compressed
asset stores its geometry in compressed buffer views and declares a second,
empty "fallback" buffer that only exists once something decodes into it, so
trimesh dies on the bufferView lookup with a bare `IndexError: list index out of
range`. Meshopt is what gltfpack emits and what most three.ws avatars ship as,
so this was a hard failure on our own assets (verified 2026-08-13:
/avatars/michelle.glb failed every stylize filter in production). gltfpack is
the same project's CLI and decodes what it encoded, so the fix is to transcode
the asset to plain glTF before any reader touches it.

The binary is pinned by release tag and checksum in each worker's Dockerfile.
Set GLTFPACK_BIN to run the path against your own copy locally.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

log = logging.getLogger("gltf-meshopt")

MESHOPT_EXTENSION = "EXT_meshopt_compression"
GLTFPACK_BIN = os.environ.get("GLTFPACK_BIN", "gltfpack")
GLTFPACK_TIMEOUT_S = int(os.environ.get("GLTFPACK_TIMEOUT_S", "120"))


def gltf_document(data: bytes, suffix: str = ".glb") -> Optional[dict]:
    """The glTF JSON of a .glb/.gltf payload, or None when it is neither."""
    if suffix == ".gltf":
        try:
            return json.loads(data)
        except ValueError:
            return None
    if suffix != ".glb" or len(data) < 20 or data[:4] != b"glTF":
        return None
    chunk_length = int.from_bytes(data[12:16], "little")
    if data[16:20] != b"JSON":
        return None
    try:
        return json.loads(data[20:20 + chunk_length])
    except ValueError:
        return None


def uses_meshopt(document: Optional[dict]) -> bool:
    """True when the asset needs a meshopt decode before any reader can use it.

    Checked against both extension lists: an asset that only *uses* the
    extension still stores its geometry in the compressed views, and its
    fallback buffer stays empty until something decodes into it.
    """
    if not document:
        return False
    declared = set(document.get("extensionsRequired") or []) | set(document.get("extensionsUsed") or [])
    return MESHOPT_EXTENSION in declared


def transcode_meshopt(data: bytes, suffix: str = ".glb") -> bytes:
    """Rewrite a meshopt-compressed asset as a plain GLB with gltfpack.

    `-noq` keeps the source quantization instead of re-quantizing on the way
    out, so downstream geometry is derived from what the author shipped.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        src = Path(tmpdir) / f"input{suffix}"
        dst = Path(tmpdir) / "decoded.glb"
        src.write_bytes(data)
        try:
            proc = subprocess.run(
                [GLTFPACK_BIN, "-i", str(src), "-o", str(dst), "-noq"],
                capture_output=True,
                timeout=GLTFPACK_TIMEOUT_S,
            )
        except FileNotFoundError as exc:
            raise ValueError(
                f"input uses {MESHOPT_EXTENSION} and the gltfpack decoder is not installed"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise ValueError(f"{MESHOPT_EXTENSION} decode timed out") from exc
        if proc.returncode != 0 or not dst.exists():
            detail = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()
            raise ValueError(f"{MESHOPT_EXTENSION} decode failed: {detail[-1][:200] if detail else 'no output'}")
        return dst.read_bytes()


def decode_if_meshopt(data: bytes, suffix: str = ".glb") -> tuple[bytes, str]:
    """Return (data, suffix) ready for trimesh, decoding meshopt when present.

    A payload that is not compressed glTF is handed back untouched, so this is
    safe to call on every input path.
    """
    if not uses_meshopt(gltf_document(data, suffix)):
        return data, suffix
    log.info("input declares %s; decoding with gltfpack before load", MESHOPT_EXTENSION)
    return transcode_meshopt(data, suffix), ".glb"
