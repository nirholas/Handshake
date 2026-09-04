/**
 * Agent Sniper — strategy (arm/config) API.
 *
 *   GET  /api/sniper/strategy            → the caller's sniper strategies + each
 *                                          agent's live position summary.
 *   POST /api/sniper/strategy            → upsert/arm the strategy for one owned agent.
 *
 * Strategy rows (agent_sniper_strategies) are read by the agent-sniper worker
 * (workers/agent-sniper). Arming is an explicit, owner-only opt-in: the agent
 * trades from its OWN wallet with real funds, so a strategy is disabled until
 * the owner sets a budget, a per-trade size, and confirms the risk.
 *
 * Auth: session cookie OR bearer token. Every read/write is scoped to agents
 * the caller owns (agent_identities.user_id).
 */

import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { env } from '../_lib/env.js';
import { z } from 'zod';

// Best-effort SOL balance for an agent's Solana wallet. Returns null on any error.
async function getSolBalance(address) {
	if (!address || !env.HELIUS_API_KEY) return null;
	try {
		const conn = solanaConnection();
		const { PublicKey } = await import('@solana/web3.js');
		const lamports = await conn.getBalance(new PublicKey(address));
		return lamports / 1e9;
	} catch {
		return null;
	}
}

async function resolveUserId(req) {
	const session = await getSessionUser(req);
	if (session) return session.id;
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return bearer.userId;
	return null;
}

const lamports = z.union([z.string(), z.number()]);
const optPct = z.union([z.string(), z.number()]).nullable().optional();
const optInt = z.union([z.string(), z.number()]).nullable().optional();

const optLamports = z.union([z.string(), z.number()]).nullable().optional();

// Exported so tests can pin the accepted field set: zod strips unknown keys, so
// a knob missing from this schema is silently dropped from every write while the
// caller still gets a 200. That is exactly how the laddered-exit fields below
// spent weeks unsettable through the only API that is supposed to set them.
export const STRATEGY_SCHEMA = z.object({
	agent_id: z.string().uuid(),
	network: z.enum(['mainnet', 'devnet']).default('mainnet'),
	enabled: z.boolean().optional(),
	kill_switch: z.boolean().optional(),
	// trigger: what arms this strategy.
	//   new_mint        — snipe new pump.fun launches off the PumpPortal feed (default).
	//   first_claim     — snipe a creator's coin the first time they EVER claim rewards.
	//   graduation_ride — buy the AMM pool at migration and sell into pump.fun's
	//                     5-minute BOOST buyback window (workers/agent-sniper/graduation-ride.js).
	trigger: z.enum(['new_mint', 'first_claim', 'intel_confirmed', 'prelaunch_radar', 'alpha_hunt', 'graduation_ride']).optional(),
	buy_delay_ms: z.union([z.string(), z.number()]).optional(),
	// prelaunch_radar gates (null clears)
	min_creator_graduated_radar: optInt,
	require_smart_money_funder: z.boolean().optional(),
	radar_max_age_ms: optInt,
	// first_claim entry filters (null clears)
	min_claim_lamports: optLamports,
	max_claim_lamports: optLamports,
	first_claim_max_age_seconds: optInt,
	// sizing
	daily_budget_lamports: lamports.optional(),
	per_trade_lamports: lamports.optional(),
	max_concurrent_positions: z.union([z.string(), z.number()]).optional(),
	slippage_bps: z.union([z.string(), z.number()]).optional(),
	max_price_impact_pct: z.union([z.string(), z.number()]).optional(),
	// MEV-aware execution: per-strategy Jito tip policy + rug/honeypot firewall mode.
	mev_tip_mode: z.enum(['off', 'economy', 'turbo']).optional(),
	firewall_level: z.enum(['block', 'warn', 'off']).optional(),
	// Adversarial pre-trade Risk Officer. 'shadow' (default) reviews and records
	// without changing the trade; 'enforce' lets a veto abort the buy and a smaller
	// suggested size shrink it; 'off' skips the review entirely.
	risk_officer_level: z.enum(['off', 'shadow', 'enforce']).optional(),
	risk_officer_model: z.string().max(120).nullable().optional(),
	// entry filters (null clears)
	min_market_cap_usd: optPct,
	max_market_cap_usd: optPct,
	min_creator_graduated: optInt,
	max_creator_launches: optInt,
	require_socials: z.boolean().optional(),
	require_sol_quote: z.boolean().optional(),
	// exits
	take_profit_pct: optPct,
	stop_loss_pct: z.union([z.string(), z.number()]).optional(),
	trailing_stop_pct: optPct,
	max_hold_seconds: z.union([z.string(), z.number()]).optional(),
	// Oracle conviction gate (0–100, null = skip check)
	min_oracle_score: z.union([z.string(), z.number()]).nullable().optional(),
	// Intel-confirmed specific filters (null = ignore)
	min_quality_score: z.union([z.string(), z.number()]).nullable().optional(),
	max_bundle_score: z.union([z.string(), z.number()]).nullable().optional(),
	max_concentration_top1: z.union([z.string(), z.number()]).nullable().optional(),
	avoid_dev_dump: z.boolean().optional(),
	allowed_categories: z.array(z.string()).nullable().optional(),
	// alpha_hunt specific filters (null clears)
	alpha_min_smart_money: z.number().int().min(0).max(20).optional(),
	alpha_min_organic_score: z.number().min(0).max(100).optional(),
	alpha_max_mcap_usd: z.number().min(0).optional(),
	alpha_narrative_keywords: z.array(z.string()).max(10).optional(),
	alpha_min_quality_score: z.number().int().min(0).max(100).optional(),
	// Notifications: personal Telegram chat ID for this strategy's buy/sell alerts.
	// Must be a numeric chat ID (positive = user/group, negative = supergroup/channel).
	telegram_chat_id: z.string().regex(/^-?[0-9]+$/).nullable().optional(),
	// Experiment identity + decision mode. 'llm' replaces the rule shields with a
	// model verdict per launch (safety rails still enforced at executeBuy).
	decision_mode: z.enum(['rules', 'llm']).optional(),
	llm_model: z.string().max(120).nullable().optional(),
	llm_min_confidence: z.union([z.string(), z.number()]).nullable().optional(),
	llm_max_confidence: z.union([z.string(), z.number()]).nullable().optional(),
	llm_strict_model: z.boolean().optional(),
	moonbag_always: z.boolean().optional(),
	// Laddered take-initials exit. An explicit null on initials_out_multiple opts
	// back into the classic single-shot exit; moonbag_min_pct is NOT NULL in the
	// schema, so it clamps rather than clears.
	initials_out_multiple: z.union([z.string(), z.number()]).nullable().optional(),
	moonbag_min_pct: z.union([z.string(), z.number()]).optional(),
	label: z.string().max(80).nullable().optional(),
	experiment_group: z.string().max(80).nullable().optional(),
});

const atomicStr = (v, fallback = '0') => {
	if (v == null) return fallback;
	let s = String(v).trim();
	if (!/^\d+$/.test(s)) {
		const n = Number(s);
		if (!Number.isFinite(n) || n < 0) return fallback;
		s = String(Math.floor(n));
	}
	return s;
};
const intOrNull = (v) => {
	if (v == null || v === '') return null;
	const n = Math.floor(Number(v));
	return Number.isFinite(n) ? n : null;
};
const atomicOrNull = (v) => {
	if (v == null || v === '') return null;
	let s = String(v).trim();
	if (!/^\d+$/.test(s)) {
		const n = Number(s);
		if (!Number.isFinite(n) || n < 0) return null;
		s = String(Math.floor(n));
	}
	return s;
};
const numOrNull = (v) => {
	if (v == null || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};
const clampInt = (v, min, max, def) => {
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n)) return def;
	return Math.min(max, Math.max(min, n));
};
// Fractional sibling of clampInt, for the knobs that are multiples or percentages
// rather than counts. Both fall back rather than pass NaN into a numeric column.
const clampNum = (v, min, max, def) => {
	const n = Number(v);
	if (!Number.isFinite(n)) return def;
	return Math.min(max, Math.max(min, n));
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const userId = await resolveUserId(req);
	if (!userId) return error(res, 401, 'unauthorized', 'sign in to manage the sniper');

	// GET is a session-scoped READ that fires on every dashboard page load and
	// again on each poll tick, so it belongs in the generous read bucket. Sharing
	// the strict credential bucket (50/10m, also gating login and register) is
	// what let a single Capabilities page load 429 itself and lock the user out
	// of signing in; see the authedReadIp note in api/_lib/rate-limit.js. Writes
	// stay on the credential bucket, which is what it exists to protect.
	const rl = req.method === 'POST'
		? await limits.authIp(clientIp(req))
		: await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (req.method === 'POST') return upsertStrategy(req, res, userId);
	return listStrategies(req, res, userId);
});

// ── GET — strategies + live position summary ─────────────────────────────────

async function listStrategies(req, res, userId) {
	const rows = await sql`
		select s.*, a.name as agent_name,
		       a.avatar_url as agent_avatar, a.profile_image_url as agent_image,
		       a.meta->>'solana_address' as solana_address
		from agent_sniper_strategies s
		join agent_identities a on a.id = s.agent_id
		where s.user_id = ${userId}
		order by s.updated_at desc
		limit 100
	`;

	const summary = rows.length
		? await sql`
			select agent_id,
			       count(*) filter (where status in ('opening','open','closing')) as open_positions,
			       count(*) filter (where status = 'closed')                       as closed_positions,
			       coalesce(sum(realized_pnl_lamports),0)::text                     as realized_pnl_lamports,
			       count(*) filter (where exit_reason = 'take_profit')              as wins
			from agent_sniper_positions
			where user_id = ${userId}
			group by agent_id
		`
		: [];
	const byAgent = new Map(summary.map((s) => [s.agent_id, s]));

	// Fetch wallet balances concurrently — best-effort, never block on failure.
	const balances = await Promise.all(
		rows.map((r) => getSolBalance(r.solana_address).catch(() => null)),
	);
	const balanceMap = new Map(rows.map((r, i) => [r.agent_id, balances[i]]));

	const strategies = rows.map((s) => {
		const sum = byAgent.get(s.agent_id);
		return {
			wallet_sol: balanceMap.get(s.agent_id) ?? null,
			wallet_address: s.solana_address || null,
			agent_id: s.agent_id,
			agent_name: s.agent_name,
			image: s.agent_image || s.agent_avatar || null,
			network: s.network,
			enabled: s.enabled,
			kill_switch: s.kill_switch,
			trigger: s.trigger || 'new_mint',
			buy_delay_ms: s.buy_delay_ms ?? 0,
			min_claim_lamports: s.min_claim_lamports != null ? String(s.min_claim_lamports) : null,
			max_claim_lamports: s.max_claim_lamports != null ? String(s.max_claim_lamports) : null,
			first_claim_max_age_seconds: s.first_claim_max_age_seconds ?? null,
			daily_budget_lamports: String(s.daily_budget_lamports),
			per_trade_lamports: String(s.per_trade_lamports),
			max_concurrent_positions: s.max_concurrent_positions,
			slippage_bps: s.slippage_bps,
			max_price_impact_pct: Number(s.max_price_impact_pct),
			mev_tip_mode: s.mev_tip_mode || 'off',
			firewall_level: s.firewall_level || 'block',
			risk_officer_level: s.risk_officer_level || 'shadow',
			risk_officer_model: s.risk_officer_model || null,
			min_market_cap_usd: s.min_market_cap_usd != null ? Number(s.min_market_cap_usd) : null,
			max_market_cap_usd: s.max_market_cap_usd != null ? Number(s.max_market_cap_usd) : null,
			min_creator_graduated: s.min_creator_graduated,
			max_creator_launches: s.max_creator_launches,
			require_socials: s.require_socials,
			require_sol_quote: s.require_sol_quote,
			take_profit_pct: s.take_profit_pct != null ? Number(s.take_profit_pct) : null,
			stop_loss_pct: Number(s.stop_loss_pct),
			trailing_stop_pct: s.trailing_stop_pct != null ? Number(s.trailing_stop_pct) : null,
			max_hold_seconds: s.max_hold_seconds,
			min_oracle_score: s.min_oracle_score != null ? Number(s.min_oracle_score) : null,
			min_creator_graduated_radar: s.min_creator_graduated_radar ?? null,
			require_smart_money_funder: s.require_smart_money_funder ?? false,
			radar_max_age_ms: s.radar_max_age_ms ?? null,
			min_quality_score: s.min_quality_score != null ? Number(s.min_quality_score) : null,
			max_bundle_score: s.max_bundle_score != null ? Number(s.max_bundle_score) : null,
			max_concentration_top1: s.max_concentration_top1 != null ? Number(s.max_concentration_top1) : null,
			avoid_dev_dump: s.avoid_dev_dump ?? true,
			allowed_categories: s.allowed_categories || null,
			telegram_chat_id: s.telegram_chat_id || null,
			alpha_min_smart_money: s.alpha_min_smart_money != null ? Number(s.alpha_min_smart_money) : null,
			alpha_min_organic_score: s.alpha_min_organic_score != null ? Number(s.alpha_min_organic_score) : null,
			alpha_max_mcap_usd: s.alpha_max_mcap_usd != null ? Number(s.alpha_max_mcap_usd) : null,
			alpha_narrative_keywords: s.alpha_narrative_keywords || null,
			alpha_min_quality_score: s.alpha_min_quality_score != null ? Number(s.alpha_min_quality_score) : null,
			// Read-only here (operator-granted, see upsertStrategy), but the dashboard
			// still has to show whether the treasury is allowed to refill this wallet.
			auto_fund_enabled: s.auto_fund_enabled ?? false,
			initials_out_multiple: s.initials_out_multiple != null ? Number(s.initials_out_multiple) : null,
			moonbag_min_pct: s.moonbag_min_pct != null ? Number(s.moonbag_min_pct) : 15,
			decision_mode: s.decision_mode || 'rules',
			llm_model: s.llm_model || null,
			llm_min_confidence: s.llm_min_confidence != null ? Number(s.llm_min_confidence) : null,
			llm_max_confidence: s.llm_max_confidence != null ? Number(s.llm_max_confidence) : null,
			llm_strict_model: s.llm_strict_model === true,
			moonbag_always: s.moonbag_always !== false,
			label: s.label || null,
			experiment_group: s.experiment_group || null,
			summary: {
				open_positions: sum ? Number(sum.open_positions) : 0,
				closed_positions: sum ? Number(sum.closed_positions) : 0,
				realized_pnl_lamports: sum ? sum.realized_pnl_lamports : '0',
				wins: sum ? Number(sum.wins) : 0,
			},
		};
	});

	return json(res, 200, { strategies });
}

// ── POST — upsert/arm strategy ───────────────────────────────────────────────

async function upsertStrategy(req, res, userId) {
	// Arming a sniper commits the agent's real custodial funds to autonomous
	// trading, so this state-changing write gets the same CSRF gate as withdraw
	// and the spend-limit endpoints. Machine (bearer) callers are exempt inside
	// requireCsrf, which is why the client already sends the token.
	if (!(await requireCsrf(req, res, userId))) return;

	const body = await readJson(req);
	// Treasury auto-funding moves SOL from the platform's launcher master into an
	// agent wallet, so consent for it is granted by an operator against the row
	// (scripts/seed-sniper-experiments.mjs, scripts/trading-experiment-setup.mjs),
	// never by the owner of the agent through this endpoint. Say so out loud: a
	// silently-stripped flag reads as "opted in" to whoever sent it.
	if (body && typeof body === 'object' && 'auto_fund_enabled' in body) {
		return error(res, 400, 'bad_request', 'auto_fund_enabled is not settable here: treasury auto-funding is operator-granted');
	}
	const parsed = STRATEGY_SCHEMA.safeParse(body);
	if (!parsed.success) {
		return error(res, 400, 'bad_request', parsed.error.issues[0]?.message || 'invalid strategy');
	}
	const p = parsed.data;

	// Ownership: the agent must belong to the caller.
	const [agent] = await sql`
		select id from agent_identities
		where id = ${p.agent_id} and user_id = ${userId} and deleted_at is null
		limit 1
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found or not owned by you');

	const [existing] = await sql`
		select * from agent_sniper_strategies
		where agent_id = ${p.agent_id} and network = ${p.network} limit 1
	`;
	const cur = existing || {
		enabled: false, kill_switch: false,
		trigger: 'new_mint', buy_delay_ms: 0,
		min_claim_lamports: null, max_claim_lamports: null, first_claim_max_age_seconds: null,
		daily_budget_lamports: '0', per_trade_lamports: '0',
		max_concurrent_positions: 1, slippage_bps: 500, max_price_impact_pct: 10,
		mev_tip_mode: 'off', firewall_level: 'block',
		risk_officer_level: 'shadow', risk_officer_model: null,
		min_market_cap_usd: null, max_market_cap_usd: null,
		min_creator_graduated: null, max_creator_launches: null,
		require_socials: false, require_sol_quote: true,
		take_profit_pct: null, stop_loss_pct: 30, trailing_stop_pct: null,
		max_hold_seconds: 1800,
		min_oracle_score: null,
		min_creator_graduated_radar: null, require_smart_money_funder: false, radar_max_age_ms: null,
		min_quality_score: null, max_bundle_score: null, max_concentration_top1: null,
		avoid_dev_dump: true, allowed_categories: null,
		telegram_chat_id: null,
		alpha_min_smart_money: null, alpha_min_organic_score: null, alpha_max_mcap_usd: null,
		alpha_narrative_keywords: null, alpha_min_quality_score: null,
		decision_mode: 'rules', llm_model: null, llm_min_confidence: null,
		llm_max_confidence: null, llm_strict_model: false, moonbag_always: true,
		initials_out_multiple: 2,
		label: null, experiment_group: null,
	};

	const next = {
		enabled: p.enabled ?? cur.enabled,
		kill_switch: p.kill_switch ?? cur.kill_switch,
		trigger: p.trigger ?? cur.trigger,
		buy_delay_ms: p.buy_delay_ms != null ? clampInt(p.buy_delay_ms, 0, 600000, 0) : cur.buy_delay_ms,
		min_claim_lamports: 'min_claim_lamports' in p ? atomicOrNull(p.min_claim_lamports) : (cur.min_claim_lamports != null ? String(cur.min_claim_lamports) : null),
		max_claim_lamports: 'max_claim_lamports' in p ? atomicOrNull(p.max_claim_lamports) : (cur.max_claim_lamports != null ? String(cur.max_claim_lamports) : null),
		first_claim_max_age_seconds: 'first_claim_max_age_seconds' in p ? (p.first_claim_max_age_seconds == null ? null : clampInt(p.first_claim_max_age_seconds, 1, 86400, 300)) : cur.first_claim_max_age_seconds,
		daily_budget_lamports: p.daily_budget_lamports != null ? atomicStr(p.daily_budget_lamports) : String(cur.daily_budget_lamports),
		per_trade_lamports: p.per_trade_lamports != null ? atomicStr(p.per_trade_lamports) : String(cur.per_trade_lamports),
		max_concurrent_positions: p.max_concurrent_positions != null ? clampInt(p.max_concurrent_positions, 1, 50, 1) : cur.max_concurrent_positions,
		slippage_bps: p.slippage_bps != null ? clampInt(p.slippage_bps, 0, 5000, 500) : cur.slippage_bps,
		max_price_impact_pct: p.max_price_impact_pct != null ? Math.min(100, Math.max(0, Number(p.max_price_impact_pct))) : Number(cur.max_price_impact_pct),
		mev_tip_mode: p.mev_tip_mode != null ? p.mev_tip_mode : (cur.mev_tip_mode || 'off'),
		firewall_level: p.firewall_level != null ? p.firewall_level : (cur.firewall_level || 'block'),
		risk_officer_level: p.risk_officer_level != null ? p.risk_officer_level : (cur.risk_officer_level || 'shadow'),
		risk_officer_model: 'risk_officer_model' in p ? (p.risk_officer_model || null) : (cur.risk_officer_model || null),
		min_market_cap_usd: 'min_market_cap_usd' in p ? numOrNull(p.min_market_cap_usd) : (cur.min_market_cap_usd != null ? Number(cur.min_market_cap_usd) : null),
		max_market_cap_usd: 'max_market_cap_usd' in p ? numOrNull(p.max_market_cap_usd) : (cur.max_market_cap_usd != null ? Number(cur.max_market_cap_usd) : null),
		min_creator_graduated: 'min_creator_graduated' in p ? intOrNull(p.min_creator_graduated) : cur.min_creator_graduated,
		max_creator_launches: 'max_creator_launches' in p ? intOrNull(p.max_creator_launches) : cur.max_creator_launches,
		require_socials: p.require_socials ?? cur.require_socials,
		require_sol_quote: p.require_sol_quote ?? cur.require_sol_quote,
		take_profit_pct: 'take_profit_pct' in p ? numOrNull(p.take_profit_pct) : (cur.take_profit_pct != null ? Number(cur.take_profit_pct) : null),
		stop_loss_pct: p.stop_loss_pct != null ? Number(p.stop_loss_pct) : Number(cur.stop_loss_pct),
		trailing_stop_pct: 'trailing_stop_pct' in p ? numOrNull(p.trailing_stop_pct) : (cur.trailing_stop_pct != null ? Number(cur.trailing_stop_pct) : null),
		max_hold_seconds: p.max_hold_seconds != null ? clampInt(p.max_hold_seconds, 30, 86400, 1800) : cur.max_hold_seconds,
		min_oracle_score: 'min_oracle_score' in p ? (p.min_oracle_score == null || p.min_oracle_score === '' ? null : Math.min(100, Math.max(0, Math.round(Number(p.min_oracle_score))))) : cur.min_oracle_score,
		min_creator_graduated_radar: 'min_creator_graduated_radar' in p ? (p.min_creator_graduated_radar == null || p.min_creator_graduated_radar === '' ? null : clampInt(p.min_creator_graduated_radar, 0, 100000, 0)) : (cur.min_creator_graduated_radar ?? null),
		require_smart_money_funder: p.require_smart_money_funder ?? cur.require_smart_money_funder ?? false,
		radar_max_age_ms: 'radar_max_age_ms' in p ? (p.radar_max_age_ms == null || p.radar_max_age_ms === '' ? null : clampInt(p.radar_max_age_ms, 1000, 3600000, 120000)) : (cur.radar_max_age_ms ?? null),
		min_quality_score: 'min_quality_score' in p ? (p.min_quality_score == null || p.min_quality_score === '' ? null : Math.min(100, Math.max(0, Math.round(Number(p.min_quality_score))))) : (cur.min_quality_score != null ? Number(cur.min_quality_score) : null),
		max_bundle_score: 'max_bundle_score' in p ? (p.max_bundle_score == null || p.max_bundle_score === '' ? null : Math.min(1, Math.max(0, Number(p.max_bundle_score)))) : (cur.max_bundle_score != null ? Number(cur.max_bundle_score) : null),
		max_concentration_top1: 'max_concentration_top1' in p ? (p.max_concentration_top1 == null || p.max_concentration_top1 === '' ? null : Math.min(100, Math.max(0, Number(p.max_concentration_top1)))) : (cur.max_concentration_top1 != null ? Number(cur.max_concentration_top1) : null),
		avoid_dev_dump: p.avoid_dev_dump ?? cur.avoid_dev_dump ?? true,
		allowed_categories: 'allowed_categories' in p ? (Array.isArray(p.allowed_categories) ? p.allowed_categories.filter(Boolean) : null) : (cur.allowed_categories || null),
		telegram_chat_id: 'telegram_chat_id' in p ? (p.telegram_chat_id || null) : (cur.telegram_chat_id || null),
		alpha_min_smart_money: 'alpha_min_smart_money' in p ? (p.alpha_min_smart_money == null ? null : Math.min(20, Math.max(0, Math.round(Number(p.alpha_min_smart_money))))) : (cur.alpha_min_smart_money != null ? Number(cur.alpha_min_smart_money) : null),
		alpha_min_organic_score: 'alpha_min_organic_score' in p ? (p.alpha_min_organic_score == null ? null : Math.min(100, Math.max(0, Number(p.alpha_min_organic_score)))) : (cur.alpha_min_organic_score != null ? Number(cur.alpha_min_organic_score) : null),
		alpha_max_mcap_usd: 'alpha_max_mcap_usd' in p ? (p.alpha_max_mcap_usd == null ? null : Math.max(0, Number(p.alpha_max_mcap_usd))) : (cur.alpha_max_mcap_usd != null ? Number(cur.alpha_max_mcap_usd) : null),
		alpha_narrative_keywords: 'alpha_narrative_keywords' in p ? (Array.isArray(p.alpha_narrative_keywords) ? p.alpha_narrative_keywords.filter(Boolean).slice(0, 10) : null) : (cur.alpha_narrative_keywords || null),
		alpha_min_quality_score: 'alpha_min_quality_score' in p ? (p.alpha_min_quality_score == null ? null : Math.min(100, Math.max(0, Math.round(Number(p.alpha_min_quality_score))))) : (cur.alpha_min_quality_score != null ? Number(cur.alpha_min_quality_score) : null),
		// Off-by-default consent for the auto-funder to top this agent's wallet up
		// from the launcher master. Arming a strategy never moves money on its own,
		// and this endpoint never grants the consent either (rejected above): the
		// write only carries the stored value through the upsert unchanged.
		auto_fund_enabled: cur.auto_fund_enabled ?? false,
		// Laddered take-initials exit (fleet default, owner rule 2026-07-25): at
		// initials_out_multiple × entry, sell exactly enough to recover the cost
		// basis and let the rest ride behind the trailing stop. New strategies get
		// 2× unless the creator sets a value; an explicit null opts back into the
		// classic single-shot exit. moonbag_min_pct = the floor always kept.
		initials_out_multiple: 'initials_out_multiple' in p ? (p.initials_out_multiple == null || p.initials_out_multiple === '' ? null : clampNum(p.initials_out_multiple, 1.01, 1000, 2)) : (cur.initials_out_multiple != null ? Number(cur.initials_out_multiple) : null),
		moonbag_min_pct: 'moonbag_min_pct' in p && p.moonbag_min_pct !== '' ? clampNum(p.moonbag_min_pct, 0, 95, 15) : (cur.moonbag_min_pct != null ? Number(cur.moonbag_min_pct) : 15),
		// Experiment identity + decision mode. 'llm' replaces the rule shields with
		// a per-launch model verdict; safety rails still hold at executeBuy.
		decision_mode: p.decision_mode ?? cur.decision_mode ?? 'rules',
		llm_model: 'llm_model' in p ? (p.llm_model || null) : (cur.llm_model || null),
		llm_min_confidence: 'llm_min_confidence' in p ? (p.llm_min_confidence == null || p.llm_min_confidence === '' ? null : Math.min(1, Math.max(0, Number(p.llm_min_confidence)))) : (cur.llm_min_confidence != null ? Number(cur.llm_min_confidence) : null),
		// Overconfidence CEILING (audit: the 0.9+ band went winless). A buy verdict
		// at/above it is recorded but never funded. Null = no ceiling.
		llm_max_confidence: 'llm_max_confidence' in p ? (p.llm_max_confidence == null || p.llm_max_confidence === '' ? null : Math.min(1, Math.max(0.05, Number(p.llm_max_confidence)))) : (cur.llm_max_confidence != null ? Number(cur.llm_max_confidence) : null),
		// Named-model integrity: a strict arm refuses to trade on a fallback
		// model's verdict, pausing rather than polluting its own experiment.
		llm_strict_model: 'llm_strict_model' in p ? Boolean(p.llm_strict_model) : (cur.llm_strict_model === true),
		// Fleet-wide never-sell-100%-of-a-winner rule; opt-out per strategy.
		moonbag_always: 'moonbag_always' in p ? Boolean(p.moonbag_always) : (cur.moonbag_always !== false),
		label: 'label' in p ? (p.label || null) : (cur.label || null),
		experiment_group: 'experiment_group' in p ? (p.experiment_group || null) : (cur.experiment_group || null),
	};

	// Mandatory stop-loss — never let the DB constraint be the first line of defense.
	if (!(next.stop_loss_pct > 0)) {
		return error(res, 400, 'bad_request', 'stop_loss_pct must be greater than 0');
	}
	// A live, armed strategy with no real money makes no sense; guide the owner.
	if (next.enabled && (BigInt(next.daily_budget_lamports) <= 0n || BigInt(next.per_trade_lamports) <= 0n)) {
		return error(res, 400, 'bad_request', 'set a daily_budget_lamports and per_trade_lamports before enabling');
	}
	if (next.enabled && BigInt(next.per_trade_lamports) > BigInt(next.daily_budget_lamports)) {
		return error(res, 400, 'bad_request', 'per_trade_lamports cannot exceed daily_budget_lamports');
	}
	if (next.min_claim_lamports != null && next.max_claim_lamports != null &&
		BigInt(next.min_claim_lamports) > BigInt(next.max_claim_lamports)) {
		return error(res, 400, 'bad_request', 'min_claim_lamports cannot exceed max_claim_lamports');
	}

	const [row] = await sql`
		insert into agent_sniper_strategies
			(agent_id, user_id, network, enabled, kill_switch,
			 trigger, buy_delay_ms, min_claim_lamports, max_claim_lamports, first_claim_max_age_seconds,
			 daily_budget_lamports, per_trade_lamports, max_concurrent_positions,
			 slippage_bps, max_price_impact_pct, mev_tip_mode, firewall_level,
			 risk_officer_level, risk_officer_model,
			 min_market_cap_usd, max_market_cap_usd, min_creator_graduated, max_creator_launches,
			 require_socials, require_sol_quote,
			 take_profit_pct, stop_loss_pct, trailing_stop_pct, max_hold_seconds,
			 min_oracle_score,
			 min_creator_graduated_radar, require_smart_money_funder, radar_max_age_ms,
			 min_quality_score, max_bundle_score, max_concentration_top1,
			 avoid_dev_dump, allowed_categories, telegram_chat_id,
			 alpha_min_smart_money, alpha_min_organic_score, alpha_max_mcap_usd,
			 alpha_narrative_keywords, alpha_min_quality_score, auto_fund_enabled,
			 initials_out_multiple, moonbag_min_pct,
			 decision_mode, llm_model, llm_min_confidence, llm_max_confidence, llm_strict_model, moonbag_always, label, experiment_group, updated_at)
		values
			(${p.agent_id}, ${userId}, ${p.network}, ${next.enabled}, ${next.kill_switch},
			 ${next.trigger}, ${next.buy_delay_ms}, ${next.min_claim_lamports}, ${next.max_claim_lamports}, ${next.first_claim_max_age_seconds},
			 ${next.daily_budget_lamports}, ${next.per_trade_lamports}, ${next.max_concurrent_positions},
			 ${next.slippage_bps}, ${next.max_price_impact_pct}, ${next.mev_tip_mode}, ${next.firewall_level},
			 ${next.risk_officer_level}, ${next.risk_officer_model},
			 ${next.min_market_cap_usd}, ${next.max_market_cap_usd}, ${next.min_creator_graduated}, ${next.max_creator_launches},
			 ${next.require_socials}, ${next.require_sol_quote},
			 ${next.take_profit_pct}, ${next.stop_loss_pct}, ${next.trailing_stop_pct}, ${next.max_hold_seconds},
			 ${next.min_oracle_score},
			 ${next.min_creator_graduated_radar}, ${next.require_smart_money_funder}, ${next.radar_max_age_ms},
			 ${next.min_quality_score}, ${next.max_bundle_score}, ${next.max_concentration_top1},
			 ${next.avoid_dev_dump}, ${next.allowed_categories}, ${next.telegram_chat_id},
			 ${next.alpha_min_smart_money}, ${next.alpha_min_organic_score}, ${next.alpha_max_mcap_usd},
			 ${next.alpha_narrative_keywords}, ${next.alpha_min_quality_score}, ${next.auto_fund_enabled},
			 ${next.initials_out_multiple}, ${next.moonbag_min_pct},
			 ${next.decision_mode}, ${next.llm_model}, ${next.llm_min_confidence}, ${next.llm_max_confidence}, ${next.llm_strict_model}, ${next.moonbag_always}, ${next.label}, ${next.experiment_group}, now())
		on conflict (agent_id, network) do update set
			enabled                  = excluded.enabled,
			kill_switch              = excluded.kill_switch,
			trigger                  = excluded.trigger,
			buy_delay_ms             = excluded.buy_delay_ms,
			min_claim_lamports       = excluded.min_claim_lamports,
			max_claim_lamports       = excluded.max_claim_lamports,
			first_claim_max_age_seconds = excluded.first_claim_max_age_seconds,
			daily_budget_lamports    = excluded.daily_budget_lamports,
			per_trade_lamports       = excluded.per_trade_lamports,
			max_concurrent_positions = excluded.max_concurrent_positions,
			slippage_bps             = excluded.slippage_bps,
			max_price_impact_pct     = excluded.max_price_impact_pct,
			mev_tip_mode             = excluded.mev_tip_mode,
			firewall_level           = excluded.firewall_level,
			risk_officer_level       = excluded.risk_officer_level,
			risk_officer_model       = excluded.risk_officer_model,
			min_market_cap_usd       = excluded.min_market_cap_usd,
			max_market_cap_usd       = excluded.max_market_cap_usd,
			min_creator_graduated    = excluded.min_creator_graduated,
			max_creator_launches     = excluded.max_creator_launches,
			require_socials          = excluded.require_socials,
			require_sol_quote        = excluded.require_sol_quote,
			take_profit_pct          = excluded.take_profit_pct,
			stop_loss_pct            = excluded.stop_loss_pct,
			trailing_stop_pct        = excluded.trailing_stop_pct,
			max_hold_seconds         = excluded.max_hold_seconds,
			min_oracle_score         = excluded.min_oracle_score,
			min_creator_graduated_radar = excluded.min_creator_graduated_radar,
			require_smart_money_funder  = excluded.require_smart_money_funder,
			radar_max_age_ms            = excluded.radar_max_age_ms,
			min_quality_score        = excluded.min_quality_score,
			max_bundle_score         = excluded.max_bundle_score,
			max_concentration_top1   = excluded.max_concentration_top1,
			avoid_dev_dump           = excluded.avoid_dev_dump,
			allowed_categories       = excluded.allowed_categories,
			telegram_chat_id         = excluded.telegram_chat_id,
			alpha_min_smart_money    = excluded.alpha_min_smart_money,
			alpha_min_organic_score  = excluded.alpha_min_organic_score,
			alpha_max_mcap_usd       = excluded.alpha_max_mcap_usd,
			alpha_narrative_keywords = excluded.alpha_narrative_keywords,
			alpha_min_quality_score  = excluded.alpha_min_quality_score,
			auto_fund_enabled        = excluded.auto_fund_enabled,
			initials_out_multiple    = excluded.initials_out_multiple,
			moonbag_min_pct          = excluded.moonbag_min_pct,
			decision_mode            = excluded.decision_mode,
			llm_model                = excluded.llm_model,
			llm_min_confidence       = excluded.llm_min_confidence,
			llm_max_confidence       = excluded.llm_max_confidence,
			llm_strict_model         = excluded.llm_strict_model,
			moonbag_always           = excluded.moonbag_always,
			label                    = excluded.label,
			experiment_group         = excluded.experiment_group,
			updated_at               = now()
		returning *
	`;

	return json(res, 200, {
		ok: true,
		strategy: {
			agent_id: row.agent_id,
			network: row.network,
			enabled: row.enabled,
			kill_switch: row.kill_switch,
			trigger: row.trigger || 'new_mint',
			buy_delay_ms: row.buy_delay_ms ?? 0,
			min_claim_lamports: row.min_claim_lamports != null ? String(row.min_claim_lamports) : null,
			max_claim_lamports: row.max_claim_lamports != null ? String(row.max_claim_lamports) : null,
			first_claim_max_age_seconds: row.first_claim_max_age_seconds ?? null,
			daily_budget_lamports: String(row.daily_budget_lamports),
			per_trade_lamports: String(row.per_trade_lamports),
			max_concurrent_positions: row.max_concurrent_positions,
			slippage_bps: row.slippage_bps,
			max_price_impact_pct: Number(row.max_price_impact_pct),
			mev_tip_mode: row.mev_tip_mode || 'off',
			firewall_level: row.firewall_level || 'block',
			risk_officer_level: row.risk_officer_level || 'shadow',
			risk_officer_model: row.risk_officer_model || null,
			min_market_cap_usd: row.min_market_cap_usd != null ? Number(row.min_market_cap_usd) : null,
			max_market_cap_usd: row.max_market_cap_usd != null ? Number(row.max_market_cap_usd) : null,
			min_creator_graduated: row.min_creator_graduated,
			max_creator_launches: row.max_creator_launches,
			require_socials: row.require_socials,
			require_sol_quote: row.require_sol_quote,
			take_profit_pct: row.take_profit_pct != null ? Number(row.take_profit_pct) : null,
			stop_loss_pct: Number(row.stop_loss_pct),
			trailing_stop_pct: row.trailing_stop_pct != null ? Number(row.trailing_stop_pct) : null,
			max_hold_seconds: row.max_hold_seconds,
			min_oracle_score: row.min_oracle_score != null ? Number(row.min_oracle_score) : null,
			min_creator_graduated_radar: row.min_creator_graduated_radar ?? null,
			require_smart_money_funder: row.require_smart_money_funder ?? false,
			radar_max_age_ms: row.radar_max_age_ms ?? null,
			min_quality_score: row.min_quality_score != null ? Number(row.min_quality_score) : null,
			max_bundle_score: row.max_bundle_score != null ? Number(row.max_bundle_score) : null,
			max_concentration_top1: row.max_concentration_top1 != null ? Number(row.max_concentration_top1) : null,
			avoid_dev_dump: row.avoid_dev_dump ?? true,
			allowed_categories: row.allowed_categories || null,
			telegram_chat_id: row.telegram_chat_id || null,
			alpha_min_smart_money: row.alpha_min_smart_money != null ? Number(row.alpha_min_smart_money) : null,
			alpha_min_organic_score: row.alpha_min_organic_score != null ? Number(row.alpha_min_organic_score) : null,
			alpha_max_mcap_usd: row.alpha_max_mcap_usd != null ? Number(row.alpha_max_mcap_usd) : null,
			alpha_narrative_keywords: row.alpha_narrative_keywords || null,
			alpha_min_quality_score: row.alpha_min_quality_score != null ? Number(row.alpha_min_quality_score) : null,
			auto_fund_enabled: row.auto_fund_enabled ?? false,
			initials_out_multiple: row.initials_out_multiple != null ? Number(row.initials_out_multiple) : null,
			moonbag_min_pct: row.moonbag_min_pct != null ? Number(row.moonbag_min_pct) : 15,
			decision_mode: row.decision_mode || 'rules',
			llm_model: row.llm_model || null,
			llm_min_confidence: row.llm_min_confidence != null ? Number(row.llm_min_confidence) : null,
			llm_max_confidence: row.llm_max_confidence != null ? Number(row.llm_max_confidence) : null,
			llm_strict_model: row.llm_strict_model === true,
			moonbag_always: row.moonbag_always !== false,
			label: row.label || null,
			experiment_group: row.experiment_group || null,
		},
	});
}
