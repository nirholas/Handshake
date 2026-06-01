// GET /api/pump/trending?limit=25
// -------------------------------
// Server-side proxy for Birdeye's trending-tokens feed. Keeps BIRDEYE_API_KEY
// on the server — the browser never sees it. Returns the upstream error verbatim
// on failure so the UI can surface it; never falls back to a hardcoded list.
//
// Response: { data: [ { mint, symbol, name, logo, price_usd, rank } ] }

import { cors, json, method, wrap, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

// Process-local cache. Trending shifts slowly; many tabs polling on nav into the
// dashboard would otherwise hammer Birdeye. Warm-starts share this map.
let _cache = { value: null, expiresAt: 0, limit: 0 };
const TTL_MS = 30_000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const raw = Number(new URL(req.url, 'http://x').searchParams.get('limit') || '25');
	const limit = Math.min(50, Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : 25));

	if (!BIRDEYE_API_KEY) {
		return error(res, 503, 'not_configured', 'Trending data provider is not configured');
	}

	const now = Date.now();
	if (_cache.value && _cache.limit >= limit && _cache.expiresAt > now) {
		return json(
			res,
			200,
			{ data: _cache.value.slice(0, limit) },
			{
				'cache-control': 'public, max-age=15, s-maxage=30',
			},
		);
	}

	const url =
		`https://public-api.birdeye.so/defi/token_trending` +
		`?sort_by=rank&sort_type=asc&offset=0&limit=${limit}`;

	let upstream;
	try {
		upstream = await fetch(url, {
			headers: {
				'X-API-KEY': BIRDEYE_API_KEY,
				'x-chain': 'solana',
				accept: 'application/json',
			},
			signal: AbortSignal.timeout(8000),
		});
	} catch (e) {
		return error(res, 502, 'bad_gateway', `Birdeye unreachable: ${e.message}`);
	}

	if (!upstream.ok) {
		const body = await upstream.text().catch(() => '');
		return error(
			res,
			502,
			'upstream_error',
			`Birdeye ${upstream.status}: ${body.slice(0, 200)}`,
		);
	}

	const payload = await upstream.json().catch(() => null);
	const tokens = payload?.data?.tokens;
	if (!Array.isArray(tokens)) {
		return error(res, 502, 'upstream_error', 'Birdeye returned an unexpected payload');
	}

	const data = tokens
		.map((t) => ({
			mint: t.address,
			symbol: t.symbol || '?',
			name: t.name || t.symbol || '',
			logo: t.logoURI || null,
			price_usd: typeof t.price === 'number' ? t.price : null,
			rank: typeof t.rank === 'number' ? t.rank : null,
		}))
		.filter((t) => typeof t.mint === 'string' && t.mint.length >= 32);

	_cache = { value: data, expiresAt: now + TTL_MS, limit };

	return json(res, 200, { data }, { 'cache-control': 'public, max-age=15, s-maxage=30' });
});
