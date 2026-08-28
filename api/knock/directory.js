// GET /api/knock/directory
//
// Every open, listed door, cheapest first. This is the browsable half of Knock:
// the page a person lands on to find someone reachable, and the feed an agent
// crawls to discover who it can pay to talk to. Public and cacheable.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { formatUsdc } from '../_lib/knock/policy.js';
import { listDirectory } from '../_lib/knock/store.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.knockPublic(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const limitRaw = Number.parseInt(params.get('limit') || '60', 10);
	const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 60;

	const rows = await listDirectory({ limit });
	return json(
		res,
		200,
		{
			doors: rows.map((row) => ({
				handle: row.username,
				display_name: row.display_name || row.username,
				avatar_url: row.avatar_url || null,
				verified: row.verified_type || null,
				price_atomics: String(row.price_atomics),
				price: formatUsdc(row.price_atomics),
				headline: row.headline || null,
				replies: row.replies ?? 0,
				updated_at: row.updated_at,
			})),
			count: rows.length,
		},
		{ 'cache-control': 'public, max-age=60' },
	);
});
