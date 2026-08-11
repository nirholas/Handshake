"""Core-path smoke test for the LongCat avatar service.

    python3 workers/longcat/test_app_smoke.py

Imports the real FastAPI app and drives its handlers directly. No GPU, no model
weights, and no GCP credentials: the handlers under test all short-circuit
before touching Firestore or Cloud Storage, which is itself part of what is
being asserted. Runs as a Docker build gate, so the image cannot ship with a
broken import, a missing route, or an auth regression.

What it proves:
  * main.py imports and its config validation works;
  * /health reports the weights state instead of claiming a model is loaded;
  * both authed routes reject a missing, malformed, or wrong bearer token with
    401 (not the 422 that FastAPI's required-Header form produced);
  * /generate refuses with 503 while weights are unstaged, and refuses BEFORE
    creating a Firestore job document, so a misconfigured instance cannot leave
    a trail of jobs that can never run;
  * an unsupported RESOLUTION fails at boot rather than 40 minutes into a job.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import tempfile
from pathlib import Path

API_KEY = "test-key-not-a-real-secret"

# main.py reads these at import time. Set them outright rather than defaulting,
# so the assertions below hold whatever the ambient environment carries. The
# WEIGHTS_DIR points at an empty directory so the unstaged-weights paths are the
# ones exercised.
_EMPTY_WEIGHTS = tempfile.mkdtemp(prefix="longcat_test_weights_")
os.environ["API_KEY"] = API_KEY
os.environ["GCS_BUCKET"] = "test-bucket"
os.environ["FIRESTORE_PROJECT"] = "test-project"
os.environ["WEIGHTS_DIR"] = _EMPTY_WEIGHTS
os.environ.pop("RESOLUTION", None)

from fastapi import BackgroundTasks, HTTPException  # noqa: E402

import main  # noqa: E402

PASS = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS
    if not condition:
        print(f"FAIL  {name}  {detail}")
        sys.exit(1)
    PASS += 1


def status_of(coro) -> int:
    """Run ``coro`` and return the HTTPException status it raises."""
    try:
        asyncio.run(coro)
    except HTTPException as exc:
        return exc.status_code
    return 0


def generate_call(authorization):
    return main.generate(
        main.GenerateRequest(
            image_url="https://three.ws/a.png",
            audio_url="https://three.ws/a.wav",
        ),
        BackgroundTasks(),
        authorization=authorization,
    )


# ── config ─────────────────────────────────────────────────────────────────────

check("the default resolution is supported", main.RESOLUTION in main.SUPPORTED_RESOLUTIONS)
check("concurrency is at least 1", main.MAX_CONCURRENT >= 1)
check("the segment cap is at least 1", main.MAX_SEGMENTS >= 1)
check(
    "the checkpoint dir is the avatar repo under the weights root",
    main.CHECKPOINT_DIR == Path(_EMPTY_WEIGHTS) / "LongCat-Video-Avatar-1.5",
    str(main.CHECKPOINT_DIR),
)
check(
    "the base model dir is its sibling",
    main.BASE_MODEL_DIR == Path(_EMPTY_WEIGHTS) / "LongCat-Video",
    str(main.BASE_MODEL_DIR),
)
check(
    "the inference entrypoint is upstream's single-audio avatar demo",
    main.INFERENCE_SCRIPT == "run_demo_avatar_single_audio_to_video.py",
)


# ── /health ────────────────────────────────────────────────────────────────────

health = asyncio.run(main.health())
check("health is unauthenticated and answers", health.get("ok") is True)
check("health names the pipeline", health.get("pipeline") == "longcat-avatar-1.5")
check(
    "health does not claim a model is loaded when weights are absent",
    health.get("model_loaded") is False,
    str(health),
)
check(
    "health lists what is missing so an operator can act",
    isinstance(health.get("missing_weights"), list) and len(health["missing_weights"]) > 0,
    str(health.get("missing_weights")),
)
check("health reports the resolution", health.get("resolution") == main.RESOLUTION)
check("health reports the segment cap", health.get("max_segments") == main.MAX_SEGMENTS)


# ── auth ───────────────────────────────────────────────────────────────────────

for label, header in (
    ("a missing header", None),
    ("an empty header", ""),
    ("a non-bearer scheme", f"Basic {API_KEY}"),
    ("a bare token", API_KEY),
    ("a wrong key", "Bearer wrong-key"),
    ("an empty bearer", "Bearer "),
):
    check(
        f"/generate rejects {label} with 401",
        status_of(generate_call(header)) == 401,
        f"got {status_of(generate_call(header))}",
    )
    check(
        f"/jobs rejects {label} with 401",
        status_of(main.get_job("some-job", authorization=header)) == 401,
    )


# ── /generate with weights unstaged ────────────────────────────────────────────

# A valid key gets past auth and lands on the weights gate. If this ever returns
# 401 the key comparison broke; if it returns 500 the handler reached Firestore,
# which has no credentials here, and the ordering regressed.
check(
    "a valid key past the weights gate answers 503",
    status_of(generate_call(f"Bearer {API_KEY}")) == 503,
    f"got {status_of(generate_call(f'Bearer {API_KEY}'))}",
)

# The gate must run before the job document is written. main._set_job would
# raise AttributeError on the None client if it were reached, so a 503 here is
# proof the Firestore write never happened.
check("the weights gate precedes any Firestore write", main._db is None)


# ── boot-time config validation ────────────────────────────────────────────────

def import_with(env: dict) -> subprocess.CompletedProcess:
    child_env = {**os.environ, **env}
    return subprocess.run(
        [sys.executable, "-c", "import main"],
        cwd=str(Path(__file__).resolve().parent),
        env=child_env,
        capture_output=True,
        text=True,
    )


bad = import_with({"RESOLUTION": "1080p"})
check("an unsupported resolution fails at import", bad.returncode != 0, bad.stderr[-400:])
check(
    "the failure names the offending value",
    "1080p" in bad.stderr,
    bad.stderr[-400:],
)

good = import_with({"RESOLUTION": "480p"})
check("480p is accepted at import", good.returncode == 0, good.stderr[-400:])

for missing_var in ("API_KEY", "GCS_BUCKET", "FIRESTORE_PROJECT"):
    child_env = {k: v for k, v in os.environ.items() if k != missing_var}
    result = subprocess.run(
        [sys.executable, "-c", "import main"],
        cwd=str(Path(__file__).resolve().parent),
        env=child_env,
        capture_output=True,
        text=True,
    )
    check(
        f"a missing {missing_var} fails at import",
        result.returncode != 0,
        result.stderr[-200:],
    )

print(f"OK  {PASS} app smoke checks passed")
