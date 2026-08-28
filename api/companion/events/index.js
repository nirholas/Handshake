// GET /api/companion/events → the triaged feed.
//
// Query:
//   limit=<1-50>            page size (default 30)
//   before=<iso timestamp>  cursor for "load more"
//   pending=1               only what has not been delivered or dismissed
//   min_importance=<0-100>  floor, for the "only the loud ones" view

import { getRequestUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import { listEvents, getSettings } from '../../_lib/companion/store.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const user = await getRequestUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.companionRead(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const limitRaw = Number.parseInt(params.get('limit') || '30', 10);
	const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 30;
	const beforeRaw = params.get('before');
	const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw) : null;
	const minRaw = Number.parseInt(params.get('min_importance') || '0', 10);
	const minImportance = Number.isFinite(minRaw) ? Math.min(100, Math.max(0, minRaw)) : 0;

	const [events, settings] = await Promise.all([
		listEvents(user.id, { limit, before, pendingOnly: params.get('pending') === '1', minImportance }),
		getSettings(user.id),
	]);

	return json(res, 200, {
		events,
		threshold: settings.threshold,
		has_more: events.length === limit,
	});
});
