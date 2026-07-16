// Meta-Allocator API, the "ETF of degens" allocation planner.
// ---------------------------------------------------------------------------
//   GET  /api/meta-allocator?network=mainnet[&risk=balanced][&budget=5][&limit=200]
//        The verified leader universe + a ready-to-read default allocation plan
//        for the requested (or balanced) risk profile. Public, cached.
//
//   POST /api/meta-allocator   { budget_quote, risk_profile,
//                                current_allocations?, network? }
//        A tailored allocation plan for a specific budget/profile. Public, this
//        is planning only, fully non-custodial: it returns weights + suggested
//        sizes + a rebalance rule, never a transaction. Executing the plan is the
//        existing per-leader copy-subscribe flow, one confirmed action at a time.
//
// Every leader stat traces to a real closed on-chain round-trip. $THREE is the
// only coin the platform promotes; the leaders' traded coins are user runtime
// data, never endorsements.

import { cors, json, error, method, wrap, readJson, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { getSessionUser } from './_lib/auth.js';
import { gatherLeaders, buildAllocationPlan, RISK_PROFILES } from './_lib/meta-allocator.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

export const maxDuration = 30;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const network = NETWORKS.has(url.searchParams.get('network')) ? url.searchParams.get('network') : 'mainnet';

	// Signed-in users get their allocation LLM spend tracked against their cap;
	// anonymous callers fall through to the free lane / deterministic plan.
	let userId = null;
	try { userId = (await getSessionUser(req))?.id ?? null; } catch { userId = null; }

	if (req.method === 'POST') {
		let body;
		try { body = await readJson(req); } catch { return error(res, 400, 'invalid_json', 'Body must be JSON.'); }
		const budgetQuote = Number(body?.budget_quote);
		if (!Number.isFinite(budgetQuote) || budgetQuote <= 0) {
			return error(res, 400, 'invalid_budget', 'budget_quote must be a positive number (SOL).');
		}
		const riskProfile = RISK_PROFILES.has(body?.risk_profile) ? body.risk_profile : 'balanced';
		const currentAllocations = Array.isArray(body?.current_allocations) ? body.current_allocations : [];

		const leaders = await gatherLeaders(network, { limit: 200 });
		const plan = await buildAllocationPlan({
			budgetQuote, riskProfile, leaders, currentAllocations, network, userId,
		});
		res.setHeader?.('cache-control', 'no-store');
		return json(res, 200, { network, ...plan });
	}

	// GET, universe + a default plan for the requested profile.
	const riskProfile = RISK_PROFILES.has(url.searchParams.get('risk')) ? url.searchParams.get('risk') : 'balanced';
	const rawBudget = Number(url.searchParams.get('budget'));
	const budgetQuote = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : 5; // 5 SOL demo default
	const limit = Math.min(200, Math.max(10, parseInt(url.searchParams.get('limit') || '50', 10) || 50));

	const leaders = await gatherLeaders(network, { limit });
	const plan = await buildAllocationPlan({ budgetQuote, riskProfile, leaders, network, userId });

	res.setHeader?.('cache-control', 'public, max-age=30, s-maxage=60');
	return json(res, 200, {
		network,
		risk_profiles: [...RISK_PROFILES],
		leader_universe: leaders,
		plan,
	});
});
