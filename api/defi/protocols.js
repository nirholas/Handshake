// GET /api/defi/protocols
// ---------------------------------------------------------------------------
// Top DeFi protocols by TVL for the /defi page. Fetches DeFiLlama's keyless
// /protocols feed (no API key), normalizes each entry to the fields the page
// renders, and returns the top 100 by TVL plus whole-market totals. Cached
// 5 min in-memory + CDN. DeFiLlama is the data source — see the page's
// attribution line.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const UPSTREAM = 'https://api.llama.fi/protocols';
const TTL_MS = 300_000;

let _cache = null; // { value, expiresAt }

const finite = (n) => (Number.isFinite(n) ? n : null);

async function build() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache.value;

	const resp = await fetch(UPSTREAM, {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(10_000),
	});
	if (!resp.ok) throw new Error(`llama ${resp.status}`);
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
			name: typeof p.name === 'string' ? p.name : 'Unknown',
			logo: typeof p.logo === 'string' ? p.logo : null,
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

	const value = {
		total_tvl: totalTvl,
		protocol_count: protocolCount,
		protocols,
		updated_at: now,
	};
	_cache = { value, expiresAt: now + TTL_MS };
	return value;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	try {
		const payload = await build();
		return json(res, 200, payload, {
			'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=600',
		});
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'DeFi protocol data is unavailable right now — retry shortly',
		);
	}
});
