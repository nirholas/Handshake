// Trader Wrapped API: the shareable season recap for a trading agent.
// ---------------------------------------------------------------------------
//   GET /api/pump/wrapped?window=30d[&network=mainnet][&limit=24]
//       The picker: public agents with enough settled round-trips in the window
//       to have a recap worth cutting, ranked by activity.
//
//   GET /api/pump/wrapped?agent=<agent_id>[&window=7d|30d|all][&network=]
//       The deck: an ordered list of slides (scoreboard, best trade, worst trade,
//       the coin that carried the season, rhythm, peer rank + nearest rival, and
//       the receipt), every number traced to closed on-chain round-trips.
//
// Public and cacheable. It reads settled history only: no account, no wallet, no
// signature, and nothing here spends, signs, or takes custody.
//
// The coins named in a response are whatever the agent actually traded (runtime
// data). $THREE remains the only coin this platform promotes.

import { cors, json, error, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';
import { WRAPPED_WINDOWS, WRAPPED_WINDOW_CHOICES, fetchWrappableTraders, getWrapped } from '../_lib/wrapped.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

export const maxDuration = 30;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const q = url.searchParams;

	const networkParam = q.get('network');
	if (networkParam && !NETWORKS.has(networkParam)) {
		return error(res, 400, 'invalid_network', 'network must be mainnet or devnet.');
	}
	const network = NETWORKS.has(networkParam) ? networkParam : 'mainnet';

	const windowParam = q.get('window');
	if (windowParam && !WRAPPED_WINDOWS.has(windowParam)) {
		return error(res, 400, 'invalid_window', `window must be one of ${[...WRAPPED_WINDOWS].join(', ')}.`);
	}
	const window = windowParam || '30d';

	// --- Picker -------------------------------------------------------------
	const agentId = (q.get('agent') || q.get('agent_id') || '').trim();
	if (!agentId) {
		const limitParam = parseInt(q.get('limit') || '24', 10);
		const limit = Math.min(100, Math.max(1, Number.isFinite(limitParam) ? limitParam : 24));
		const traders = await fetchWrappableTraders(network, { window, limit });
		res.setHeader?.('cache-control', 'public, max-age=120, s-maxage=300');
		return json(res, 200, {
			network,
			window,
			windows: WRAPPED_WINDOW_CHOICES,
			traders,
			custody: 'none',
		});
	}

	if (!isUuid(agentId)) {
		return error(res, 400, 'invalid_agent', 'agent must be an agent UUID. Call this endpoint without an agent to list traders with a recap.');
	}

	// --- Deck ---------------------------------------------------------------
	const deck = await getWrapped({ agentId, network, window });
	if (!deck) {
		return error(res, 404, 'agent_not_found', 'No public trading agent with that id.');
	}

	res.setHeader?.('cache-control', 'public, max-age=120, s-maxage=300, stale-while-revalidate=600');
	return json(res, 200, { custody: 'none', ...deck });
});
