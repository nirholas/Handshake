// GET /api/defi/stablecoins
// ---------------------------------------------------------------------------
// Live stablecoin market-cap board for the /stablecoins page. Reads the free,
// keyless DeFiLlama stablecoins API and reshapes it into a lean, ranked list:
// each pegged asset's circulating supply (denominated in its own peg unit) is
// its on-chain market cap. We surface price (for peg-health), peg mechanism,
// and the chains it lives on. Aggregate market cap sums every finite asset,
// then the list is sorted by size and capped at the top 100. Cached 5m
// in-memory + CDN — the source refreshes on the order of minutes, not seconds.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const UPSTREAM = 'https://stablecoins.llama.fi/stablecoins?includePrices=true';
const TTL_MS = 300_000; // 5 minutes — matches the CDN s-maxage below.
const TOP_N = 100;

let _cache = null; // { value, expiresAt }

// peg_type keeps DeFiLlama's raw token (`peggedUSD`, `peggedEUR`, …) so the
// client can render the pegged currency (USD, EUR) without a lossy remap; the
// "pegged" prefix is stripped for display client-side.
function shape(assets) {
	const rows = [];
	let totalMcap = 0;

	for (const a of assets) {
		if (!a || typeof a !== 'object') continue;
		const pegType = typeof a.pegType === 'string' ? a.pegType : null;
		// Circulating is nested under the asset's own peg unit, e.g.
		// circulating.peggedUSD. No peg type → no way to read it; skip.
		const circulating = pegType && a.circulating ? Number(a.circulating[pegType]) : NaN;
		if (!Number.isFinite(circulating)) continue;

		totalMcap += circulating;

		const price = Number(a.price);
		const chains = Array.isArray(a.chains) ? a.chains.filter((c) => typeof c === 'string') : [];

		rows.push({
			// DeFiLlama's numeric asset id ("1", "2", …) — the /stablecoin/:id
			// detail page keys off it; null when upstream omits it.
			id: a.id != null ? String(a.id) : null,
			name: typeof a.name === 'string' ? a.name : 'Unknown',
			symbol: typeof a.symbol === 'string' ? a.symbol : '',
			price: Number.isFinite(price) ? price : null,
			peg_type: pegType,
			peg_mechanism: typeof a.pegMechanism === 'string' ? a.pegMechanism : null,
			circulating_usd: circulating,
			chains,
			chain_count: chains.length,
		});
	}

	rows.sort((x, y) => y.circulating_usd - x.circulating_usd);

	return {
		total_mcap: totalMcap,
		count: rows.length,
		stablecoins: rows.slice(0, TOP_N),
		updated_at: Date.now(),
	};
}

// Exported for the paid Market Data API (api/_lib/market-data/) — the x402
// market-stablecoins endpoint sells the same peg board this page renders.
export async function buildStablecoins() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache.value;

	const resp = await fetch(UPSTREAM, {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(10_000),
	});
	if (!resp.ok) throw new Error(`llama ${resp.status}`);

	const body = await resp.json();
	const assets = Array.isArray(body?.peggedAssets) ? body.peggedAssets : null;
	if (!assets) throw new Error('unexpected upstream shape');

	const value = shape(assets);
	_cache = { value, expiresAt: now + TTL_MS };
	return value;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	try {
		const payload = await buildStablecoins();
		return json(res, 200, payload, {
			'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=600',
		});
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'stablecoin data is unavailable right now — retry shortly',
		);
	}
});
