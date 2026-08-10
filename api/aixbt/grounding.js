// GET /api/aixbt/grounding: hourly structured market context (crypto + tradfi).
//
// Part of the three.ws / aixbt bridge. Public, read-only. Updates hourly
// upstream, so it is cached aggressively.
//
// Response: { grounding, source } | { error, error_description }

import { wrap, cors, method, json, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getGrounding } from '../_lib/aixbt.js';
import { respondAixbtError } from './_shared.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	// Shares the upstream key quota with the other /api/aixbt/* lanes, so it
	// takes the global ceiling as well as the per-IP one. A 600s cache absorbs
	// most of the traffic, but a cold cache under a spread of callers would
	// otherwise bypass the shared budget entirely.
	const [rl, rlg] = await Promise.all([limits.aixbtIp(clientIp(req)), limits.aixbtGlobal()]);
	if (!rl.success) return rateLimited(res, rl);
	if (!rlg.success) return rateLimited(res, rlg);

	try {
		const result = await getGrounding();
		return json(res, 200, result, {
			'cache-control': 'public, s-maxage=600, stale-while-revalidate=1800',
		});
	} catch (err) {
		return respondAixbtError(res, err);
	}
});
