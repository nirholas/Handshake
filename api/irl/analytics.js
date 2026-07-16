// GET /api/irl/analytics — site-wide /irl usage rollup for the admin dashboard
// (/admin/irl-analytics). Auth mirrors /api/ops/health and
// /api/admin/ops-alerts exactly: authorizeOps (signed-in platform admin OR
// `x-ops-secret` / Bearer OPS_SECRET). This surface exposes aggregate usage
// volume, not any individual's location or identity, but it's still internal
// operating data — same gate as the rest of /admin.
//
// Every number is a real query over irl_events (api/_lib/irl-analytics.js),
// irl_interactions, and irl_drop_claims — no cached/sampled/fake figures.

import { wrap, cors, json, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { rateLimited } from '../_lib/http.js';
import { authorizeOps } from '../_lib/ops-auth.js';
import { getIrlAnalyticsSummary } from '../_lib/irl-analytics.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: 'same' })) return;
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
		// rather than 500ing the dashboard.
		return json(res, 200, {
			windows: {},
			placement_modes_30d: {},
			daily_series_30d: [],
			generated_at: new Date().toISOString(),
			note: `analytics_unavailable: ${err?.message || 'db error'}`,
		});
	}
});
