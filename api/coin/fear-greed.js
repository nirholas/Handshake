// GET /api/coin/fear-greed?limit=<1..365>
// ---------------------------------------------------------------------------
// The Crypto Fear & Greed index — current reading plus history for the
// /fear-greed page. Proxies alternative.me /fng (the standard free source,
// already used by /api/coin/global) and returns the latest value with its
// classification, plus a chronological [{ ts, value, label }] history for the
// chart. Cached 5 min in-memory + CDN.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

import { fetchUpstreamJson, lastGood } from '../_lib/upstream-fetch.js';
const FNG_BASE = 'https://api.alternative.me/fng/';
// The index updates once a day, so a day-old reading is still the current one.
const STALE_MAX_AGE_MS = 24 * 60 * 60_000;

// One tiny per-instance cache keyed by limit shields the upstream from
// concurrent cold-instance misses; CDN absorbs the rest.
const _cache = new Map(); // limit → { value, expiresAt }
const TTL_MS = 300_000;

function classify(v) {
	if (v <= 25) return 'Extreme Fear';
	if (v <= 45) return 'Fear';
	if (v <= 55) return 'Neutral';
	if (v <= 75) return 'Greed';
	return 'Extreme Greed';
}

async function fetchFng(limit) {
	const now = Date.now();
	const hit = _cache.get(limit);
	if (hit && hit.expiresAt > now) return hit.value;

	const { value } = await lastGood(`fng:${limit}`, () => fetchFngLive(limit), {
		maxAgeMs: STALE_MAX_AGE_MS,
		onFallback: (err, ageMs) => console.warn(`[fear-greed] every source failed (${err?.message}); serving ${Math.round(ageMs / 60_000)}m-old reading`),
	});
	return value;
}

// alternative.me is the canonical index. CoinMarketCap publishes its own
// (same 0-100 scale, same classification bands) behind a free key, so it is
// the second rung whenever COINMARKETCAP_API_KEY is set. Both normalise to the
// same {value, timestamp, value_classification} row shape.
async function fetchFngRows(limit) {
	const sources = [
		{
			name: 'alternative.me',
			load: async () => {
				const raw = await fetchUpstreamJson(`${FNG_BASE}?limit=${limit}&format=json`, {
					headers: { 'user-agent': 'three.ws/1.0' },
				}, { name: 'alternative-me-fng', timeoutMs: 8_000, attempts: 2 });
				return Array.isArray(raw?.data) ? raw.data : [];
			},
		},
		process.env.COINMARKETCAP_API_KEY && {
			name: 'coinmarketcap',
			load: async () => {
				const raw = await fetchUpstreamJson(`https://pro-api.coinmarketcap.com/v3/fear-and-greed/historical?limit=${limit}`, {
					headers: { 'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY },
				}, { name: 'cmc-fng', timeoutMs: 8_000, attempts: 2 });
				const rows = Array.isArray(raw?.data) ? raw.data : [];
				return rows.map((d) => ({
					value: d.value,
					timestamp: Math.floor(Date.parse(d.timestamp) / 1000),
					value_classification: d.value_classification,
				}));
			},
		},
	].filter(Boolean);
	let lastErr;
	for (const src of sources) {
		try {
			const rows = await src.load();
			if (rows.length) return rows;
			lastErr = new Error(`${src.name}: empty payload`);
		} catch (err) {
			lastErr = err;
			console.warn(`[fear-greed] ${src.name} failed: ${err?.message || err}`);
		}
	}
	throw lastErr || new Error('no fear & greed source configured');
}

async function fetchFngLive(limit) {
	const now = Date.now();
	const rows = await fetchFngRows(limit);
	// alternative.me returns newest-first; the chart wants oldest→newest.
	const history = rows
		.map((d) => {
			const value = Number(d.value);
			const ts = Number(d.timestamp) * 1000;
			if (!Number.isFinite(value) || !Number.isFinite(ts)) return null;
			return { ts, value, label: d.value_classification || classify(value) };
		})
		.filter(Boolean)
		.sort((a, b) => a.ts - b.ts);
	if (!history.length) throw new Error('empty fng payload');

	const latest = history[history.length - 1];
	// A 7-day-ago comparison point powers the "vs last week" delta. Only a real
	// week back qualifies: a short window used to fall back to history[0], so
	// `?limit=1` reported the current reading as its own previous week and the
	// page rendered "Unchanged from last week" from a single data point. With no
	// week-old point the field is null and the client omits the delta.
	const weekAgo = history.length > 7 ? history[history.length - 8] : null;
	const value = {
		current: { value: latest.value, label: latest.label, ts: latest.ts },
		previous_week: weekAgo
			? { value: weekAgo.value, label: weekAgo.label, ts: weekAgo.ts }
			: null,
		history,
	};
	_cache.set(limit, { value, expiresAt: now + TTL_MS });
	if (_cache.size > 8) _cache.delete(_cache.keys().next().value);
	return value;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const limit = Math.min(Math.max(1, parseInt(params.get('limit') || '90', 10) || 90), 365);

	try {
		const payload = await fetchFng(limit);
		return json(res, 200, payload, {
			'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=900',
		});
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'the Fear & Greed index is unavailable right now — retry shortly',
		);
	}
});
