/**
 * Widget view event logger
 * ------------------------
 * POST /api/widgets/:id/view
 *
 * Logs an anonymous load event for analytics. No cookies, no IP, no UID.
 * - country: ISO 3166-1 alpha-2 from the edge geo header, never derived from
 *   the raw IP. See api/_lib/client-geo.js for the header priority.
 * - referer_host: hostname only, no path, no query.
 *
 * Best-effort by design: a widget page load must never fail because analytics
 * could not be recorded. A foreign-key miss (the id names no live widget, which
 * is what every demo-fixture view does) and a missing table both 204 silently.
 * Any other database error still throws, so a real outage stays visible.
 */

import { sql } from '../_lib/db.js';
import { clientCountry } from '../_lib/client-geo.js';
import { cors, wrap, error } from '../_lib/http.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'POST only');

	const url = new URL(req.url, 'http://x');
	const widgetId = url.searchParams.get('id');
	if (!widgetId) return error(res, 400, 'invalid_request', 'id required');

	const country = clientCountry(req);
	const refererHost = parseRefererHost(req.headers.referer);

	try {
		await sql`
			insert into widget_views (widget_id, country, referer_host, created_at)
			values (${widgetId}, ${country}, ${refererHost}, now())
		`;
	} catch (err) {
		if (!isBestEffortMiss(err)) throw err;
	}
	try {
		await sql`
			update widgets set view_count = view_count + 1 where id = ${widgetId}
		`;
	} catch (err) {
		if (!isBestEffortMiss(err)) throw err;
	}

	res.statusCode = 204;
	res.setHeader('cache-control', 'no-store');
	res.end();
});

// A view that names no live widget (23503) or lands before the analytics table
// exists is a miss we absorb. Anything else is a real fault and propagates.
function isBestEffortMiss(err) {
	if (err?.code === '23503') return true;
	return /relation .* does not exist/i.test(err?.message || '');
}

function parseRefererHost(referer) {
	if (!referer) return null;
	try {
		return new URL(referer).hostname || null;
	} catch {
		return null;
	}
}
