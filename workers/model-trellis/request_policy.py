"""Request policy for the TRELLIS worker: quality tiers and transient-fetch retry.

This module is deliberately free of torch, CUDA, and the TRELLIS source tree so
the decision logic that shapes every generation can be imported and unit tested
on any machine (see test_request_policy.py). main.py imports every public name
here; nothing in this file touches the GPU.

Two policies live here:

  1. Quality resolution. A caller sends an optional named `tier` and an optional
     per-field `quality` dict; this module turns that into the exact sampler and
     bake parameters, clamped to what a 24 GB L4 can serve.
  2. Transient-fetch retry. Caller-supplied image URLs are fetched over the
     public internet, where a single read timeout would otherwise fail a whole
     generation. `call_with_retry` re-runs the fetch for errors that are worth
     retrying and gives up immediately on the ones that are not.
"""

from __future__ import annotations

from typing import Callable, Optional

import httpx

# Per-request quality knobs, clamped to safe envelopes for a 24 GB L4.
# Defaults are the platform's production quality bar, not the TRELLIS demo's
# (steps=12, simplify=0.95, texture_size=1024): GPU time is cheap against the
# platform's GCP credit budget, so both diffusion stages run well past the demo
# step count and the texture bake runs at the model's max resolution by default.
# Callers may still override per request (for example a lower-cost preview lane).
# `simplify` is the FRACTION OF TRIANGLES REMOVED by to_glb's decimation, so a
# lower value keeps more geometry. Raising steps sharpens structure and
# appearance at roughly linear GPU-time cost; the L4 has headroom because
# MAX_CONCURRENT is 1.
#
# Why these numbers, measured: warm cost at the PRIOR defaults (steps 25/25,
# texture 2048, simplify 0.90) was about 50s per asset (docs/ops/gcp-credits.md)
# against a 300s client poll budget (src/home-forge.js MAX_POLL_MS), which left
# room to push further:
#   - ss_steps/slat_steps 25 to 40: sharper structure and surface detail, at
#     roughly 1.6x the diffusion time since cost scales about linearly.
#   - texture_size 2048 to 4096 (the clamp ceiling): the bake is a resize and
#     encode pass, not a diffusion stage, so this is a small time cost for a
#     large perceptual win. Resolution is one of the biggest levers on whether a
#     result reads as real rather than generated.
#   - simplify 0.90 to 0.75: keeps meaningfully more geometry (25% of triangles
#     removed instead of 90%). Low-poly faceting is one of the most obvious tells
#     of AI-generated 3D, and this is otherwise-idle GPU decimation cost.
# Together these land well inside the poll budget (about 90 to 120s warm).
QUALITY_DEFAULTS = {
    "ss_steps": 40,
    "slat_steps": 40,
    "ss_cfg": 7.5,
    "slat_cfg": 3.0,
    "simplify": 0.75,
    "texture_size": 4096,
}

# Named quality tiers. A caller sends `tier` to pick one preset; an explicit
# `quality` dict still overrides individual fields on top of it. When no tier is
# sent the base stays QUALITY_DEFAULTS, so the existing lane's behaviour is
# byte-for-byte unchanged: tiers are purely additive.
#   draft    - latency lane: demo-grade steps, aggressive decimation, 1K texture.
#   standard - the platform's prior default (steps 25, 2K texture, simplify 0.90).
#   high     - the current default (steps 40, 4K texture, simplify 0.75).
#   max      - maximum fidelity: steps at the sampler ceiling, near-zero geometry
#              decimation (keep about all triangles), firmer guidance, 4K texture.
# texture_size caps at 4096 (the clamp ceiling and TRELLIS's practical bake limit
# on the L4). `max` is meant to be paired with rembg pre-matting.
TIER_PRESETS = {
    "draft":    {"ss_steps": 12, "slat_steps": 12, "ss_cfg": 7.5, "slat_cfg": 3.0, "simplify": 0.95, "texture_size": 1024},
    "standard": {"ss_steps": 25, "slat_steps": 25, "ss_cfg": 7.5, "slat_cfg": 3.0, "simplify": 0.90, "texture_size": 2048},
    "high":     {"ss_steps": 40, "slat_steps": 40, "ss_cfg": 7.5, "slat_cfg": 3.0, "simplify": 0.75, "texture_size": 4096},
    "max":      {"ss_steps": 50, "slat_steps": 50, "ss_cfg": 8.5, "slat_cfg": 4.5, "simplify": 0.50, "texture_size": 4096},
}


def normalize_tier(tier: Optional[str]) -> Optional[str]:
    """Lowercase and trim a caller's tier string, or None when none was sent.

    An unknown-but-non-empty tier normalizes rather than raising: it is reported
    back on the task record so a typo is visible, and quality falls back to the
    defaults.
    """
    if tier is None:
        return None
    key = str(tier).strip().lower()
    return key or None


def matte_enabled(matte: Optional[bool], tier_key: Optional[str]) -> bool:
    """Resolve whether to pre-matte the subject via the sibling rembg service.

    Defaults on for the `max` tier (paired for maximum fidelity) and off
    everywhere else, preserving the free/default lane. An explicit `matte` value
    from the caller always wins.
    """
    if matte is not None:
        return bool(matte)
    return tier_key == "max"


def clamped_quality(q: Optional[dict], tier: Optional[str] = None) -> dict:
    """Resolve tier preset plus per-field overrides into clamped sampler params.

    Base is the named tier preset when a valid one is given, else the historical
    defaults. An explicit `quality` dict then overrides field by field, and every
    field is clamped to the L4 envelope. Unparseable values fall back to the base
    rather than failing the request.
    """
    base = dict(QUALITY_DEFAULTS)
    if tier:
        preset = TIER_PRESETS.get(normalize_tier(tier) or "")
        if preset:
            base = dict(preset)
    src = {**base, **(q or {})}

    def num(key, lo, hi, cast=float):
        raw = src.get(key)
        try:
            val = cast(raw)
        except (TypeError, ValueError):
            return base[key]
        return max(lo, min(hi, val))

    # nvdiffrast's texture bake builds a mip stack and hard-fails on any
    # non-power-of-two extent (proven live 2026-07-16: a 3072 request killed
    # every generation at the bake step). Snap the requested size down to the
    # nearest power of two inside the clamp envelope so no caller value can
    # crash the bake.
    tex = num("texture_size", 512, 4096, int)
    tex = 1 << (int(tex).bit_length() - 1)

    return {
        "ss_steps": num("ss_steps", 8, 50, int),
        "slat_steps": num("slat_steps", 8, 50, int),
        "ss_cfg": num("ss_cfg", 1.0, 15.0),
        "slat_cfg": num("slat_cfg", 1.0, 10.0),
        "simplify": num("simplify", 0.5, 0.98),
        "texture_size": tex,
    }


# Total attempts (not extra retries) for one caller-supplied image URL, and the
# first backoff gap. Three attempts at 1s then 2s costs at most a few seconds of
# an already-asynchronous job, and covers the single-blip read timeouts that
# were failing whole generations from the public internet.
FETCH_ATTEMPTS = 3
FETCH_RETRY_BASE_SECONDS = 1.0

# Upstream status codes worth a second try. Everything else (404, 403, 400) is a
# statement about the URL itself and will fail identically on every attempt.
_RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


def retry_delays(
    attempts: int = FETCH_ATTEMPTS, base: float = FETCH_RETRY_BASE_SECONDS
) -> list[float]:
    """Exponential backoff gaps between attempts (one fewer than `attempts`)."""
    return [base * (2 ** i) for i in range(max(0, attempts - 1))]


def is_transient_fetch_error(exc: BaseException) -> bool:
    """True when re-fetching the same URL could plausibly succeed.

    Timeouts and connection-level failures are the blips this exists for. An
    HTTP error is transient only for the status codes above; a 404 is not going
    to become a 200 on the next attempt.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in _RETRYABLE_STATUS
    return isinstance(
        exc, (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)
    )


def call_with_retry(
    fn: Callable[[], object],
    *,
    attempts: int = FETCH_ATTEMPTS,
    should_retry: Callable[[BaseException], bool] = is_transient_fetch_error,
    sleep: Callable[[float], None],
    on_retry: Optional[Callable[[int, float, BaseException], None]] = None,
):
    """Call `fn`, retrying with exponential backoff while `should_retry` holds.

    Re-raises the last exception once the attempts are spent or the error is not
    retryable. `sleep` is injected so the policy stays testable without wall
    clock time; `on_retry` receives (attempt_number, delay, exception) for
    logging.
    """
    delays = retry_delays(attempts)
    last: BaseException
    for index in range(max(1, attempts)):
        try:
            return fn()
        except BaseException as exc:  # noqa: BLE001 - re-raised below after the budget
            last = exc
            if index >= len(delays) or not should_retry(exc):
                raise
            delay = delays[index]
            if on_retry:
                on_retry(index + 1, delay, exc)
            sleep(delay)
    raise last
