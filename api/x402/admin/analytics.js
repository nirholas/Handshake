// GET /api/x402/admin/analytics?period=7d
//
// Payment analytics dashboard endpoint. Returns aggregate stats for x402
// payments across all endpoints, networks, and payers.
//
// Admin-only (api/_lib/admin.js requireAdmin gate).
//
// Supported periods: 1d, 7d, 30d, 90d, all.

import { cors, json, error, method, wrap } from '../../_lib/http.js';
import { requireAdmin } from '../../_lib/admin.js';
import { getPaymentStats } from '../../_lib/x402/audit-log.js';

const PERIOD_MAP = {
	'1d': 1,
	'7d': 7,
	'30d': 30,
	'90d': 90,
	'all': null,
};

function parsePeriod(raw) {
	const key = String(raw || '7d').toLowerCase();
	if (!(key in PERIOD_MAP)) return { error: `invalid period "${raw}". Use: ${Object.keys(PERIOD_MAP).join(', ')}` };
	const days = PERIOD_MAP[key];
	if (days === null) return { key, since: null };
	const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
	return { key, since };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const admin = await requireAdmin(req, res);
	if (!admin) return;

	const period = parsePeriod(req.query?.period);
	if (period.error) {
		return error(res, 400, 'invalid_period', period.error);
	}

	const stats = await getPaymentStats({ since: period.since });

	return json(res, 200, {
		period: period.key,
		...stats,
	});
});
