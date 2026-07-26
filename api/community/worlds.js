// GET /api/community/worlds
// The lobby of live coin-worlds. Each TopCommunity becomes an enterable 3D
// world on /temporary?coin=<token>. Real data — most active communities first.
//
// Failover: when CoinCommunities is unconfigured (no CC_API_KEY) or its
// upstream errors, the lobby falls back to the live pump.fun trending feed
// (Birdeye → pump.fun frontend, same chain as every world). Entering a world
// never needed CoinCommunities (only Town chat does, and Town has its own
// designed locked state), so the picker stays alive on real market data.
// Fallback cards carry `social: false` (no members/posts/likes to show) and
// the response is tagged with its `source` so clients can render accordingly.
import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { cc, toWorldCard, UnconfiguredError } from '../_lib/coin-communities.js';
import { getTrendingSlim } from '../_lib/pump-trending.js';

const TRENDING_WORLDS = 24;

async function trendingWorlds() {
	const { data } = await getTrendingSlim(TRENDING_WORLDS);
	if (!data) return null;
	return data.map((t) => ({
		token: t.mint,
		symbol: t.symbol || null,
		name: t.name || null,
		image: t.logo || null,
		chainId: null,
		members: 0,
		posts: 0,
		likes: 0,
		latestPostAt: null,
		social: false,
	}));
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let api = null;
	try {
		api = cc();
	} catch (err) {
		if (!(err instanceof UnconfiguredError)) throw err;
	}

	if (api) {
		const { data, error: apiErr } = await api.getTopCommunities();
		if (!apiErr) {
			const worlds = (data?.communities ?? []).map(toWorldCard);
			// Short cache so the lobby feels live without hammering upstream.
			res.setHeader('cache-control', 'public, max-age=20, s-maxage=20, stale-while-revalidate=60');
			return json(res, 200, { data: { worlds, source: 'coincommunities' } });
		}
	}

	const worlds = await trendingWorlds();
	if (worlds) {
		res.setHeader('cache-control', 'public, max-age=20, s-maxage=20, stale-while-revalidate=60');
		return json(res, 200, { data: { worlds, source: 'pump-trending' } });
	}

	// Both CoinCommunities and the trending failover are unavailable: keep the
	// original per-cause envelope so clients show the right designed state.
	if (!api) {
		return error(res, 503, 'cc_unconfigured', 'CoinCommunities is not configured');
	}
	return error(res, 502, 'upstream_error', 'failed to load worlds');
});
