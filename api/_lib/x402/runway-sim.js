// api/_lib/x402/runway-sim.js
//
// A forward simulation of the x402 settle path's admission control — the
// "digital twin" behind /economy-lab.
//
// Why this exists
// ---------------
// When settlement stops, the outward symptom is always the same ("payments are
// failing") and the causes are not: the fee wallet can be under its hard SOL
// floor, or above the floor but out of daily fee budget, or simply out of
// demand. Those three have completely different fixes (fund the wallet / widen
// the governor / nothing is wrong), and telling them apart historically meant
// hand-writing SQL against x402_self_facilitator_log and reading lamport math
// off alert strings. On 2026-07-31 that hand work attributed 5,483 of 8,657
// settle failures to fee_runway_exhausted — a config problem that looked
// exactly like an empty wallet.
//
// The simulation is faithful because it does NOT reimplement the decision. It
// imports walletDailyFeeBudgetLamports() and assessWalletFeeBudget() from
// wallet-fee-governor.js — the very functions api/x402-facilitator/[action].js
// calls through wallet-fee-meter.js — and applies them in the same ORDER the
// settle path does (self-facilitator.js settleRingPayment):
//
//   1. hard SOL floor      → reason `fee_wallet_below_floor:<bal><<floor>`
//   2. wallet fee governor → reason `fee_runway_exhausted:<spent>+<fee>><budget>`
//   3. admit, burn the fee
//
// so a projection can never drift from production the way a parallel model
// would. Change the governor and this simulation changes with it.
//
// Zero I/O and zero imports beyond the governor, which is itself dependency-
// free. That is deliberate: the browser at /economy-lab imports this module
// directly (see scripts/check-browser-graph.mjs — no node: built-in may become
// reachable from here), so the page runs the real admission logic client-side
// against a live seed from GET /api/x402/runway-lab.

import {
	walletDailyFeeBudgetLamports,
	assessWalletFeeBudget,
	pacedFeeBudgetLamports,
} from './wallet-fee-governor.js';

export const LAMPORTS_PER_SOL = 1_000_000_000;

// The 1-signature Solana base fee: the cheapest a settle can possibly cost, and
// the floor we clamp a caller-supplied fee estimate to. Mirrors
// ring-dashboard-model.js FEE_FLOOR_LAMPORTS.
export const MIN_FEE_LAMPORTS = 5_000;

// Guard rail for the attempt loop. A 30-day horizon at 500 settles/hour is
// 360k attempts, which runs in a few milliseconds; beyond this we stop
// simulating and say so rather than freezing a browser tab.
export const MAX_ATTEMPTS = 600_000;

const int = (v, d = 0) => {
	const n = Math.floor(Number(v));
	return Number.isFinite(n) ? n : d;
};

/**
 * Project the fee wallet forward, settle attempt by settle attempt.
 *
 * @param {object} input
 * @param {number} input.startLamports        fee wallet SOL balance at t=0
 * @param {number} input.floorLamports        X402_SPONSOR_SOL_FLOOR_LAMPORTS
 * @param {number} input.runwayDays           X402_WALLET_FEE_RUNWAY_DAYS
 * @param {number} input.minBudgetLamports    X402_WALLET_FEE_MIN_BUDGET_LAMPORTS
 * @param {number} input.feeLamports          SOL burned per admitted settle
 * @param {number} input.demandPerHour        settles ATTEMPTED per hour
 * @param {number} input.hours                horizon
 * @param {number} [input.spentTodayLamports] fee already burned in the current UTC day
 * @param {number} [input.startHourOfDay]     UTC hour at t=0, so day resets land correctly
 * @param {{hour:number, lamports:number}[]} [input.funding] deposits applied at the top of an hour
 * @param {boolean} [input.governorEnabled]   X402_WALLET_FEE_GOVERNOR_ENABLED
 * @param {boolean} [input.paceDay]           X402_WALLET_FEE_PACE_DAY
 * @param {number} [input.paceMinSliceLamports] X402_WALLET_FEE_PACE_MIN_SLICE_LAMPORTS
 */
export function simulateRunway(input = {}) {
	const floorLamports = Math.max(0, int(input.floorLamports));
	const runwayDays = Math.max(0.5, Number(input.runwayDays) || 3);
	const minBudgetLamports = Math.max(0, int(input.minBudgetLamports));
	const feeLamports = Math.max(MIN_FEE_LAMPORTS, int(input.feeLamports, MIN_FEE_LAMPORTS));
	const demandPerHour = Math.max(0, int(input.demandPerHour));
	const hours = Math.min(24 * 90, Math.max(1, int(input.hours, 24 * 7)));
	const governorEnabled = input.governorEnabled !== false;
	const startHourOfDay = ((int(input.startHourOfDay) % 24) + 24) % 24;
	// Opt-in, matching walletFeeGovernorConfig().paceDay: the lab must default to
	// the shape production actually runs, or its verdicts describe a rail nobody
	// is on.
	const paceDay = input.paceDay === true;
	const paceMinSliceLamports = Math.max(0, int(input.paceMinSliceLamports, 200_000));

	// The budget the wallet may draw on at a given hour of the UTC day. Mirrors
	// wallet-fee-meter.js: the daily figure, then the paced slice unlocked so far.
	// Pacing is measured to the END of the hour being simulated, so an hour is
	// allowed to spend the share it accrues during that hour.
	const budgetAt = (solLamports, hourOfDay) => {
		const daily = walletDailyFeeBudgetLamports({
			solLamports, floorLamports, runwayDays, minBudgetLamports,
		});
		if (!paceDay) return daily;
		return pacedFeeBudgetLamports({
			budgetLamports: daily,
			dayElapsedFraction: (hourOfDay + 1) / 24,
			minSliceLamports: paceMinSliceLamports,
		});
	};

	const fundingByHour = new Map();
	for (const f of input.funding || []) {
		const h = int(f?.hour, -1);
		const lam = int(f?.lamports);
		if (h < 0 || h >= hours || lam === 0) continue;
		fundingByHour.set(h, (fundingByHour.get(h) || 0) + lam);
	}

	let lamports = Math.max(0, int(input.startLamports));
	let spentToday = Math.max(0, int(input.spentTodayLamports));

	const series = [];
	let admitted = 0;
	let refusedFloor = 0;
	let refusedGovernor = 0;
	let attempts = 0;
	let truncated = false;
	let firstRefusalHour = null;
	let floorBreachHour = null;
	let fundedLamports = 0;
	const perDayAdmitted = [];

	for (let h = 0; h < hours; h++) {
		// A UTC midnight crossing resets the governor's daily meter. `h === 0` is
		// the seed hour, which carries the real spent-today read from the ledger.
		if (h > 0 && (startHourOfDay + h) % 24 === 0) spentToday = 0;

		const deposit = fundingByHour.get(h);
		if (deposit) {
			lamports = Math.max(0, lamports + deposit);
			fundedLamports += deposit;
		}

		let hourAdmitted = 0;
		let hourRefusedFloor = 0;
		let hourRefusedGovernor = 0;
		let lastReason = null;
		const hourOfDay = (startHourOfDay + h) % 24;
		let hourBudget = budgetAt(lamports, hourOfDay);

		for (let i = 0; i < demandPerHour; i++) {
			if (attempts >= MAX_ATTEMPTS) { truncated = true; break; }
			attempts++;

			// (1) Hard SOL floor — self-facilitator.js checks this first, on the
			// live balance, before the meter is ever consulted. Note the strict
			// `<`: a wallet sitting exactly ON its floor still admits one more
			// settle and lands just under it. That is production's comparison,
			// reproduced rather than rounded away.
			if (lamports < floorLamports) {
				hourRefusedFloor++;
				lastReason = `fee_wallet_below_floor:${lamports}<${floorLamports}`;
				if (floorBreachHour === null) floorBreachHour = h;
				if (firstRefusalHour === null) firstRefusalHour = h;
				continue;
			}

			// (1b) With a floor at or near zero the floor check stops binding and
			// the chain becomes the constraint: a transaction cannot pay a fee the
			// account does not hold. Same bucket as the floor (both are "the wallet
			// is out of SOL"), distinct reason so the cause stays legible.
			if (lamports < feeLamports) {
				hourRefusedFloor++;
				lastReason = `insufficient_lamports_for_fee:${lamports}<${feeLamports}`;
				if (floorBreachHour === null) floorBreachHour = h;
				if (firstRefusalHour === null) firstRefusalHour = h;
				continue;
			}

			// (2) Wallet fee governor, recomputed per settle from the live balance
			// exactly as wallet-fee-meter.js does.
			const budgetLamports = budgetAt(lamports, hourOfDay);
			hourBudget = budgetLamports;
			if (governorEnabled) {
				const verdict = assessWalletFeeBudget({
					spentTodayLamports: spentToday, budgetLamports, nextFeeLamports: feeLamports,
				});
				if (!verdict.ok) {
					hourRefusedGovernor++;
					lastReason = verdict.reason;
					if (firstRefusalHour === null) firstRefusalHour = h;
					continue;
				}
			}

			// (3) Admitted: the fee is burned and metered.
			lamports -= feeLamports;
			spentToday += feeLamports;
			hourAdmitted++;
		}

		admitted += hourAdmitted;
		refusedFloor += hourRefusedFloor;
		refusedGovernor += hourRefusedGovernor;

		series.push({
			hour: h,
			lamports,
			budgetLamports: hourBudget,
			spentTodayLamports: spentToday,
			admitted: hourAdmitted,
			refusedFloor: hourRefusedFloor,
			refusedGovernor: hourRefusedGovernor,
			fundedLamports: deposit || 0,
			reason: lastReason,
		});

		const day = Math.floor((startHourOfDay + h) / 24);
		perDayAdmitted[day] = (perDayAdmitted[day] || 0) + hourAdmitted;
		if (truncated) break;
	}

	const refused = refusedFloor + refusedGovernor;
	const demanded = admitted + refused;
	const settledDays = perDayAdmitted.filter((n) => n !== undefined);

	return {
		series,
		summary: {
			admitted,
			refused,
			refusedFloor,
			refusedGovernor,
			demanded,
			admissionRate: demanded > 0 ? admitted / demanded : 1,
			firstRefusalHour,
			floorBreachHour,
			startLamports: Math.max(0, int(input.startLamports)),
			endLamports: lamports,
			feesBurnedLamports: admitted * feeLamports,
			fundedLamports,
			settlesPerDay: settledDays,
			steadySettlesPerDay: steadyStateSettlesPerDay(settledDays),
			limiter: limiterOf({ refusedFloor, refusedGovernor, admitted, demandPerHour, hours }),
			verdict: verdictOf({ admitted, refused, refusedFloor }),
			truncated,
			hoursSimulated: series.length,
		},
	};
}

// The last FULL day in the projection is the honest steady-state read: day 0 is
// partial (the seed hour lands mid-day) and the final day may be truncated by
// the horizon. With fewer than three days on record, fall back to the max.
function steadyStateSettlesPerDay(perDay) {
	if (!perDay.length) return 0;
	if (perDay.length < 3) return Math.max(...perDay);
	return perDay[perDay.length - 2];
}

// What is actually holding throughput back — the question an operator is really
// asking when they say "why did settlement stop".
function limiterOf({ refusedFloor, refusedGovernor, admitted, demandPerHour, hours }) {
	if (refusedFloor > refusedGovernor && refusedFloor > 0) return 'floor';
	if (refusedGovernor > 0) return 'governor';
	if (admitted >= demandPerHour * hours && demandPerHour > 0) return 'demand';
	return 'none';
}

function verdictOf({ admitted, refused, refusedFloor }) {
	if (admitted === 0 && refused > 0) return 'starved';
	if (refusedFloor > 0) return 'starved';
	if (refused > 0) return 'throttled';
	return 'healthy';
}

/**
 * Closed-form daily throughput, for the UI to explain a projection without
 * re-running it.
 *
 * The governor recomputes its budget from the LIVE balance on every settle, so
 * spending shrinks the budget that authorises the next spend. That feedback
 * settles at a fixed point well below the naive `budget / fee`:
 *
 *   n·fee = (spendable − n·fee) / runwayDays
 *   ⇒ n = spendable / (fee · (runwayDays + 1))
 *
 * With the stock 3-day runway that is spendable/4 per day, not spendable/3 —
 * a 25% gap between the configured intent and the delivered throughput, and
 * the reason "the wallet has 3 days of runway" and "settlement stopped today"
 * are not contradictory statements. The heartbeat floor raises the result, and
 * the wallet's own distance to its hard floor caps it.
 */
export function equilibriumSettlesPerDay({
	spendableLamports, feeLamports, runwayDays, minBudgetLamports = 0,
}) {
	const fee = Math.max(MIN_FEE_LAMPORTS, int(feeLamports, MIN_FEE_LAMPORTS));
	const spendable = Math.max(0, int(spendableLamports));
	const days = Math.max(0.5, Number(runwayDays) || 3);
	const damped = spendable / (fee * (days + 1));
	const heartbeat = Math.max(0, int(minBudgetLamports)) / fee;
	const hardCap = spendable / fee;
	return Math.floor(Math.min(hardCap, Math.max(damped, heartbeat)));
}

/**
 * Given a throughput target, solve each of the three independent levers for the
 * exact value that reaches it. This is the "what fixes it" half of the lab: the
 * governor's budget is one equation with three tunable terms, so an operator
 * should never have to guess which knob to turn or by how much.
 *
 *   budget = max(minBudgetLamports, floor((balance - floor) / runwayDays))
 *   throughput_per_day = budget / feeLamports
 *
 * @returns {{ targetSettlesPerDay:number, requiredDailyBudgetLamports:number,
 *   currentDailyBudgetLamports:number, alreadyMet:boolean,
 *   fund:{lamports:number, sol:number}|null,
 *   runwayDays:{value:number}|null,
 *   minBudget:{lamports:number, sol:number} }}
 */
export function solveForThroughput({
	targetSettlesPerDay, startLamports, floorLamports, runwayDays, minBudgetLamports, feeLamports,
}) {
	const fee = Math.max(MIN_FEE_LAMPORTS, int(feeLamports, MIN_FEE_LAMPORTS));
	const target = Math.max(0, int(targetSettlesPerDay));
	const floor = Math.max(0, int(floorLamports));
	const days = Math.max(0.5, Number(runwayDays) || 3);
	const balance = Math.max(0, int(startLamports));
	const required = target * fee;
	const current = walletDailyFeeBudgetLamports({
		solLamports: balance, floorLamports: floor, runwayDays: days, minBudgetLamports,
	});

	// Lever 1 — fund the wallet, keeping the governor as configured.
	const neededBalance = floor + Math.ceil(required * days);
	const fundLamports = Math.max(0, neededBalance - balance);

	// Lever 2 — shorten the runway target, keeping the balance as-is. Only
	// solvable while the wallet is above its floor; below it there is nothing to
	// spread and the hard floor refuses every settle regardless.
	const spendable = balance - floor;
	const solvedRunwayDays = spendable > 0 && required > 0
		? Math.max(0.5, Math.floor((spendable / required) * 100) / 100)
		: null;

	// Lever 3 — raise the heartbeat floor. Always solvable, and the only lever
	// that does not depend on the balance, which is precisely why it is the one
	// that keeps a nearly-empty wallet transacting.
	return {
		targetSettlesPerDay: target,
		requiredDailyBudgetLamports: required,
		currentDailyBudgetLamports: current,
		alreadyMet: current >= required,
		fund: fundLamports > 0 ? { lamports: fundLamports, sol: fundLamports / LAMPORTS_PER_SOL } : null,
		runwayDays: solvedRunwayDays !== null && solvedRunwayDays < days ? { value: solvedRunwayDays } : null,
		minBudget: { lamports: required, sol: required / LAMPORTS_PER_SOL },
	};
}

/**
 * The env changes that turn a simulated config into a real one. Emitted so the
 * lab hands over an exact, runnable `gcloud run services update` instead of a
 * description of one — the step where hand-transcribed lamport values have gone
 * wrong before. Only keys that actually differ from live are returned, and
 * --update-env-vars is used because --set-env-vars REPLACES the whole set.
 */
export function envDiff(live = {}, proposed = {}) {
	const keys = [
		['runwayDays', 'X402_WALLET_FEE_RUNWAY_DAYS'],
		['minBudgetLamports', 'X402_WALLET_FEE_MIN_BUDGET_LAMPORTS'],
		['floorLamports', 'X402_SPONSOR_SOL_FLOOR_LAMPORTS'],
		['governorEnabled', 'X402_WALLET_FEE_GOVERNOR_ENABLED'],
	];
	const changes = [];
	for (const [field, envName] of keys) {
		if (proposed[field] === undefined || live[field] === undefined) continue;
		if (String(proposed[field]) === String(live[field])) continue;
		changes.push({ env: envName, from: String(live[field]), to: String(proposed[field]) });
	}
	return changes;
}

export function formatSol(lamports, digits = 4) {
	const n = Number(lamports) / LAMPORTS_PER_SOL;
	if (!Number.isFinite(n)) return '0';
	return n.toFixed(digits).replace(/\.?0+$/, '') || '0';
}
