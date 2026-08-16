// GET /api/pump-bounties — read-only mirror of pump.fun GO's public bounty list.
//
// Proxies livestream-api.pump.fun/bounties/tasks (public, no auth) through a
// short server cache so we hit pump.fun rarely and serve every visitor from
// cache. Pagination is cursor-based (pass `cursor` = the previous page's
// `nextCursor`); `status` filters; `limit` caps at 50.

import { cors, json, error, wrap, method, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { cacheGet, cacheSet } from './_lib/cache.js';
import { listBounties, PumpGoError } from './_lib/pump-go.js';
import { clampInt } from './_lib/http-params.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	// Every (limit, cursor, status) triple is its own cache key, so an unthrottled
	// caller can walk the parameter space and miss the cache on every request,
	// turning this proxy into an open amplifier aimed at the upstream. Throttle per
	// IP first, on the same publicIp bucket the rest of the public read surface uses.
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://localhost');
	const limit = clampInt(url.searchParams.get('limit'), { max: 50, fallback: 30 });
	const cursor = url.searchParams.get('cursor') || null;
	const status = url.searchParams.get('status') || null;

	const cacheKey = `pumpgo:list:${limit}:${cursor || '_'}:${status || '_'}`;
	const cached = await cacheGet(cacheKey).catch(() => null);
	if (cached) {
		res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=120');
		return json(res, 200, cached);
	}

	let data;
	try {
		data = await listBounties({ limit, cursor, status });
	} catch (e) {
		if (e instanceof PumpGoError) return error(res, e.status, e.code, e.message);
		throw e;
	}

	await cacheSet(cacheKey, data, 30).catch(() => {});
	res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=120');
	return json(res, 200, data);
});
