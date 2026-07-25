// GET/POST /api/cron/sniper-optimize: the autonomous learning loop for the
// sniper fleet. Reads each arm's REAL trading record over a trailing window,
// asks the pure optimizer (api/_lib/sniper-optimizer.js) for bounded, explained
// adjustments to that arm's own knobs, and:
//
//   mode=shadow (default): persists the proposals and mutates NOTHING. This is
//        how you watch the loop make tuning calls before it touches a live arm.
//   mode=apply: additionally enacts the proposals, but ONLY for arms that opted
//        in (auto_optimize = true). Each applied change is bounded to a small
//        per-run step, recorded in agent_sniper_optimizer_runs, and written to
//        the agent's tamper-evident Reasoning Ledger (agent_decisions) so the
//        tuning itself is auditable next to the trades it learned from.
//
// The deterministic safety rails (trade firewall, Mayhem exclusion, budgets,
// concurrency) are never touched here. The optimizer only moves policy knobs a
// human owner already tunes, each clamped to a hard range.
//
// How wide that range is depends on the arm. Each run classifies every arm with
// the earned-autonomy engine (api/_lib/sniper-autonomy.js) from its own realized
// record: a profitable arm gets wider bounds, bigger steps, and unlocks fields a
// losing arm cannot touch (its entry universe, its LLM confidence bar, the
// take-initials ladder); a bleeding arm gets narrowed bounds and half steps. The
// tier is recomputed from scratch every pass, so freedom is continuously earned
// rather than granted once, and it is recorded on the run row and in the ledger.
//
// Controls:
//   SNIPER_OPTIMIZER_MODE   = shadow | apply     (default shadow)
//   SNIPER_OPTIMIZER_WINDOW = 24h | 7d | 30d     (default 7d)
//   SNIPER_OPTIMIZER_MAX_APPLIES = integer        (default 5 arms mutated/run)

import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { sql } from '../_lib/db.js';
import { recordDecision } from '../_lib/reasoning-ledger.js';
import { proposeAdjustments } from '../_lib/sniper-optimizer.js';
import { classifyAutonomy, describeTier } from '../_lib/sniper-autonomy.js';

const WINDOWS = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

// Enact one tuning on a strategy row. Explicit per-column statements on purpose:
// the neon http driver rejects a dynamic column identifier in SET position
// (`set ${sql(field)} = $1` throws "syntax error at or near $1"), which silently
// turned every apply-mode run into a no-op. The field is already whitelisted by
// the optimizer's BOUNDS; anything unknown is refused loudly.
async function applyProposal(strategyId, field, value) {
	switch (field) {
		case 'take_profit_pct':
			return sql`update agent_sniper_strategies set take_profit_pct = ${value}, updated_at = now() where id = ${strategyId}`;
		case 'trailing_stop_pct':
			return sql`update agent_sniper_strategies set trailing_stop_pct = ${value}, updated_at = now() where id = ${strategyId}`;
		case 'stop_loss_pct':
			return sql`update agent_sniper_strategies set stop_loss_pct = ${value}, updated_at = now() where id = ${strategyId}`;
		case 'max_hold_seconds':
			return sql`update agent_sniper_strategies set max_hold_seconds = ${value}, updated_at = now() where id = ${strategyId}`;
		case 'min_quality_score':
			return sql`update agent_sniper_strategies set min_quality_score = ${value}, updated_at = now() where id = ${strategyId}`;
		case 'min_oracle_score':
			return sql`update agent_sniper_strategies set min_oracle_score = ${value}, updated_at = now() where id = ${strategyId}`;
		case 'per_trade_lamports':
			return sql`update agent_sniper_strategies set per_trade_lamports = ${value}, updated_at = now() where id = ${strategyId}`;
		// Tier-unlocked fields. The optimizer only ever emits these for an arm the
		// autonomy engine placed at trusted or above; the switch is the second gate.
		case 'llm_min_confidence':
			return sql`update agent_sniper_strategies set llm_min_confidence = ${value}, updated_at = now() where id = ${strategyId}`;
		case 'min_market_cap_usd':
			return sql`update agent_sniper_strategies set min_market_cap_usd = ${value}, updated_at = now() where id = ${strategyId}`;
		case 'max_market_cap_usd':
			return sql`update agent_sniper_strategies set max_market_cap_usd = ${value}, updated_at = now() where id = ${strategyId}`;
		case 'initials_out_multiple':
			return sql`update agent_sniper_strategies set initials_out_multiple = ${value}, updated_at = now() where id = ${strategyId}`;
		case 'moonbag_min_pct':
			return sql`update agent_sniper_strategies set moonbag_min_pct = ${value}, updated_at = now() where id = ${strategyId}`;
		case 'max_creator_launches':
			return sql`update agent_sniper_strategies set max_creator_launches = ${value}, updated_at = now() where id = ${strategyId}`;
		default:
			throw new Error(`optimizer refused to write unknown field '${field}'`);
	}
}

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) { error(res, 503, 'not_configured', 'CRON_SECRET unset'); return false; }
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) { error(res, 401, 'unauthorized', 'invalid cron secret'); return false; }
	return true;
}

// Per-arm real trading record over the window, including the exit-reason
// distribution the optimizer's rules key on. Real fills only (the 'SIMULATED'
// sentinel is excluded) so a shadow-mode fleet still produces proposals from its
// paper record is NOT what we want; we learn from real money. Paper arms simply
// have too few real closes and no-op under MIN_SAMPLE, which is correct.
async function armStats(network, interval) {
	return sql`
		select
			s.id as strategy_id, s.agent_id, s.decision_mode, s.auto_optimize, s.label,
			s.per_trade_lamports, s.daily_budget_lamports, s.max_concurrent_positions,
			s.take_profit_pct, s.trailing_stop_pct, s.stop_loss_pct, s.max_hold_seconds,
			s.min_quality_score, s.min_oracle_score,
			s.llm_min_confidence, s.min_market_cap_usd, s.max_market_cap_usd,
			s.initials_out_multiple, s.moonbag_min_pct, s.max_creator_launches,
			count(p.id) filter (where p.status='closed' and p.buy_sig<>'SIMULATED')                              as closed,
			count(p.id) filter (where p.status='closed' and p.buy_sig<>'SIMULATED' and p.realized_pnl_lamports>0) as wins,
			coalesce(sum(p.realized_pnl_lamports) filter (where p.status='closed' and p.buy_sig<>'SIMULATED'),0)  as net_pnl_lamports,
			avg(p.realized_pnl_pct) filter (where p.status='closed' and p.buy_sig<>'SIMULATED')                   as avg_pnl_pct,
			max(p.realized_pnl_pct) filter (where p.status='closed' and p.buy_sig<>'SIMULATED')                   as best_pnl_pct,
			min(p.realized_pnl_pct) filter (where p.status='closed' and p.buy_sig<>'SIMULATED')                   as worst_pnl_pct,
			avg(extract(epoch from (p.closed_at - p.opened_at))) filter (where p.status='closed' and p.buy_sig<>'SIMULATED') as avg_hold_s,
			jsonb_object_agg(coalesce(p.exit_reason,'unknown'), rc)
				filter (where p.status='closed' and p.buy_sig<>'SIMULATED')                                       as exit_reasons
		from agent_sniper_strategies s
		join agent_identities a on a.id = s.agent_id and a.deleted_at is null
		left join lateral (
			select p.*, count(*) over (partition by p.exit_reason) as rc
			from agent_sniper_positions p
			where p.strategy_id = s.id and p.network = s.network and p.buy_sig is not null
			  and p.opened_at > now() - (${interval}::text)::interval
		) p on true
		where s.network = ${network} and (s.enabled = true or s.label is not null)
		group by s.id, a.id
	`;
}

// Per-arm realized win rate bucketed by the Oracle conviction each coin had at
// entry (Bridge 2). Feeds the optimizer's Rule O so it tunes min_oracle_score to
// the conviction band where the arm actually wins, instead of ignoring Oracle.
// Uses the coin's current conviction (oracle_conviction keeps one row per mint);
// coins the Oracle never scored simply don't contribute.
async function armOracleBuckets(network, interval) {
	return sql`
		select p.strategy_id,
			case when oc.score >= 85 then 85 when oc.score >= 70 then 70
			     when oc.score >= 50 then 50 when oc.score >= 30 then 30 else 0 end as lo,
			count(*) as closed,
			count(*) filter (where p.realized_pnl_lamports > 0) as wins
		from agent_sniper_positions p
		join oracle_conviction oc on oc.mint = p.mint and oc.network = p.network
		where p.network = ${network} and p.status = 'closed' and p.buy_sig <> 'SIMULATED'
		  and p.opened_at > now() - (${interval}::text)::interval
		group by p.strategy_id, lo
	`;
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const mode = (process.env.SNIPER_OPTIMIZER_MODE || 'shadow').trim() === 'apply' ? 'apply' : 'shadow';
	const windowLabel = WINDOWS[process.env.SNIPER_OPTIMIZER_WINDOW] ? process.env.SNIPER_OPTIMIZER_WINDOW : '7d';
	const interval = WINDOWS[windowLabel];
	const maxApplies = Math.max(0, Number(process.env.SNIPER_OPTIMIZER_MAX_APPLIES ?? 5) || 5);
	const network = 'mainnet';

	const report = { mode, window: windowLabel, arms: 0, with_proposals: 0, applied: 0, skipped_optin: 0, errors: 0, tiers: {}, runs: [] };
	let rows = [];
	let oracleByArm = new Map();
	try {
		rows = await armStats(network, interval);
		const oracleRows = await armOracleBuckets(network, interval).catch(() => []);
		for (const o of oracleRows) {
			const list = oracleByArm.get(o.strategy_id) || [];
			list.push({ lo: Number(o.lo), closed: Number(o.closed), wins: Number(o.wins) });
			oracleByArm.set(o.strategy_id, list);
		}
	} catch (err) {
		return json(res, 200, { ok: false, error: err.message, report });
	}
	report.arms = rows.length;

	for (const r of rows) {
		try {
			const closed = Number(r.closed) || 0;
			const wins = Number(r.wins) || 0;
			const stats = {
				closed, wins,
				winRate: closed > 0 ? Math.round((wins / closed) * 100) : 0,
				avgPnlPct: r.avg_pnl_pct != null ? Number(r.avg_pnl_pct) : 0,
				bestPnlPct: r.best_pnl_pct != null ? Number(r.best_pnl_pct) : 0,
				worstPnlPct: r.worst_pnl_pct != null ? Number(r.worst_pnl_pct) : 0,
				avgHoldSeconds: r.avg_hold_s != null ? Math.round(Number(r.avg_hold_s)) : null,
				netPnlLamports: Number(r.net_pnl_lamports) || 0,
				exitReasons: r.exit_reasons || {},
				oracleBuckets: oracleByArm.get(r.strategy_id) || [],
			};
			// Earned autonomy: the arm's own realized record decides how much rope it
			// gets this run. Recomputed every pass, so a profitable arm widens as it
			// keeps earning and a fading one narrows again without anyone stepping in.
			const autonomy = classifyAutonomy(stats);
			report.tiers[autonomy.tier] = (report.tiers[autonomy.tier] || 0) + 1;

			const { proposals, sample, acted, notes } = proposeAdjustments(stats, r, { tier: autonomy.tier });
			if (!acted) continue;
			report.with_proposals++;

			const optedIn = r.auto_optimize === true;
			const willApply = mode === 'apply' && optedIn && report.applied < maxApplies;
			if (mode === 'apply' && !optedIn) report.skipped_optin++;

			let ledgerSeq = null;
			if (willApply) {
				// Enact each proposal on the strategy row (bounded values only).
				for (const p of proposals) {
						await applyProposal(r.strategy_id, p.field, p.to);
					}
				// Log the tuning to the agent's tamper-evident ledger so the loop's
				// own decisions are auditable next to the trades that drove them.
				const dec = await recordDecision({
					agentId: r.agent_id,
					kind: 'optimize',
					subjectRef: r.strategy_id,
					actionRef: `optimize:${r.strategy_id}:${Date.now()}`,
					inputs: { window: windowLabel, sample, stats, proposals, autonomy },
					rationale: `Auto-tuned ${proposals.length} field(s) for arm "${r.label || r.strategy_id}" from ${sample} real trades over ${windowLabel} at autonomy tier "${autonomy.tier}" (${autonomy.reason}): ${proposals.map((p) => `${p.field} ${p.from ?? '(unset)'}→${p.to}`).join(', ')}.`,
					prediction: { basis: 'bounded self-tuning from realized outcomes', metric: 'realized_pnl', direction: 'up' },
					confidence: 0.5,
					network,
				}).catch(() => null);
				ledgerSeq = dec?.seq ?? null;
				report.applied++;
			}

			await sql`
				insert into agent_sniper_optimizer_runs
					(strategy_id, agent_id, network, mode, window_label, sample_size, evidence, proposals, applied, ledger_seq,
					 autonomy_tier, autonomy_reason)
				values
					(${r.strategy_id}, ${r.agent_id}, ${network}, ${mode}, ${windowLabel}, ${sample},
					 ${JSON.stringify({ ...stats, autonomy })}::jsonb, ${JSON.stringify(proposals)}::jsonb, ${willApply}, ${ledgerSeq},
					 ${autonomy.tier}, ${autonomy.reason})
			`;

			report.runs.push({
				strategy_id: r.strategy_id, label: r.label || null, sample,
				applied: willApply, opted_in: optedIn,
				tier: autonomy.tier, tier_reason: autonomy.reason, tier_grants: describeTier(autonomy.tier),
				proposals: proposals.map((p) => ({ field: p.field, from: p.from, to: p.to })),
				notes,
			});
		} catch (err) {
			report.errors++;
			report.runs.push({ strategy_id: r.strategy_id, error: err.message });
		}
	}

	return json(res, 200, { ok: true, ...report });
});
