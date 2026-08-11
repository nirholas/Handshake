"""Unit tests for the pure request policy (rembg_policy.py): model-name
resolution, caller-error typing, task retention. Stdlib only, no ONNX weights,
no GCS, no FastAPI. Runs locally and as a Docker build gate:

    python3 workers/rembg/test_rembg_policy.py

These pin the rules the service is easy to break silently: an alias that stops
resolving turns every "rmbg2" request into a different model, and a retention
bug either leaks the task map forever (the service runs with min-instances=1,
so an instance lives for weeks) or evicts a job someone is still polling.
"""

from __future__ import annotations

import sys

from rembg_policy import (
    CANONICAL_MODELS,
    DEFAULT_MODEL,
    MAX_TASKS,
    SourceImageError,
    canonical_model,
    gpu_providers,
    prune_tasks,
)

PASS = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS
    if not condition:
        print(f"FAIL  {name}  {detail}")
        sys.exit(1)
    PASS += 1
    print(f"ok    {name}")


def task(status: str, finished_at: float = None, created_at: float = 0.0) -> dict:
    entry = {"status": status, "created_at": created_at}
    if finished_at is not None:
        entry["finished_at"] = finished_at
    return entry


# ── model resolution ────────────────────────────────────────────────────────

for name in CANONICAL_MODELS:
    check(f"canonical name survives: {name}", canonical_model(name) == name)

check("legacy alias rmbg2 resolves", canonical_model("rmbg2") == "isnet-general-use")
check("legacy alias isnet resolves", canonical_model("isnet") == "isnet-general-use")
check("whitespace is trimmed", canonical_model("  u2net  ") == "u2net")
check("unknown name falls back", canonical_model("segment-anything") == DEFAULT_MODEL)
check("empty name falls back", canonical_model("") == DEFAULT_MODEL)
check("None falls back", canonical_model(None) == DEFAULT_MODEL)
check("caller fallback is honored", canonical_model("nope", fallback="silueta") == "silueta")
# MODEL=rmbg2 is what the deployed Cloud Run service sets; it must not select a
# model rembg has never heard of.
check("prod MODEL env resolves to a real model",
      canonical_model("rmbg2") in CANONICAL_MODELS)

# ── task retention ──────────────────────────────────────────────────────────

tasks = {
    "fresh-done": task("done", finished_at=1000.0),
    "old-done": task("done", finished_at=100.0),
    "old-failed": task("failed", finished_at=90.0),
    "running": task("running"),
    "queued": task("queued"),
}
removed = prune_tasks(tasks, now=1010.0, retention_s=600.0, max_tasks=100)
check("expired terminal tasks are dropped", set(removed) == {"old-done", "old-failed"}, str(removed))
check("recent terminal task is retained", "fresh-done" in tasks)
check("running task is never dropped", "running" in tasks)
check("queued task is never dropped", "queued" in tasks)

# A finished task stays pollable for the whole retention window: the forge polls
# for seconds, but a client that reconnects must still find its result.
tasks = {"done-1": task("done", finished_at=1000.0)}
check("nothing evicted inside the window", prune_tasks(tasks, now=1599.0, retention_s=600.0) == [])
check("evicted at the window edge", prune_tasks(tasks, now=1600.0, retention_s=600.0) == ["done-1"])

# Overflow: oldest finished first, and only as many as the ceiling requires.
tasks = {f"done-{i}": task("done", finished_at=float(i)) for i in range(10)}
removed = prune_tasks(tasks, now=10.0, retention_s=10_000.0, max_tasks=6)
check("overflow drops exactly the excess", len(removed) == 4, str(removed))
check("overflow drops the oldest", set(removed) == {"done-0", "done-1", "done-2", "done-3"}, str(removed))
check("survivors are the newest", set(tasks) == {f"done-{i}" for i in range(4, 10)})

# In-flight work outweighs the ceiling: better a temporarily larger map than a
# job that vanishes from under a poller.
tasks = {f"run-{i}": task("running") for i in range(5)}
check("in-flight work is never evicted for the cap",
      prune_tasks(tasks, now=10.0, retention_s=1.0, max_tasks=2) == [])
check("in-flight tasks all survive", len(tasks) == 5)

# A terminal task written before finished_at existed (an instance mid-rollout)
# is treated as finished now, not as infinitely old.
tasks = {"legacy": {"status": "done"}}
check("missing finished_at is not treated as expired",
      prune_tasks(tasks, now=10_000.0, retention_s=600.0) == [])

check("default ceiling is a real number", isinstance(MAX_TASKS, int) and MAX_TASKS > 0)

# ── accelerator reporting ───────────────────────────────────────────────────

check("CPU-only build reports no GPU",
      gpu_providers(["AzureExecutionProvider", "CPUExecutionProvider"]) == [])
check("CUDA build reports the GPU provider",
      gpu_providers(["CUDAExecutionProvider", "CPUExecutionProvider"]) == ["CUDAExecutionProvider"])
check("empty provider list is not a GPU", gpu_providers([]) == [])

# ── caller-error typing ─────────────────────────────────────────────────────

check("SourceImageError is a ValueError", issubclass(SourceImageError, ValueError))
check("SourceImageError carries its message",
      str(SourceImageError("the image URL returned HTTP 403")) == "the image URL returned HTTP 403")

print(f"\n{PASS} checks passed")
