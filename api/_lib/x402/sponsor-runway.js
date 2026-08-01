// @ts-check
// api/_lib/x402/sponsor-runway.js
//
// Sponsor fee-wallet RUNWAY: how many days of settling the fee payer can still
// afford, measured from what it actually spent, plus the alert that fires before
// it bites.
//
// Why this module exists
// ----------------------
// The sponsor wallet (X402_FEE_PAYER_SOLANA) pays the SOL fee on every platform
// settle. Below X402_SPONSOR_SOL_FLOOR_LAMPORTS the self-facilitator refuses to
// settle, and buildRequirements() then WITHDRAWS the Solana accept from every 402
// challenge (sponsorKnownBelowFloor(), api/_lib/x402-paid-endpoint.js). The
// outward symptom is not a clean outage: settlements collapse while rail faults
// stay flat, because the Solana-only ring never attempts a payment there is
// nothing to reject. The settle sensor names that cause (`sponsor_floor` in
// ops/x402-settle-health.js), but naming it AFTER the collapse is a post-mortem.
// The runway is the signal that precedes it, and until now it was rendered on a
// dashboard nobody watches at 3am and acted on by nothing.
//
// Two rules the numbers obey
// --------------------------
// 1. BURN IS MEASURED, NEVER REMEMBERED. It comes from `fee_lamports` over
//    successful settles in `x402_self_facilitator_log` across a stated window.
//    The folklore figure carried in old triage notes ("1 to 2 SOL/day") is off by
//    roughly 10x against the measured 0.06 to 0.09 SOL/day (ISSUES.md item 6), and
//    a funding ask sized from it would be wrong by an order of magnitude. Every
//    consumer therefore carries the window alongside the number: a rate without
//    its window is a rumour.
// 2. RUNWAY IS MEASURED TO THE FLOOR, NOT TO ZERO. Settling stops at the floor,
//    so the operationally meaningful figure is (balance − floor) / burn. The
//    to-zero figure is still reported (`runway_days`) because it is what the
//    board has always shown and what a funding ask is sized against, but the
//    STATUS and the alert key off `runway_days_to_floor`.
//
// Everything here except measureSponsorBurn() is pure, so the thresholds and the
// alert copy are unit-tested without a chain or a database
// (tests/x402-sponsor-runway.test.js).

import { LAMPORTS_PER_SOL } from './ring-floors.js';

/** Window the burn rate is measured over. Long enough to smooth a bursty ring. */
export const SPONSOR_BURN_WINDOW_DAYS = clampNumber(
	process.env.X402_SPONSOR_BURN_WINDOW_DAYS,
	7,
	{ min: 1, max: 90 },
);

/**
 * Days of runway below which the sponsor alert fires. Three days is the smallest
 * threshold that still leaves a weekend of slack: the reclaim self-heal runs on a
 * cron and an owner top-up needs a human, so a one-day warning is a warning
 * nobody can act on.
 */
export const SPONSOR_RUNWAY_ALERT_DAYS = clampNumber(
	process.env.X402_SPONSOR_RUNWAY_ALERT_DAYS,
	3,
	{ min: 0.25, max: 60 },
);

function clampNumber(raw, fallback, { min, max }) {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(max, Math.max(min, n));
}

function round(n, places) {
	const f = 10 ** places;
	return Math.round(n * f) / f;
}

/**
 * @typedef {{ address: string|null, sol: number|null, floor_sol: number|null,
 *   spendable_sol: number|null, burn_sol_per_day: number|null,
 *   burn_window_days: number, settles_in_window: number,
 *   runway_days: number|null, runway_days_to_floor: number|null,
 *   alert_days: number, status: 'ok'|'warn'|'critical'|'unknown',
 *   reason: string, should_alert: boolean }} SponsorRunway
 */

/**
 * Turn a live sponsor balance and a measured burn rate into a runway verdict.
 * Pure — no clock, no DB, no RPC.
 *
 * Statuses:
 *   `critical` the wallet is at or under its floor. Settlement is already being
 *              refused and the Solana accept is already withdrawn.
 *   `warn`     runway to the floor is under `alertDays`. Still settling, but the
 *              window to act is closing.
 *   `ok`       runway to the floor is at or above `alertDays`.
 *   `unknown`  no balance, or no measured burn in the window (a genuinely idle
 *              rail divides by zero; that is not a fault and must never page).
 *
 * @param {object} input
 * @param {number|null} [input.sol]            live sponsor balance, SOL
 * @param {number|null} [input.floorSol]       facilitator hard floor, SOL
 * @param {number|null} [input.burnSolPerDay]  measured burn, SOL/day
 * @param {number} [input.settles]             successful settles in the window
 * @param {number} [input.windowDays]          window the burn was measured over
 * @param {number} [input.alertDays]           threshold for `warn`
 * @param {string|null} [input.address]        sponsor address, carried for the alert
 * @returns {{ address: string|null, sol: number|null, floor_sol: number|null,
 *   spendable_sol: number|null, burn_sol_per_day: number|null,
 *   burn_window_days: number, settles_in_window: number,
 *   runway_days: number|null, runway_days_to_floor: number|null,
 *   alert_days: number, status: 'ok'|'warn'|'critical'|'unknown',
 *   reason: string, should_alert: boolean }}
 */
export function computeSponsorRunway({
	sol = null,
	floorSol = null,
	burnSolPerDay = null,
	settles = 0,
	windowDays = SPONSOR_BURN_WINDOW_DAYS,
	alertDays = SPONSOR_RUNWAY_ALERT_DAYS,
	address = null,
} = {}) {
	const balance = Number.isFinite(Number(sol)) ? Number(sol) : null;
	const floor = Number.isFinite(Number(floorSol)) ? Number(floorSol) : null;
	const burn = Number.isFinite(Number(burnSolPerDay)) && Number(burnSolPerDay) > 0
		? Number(burnSolPerDay)
		: null;
	const spendable = balance != null && floor != null ? round(balance - floor, 9) : null;

	const base = {
		address,
		sol: balance,
		floor_sol: floor,
		spendable_sol: spendable,
		burn_sol_per_day: burn == null ? null : round(burn, 6),
		burn_window_days: windowDays,
		settles_in_window: Number(settles) || 0,
		alert_days: alertDays,
	};

	if (balance == null) {
		return {
			...base,
			runway_days: null,
			runway_days_to_floor: null,
			status: /** @type {const} */ ('unknown'),
			reason: 'sponsor balance unreadable',
			should_alert: false,
		};
	}

	// Already under the floor: the rail is down right now. This verdict does not
	// need a burn rate, and refusing to report it without one is exactly how a
	// live outage reads as `unknown`.
	if (floor != null && balance <= floor) {
		return {
			...base,
			runway_days: burn == null ? null : round(balance / burn, 2),
			runway_days_to_floor: 0,
			status: /** @type {const} */ ('critical'),
			reason: 'at or below the settle floor',
			should_alert: true,
		};
	}

	if (burn == null) {
		return {
			...base,
			runway_days: null,
			runway_days_to_floor: null,
			status: /** @type {const} */ ('unknown'),
			reason: `no settle fees recorded in the last ${windowDays} day(s)`,
			should_alert: false,
		};
	}

	const runwayDays = round(balance / burn, 2);
	const runwayToFloor = spendable == null ? runwayDays : round(Math.max(0, spendable) / burn, 2);
	const warn = runwayToFloor < alertDays;
	return {
		...base,
		runway_days: runwayDays,
		runway_days_to_floor: runwayToFloor,
		status: warn ? /** @type {const} */ ('warn') : /** @type {const} */ ('ok'),
		reason: warn
			? `under the ${alertDays}-day threshold`
			: `above the ${alertDays}-day threshold`,
		should_alert: warn,
	};
}

/**
 * Render the ops alert for a runway verdict. Separated from the send so the copy
 * is testable: the bridge-down alert shipped a template that interpolated its own
 * source text and logged `${detail}` instead of the numbers, which made the page
 * useless exactly when someone was reading it at speed. Every number below is a
 * field of `r`, and the test asserts the rendered string, not the template.
 *
 * @param {ReturnType<typeof computeSponsorRunway>} r
 * @returns {{ title: string, detail: string, signature: string, severity: 'critical'|'warn' }}
 */
export function formatSponsorRunwayAlert(r) {
	const critical = r.status === 'critical';
	const addr = r.address || 'unconfigured';
	const sol = r.sol == null ? 'unknown' : `${r.sol.toFixed(4)} SOL`;
	const floor = r.floor_sol == null ? 'unknown' : `${r.floor_sol.toFixed(4)} SOL`;
	const burn = r.burn_sol_per_day == null
		? 'not measurable'
		: `${r.burn_sol_per_day.toFixed(4)} SOL/day`;
	const days = r.runway_days_to_floor == null ? 'unknown' : `${r.runway_days_to_floor.toFixed(1)} day(s)`;
	const toEmpty = r.runway_days == null ? 'unknown' : `${r.runway_days.toFixed(1)} day(s)`;
	const topUp = r.burn_sol_per_day == null
		? null
		: round(r.burn_sol_per_day * 14 + (r.floor_sol || 0) - (r.sol || 0), 3);

	const title = critical
		? `🚨 x402 sponsor UNDER its settle floor (${sol})`
		: `⛽ x402 sponsor runway ${days} left`;

	const lines = [
		`Sponsor ${addr} holds ${sol} against a ${floor} settle floor.`,
		`Measured burn ${burn} from ${r.settles_in_window} successful settle(s) over the last ` +
			`${r.burn_window_days} day(s) (fee_lamports in x402_self_facilitator_log, never a remembered constant).`,
		`Runway: ${days} above the floor, ${toEmpty} to empty. Alert threshold ${r.alert_days} day(s).`,
		critical
			? 'Settlement is being REFUSED right now: sponsorKnownBelowFloor() withdraws the Solana accept from ' +
				'every 402 challenge, so the ring has nothing payable and settles stop while rail faults stay flat.'
			: 'Below the floor the Solana accept is withdrawn from every 402 challenge and settles stop while rail ' +
				'faults stay flat, so this will not look like a rail outage when it lands.',
		'Free self-heal first: POST /api/cron/treasury-topup?dry=1 (Bearer CRON_SECRET) to see the reclaim plan, ' +
			'then without ?dry=1 to apply. Owner SOL is needed only when every source reports at_or_below_floor.',
		topUp != null && topUp > 0
			? `A top-up of about ${topUp.toFixed(3)} SOL buys 14 days at the measured burn. Send it to the SPONSOR or ` +
				'the economy master, NEVER to per-agent wallets (that strands SOL and kills the rail).'
			: 'Top up the SPONSOR or the economy master, NEVER per-agent wallets (that strands SOL and kills the rail).',
		'See docs/ops/payment-outcomes.md.',
	];

	return {
		title,
		detail: lines.join(' '),
		// Coalesce on the wallet, not the numbers: the balance moves every read and
		// a balance-keyed signature would post a fresh alert every ten minutes.
		signature: `x402-sponsor-runway:${addr}`,
		severity: critical ? 'critical' : 'warn',
	};
}

/**
 * Measure the sponsor's burn from the settle ledger. The only impure function
 * here. Fail-soft: a missing DB or absent table resolves to an unmeasured result
 * rather than throwing into a health read.
 *
 * @param {any} sql tagged-template SQL client
 * @param {{ windowDays?: number }} [opts]
 * @returns {Promise<{ measured: boolean, settles: number, lamports: number,
 *   window_days: number, burn_sol_per_day: number|null, error?: string }>}
 */
export async function measureSponsorBurn(sql, { windowDays = SPONSOR_BURN_WINDOW_DAYS } = {}) {
	const window_days = windowDays;
	try {
		const [row] = await sql`
			SELECT count(*)::int AS settles,
			       coalesce(sum(fee_lamports), 0)::bigint AS lamports
			FROM x402_self_facilitator_log
			WHERE ts >= now() - ${`${window_days} days`}::interval
			  AND action = 'settle' AND ok = true
		`;
		const lamports = Number(row?.lamports || 0);
		const settles = Number(row?.settles || 0);
		return {
			measured: true,
			settles,
			lamports,
			window_days,
			burn_sol_per_day: lamports > 0 ? round(lamports / window_days / LAMPORTS_PER_SOL, 6) : null,
		};
	} catch (err) {
		return {
			measured: false,
			settles: 0,
			lamports: 0,
			window_days,
			burn_sol_per_day: null,
			error: err?.message || 'settle log unreadable',
		};
	}
}
