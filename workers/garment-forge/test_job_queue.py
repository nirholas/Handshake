"""Unit tests for the durable job-queue policy (job_queue.py): pure dict rules,
no GCS, no FastAPI. Runs locally and as a Docker build gate:

    python3 workers/garment-forge/test_job_queue.py

These pin the behaviour that fixes the 2026-07-26 batch loss, where 12 of 22
jobs died in a reclaimed instance's in-memory queue while their durable records
sat at "queued" until a watchdog buried them.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone

from job_queue import claim_fields, claimable, stale_action

STALE_S = 2700.0
MAX_ATTEMPTS = 3
NOW = datetime(2026, 7, 27, 12, 0, 0, tzinfo=timezone.utc)

PASS = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS
    if not condition:
        print(f"FAIL  {name}  {detail}")
        sys.exit(1)
    PASS += 1
    print(f"ok    {name}")


def job(**fields) -> dict:
    base = {
        "job_id": "j1",
        "status": "queued",
        "stage": "queued",
        "attempts": 0,
        "updated_at": NOW.isoformat(),
    }
    base.update(fields)
    return base


def aged(seconds: float, **fields) -> dict:
    return job(updated_at=(NOW - timedelta(seconds=seconds)).isoformat(), **fields)


# ── claimable ───────────────────────────────────────────────────────────────

# The core of the fix: a job left queued by a reclaimed instance is claimable
# by ANY live instance, immediately, without waiting out the stale window.
check("fresh queued job is claimable",
      claimable(job(), NOW, STALE_S, MAX_ATTEMPTS))
check("old queued job is claimable",
      claimable(aged(9999), NOW, STALE_S, MAX_ATTEMPTS))

# A job actively advancing on another instance must never be stolen: that
# would run the same pipeline twice and publish duplicate catalog entries.
check("running job inside the stale window is NOT claimable",
      not claimable(job(status="running", stage="mesh"), NOW, STALE_S, MAX_ATTEMPTS))
check("running job just under the window is NOT claimable",
      not claimable(aged(STALE_S - 1, status="running", stage="mesh"),
                    NOW, STALE_S, MAX_ATTEMPTS))
check("running job past the window IS claimable (its instance is gone)",
      claimable(aged(STALE_S + 1, status="running", stage="mesh"),
                NOW, STALE_S, MAX_ATTEMPTS))

# Terminal jobs are never re-run: a published garment must not be republished.
for terminal in ("done", "failed"):
    check(f"{terminal} job is not claimable",
          not claimable(job(status=terminal), NOW, STALE_S, MAX_ATTEMPTS))

# Runaway protection: a job that keeps killing its instance stops consuming
# capacity instead of looping forever.
check("job at max attempts is not claimable",
      not claimable(job(attempts=MAX_ATTEMPTS), NOW, STALE_S, MAX_ATTEMPTS))
check("job one below max attempts is still claimable",
      claimable(job(attempts=MAX_ATTEMPTS - 1), NOW, STALE_S, MAX_ATTEMPTS))

# An undateable record must not pin a job forever.
check("running job with unparseable timestamp is claimable",
      claimable(job(status="running", updated_at="not-a-date"),
                NOW, STALE_S, MAX_ATTEMPTS))

# Records written before this feature shipped carry no `attempts` key.
check("legacy record without attempts is claimable",
      claimable({"job_id": "old", "status": "queued", "updated_at": NOW.isoformat()},
                NOW, STALE_S, MAX_ATTEMPTS))

# ── claim_fields ────────────────────────────────────────────────────────────

fields = claim_fields(job(attempts=1), "rev-7:abc", NOW)
check("claim marks running", fields["status"] == "running", str(fields))
check("claim counts the attempt", fields["attempts"] == 2, str(fields))
check("claim records the owner", fields["owner"] == "rev-7:abc", str(fields))
check("claim stamps the time", fields["updated_at"] == NOW.isoformat(), str(fields))
check("claim of a legacy record starts attempts at 1",
      claim_fields({"job_id": "old"}, "o", NOW)["attempts"] == 1)

# ── stale_action ────────────────────────────────────────────────────────────

check("healthy running job needs no action",
      stale_action(job(status="running"), NOW, STALE_S, MAX_ATTEMPTS) is None)
check("done job needs no action",
      stale_action(job(status="done"), NOW, STALE_S, MAX_ATTEMPTS) is None)
# The behaviour change: losing an instance requeues rather than buries.
check("stale job with attempts left is requeued, not failed",
      stale_action(aged(STALE_S + 1, status="running", attempts=1),
                   NOW, STALE_S, MAX_ATTEMPTS) == "requeue")
check("stale job out of attempts fails terminally",
      stale_action(aged(STALE_S + 1, status="running", attempts=MAX_ATTEMPTS),
                   NOW, STALE_S, MAX_ATTEMPTS) == "fail")
check("a queued job that never got picked up is requeued (harmless no-op)",
      stale_action(aged(STALE_S + 1), NOW, STALE_S, MAX_ATTEMPTS) == "requeue")

# Naive timestamps (no tzinfo) must not raise; they are read as UTC.
check("naive timestamp is treated as UTC, not a crash",
      stale_action({"job_id": "n", "status": "running", "attempts": 0,
                    "updated_at": (NOW - timedelta(seconds=STALE_S + 1))
                    .replace(tzinfo=None).isoformat()},
                   NOW, STALE_S, MAX_ATTEMPTS) == "requeue")

print(f"\nall {PASS} checks passed")
