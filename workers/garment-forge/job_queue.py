"""Durable job-queue policy: who may run a job, and what to do with one whose
instance vanished. Pure functions over the job record, no GCS and no FastAPI,
so the rules are unit-testable without any cloud dependency (test_job_queue.py,
also a Docker build gate).

Why this exists
---------------
garment-forge is a scale-to-zero Cloud Run service with MAX_CONCURRENT jobs per
instance. Submitting a batch used to hand every job to that instance's FastAPI
background queue: the jobs past the concurrency limit sat on a semaphore in
memory, and when Cloud Run reclaimed the instance (idle scale-down or a
revision rollout) they disappeared, leaving their durable records stuck at
"queued" until a watchdog buried them. That is exactly what happened to 12 of
22 pieces in the 2026-07-26 catalog batch.

The rule that fixes it: a job's RECORD is the queue, and work is CLAIMED at
execution time by a live instance holding a concurrency slot. Anything not
claimed, or claimed by an instance that then died, is recoverable by any other
instance (POST /sweep, or the drain that runs when a slot frees).
"""

from __future__ import annotations

from datetime import datetime, timezone

# Statuses that mean "this job still owes work".
PENDING_STATUSES = ("queued", "running")


def _age_seconds(job: dict, now: datetime) -> float | None:
    """Seconds since the record last advanced, or None if it carries no
    parseable timestamp (which we treat as 'infinitely stale': a record we
    cannot date must not be able to pin a job forever)."""
    try:
        updated = datetime.fromisoformat(job.get("updated_at", ""))
    except ValueError:
        return None
    if updated.tzinfo is None:
        updated = updated.replace(tzinfo=timezone.utc)
    return (now - updated).total_seconds()


def claimable(job: dict, now: datetime, stale_s: float, max_attempts: int) -> bool:
    """True when a live instance may take ownership of this job.

    Claimable: a queued job (nobody owns it), or a running job whose owner has
    not advanced a stage within `stale_s` (its instance is gone). Never
    claimable: terminal jobs, and jobs that already burned `max_attempts`.
    """
    if job.get("status") not in PENDING_STATUSES:
        return False
    if int(job.get("attempts", 0)) >= max_attempts:
        return False
    if job.get("status") == "queued":
        return True
    age = _age_seconds(job, now)
    return age is None or age > stale_s


def claim_fields(job: dict, owner: str, now: datetime) -> dict:
    """The mutation that takes ownership: mark running, count the attempt, and
    stamp the owner so logs attribute a job to a specific instance."""
    return {
        "status": "running",
        "stage": "claimed",
        "attempts": int(job.get("attempts", 0)) + 1,
        "owner": owner,
        "updated_at": now.isoformat(),
    }


def stale_action(job: dict, now: datetime, stale_s: float,
                 max_attempts: int) -> str | None:
    """What the read-path watchdog should do with this record.

    Returns "requeue" (lost its instance but has attempts left, so hand it
    back to the queue), "fail" (out of attempts: terminal, stop polling), or
    None (healthy or already terminal, leave it alone).
    """
    if job.get("status") not in PENDING_STATUSES:
        return None
    age = _age_seconds(job, now)
    if age is not None and age <= stale_s:
        return None
    return "requeue" if int(job.get("attempts", 0)) < max_attempts else "fail"
