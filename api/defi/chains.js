// GET /api/defi/chains
// ---------------------------------------------------------------------------
// Cross-chain TVL leaderboard for the /chains page. Fetches DeFiLlama's keyless
// /v2/chains feed (no API key), normalizes each chain to name + TVL + native
// token, computes each chain's share of total TVL, and returns the top 100 by
// TVL plus the whole-market total. Cached 5 min in-memory + CDN. DeFiLlama is
// the data source. See the page's attribution line.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { createCache, cached } from '../_lib/mem-cache.js';

const UPSTREAM = 'https://api.llama.fi/v2/chains';
const TTL_MS = 300_000;

// Single-entry cache with single-flight de-dup, so a burst of concurrent
// requests on a cold or just-expired entry shares one upstream fetch.
const _cache = createCache({ max: 1, ttlMs: TTL_MS });
const CACHE_KEY = 'chains';

// Exported for the paid Market Data API (api/_lib/market-data/), the x402
// market-chains endpoint sells the same cross-chain TVL board this page renders.
export async function buildChains() {
	return cached(_cache, CACHE_KEY, loadChains);
}

async function loadChains() {
	const now = Date.now();

	const resp = await fetch(UPSTREAM, {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(10_000),
	});
	if (!resp.ok) throw new Error(`llama ${resp.status}`);
	const raw = await resp.json();
	if (!Array.isArray(raw)) throw new Error('unexpected upstream shape');

	let totalTvl = 0;
	const eligible = [];
	for (const c of raw) {
		const tvl = Number(c?.tvl);
		if (!Number.isFinite(tvl) || tvl <= 0) continue;
		totalTvl += tvl;
		eligible.push(c);
	}

	eligible.sort((a, b) => Number(b.tvl) - Number(a.tvl));

	const chains = eligible.slice(0, 100).map((c) => {
		const tvl = Number(c.tvl);
		return {
			name: typeof c.name === 'string' ? c.name : 'Unknown',
			tvl,
			token_symbol: typeof c.tokenSymbol === 'string' && c.tokenSymbol ? c.tokenSymbol : null,
			share_pct: totalTvl > 0 ? (tvl / totalTvl) * 100 : 0,
		};
	});

	return {
		total_tvl: totalTvl,
		chain_count: eligible.length,
		chains,
		updated_at: now,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	try {
		const payload = await buildChains();
		return json(res, 200, payload, {
			'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=600',
		});
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'Cross-chain TVL data is unavailable right now. Retry shortly',
		);
	}
});
