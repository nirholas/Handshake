// @ts-check
// Forge generation success-rate sensor — the outcome signal that was missing,
// the twin of x402-settle-health.js for 3D generation.
//
// subsystem-health already reports forge lane LIVENESS (forge-lane-health.js:
// "can our GPU workers serve a generation right now, are they warm?"). But a
// live, warm lane can still FAIL generations — from 2026-07-09 the self-host
// image→3D lane failed ~48% of the time (task-not-found poll losses) while every
// liveness probe read healthy. That is the same blind spot the x402 rail had:
// "armed" is not "succeeding". This sensor reads the actual outcome ledger
// (forge_creations) and reports the generation SUCCESS RATE, so a failure burst
// pages instead of hiding.
//
// Metric: done / (done + failed) over a rolling window. Still-running and queued
// rows are excluded (not yet an outcome), and so are attempts that were
// automatically re-dispatched to another lane (`superseded_by IS NOT NULL`):
// the successor row carries that same request to its real outcome, so counting
// the attempt too would page on the failover machinery working. Measured on
// 2026-08-14, 13 of the 14 trellis_selfhost orphan failures in the prior week
// were recovered that way and every one of them counted against the lane here. The window is 6h because forge volume
// is modest (~7 image jobs/hour) — long enough to carry a judge-able sample and
// smooth the bursty failure pattern, short enough to surface a sustained
// regression. Below MIN_ATTEMPTS the verdict is `unknown` (neutral, never pages).
//
// The detail names WHERE the failures concentrate — the worst backend/path and
// the top error class — so a page is actionable, not just "generation is bad".
//
// Consumed via gatherSubsystemHealth() → /api/healthz, /status, and the
// uptime-cron escalation (pages on first sight, re-pages hourly, clears on
// recovery). No new cron, no new alert path.

const WINDOW_INTERVAL = '6 hours';
// Forge runs ~7 image jobs/hour; 15 outcomes in 6h is a trustworthy sample
// without letting a quiet stretch read as an outage.
const MIN_ATTEMPTS = 15;

// Rate bands. 3D generation legitimately fails sometimes (hard prompts/images),
// so the healthy bar is not 100%: ok ≥ 85%, degraded 60–85%, down < 60%. The
// 2026-07 image burst (~52% success) reads `down`; a 77% day reads `degraded`.
const OK_RATE = 0.85;
const DOWN_RATE = 0.6;

/**
 * Classify pre-aggregated forge outcome buckets into a subsystem verdict. Pure —
 * no DB, no clock — so thresholds and the failure-attribution are unit-testable
 * against the exact bucket shape the DB returns.
 * @param {Array<{ status: string, backend: string, path: string, reason: string, n: number }>} buckets
 * @param {{ minAttempts?: number }} [opts]
 * @returns {{ status: 'ok'|'degraded'|'down'|'unknown', done: number, failed: number,
 *   attempts: number, rate: number|null, worstBackend: {backend:string,failed:number}|null,
 *   worstPath: {path:string,failed:number}|null, topReason: {reason:string,n:number}|null,
 *   detail: string, hint?: string }}
 */
export function classifyForgeBuckets(buckets, { minAttempts = MIN_ATTEMPTS } = {}) {
	let done = 0;
	let failed = 0;
	/** @type {Record<string, number>} */ const failByBackend = {};
	/** @type {Record<string, number>} */ const failByPath = {};
	/** @type {Record<string, number>} */ const failByReason = {};
	for (const b of Array.isArray(buckets) ? buckets : []) {
		const n = Number(b?.n) || 0;
		if (n <= 0) continue;
		if (b.status === 'done') {
			done += n;
		} else if (b.status === 'failed') {
			failed += n;
			failByBackend[b.backend || '(none)'] = (failByBackend[b.backend || '(none)'] || 0) + n;
			failByPath[b.path || '(none)'] = (failByPath[b.path || '(none)'] || 0) + n;
			if (b.reason && b.reason !== 'none') failByReason[b.reason] = (failByReason[b.reason] || 0) + n;
		}
		// Any other status (running/queued/…) is not yet an outcome — ignored.
	}
	const attempts = done + failed;
	const top = (m) => {
		const e = Object.entries(m).sort((a, b) => b[1] - a[1])[0];
		return e ? { key: e[0], n: e[1] } : null;
	};
	const wBackend = top(failByBackend);
	const wPath = top(failByPath);
	const wReason = top(failByReason);
	const worstBackend = wBackend ? { backend: wBackend.key, failed: wBackend.n } : null;
	const worstPath = wPath ? { path: wPath.key, failed: wPath.n } : null;
	const topReason = wReason ? { reason: wReason.key, n: wReason.n } : null;

	if (attempts < minAttempts) {
		return {
			status: 'unknown',
			done, failed, attempts, rate: null, worstBackend, worstPath, topReason,
			detail: `only ${attempts} finished generations in ${WINDOW_INTERVAL}, too few to judge`,
		};
	}

	const rate = done / attempts;
	const pct = (rate * 100).toFixed(0);
	const base = `${pct}% success (${done}/${attempts} finished, ${WINDOW_INTERVAL})`;
	if (rate >= OK_RATE) {
		return { status: 'ok', done, failed, attempts, rate, worstBackend, worstPath, topReason, detail: base };
	}
	const status = rate < DOWN_RATE ? 'down' : 'degraded';
	const where = [
		worstPath ? `${worstPath.path} path` : null,
		worstBackend ? `${worstBackend.backend} lane` : null,
		topReason ? `mostly "${topReason.reason}"` : null,
	].filter(Boolean).join(', ');
	return {
		status,
		done, failed, attempts, rate, worstBackend, worstPath, topReason,
		detail: `${base}; ${failed} failed${where ? ` (${where})` : ''}`,
		hint:
			'Generations are failing above the normal rate. Find the concentration: ' +
			'forge_creations carries per-row backend/status/error/path. Check the worst ' +
			'lane above and its worker health; a self-host lane failing on lost-task 404s ' +
			'recovers via _lib/forge-selfhost-recovery.js, a vendor lane via its failover chain.',
	};
}

/**
 * Read the last WINDOW_INTERVAL of forge outcomes and classify them. Fail-soft:
 * a missing DB, absent table, or query error resolves to `unknown` so a health
 * read never throws. Pre-aggregates in SQL (bounded rows) so it is safe on the
 * per-request /api/healthz path.
 * @returns {Promise<{ name: 'forge_generation', label: string, status: string,
 *   detail: string, hint?: string, metrics?: object }>}
 */
export async function gatherForgeHealth() {
	const base = { name: /** @type {const} */ ('forge_generation'), label: 'Forge 3D generation' };
	try {
		const { sql } = await import('../db.js');
		const buckets = /** @type {Array<{ status: string, backend: string, path: string, reason: string, n: number }>} */ (
			await sql`
				SELECT status,
				       COALESCE(backend, '(none)') AS backend,
				       COALESCE(path, '(none)') AS path,
				       COALESCE(NULLIF(split_part(error, ':', 1), ''), 'none') AS reason,
				       count(*)::int AS n
				FROM forge_creations
				WHERE created_at >= now() - ${WINDOW_INTERVAL}::interval
				  AND superseded_by IS NULL
				GROUP BY status, backend, path, reason
			`
		);
		const v = classifyForgeBuckets(buckets);
		return {
			...base,
			status: v.status,
			detail: v.detail,
			...(v.hint ? { hint: v.hint } : {}),
			metrics: {
				windowHours: 6,
				done: v.done,
				failed: v.failed,
				attempts: v.attempts,
				rate: v.rate == null ? null : Math.round(v.rate * 1000) / 1000,
				worstBackend: v.worstBackend,
				worstPath: v.worstPath,
				topReason: v.topReason,
			},
		};
	} catch (err) {
		return { ...base, status: 'unknown', detail: err?.message || 'forge outcome ledger unreadable' };
	}
}
