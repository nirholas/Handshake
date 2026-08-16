/**
 * Tournament scoring engine — PURE. No DB, no network.
 *
 * Deterministic over an array of {entry, positions} pairs, exactly like
 * computeTraderMetrics is deterministic over positions. This is what the tests pin
 * and what guarantees the live board, the SSE stream, and the final attested
 * standings can never disagree.
 *
 * The fairness rules, baked in and honest:
 *   1. WINDOW SCOPING — only positions OPENED inside [starts_at, min(now, ends_at)]
 *      count. A pre-window winner can't be carried in; a position opened after the
 *      bell can't pad the score.
 *   2. REAL-TRADE GATE (prize bracket) — simulated/paper positions (no real buy
 *      signature) are excluded from prize scoring. They are the practice bracket's
 *      domain, clearly labelled, and never earn $THREE.
 *   3. VERIFICATION GATES — the same min-closed / min-unique-coins / max-churn gates
 *      the verification badge uses decide PRIZE ELIGIBILITY. Ineligible entrants are
 *      still ranked and shown; they just can't win a prize.
 *   4. A RESULT BEATS NO RESULT: an entrant who closed nothing inside the window has
 *      produced no result, so it ranks below everyone who did, whatever the scoring
 *      mode says. Under realized-P&L scoring an idle entrant otherwise scores a clean
 *      0 and outranks every agent brave enough to take a real loss, which crowns
 *      no-shows and starves the prize splits (allocatePrizes pays only eligible ranks,
 *      and an entrant with zero closed trades can never clear min_closed).
 *   5. CHURN HEURISTIC, NAMED AS SUCH: we flag high-churn/single-coin entries as
 *      wash-suspected. We do NOT claim counterparty wash detection we can't do from
 *      one-sided position data (same honesty rule as trader-stats.js); the on-chain
 *      buy/sell signatures are the real integrity guarantee.
 *
 * All metric arithmetic defers to computeTraderMetrics so there is one truth layer.
 */

import { computeTraderMetrics } from './trader-stats.js';

/** Default prize-eligibility gates; a tournament's entry_rules override these. */
export const DEFAULT_GATES = { min_closed: 3, min_unique_coins: 2, max_churn_pct: 60 };

/** A position is a REAL on-chain trade iff it carries a genuine buy signature. */
export function isRealTrade(p) {
	const sig = p.buy_sig;
	return !!sig && sig !== 'SIMULATED';
}

/**
 * Filter a trader's positions to the ones that count for a tournament:
 *   - opened strictly within the window (open time, not close time — fairness rule 1)
 *   - for a 'prize' bracket, real on-chain trades only (fairness rule 2)
 */
export function filterWindowPositions(positions, { startIso, endIso, bracket = 'prize' }) {
	const start = new Date(startIso).getTime();
	const end = new Date(endIso).getTime();
	return positions.filter((p) => {
		const opened = new Date(p.opened_at).getTime();
		if (!(opened >= start && opened <= end)) return false;
		if (bracket === 'prize' && !isRealTrade(p)) return false;
		return true;
	});
}

/** Resolve the gates for a tournament, merging its entry_rules over the defaults. */
export function resolveGates(tournament) {
	const r = tournament?.entry_rules || {};
	return {
		min_closed: numOr(r.min_closed, DEFAULT_GATES.min_closed),
		min_unique_coins: numOr(r.min_unique_coins, DEFAULT_GATES.min_unique_coins),
		max_churn_pct: numOr(r.max_churn_pct, DEFAULT_GATES.max_churn_pct),
	};
}

function numOr(v, d) {
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : d;
}

/** Map a metric set to the single number a tournament ranks on. */
export function scoreValue(metrics, scoring) {
	switch (scoring) {
		case 'realized_pnl':
			return metrics.realized_pnl_sol;
		case 'roi_pct':
			return metrics.roi_pct;
		case 'score':
		default:
			return metrics.score;
	}
}

/**
 * Evaluate prize eligibility + anti-cheat flags for one entry's window metrics.
 * Returns { eligible, reasons:[], wash_suspected }.
 */
export function evaluateEligibility({ metrics, gates, bracket, realTrades }) {
	const reasons = [];
	if (bracket === 'practice') reasons.push('practice_bracket');
	if (metrics.closed_count < gates.min_closed) reasons.push(`min_closed_${gates.min_closed}`);
	if (metrics.unique_coins < gates.min_unique_coins) reasons.push(`min_unique_coins_${gates.min_unique_coins}`);
	if (metrics.churn_pct > gates.max_churn_pct) reasons.push(`churn_over_${gates.max_churn_pct}`);
	if (bracket === 'prize' && realTrades === 0) reasons.push('no_real_trades');

	// Churn-based wash heuristic (NOT counterparty wash detection — see header).
	const wash_suspected =
		metrics.closed_count >= 4 &&
		metrics.unique_coins <= 1 &&
		metrics.churn_pct >= gates.max_churn_pct;
	if (wash_suspected) reasons.push('wash_suspected');

	const eligible = bracket === 'prize' && reasons.length === 0;
	return { eligible, reasons, wash_suspected };
}

/**
 * Allocate the prize pool across the eligible, ranked standings per prize_splits
 * (basis points by rank). Returns Map(agentId -> prizeAtomics:bigint). Splits that
 * land on an ineligible/absent rank go UNALLOCATED — we never reassign a prize the
 * structure didn't promise.
 *
 * @param {bigint} poolAtomics  prize pool in $THREE base units
 * @param {Array}  splits       [{rank, bps}, …]
 * @param {Array}  ranked       standings already sorted, each {agent_id, rank, eligible}
 */
export function allocatePrizes(poolAtomics, splits, ranked) {
	const out = new Map();
	if (!poolAtomics || poolAtomics <= 0n || !Array.isArray(splits)) return out;
	const byRank = new Map(ranked.map((s) => [s.rank, s]));
	for (const split of splits) {
		const rank = Number(split?.rank);
		const bps = Number(split?.bps);
		if (!Number.isInteger(rank) || !Number.isFinite(bps) || bps <= 0) continue;
		const s = byRank.get(rank);
		if (!s || !s.eligible) continue; // unallocated — honest, not redistributed
		const amount = (poolAtomics * BigInt(Math.round(bps))) / 10000n;
		if (amount > 0n) out.set(s.agent_id, (out.get(s.agent_id) || 0n) + amount);
	}
	return out;
}

/**
 * Compute the full live standings for a tournament.
 *
 * @param {object} tournament  tournament row (scoring, bracket, entry_rules, window)
 * @param {Array}  pairs       [{ entry, positions }] — entry rows joined to identity,
 *                             positions are that agent's raw agent_sniper_positions
 * @param {object} [opts]
 * @param {number|null} [opts.solUsd]
 * @param {number} [opts.now]  injectable clock
 * @returns {{ standings: Array, scoring, bracket, window: {start,end}, computed_at }}
 */
export function computeStandings(tournament, pairs, { solUsd = null, now = Date.now() } = {}) {
	const startIso = tournament.starts_at;
	const endIso = new Date(Math.min(now, new Date(tournament.ends_at).getTime())).toISOString();
	const gates = resolveGates(tournament);
	const bracket = tournament.bracket || 'prize';
	const scoring = tournament.scoring || 'score';

	const rows = pairs.map(({ entry, positions }) => {
		const windowPositions = filterWindowPositions(positions, { startIso, endIso, bracket });
		const realTrades = windowPositions.filter(isRealTrade).length;
		const metrics = computeTraderMetrics(windowPositions, { solUsd });
		const elig = evaluateEligibility({ metrics, gates, bracket, realTrades });
		const value = scoreValue(metrics, scoring);
		return {
			agent_id: entry.agent_id,
			agent_name: entry.agent_name || null,
			// Row thumbnails render as <img>, so only use a flat profile image here; the
			// glb (avatar_url) drives the 3D spotlight separately and isn't an image.
			image: entry.profile_image_url || null,
			glb_url: entry.avatar_url || null,
			wallet: entry.wallet || null,
			joined_at: entry.joined_at,
			entry_status: entry.status,
			score_value: round(value),
			metrics: summarize(metrics),
			eligible: elig.eligible && entry.status === 'active',
			ineligible_reasons: elig.reasons,
			wash_suspected: elig.wash_suspected,
			in_window_trades: metrics.closed_count,
			open_window_trades: metrics.open_count,
			sample_trades: sampleTrades(windowPositions, tournament.network),
		};
	});

	// Withdrawn entries fall out of the ranking entirely; disqualified sink to the
	// bottom, then entrants with no closed trade in the window (rule 4: a result
	// beats no result). Everyone else is ranked by the tournament's score,
	// descending, with a stable realized-PnL → closed-count tiebreak.
	const active = rows.filter((r) => r.entry_status !== 'withdrawn');
	active.sort((a, b) => {
		const aDq = a.entry_status === 'disqualified' ? 1 : 0;
		const bDq = b.entry_status === 'disqualified' ? 1 : 0;
		if (aDq !== bDq) return aDq - bDq;
		const aIdle = a.in_window_trades > 0 ? 0 : 1;
		const bIdle = b.in_window_trades > 0 ? 0 : 1;
		if (aIdle !== bIdle) return aIdle - bIdle;
		return (
			b.score_value - a.score_value ||
			b.metrics.realized_pnl_sol - a.metrics.realized_pnl_sol ||
			b.in_window_trades - a.in_window_trades
		);
	});
	const standings = active.map((r, i) => ({ rank: r.entry_status === 'disqualified' ? null : i + 1, ...r }));

	return {
		standings,
		scoring,
		bracket,
		gates,
		window: { start: startIso, end: tournament.ends_at },
		computed_at: now,
	};
}

function summarize(m) {
	return {
		score: m.score,
		verified: m.verified,
		realized_pnl_sol: m.realized_pnl_sol,
		realized_pnl_usd: m.realized_pnl_usd,
		roi_pct: m.roi_pct,
		win_rate: m.win_rate,
		closed_count: m.closed_count,
		wins: m.wins,
		losses: m.losses,
		unique_coins: m.unique_coins,
		churn_pct: m.churn_pct,
		max_drawdown_pct: m.max_drawdown_pct,
		best_pnl_pct: m.best_pnl_pct,
	};
}

function sampleTrades(positions, network) {
	return [...positions]
		.filter((p) => p.status === 'closed')
		.sort((a, b) => new Date(b.closed_at || b.opened_at) - new Date(a.closed_at || a.opened_at))
		.slice(0, 3)
		.map((p) => ({
			mint: p.mint,
			symbol: p.symbol,
			pnl_sol: p.realized_pnl_lamports != null ? Number(BigInt(p.realized_pnl_lamports)) / 1e9 : null,
			pnl_pct: p.realized_pnl_pct != null ? Number(p.realized_pnl_pct) : null,
			closed_at: p.closed_at,
			tx_url: txUrl(p.sell_sig || p.buy_sig, network),
		}));
}

function txUrl(sig, network) {
	if (!sig || sig === 'SIMULATED') return null;
	return network === 'devnet' ? `https://solscan.io/tx/${sig}?cluster=devnet` : `https://solscan.io/tx/${sig}`;
}

function round(n) {
	return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}
