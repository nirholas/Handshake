// Reputation Staking Market — the pure earnings engine.
//
// Stakers back an agent with escrowed lamports; the agent's ATTESTED ACTION
// HISTORY decides what that conviction earns. This module is the only place the
// weights, the epoch math, and the distribution rule exist. It is the executable
// form of specs/REPUTATION_STAKING_MARKET.md §5.
//
// Intentionally PURE: no I/O, no imports. The same functions run
// server-authoritatively in api/_lib/reputation-market.js (which does the real
// chain + index reads) and in the browser on /reputation/market, so a staker can
// re-derive every lamport the server quotes them. Unit-tested in
// tests/reputation-staking.test.js.
//
// ── Design principles (read before touching the weights) ─────────────────────
//
//   1. Every input is a signed, indexed attestation that already exists on
//      Solana (api/_lib/solana-attestations.js). Nothing here invents activity.
//
//   2. Conviction is not work. Stake and unstake attestations contribute zero to
//      the yield they earn; otherwise the market would pay itself.
//
//   3. Faults cost double what work pays, so a failed validation is never
//      cancelled out by the passed one next to it.
//
//   4. Yield is concave in activity (log2), so spraying cheap attestations does
//      not buy proportional yield.
//
//   5. The pool is a fixed per-epoch budget, never a rate. The market can never
//      owe more than the escrow holds.
//
//   6. An agent with no attested work earns its stakers nothing. Idle is not
//      punished, it is simply unpaid.

/** Seconds in one epoch. An epoch is one UTC day. */
export const EPOCH_SECONDS = 86_400;

/** Minimum escrow delta for a transaction to count as a market stake (0.001 SOL). */
export const MIN_STAKE_LAMPORTS = 1_000_000n;

/** The market envelope tag that separates a market stake from a bare conviction memo. */
export const MARKET_TAG = 'rsm.v1';

/** Weight each attested action contributes to an agent's epoch `work`. */
export const WORK_WEIGHTS = Object.freeze({
	taskAccepted: 1.0,
	taskOffered: 0.6,
	validationPassed: 1.0,
	feedbackVerified: 0.75,
	feedbackPlain: 0.35,
});

/** Weight each attested failure contributes to an agent's epoch `faults`. */
export const FAULT_WEIGHTS = Object.freeze({
	validationFailed: 1.0,
	dispute: 1.0,
	revocation: 1.0,
});

/** Faults are charged at this multiple of the rate work is credited. */
export const FAULT_PENALTY = 2;

/** Quality of an agent that received no feedback in an epoch. Silence is neutral. */
export const NEUTRAL_QUALITY = 0.5;

/** Decimal places every intermediate is rounded to, so server and browser agree exactly. */
const PRECISION = 9;

const round = (n) => {
	const f = 10 ** PRECISION;
	return Math.round((Number(n) || 0) * f) / f;
};

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** The epoch a unix-seconds timestamp falls in. */
export function epochOf(unixSeconds) {
	return Math.floor(Number(unixSeconds) / EPOCH_SECONDS);
}

/** The half-open `[start, end)` unix-second bounds of an epoch. */
export function epochBounds(epoch) {
	const start = Number(epoch) * EPOCH_SECONDS;
	return { start, end: start + EPOCH_SECONDS };
}

/**
 * The fraction of an epoch a position was open for, in [0, 1].
 *
 * @param {{ openedAt: number, closedAt?: number|null }} position unix seconds
 * @param {number} epoch
 * @param {number} now unix seconds, used when the position is still open
 */
export function epochFraction(position, epoch, now) {
	const { start, end } = epochBounds(epoch);
	const opened = Number(position.openedAt) || 0;
	const closedRaw = position.closedAt === null || position.closedAt === undefined ? now : position.closedAt;
	const closed = Math.min(Number(closedRaw) || 0, now);
	const from = Math.max(opened, start);
	const to = Math.min(closed, end);
	if (to <= from) return 0;
	// Exact by design (spec section 4): overlap seconds over 86400, no rounding.
	// The 9-decimal rounding rule covers the section 5 earnings intermediates;
	// rounding here would credit a one-second sliver as a fatter slice than it is.
	return (to - from) / EPOCH_SECONDS;
}

/**
 * Fold an agent's attestations for one epoch into `work` and `faults`.
 *
 * Each entry is `{ kind, verified, passed, score, taskAccepted }` — exactly the
 * columns `solana_attestations` already carries. Revoked rows must be filtered
 * out by the caller; a revoked attestation is not evidence of anything.
 *
 * @param {Array<object>} attestations
 * @returns {{ work: number, faults: number, feedbackCount: number, feedbackScoreSum: number, counts: object }}
 */
export function foldActions(attestations) {
	let work = 0;
	let faults = 0;
	let feedbackCount = 0;
	let feedbackScoreSum = 0;
	const counts = {
		taskAccepted: 0,
		taskOffered: 0,
		validationPassed: 0,
		validationFailed: 0,
		feedbackVerified: 0,
		feedbackPlain: 0,
		dispute: 0,
		revocation: 0,
	};

	for (const a of Array.isArray(attestations) ? attestations : []) {
		if (!a || a.verified === false) continue;
		switch (a.kind) {
			case 'threews.accept.v1':
				work += WORK_WEIGHTS.taskAccepted;
				counts.taskAccepted++;
				break;
			case 'threews.task.v1':
				work += WORK_WEIGHTS.taskOffered;
				counts.taskOffered++;
				break;
			case 'threews.validation.v1':
				if (a.passed === true) {
					work += WORK_WEIGHTS.validationPassed;
					counts.validationPassed++;
				} else {
					faults += FAULT_WEIGHTS.validationFailed;
					counts.validationFailed++;
				}
				break;
			case 'threews.feedback.v1': {
				const linked = a.taskAccepted === true;
				work += linked ? WORK_WEIGHTS.feedbackVerified : WORK_WEIGHTS.feedbackPlain;
				if (linked) counts.feedbackVerified++;
				else counts.feedbackPlain++;
				const score = Number(a.score);
				if (Number.isFinite(score) && score >= 1 && score <= 5) {
					feedbackCount++;
					feedbackScoreSum += score;
				}
				break;
			}
			case 'threews.dispute.v1':
				faults += FAULT_WEIGHTS.dispute;
				counts.dispute++;
				break;
			case 'threews.revoke.v1':
				faults += FAULT_WEIGHTS.revocation;
				counts.revocation++;
				break;
			default:
				// threews.stake.v1 / threews.unstake.v1 and any future kind: conviction
				// is not work, and an unknown kind is not evidence of work either.
				break;
		}
	}

	return {
		work: round(work),
		faults: round(faults),
		feedbackCount,
		feedbackScoreSum: round(feedbackScoreSum),
		counts,
	};
}

/**
 * An agent's yield weight for one epoch, plus the full derivation so the UI can
 * show a staker exactly where the number came from.
 *
 * @param {Array<object>} attestations the epoch's verified, non-revoked rows
 * @returns {{ weight: number, performance: number, quality: number, integrity: number, work: number, faults: number, meanFeedbackScore: number|null, counts: object }}
 */
export function agentEpochWeight(attestations) {
	const folded = foldActions(attestations);
	const { work, faults, feedbackCount, feedbackScoreSum } = folded;

	const meanFeedbackScore = feedbackCount > 0 ? round(feedbackScoreSum / feedbackCount) : null;
	const quality = meanFeedbackScore === null ? NEUTRAL_QUALITY : round(clamp01((meanFeedbackScore - 1) / 4));
	const integrity = work + faults > 0 ? round(work / (work + FAULT_PENALTY * faults)) : 1;
	const performance = round(quality * integrity);
	const weight = round(performance * Math.log2(1 + work));

	return {
		weight,
		performance,
		quality,
		integrity,
		work,
		faults,
		meanFeedbackScore,
		counts: folded.counts,
	};
}

/**
 * Split one epoch's reward pool across the positions open during it.
 *
 * `positions` are `{ id, agentAsset, principalLamports (bigint|string), openedAt, closedAt }`.
 * `agentWeights` maps `agentAsset → weight` (from agentEpochWeight).
 * `poolLamports` is the epoch's fixed budget.
 *
 * Returns a Map of `id → { lamports: bigint, posWeight, epochFraction }`. Floor
 * division guarantees the sum never exceeds the pool; the remainder rolls over.
 *
 * @returns {{ payouts: Map<string, {lamports: bigint, posWeight: number, epochFraction: number}>, totalWeight: number, distributed: bigint }}
 */
export function distributeEpoch({ epoch, positions, agentWeights, poolLamports, now }) {
	const pool = toBigInt(poolLamports);
	const weights = agentWeights instanceof Map ? agentWeights : new Map(Object.entries(agentWeights || {}));
	const nowSec = Number(now);
	const rows = [];
	let totalWeight = 0;

	for (const p of Array.isArray(positions) ? positions : []) {
		const fraction = epochFraction(p, epoch, nowSec);
		if (fraction <= 0) continue;
		const principal = toBigInt(p.principalLamports);
		if (principal <= 0n) continue;
		const agentWeight = Number(weights.get(p.agentAsset) ?? 0) || 0;
		const posWeight = round(Number(principal) * fraction * agentWeight);
		rows.push({ id: p.id, posWeight, fraction });
		totalWeight = round(totalWeight + posWeight);
	}

	const payouts = new Map();
	let distributed = 0n;
	for (const r of rows) {
		let lamports = 0n;
		if (totalWeight > 0 && pool > 0n && r.posWeight > 0) {
			// Ratio in float, applied to the bigint pool. posWeight/totalWeight is a
			// bounded [0,1] fraction, so the float cannot lose lamport-scale precision
			// the way multiplying two lamport-magnitude floats would.
			lamports = BigInt(Math.floor(Number(pool) * (r.posWeight / totalWeight)));
		}
		payouts.set(r.id, { lamports, posWeight: r.posWeight, epochFraction: r.fraction });
		distributed += lamports;
	}

	return { payouts, totalWeight, distributed };
}

/**
 * Total earnings for ONE position across every epoch it overlapped.
 *
 * `epochInputs` maps `epoch → { poolLamports, positions, agentWeights }` — the
 * same shape distributeEpoch takes, because a position's share depends on every
 * other position competing for that epoch's pool.
 *
 * @returns {{ lamports: bigint, byEpoch: Array<{epoch: number, lamports: string, posWeight: number, epochFraction: number}> }}
 */
export function accruePosition({ position, epochInputs, now }) {
	const byEpoch = [];
	let total = 0n;
	const epochs = [...(epochInputs instanceof Map ? epochInputs.keys() : Object.keys(epochInputs || {}))]
		.map(Number)
		.sort((a, b) => a - b);

	for (const epoch of epochs) {
		const input = epochInputs instanceof Map ? epochInputs.get(epoch) : epochInputs[epoch];
		if (!input) continue;
		const { payouts } = distributeEpoch({
			epoch,
			positions: input.positions,
			agentWeights: input.agentWeights,
			poolLamports: input.poolLamports,
			now,
		});
		const share = payouts.get(position.id);
		if (!share || (share.lamports === 0n && share.posWeight === 0)) continue;
		total += share.lamports;
		byEpoch.push({
			epoch,
			lamports: share.lamports.toString(),
			posWeight: share.posWeight,
			epochFraction: share.epochFraction,
		});
	}

	return { lamports: total, byEpoch };
}

/**
 * The epochs a position overlapped, inclusive of the current one.
 *
 * @returns {number[]}
 */
export function positionEpochs(position, now) {
	const opened = Number(position.openedAt) || 0;
	const closedRaw = position.closedAt === null || position.closedAt === undefined ? now : position.closedAt;
	const closed = Math.min(Number(closedRaw) || 0, Number(now));
	const first = epochOf(opened);
	const last = epochOf(Math.max(closed, opened));
	const out = [];
	for (let e = first; e <= last; e++) out.push(e);
	return out;
}

/**
 * Realized annualised rate for a position. Never a projection: it divides
 * earnings that have actually accrued by the time they took to accrue.
 *
 * @returns {number} e.g. 0.184 for 18.4%
 */
export function realizedApr({ principalLamports, earningsLamports, openedAt, closedAt, now }) {
	const principal = Number(toBigInt(principalLamports));
	const earnings = Number(toBigInt(earningsLamports));
	if (principal <= 0) return 0;
	const end = closedAt === null || closedAt === undefined ? Number(now) : Number(closedAt);
	const elapsedDays = (end - Number(openedAt)) / EPOCH_SECONDS;
	if (!(elapsedDays > 0)) return 0;
	return round((earnings / principal) * (365 / elapsedDays));
}

/**
 * Clamp a settlement to what the escrow can actually pay. Principal is always
 * returned in full; only earnings are reduced, and only when the reward surplus
 * is short. See spec §2.
 *
 * @returns {{ principal: bigint, earnings: bigint, clamped: boolean }}
 */
export function clampSettlement({ principalLamports, earningsLamports, surplusLamports }) {
	const principal = toBigInt(principalLamports);
	const earnings = toBigInt(earningsLamports);
	const surplus = toBigInt(surplusLamports);
	if (earnings <= surplus) return { principal, earnings, clamped: false };
	return { principal, earnings: surplus < 0n ? 0n : surplus, clamped: true };
}

/** Parse lamports from a bigint, a decimal string, or a safe number. */
export function toBigInt(v) {
	if (typeof v === 'bigint') return v;
	if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n;
	if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
	return 0n;
}

/** Lamports as a human SOL string with the given precision. */
export function formatSol(lamports, decimals = 4) {
	const n = Number(toBigInt(lamports)) / 1e9;
	return n.toFixed(decimals);
}
