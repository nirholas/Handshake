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
import { cacheGet, cacheSet } from '../_lib/cache.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { getSolBalance } from '../_lib/avatar-wallet.js';
import { classifyAutonomy, describeTier } from '../_lib/sniper-autonomy.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const WINDOWS = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', all: null };
const BALANCE_CACHE_TTL_S = 20; // shorter than the page's 30s poll so a refresh sees fresh funding

function solscanAddress(address, network) {
	if (!address) return null;
	return network === 'devnet' ? `https://solscan.io/account/${address}?cluster=devnet` : `https://solscan.io/account/${address}`;
}

// Live SOL balance per wallet, cached briefly so a public, polled endpoint
// doesn't turn into an RPC-balance hammer. A read failure degrades to null
// (never breaks the scoreboard) rather than throwing.
async function walletBalances(addresses, network) {
	const out = new Map();
	const misses = [];
	for (const addr of addresses) {
		const cached = await cacheGet(`sniper:wallet-sol:${network}:${addr}`).catch(() => null);
		if (cached != null) out.set(addr, Number(cached));
		else misses.push(addr);
	}
	if (misses.length) {
		const conn = solanaConnection({ network });
		await Promise.all(misses.map(async (addr) => {
			try {
				const { sol } = await getSolBalance(conn, addr);
				out.set(addr, sol);
				await cacheSet(`sniper:wallet-sol:${network}:${addr}`, sol, BALANCE_CACHE_TTL_S).catch(() => {});
			} catch {
				out.set(addr, null);
			}
		}));
	}
	return out;
}

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
			s.initials_out_multiple, s.moonbag_min_pct, s.max_creator_launches, s.auto_optimize,
			a.id as agent_id, a.name as agent_name, a.meta->>'solana_address' as wallet_address,
			count(p.id) filter (where p.status = 'closed' and p.buy_sig <> 'SIMULATED')                                 as closed,
			count(p.id) filter (where p.status = 'closed' and p.buy_sig <> 'SIMULATED' and p.realized_pnl_lamports > 0) as wins,
			count(p.id) filter (where p.status = 'open' and p.buy_sig <> 'SIMULATED')                                   as open,
			coalesce(sum(p.realized_pnl_lamports) filter (where p.status = 'closed' and p.buy_sig <> 'SIMULATED'), 0)   as realized_pnl_lamports,
			coalesce(sum(p.entry_quote_lamports) filter (where p.status = 'closed' and p.buy_sig <> 'SIMULATED'), 0)    as deployed_lamports,
			avg(p.realized_pnl_pct) filter (where p.status = 'closed' and p.buy_sig <> 'SIMULATED')                     as avg_pnl_pct,
			max(p.realized_pnl_pct) filter (where p.status = 'closed' and p.buy_sig <> 'SIMULATED')                     as best_pnl_pct,
			min(p.realized_pnl_pct) filter (where p.status = 'closed' and p.buy_sig <> 'SIMULATED')                     as worst_pnl_pct,
			avg(extract(epoch from (p.closed_at - p.opened_at))) filter (where p.status = 'closed' and p.buy_sig <> 'SIMULATED') as avg_hold_s,
			max(p.closed_at) filter (where p.buy_sig <> 'SIMULATED')                                                    as last_closed_at,
			count(p.id) filter (where p.status = 'closed' and p.buy_sig = 'SIMULATED')                                  as paper_closed,
			count(p.id) filter (where p.status = 'closed' and p.buy_sig = 'SIMULATED' and p.realized_pnl_lamports > 0)  as paper_wins,
			count(p.id) filter (where p.status = 'open' and p.buy_sig = 'SIMULATED')                                    as paper_open,
			coalesce(sum(p.realized_pnl_lamports) filter (where p.status = 'closed' and p.buy_sig = 'SIMULATED'), 0)    as paper_pnl_lamports
		from agent_sniper_strategies s
		join agent_identities a on a.id = s.agent_id and a.deleted_at is null
		left join agent_sniper_positions p
			on p.strategy_id = s.id
			and p.network = s.network
			and p.buy_sig is not null
			and (${interval}::text is null or p.opened_at > now() - (${interval}::text)::interval)
		where s.network = ${network}
		  and (s.enabled = true or s.label is not null)
		group by s.id, a.id, a.name, a.meta
		order by realized_pnl_lamports desc, closed desc
	`;

	const experiments = rows.map((r) => {
		const closed = Number(r.closed) || 0;
		const wins = Number(r.wins) || 0;
		// Earned autonomy over the same window this board reports. The optimizer
		// recomputes this independently on its own schedule; showing it here is what
		// makes "why did that arm get a wider band" answerable without a DB query.
		const autonomy = classifyAutonomy({
			closed,
			wins,
			netPnlLamports: Number(r.realized_pnl_lamports) || 0,
			avgPnlPct: r.avg_pnl_pct != null ? Number(r.avg_pnl_pct) : 0,
		});
		return {
			strategy_id: r.strategy_id,
			label: r.label || `${(r.decision_mode || 'rules') === 'llm' ? 'llm' : 'rules'}:${String(r.strategy_id).slice(0, 8)}`,
			experiment_group: r.experiment_group || null,
			agent_id: r.agent_id,
			agent_name: r.agent_name,
			wallet_address: r.wallet_address || null,
			wallet_explorer_url: solscanAddress(r.wallet_address, network),
			ledger_url: `/reasoning-ledger?agent=${encodeURIComponent(r.agent_id)}&kind=snipe`,
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
			// Laddered exit: null multiple = classic single-shot full exit.
			initials_out_multiple: r.initials_out_multiple != null ? Number(r.initials_out_multiple) : null,
			moonbag_min_pct: r.moonbag_min_pct != null ? Number(r.moonbag_min_pct) : null,
			max_creator_launches: r.max_creator_launches != null ? Number(r.max_creator_launches) : null,
			// Earned autonomy: what this arm's own record has bought it.
			autonomy_tier: autonomy.tier,
			autonomy_reason: autonomy.reason,
			autonomy_grants: describeTier(autonomy.tier),
			auto_optimize: r.auto_optimize === true,
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
			// Simulate-mode (paper) record, kept strictly separate from the real one:
			// the worker's SNIPER_MODE=simulate books quotes without broadcasting, so
			// these rows prove behavior but never claim on-chain results.
			paper_closed: Number(r.paper_closed) || 0,
			paper_wins: Number(r.paper_wins) || 0,
			paper_open: Number(r.paper_open) || 0,
			paper_pnl_sol: lamportsToSol(r.paper_pnl_lamports),
		};
	});

	// Live wallet transparency: every arm's actual SOL balance, right now, next to
	// its Solscan link — so "is this arm funded" never requires a DB query the
	// public can't run themselves. Best-effort: an RPC hiccup leaves balance_sol
	// null on the affected rows rather than failing the whole scoreboard.
	const wallets = [...new Set(experiments.map((x) => x.wallet_address).filter(Boolean))];
	if (wallets.length) {
		const balances = await walletBalances(wallets, network).catch(() => new Map());
		for (const x of experiments) {
			x.balance_sol = x.wallet_address ? (balances.get(x.wallet_address) ?? null) : null;
		}
	} else {
		for (const x of experiments) x.balance_sol = null;
	}

	// Judgment ledger: every LLM verdict (buys AND skips) scored against what the
	// coin actually did. This measures a model's CALLS, independent of trade size
	// or simulate mode; `scored` counts verdicts whose coin has an outcome label
	// (pump_coin_outcomes lags launches by an hour by design). A "hit" for a buy
	// call, and a "missed winner" for a skip, is a coin that pumped 3x or
	// graduated after the verdict.
	const judgment = await sql`
		select
			v.model,
			count(*)                                                                        as verdicts,
			count(*) filter (where v.buy)                                                   as buy_calls,
			avg(v.confidence)                                                               as avg_confidence,
			avg(v.latency_ms)                                                               as avg_latency_ms,
			count(o.mint)                                                                   as scored,
			count(*) filter (where v.buy and o.mint is not null)                            as buys_scored,
			count(*) filter (where v.buy and o.outcome in ('pumped','graduated'))           as buy_hits,
			count(*) filter (where not v.buy and o.mint is not null)                        as skips_scored,
			count(*) filter (where not v.buy and o.outcome in ('pumped','graduated'))       as missed_winners,
			max(v.created_at)                                                               as last_verdict_at
		from sniper_llm_verdicts v
		left join pump_coin_outcomes o on o.mint = v.mint
		where v.network = ${network}
		  and (${interval}::text is null or v.created_at > now() - (${interval}::text)::interval)
		group by v.model
		order by verdicts desc
	`.catch(() => []);

	const judgmentOut = judgment.map((j) => {
		const buysScored = Number(j.buys_scored) || 0;
		const skipsScored = Number(j.skips_scored) || 0;
		return {
			model: j.model,
			verdicts: Number(j.verdicts) || 0,
			buy_calls: Number(j.buy_calls) || 0,
			avg_confidence: j.avg_confidence != null ? Number(Number(j.avg_confidence).toFixed(3)) : null,
			avg_latency_ms: j.avg_latency_ms != null ? Math.round(Number(j.avg_latency_ms)) : null,
			scored: Number(j.scored) || 0,
			buys_scored: buysScored,
			buy_hits: Number(j.buy_hits) || 0,
			buy_precision_pct: buysScored > 0 ? Math.round((Number(j.buy_hits) / buysScored) * 100) : null,
			skips_scored: skipsScored,
			missed_winners: Number(j.missed_winners) || 0,
			missed_winner_pct: skipsScored > 0 ? Math.round((Number(j.missed_winners) / skipsScored) * 100) : null,
			last_verdict_at: j.last_verdict_at || null,
		};
	});

	// The funding source: one master wallet auto-tops-up every dry arm above.
	// Publishing its address + live balance is the other half of "track the
	// wallets" — you can watch funding flow into the fleet, not just the fleet
	// itself. Reads a PUBLIC-ADDRESS-ONLY env var (SNIPER_MASTER_WALLET_ADDRESS),
	// never a secret key: this route runs on three-ws-api, a different Cloud Run
	// service from agent-sniper, and the two do NOT share which physical wallet
	// LAUNCHER_MASTER_SECRET_KEY_B64 resolves to (three-ws-api's copy funds the
	// autonomous coin launcher; agent-sniper's is the sniper-only wallet below) —
	// deriving a pubkey from either service's secret here would silently show the
	// wrong wallet. Best-effort: unconfigured or unreadable never breaks the board.
	let masterWallet = null;
	try {
		const address = (process.env.SNIPER_MASTER_WALLET_ADDRESS || '').trim();
		if (address) {
			const balance = await walletBalances([address], network);
			masterWallet = {
				address,
				balance_sol: balance.get(address) ?? null,
				explorer_url: solscanAddress(address, network),
			};
		}
	} catch {
		masterWallet = null;
	}

	return json(res, 200, {
		network,
		window,
		experiments,
		judgment: judgmentOut,
		master_wallet: masterWallet,
		t: Date.now(),
	}, { 'cache-control': 'public, max-age=15, s-maxage=30' });
});
