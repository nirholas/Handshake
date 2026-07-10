// GET /api/coin/rates
// ---------------------------------------------------------------------------
// Live fiat exchange rates for the /converter page. Proxies CoinGecko
// /exchange_rates — which quotes every currency as "units per 1 BTC" — and
// slims it to a curated list of major fiat currencies (plus USD as the anchor
// the converter divides through). Each entry carries its display unit symbol
// and its per-BTC value so the client can derive any fiat⇄fiat / fiat⇄USD rate
// without a second call. Cached in-memory 5m + CDN.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { geckoFetch } from '../_lib/coingecko.js';

// Curated fiat set, in display order. USD is always first — it's the anchor the
// converter divides through to turn a per-BTC value into a per-USD rate. The
// rest are the most-traded/most-searched fiats; whichever the upstream returns
// are included, the rest are silently skipped so a currency dropping out of the
// feed never breaks the page.
const CURATED = [
	'usd',
	'eur',
	'gbp',
	'jpy',
	'cny',
	'inr',
	'krw',
	'brl',
	'cad',
	'aud',
	'chf',
	'rub',
	'try',
	'mxn',
	'sgd',
	'hkd',
	'aed',
	'zar',
];

let _cache = null; // { value, expiresAt }
const TTL_MS = 300_000;

async function build() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache.value;

	const raw = await geckoFetch('/exchange_rates', { ttlMs: TTL_MS });
	const rates = raw?.rates;
	if (!rates || typeof rates !== 'object') throw new Error('unexpected upstream payload');

	const fiats = [];
	for (const code of CURATED) {
		const r = rates[code];
		if (!r || r.type !== 'fiat') continue;
		const perBtc = Number(r.value);
		if (!Number.isFinite(perBtc) || perBtc <= 0) continue;
		fiats.push({
			code: code.toUpperCase(),
			name: typeof r.name === 'string' ? r.name : code.toUpperCase(),
			unit: typeof r.unit === 'string' && r.unit.trim() ? r.unit.trim() : '',
			per_btc: perBtc,
		});
	}
	// USD is load-bearing — without it the client can't convert a per-BTC value
	// into a per-USD rate. If the upstream ever omits it, that's an upstream fault.
	if (!fiats.some((f) => f.code === 'USD')) throw new Error('missing USD anchor rate');

	const value = { fiats, updated_at: now };
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
			'cache-control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=1800',
		});
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'exchange rates are unavailable right now — retry shortly',
		);
	}
});
