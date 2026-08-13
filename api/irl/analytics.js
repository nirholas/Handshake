// GET /api/irl/analytics: site-wide /irl usage rollup for operators.
// Auth mirrors /api/ops/health exactly: authorizeOps (signed-in platform admin
// OR `x-ops-secret` / Bearer OPS_SECRET). This surface exposes aggregate usage
// volume, not any individual's location or identity, but it's still internal
// operating data, so it wears the same gate as the rest of the ops APIs.
//
// Every number is a real query over irl_events (api/_lib/irl-analytics.js),
// irl_interactions, and irl_drop_claims — no cached/sampled/fake figures.

import { wrap, cors, json, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { rateLimited } from '../_lib/http.js';
import { authorizeOps } from '../_lib/ops-auth.js';
import { getIrlAnalyticsSummary } from '../_lib/irl-analytics.js';

export default wrap(async (req, res) => {
	// Omitting `origins` IS the same-origin policy: cors() then falls back to the
	// first-party allow-list in isAllowedOrigin(). Passing a sentinel string instead
	// (`origins: 'same'`) reached `allowed.some(...)` on a string and threw, so every
	// request carrying an Origin header - including the browser's preflight - came
	// back 500 rather than a CORS decision.
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (req.method?.toUpperCase() !== 'GET') return error(res, 405, 'method_not_allowed', 'GET only');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const auth = await authorizeOps(req);
	if (!auth.ok) return error(res, 401, 'unauthorized', 'admin session or x-ops-secret required');

	try {
		const summary = await getIrlAnalyticsSummary();
		return json(res, 200, summary);
	} catch (err) {
		// Table absent (pre-deploy) or DB hiccup — report an honest empty summary
		// rather than 500ing the dashboard. LOG it: this degrade is indistinguishable
		// from "no usage yet" in the response, so an unlogged failure hides a broken
		// query behind a plausible-looking wall of zeros (exactly how an ambiguous
		// column reference in the daily-series query survived unnoticed).
		console.error('[irl/analytics] summary unavailable, serving empty rollup', {
			endpoint: 'GET /api/irl/analytics',
			reason: err?.message || String(err),
		});
		return json(res, 200, {
			windows: {},
			placement_modes_30d: {},
			daily_series_30d: [],
			generated_at: new Date().toISOString(),
			note: `analytics_unavailable: ${err?.message || 'db error'}`,
		});
	}
});
