// Ghost-copy API: paper-copy a verified pump.fun leader over their real trades.
// ---------------------------------------------------------------------------
//   GET /api/pump/ghost-copy?window=7d[&network=mainnet][&limit=24]
//       The ghost-able leader universe: public agents with at least one closed
//       on-chain round-trip in the window, ranked by realized P&L. This is the
//       picker; no leader param means "who could I ghost-copy?".
//
//   GET /api/pump/ghost-copy?leader=<agent_id>&budget=1[&window=7d]
//                           [&sizing=fixed|multiplier][&fixed_sol=][&multiplier=]
//                           [&per_trade_cap_sol=][&min_order_sol=]
//                           [&daily_budget_sol=][&max_open_copies=][&network=]
//       The replay: what a hypothetical `budget` SOL wallet would have done if it
//       had copied this leader across the window, sized by the SAME copy-engine
//       the live fanout cron uses. Returns the equity curve, every ghost fill,
//       every skip with its reason, and an honesty block.
//
// Public and cacheable: it reads only settled on-chain history, needs no account,
// no wallet, and no signature. Nothing here spends, signs, or takes custody.
//
// The coins named in a response are whatever the leader traded (runtime data).
// $THREE remains the only coin this platform promotes.

import { cors, json, error, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { GHOST_WINDOWS, fetchGhostableLeaders, runGhostCopy } from '../_lib/ghost-copy.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BUDGET_SOL = 10_000;

export const maxDuration = 30;

const numParam = (v) => {
	if (v == null || v === '') return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const q = url.searchParams;
	const network = NETWORKS.has(q.get('network')) ? q.get('network') : 'mainnet';
	const window = GHOST_WINDOWS.has(q.get('window')) ? q.get('window') : '7d';

	// --- Picker: the ghost-able leader universe -----------------------------
	const leaderId = (q.get('leader') || '').trim();
	if (!leaderId) {
		const limit = Math.min(100, Math.max(1, parseInt(q.get('limit') || '24', 10) || 24));
		const leaders = await fetchGhostableLeaders(network, { window, limit });
		res.setHeader?.('cache-control', 'public, max-age=60, s-maxage=120');
		return json(res, 200, {
			network,
			window,
			windows: [...GHOST_WINDOWS],
			leaders,
			custody: 'none',
		});
	}

	if (!UUID_RE.test(leaderId)) {
		return error(res, 400, 'invalid_leader', 'leader must be an agent UUID. Call this endpoint without a leader to list ghost-able agents.');
	}

	// --- Replay -------------------------------------------------------------
	const budget = Number(q.get('budget') || '1');
	if (!Number.isFinite(budget) || budget <= 0) {
		return error(res, 400, 'invalid_budget', 'budget must be a positive number of SOL.');
	}
	if (budget > MAX_BUDGET_SOL) {
		return error(res, 400, 'budget_too_large', `budget must be ${MAX_BUDGET_SOL} SOL or less.`);
	}

	const overrides = {
		sizing_rule: q.get('sizing') || undefined,
		fixed_sol: numParam(q.get('fixed_sol')),
		multiplier: numParam(q.get('multiplier')),
		per_trade_cap_sol: numParam(q.get('per_trade_cap_sol')),
		min_order_sol: numParam(q.get('min_order_sol')),
		daily_budget_sol: numParam(q.get('daily_budget_sol')),
		max_open_copies: numParam(q.get('max_open_copies')),
	};

	const result = await runGhostCopy({ agentId: leaderId, network, window, budgetSol: budget, overrides });
	if (result === null) {
		return error(res, 404, 'leader_not_found', 'No public trading agent with that id.');
	}
	if (result.error) {
		return error(res, 400, 'invalid_sizing', result.error);
	}

	res.setHeader?.('cache-control', 'public, max-age=30, s-maxage=60');
	return json(res, 200, { custody: 'none', paper: true, ...result });
});
