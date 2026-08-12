"""
Open Inference Protocol (OIN) v0.1: worker-side protocol layer.

Implements the node half of specs/OPEN_INFERENCE_PROTOCOL.md so any three.ws
worker can speak the open protocol next to its native routes:

  - JCS (RFC 8785) canonical JSON, SHA-256 job digests.
  - Ed25519 signing of advertisements and responses (PyNaCl when installed,
    falling back to a pure-Python RFC 8032 implementation so a minimal worker
    image is never blocked on a dependency).
  - A mounted FastAPI router: GET /.well-known/oin, POST /oin/jobs,
    GET /oin/jobs/{id}. The worker's own job runner is passed in as a
    callback; OIN only wraps envelopes and signatures around it.

This module is intentionally dependency-light (PyNaCl optional, otherwise
stdlib only) so it can be COPYed verbatim into every worker's Docker build
context, exactly like worker_security.py. The canonical file lives in
workers/stylize/ (the reference worker); copy it byte-identical when wiring
OIN into another worker.

Dependency note: the pure-Python fallback is checked at import against an
RFC 8032 test vector (see _self_test), so a broken crypto stack fails the
worker's boot instead of signing garbage on the first paid job. Production
images install pynacl and take the libsodium path. ``OIN_PURE_PYTHON=1``
forces the fallback (used by tests).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
from typing import Callable, Optional

log = logging.getLogger("oin")

OIN_SPEC = "oin/0.1"
MAX_FUTURE_SKEW_S = 24 * 60 * 60


# ── canonical JSON (RFC 8785 JCS) ────────────────────────────────────────────────
# Python's json.dumps with sorted keys, no whitespace, and ensure_ascii matches
# JCS for every value type this protocol carries (objects, arrays, strings,
# finite numbers, booleans, null). Non-finite numbers are rejected outright.


def _jcs_number(n) -> str:
    if isinstance(n, bool):  # bool is an int subclass; never reaches here via dumps
        raise TypeError("bool is not a number")
    if isinstance(n, int):
        return str(n)
    if isinstance(n, float):
        if n != n or n in (float("inf"), float("-inf")):
            raise TypeError("OIN canonicalization: non-finite number")
        # ECMAScript shortest round-trip form. repr() in py3 is shortest-form
        # already; JCS wants exponent notation without a leading zero or '+0'.
        if n == int(n) and abs(n) < 1e21:
            return str(int(n))
        s = repr(n)
        if "e" in s or "E" in s:
            mantissa, _, exp = s.replace("E", "e").partition("e")
            exp = exp.lstrip("+").lstrip("0") or "0"
            if exp.startswith("-"):
                exp = "-" + (exp[1:].lstrip("0") or "0")
            return f"{mantissa}e{exp}"
        return s
    raise TypeError(f"OIN canonicalization: unsupported number {type(n)}")


def canonicalize(value) -> str:
    """RFC 8785 canonical form of a JSON value, as a str."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _jcs_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        # JCS sorts keys by UTF-16 code units. Python sorts str by code points,
        # which agree for the BMP; for astral keys we must sort by UTF-16
        # code-unit sequence explicitly.
        keys = sorted(value.keys(), key=lambda k: k.encode("utf-16-be", "surrogatepass"))
        parts = []
        for k in keys:
            v = value[k]
            if v is None and k not in value:
                continue
            parts.append(json.dumps(k, ensure_ascii=False, separators=(",", ":")) + ":" + canonicalize(v))
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"OIN canonicalization: unsupported type {type(value)}")


def digest_job(envelope: dict) -> str:
    return hashlib.sha256(canonicalize(envelope).encode("utf-8")).hexdigest()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ── Ed25519: PyNaCl, with a pure-Python RFC 8032 fallback ─────────────────────────

_FORCE_PURE = os.environ.get("OIN_PURE_PYTHON") == "1"

try:
    if _FORCE_PURE:
        raise ImportError("OIN_PURE_PYTHON=1")
    from nacl.signing import SigningKey as _NaclSigningKey

    def _ed25519_sign(seed: bytes, message: bytes) -> bytes:
        return _NaclSigningKey(seed).sign(message).signature

    def _ed25519_pubkey(seed: bytes) -> bytes:
        return bytes(_NaclSigningKey(seed).verify_key)

    _BACKEND = "pynacl"
except ImportError:
    # Pure-Python Ed25519 (RFC 8032, section 6 shape). Slow next to libsodium
    # but byte-identical; a worker signs one payload per job, so this is never
    # the bottleneck.
    _q = 2**255 - 19
    _l = 2**252 + 27742317777372353535851937790883648493
    _d = (-121665 * pow(121666, _q - 2, _q)) % _q
    _I = pow(2, (_q - 1) // 4, _q)

    def _xrecover(y: int) -> int:
        xx = (y * y - 1) * pow(_d * y * y + 1, _q - 2, _q)
        x = pow(xx, (_q + 3) // 8, _q)
        if (x * x - xx) % _q != 0:
            x = (x * _I) % _q
        if x % 2 != 0:
            x = _q - x
        return x

    _By = 4 * pow(5, _q - 2, _q) % _q
    _Bx = _xrecover(_By)
    _B = (_Bx % _q, _By % _q)

    def _edwards_add(P, Q):
        (x1, y1), (x2, y2) = P, Q
        xy = _d * x1 * x2 * y1 * y2
        x3 = (x1 * y2 + x2 * y1) * pow(1 + xy, _q - 2, _q) % _q
        # edwards25519 is a twisted Edwards curve with a = -1:
        # y3 = (y1*y2 - a*x1*x2) / (1 - d*x1*x2*y1*y2) = (y1*y2 + x1*x2) / (...)
        y3 = (y1 * y2 + x1 * x2) * pow(1 - xy, _q - 2, _q) % _q
        return (x3, y3)

    def _scalarmult(P, e):
        if e == 0:
            return (0, 1)
        Q = _scalarmult(P, e // 2)
        Q = _edwards_add(Q, Q)
        if e & 1:
            Q = _edwards_add(Q, P)
        return Q

    def _encodepoint(P) -> bytes:
        x, y = P
        bits = [(y >> i) & 1 for i in range(255)] + [x & 1]
        return bytes(sum(bits[i * 8 + j] << j for j in range(8)) for i in range(32))

    def _hint(m: bytes) -> int:
        return int.from_bytes(hashlib.sha512(m).digest(), "little")

    def _ed25519_pubkey(seed: bytes) -> bytes:
        h = hashlib.sha512(seed).digest()
        a = int.from_bytes(h[:32], "little")
        a &= (1 << 254) - 8
        a |= 1 << 254
        return _encodepoint(_scalarmult(_B, a))

    def _ed25519_sign(seed: bytes, message: bytes) -> bytes:
        h = hashlib.sha512(seed).digest()
        a = int.from_bytes(h[:32], "little")
        a &= (1 << 254) - 8
        a |= 1 << 254
        prefix = h[32:]
        A = _encodepoint(_scalarmult(_B, a))
        r = _hint(prefix + message) % _l
        R = _encodepoint(_scalarmult(_B, r))
        S = (r + _hint(R + A + message) * a) % _l
        return R + S.to_bytes(32, "little")

    _BACKEND = "pure-python"


def _decode_signing_key(key_b64: str) -> bytes:
    raw = base64.b64decode(key_b64)
    if len(raw) == 64:
        raw = raw[:32]  # expanded key: seed is the first half
    if len(raw) != 32:
        raise ValueError("OIN signing key must be a base64 32-byte seed or 64-byte expanded key")
    return raw


def public_key_b64(key_b64: str) -> str:
    return base64.b64encode(_ed25519_pubkey(_decode_signing_key(key_b64))).decode()


def sign_payload(payload: dict, key_b64: str) -> str:
    """Canonicalize ``payload`` (which must not contain a ``signature`` key) and sign."""
    if "signature" in payload:
        payload = {k: v for k, v in payload.items() if k != "signature"}
    message = canonicalize(payload).encode("utf-8")
    return base64.b64encode(_ed25519_sign(_decode_signing_key(key_b64), message)).decode()


# RFC 8032 test vector (test 1): proves whichever backend is active at import,
# so a silently broken crypto stack fails the worker's boot instead of signing
# garbage on the first paid job.


def _self_test() -> None:
    seed = bytes.fromhex("9d61b19deffebc3a9ba5e0b7a40637c6c28ae1c6e2e2b60e04d0c1c38c18fc6e")
    expected_pub = "bf7f06309ee61f64017d0dcf0ed8d5fba34cda3166b4bb031eb9fe730b18b59c"
    expected_sig = (
        "b1133656c872ee0d3010b972323709b214a21d7f0fbda8e132565164ab426adb"
        "23759f5dc7b123e96cf743fa03e9d5dff205884cf62a184c052c087511fd9a01"
    )
    assert _ed25519_pubkey(seed).hex() == expected_pub, f"OIN ed25519 pubkey mismatch on {_BACKEND}"
    assert _ed25519_sign(seed, b"").hex() == expected_sig, f"OIN ed25519 signature mismatch on {_BACKEND}"


_self_test()
log.info("oin ed25519 backend: %s", _BACKEND)


# ── FastAPI surface ──────────────────────────────────────────────────────────────


def mount_oin(
    app,
    *,
    node_id: str,
    signing_key_b64: str,
    capabilities: list,
    auth: str,
    run_job: Callable,
    require_auth: Optional[Callable] = None,
) -> None:
    """Mount the OIN routes on a FastAPI app.

    ``run_job(envelope, report)`` is the worker's own executor. It receives the
    validated job envelope and a ``report`` callback; it MUST call exactly one
    of:

        report.done(url=..., data=out_bytes)
        report.failed(code=..., message=...)

    ``data`` is the artifact bytes: OIN computes output.sha256/bytes from them,
    so the signature can never describe bytes other than the ones the caller
    can fetch. ``require_auth`` (optional) is the worker's own bearer-check
    callable, invoked with the raw Authorization header when ``auth='bearer'``.
    """
    from fastapi import HTTPException
    from fastapi import Header as FastAPIHeader

    node_pubkey = f"ed25519:{public_key_b64(signing_key_b64)}"
    jobs: dict = {}

    def _advertisement() -> dict:
        return {
            "spec": OIN_SPEC,
            "node_id": node_id,
            "node_pubkey": node_pubkey,
            "generated_at": _now_iso(),
            "capabilities": capabilities,
            "endpoints": {"submit": "/oin/jobs", "poll": "/oin/jobs/:id", "health": "/health"},
            "auth": auth,
        }

    def _now_iso() -> str:
        from datetime import datetime, timezone

        return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    @app.get("/.well-known/oin")
    async def oin_advertisement() -> dict:
        ad = _advertisement()
        return {**ad, "signature": sign_payload(ad, signing_key_b64)}

    @app.post("/oin/jobs", status_code=202)
    async def oin_submit(envelope: dict, authorization: Optional[str] = FastAPIHeader(default=None)) -> dict:
        if auth == "bearer" and require_auth is not None:
            require_auth(authorization)
        if envelope.get("spec") != OIN_SPEC:
            raise HTTPException(status_code=400, detail="unsupported_spec")
        capability = envelope.get("capability")
        advertised = {c.get("key") for c in capabilities}
        if capability not in advertised:
            raise HTTPException(status_code=400, detail="unsupported_capability")
        job_id = envelope.get("job_id")
        if not job_id or not isinstance(job_id, str):
            raise HTTPException(status_code=400, detail="bad_shape: job_id required")
        if job_id in jobs:
            raise HTTPException(status_code=409, detail="duplicate_job")
        if not envelope.get("created_at"):
            raise HTTPException(status_code=400, detail="bad_shape: created_at required")
        if not isinstance(envelope.get("input"), dict):
            raise HTTPException(status_code=400, detail="bad_shape: input required")

        job_digest = digest_job(envelope)
        jobs[job_id] = {"status": "queued", "envelope": envelope, "job_digest": job_digest}

        asyncio.get_event_loop().create_task(_execute(job_id, envelope, job_digest))
        return {
            "job_id": job_id,
            "status": "queued",
            "job_digest": job_digest,
            "node_pubkey": node_pubkey,
        }

    async def _execute(job_id: str, envelope: dict, job_digest: str) -> None:
        jobs[job_id]["status"] = "running"

        class _Report:
            called = False

            def done(self, *, url: str, data: bytes):
                self.called = True
                response = {
                    "spec": OIN_SPEC,
                    "job_digest": job_digest,
                    "node_pubkey": node_pubkey,
                    "completed_at": _now_iso(),
                    "status": "done",
                    "output": {"url": url, "sha256": sha256_hex(data), "bytes": len(data)},
                }
                jobs[job_id]["status"] = "done"
                jobs[job_id]["response"] = {**response, "signature": sign_payload(response, signing_key_b64)}

            def failed(self, *, code: str, message: str):
                self.called = True
                response = {
                    "spec": OIN_SPEC,
                    "job_digest": job_digest,
                    "node_pubkey": node_pubkey,
                    "completed_at": _now_iso(),
                    "status": "failed",
                    "error": {"code": code, "message": message},
                }
                jobs[job_id]["status"] = "failed"
                jobs[job_id]["response"] = {**response, "signature": sign_payload(response, signing_key_b64)}

        report = _Report()
        try:
            result = run_job(envelope, report)
            if hasattr(result, "__await__"):
                await result
        except Exception as exc:  # noqa: BLE001 — an unsigned crash still earns a signed failure
            log.exception("oin job %s crashed; signing a failure response", job_id)
            if not report.called:
                report.failed(code="node_error", message=str(exc)[:500])
        if not report.called:
            report.failed(code="node_error", message="executor returned without reporting")

    @app.get("/oin/jobs/{job_id}")
    async def oin_poll(job_id: str, authorization: Optional[str] = FastAPIHeader(default=None)) -> dict:
        if auth == "bearer" and require_auth is not None:
            require_auth(authorization)
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        if job["status"] in ("done", "failed"):
            return job["response"]
        return {
            "spec": OIN_SPEC,
            "job_id": job_id,
            "job_digest": job["job_digest"],
            "status": job["status"],
            "node_pubkey": node_pubkey,
        }
