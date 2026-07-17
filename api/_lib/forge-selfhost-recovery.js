// @ts-check
// Self-host (GCP worker) poll recovery — the fix for the platform's single
// largest generation-failure class.
//
// Evidence (forge_creations, 7-day window): image→3D failed ~48% of the time,
// and 410 of 425 `trellis_selfhost` failures were the literal string
// "task not found on gcp service" — a 404 from the worker's /tasks/:id or
// /jobs/:id poll. Every one of those was on path='image'.
//
// Why a 404 is NOT a real failure (usually):
// The worker persists each task's `queued` state to GCS synchronously before
// returning its 202, and every poll re-reads GCS for non-terminal records
// (workers/model-trellis/main.py `_resolve_task`). So a 404 means the durable
// record is not visible to the instance this poll happened to land on. With the
// worker at containerConcurrency 80 / maxScale 3 and no session affinity, a poll
// fired seconds after submit can hit a different instance before the just-written
// record is consistently readable, or a completion write can be racing. Treating
// that first 404 as terminal — which the router did — throws away a job that is
// almost always fine, then burns a failover hop recovering it.
//
// The rule the rest of the forge already follows (see the NVCF recovery in
// api/forge.js `pollNvidiaStatus`): never dead-end on a RECOVERABLE signal.
// This module is the GCP twin of that decision, kept pure so the grace/terminal
// state machine is unit-testable without a worker or a DB.
//
// Decision, given a 404-class ("gcp_task_missing") poll result:
//   1. Store re-check — if the creation row already materialized (done + a glb),
//      a racing poll or the worker's completion write beat us; that's a success.
//   2. Grace window — if the job is younger than GRACE, the 404 is the
//      post-submit cross-instance/visibility window; report `running` so the
//      client keeps polling. The durable record resolves within seconds.
//   3. Terminal — past the window a still-missing task is genuinely orphaned
//      (its runner instance died mid-job); surface the failure so the poll
//      handler's lane failover redispatches to a healthy lane.
//
// GRACE is 90s: comfortably covers the post-submit visibility window and a cold
// instance, while leaving the client's ~300s poll budget room for a failover
// hop plus a real generation if the task is truly lost.

export const GCP_TASK_MISSING_GRACE_MS = 90_000;

// The recoverable code the GCP provider tags onto a 404 result (api/_providers/
// gcp.js). Matching on a code, not the human error string, keeps the operator-
// facing message free to change without breaking recovery.
export const GCP_TASK_MISSING_CODE = 'gcp_task_missing';

/**
 * Decide what a "task not found" (404-class) self-host poll should become.
 * Pure: no clock, no I/O — the caller supplies the resolved row and the job age.
 *
 * @param {{
 *   code?: string,
 *   row?: { status?: string, glb_url?: string|null } | null,
 *   ageMs?: number,
 *   graceMs?: number,
 * }} input
 * @returns {{ action: 'passthrough' } | { action: 'done', glbUrl: string }
 *   | { action: 'running' } | { action: 'fail' }}
 *   - passthrough: not the recoverable class; use the provider result unchanged.
 *   - done: a durable result already exists; resolve the job as complete.
 *   - running: within grace; keep the client polling.
 *   - fail: genuinely lost; let the caller surface failure + failover.
 */
export function decideSelfhostMissing({ code, row, ageMs, graceMs = GCP_TASK_MISSING_GRACE_MS } = {}) {
	if (code !== GCP_TASK_MISSING_CODE) return { action: 'passthrough' };

	// A racing poll or the worker's own completion write already materialized the
	// mesh — the 404 we just got is stale. That's a success, not a loss.
	if (row && row.status === 'done' && row.glb_url) {
		return { action: 'done', glbUrl: row.glb_url };
	}

	// Young job: the durable record is written but not yet visible to the instance
	// this poll reached. Keep waiting; the next poll resolves it.
	if (Number.isFinite(ageMs) && /** @type {number} */ (ageMs) < graceMs) {
		return { action: 'running' };
	}

	// Old enough (or age unknowable): a still-missing task is orphaned. Surface
	// the failure so lane failover can redispatch.
	return { action: 'fail' };
}
