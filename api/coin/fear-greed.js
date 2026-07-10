// GET /api/coin/fear-greed?limit=<1..365>
// ---------------------------------------------------------------------------
// The Crypto Fear & Greed index — current reading plus history for the
// /fear-greed page. Proxies alternative.me /fng (the standard free source,
// already used by /api/coin/global) and returns the latest value with its
// classification, plus a chronological [{ ts, value, label }] history for the
// chart. Cached 5 min in-memory + CDN.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const FNG_BASE = 'https://api.alternative.me/fng/';

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

	const resp = await fetch(`${FNG_BASE}?limit=${limit}&format=json`, {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(8000),
	});
	if (!resp.ok) {
		const err = new Error(`fng ${resp.status}`);
		err.status = resp.status;
		throw err;
	}
	const raw = await resp.json();
	const rows = Array.isArray(raw?.data) ? raw.data : [];
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
	// A 7-day-ago comparison point powers the "vs last week" delta.
	const weekAgo = history.length > 7 ? history[Math.max(0, history.length - 8)] : history[0];
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
