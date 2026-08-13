// Oracle MCP tools — conviction signal for autonomous agents.
//
// Three tools, one mission: give any 3D AI agent on three.ws access to the
// same Oracle conviction intelligence that drives the platform's own sniper
// strategy and copy-trading systems.
//
//   oracle_top_plays   — public, no auth needed. Returns the current top-scoring
//                        pump.fun launches ranked by Oracle conviction. Each play
//                        carries a machine-readable recommendation: action (buy /
//                        watch / skip), confidence, and a suggested size factor
//                        so the agent never has to re-derive the trading signal.
//
//   oracle_coin        — public. Full conviction verdict for one specific mint:
//                        score, tier, four pillar scores, badges, and the same
//                        agent-ready recommendation envelope.
//
//   oracle_arm_watch   — requires account auth (scope: agents:write). Arms (or
//                        updates) the caller's agent to act on the live Oracle
//                        stream. Sets the conviction floor, category filters,
//                        per-trade SOL cap, and simulate-vs-live mode. The
//                        cron runs every 2 min and will execute actions on behalf
//                        of the agent without further intervention.

import { sql } from '../../_lib/db.js';
import { limits } from '../../_lib/rate-limit.js';
import { readFeed, scoreCoin, getWatch, upsertWatch, recentActions, actionsSummary } from '../../_lib/oracle/store.js';
import { isUuid } from '../../_lib/validate.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const CATEGORIES = new Set([
	'meme', 'tech', 'ai', 'culture', 'community', 'political',
	'news', 'animal', 'celebrity', 'utility', 'unknown',
]);
const TIERS = new Set(['prime', 'strong', 'lean', 'watch']);
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const REC = {
	prime:  { action: 'buy',   confidence: 'high',   size_factor: 1.0,  note: 'top-conviction play — proven smart money + clean structure + on-narrative' },
	strong: { action: 'buy',   confidence: 'medium', size_factor: 0.75, note: 'strong conviction — favorable across multiple pillars' },
	lean:   { action: 'watch', confidence: 'low',    size_factor: 0,    note: 'leaning positive but not decisive — watch for confirmation' },
	watch:  { action: 'skip',  confidence: 'low',    size_factor: 0,    note: 'inconclusive — no edge yet' },
	avoid:  { action: 'skip',  confidence: 'high',   size_factor: 0,    note: 'structural or pedigree red flags — avoid' },
};

function shapePlay(it) {
	return {
		mint: it.mint,
		symbol: it.symbol,
		conviction: it.score,
		tier: it.tier,
		category: it.category,
		smart_wallet_count: it.smart_wallet_count ?? 0,
		pillars: it.pillars,
		badges: it.badges ?? [],
		recommendation: REC[it.tier] || REC.avoid,
		scored_at: it.scored_at,
	};
}

function mcpOk(payload) {
	return {
		content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
		structuredContent: payload,
	};
}

function mcpErr(msg) {
	return { content: [{ type: 'text', text: msg }], isError: true };
}

// Throws on a DB fault rather than swallowing it. Swallowing turned an outage
// into "that agent does not belong to your account": a confident, false answer
// that sends the owner off to audit permissions that were never the problem.
// The dispatcher sanitizes the throw into the transient retry message instead.
async function ownsAgent(userId, agentId) {
	const rows = await sql`
		select id from agent_identities
		where id = ${agentId} and user_id = ${userId} and deleted_at is null
		limit 1
	`;
	return rows.length > 0;
}

const LIVE_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};

export const toolDefs = [
	// ── oracle_top_plays ────────────────────────────────────────────────────
	{
		name: 'oracle_top_plays',
		title: 'Oracle top conviction plays',
		annotations: LIVE_ANNOTATIONS,
		description:
			"Get the current top pump.fun launches ranked by Oracle conviction score. Each play includes a score (0–100), tier (prime/strong/lean/watch/avoid), four pillar scores (pedigree/structure/narrative/momentum), and an agent-ready recommendation with a suggested size_factor. Use this to decide which coins to buy before they move. Filter by min_score or category to narrow the signal.",
		inputSchema: {
			type: 'object',
			properties: {
				limit:     { type: 'integer', minimum: 1, maximum: 20, default: 5, description: 'Number of plays to return (default 5, max 20).' },
				min_score: { type: 'integer', minimum: 0, maximum: 100, default: 72, description: 'Minimum conviction score (0–100). Default 72 (strong+).' },
				category:  { type: 'string', enum: [...CATEGORIES], description: 'Filter by narrative category (optional).' },
				network:   { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			additionalProperties: false,
		},
		async handler(args, auth) {
			const network  = NETWORKS.has(args?.network) ? args.network : 'mainnet';
			const minScore = Math.max(0, Math.min(100, Number(args?.min_score ?? 72)));
			const limit    = Math.min(20, Math.max(1, Number(args?.limit ?? 5)));
			const category = CATEGORIES.has(args?.category) ? args.category : null;

			const rl = await limits.mcpIp(auth.rateKey || 'anon');
			if (!rl.success) return mcpErr('Rate limit exceeded — try again in a moment.');

			// A degraded feed store is NOT an empty feed. Returning [] on a fault
			// rendered "no plays at this conviction floor, try lowering min_score",
			// which reads as a real market answer and coaches the agent into
			// loosening its filters during an outage. Say it is transient instead,
			// the way oracle_coin already does.
			let items;
			try {
				items = await readFeed({ network, limit, minScore, category, sinceSeconds: 6 * 3600 });
			} catch {
				return mcpErr('Oracle is temporarily unavailable: the feed store is degraded. Retry shortly.');
			}

			const plays = items.map(shapePlay);
			const payload = {
				network,
				count: plays.length,
				top: plays[0] || null,
				plays,
				generated_at: new Date().toISOString(),
				hint: plays.length === 0
					? 'No plays found at this conviction floor. Try lowering min_score or broadening the category.'
					: `Top play: ${plays[0]?.symbol || plays[0]?.mint} at ${plays[0]?.conviction}/100 (${plays[0]?.tier}).`,
			};
			return mcpOk(payload);
		},
	},

	// ── oracle_coin ─────────────────────────────────────────────────────────
	{
		name: 'oracle_coin',
		title: 'Oracle verdict for one coin',
		annotations: LIVE_ANNOTATIONS,
		description:
			"Get Oracle's full conviction verdict for a specific pump.fun coin by mint address. Returns the fused 0–100 conviction score, tier (prime/strong/lean/watch/avoid), all four pillar scores (pedigree = who's behind it, structure = how it's built, narrative = cultural fit, momentum = early trading signal), active badges (e.g. smart_money_early, narrative_match), and a machine-readable buy/watch/skip recommendation. If the coin isn't in the Oracle cache yet, it will be scored on-demand (may add ~1s latency).",
		inputSchema: {
			type: 'object',
			properties: {
				mint:    { type: 'string', description: 'SPL mint pubkey (base58) of the pump.fun coin.' },
				network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			required: ['mint'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			const network = NETWORKS.has(args?.network) ? args.network : 'mainnet';
			const mint = (args?.mint || '').trim();

			if (!MINT_RE.test(mint)) return mcpErr('Invalid mint: must be a base58 Solana address (32–44 chars).');

			const rl = await limits.mcpIp(auth.rateKey || 'anon');
			if (!rl.success) return mcpErr('Rate limit exceeded — try again in a moment.');

			let scored;
			try {
				scored = await scoreCoin(mint, { network, classify: true, persist: true });
			} catch {
				// Intel store / DB degraded — distinct from "coin unknown". Tell the
				// agent it's transient so it retries rather than concluding the coin
				// doesn't exist.
				return mcpErr(`Oracle is temporarily unavailable for ${mint} — the intel store is degraded. Retry shortly.`);
			}
			if (!scored) {
				return mcpErr(`Coin ${mint} not found in Oracle — it may not have been observed on pump.fun yet.`);
			}

			const v = scored.verdict;
			const play = shapePlay({
				mint, symbol: scored.intel?.symbol, score: v.score, tier: v.tier,
				category: scored.intel?.category,
				smart_wallet_count: scored.intel?.smartMoney?.smartWalletCount ?? 0,
				pillars: v.pillars, badges: v.badges,
				scored_at: new Date().toISOString(),
			});

			const payload = {
				network, ...play,
				// How much of the verdict rests on real data vs. defaulted inputs.
				// Agents should scale conviction in this: a high score with low
				// data_confidence is a lead to watch, not a call to size into.
				data_confidence: v.confidence ?? null,
				data_confidence_label: v.confidenceLabel ?? null,
				market_cap_usd: scored.intel?.marketCapUsd ?? null,
				graduated: scored.intel?.graduated ?? false,
				creator: scored.intel?.creator ?? null,
				generated_at: new Date().toISOString(),
			};
			return mcpOk(payload);
		},
	},

	// ── oracle_arm_watch ────────────────────────────────────────────────────
	{
		name: 'oracle_arm_watch',
		title: 'Arm agent Oracle watch',
		scope: 'agents:write',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		description:
			"Arm your agent to automatically act on Oracle conviction signals. Once armed, the Oracle cron (every 2 min) will detect high-conviction launches that cross your floor and execute buys from your agent's custodial Solana wallet. Set mode='simulate' (default, safe) to log what it would have bought without spending. Set mode='live' to spend real SOL. The agent acts at most once per mint, per-trade SOL is capped, and you can disarm at any time by passing armed=false.",
		inputSchema: {
			type: 'object',
			properties: {
				agent_id:            { type: 'string', format: 'uuid', description: 'Your agent UUID (from /api/agents or the dashboard).' },
				armed:               { type: 'boolean', default: true, description: 'true to arm, false to disarm.' },
				mode:                { type: 'string', enum: ['simulate', 'live'], default: 'simulate', description: "simulate = no real spend (safe default). live = real SOL from agent's wallet." },
				min_score:           { type: 'integer', minimum: 0, maximum: 100, default: 72, description: 'Conviction floor to act on (72 = strong+; 90 = prime only).' },
				min_tier:            { type: 'string', enum: ['prime', 'strong', 'lean', 'watch'], description: 'Alternative to min_score — acts on this tier and above.' },
				categories:          { type: 'array', items: { type: 'string', enum: [...CATEGORIES] }, description: 'Only act on coins in these narrative categories. Omit to act on all.' },
				per_trade_sol:       { type: 'number', minimum: 0.001, maximum: 1, default: 0.05, description: 'Max SOL per single trade (default 0.05). Ignored in simulate mode.' },
				max_daily_sol:       { type: 'number', minimum: 0, maximum: 10, default: 0.5, description: 'Daily SOL budget cap (default 0.5). The loop will not spend more in one day.' },
				max_open:            { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Max simultaneous open positions (default 10).' },
				require_smart_money: { type: 'boolean', default: false, description: 'Only act when at least one proven smart-money wallet is in early.' },
				size_scaling:        { type: 'boolean', default: true, description: 'Scale position size with conviction (prime = full, strong = 75%, lean = 50%).' },
				network:             { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			required: ['agent_id'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			if (!auth.userId) return mcpErr('You must be signed in with a three.ws account to arm an agent watch.');

			const agentId = (args?.agent_id || '').trim();
			if (!isUuid(agentId)) return mcpErr('Invalid agent_id — must be a UUID (get it from /api/agents or your dashboard).');

			if (!(await ownsAgent(auth.userId, agentId))) {
				return mcpErr(`Agent ${agentId} does not belong to your account.`);
			}

			const network = NETWORKS.has(args?.network) ? args.network : 'mainnet';

			const cfg = {
				armed:               args?.armed !== false,
				mode:                args?.mode === 'live' ? 'live' : 'simulate',
				min_score:           Math.max(0, Math.min(100, Number(args?.min_score ?? 72))),
				min_tier:            (args?.min_tier && TIERS.has(args.min_tier)) ? args.min_tier : 'strong',
				categories:          Array.isArray(args?.categories) ? args.categories.filter((c) => CATEGORIES.has(c)) : [],
				per_trade_sol:       Math.max(0.001, Math.min(1, Number(args?.per_trade_sol ?? 0.05))),
				max_daily_sol:       Math.max(0, Math.min(10, Number(args?.max_daily_sol ?? 0.5))),
				max_open:            Math.max(1, Math.min(50, Number(args?.max_open ?? 10))),
				require_smart_money: !!args?.require_smart_money,
				size_scaling:        args?.size_scaling !== false,
			};

			await upsertWatch(agentId, auth.userId, network, cfg);

			const [watch, summary] = await Promise.all([
				getWatch(agentId, network),
				actionsSummary(agentId, network),
			]);

			const payload = {
				success: true,
				agent_id: agentId,
				network,
				watch: watch || { agent_id: agentId, network, ...cfg },
				track_record: summary || { total: 0, wins: 0, losses: 0, win_rate: null, realized_pnl_sol: 0 },
				message: cfg.armed
					? `Agent armed in ${cfg.mode} mode. The Oracle cron runs every 2 min — your first action will appear in /oracle?tab=activity once a qualifying coin is scored.`
					: `Agent disarmed. No further Oracle actions will be taken.`,
				links: {
					activity: `https://three.ws/activity`,
					oracle:   `https://three.ws/oracle`,
					trader:   `https://three.ws/trader/${agentId}`,
				},
			};
			return mcpOk(payload);
		},
	},

	// ── oracle_watch_status ─────────────────────────────────────────────────
	{
		name: 'oracle_watch_status',
		title: 'Oracle watch status + track record',
		scope: 'agents:read',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		description:
			"Check your agent's current Oracle watch configuration and its realized track record: win rate, PnL, ROI, plus the 10 most recent actions with their outcomes. Use this to verify the agent is armed correctly and to review its performance before scaling up.",
		inputSchema: {
			type: 'object',
			properties: {
				agent_id: { type: 'string', format: 'uuid', description: 'Your agent UUID.' },
				network:  { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			required: ['agent_id'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			if (!auth.userId) return mcpErr('Sign in to check your agent watch status.');

			const agentId = (args?.agent_id || '').trim();
			if (!isUuid(agentId)) return mcpErr('Invalid agent_id — must be a UUID.');

			if (!(await ownsAgent(auth.userId, agentId))) {
				return mcpErr(`Agent ${agentId} does not belong to your account.`);
			}

			const network = NETWORKS.has(args?.network) ? args.network : 'mainnet';

			const [watch, summary, actions] = await Promise.all([
				getWatch(agentId, network),
				actionsSummary(agentId, network),
				recentActions(agentId, network, 10),
			]);

			if (!watch) {
				return mcpOk({
					agent_id: agentId, network,
					armed: false,
					message: "No Oracle watch configured yet. Use oracle_arm_watch to get started.",
					track_record: null,
					recent_actions: [],
				});
			}

			const payload = {
				agent_id: agentId,
				network,
				armed: watch.armed,
				mode: watch.mode,
				config: {
					min_score:           watch.min_score,
					min_tier:            watch.min_tier,
					categories:          watch.categories,
					per_trade_sol:       watch.per_trade_sol,
					max_daily_sol:       watch.max_daily_sol,
					max_open:            watch.max_open,
					require_smart_money: watch.require_smart_money,
					size_scaling:        watch.size_scaling,
				},
				track_record: summary || { total: 0, wins: 0, losses: 0, win_rate: null, realized_pnl_sol: 0 },
				recent_actions: (actions || []).map((a) => ({
					mint:              a.mint,
					symbol:            a.symbol,
					tier:              a.tier,
					conviction:        a.conviction,
					current_score:     a.current_score ?? null,
					current_tier:      a.current_tier ?? null,
					size_sol:          a.size_sol,
					mode:              a.mode,
					outcome:           a.outcome,
					pnl_sol:           a.realized_pnl_sol,
					// Open-position exit call — an agent reading its own status can act
					// on this to close a position whose thesis has broken.
					exit_signal:       a.exit_signal ?? null,
					acted_at:          a.acted_at,
				})),
				links: {
					trader: `https://three.ws/trader/${agentId}`,
					oracle: `https://three.ws/oracle`,
				},
			};
			return mcpOk(payload);
		},
	},
];
