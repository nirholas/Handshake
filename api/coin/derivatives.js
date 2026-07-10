// GET /api/coin/derivatives
// ---------------------------------------------------------------------------
// Perpetual futures markets for the /derivatives page. Proxies CoinGecko
// `/derivatives?include_tickers=unexpired`, keeps only perpetual contracts,
// coerces the numeric fields (price, funding rate, open interest, 24h volume)
// and returns them sorted by 24h volume, capped at 100. Non-finite numbers
// become null so the client renders an em dash instead of NaN. Cached 60s
// in-memory + CDN.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch } from '../_lib/coingecko.js';

let _cache = null; // { value, expiresAt }
const TTL_MS = 60_000;

const num = (v) => {
	if (v == null || v === '') return null;
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) ? n : null;
};

async function build() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache.value;

	const raw = await geckoFetch('/derivatives?include_tickers=unexpired', { ttlMs: TTL_MS });
	const rows = Array.isArray(raw) ? raw : [];

	const tickers = rows
		.filter((t) => t && t.contract_type === 'perpetual')
		.map((t) => ({
			market: t.market || 'Unknown',
			symbol: t.symbol || '',
			index_id: t.index_id || null,
			price: num(t.price),
			change_24h: num(t.price_percentage_change_24h),
			funding_rate: num(t.funding_rate),
			open_interest: num(t.open_interest),
			volume_24h: num(t.volume_24h),
		}))
		.sort((a, b) => (b.volume_24h ?? 0) - (a.volume_24h ?? 0))
		.slice(0, 100);

	if (!tickers.length) throw new Error('empty derivatives payload');

	const value = { tickers, updated_at: now };
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
			'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300',
		});
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'derivatives data is unavailable right now — retry shortly',
		);
	}
});
