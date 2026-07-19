/**
 * Agent Sniper, strategy experiment comparison.
 *
 *   GET /api/sniper/experiments?network=mainnet&window=7d
 *
 * The sniper fleet runs deliberately different rule sets side by side, rule
 * shields with different thresholds, and LLM-judged arms with no shields at
 * all, to learn which entry conditions actually make money. This endpoint is
 * the scoreboard: one row per armed strategy, its human-readable label and
 * config fingerprint, and its REAL trading record (on-chain fills only, the
 * 'SIMULATED' sentinel excluded) over the window.
 *
 * Public + IP rate-limited, same trust model as /api/sniper/leaderboard: the
 * tx signatures are the proof.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const WINDOWS = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', all: null };

function lamportsToSol(v) {
	return v == null ? null : Number((Number(BigInt(v)) / 1e9).toFixed(6));
}

// One-line human fingerprint of a strategy's entry conditions, so the
// scoreboard reads as "what rules produced this record" without a schema tour.
function conditionSummary(s) {
	if ((s.decision_mode || 'rules') === 'llm') {
		const conf = s.llm_min_confidence != null ? ` ≥${Math.round(Number(s.llm_min_confidence) * 100)}%` : '';
		return `LLM judge (${s.llm_model || 'openrouter/auto'}${conf}), no rule shields`;
	}
	const parts = [`trigger ${s.trigger || 'new_mint'}`];
	if (s.min_market_cap_usd != null || s.max_market_cap_usd != null) {
		parts.push(`mcap $${Number(s.min_market_cap_usd || 0) / 1000}k-$${s.max_market_cap_usd != null ? Number(s.max_market_cap_usd) / 1000 + 'k' : '∞'}`);
	}
	if (s.require_socials) parts.push('socials required');
	if (s.min_oracle_score != null) parts.push(`oracle ≥${s.min_oracle_score}`);
	if (s.min_quality_score != null) parts.push(`quality ≥${s.min_quality_score}`);
	if (s.max_bundle_score != null) parts.push(`bundle ≤${s.max_bundle_score}`);
	if (s.require_smart_money) parts.push('smart money required');
	return parts.join(', ');
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const network = NETWORKS.has(params.get('network')) ? params.get('network') : 'mainnet';
	const window = Object.prototype.hasOwnProperty.call(WINDOWS, params.get('window')) ? params.get('window') : '7d';
	const interval = WINDOWS[window];

	const rows = await sql`
		select
			s.id as strategy_id,
			s.label, s.experiment_group, s.decision_mode, s.llm_model, s.llm_min_confidence,
			s.trigger, s.enabled,
			s.per_trade_lamports, s.daily_budget_lamports, s.max_concurrent_positions,
			s.min_market_cap_usd, s.max_market_cap_usd, s.require_socials,
			s.min_oracle_score, s.min_quality_score, s.max_bundle_score, s.require_smart_money,
			s.stop_loss_pct, s.trailing_stop_pct, s.take_profit_pct, s.max_hold_seconds,
			a.id as agent_id, a.name as agent_name,
			count(p.id) filter (where p.status = 'closed')                                   as closed,
			count(p.id) filter (where p.status = 'closed' and p.realized_pnl_lamports > 0)   as wins,
			count(p.id) filter (where p.status = 'open')                                     as open,
			coalesce(sum(p.realized_pnl_lamports) filter (where p.status = 'closed'), 0)     as realized_pnl_lamports,
			coalesce(sum(p.entry_quote_lamports) filter (where p.status = 'closed'), 0)      as deployed_lamports,
			avg(p.realized_pnl_pct) filter (where p.status = 'closed')                       as avg_pnl_pct,
			max(p.realized_pnl_pct) filter (where p.status = 'closed')                       as best_pnl_pct,
			min(p.realized_pnl_pct) filter (where p.status = 'closed')                       as worst_pnl_pct,
			avg(extract(epoch from (p.closed_at - p.opened_at))) filter (where p.status = 'closed') as avg_hold_s,
			max(p.closed_at)                                                                 as last_closed_at
		from agent_sniper_strategies s
		join agent_identities a on a.id = s.agent_id and a.deleted_at is null
		left join agent_sniper_positions p
			on p.strategy_id = s.id
			and p.network = s.network
			and p.buy_sig is not null and p.buy_sig <> 'SIMULATED'
			and (${interval}::text is null or p.opened_at > now() - (${interval}::text)::interval)
		where s.network = ${network}
		  and (s.enabled = true or s.label is not null)
		group by s.id, a.id, a.name
		order by realized_pnl_lamports desc, closed desc
	`;

	const experiments = rows.map((r) => {
		const closed = Number(r.closed) || 0;
		const wins = Number(r.wins) || 0;
		return {
			strategy_id: r.strategy_id,
			label: r.label || `${(r.decision_mode || 'rules') === 'llm' ? 'llm' : 'rules'}:${String(r.strategy_id).slice(0, 8)}`,
			experiment_group: r.experiment_group || null,
			agent_id: r.agent_id,
			agent_name: r.agent_name,
			decision_mode: r.decision_mode || 'rules',
			llm_model: r.llm_model || null,
			trigger: r.trigger || 'new_mint',
			enabled: r.enabled === true,
			conditions: conditionSummary(r),
			per_trade_sol: lamportsToSol(r.per_trade_lamports),
			daily_budget_sol: lamportsToSol(r.daily_budget_lamports),
			stop_loss_pct: r.stop_loss_pct != null ? Number(r.stop_loss_pct) : null,
			trailing_stop_pct: r.trailing_stop_pct != null ? Number(r.trailing_stop_pct) : null,
			take_profit_pct: r.take_profit_pct != null ? Number(r.take_profit_pct) : null,
			max_hold_seconds: r.max_hold_seconds != null ? Number(r.max_hold_seconds) : null,
			closed,
			wins,
			losses: Math.max(0, closed - wins),
			open: Number(r.open) || 0,
			win_rate: closed > 0 ? Math.round((wins / closed) * 100) : null,
			realized_pnl_sol: lamportsToSol(r.realized_pnl_lamports),
			deployed_sol: lamportsToSol(r.deployed_lamports),
			roi_pct: Number(r.deployed_lamports) > 0
				? Number(((Number(r.realized_pnl_lamports) / Number(r.deployed_lamports)) * 100).toFixed(2))
				: null,
			avg_pnl_pct: r.avg_pnl_pct != null ? Number(Number(r.avg_pnl_pct).toFixed(2)) : null,
			best_pnl_pct: r.best_pnl_pct != null ? Number(Number(r.best_pnl_pct).toFixed(2)) : null,
			worst_pnl_pct: r.worst_pnl_pct != null ? Number(Number(r.worst_pnl_pct).toFixed(2)) : null,
			avg_hold_seconds: r.avg_hold_s != null ? Math.round(Number(r.avg_hold_s)) : null,
			last_closed_at: r.last_closed_at || null,
		};
	});

	return json(res, 200, {
		network,
		window,
		experiments,
		t: Date.now(),
	}, { 'cache-control': 'public, max-age=15, s-maxage=30' });
});
