// GET /api/coin/exchanges
// ---------------------------------------------------------------------------
// The top crypto exchanges for the /exchanges page. Proxies CoinGecko
// `/exchanges` (ranked by trust score, with 24h BTC volume) and converts each
// venue's BTC volume to USD using the live BTC price so the table can lead with
// a dollar figure. The price fetch is best-effort (Promise.allSettled) — the
// exchange list still renders with a BTC-only volume fallback if it fails.
// Cached 5 min in-memory + CDN.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch } from '../_lib/coingecko.js';
import { fetchCoinPriceUsd } from '../_lib/market-fallbacks.js';

let _cache = null; // { value, expiresAt }
const TTL_MS = 300_000;

const num = (v) => {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) ? n : null;
};

// Exported for the paid Market Data API (api/_lib/market-data/) — the x402
// market-exchanges endpoint sells the same ranked venue table this page renders.
export async function buildExchanges() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache.value;

	const [exResult, priceResult] = await Promise.allSettled([
		geckoFetch('/exchanges?per_page=100&page=1', { ttlMs: TTL_MS }),
		fetchCoinPriceUsd('bitcoin'),
	]);
	if (exResult.status !== 'fulfilled') throw exResult.reason || new Error('no exchange data');

	const rows = Array.isArray(exResult.value) ? exResult.value : [];
	if (!rows.length) throw new Error('empty exchange payload');

	const btcUsdRaw = priceResult.status === 'fulfilled' ? num(priceResult.value) : null;
	const btcUsd = btcUsdRaw != null && btcUsdRaw > 0 ? btcUsdRaw : null;

	const exchanges = rows.map((e) => {
		const volBtc = num(e.trade_volume_24h_btc);
		return {
			id: String(e.id ?? ''),
			name: e.name || e.id || 'Unknown exchange',
			image: e.image || null,
			trust_score: num(e.trust_score),
			trust_score_rank: num(e.trust_score_rank),
			volume_24h_btc: volBtc,
			volume_24h_usd: volBtc != null && btcUsd != null ? volBtc * btcUsd : null,
			year_established: num(e.year_established),
			country: e.country || null,
			url: typeof e.url === 'string' && /^https?:\/\//.test(e.url) ? e.url : null,
		};
	});

	const value = { exchanges, btc_usd: btcUsd, updated_at: now };
	_cache = { value, expiresAt: now + TTL_MS };
	return value;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	try {
		const payload = await buildExchanges();
		return json(res, 200, payload, {
			'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=900',
		});
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'exchange data is unavailable right now — retry shortly',
		);
	}
});
