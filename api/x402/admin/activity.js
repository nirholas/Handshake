// GET /api/x402/admin/activity?limit=50&offset=0
//
// Recent x402 payment event feed with pagination and filters.
// Admin-only (api/_lib/admin.js requireAdmin gate).
//
// Query params:
//   limit       — max rows, 1-1000, default 50
//   offset      — pagination offset, default 0
//   route       — filter by endpoint route
//   payer       — filter by wallet address
//   event_type  — filter: payment_settled, payment_failed, siwx_grant, siwx_access, bypass_granted
//   network     — filter by CAIP-2 network ID
//   since       — ISO 8601 timestamp, events after this time

import { cors, json, error, method, wrap } from '../../_lib/http.js';
import { requireAdmin } from '../../_lib/admin.js';
import { getAuditLog } from '../../_lib/x402/audit-log.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const admin = await requireAdmin(req, res);
	if (!admin) return;

	const q = req.query || {};
	const limit = Math.min(Math.max(1, parseInt(q.limit, 10) || 50), 1000);
	const offset = Math.max(0, parseInt(q.offset, 10) || 0);

	const rows = await getAuditLog({
		route: q.route || undefined,
		payer: q.payer || undefined,
		eventType: q.event_type || undefined,
		network: q.network || undefined,
		since: q.since || undefined,
		limit,
		offset,
	});

	return json(res, 200, {
		data: rows,
		pagination: {
			limit,
			offset,
			count: rows.length,
			has_more: rows.length === limit,
		},
	});
});
