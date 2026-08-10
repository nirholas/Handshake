// GET /api/coin/pool?address=<token-address>&network=<geckoterminal-network>
// ---------------------------------------------------------------------------
// Resolves the most-liquid on-chain pool for a token on a GeckoTerminal-indexed
// network, so the /coin/:id page can mount the GeckoTerminal chart embed (which
// is keyed by pool address, not by token). Thin wrapper over the shared keyless
// topPoolForToken() helper — real data, cached, never fabricated. Response is
// cached 60s in-process + 5min at the CDN so repeat views and the CDN shield the
// upstream free-tier rate limit.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { topPoolForToken } from '../_lib/market/ohlcv.js';

// The GeckoTerminal network ids the /coin page's CHAIN_MAP can emit. Solana is
// the home chain; the rest are the majors both DEX terminals index.
const NETWORKS = new Set(['solana', 'eth', 'base', 'bsc', 'polygon_pos', 'arbitrum', 'optimism', 'avax']);

const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const address = (params.get('address') || '').trim();
	const network = (params.get('network') || 'solana').trim();

	if (!NETWORKS.has(network)) {
		return error(res, 400, 'bad_network', 'network must be a supported GeckoTerminal network id');
	}
	// Reject at the boundary so a malformed address never reaches upstream.
	const wellFormed = network === 'solana' ? SOL_RE.test(address) : EVM_RE.test(address);
	if (!wellFormed) {
		return error(res, 400, 'bad_address', 'address is not a valid token address for the network');
	}

	try {
		const pool = await topPoolForToken(address, network);
		return json(
			res,
			200,
			{ network, address, pool },
			{ 'cache-control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' },
		);
	} catch (err) {
		// A coin with no indexed pool is a normal outcome (404), not an error;
		// throttles and outages surface their true status so the client can
		// fall back to the "open on GeckoTerminal" link without a false chart.
		// Optional-chained: a rejection that is not an object (or an AbortError,
		// which carries no `status`) would otherwise throw a TypeError inside this
		// catch and turn a routine upstream timeout into an unhandled 500.
		if (err?.status === 404) return error(res, 404, 'no_pool', 'no on-chain pool found for this token');
		if (err?.status === 429) return error(res, 429, 'rate_limited', 'pool source is throttled, retry shortly');
		return error(res, 502, 'upstream_error', 'pool source is temporarily unavailable');
	}
});
