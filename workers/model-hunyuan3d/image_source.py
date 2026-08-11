"""Caller-supplied image sourcing for the Hunyuan3D workers.

Both apps in this directory (``app21.py``, the live 2.1 lane, and ``main.py``,
the 2.0 lane) reconstruct from an image URL the platform hands them. Until this
module existed each of them fetched that URL with a bare
``fetch_remote_bytes(src, timeout=30)`` inside the generic ``except Exception``
of ``_run_inference``, which produced two live defects:

  1. **The reason was destroyed.** Any fetch failure became
     ``safe_error(...)`` -> ``internal error (ref <id>)``. That string is what
     lands in ``forge_creations.error``, the platform's declared ground truth
     for generation issues, so the single most common real cause of a failed
     generation (the reference image URL answering 403/404, or a read timing
     out mid-stream) was indistinguishable from a GPU fault. Measured over the
     7 days to 2026-08-11: 11 of 24 failed forge rows carried an opaque ref,
     and every one traced back to this fetch.
  2. **A dead URL burned more GPU.** An opaque failure is a retryable failure
     to ``api/_lib/forge-failover.js``, so a 404 reference image was
     re-dispatched to the next GPU lane, which fetched the same dead URL and
     failed the same way. Naming the cause lets that decision be made honestly.

The fix is the one the sibling TRELLIS worker already ships
(``workers/model-trellis/request_policy.py``): retry the transient blips, and
classify everything else as ``ImageSourceError`` so the worker hands the reason
back verbatim instead of an error ref.
"""

from __future__ import annotations

import base64
import io
import time
from typing import Callable, Optional
from urllib.parse import urlsplit

import httpx
from PIL import Image

from worker_security import UnsafeUrlError, fetch_remote_bytes

# Seconds allowed for one attempt at one caller-supplied image URL.
IMAGE_FETCH_TIMEOUT_S = 30.0

# Total attempts (not extra retries) per URL, and the first backoff gap. Three
# attempts at 1s then 2s cost at most a few seconds of an already-asynchronous
# job and cover the single-blip read timeouts that were failing whole
# generations against the public internet.
FETCH_ATTEMPTS = 3
FETCH_RETRY_BASE_SECONDS = 1.0

# Upstream status codes worth a second try. Everything else (404, 403, 400) is
# a statement about the URL itself and will fail identically on every attempt.
_RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


class ImageSourceError(ValueError):
    """A caller-supplied image could not be read.

    Distinct from an internal failure: the cause is the request's own ``images``
    entry (unreachable host, rejected target, undecodable bytes), so the message
    is safe and useful to hand back verbatim instead of an opaque error ref.
    """


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
    sleep: Callable[[float], None] = time.sleep,
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


def source_label(src: str) -> str:
    """Short, non-leaking identifier for an image source, for error messages."""
    if src.startswith("data:image"):
        return "inline data uri"
    host = urlsplit(src).hostname
    return host or src[:60]


def fetch_image_bytes(
    src: str,
    *,
    timeout: float = IMAGE_FETCH_TIMEOUT_S,
    sleep: Callable[[float], None] = time.sleep,
    on_retry: Optional[Callable[[int, float, BaseException], None]] = None,
) -> bytes:
    """Fetch one https image source, retrying transient network failures.

    The fetch itself stays SSRF-hardened by ``fetch_remote_bytes``: https-only,
    private/loopback/link-local/metadata IPs rejected after DNS resolution,
    redirects re-validated per hop, response size bounded. Every failure leaves
    here as an ``ImageSourceError`` naming the host and the reason.
    """
    label = source_label(src)

    def attempt() -> bytes:
        return fetch_remote_bytes(src, timeout=timeout)

    try:
        return call_with_retry(attempt, sleep=sleep, on_retry=on_retry)
    except UnsafeUrlError as exc:
        raise ImageSourceError(f"refused to fetch image source ({label}): {exc}") from exc
    except httpx.HTTPStatusError as exc:
        raise ImageSourceError(
            f"image source {label} returned HTTP {exc.response.status_code}"
        ) from exc
    except httpx.HTTPError as exc:
        raise ImageSourceError(
            f"image source {label} unreachable after {FETCH_ATTEMPTS} attempts "
            f"({type(exc).__name__}); check the URL is publicly readable"
        ) from exc
    except ValueError as exc:
        # The guard's own size ceiling. Caught after UnsafeUrlError (a ValueError
        # subclass) so the more specific message wins.
        raise ImageSourceError(f"image source {label} rejected: {exc}") from exc


def open_image(data: bytes, mode: str, label: str) -> Image.Image:
    try:
        return Image.open(io.BytesIO(data)).convert(mode)
    except Exception as exc:  # noqa: BLE001 - undecodable caller input, not an internal fault
        raise ImageSourceError(
            f"image source {label} is not a decodable image ({type(exc).__name__})"
        ) from exc


def decode_image(
    src: str,
    *,
    mode: str = "RGB",
    timeout: float = IMAGE_FETCH_TIMEOUT_S,
    sleep: Callable[[float], None] = time.sleep,
    on_retry: Optional[Callable[[int, float, BaseException], None]] = None,
) -> Image.Image:
    """Turn one caller-supplied image source into a PIL image.

    Accepts an inline ``data:image`` URI or an https URL. Raises
    ``ImageSourceError`` (never a bare httpx/PIL exception) so the caller can
    report the reason instead of an opaque internal error ref.
    """
    if src.startswith("data:image"):
        parts = src.split(",", 1)
        if len(parts) != 2:
            raise ImageSourceError("inline data uri has no base64 payload")
        try:
            raw = base64.b64decode(parts[1])
        except Exception as exc:  # noqa: BLE001 - caller's own payload, report it as such
            raise ImageSourceError(f"inline data uri is not valid base64: {exc}") from exc
        return open_image(raw, mode, "inline data uri")
    if src.startswith("https://"):
        data = fetch_image_bytes(src, timeout=timeout, sleep=sleep, on_retry=on_retry)
        return open_image(data, mode, source_label(src))
    raise ImageSourceError(f"unsupported image source: {src[:60]}")
