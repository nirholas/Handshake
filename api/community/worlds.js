// GET /api/community/worlds
// The lobby of live coin-worlds. Each TopCommunity becomes an enterable 3D
// world on /walk?coin=<token>. Real data — most active communities first.
import { cors, error, json, method, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { cc, toWorldCard, UnconfiguredError } from '../_lib/coin-communities.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	let api;
	try {
		api = cc();
	} catch (err) {
		if (err instanceof UnconfiguredError) {
			return error(res, 503, 'cc_unconfigured', 'CoinCommunities is not configured');
		}
		throw err;
	}

	const { data, error: apiErr } = await api.getTopCommunities();
	if (apiErr) {
		return error(res, 502, 'upstream_error', apiErr.message || 'failed to load worlds');
	}

	const worlds = (data?.communities ?? []).map(toWorldCard);
	// Short cache so the lobby feels live without hammering upstream.
	res.setHeader('cache-control', 'public, max-age=20, s-maxage=20, stale-while-revalidate=60');
	return json(res, 200, { data: { worlds } });
});
