// GET /api/knock/inbox → the knocks this account has taken.
//
// Ordered newest first, with the settled amount on every row, because "what was
// this worth" is the first thing an owner wants next to "who was it". The
// companion feed shows the same knocks as deliveries; this is the ledger view.

import { getRequestUser } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import { formatUsdc, KNOCK_STATUSES } from '../../_lib/knock/policy.js';
import { listInbox, inboxTotals } from '../../_lib/knock/store.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const user = await getRequestUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.knockRead(user.id);
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;
	const limitRaw = Number.parseInt(params.get('limit') || '30', 10);
	const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 30;
	const beforeRaw = params.get('before');
	const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw) : null;
	const statusRaw = params.get('status');
	const status = KNOCK_STATUSES.includes(statusRaw) ? statusRaw : null;

	const [rows, totals] = await Promise.all([
		listInbox(user.id, { limit, before, status }),
		inboxTotals(user.id),
	]);

	return json(res, 200, {
		knocks: rows.map((row) => ({ ...row, amount: formatUsdc(row.amount_atomics) })),
		has_more: rows.length === limit,
		totals: {
			pending: totals.pending,
			total: totals.total,
			earned_atomics: totals.earned_atomics,
			earned: formatUsdc(totals.earned_atomics),
		},
	});
});
