// `create_subscription` — follow a leader (or re-tune an existing follow).
// Write, idempotent: the API upserts on (account, leader, network), so calling
// it again with the same leader updates that subscription instead of duplicating
// it and (re)sets its status to active.
//
// Wraps POST /api/copy/subscriptions (the create/update path).
//
// MONEY-ADJACENT: this defines how much of the copier's OWN SOL each mirrored
// trade may spend. It is non-custodial — three.ws never signs or holds funds; it
// only emits sized, guard-checked copy INTENTS the copier acts on. Sizing is
// always clamped to per_trade_cap_sol and the remaining daily_budget_sol, so a
// runaway leader can never drain the copier.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';
import { shapeSubscription } from '../lib/shapes.js';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const def = {
	name: 'create_subscription',
	title: 'Follow a leader (create / update subscription)',
	annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
	description:
		'Follow a copy-trade leader from the authenticated account, defining how their trades are mirrored into your own wallet. MONEY-ADJACENT: this sets how much of YOUR SOL each copy may spend. Non-custodial — three.ws never signs or holds funds; it emits sized, guard-checked copy INTENTS you act on. Idempotent: re-calling with the same leader_agent_id + network updates that subscription (and re-activates it) rather than creating a duplicate. Sizing rule: "fixed" spends fixed_sol per copy; "multiplier" spends multiplier × the leader\'s entry; "pct_balance" spends pct_balance % of your spendable SOL. Every order is clamped to per_trade_cap_sol and the remaining daily_budget_sol. Returns the created/updated subscription. Requires THREE_WS_API_KEY.',
	inputSchema: {
		leader_agent_id: z.string().uuid().describe('UUID of the public leader (agent with a sniper track record) to follow.'),
		copier_wallet: z
			.string()
			.regex(BASE58_RE, 'must be a base58 Solana address')
			.describe('Your own Solana wallet address that will execute the mirrored trades. Never a private key — non-custodial.'),
		network: z.enum(['mainnet', 'devnet']).default('mainnet').describe('Solana network (default mainnet).'),
		sizing_rule: z
			.enum(['fixed', 'multiplier', 'pct_balance'])
			.default('fixed')
			.describe('How each copy is sized: fixed | multiplier (× leader entry) | pct_balance (% of your SOL). Default fixed.'),
		fixed_sol: z.number().positive().optional().describe('SOL spent per copy when sizing_rule="fixed". Required for fixed sizing.'),
		multiplier: z.number().positive().default(0.1).describe('Fraction of the leader\'s entry size to copy when sizing_rule="multiplier" (default 0.1).'),
		pct_balance: z.number().gt(0).max(100).optional().describe('Percent of your spendable SOL per copy when sizing_rule="pct_balance" (0–100).'),
		per_trade_cap_sol: z.number().positive().default(0.5).describe('Hard ceiling on any single copy, in SOL (default 0.5). Must be > 0.'),
		min_order_sol: z.number().min(0).default(0.02).describe('Skip dust copies sized below this, in SOL (default 0.02). Cannot exceed per_trade_cap_sol.'),
		daily_budget_sol: z.number().positive().default(1).describe('Max SOL fanned out across copies per UTC day (default 1). Must be > 0.'),
		max_open_copies: z.number().int().min(1).max(100).default(5).describe('Cap on concurrent pending copy intents (1–100, default 5).'),
		mcap_floor_usd: z.number().nonnegative().nullable().optional().describe('Skip coins below this market cap (USD). Omit/null to ignore.'),
		mcap_ceiling_usd: z.number().nonnegative().nullable().optional().describe('Skip coins above this market cap (USD). Omit/null to ignore.'),
		copy_sells: z.boolean().default(true).describe('Mirror the leader\'s exits, not just entries (default true).'),
		require_safety_pass: z.boolean().default(false).describe('Skip a copy when the coin\'s safety context cannot be confirmed (default false).'),
		min_oracle_score: z.number().int().min(0).max(100).nullable().optional().describe('Skip coins whose Oracle conviction score is below this (0–100). Omit/null to ignore.'),
		perf_fee_bps: z.number().int().min(0).max(3000).default(1000).describe('Leader\'s performance fee on your realized copy profit, in basis points (0–3000, default 1000 = 10%). Charged above a high-water mark, settled in $THREE.'),
		telegram_chat_id: z.string().regex(/^-?[0-9]+$/, 'must be a numeric Telegram chat ID').nullable().optional().describe('Optional Telegram chat ID to receive copy-intent alerts for this subscription.'),
	},
	async handler(args) {
		// Cross-field rule zod's flat shape cannot express: fixed sizing needs its
		// amount. Fail here with the recovery in the message instead of a 400 round trip.
		if ((args.sizing_rule ?? 'fixed') === 'fixed' && !(Number(args.fixed_sol) > 0)) {
			throw Object.assign(new Error('sizing_rule "fixed" requires fixed_sol > 0 (SOL spent per copy).'), {
				code: 'validation_error',
			});
		}
		const data = await apiRequest('/api/copy/subscriptions', {
			method: 'POST',
			body: {
				leader_agent_id: args.leader_agent_id,
				copier_wallet: args.copier_wallet,
				network: args.network,
				sizing_rule: args.sizing_rule,
				fixed_sol: args.fixed_sol,
				multiplier: args.multiplier,
				pct_balance: args.pct_balance,
				per_trade_cap_sol: args.per_trade_cap_sol,
				min_order_sol: args.min_order_sol,
				daily_budget_sol: args.daily_budget_sol,
				max_open_copies: args.max_open_copies,
				mcap_floor_usd: args.mcap_floor_usd,
				mcap_ceiling_usd: args.mcap_ceiling_usd,
				copy_sells: args.copy_sells,
				require_safety_pass: args.require_safety_pass,
				min_oracle_score: args.min_oracle_score,
				perf_fee_bps: args.perf_fee_bps,
				telegram_chat_id: args.telegram_chat_id,
			},
		});
		return { ok: true, subscription: shapeSubscription(data?.subscription) };
	},
};
