// GET /api/pump/price-history?mint=<mint>&interval=15m&from=<unix>&to=<unix>
// --------------------------------------------------------------------------
// Server-side proxy for Birdeye OHLCV. Keeps BIRDEYE_API_KEY on the server.
// Returns the upstream error verbatim on failure — never fabricates candles.
//
// Response: { data: [ { t, o, h, l, c, v }, ... ] }  (t = unix seconds)

import { cors, json, method, wrap, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

const VALID_INTERVALS = new Set([
	'1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '6H', '8H', '12H', '1D', '3D', '1W', '1M',
]);

// Birdeye uses uppercase hour/day codes (1H, 1D). Accept the common lowercase
// forms from the client and normalize so callers don't have to care.
function normalizeInterval(raw) {
	if (!raw) return '15m';
	const map = { '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '8h': '8H', '12h': '12H', '1d': '1D', '3d': '3D', '1w': '1W' };
	const v = map[raw] || raw;
	return VALID_INTERVALS.has(v) ? v : '15m';
}

function isPlausibleMint(s) {
	return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

let _cache = new Map(); // key → { value, expiresAt }
const TTL_MS = 30_000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const params = new URL(req.url, 'http://x').searchParams;
	const mint = (params.get('mint') || '').trim();
	if (!isPlausibleMint(mint)) {
		return error(res, 400, 'bad_mint', 'mint must be a base58 Solana address (32–44 chars)');
	}
	const interval = normalizeInterval(params.get('interval'));

	const nowSec = Math.floor(Date.now() / 1000);
	const to = Math.min(nowSec, parseInt(params.get('to') || String(nowSec), 10) || nowSec);
	const defaultFrom = nowSec - 24 * 3600;
	let from = parseInt(params.get('from') || String(defaultFrom), 10);
	if (!Number.isFinite(from) || from <= 0 || from >= to) from = defaultFrom;
	// Cap the window at 30 days to keep upstream payloads bounded.
	if (to - from > 30 * 86400) from = to - 30 * 86400;

	if (!BIRDEYE_API_KEY) {
		return error(res, 503, 'not_configured', 'On-chain data provider is not configured');
	}

	const key = `${mint}:${interval}:${from}:${to}`;
	const now = Date.now();
	const hit = _cache.get(key);
	if (hit && hit.expiresAt > now) {
		return json(res, 200, { data: hit.value }, { 'cache-control': 'public, max-age=15, s-maxage=30' });
	}

	const url =
		`https://public-api.birdeye.so/defi/ohlcv` +
		`?address=${encodeURIComponent(mint)}&type=${interval}&time_from=${from}&time_to=${to}`;

	let upstream;
	try {
		upstream = await fetch(url, {
			headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana', accept: 'application/json' },
			signal: AbortSignal.timeout(10_000),
		});
	} catch (e) {
		return error(res, 502, 'bad_gateway', `Birdeye unreachable: ${e.message}`);
	}

	if (!upstream.ok) {
		const body = await upstream.text().catch(() => '');
		return error(res, 502, 'upstream_error', `Birdeye ${upstream.status}: ${body.slice(0, 200)}`);
	}

	const payload = await upstream.json().catch(() => null);
	const items = payload?.data?.items;
	if (!Array.isArray(items)) {
		return error(res, 502, 'upstream_error', 'Birdeye returned an unexpected payload');
	}

	const data = items
		.map((it) => ({
			t: Number(it.unixTime),
			o: Number(it.o),
			h: Number(it.h),
			l: Number(it.l),
			c: Number(it.c),
			v: Number(it.v ?? 0),
		}))
		.filter((d) => Number.isFinite(d.t) && Number.isFinite(d.c));

	_cache.set(key, { value: data, expiresAt: now + TTL_MS });
	if (_cache.size > 128) _cache.delete(_cache.keys().next().value);

	return json(res, 200, { data }, { 'cache-control': 'public, max-age=15, s-maxage=30' });
});
