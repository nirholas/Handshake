// GET /api/defi/protocols
// ---------------------------------------------------------------------------
// Top DeFi protocols by TVL for the /defi page. Fetches DeFiLlama's keyless
// /protocols feed (no API key), normalizes each entry to the fields the page
// renders, and returns the top 100 by TVL plus whole-market totals. Cached
// 5 min in-memory + CDN. DeFiLlama is the data source. See the page's
// attribution line.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { createCache, cached } from '../_lib/mem-cache.js';
import { fetchUpstream } from '../_lib/upstream-fetch.js';
import { normalizeLlamaLogo } from '../_lib/llama-icon.js';

const UPSTREAM = 'https://api.llama.fi/protocols';
const TTL_MS = 300_000;

// Single-entry cache with single-flight de-dup. This feed is ~8 MB; without
// de-dup every concurrent request arriving on a cold or just-expired entry
// fired its own copy of it, so one page load by N visitors cost N full
// downloads and could tip the upstream into refusing the burst.
const _cache = createCache({ max: 1, ttlMs: TTL_MS });
const CACHE_KEY = 'protocols';

const finite = (n) => (Number.isFinite(n) ? n : null);

// Exported for the paid Market Data API (api/_lib/market-data/), the x402
// market-defi endpoint sells the same TVL leaderboard this page renders.
export async function buildProtocols() {
	return cached(_cache, CACHE_KEY, loadProtocols);
}

async function loadProtocols() {
	const now = Date.now();

	const resp = await fetchUpstream(UPSTREAM, {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
	}, { timeoutMs: 10_000, attempts: 2 });
	const raw = await resp.json();
	if (!Array.isArray(raw)) throw new Error('unexpected upstream shape');

	// Whole-market totals span every protocol with a positive TVL, not just the
	// top 100 we return for the table.
	let totalTvl = 0;
	let protocolCount = 0;
	const eligible = [];
	for (const p of raw) {
		const tvl = Number(p?.tvl);
		if (!Number.isFinite(tvl) || tvl <= 0) continue;
		// DeFiLlama's /protocols feed mixes centralized-exchange reserves
		// (category "CEX") in with real DeFi protocols; a DeFi TVL page must
		// exclude them or Binance/OKX dwarf every actual protocol.
		if (typeof p.category === 'string' && p.category.toUpperCase() === 'CEX') continue;
		totalTvl += tvl;
		protocolCount += 1;
		eligible.push(p);
	}

	eligible.sort((a, b) => Number(b.tvl) - Number(a.tvl));

	const protocols = eligible.slice(0, 100).map((p) => {
		const chains = Array.isArray(p.chains) ? p.chains.filter((c) => typeof c === 'string') : [];
		return {
			// DeFiLlama protocol slug. The /protocol/:slug detail page keys off it.
			slug: typeof p.slug === 'string' ? p.slug : null,
			name: typeof p.name === 'string' ? p.name : 'Unknown',
			logo: normalizeLlamaLogo(p.logo),
			symbol: typeof p.symbol === 'string' && p.symbol !== '-' ? p.symbol : null,
			category: typeof p.category === 'string' ? p.category : null,
			chains,
			chain_count: chains.length,
			tvl: Number(p.tvl),
			change_1d: finite(Number(p.change_1d)),
			change_7d: finite(Number(p.change_7d)),
			mcap: finite(Number(p.mcap)),
		};
	});

	return {
		total_tvl: totalTvl,
		protocol_count: protocolCount,
		protocols,
		updated_at: now,
	};
}

// `cached()` serves its last-good copy (without re-populating the fresh slot)
// when the loader throws, so a fresh miss after a resolved value means the
// payload is stale. Label it so the page can say so instead of passing it off
// as live.
function staleHeaders() {
	return _cache.has(CACHE_KEY) ? {} : { 'x-three-stale': '1' };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	try {
		const payload = await buildProtocols();
		return json(res, 200, payload, {
			'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=600',
			...staleHeaders(),
		});
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'DeFi protocol data is unavailable right now. Retry shortly',
		);
	}
});
