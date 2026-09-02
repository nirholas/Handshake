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
// The blind spot `unknown` opens, and why the governor count closes it
// --------------------------------------------------------------------
// "Too few attempts to judge" is the right verdict for a quiet ring and the
// WRONG one for a throttled one, and the two are identical in this log until you
// count the throttle. Since the wallet fee governor gained a caller-side
// admission check, a fee wallet with no daily budget left makes the ring SKIP
// its paid calls (reason `fee_runway_exhausted`) instead of settling them. Those
// skips are correctly not rail faults (nothing broke, we chose not to spend),
// but they also empty the numerator AND the denominator, so a rail that is
// 100% paced shut reads exactly like a rail nobody used. Measured on production
// 2026-08-01, before the admission check existed and while the same refusal
// still came back as a 502: 85,265 governed refusals against 562 rail-shaped
// failures, a settle rate of 25.9%, and a hint that sent the reader to the
// facilitator for a funding problem. `governorSkips` is counted separately here
// so the sensor can say "paced, top the fee wallet up" in both regimes.
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

// The ring reports `no_solana_accept` when a 402 challenge carried no Solana
// accept it could pay. On OUR OWN endpoints that is never the ring's choice: it
// means buildRequirements() dropped the Solana accept, and the reason it drops
// one in production is sponsorKnownBelowFloor() (api/_lib/x402-paid-endpoint.js).
const NO_SOLANA_ACCEPT = 'no_solana_accept';
// The wallet fee governor's refusal, as both sides of the handshake record it:
// the caller-side admission check (api/_lib/x402/pay.js) skips the call with
// this reason, and the settle-path meter refuses with the same token. Never a
// rail fault: it is the platform pacing its own SOL burn, but it is the one
// benign reason that must still be COUNTED, because at volume it is the whole
// explanation for a rate or an attempt count that fell off a cliff.
const FEE_GOVERNOR = /^fee_runway_exhausted/i;
// The sponsor-floor refusal, as the ring records it. x402-spec.js answers 503
// `settlement_unavailable` for a fee wallet under its floor, so the reason token
// arrives either as the 503 prose or as the raw floor signature.
// `insufficient_lamports_for_fee` is the same starvation reported from inside
// the settle path (see runway-lab's bucketer, which files it under floor too).
const SPONSOR_FLOOR = /^(settlement temporarily unavailable|fee_wallet_below_floor|sponsor_sol_floor|sol_floor|insufficient_lamports_for_fee)/i;

/**
 * Why did the settle rate fall? Two failure shapes are indistinguishable in the
 * rate alone and have opposite fixes, and the generic hint sent operators at the
 * wrong one for a full shift on 2026-07-29:
 *
 *   FAULTS ROSE      the denominator grew; settles are being attempted and
 *                    rejected. Look at the facilitator.
 *   NUMERATOR FELL   rail faults stayed flat while settlements stopped
 *                    happening, because the Solana accept was withdrawn from
 *                    every challenge and the (Solana-only) ring had nothing it
 *                    could pay. Look at the sponsor's SOL balance. On 07-29 this
 *                    read as "settle 22%" while faults sat at their normal
 *                    ~100/h and `no_solana_accept` went 0 to 374/h.
 *
 *   BUDGET PACED     nothing failed and nothing was withdrawn: the wallet fee
 *                    governor spent today's fee budget and is refusing the rest
 *                    of the day's settles on purpose. Look at the fee wallet's
 *                    SOL, not at the rail. On 2026-08-01 this shape was 85,265
 *                    governed refusals against 562 rail-shaped failures, and the
 *                    generic rail hint below sent the reader to the facilitator.
 *
 * Solana is the home chain, so a withdrawn Solana accept is a platform outage,
 * not the benign "ring chose not to pay" the rate deliberately excludes.
 * @param {{ noSolanaAccept: number, floorSignals: number, governorSkips?: number,
 *   settled: number, faults: number }} s
 * @returns {{ cause: 'sponsor_floor'|'fee_governor'|'rail', hint: string }}
 */
export function diagnoseSettleDrop({ noSolanaAccept, floorSignals, governorSkips = 0, settled, faults }) {
	// A floor refusal is proof on its own. Absent that, treat the home chain going
	// unpayable more often than it settles as the same cause: the accept is
	// withdrawn for most of the window, which is what a flapping floor looks like
	// through a cache-backed, fail-open check.
	//
	// The hard floor outranks the governor deliberately: both want SOL in the same
	// wallet, but under the floor EVERY settle fails closed, while a spent budget
	// still settles at the paced rate. Report the harder stop when both are lit.
	if (floorSignals > 0 || (noSolanaAccept > 0 && noSolanaAccept > settled)) {
		return {
			cause: /** @type {const} */ ('sponsor_floor'),
			hint:
				'The Solana accept is being WITHDRAWN, not rejected: ' +
				`${noSolanaAccept} no_solana_accept + ${floorSignals} floor refusal(s) against ${faults} rail faults. ` +
				'sponsorKnownBelowFloor() drops Solana from every 402 challenge while the sponsor sits under ' +
				'X402_SPONSOR_SOL_FLOOR_LAMPORTS, so the ring has nothing payable and settlements stop. ' +
				'Do NOT start at the facilitator. Check the sponsor balance, then let the free self-heal run: ' +
				'POST /api/cron/treasury-topup?dry=1 (Bearer CRON_SECRET) to see the plan, then without ?dry=1 ' +
				'to apply. READ agent_reclaim.failed in that plan before you trust its total: a wallet whose ' +
				'secret does not decrypt is reported at stage `recover` and its SOL is unreachable until ' +
				'WALLET_ENCRYPTION_KEY (or WALLET_ENCRYPTION_KEY_PREVIOUS) can open it, so no cron run and no ' +
				'RPC tier will ever move it. Owner SOL is needed when every reclaim source reports ' +
				'at_or_below_floor or secret_undecryptable. See docs/ops/production-log-triage.md.',
		};
	}
	// Nothing failed and nothing was withdrawn: we are refusing our own settles to
	// pace the fee wallet's SOL. Dominance over faults is the test, because a
	// handful of governed skips is the governor working as designed on a healthy
	// rail, while a landslide of them IS the reason the rate moved.
	if (governorSkips > faults && governorSkips > 0) {
		return {
			cause: /** @type {const} */ ('fee_governor'),
			hint:
				'This is a GOVERNED THROTTLE, not a rail fault: ' +
				`${governorSkips} settle(s) skipped by the wallet fee governor against ${faults} rail fault(s). ` +
				'The fee wallet spent its daily SOL fee budget (spendable SOL / X402_WALLET_FEE_RUNWAY_DAYS, ' +
				'floored at X402_WALLET_FEE_MIN_BUDGET_LAMPORTS), so the rail is pacing itself until the budget ' +
				'refills. Do NOT debug the facilitator and do NOT lower the sponsor floor. Read the live budget ' +
				'at GET /api/x402/runway-lab, then fund the fee wallet: POST /api/cron/treasury-topup?dry=1 ' +
				'(Bearer CRON_SECRET) shows what the free self-heal can reclaim, and owner SOL is needed only ' +
				'when every reclaim source reports at_or_below_floor or an undecryptable secret. ' +
				'See docs/x402-ring-economy.md "The wallet fee governor".',
		};
	}
	return {
		cause: /** @type {const} */ ('rail'),
		hint:
			'Payments are being rejected at settle. Check the self-facilitator: ' +
			'`npm run logs -- -s three-ws-api --grep "settle_failed" --since 3h`. ' +
			'A 502 cluster with empty simulation logs is a duplicate-signature or ' +
			'RPC-preflight fault; a 402 cluster is verify/facilitator rejection. A 503 ' +
			'cluster is a deliberate refusal (fee-governor budget or sponsor floor); ' +
			'both are reconciled against the facilitator book above, so a 503 surplus ' +
			'surviving into this hint means the facilitator log and the ring log ' +
			'disagree; read x402_self_facilitator_log.reject_reason directly. ' +
			'See docs/ops/production-log-triage.md.',
	};
}

/**
 * Classify pre-aggregated settle buckets into a subsystem verdict. Pure — no DB,
 * no clock — so the thresholds and the rail-fault split are unit-testable
 * against the exact bucket shape the DB returns.
 *
 * `facilitatorRejects` is the same window's deliberate-refusal counts from the
 * facilitator's own book (`x402_self_facilitator_log.reject_reason`). It exists
 * because the ring log is REASON-BLIND for refusals that arrive over HTTP: a
 * settle the wallet fee governor refused reaches `x402_autonomous_log` as a bare
 * `http_503` (pre-2026-08-06: `http_502`), matches RAIL_STATUS, and reads as a
 * rail fault, which is how 2026-08-05 production showed `cause: "rail"` for
 * ~1,200 refusals that were the budget governor pacing on purpose. The
 * reconciliation below re-attributes status-only 5xx faults to the governor /
 * floor, clamped by min() so a window skew between the two logs can never
 * invent faults or attribute more than actually happened.
 * @param {Array<{ success: boolean, paid: boolean, reason: string, rent?: boolean, n: number }>} buckets
 * @param {{ minAttempts?: number,
 *   facilitatorRejects?: { governor?: number, floor?: number } }} [opts]
 * @returns {{ status: 'ok'|'degraded'|'down'|'unknown', settled: number,
 *   faults: number, attempts: number, rate: number|null,
 *   faultClasses: Array<{ reason: string, n: number }>, detail: string, hint?: string }}
 */
export function classifySettleBuckets(buckets, { minAttempts = MIN_ATTEMPTS, facilitatorRejects } = {}) {
	let settled = 0;
	let faults = 0;
	// Counted but deliberately kept OUT of the rate: these two explain a collapse
	// the rate can only report. Folding them into `faults` would change what the
	// percentage means (and peg it red on a benign quiet ring); dropping them
	// entirely is what made the 07-29 numerator collapse unreadable.
	let noSolanaAccept = 0;
	let floorSignals = 0;
	let governorSkips = 0;
	/** @type {Record<string, number>} */
	const faultBy = {};
	for (const b of Array.isArray(buckets) ? buckets : []) {
		const n = Number(b?.n) || 0;
		if (n <= 0) continue;
		if (b.success && b.paid) {
			settled += n;
			continue;
		}
		if (b.success) continue;
		if (b.reason === NO_SOLANA_ACCEPT) noSolanaAccept += n;
		if (SPONSOR_FLOOR.test(String(b.reason || ''))) floorSignals += n;
		if (FEE_GOVERNOR.test(String(b.reason || ''))) governorSkips += n;
		// A rent-exemption failure on the fee payer wears a rail-shaped reason
		// token (`simulation_failed`, `sweep_broadcast_failed`) while being the
		// opposite of a rail fault: the transaction never reached the rail because
		// the sponsor could not pay for it. Counting it as rail is what produced
		// the wrong hint on 2026-08-28, when 3 hours of a dry sponsor were reported
		// as `cause: rail` and the operator was pointed at duplicate signatures and
		// RPC preflight instead of at a wallet holding 0.000899 SOL. The flag is
		// computed from the full error_msg because the `:`-token this groups by
		// throws the rent detail away.
		if (b.rent) {
			floorSignals += n;
			continue;
		}
		if (isRailFault(b.reason)) {
			faults += n;
			faultBy[b.reason] = (faultBy[b.reason] || 0) + n;
		}
	}

	// Re-attribute status-only 5xx faults to the deliberate refusals the
	// facilitator book proves happened in the window. 503 drains first (the
	// current status both refusals wear), then 502 (the pre-2026-08-06 mapping,
	// and any path still routed through the generic settle_failed throw).
	const drainStatusFaults = (count) => {
		let remaining = Math.max(0, Math.floor(Number(count) || 0));
		let drained = 0;
		for (const key of ['http_503', 'http_502']) {
			if (remaining <= 0) break;
			const take = Math.min(faultBy[key] || 0, remaining);
			if (take <= 0) continue;
			faultBy[key] -= take;
			if (faultBy[key] === 0) delete faultBy[key];
			faults -= take;
			remaining -= take;
			drained += take;
		}
		return drained;
	};
	governorSkips += drainStatusFaults(facilitatorRejects?.governor);
	floorSignals += drainStatusFaults(facilitatorRejects?.floor);

	const attempts = settled + faults;
	const faultClasses = Object.entries(faultBy)
		.map(([reason, n]) => ({ reason, n }))
		.sort((a, b) => b.n - a.n);

	if (attempts < minAttempts) {
		// A sponsor under its floor is a HARD stop, not an unjudgeable window. Every
		// settle it touches fails closed, so the attempts that would have been
		// judged are precisely the ones the empty wallet prevented, and moving them
		// out of `faults` (which is correct: they never reached the rail) must not
		// let the sensor answer `unknown`. On 2026-08-28 that would have reported a
		// three-hour, zero-settle outage as "too few attempts to judge". Down rather
		// than degraded, per the precedence in diagnoseSettleDrop: under the floor
		// nothing settles at all, where a spent governor budget still settles at the
		// paced rate.
		if (floorSignals >= minAttempts) {
			const { cause, hint } = diagnoseSettleDrop({
				noSolanaAccept, floorSignals, governorSkips, settled, faults,
			});
			return {
				status: 'down',
				settled, faults, attempts, rate: null, faultClasses,
				cause, noSolanaAccept, floorSignals, governorSkips,
				detail:
					`settle halted: ${floorSignals} attempt(s) refused with the sponsor under its SOL floor ` +
					`in ${WINDOW_INTERVAL}, ${settled} settled`,
				hint,
			};
		}
		// A throttled rail is not an unjudgeable one. When the reason there is
		// nothing to judge is that the governor skipped the calls, say so and report
		// `degraded`: the funding action is identical to the low-rate case, and
		// `unknown` would let a fully paced-shut economy sit silent behind a neutral
		// verdict. The threshold is the same MIN_ATTEMPTS, so a handful of skips on
		// a genuinely idle ring still reads `unknown`.
		if (governorSkips >= minAttempts) {
			const { cause, hint } = diagnoseSettleDrop({
				noSolanaAccept, floorSignals, governorSkips, settled, faults,
			});
			return {
				status: 'degraded',
				settled, faults, attempts, rate: null, faultClasses,
				cause, noSolanaAccept, floorSignals, governorSkips,
				detail:
					`settle throttled: ${governorSkips} call(s) skipped by the wallet fee governor, ` +
					`${attempts} attempt(s) in ${WINDOW_INTERVAL}`,
				hint,
			};
		}
		return {
			status: 'unknown',
			settled, faults, attempts, rate: null, faultClasses, governorSkips,
			detail: `only ${attempts} settle attempts in ${WINDOW_INTERVAL}, too few to judge`,
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
		// A healthy rate with the governor pacing behind it is still healthy: the
		// settles that ran, ran. Carry the skip count so a wallet quietly sliding
		// toward its budget shows up before the rate does.
		return {
			status: 'ok', settled, faults, attempts, rate, faultClasses,
			noSolanaAccept, floorSignals, governorSkips,
			detail: governorSkips > 0 ? `${base}; ${governorSkips} paced by the fee governor` : base,
		};
	}
	const status = rate < DOWN_RATE ? 'down' : 'degraded';
	const { cause, hint } = diagnoseSettleDrop({ noSolanaAccept, floorSignals, governorSkips, settled, faults });
	// Name the withdrawal in `detail` too: the hint is one field deep in the JSON,
	// but `detail` is what the dashboard row, the digest and /api/status all print.
	const withdrawn =
		cause === 'sponsor_floor'
			? `; Solana accept withdrawn (${noSolanaAccept} no_solana_accept, sponsor under SOL floor)`
			: cause === 'fee_governor'
				? `; ${governorSkips} call(s) paced by the fee governor (budget spent, not a rail fault)`
				: '';
	return {
		status,
		settled, faults, attempts, rate, faultClasses,
		cause,
		noSolanaAccept,
		floorSignals,
		governorSkips,
		detail: `${base}; ${faults} rail faults${topFaults ? ` (${topFaults})` : ''}${withdrawn}`,
		hint,
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
		const buckets = /** @type {Array<{ success: boolean, paid: boolean, reason: string, rent?: boolean, n: number }>} */ (
			await sql`
				SELECT success,
				       (amount_atomic > 0) AS paid,
				       COALESCE(NULLIF(split_part(error_msg, ':', 1), ''), 'none') AS reason,
				       ((error_msg ILIKE '%InsufficientFundsForRent%' AND error_msg ILIKE '%"account_index":0%')
				         OR error_msg ILIKE '%account (0) with insufficient funds for rent%') AS rent,
				       count(*)::int AS n
				FROM x402_autonomous_log
				WHERE ts >= now() - ${WINDOW_INTERVAL}::interval
				GROUP BY success, paid, reason, rent
			`
		);
		// The facilitator's own book for the same window: the ring log only carries
		// `http_5xx` for a refusal that came back over HTTP, so this is the sole
		// record of WHY those settles were refused. Fail-soft to zero: a missing
		// table (pre-migration) must not take the whole sensor down with it.
		const rejects = await sql`
			SELECT split_part(COALESCE(reject_reason, ''), ':', 1) AS reason,
			       count(*)::int AS n
			FROM x402_self_facilitator_log
			WHERE ts >= now() - ${WINDOW_INTERVAL}::interval
			  AND action = 'settle' AND ok = false
			GROUP BY 1
		`.catch(() => []);
		const facilitatorRejects = { governor: 0, floor: 0 };
		for (const r of rejects) {
			const n = Number(r?.n) || 0;
			if (FEE_GOVERNOR.test(String(r?.reason || ''))) facilitatorRejects.governor += n;
			else if (SPONSOR_FLOOR.test(String(r?.reason || ''))) facilitatorRejects.floor += n;
		}
		const v = classifySettleBuckets(buckets, { facilitatorRejects });
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
				// The collapse-vs-rejection split. `cause` is what an operator should
				// read first; noSolanaAccept is the volume the rate cannot show.
				...(v.cause ? { cause: v.cause } : {}),
				noSolanaAccept: v.noSolanaAccept ?? 0,
				floorSignals: v.floorSignals ?? 0,
				// Deliberate spend-pacing, not failure. Read it next to `rate`: the two
				// together separate "the rail broke" from "the rail is out of budget".
				governorSkips: v.governorSkips ?? 0,
			},
		};
	} catch (err) {
		return { ...base, status: 'unknown', detail: err?.message || 'settle log unreadable' };
	}
}
