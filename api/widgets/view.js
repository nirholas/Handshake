/**
 * Widget view event logger
 * ------------------------
 * POST /api/widgets/:id/view
 *
 * Logs an anonymous load event for analytics. No cookies, no IP, no UID.
 * - country: from Vercel edge headers (x-vercel-ip-country), not derived from raw IP
 * - referer_host: hostname only — no path, no query
 *
 * Best-effort: if the underlying widget_views table doesn't exist yet
 * (Prompt 06 owns that migration), we 204 silently so widgets can ship before
 * the dashboard does.
 */

import { sql } from '../_lib/db.js';
import { cors, wrap, error } from '../_lib/http.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'POST only');

	const url = new URL(req.url, 'http://x');
	const widgetId = url.searchParams.get('id');
	if (!widgetId) return error(res, 400, 'invalid_request', 'id required');

	const country = headerOnce(req, 'x-vercel-ip-country') || null;
	const refererHost = parseRefererHost(req.headers.referer);

	try {
		await sql`
			insert into widget_views (widget_id, country, referer_host, created_at)
			values (${widgetId}, ${country}, ${refererHost}, now())
		`;
	} catch (err) {
		if (err?.code === '23503') {
			// FK violation: widget_id does not exist — best-effort analytics, swallow silently
		} else if (/relation .* does not exist/i.test(err?.message || '')) {
			// Table not yet migrated — swallow silently
		} else {
			throw err;
		}
	}
	try {
		await sql`
			update widgets set view_count = view_count + 1 where id = ${widgetId}
		`;
	} catch (err) {
		if (err?.code === '23503') {
			// FK violation — swallow silently
		} else if (/relation .* does not exist/i.test(err?.message || '')) {
			// Table not yet migrated — swallow silently
		} else {
			throw err;
		}
	}

	res.statusCode = 204;
	res.setHeader('cache-control', 'no-store');
	res.end();
});

function headerOnce(req, name) {
	const v = req.headers[name];
	if (Array.isArray(v)) return v[0] || null;
	return v || null;
}

function parseRefererHost(referer) {
	if (!referer) return null;
	try {
		return new URL(referer).hostname || null;
	} catch {
		return null;
	}
}
