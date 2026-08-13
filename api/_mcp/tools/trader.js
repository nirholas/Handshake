// Trader MCP tools — leaderboard discovery + copy-trading for autonomous agents.
//
// Four tools that close the autonomous copy-trading loop:
//
//   trader_leaderboard  — public. Top agents ranked by composite TraderScore.
//                         Each row carries win rate, realized P&L, ROI, and
//                         a recommendation on whether to copy them.
//
//   trader_profile      — public. Full track record for one agent: score,
//                         all headline metrics, and the 10 most recent trades.
//
//   copy_subscribe      — auth-gated (agents:write). Set up copy-trading: mirror
//                         a leader's future entries to your own wallet with your
//                         own sizing and risk caps. Non-custodial — we never
//                         touch keys.
//
//   copy_status         — auth-gated (agents:read). Check the caller's active
//                         copy subscriptions and their execution counts.

import { sql, isDbUnavailableError } from '../../_lib/db.js';
import { limits } from '../../_lib/rate-limit.js';
import { getLeaderboard, getTraderStats, WINDOWS, LEADERBOARD_SORTS } from '../../_lib/trader-stats.js';
import { normalizeSubscriptionInput } from '../../_lib/copy-engine.js';
import { isUuid } from '../../_lib/validate.js';

const NETWORKS  = new Set(['mainnet', 'devnet']);
const SORTS     = new Set([...LEADERBOARD_SORTS]);
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function mcpOk(payload) {
	return {
		content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
		structuredContent: payload,
	};
}

function mcpErr(msg) {
	return { content: [{ type: 'text', text: msg }], isError: true };
}

// A DB outage and a genuine "no such row" used to look identical here: every
// query was wrapped in `.catch(() => [])`, so a dropped Neon connection told the
// caller their leader did not exist or that they had no subscriptions. That is a
// wrong answer, not a degraded one, and an agent acts on it. Now only transport
// and configuration failures are folded into an explicit "temporarily
// unavailable" reply; a real SQL fault propagates to the MCP dispatcher, which
// sanitizes it, logs it with an id, and returns isError.
function unavailable(err, what) {
	if (!isDbUnavailableError(err)) throw err;
	return mcpErr(`${what} is temporarily unavailable. Retry in a moment.`);
}

const LIVE = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function traderScore(r) {
	if (r.score >= 75 && r.verified) return 'copy';
	if (r.score >= 60 || (r.win_rate >= 60 && r.closed >= 5)) return 'watch';
	return 'skip';
}

function shapeLeaderboardRow(r) {
	return {
		rank:             r.rank,
		agent_id:         r.agent_id,
		name:             r.agent_name,
		image:            r.image || null,
		score:            r.score,
		verified:         r.verified,
		closed_trades:    r.closed,
		open_positions:   r.open_positions,
		wins:             r.wins,
		losses:           r.losses,
		win_rate_pct:     r.win_rate,
		realized_pnl_sol: r.realized_pnl_sol,
		realized_pnl_usd: r.realized_pnl_usd ?? null,
		roi_pct:          r.roi_pct,
		profit_factor:    r.profit_factor,
		max_drawdown_pct: r.max_drawdown_pct,
		copiers:          r.copiers,
		last_active_at:   r.last_active_at,
		recommendation:   traderScore(r),
		profile_url:      `https://three.ws/trader/${r.agent_id}`,
	};
}

export const toolDefs = [
	// ── trader_leaderboard ──────────────────────────────────────────────────
	{
		name: 'trader_leaderboard',
		title: 'Top pump.fun traders',
		annotations: LIVE,
		description:
			"Get the top pump.fun traders on three.ws ranked by composite TraderScore (win rate + P&L + ROI + drawdown). Each row includes score (0–100), verified badge, closed trade count, win rate, realized P&L in SOL and USD, ROI %, max drawdown, and a 'recommendation' field: 'copy' = strong candidate, 'watch' = emerging, 'skip' = unproven. Use trader_profile to get full details before copying. Sort by 'score' (default), 'pnl', 'winrate', or 'roi'. Window: '24h', '7d', '30d' (default), or 'all'.",
		inputSchema: {
			type: 'object',
			properties: {
				limit:         { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Max rows to return (default 10, max 50).' },
				sort:          { type: 'string', enum: ['score', 'pnl', 'winrate', 'roi'], default: 'score', description: 'Ranking metric.' },
				window:        { type: 'string', enum: ['24h', '7d', '30d', 'all'], default: '30d', description: 'Time window for trade history.' },
				verified_only: { type: 'boolean', default: false, description: 'Only return verified traders (12+ closed trades, 5+ unique coins, <40% churn).' },
				network:       { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			additionalProperties: false,
		},
		async handler(args, auth) {
			const network      = NETWORKS.has(args?.network) ? args.network : 'mainnet';
			const window       = WINDOWS.has(args?.window) ? args.window : '30d';
			const sort         = SORTS.has(args?.sort) ? args.sort : 'score';
			const asked        = Number(args?.limit ?? 10);
			// A non-finite limit reached getLeaderboard's `.slice(0, NaN)` and
			// silently returned an empty board that read as "no traders".
			const limit        = Number.isFinite(asked) ? Math.min(50, Math.max(1, Math.floor(asked))) : 10;
			const verifiedOnly = !!args?.verified_only;

			const rl = await limits.mcpIp(auth.rateKey || 'anon');
			if (!rl.success) return mcpErr('Rate limit exceeded, try again in a moment.');

			let result;
			try {
				result = await getLeaderboard({ network, window, sort, limit, verifiedOnly });
			} catch (err) {
				return unavailable(err, 'The trader leaderboard');
			}

			const traders = (result.leaderboard || []).map(shapeLeaderboardRow);
			const copyCount = traders.filter((t) => t.recommendation === 'copy').length;

			const payload = {
				network,
				window,
				sort,
				sol_usd: result.sol_usd ?? null,
				count: traders.length,
				copy_candidates: copyCount,
				traders,
				hint: traders.length === 0
					? 'No traders found in this window. Try a wider window or remove verified_only.'
					: `Top trader: ${traders[0].name} · score ${traders[0].score} · ${traders[0].win_rate_pct ?? '?'}% win rate. ${copyCount} copy candidate${copyCount !== 1 ? 's' : ''} in results.`,
				generated_at: new Date().toISOString(),
			};
			return mcpOk(payload);
		},
	},

	// ── trader_profile ──────────────────────────────────────────────────────
	{
		name: 'trader_profile',
		title: 'Full track record for one agent',
		annotations: LIVE,
		description:
			"Get the full, verifiable track record for a specific pump.fun agent trader. Returns the composite TraderScore, all headline metrics (win rate, realized P&L, ROI, profit factor, max drawdown, average hold time), up to 10 recent closed trades with their on-chain Solscan links, and any open positions. Every number is traceable to its on-chain buy/sell transaction. Use this to vet an agent before calling copy_subscribe.",
		inputSchema: {
			type: 'object',
			properties: {
				agent_id: { type: 'string', description: 'Agent UUID (from trader_leaderboard rows or /api/agents).' },
				window:   { type: 'string', enum: ['24h', '7d', '30d', 'all'], default: 'all', description: 'Time window for metrics (default all-time).' },
				network:  { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			required: ['agent_id'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			const agentId = (args?.agent_id || '').trim();
			if (!isUuid(agentId)) return mcpErr('Invalid agent_id — must be a UUID (get it from trader_leaderboard).');

			const network = NETWORKS.has(args?.network) ? args.network : 'mainnet';
			const window  = WINDOWS.has(args?.window) ? args.window : 'all';

			const rl = await limits.mcpIp(auth.rateKey || 'anon');
			if (!rl.success) return mcpErr('Rate limit exceeded, try again in a moment.');

			let stats;
			try {
				stats = await getTraderStats({ agentId, network, window });
			} catch (err) {
				return unavailable(err, 'This trader profile');
			}
			if (!stats) return mcpErr(`Agent ${agentId} not found or has no public trading history.`);
			if (!stats.agent.is_public) return mcpErr('This agent\'s track record is not public.');

			const m = stats.metrics;
			const topTrades = (stats.closed || []).slice(0, 10).map((t) => ({
				symbol:          t.symbol,
				mint:            t.mint,
				outcome:         t.realized_pnl_pct > 5 ? 'win' : t.realized_pnl_pct < -5 ? 'loss' : 'flat',
				pnl_sol:         t.realized_pnl_sol,
				pnl_pct:         t.realized_pnl_pct,
				hold_seconds:    t.hold_seconds,
				exit_reason:     t.exit_reason,
				closed_at:       t.closed_at,
				proof_url:       t.sell_solscan || t.buy_solscan || null,
			}));

			// The tool description promises open positions; only the count was ever
			// returned, so an agent vetting a leader could not see what they are
			// currently holding. Same shape the /trader page renders.
			const openPositions = (stats.open || []).map((p) => ({
				symbol:         p.symbol,
				mint:           p.mint,
				entry_sol:      p.entry_sol,
				current_sol:    p.current_sol,
				unrealized_pct: p.unrealized_pct,
				opened_at:      p.opened_at,
				proof_url:      p.buy_url || null,
			}));

			const rec = traderScore({ score: m.score, verified: m.verified, win_rate: m.win_rate, closed: m.closed_count });

			const payload = {
				agent_id:        agentId,
				name:            stats.agent.name,
				image:           stats.agent.image || null,
				network,
				window,
				sol_usd:         stats.sol_usd ?? null,
				score:           m.score,
				verified:        m.verified,
				recommendation:  rec,
				metrics: {
					closed_trades:      m.closed_count,
					open_positions:     m.open_count,
					wins:               m.wins,
					losses:             m.losses,
					win_rate_pct:       m.win_rate,
					realized_pnl_sol:   m.realized_pnl_sol,
					realized_pnl_usd:   m.realized_pnl_usd ?? null,
					roi_pct:            m.roi_pct,
					profit_factor:      m.profit_factor,
					avg_pnl_pct:        m.avg_pnl_pct,
					best_pnl_pct:       m.best_pnl_pct,
					max_drawdown_pct:   m.max_drawdown_pct,
					avg_hold_seconds:   m.avg_hold_seconds,
					unique_coins:       m.unique_coins,
				},
				copiers:         stats.agent.copiers,
				oracle:          stats.oracle ?? null,
				recent_trades:   topTrades,
				open_positions:  openPositions,
				profile_url:     `https://three.ws/trader/${agentId}`,
				generated_at:    new Date().toISOString(),
			};
			return mcpOk(payload);
		},
	},

	// ── copy_subscribe ──────────────────────────────────────────────────────
	{
		name: 'copy_subscribe',
		title: 'Subscribe to copy a trader',
		scope: 'agents:write',
		annotations: WRITE,
		description:
			"Set up non-custodial copy-trading: mirror a leader agent's future pump.fun entries into your own wallet with your own sizing and risk caps. You supply your wallet address and the sizing rules; we never hold keys. The fan-out cron checks for new leader entries and generates sized intents you act on from /dashboard/copy. Provide leader_agent_id (from trader_leaderboard) and your Solana wallet address. Sizing rules: 'fixed' = exact SOL per trade, 'multiplier' = N× leader size, 'pct_balance' = % of your balance. Always set a per_trade_cap_sol and daily_budget_sol to limit exposure.",
		inputSchema: {
			type: 'object',
			properties: {
				leader_agent_id:    { type: 'string', format: 'uuid', description: 'The agent UUID to copy (from trader_leaderboard).' },
				copier_wallet:      { type: 'string', description: 'Your Solana wallet address (base58) that will receive the copy intents.' },
				sizing_rule:        { type: 'string', enum: ['fixed', 'multiplier', 'pct_balance'], default: 'fixed', description: 'How to size your copies relative to the leader.' },
				fixed_sol:          { type: 'number', minimum: 0.001, description: 'SOL per trade (sizing_rule=fixed).' },
				multiplier:         { type: 'number', minimum: 0.01, maximum: 10, description: 'Multiplier of leader size (sizing_rule=multiplier).' },
				pct_balance:        { type: 'number', minimum: 0.1, maximum: 100, description: 'Percent of your balance per trade (sizing_rule=pct_balance).' },
				per_trade_cap_sol:  { type: 'number', minimum: 0.001, default: 0.05, description: 'Hard cap: no single copy trade may exceed this SOL amount.' },
				daily_budget_sol:   { type: 'number', minimum: 0.001, default: 0.5, description: 'Hard daily spend ceiling across all copy trades.' },
				min_order_sol:      { type: 'number', minimum: 0, default: 0, description: 'Skip copies that would be smaller than this SOL amount.' },
				max_open_copies:    { type: 'integer', minimum: 1, maximum: 50, default: 5, description: 'Max simultaneous open copy positions.' },
				min_oracle_score:   { type: 'integer', minimum: 0, maximum: 100, description: 'Only copy leader entries where Oracle conviction is at least this score.' },
				mcap_floor_usd:     { type: 'number', minimum: 0, description: 'Skip coins below this USD market cap at entry.' },
				mcap_ceiling_usd:   { type: 'number', minimum: 0, description: 'Skip coins above this USD market cap at entry (avoid already-pumped).' },
				telegram_chat_id:   { type: 'string', description: 'Telegram chat ID for copy-execution alerts (optional).' },
				perf_fee_bps:       { type: 'integer', minimum: 0, maximum: 3000, default: 1000, description: 'Performance fee in bps paid to the leader on wins (default 10%).' },
				network:            { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			required: ['leader_agent_id', 'copier_wallet'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			if (!auth.userId) return mcpErr('Sign in to a three.ws account to set up copy-trading.');

			const leaderId = (args?.leader_agent_id || '').trim();
			if (!isUuid(leaderId)) return mcpErr('Invalid leader_agent_id — must be a UUID from trader_leaderboard.');

			const wallet = (args?.copier_wallet || '').trim();
			if (!BASE58_RE.test(wallet)) return mcpErr('Invalid copier_wallet — must be a base58 Solana address.');

			const network = NETWORKS.has(args?.network) ? args.network : 'mainnet';

			const rl = await limits.mcpIp(auth.rateKey || 'anon');
			if (!rl.success) return mcpErr('Rate limit exceeded, try again in a moment.');

			// Validate leader exists and is public
			let leader;
			try {
				[leader] = await sql`
					select id, name, is_public from agent_identities
					where id = ${leaderId} and deleted_at is null limit 1
				`;
			} catch (err) {
				return unavailable(err, 'Copy-trading setup');
			}
			if (!leader) return mcpErr(`Leader agent ${leaderId} not found.`);
			if (leader.is_public === false) return mcpErr('That agent\'s trades are not public, so they cannot be copied.');

			const raw = {
				sizing_rule:      args?.sizing_rule ?? 'fixed',
				fixed_sol:        args?.fixed_sol,
				multiplier:       args?.multiplier,
				pct_balance:      args?.pct_balance,
				per_trade_cap_sol: args?.per_trade_cap_sol ?? 0.05,
				min_order_sol:    args?.min_order_sol ?? 0,
				daily_budget_sol: args?.daily_budget_sol ?? 0.5,
				max_open_copies:  args?.max_open_copies ?? 5,
				min_oracle_score: args?.min_oracle_score ?? null,
				mcap_floor_usd:   args?.mcap_floor_usd ?? null,
				mcap_ceiling_usd: args?.mcap_ceiling_usd ?? null,
				telegram_chat_id: args?.telegram_chat_id ?? null,
				perf_fee_bps:     args?.perf_fee_bps ?? 1000,
			};

			const norm = normalizeSubscriptionInput(raw);
			if (!norm.ok) return mcpErr(`Invalid subscription parameters: ${norm.error}`);
			const cfg = norm.value;

			// Denormalize the leader's trading wallet from their most recent position,
			// exactly as POST /api/copy/subscriptions does. Without it the row carries a
			// null leader_wallet and /api/copy/settle-fee refuses the leader's
			// performance fee with leader_wallet_unknown, so an MCP-created
			// subscription could never pay its leader. coalesce on update keeps a
			// previously recorded wallet when the leader has no position on this
			// network yet.
			let leaderWallet;
			try {
				const [pos] = await sql`
					select wallet from agent_sniper_positions
					where agent_id = ${leaderId} and network = ${network}
					order by opened_at desc limit 1
				`;
				leaderWallet = pos?.wallet || null;
			} catch (err) {
				return unavailable(err, 'Copy-trading setup');
			}

			// One atomic upsert against the (copier_user_id, leader_agent_id, network)
			// unique key. The previous select-then-insert lost the race between two
			// concurrent calls and failed the second with a raw unique violation.
			// `xmax = 0` is true only for the row this statement inserted, which is how
			// we still report created vs updated. copy_sells and require_safety_pass are
			// deliberately absent: this tool does not expose them, so an insert takes
			// the table defaults and an update leaves whatever the dashboard set.
			let sub;
			try {
				[sub] = await sql`
					insert into copy_subscriptions (
						copier_user_id, leader_agent_id, leader_wallet, network, copier_wallet,
						sizing_rule, fixed_sol, multiplier, pct_balance,
						per_trade_cap_sol, min_order_sol, daily_budget_sol, max_open_copies,
						min_oracle_score, mcap_floor_usd, mcap_ceiling_usd, telegram_chat_id,
						perf_fee_bps, status
					) values (
						${auth.userId}, ${leaderId}, ${leaderWallet}, ${network}, ${wallet},
						${cfg.sizing_rule}, ${cfg.fixed_sol}, ${cfg.multiplier}, ${cfg.pct_balance},
						${cfg.per_trade_cap_sol}, ${cfg.min_order_sol}, ${cfg.daily_budget_sol}, ${cfg.max_open_copies},
						${cfg.min_oracle_score}, ${cfg.mcap_floor_usd}, ${cfg.mcap_ceiling_usd}, ${cfg.telegramChatId ?? null},
						${cfg.perf_fee_bps}, 'active'
					)
					on conflict (copier_user_id, leader_agent_id, network) do update set
						copier_wallet     = excluded.copier_wallet,
						leader_wallet     = coalesce(excluded.leader_wallet, copy_subscriptions.leader_wallet),
						sizing_rule       = excluded.sizing_rule,
						fixed_sol         = excluded.fixed_sol,
						multiplier        = excluded.multiplier,
						pct_balance       = excluded.pct_balance,
						per_trade_cap_sol = excluded.per_trade_cap_sol,
						min_order_sol     = excluded.min_order_sol,
						daily_budget_sol  = excluded.daily_budget_sol,
						max_open_copies   = excluded.max_open_copies,
						min_oracle_score  = excluded.min_oracle_score,
						mcap_floor_usd    = excluded.mcap_floor_usd,
						mcap_ceiling_usd  = excluded.mcap_ceiling_usd,
						telegram_chat_id  = excluded.telegram_chat_id,
						perf_fee_bps      = excluded.perf_fee_bps,
						status            = 'active',
						updated_at        = now()
					returning id, status, created_at, updated_at, (xmax = 0) as inserted
				`;
			} catch (err) {
				return unavailable(err, 'Copy-trading setup');
			}

			if (!sub) return mcpErr('Failed to save the copy subscription. Try again.');

			const isNew = sub.inserted !== false;
			const sizeLabel = cfg.sizing_rule === 'fixed'
				? `${cfg.fixed_sol} SOL fixed`
				: cfg.sizing_rule === 'multiplier'
				? `${cfg.multiplier}× leader size`
				: `${cfg.pct_balance}% of balance`;

			const payload = {
				success: true,
				action:        isNew ? 'created' : 'updated',
				subscription_id: sub.id,
				leader_agent_id: leaderId,
				leader_name:     leader.name,
				copier_wallet:   wallet,
				network,
				config: {
					sizing:         sizeLabel,
					per_trade_cap:  `${cfg.per_trade_cap_sol} SOL`,
					daily_budget:   `${cfg.daily_budget_sol} SOL`,
					max_open:       cfg.max_open_copies,
					min_oracle_score: cfg.min_oracle_score ?? null,
					perf_fee_bps:   cfg.perf_fee_bps,
				},
				message: `Copy subscription ${isNew ? 'created' : 'updated'}. The fan-out cron will detect ${leader.name}'s next entry and generate a sized intent for your wallet. Review intents at https://three.ws/dashboard/copy`,
				links: {
					dashboard:    'https://three.ws/dashboard/copy',
					leader_profile: `https://three.ws/trader/${leaderId}`,
					leaderboard:  'https://three.ws/leaderboard',
				},
			};
			return mcpOk(payload);
		},
	},

	// ── copy_status ─────────────────────────────────────────────────────────
	{
		name: 'copy_status',
		title: 'My copy subscriptions',
		scope: 'agents:read',
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		description:
			"List all your active copy-trading subscriptions, with sizing config, execution counts (pending/acted), and the leader's name and profile. Use this to check that copy-trading is set up correctly and to see which subscriptions are generating intents.",
		inputSchema: {
			type: 'object',
			properties: {
				network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			},
			additionalProperties: false,
		},
		async handler(args, auth) {
			if (!auth.userId) return mcpErr('Sign in to view your copy subscriptions.');

			const rl = await limits.mcpIp(auth.rateKey || 'anon');
			if (!rl.success) return mcpErr('Rate limit exceeded, try again in a moment.');

			const network = NETWORKS.has(args?.network) ? args.network : 'mainnet';

			let rows;
			try {
				rows = await sql`
					select s.id, s.leader_agent_id, s.status, s.network,
					       s.copier_wallet, s.sizing_rule, s.fixed_sol, s.multiplier, s.pct_balance,
					       s.per_trade_cap_sol, s.daily_budget_sol, s.max_open_copies,
					       s.min_oracle_score, s.perf_fee_bps, s.created_at, s.updated_at,
					       a.name as leader_name, a.profile_image_url as leader_image,
					       (select count(*) from copy_executions e
					         where e.subscription_id = s.id and e.status = 'pending') as pending_count,
					       (select count(*) from copy_executions e
					         where e.subscription_id = s.id and e.status = 'acted') as acted_count
					from copy_subscriptions s
					join agent_identities a on a.id = s.leader_agent_id
					where s.copier_user_id = ${auth.userId} and s.network = ${network}
					  and s.status not in ('stopped')
					order by s.created_at desc
				`;
			} catch (err) {
				return unavailable(err, 'Your copy subscriptions list');
			}

			const subs = rows.map((s) => ({
				id:              s.id,
				leader_agent_id: s.leader_agent_id,
				leader_name:     s.leader_name,
				leader_image:    s.leader_image || null,
				status:          s.status,
				network:         s.network,
				copier_wallet:   s.copier_wallet,
				sizing_rule:     s.sizing_rule,
				fixed_sol:       s.fixed_sol ? Number(s.fixed_sol) : null,
				multiplier:      s.multiplier ? Number(s.multiplier) : null,
				pct_balance:     s.pct_balance ? Number(s.pct_balance) : null,
				per_trade_cap_sol: Number(s.per_trade_cap_sol),
				daily_budget_sol:  Number(s.daily_budget_sol),
				max_open_copies:   Number(s.max_open_copies),
				min_oracle_score:  s.min_oracle_score ? Number(s.min_oracle_score) : null,
				perf_fee_bps:      Number(s.perf_fee_bps),
				pending_intents:   Number(s.pending_count),
				acted_intents:     Number(s.acted_count),
				created_at:        s.created_at,
				profile_url:       `https://three.ws/trader/${s.leader_agent_id}`,
			}));

			// The query keeps paused rows (only 'stopped' is filtered out), so counting
			// them all as active misreported a paused subscription as live.
			const activeCount  = subs.filter((s) => s.status === 'active').length;
			const pausedCount  = subs.length - activeCount;
			const pendingTotal = subs.reduce((n, s) => n + s.pending_intents, 0);

			const payload = {
				user_id:     auth.userId,
				network,
				count:       subs.length,
				active_count: activeCount,
				paused_count: pausedCount,
				subscriptions: subs,
				pending_total: pendingTotal,
				acted_total:   subs.reduce((n, s) => n + s.acted_intents, 0),
				hint: subs.length === 0
					? 'No copy subscriptions yet. Use trader_leaderboard to find top performers, then copy_subscribe to mirror them.'
					: `${activeCount} active subscription${activeCount !== 1 ? 's' : ''}${pausedCount ? ` (plus ${pausedCount} paused)` : ''}. ${pendingTotal} intent${pendingTotal !== 1 ? 's' : ''} waiting to be acted on.`,
				links: {
					dashboard:   'https://three.ws/dashboard/copy',
					leaderboard: 'https://three.ws/leaderboard',
				},
				generated_at: new Date().toISOString(),
			};
			return mcpOk(payload);
		},
	},
];
