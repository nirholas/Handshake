// GET /api/coin/derivatives[?view=exchanges]
// ---------------------------------------------------------------------------
// Perpetual futures markets for the /derivatives page. Proxies CoinGecko
// `/derivatives?include_tickers=unexpired`, keeps only perpetual contracts,
// coerces the numeric fields (price, funding rate, open interest, 24h volume)
// and returns them sorted by 24h volume, capped at 100. Non-finite numbers
// become null so the client renders an em dash instead of NaN. Cached 60s
// in-memory + CDN.
//
// `?view=exchanges` returns the derivatives venues instead — CoinGecko
// `/derivatives/exchanges` ranked by open interest — feeding the Derivatives
// Exchanges section of the page; rows deep-link to /exchange/:id, where the
// detail endpoint's derivatives fallback serves them. Cached 5 min.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch } from '../_lib/coingecko.js';

let _cache = null; // { value, expiresAt }
let _exCache = null; // { value, expiresAt }
const TTL_MS = 60_000;
const EX_TTL_MS = 300_000;

const num = (v) => {
	if (v == null || v === '') return null;
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) ? n : null;
};

// Exported for the paid Market Data API (api/_lib/market-data/) — the x402
// market-derivatives endpoint sells the same perp table this page renders.
export async function buildDerivativeTickers() {
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

export async function buildDerivativeExchanges() {
	const now = Date.now();
	if (_exCache && _exCache.expiresAt > now) return _exCache.value;

	// trade_volume_24h_btc arrives as a string on this endpoint — num() coerces.
	const raw = await geckoFetch('/derivatives/exchanges?order=open_interest_btc_desc&per_page=50', {
		ttlMs: EX_TTL_MS,
	});
	const rows = Array.isArray(raw) ? raw : [];

	const exchanges = rows
		.filter((e) => e && e.id)
		.map((e) => ({
			id: String(e.id),
			name: e.name || e.id,
			image: e.image || null,
			open_interest_btc: num(e.open_interest_btc),
			trade_volume_24h_btc: num(e.trade_volume_24h_btc),
			perpetual_pairs: num(e.number_of_perpetual_pairs),
			futures_pairs: num(e.number_of_futures_pairs),
			year_established: num(e.year_established),
			country: e.country || null,
		}));

	if (!exchanges.length) throw new Error('empty derivatives exchanges payload');

	const value = { exchanges, updated_at: now };
	_exCache = { value, expiresAt: now + EX_TTL_MS };
	return value;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const view = new URL(req.url, 'http://x').searchParams.get('view');

	if (view === 'exchanges') {
		try {
			const payload = await buildDerivativeExchanges();
			return json(res, 200, payload, {
				'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=900',
			});
		} catch {
			return error(
				res,
				502,
				'upstream_error',
				'derivatives exchange data is unavailable right now — retry shortly',
			);
		}
	}

	try {
		const payload = await buildDerivativeTickers();
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
