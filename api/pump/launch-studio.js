// GET /api/pump/launch-studio?action=list[&category=&mode=]
// GET /api/pump/launch-studio?action=preview&id=<useCaseId>[&limit=&network=]
// ------------------------------------------------------------------------------
// Read API for the Launch Studio — the catalog of coin-launch use cases and a
// LIVE preview of what each would mint right now. Public + rate-limited:
//   list    → every use case as a summary (id, title, category, mode, tags).
//   preview → runs the use case against live data (GitHub trending / narrative
//             engine) and returns a concrete launch plan: coin identities + the
//             reward-routing INTENT for each candidate.
//
// Reward resolution here is INTENT-ONLY (engine resolveRewards defaults to false)
// so the public endpoint never touches the DB or reveals whether a GitHub user
// has a linked wallet. The concrete address is resolved on the authed launch path
// (resolve-github-shareholder / fee-sharing-agent) when a user actually mints.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { listUseCases, getUseCase, categories, USE_CASE_COUNT } from '../_lib/launch/registry.js';
import { planLaunch } from '../_lib/launch/usecase-engine.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host}`);
	const action = url.searchParams.get('action') || 'list';

	if (action === 'list') {
		const category = url.searchParams.get('category') || undefined;
		const mode = url.searchParams.get('mode') || undefined;
		return json(res, 200, {
			count: USE_CASE_COUNT,
			categories: categories(),
			use_cases: listUseCases({ category, mode }),
		}, { 'cache-control': 'public, max-age=60, s-maxage=300' });
	}

	if (action === 'preview') {
		const id = url.searchParams.get('id');
		const uc = id ? getUseCase(id) : null;
		if (!uc) return error(res, 404, 'not_found', 'unknown use case id');
		const limit = Math.max(1, Math.min(12, parseInt(url.searchParams.get('limit') || '6', 10) || 6));
		const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
		const plan = await planLaunch(uc, { limit, network });
		return json(res, 200, plan, { 'cache-control': 'public, max-age=30, s-maxage=120' });
	}

	return error(res, 400, 'bad_request', "unknown action — use 'list' or 'preview'");
});
