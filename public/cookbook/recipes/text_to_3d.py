#!/usr/bin/env python3
"""Turn a text prompt into a downloadable GLB using the free three.ws 3D API.

No API key, no account, no dependencies beyond the Python standard library.

    python3 text_to_3d.py "a small ceramic teapot with a bamboo handle"
    python3 text_to_3d.py "a wooden treasure chest" --out chest.glb

The free lane is NVIDIA NIM TRELLIS: single-subject prompts, draft-fidelity
geometry, no rigging. Higher polygon budgets, PBR textures, and rigged
skeletons live behind the paid tiers that every response links to.

Recipe: https://three.ws/cookbook/text-to-3d-cli
API reference: https://three.ws/docs/3d-api
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://three.ws/api/3d/generate"
USER_AGENT = "three.ws-cookbook/text_to_3d.py"

# The free GPU lane is shared. Polling faster than the server's own retryAfter
# hint trips the flood guard (HTTP 429) and helps nobody, so these bounds only
# ever clamp a hint that is missing or absurd.
MIN_POLL_SECONDS = 2.0
MAX_POLL_SECONDS = 30.0
DEFAULT_TIMEOUT_SECONDS = 600.0


class ForgeError(RuntimeError):
    """The generation lane refused the prompt or failed upstream."""


def _request(url: str, payload: dict | None = None, timeout: float = 180.0) -> dict:
    """POST JSON (or GET when payload is None) and decode the JSON response."""
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method="POST" if data else "GET",
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "user-agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        try:
            detail = json.loads(body).get("error_description") or json.loads(body).get("error")
        except json.JSONDecodeError:
            detail = body[:200]
        raise ForgeError(f"HTTP {exc.code} from {url}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ForgeError(f"could not reach {url}: {exc.reason}") from exc


def _poll_delay(payload: dict) -> float:
    """Honor the server's retryAfter hint, clamped to a sane range."""
    hint = payload.get("retryAfter")
    try:
        seconds = float(hint)
    except (TypeError, ValueError):
        return MIN_POLL_SECONDS
    return max(MIN_POLL_SECONDS, min(MAX_POLL_SECONDS, seconds))


def generate(prompt: str, timeout: float = DEFAULT_TIMEOUT_SECONDS, log=print) -> dict:
    """Generate one model and return the finished payload.

    The API answers inline when the draft finishes fast, and hands back a job
    handle when the lane is busy. Both paths end at the same shape:
    ``{"status": "done", "glbUrl": ..., "viewerUrl": ..., "arUrl": ...}``.
    """
    started = time.monotonic()
    payload = _request(API, {"prompt": prompt, "format": "glb"})

    while payload.get("status") == "pending":
        job = payload.get("job")
        if not job:
            raise ForgeError("the API reported 'pending' without a job handle")

        elapsed = time.monotonic() - started
        if elapsed > timeout:
            raise ForgeError(f"gave up after {elapsed:.0f}s waiting for job {job}")

        delay = _poll_delay(payload)
        log(f"  queued, next poll in {delay:.0f}s ({elapsed:.0f}s elapsed)")
        time.sleep(delay)

        query = urllib.parse.urlencode({"job": job, "title": prompt})
        payload = _request(f"{API}?{query}")

    if payload.get("status") == "error":
        raise ForgeError(payload.get("error") or "the generation lane failed")
    if not payload.get("glbUrl"):
        raise ForgeError(f"unexpected response: {json.dumps(payload)[:200]}")
    return payload


def download(url: str, path: str) -> int:
    """Stream a URL to disk and return the byte count written."""
    req = urllib.request.Request(url, headers={"user-agent": USER_AGENT})
    written = 0
    with urllib.request.urlopen(req, timeout=180) as res, open(path, "wb") as out:
        while chunk := res.read(1 << 16):
            out.write(chunk)
            written += len(chunk)
    return written


def slugify(text: str, limit: int = 48) -> str:
    keep = [c.lower() if c.isalnum() else "-" for c in text]
    slug = "".join(keep).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return (slug[:limit].strip("-")) or "model"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Text to 3D with the free, keyless three.ws API.",
        epilog="Docs: https://three.ws/docs/3d-api",
    )
    parser.add_argument("prompt", help="what to build, e.g. 'a wooden treasure chest'")
    parser.add_argument("--out", help="output .glb path (default: derived from the prompt)")
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=f"seconds to wait for a queued job (default: {DEFAULT_TIMEOUT_SECONDS:.0f})",
    )
    parser.add_argument("--quiet", action="store_true", help="print only the output path")
    args = parser.parse_args(argv)

    log = (lambda *_a, **_k: None) if args.quiet else print
    out_path = args.out or f"{slugify(args.prompt)}.glb"

    log(f"prompt: {args.prompt}")
    try:
        result = generate(args.prompt, timeout=args.timeout, log=log)
    except ForgeError as exc:
        print(f"generation failed: {exc}", file=sys.stderr)
        return 1

    log(f"  glb:    {result['glbUrl']}")
    log(f"  viewer: {result.get('viewerUrl', '')}")
    if result.get("arUrl"):
        log(f"  ar:     {result['arUrl']}  (open on a phone to place it in your room)")

    try:
        size = download(result["glbUrl"], out_path)
    except (urllib.error.URLError, OSError) as exc:
        print(f"download failed: {exc}", file=sys.stderr)
        return 1

    print(out_path if args.quiet else f"saved {size / 1024:.0f} KB to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
