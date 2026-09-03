// Meta-Allocator, the "ETF of degens" brain (pumpfun-trading-wedge §3.3 / §4.2).
// ---------------------------------------------------------------------------
// A first-class agent type whose entire strategy is to ALLOCATE a fixed budget
// across the top verified leader agents and rebalance, it never picks tokens,
// only leaders. The leaderboard becomes an input to a strategy, so the system
// compounds on itself (better leaders -> better meta-agents -> more copy demand).
//
// It is the diversified on-ramp for the cautious: "just make me money" as a
// spread of verified track records instead of one bet. This module is the
// planning brain only. It is fully NON-CUSTODIAL, it emits an allocation PLAN
// (weights + suggested sizes + a plain-English rebalance rule), never a signed
// transaction, never delegated custody. Executing the plan is the copy-engine's
// existing per-leader subscribe flow, one confirmed action at a time.
//
// Every leader stat traces to a real on-chain fill (agent_sniper_positions
// closed round-trips), the same honest source the mirror leaderboard ranks on.
// The LLM (free-first llmComplete chain) shapes the narrative and the diversified
// pick; when no provider is available the deterministic allocator below produces
// the same-shaped plan so the endpoint never fails.

import { sql } from './db.js';
import { llmComplete, llmConfigured, LlmUnavailableError } from './llm.js';
import { extractJson } from './bounty-judge.js';

const LAMPORTS = 1e9;
const lamToSol = (l) => (l == null ? 0 : Number(BigInt(Math.trunc(Number(l)))) / LAMPORTS);
const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 1e4) / 1e4;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export const RISK_PROFILES = new Set(['conservative', 'balanced', 'degen']);

// Per-profile guardrails the deterministic allocator (and the model, via the
// prompt) respects. Conservative = fewer, steadier leaders, hard drawdown cap
// and a low single-leader weight ceiling; degen = wider, spicier basket.
const PROFILE_RULES = {
	conservative: { maxLeaders: 4, maxWeightPct: 35, maxDrawdownPct: 40, minSettled: 5 },
	balanced:     { maxLeaders: 6, maxWeightPct: 45, maxDrawdownPct: 70, minSettled: 3 },
	degen:        { maxLeaders: 8, maxWeightPct: 60, maxDrawdownPct: 100, minSettled: 1 },
};

// ---------------------------------------------------------------------------
// Data, pull the verified leader universe in a single windowed query.
// max_drawdown is computed on the cumulative realized-P&L equity curve
// (peak-to-trough), the same definition mirror-stats.js uses per-leader, so the
// number a copier sees on a Trader Card matches the one the allocator ranks on.
// ---------------------------------------------------------------------------
export async function gatherLeaders(network = 'mainnet', { limit = 200 } = {}) {
	const rows = await sql`
		with closed as (
			select agent_id, closed_at, realized_pnl_lamports, realized_pnl_pct, entry_quote_lamports,
			       sum(realized_pnl_lamports) over (
			           partition by agent_id order by closed_at
			           rows between unbounded preceding and current row) as cum_pnl
			from agent_sniper_positions
			where network = ${network} and status = 'closed' and closed_at is not null
		),
		curve as (
			select agent_id, cum_pnl,
			       max(cum_pnl) over (
			           partition by agent_id order by closed_at
			           rows between unbounded preceding and current row) as peak
			from closed
		),
		dd as (
			select agent_id, max(peak - cum_pnl) as max_dd_lamports from curve group by agent_id
		),
		agg as (
			select agent_id,
			       count(*)::int as settled,
			       count(*) filter (where realized_pnl_lamports > 0)::int as wins,
			       coalesce(sum(realized_pnl_lamports), 0)::text as pnl_lamports,
			       coalesce(sum(entry_quote_lamports), 0)::text as entry_lamports,
			       coalesce(avg(entry_quote_lamports), 0)::text as avg_entry_lamports,
			       max(realized_pnl_pct) as best_pct,
			       min(realized_pnl_pct) as worst_pct,
			       max(closed_at) as last_closed_at
			from closed group by agent_id
		),
		-- Self-follows excluded, same as the mirror leaderboard: an owner's own
		-- mirror edges must not weight this allocator's view of a leader.
		followers as (
			select f.leader_agent_id as agent_id,
			       count(*)::int as followers,
			       count(*) filter (where f.enabled)::int as active_followers
			from agent_mirror_follows f
			join agent_identities la on la.id = f.leader_agent_id and la.user_id <> f.owner_user_id
			where f.network = ${network} group by f.leader_agent_id
		)
		select a.id, a.name, a.avatar_url, a.profile_image_url,
		       g.settled, g.wins, g.pnl_lamports, g.entry_lamports, g.avg_entry_lamports,
		       g.best_pct, g.worst_pct, g.last_closed_at,
		       coalesce(dd.max_dd_lamports, 0)::text as max_dd_lamports,
		       coalesce(f.followers, 0) as followers,
		       coalesce(f.active_followers, 0) as active_followers
		from agent_identities a
		join agg g on g.agent_id = a.id
		left join dd on dd.agent_id = a.id
		left join followers f on f.agent_id = a.id
		where a.deleted_at is null and a.is_public <> false and g.settled >= 1
		order by g.settled desc
		limit ${Math.min(500, Math.max(1, limit))}
	`.catch(() => []);

	return rows.map((r) => {
		const settled = Number(r.settled || 0);
		const wins = Number(r.wins || 0);
		const pnlSol = lamToSol(r.pnl_lamports);
		const grossEntrySol = lamToSol(r.entry_lamports);
		const avgEntrySol = lamToSol(r.avg_entry_lamports);
		const maxDdSol = lamToSol(r.max_dd_lamports);
		const winRate = settled > 0 ? (wins / settled) * 100 : null;
		const roiPct = grossEntrySol > 0 ? (pnlSol / grossEntrySol) * 100 : null;
		// Drawdown as a share of capital actually deployed, comparable across
		// leaders of different size.
		const maxDrawdownPct = grossEntrySol > 0 ? clamp((maxDdSol / grossEntrySol) * 100, 0, 100) : null;
		const followers = Number(r.followers || 0);

		// Risk-adjusted score: reward realized ROI and win-rate edge, weighted by
		// sample size so a 1-trade fluke can't top a consistent trader, then
		// penalize drawdown. NOT raw P&L (a whale's big number shouldn't outrank a
		// steadier, more copyable record). Bounded, deterministic, explainable.
		const sample = Math.min(1, settled / 8);
		const edge = (roiPct != null ? roiPct : 0) * 0.5 + (winRate != null ? (winRate - 50) : 0);
		const ddPenalty = maxDrawdownPct != null ? maxDrawdownPct * 0.4 : 0;
		const trust = Math.min(15, followers * 1.5);
		const riskAdjusted = round2(edge * sample - ddPenalty + trust);

		return {
			agent_id: r.id,
			name: r.name || 'Unnamed trader',
			avatar: r.avatar_url || r.profile_image_url || null,
			settled, wins,
			win_rate_pct: winRate == null ? null : round2(winRate),
			roi_pct: roiPct == null ? null : round2(roiPct),
			pnl_sol: round4(pnlSol),
			max_drawdown_pct: maxDrawdownPct == null ? null : round2(maxDrawdownPct),
			best_pct: r.best_pct == null ? null : round2(Number(r.best_pct)),
			worst_pct: r.worst_pct == null ? null : round2(Number(r.worst_pct)),
			// Capacity proxy: the size this leader actually trades. Allocating much
			// more than this would move their fills, so the plan respects it.
			capacity_quote: round4(avgEntrySol) || null,
			// Real follower-outcome P&L requires a populated copy-execution ledger;
			// when absent it is null and the allocator weights on risk-adjusted score
			// (never fabricated). Exposed so a future copy-outcome rollup can fill it.
			follower_outcome_pnl: null,
			followers, active_followers: Number(r.active_followers || 0),
			correlation_group: correlationGroup({ winRate, roiPct, maxDrawdownPct, bestPct: r.best_pct }),
			risk_adjusted_score: riskAdjusted,
			last_closed_at: r.last_closed_at || null,
		};
	});
}

// Correlation group, a REAL derived style bucket from realized behavior, used
// only to diversify the basket (never concentrate in one style). Derived from
// the win-rate / ROI / drawdown / best-trade profile, not a random label.
function correlationGroup({ winRate, roiPct, maxDrawdownPct, bestPct }) {
	const best = bestPct == null ? null : Number(bestPct);
	if (best != null && best >= 300 && (winRate == null || winRate < 50)) return 'moonshot';
	if (winRate != null && winRate >= 62) return 'high_winrate';
	if (roiPct != null && roiPct >= 80) return 'high_roi';
	if (maxDrawdownPct != null && maxDrawdownPct >= 60) return 'volatile';
	return 'steady';
}

// ---------------------------------------------------------------------------
// The plan, LLM-shaped, with a deterministic fallback of the same shape.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You allocate a fixed budget across VERIFIED leader agents and rebalance. You do not pick individual tokens; you pick leaders. You only use the real leaderboard data provided.

Output STRICT JSON only, no prose, no code fence:
{ "allocations": [ {"agent_id": "<id>", "weight_pct": <num>, "why": "one fact-based line"} ],
  "excluded": [ {"agent_id": "<id>", "reason": "one line"} ],
  "rebalance_rule": "plain-English trigger (e.g. drop a leader if 7d drawdown > X% or correlation to an existing pick is too high)",
  "caution": "one honest risk line" }

Rules: diversify across correlation_group values, never concentrate the basket in one style. Weight by follower_outcome_pnl and risk_adjusted_score, NOT raw P&L. Respect each leader's capacity_quote (do not allocate size that moves their fills). For conservative profiles cap single-leader weight and prefer low max_drawdown_pct. Default to fewer, steadier leaders when uncertain. Weights across all allocations must sum to 100. Only reference agent_id values present in the input. Never predict future performance. Reference no token other than the ones the leaders traded or $THREE.`;

export async function buildAllocationPlan({
	budgetQuote,
	riskProfile = 'balanced',
	leaders,
	currentAllocations = [],
	network = 'mainnet',
	userId = null,
} = {}) {
	const profile = RISK_PROFILES.has(riskProfile) ? riskProfile : 'balanced';
	const rules = PROFILE_RULES[profile];
	const budget = Number(budgetQuote);
	const budgetOk = Number.isFinite(budget) && budget > 0 ? budget : null;

	// The universe the allocator is allowed to pick from, public verified leaders
	// meeting the profile's minimum settled-trade bar.
	const universe = (leaders || []).filter((l) => l.settled >= rules.minSettled);
	if (!universe.length) {
		return {
			source: 'empty',
			budget_quote: budgetOk,
			quote_symbol: 'SOL',
			risk_profile: profile,
			allocations: [],
			excluded: [],
			rebalance_rule: 'No verified leaders meet this risk profile yet. Loosen the profile or wait for more on-chain track records to settle.',
			caution: 'An allocation needs verified leaders with real closed trades. None qualify right now.',
			leaders_considered: 0,
		};
	}

	let plan = null;
	let source = 'deterministic';
	if (llmConfigured()) {
		try {
			plan = await llmPlan({ budget: budgetOk, profile, universe, currentAllocations, userId });
			if (plan) source = 'llm';
		} catch (err) {
			if (!(err instanceof LlmUnavailableError)) {
				// Any model error degrades to the deterministic plan, never a 500.
				plan = null;
			}
		}
	}
	if (!plan) plan = deterministicPlan({ profile, universe });

	return finalizePlan({ plan, source, universe, budget: budgetOk, profile });
}

async function llmPlan({ budget, profile, universe, currentAllocations, userId }) {
	const input = {
		budget_quote: budget,
		quote_symbol: 'SOL',
		risk_profile: profile,
		leaders: universe.map((l) => ({
			agent_id: l.agent_id,
			win_rate_pct: l.win_rate_pct,
			risk_adjusted_score: l.risk_adjusted_score,
			max_drawdown_pct: l.max_drawdown_pct,
			follower_outcome_pnl: l.follower_outcome_pnl,
			capacity_quote: l.capacity_quote,
			correlation_group: l.correlation_group,
			settled_trades: l.settled,
		})),
		current_allocations: Array.isArray(currentAllocations) ? currentAllocations.slice(0, 20) : [],
	};
	const out = await llmComplete({
		system: SYSTEM_PROMPT,
		user: JSON.stringify(input),
		maxTokens: 1200,
		timeoutMs: 30_000,
		track: userId ? { userId, tool: 'meta-allocator' } : null,
	});
	const parsed = extractJson(out?.text);
	// An empty allocations array is a non-answer, not a plan: the caller asked
	// how to split a budget across a universe that already passed the profile's
	// minimum-settled bar, so "allocate to nobody" is the model declining rather
	// than deciding. Returning null hands the request to the deterministic
	// allocator, which always produces a real basket from the same universe.
	// Observed live: a model reply of {"allocations":[],"excluded":[]} shipped a
	// plan with zero rows and zero exclusions while 8 leaders qualified.
	if (!parsed || !Array.isArray(parsed.allocations) || parsed.allocations.length === 0) return null;
	return {
		allocations: parsed.allocations,
		excluded: Array.isArray(parsed.excluded) ? parsed.excluded : [],
		rebalance_rule: typeof parsed.rebalance_rule === 'string' ? parsed.rebalance_rule : null,
		caution: typeof parsed.caution === 'string' ? parsed.caution : null,
	};
}

// Deterministic allocator: diversify across correlation groups (one best per
// group first, then backfill by score), weight by risk-adjusted score, honor the
// profile's leader count + single-weight caps. Same shape as the LLM output.
function deterministicPlan({ profile, universe }) {
	const rules = PROFILE_RULES[profile];
	const ranked = [...universe]
		.filter((l) => l.max_drawdown_pct == null || l.max_drawdown_pct <= rules.maxDrawdownPct)
		.sort((a, b) => b.risk_adjusted_score - a.risk_adjusted_score);

	const picks = [];
	const seenGroups = new Set();
	// Pass 1: best of each correlation group for spread.
	for (const l of ranked) {
		if (picks.length >= rules.maxLeaders) break;
		if (seenGroups.has(l.correlation_group)) continue;
		seenGroups.add(l.correlation_group);
		picks.push(l);
	}
	// Pass 2: backfill remaining slots by score.
	for (const l of ranked) {
		if (picks.length >= rules.maxLeaders) break;
		if (picks.includes(l)) continue;
		picks.push(l);
	}

	// Weight by a positive score floor so a marginally-negative score still gets a
	// small, capped allocation rather than a negative weight.
	const scored = picks.map((l) => ({ l, w: Math.max(1, l.risk_adjusted_score + 20) }));
	const totalW = scored.reduce((s, x) => s + x.w, 0) || 1;
	let allocations = scored.map(({ l, w }) => ({
		agent_id: l.agent_id,
		weight_pct: (w / totalW) * 100,
		why: reasonLine(l),
	}));
	allocations = capAndRenormalize(allocations, rules.maxWeightPct);

	const excludedIds = new Set(picks.map((l) => l.agent_id));
	const excluded = universe
		.filter((l) => !excludedIds.has(l.agent_id))
		.slice(0, 8)
		.map((l) => ({
			agent_id: l.agent_id,
			reason:
				l.max_drawdown_pct != null && l.max_drawdown_pct > rules.maxDrawdownPct
					? `Max drawdown ${l.max_drawdown_pct}% exceeds the ${profile} cap of ${rules.maxDrawdownPct}%`
					: 'Lower risk-adjusted score than the selected basket',
		}));

	return {
		allocations,
		excluded,
		rebalance_rule: `Rebalance weekly. Drop any leader whose 7-day realized drawdown exceeds ${rules.maxDrawdownPct}% or whose risk-adjusted score falls below the basket median, and re-spread across correlation groups so no single style holds more than ${rules.maxWeightPct}%.`,
		caution:
			'Copy-trading memecoins is high-variance. A diversified basket lowers single-leader risk but not market risk. Every leader here can still lose; size only what you can afford to lose.',
	};
}

function reasonLine(l) {
	const bits = [];
	if (l.win_rate_pct != null) bits.push(`${l.win_rate_pct}% win rate`);
	if (l.roi_pct != null) bits.push(`${l.roi_pct}% realized ROI`);
	if (l.max_drawdown_pct != null) bits.push(`${l.max_drawdown_pct}% max drawdown`);
	bits.push(`${l.settled} settled trades`);
	return `${l.correlation_group} style: ${bits.join(', ')}`;
}

// Cap any single weight at maxPct and redistribute the overflow across the rest
// proportionally, iterating until stable (all <= cap, sum = 100).
function capAndRenormalize(allocations, maxPct) {
	let a = allocations.map((x) => ({ ...x }));
	for (let iter = 0; iter < 8; iter++) {
		const total = a.reduce((s, x) => s + x.weight_pct, 0) || 1;
		a = a.map((x) => ({ ...x, weight_pct: (x.weight_pct / total) * 100 }));
		const over = a.filter((x) => x.weight_pct > maxPct + 0.01);
		if (!over.length) break;
		let overflow = 0;
		for (const x of over) { overflow += x.weight_pct - maxPct; x.weight_pct = maxPct; }
		const under = a.filter((x) => x.weight_pct < maxPct - 0.01);
		const underTotal = under.reduce((s, x) => s + x.weight_pct, 0) || 1;
		for (const x of under) x.weight_pct += overflow * (x.weight_pct / underTotal);
	}
	return a;
}

// Normalize whatever the model (or fallback) produced into a clean, verified
// plan: only real agent_ids, weights summing to 100, sizes = budget * weight,
// each row enriched with the leader's real stats for the UI.
function finalizePlan({ plan, source, universe, budget, profile }) {
	const byId = new Map(universe.map((l) => [l.agent_id, l]));
	const seen = new Set();
	let allocations = (plan.allocations || [])
		.filter((row) => {
			const id = String(row?.agent_id || '');
			if (!byId.has(id) || seen.has(id)) return false;
			seen.add(id);
			return true;
		})
		.map((row) => ({
			agent_id: row.agent_id,
			weight_pct: Math.max(0, Number(row.weight_pct) || 0),
			why: typeof row.why === 'string' && row.why.trim() ? row.why.trim().slice(0, 160) : reasonLine(byId.get(row.agent_id)),
		}))
		.filter((row) => row.weight_pct > 0);

	// Renormalize to exactly 100 and enforce the profile weight cap regardless of
	// source, so an LLM that ignores a rule still produces a compliant plan.
	allocations = capAndRenormalize(allocations, PROFILE_RULES[profile].maxWeightPct);
	const sum = allocations.reduce((s, x) => s + x.weight_pct, 0) || 1;

	const enriched = allocations.map((row) => {
		const l = byId.get(row.agent_id);
		const weight = (row.weight_pct / sum) * 100;
		return {
			agent_id: row.agent_id,
			name: l.name,
			avatar: l.avatar,
			weight_pct: round2(weight),
			size_quote: budget != null ? round4((budget * weight) / 100) : null,
			why: row.why,
			correlation_group: l.correlation_group,
			win_rate_pct: l.win_rate_pct,
			roi_pct: l.roi_pct,
			max_drawdown_pct: l.max_drawdown_pct,
			settled: l.settled,
			followers: l.followers,
			capacity_quote: l.capacity_quote,
			// A size beyond the leader's typical fill would move their price, flag it
			// so the UI can warn and the user can trim.
			over_capacity: l.capacity_quote != null && budget != null
				? round4((budget * weight) / 100) > l.capacity_quote * 3
				: false,
		};
	});

	const excluded = (plan.excluded || [])
		.filter((x) => byId.has(String(x?.agent_id || '')))
		.slice(0, 10)
		.map((x) => ({
			agent_id: x.agent_id,
			name: byId.get(x.agent_id).name,
			reason: typeof x.reason === 'string' ? x.reason.slice(0, 160) : 'Not selected for this basket',
		}));

	return {
		source,
		budget_quote: budget,
		quote_symbol: 'SOL',
		risk_profile: profile,
		allocations: enriched,
		excluded,
		rebalance_rule: plan.rebalance_rule || 'Rebalance weekly, dropping any leader whose drawdown breaches the basket cap.',
		caution: plan.caution || 'Copy-trading memecoins is high-variance. Size only what you can afford to lose.',
		leaders_considered: universe.length,
		diversification: countGroups(enriched),
	};
}

function countGroups(allocations) {
	const groups = {};
	for (const a of allocations) groups[a.correlation_group] = (groups[a.correlation_group] || 0) + 1;
	return groups;
}
