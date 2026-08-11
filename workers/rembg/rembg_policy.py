"""Pure request policy for the rembg worker: model-name resolution, caller-error
typing, and in-memory task retention.

Deliberately stdlib-only (no FastAPI, no PIL, no onnxruntime, no google-cloud),
so every rule here can be exercised without the ONNX weights or GCP credentials:

    python3 workers/rembg/test_rembg_policy.py

The same file runs as a gate inside the Docker build (see Dockerfile).
"""

from __future__ import annotations

from typing import Iterable

# Canonical rembg model names. The friendly aliases keep the public API contract
# stable for callers that still send "rmbg2" / "isnet" (names this service
# advertised before it ran on rembg); both resolve to rembg's general-purpose
# model. api/forge-rembg.js still accepts and forwards them.
CANONICAL_MODELS = ("u2net", "isnet-general-use", "u2net_human_seg", "silueta")
DEFAULT_MODEL = "isnet-general-use"
MODEL_ALIASES = {
    "rmbg2": DEFAULT_MODEL,
    "isnet": DEFAULT_MODEL,
}

# A task is terminal once it reaches one of these; anything else is still in
# flight and is never evicted, however old it looks.
TERMINAL_STATUSES = ("done", "failed")

# How long a finished task stays pollable, and the hard ceiling on the task map.
# The service runs with min-instances=1, so an instance lives for weeks and an
# unbounded dict is a slow leak. Callers poll for seconds, so an hour is orders
# of magnitude more than any client needs.
TASK_RETENTION_S = 3600.0
MAX_TASKS = 2000


class SourceImageError(ValueError):
    """The caller's image could not be fetched or decoded.

    Carries a message that is safe and useful to hand back: the fault is in the
    submitted URL or file, not in this service, so answering with an opaque
    "internal error (ref ...)" would send the caller looking in the wrong place.
    """


def canonical_model(name: str, fallback: str = DEFAULT_MODEL) -> str:
    """Resolve a caller-supplied model name to a name rembg actually knows.

    Unknown names fall back rather than 400, because a background-removal call
    with a stale model name still has an obviously right thing to do.
    """
    resolved = (name or "").strip()
    resolved = MODEL_ALIASES.get(resolved, resolved)
    return resolved if resolved in CANONICAL_MODELS else fallback


def prune_tasks(
    tasks: dict,
    now: float,
    retention_s: float = TASK_RETENTION_S,
    max_tasks: int = MAX_TASKS,
) -> list:
    """Evict finished tasks from ``tasks`` in place. Returns the evicted ids.

    Two rules, in order: drop anything terminal that finished longer ago than
    ``retention_s``, then, if the map is still over ``max_tasks``, drop the
    oldest terminal tasks until it fits. Queued and running tasks are never
    dropped, so a burst of slow work can push the map past the ceiling rather
    than lose a job someone is still waiting on.
    """
    finished = [
        (task.get("finished_at", now), task_id)
        for task_id, task in tasks.items()
        if task.get("status") in TERMINAL_STATUSES
    ]
    finished.sort()

    expired = {task_id for finished_at, task_id in finished if now - finished_at >= retention_s}
    evictable = [task_id for _, task_id in finished if task_id not in expired]
    overflow = len(tasks) - len(expired) - max_tasks

    removed = [task_id for _, task_id in finished if task_id in expired]
    if overflow > 0:
        removed.extend(evictable[:overflow])
    for task_id in removed:
        tasks.pop(task_id, None)
    return removed


def gpu_providers(available: Iterable[str]) -> list:
    """The accelerated ONNX Runtime providers present in ``available``.

    rembg runs on ONNX Runtime, so the providers this build ships are the honest
    answer to "is this instance accelerated". The CPU build also advertises
    AzureExecutionProvider, which is not acceleration, so match by name.
    """
    accelerated = (
        "CUDAExecutionProvider",
        "TensorrtExecutionProvider",
        "ROCMExecutionProvider",
        "MIGraphXExecutionProvider",
        "DmlExecutionProvider",
        "CoreMLExecutionProvider",
    )
    return [name for name in available if name in accelerated]
