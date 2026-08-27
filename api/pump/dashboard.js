import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { json, error, wrap } from '../_lib/http.js';
import { fetchTokenMarketData } from '../_lib/market/token-market.js';
import { withBreaker } from '../_lib/resilience.js';

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Process-local Birdeye response cache. Keeps the function instance from
// hammering Birdeye when many tabs poll the same mint within a few seconds.
// Vercel functions warm-start across requests, so this is meaningful even
// without Redis. Cross-instance dedup would still need an external cache.
const _birdeyeCache = new Map();

async function fetchWithCache(url, options, ttlMs = 60_000) {
	const key = url;
	const now = Date.now();
	const hit = _birdeyeCache.get(key);
	if (hit && hit.expires > now) return hit.value;

	const resp = await fetch(url, { ...options, signal: options?.signal ?? AbortSignal.timeout(8000) });
	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`API error (${resp.status}): ${text.slice(0, 200)}`);
	}
	const value = await resp.json();
	// Only cache successful non-null responses so an empty/error body from
	// Birdeye doesn't poison the cache for 60s.
	if (value?.data != null) {
		_birdeyeCache.set(key, { value, expires: now + ttlMs });
		if (_birdeyeCache.size > 256) {
			const oldest = _birdeyeCache.keys().next().value;
			_birdeyeCache.delete(oldest);
		}
	}
	return value;
}

export default wrap(async (req, res) => {
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'authentication required');

	const agentId = new URL(req.url, 'http://x').searchParams.get('agent_id');
	if (!agentId) return error(res, 400, 'missing_agent_id', 'agent_id is required');
	// agent_id lands in a uuid-typed column. Without this guard Postgres raises
	// "invalid input syntax for type uuid" and the caller gets a 500 for what is
	// plainly their own typo.
	if (!UUID_RE.test(agentId))
		return error(res, 400, 'invalid_agent_id', 'agent_id must be a UUID');

	const [agent] = await sql`
		SELECT meta FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${user.id} AND deleted_at IS NULL
	`;

	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const tokenMint = agent.meta?.token?.mint;
	if (!tokenMint)
		return error(res, 404, 'token_not_launched', 'token not launched for this agent');

	const headers = BIRDEYE_API_KEY ? { 'X-API-KEY': BIRDEYE_API_KEY } : null;

	// The two halves fail independently now. Price comes from the shared market
	// chain (Birdeye, then tokens.xyz, DexScreener and GeckoTerminal, with its own
	// stale tier), so it survives a Birdeye outage and works with no Birdeye key
	// at all, which is why the hard 503 above is gone. The recent-trades list has
	// no second source, so it degrades to an empty list behind a breaker and says
	// so, instead of taking the whole dashboard down with it: a price with no
	// trade feed is most of the page, a 502 is none of it.
	const [priceResult, historyResult] = await Promise.allSettled([
		fetchTokenMarketData(tokenMint),
		headers
			? withBreaker(
					'birdeye:txs',
					() => fetchWithCache(`https://public-api.birdeye.so/defi/txs/latest?address=${tokenMint}`, { headers }),
					{ fallback: null },
				)
			: Promise.resolve(null),
	]);

	const market = priceResult.status === 'fulfilled' ? priceResult.value : null;
	const history = historyResult.status === 'fulfilled' ? historyResult.value : null;
	const degraded = [];
	if (!market?.price_usd) degraded.push('price');
	if (!history) degraded.push('history');

	if (!market?.price_usd && !history) {
		console.error(`[pump-dashboard] no market source answered for ${tokenMint}`);
		res.setHeader('retry-after', '15');
		return error(res, 503, 'market_unavailable', 'on-chain market data is temporarily unavailable, retry shortly');
	}

	return json(res, 200, {
		price: market?.price_usd == null
			? null
			: {
					value: market.price_usd,
					// No `updateUnixTime` here. Birdeye's field means "when this price
					// was observed", and the market chain can answer from a cached
					// reading up to half an hour old, so stamping the response time
					// would assert a freshness we cannot vouch for. `source` says which
					// provider answered, which is a claim we can actually stand behind.
					priceChange24h: market.price_change_24h,
					// The dashboard has always rendered a market cap slot; Birdeye's
					// price endpoint does not carry one, so it read "N/A" for every
					// token. The market chain does carry it, so the slot finally means
					// something.
					marketCap: market.market_cap,
					liquidity: market.liquidity,
					source: market.source,
				},
		history: history?.data?.items ?? [],
		degraded: degraded.length ? degraded : null,
	});
});
