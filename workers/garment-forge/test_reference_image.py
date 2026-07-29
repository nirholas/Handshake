"""Unit tests for the reference-image re-roll (pipeline.generate_reference_image).
No network, no Vertex, no GCS. Runs locally and as a Docker build gate:

    python3 workers/garment-forge/test_reference_image.py

These pin the fix for the 2026-07-29 job loss: Vertex answered HTTP 200 with an
empty candidate ("Vertex returned no image data") and the job died on the spot.
That is not a transport failure — _post_with_retry had nothing to retry — it is
a stochastic model declining to draw once. Re-rolling the same prompt clears it,
and without the re-roll a single such response permanently loses a queued job.
"""

from __future__ import annotations

import base64
import os
import sys
import types


def _stub_missing_cloud_deps() -> None:
    """pipeline.py imports the GCS/auth/imaging stack at module scope, none of
    which this test touches (the Vertex call and the token are both patched).
    Inside the container those packages are installed and used as-is; on a bare
    checkout they are not, so stub ONLY what is actually absent. Real modules
    always win, so the Docker build gate still exercises the genuine imports.
    """
    def missing(name: str) -> bool:
        try:
            __import__(name)
            return False
        except ImportError:
            return True

    if missing("google.auth"):
        google = sys.modules.setdefault("google", types.ModuleType("google"))
        auth = types.ModuleType("google.auth")
        auth.default = lambda **_kw: (types.SimpleNamespace(token=None, refresh=lambda _r: None), "test")
        transport = types.ModuleType("google.auth.transport")
        requests_mod = types.ModuleType("google.auth.transport.requests")
        requests_mod.Request = lambda *a, **k: None
        transport.requests = requests_mod
        auth.transport = transport
        google.auth = auth
        sys.modules.update({
            "google.auth": auth,
            "google.auth.transport": transport,
            "google.auth.transport.requests": requests_mod,
        })
    if missing("google.api_core.exceptions"):
        api_core = types.ModuleType("google.api_core")
        exceptions = types.ModuleType("google.api_core.exceptions")
        exceptions.NotFound = type("NotFound", (Exception,), {})
        exceptions.PreconditionFailed = type("PreconditionFailed", (Exception,), {})
        api_core.exceptions = exceptions
        sys.modules.update({"google.api_core": api_core, "google.api_core.exceptions": exceptions})
    if missing("google.cloud.storage"):
        cloud = types.ModuleType("google.cloud")
        storage = types.ModuleType("google.cloud.storage")
        storage.Client = type("Client", (), {})
        cloud.storage = storage
        sys.modules.update({"google.cloud": cloud, "google.cloud.storage": storage})
    if missing("PIL"):
        pil = types.ModuleType("PIL")
        image = types.ModuleType("PIL.Image")
        pil.Image = image
        sys.modules.update({"PIL": pil, "PIL.Image": image})
    if missing("httpx"):
        httpx = types.ModuleType("httpx")
        httpx.Client = type("Client", (), {
            "__init__": lambda self, **k: None,
            "__enter__": lambda self: self,
            "__exit__": lambda self, *a: False,
        })
        httpx.HTTPError = type("HTTPError", (Exception,), {})
        sys.modules["httpx"] = httpx


_stub_missing_cloud_deps()

import pipeline  # noqa: E402  (must follow the dependency stubs above)

PASS = 0


def check(label: str, cond: bool) -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  ok  {label}")
    else:
        print(f"FAIL  {label}")
        sys.exit(1)


PNG = b"\x89PNG\r\n\x1a\nfake-bytes"


def _response(payload: dict, status: int = 200):
    """Minimal stand-in for the httpx.Response surface pipeline.py touches."""
    return types.SimpleNamespace(
        status_code=status,
        json=lambda: payload,
        raise_for_status=lambda: None,
    )


def image_payload():
    return {
        "candidates": [
            {"content": {"parts": [{"inlineData": {"data": base64.b64encode(PNG).decode()}}]}}
        ]
    }


def empty_payload(reason: str | None = "IMAGE_SAFETY"):
    candidate: dict = {"content": {"parts": []}}
    if reason is not None:
        candidate["finishReason"] = reason
    return {"candidates": [candidate]}


def run(responses: list[dict], attempts: int = 3):
    """Drive generate_reference_image against a scripted response sequence.
    Returns (result_or_exception, number_of_calls_made)."""
    calls = {"n": 0}

    def fake_post(client, url, *, json_body, headers, attempts=3):
        i = calls["n"]
        calls["n"] += 1
        return _response(responses[min(i, len(responses) - 1)])

    # The endpoint URL is built from the ambient project id; any value works
    # here because the POST itself is patched out.
    os.environ.setdefault("GOOGLE_CLOUD_PROJECT", "test-project")

    original_post = pipeline._post_with_retry
    original_token = pipeline._access_token
    original_attempts = pipeline._IMAGE_ATTEMPTS
    original_sleep = pipeline.time.sleep
    pipeline._post_with_retry = fake_post
    pipeline._access_token = lambda: "test-token"
    pipeline._IMAGE_ATTEMPTS = attempts
    pipeline.time.sleep = lambda _s: None
    try:
        return pipeline.generate_reference_image("a red varsity jacket", "outerwear"), calls["n"]
    except Exception as exc:  # returned so the caller can assert on it
        return exc, calls["n"]
    finally:
        pipeline._post_with_retry = original_post
        pipeline._access_token = original_token
        pipeline._IMAGE_ATTEMPTS = original_attempts
        pipeline.time.sleep = original_sleep


print("reference-image re-roll")

# A healthy first answer must not cost extra calls.
result, n = run([image_payload()])
check("a first-try image is returned as-is", isinstance(result, tuple) and result[0] == PNG)
check("a first-try image costs exactly one call", n == 1)

# The defect this fixes: one empty 200 used to end the job.
result, n = run([empty_payload(), image_payload()])
check("an empty 200 re-rolls instead of failing the job", isinstance(result, tuple) and result[0] == PNG)
check("the re-roll is a second call, not a silent give-up", n == 2)

# Two bad draws in a row still recover inside the attempt budget.
result, n = run([empty_payload(), empty_payload("RECITATION"), image_payload()])
check("recovers on the third attempt", isinstance(result, tuple) and result[0] == PNG)
check("uses all three attempts when it needs them", n == 3)

# Persistent refusal must still fail loudly, carrying the reason.
result, n = run([empty_payload("IMAGE_SAFETY")])
check("a model that never draws still raises", isinstance(result, RuntimeError))
check("the error names the attempt count", "3 attempts" in str(result))
check("the error carries the last finishReason", "IMAGE_SAFETY" in str(result))
check("it does not retry forever", n == 3)

# A missing finishReason must not crash the error path.
result, _ = run([empty_payload(None)])
check("a missing finishReason degrades to a readable message",
      isinstance(result, RuntimeError) and "no finishReason" in str(result))

# The budget is configurable and honoured.
result, n = run([empty_payload()], attempts=1)
check("attempts=1 disables the re-roll", isinstance(result, RuntimeError) and n == 1)

print(f"\nall {PASS} checks passed")
