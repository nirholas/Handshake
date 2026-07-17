// @ts-check
// x402 settle-success-rate sensor — the health signal the July 2026 502 wave
// proved was missing.
//
// The existing checks answer "is the ring ARMED?" (checkRing → invariants,
// checkX402Config → pay-to + fee payer present) and "is discovery UP?"
// (uptime-check probes /.well-known/x402.json). All three read healthy while a
// third of real settlements silently fail: from 2026-07-09 to 2026-07-17 the
// self-facilitator rejected ~300 settles/6h (same-signature collisions surfaced
// as `http_502`) yet every sensor above stayed green because the ring was
// configured, discovery answered 200, and *some* payments still landed. Eight
// days, no page. This module closes that hole by reading the only authoritative
// signal — the outcome the ring records for every paid call in
// `x402_autonomous_log` — and reporting the settle SUCCESS RATE.
//
// What counts, and the nuance that makes the signal usable
// --------------------------------------------------------
// `success=true, amount_atomic>0`  → a settlement LANDED (the numerator).
// A failure only counts against the rate when it is a PAYMENT-RAIL fault:
// facilitator/settle 5xx, a 402 (payment rejected), or an RPC/broadcast/confirm
// fault. Everything else the ring records is deliberately excluded, because the
// log is noisy with things that are NOT settle failures:
//   - caller/endpoint mismatches — http_400/404/405/409 (the ring POSTing to a
//     GET-only endpoint, or passing args a handler rejects). ~800/6h in prod:
//     including them would peg the sensor red and bury a real settle regression.
//   - benign guards — cap_would_exceed, insufficient_payer_usdc, breaker_tripped,
//     wallet_unconfigured, no_solana_accept: the ring CHOOSING not to pay. Ring
//     funding has its own monitor (x402/wallet-balance-monitor.js).
//   - downstream pipeline notes — *_calls_failed, config_missing: the payment
//     settled (or was never attempted); the failure is in value extraction.
// The fault set is an allowlist of rail faults, kept broad on the rail dimension
// (any 5xx, any RPC/broadcast/settle/confirm/simulation/timeout signature) so a
// NEW settle failure mode is caught without a code change — exactly what the 502
// wave needed. When a genuinely new benign reason starts showing up as a fault,
// add it to EXCLUDED_HINT and the caller docs, the same learn-once loop as the
// triage monitor's KNOWN_SIGNATURES.
//
// The window is 3h: the ring settles in bursts (an idle hour can hold zero
// settlements while it waits on funding or a settle-tick), so a short window
// reads `unknown` constantly. 3h reliably carries hundreds of attempts, smooths
// the bursts, and still surfaces a regression within hours — against an 8-day
// blind spot, decisive. Below MIN_ATTEMPTS the verdict is `unknown` (neutral,
// never pages): too little settling to judge is not a fault.
//
// Consumed via gatherSubsystemHealth() → /api/healthz, /api/status, and the
// uptime-check escalation digest (pages on first sight, re-pages hourly, clears
// on recovery) — no new cron, no new alert path.

const WINDOW_INTERVAL = '3 hours';
// Enough settle attempts in-window to trust a rate. The ring runs hundreds/3h
// when active; 20 keeps a genuinely quiet period from reading as an outage.
const MIN_ATTEMPTS = 20;

// Rate bands. Vocabulary matches subsystem-health.js: `degraded` = functional
// but faulting; `down` = not functional. A rail settling ~73% of the time is
// impaired, not dead, so the collapse threshold sits well below that.
const OK_RATE = 0.9;
const DOWN_RATE = 0.5;

// A recorded failure is a SETTLE/PAYMENT-RAIL fault when its reason (the first
// `:`-delimited token of error_msg) matches these. Two rules: any 5xx or a 402,
// and any RPC/broadcast/settle/confirm/simulation/timeout signature.
const RAIL_STATUS = /^http_(5\d\d|402)$/i;
const RAIL_SIGNATURE =
	/broadcast_failed|settle_failed|not_confirmed|simulation|preflight|rpc_|insufficient_source|blockhash|aborted|operation was aborted|timeout/i;

/**
 * Is this reason token a settle/payment-rail fault (vs a caller error, a benign
 * guard, or a downstream note)?
 * @param {string} reason first `:`-token of error_msg
 * @returns {boolean}
 */
export function isRailFault(reason) {
	const r = String(reason || '');
	if (!r || r === 'none') return false;
	return RAIL_STATUS.test(r) || RAIL_SIGNATURE.test(r);
}

/**
 * Classify pre-aggregated settle buckets into a subsystem verdict. Pure — no DB,
 * no clock — so the thresholds and the rail-fault split are unit-testable
 * against the exact bucket shape the DB returns.
 * @param {Array<{ success: boolean, paid: boolean, reason: string, n: number }>} buckets
 * @param {{ minAttempts?: number }} [opts]
 * @returns {{ status: 'ok'|'degraded'|'down'|'unknown', settled: number,
 *   faults: number, attempts: number, rate: number|null,
 *   faultClasses: Array<{ reason: string, n: number }>, detail: string, hint?: string }}
 */
export function classifySettleBuckets(buckets, { minAttempts = MIN_ATTEMPTS } = {}) {
	let settled = 0;
	let faults = 0;
	/** @type {Record<string, number>} */
	const faultBy = {};
	for (const b of Array.isArray(buckets) ? buckets : []) {
		const n = Number(b?.n) || 0;
		if (n <= 0) continue;
		if (b.success && b.paid) {
			settled += n;
		} else if (!b.success && isRailFault(b.reason)) {
			faults += n;
			faultBy[b.reason] = (faultBy[b.reason] || 0) + n;
		}
	}
	const attempts = settled + faults;
	const faultClasses = Object.entries(faultBy)
		.map(([reason, n]) => ({ reason, n }))
		.sort((a, b) => b.n - a.n);

	if (attempts < minAttempts) {
		return {
			status: 'unknown',
			settled, faults, attempts, rate: null, faultClasses,
			detail: `only ${attempts} settle attempts in ${WINDOW_INTERVAL} — too few to judge`,
		};
	}

	const rate = settled / attempts;
	const pct = (rate * 100).toFixed(1);
	const topFaults = faultClasses
		.slice(0, 3)
		.map((f) => `${f.reason}×${f.n}`)
		.join(', ');
	const base = `settle ${pct}% (${settled}/${attempts} paid attempts, ${WINDOW_INTERVAL})`;

	if (rate >= OK_RATE) {
		return { status: 'ok', settled, faults, attempts, rate, faultClasses, detail: base };
	}
	const status = rate < DOWN_RATE ? 'down' : 'degraded';
	return {
		status,
		settled, faults, attempts, rate, faultClasses,
		detail: `${base}; ${faults} rail faults${topFaults ? ` (${topFaults})` : ''}`,
		hint:
			'Payments are being rejected at settle. Check the self-facilitator: ' +
			'`npm run logs -- -s three-ws-api --grep "settle_failed" --since 3h`. ' +
			'A 5xx/502 cluster with empty simulation logs is a duplicate-signature or ' +
			'RPC-preflight fault; a 402 cluster is verify/facilitator rejection. See ' +
			'docs/ops/production-log-triage.md.',
	};
}

/**
 * Read the last WINDOW_INTERVAL of ring settle outcomes and classify them.
 * Fail-soft: a missing DB, an absent table (pre-migration), or any query error
 * resolves to `unknown` so a health read never throws. Pre-aggregates in SQL
 * (bucketed by success/paid/reason) so the row count is bounded regardless of
 * settle volume — safe on the per-request /api/healthz path.
 * @returns {Promise<{ name: 'x402_settle', label: string, status: string,
 *   detail: string, hint?: string, metrics?: object }>}
 */
export async function gatherX402SettleHealth() {
	const base = { name: /** @type {const} */ ('x402_settle'), label: 'x402 settlement success' };
	try {
		const { sql } = await import('../db.js');
		const buckets = /** @type {Array<{ success: boolean, paid: boolean, reason: string, n: number }>} */ (
			await sql`
				SELECT success,
				       (amount_atomic > 0) AS paid,
				       COALESCE(NULLIF(split_part(error_msg, ':', 1), ''), 'none') AS reason,
				       count(*)::int AS n
				FROM x402_autonomous_log
				WHERE ts >= now() - ${WINDOW_INTERVAL}::interval
				GROUP BY success, paid, reason
			`
		);
		const v = classifySettleBuckets(buckets);
		return {
			...base,
			status: v.status,
			detail: v.detail,
			...(v.hint ? { hint: v.hint } : {}),
			metrics: {
				windowHours: 3,
				settled: v.settled,
				faults: v.faults,
				attempts: v.attempts,
				rate: v.rate == null ? null : Math.round(v.rate * 1000) / 1000,
				topFaults: v.faultClasses.slice(0, 5),
			},
		};
	} catch (err) {
		return { ...base, status: 'unknown', detail: err?.message || 'settle log unreadable' };
	}
}
