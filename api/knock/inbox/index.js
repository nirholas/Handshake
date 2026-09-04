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
import { KNOCK_ESCROW_PROGRAM_ID } from '../../_lib/knock/escrow.js';

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

	const now = Date.now();
	return json(res, 200, {
		knocks: rows.map((row) => ({
			...row,
			amount: formatUsdc(row.amount_atomics),
			// On an escrowed knock the money is parked on-chain and is owed back
			// unless this owner answers in time, so the row carries the deadline
			// and whether it has passed. Without it the inbox would show a knock
			// worth answering that is in fact already refundable.
			escrow: escrowShape(row, now),
		})),
		has_more: rows.length === limit,
		totals: {
			pending: totals.pending,
			total: totals.total,
			earned_atomics: totals.earned_atomics,
			earned: formatUsdc(totals.earned_atomics),
			// Escrowed but unanswered: real money at this door that is not the
			// owner's yet, and stops being reachable when the window closes.
			escrowed_atomics: totals.escrowed_atomics ?? '0',
			escrowed: formatUsdc(totals.escrowed_atomics ?? '0'),
			escrowed_pending: totals.escrowed_pending ?? 0,
		},
	});
});

/** The on-chain half of one inbox row, or null on the two off-chain lanes. */
function escrowShape(row, now) {
	if (!row.escrow_knock) return null;
	const expiresAt = row.escrow_expires_at ? new Date(row.escrow_expires_at).getTime() : null;
	return {
		knock: row.escrow_knock,
		program: KNOCK_ESCROW_PROGRAM_ID,
		state: row.escrow_state || 'pending',
		expires_at: row.escrow_expires_at,
		expires_in_seconds: expiresAt === null ? null : Math.round((expiresAt - now) / 1000),
		expired: expiresAt !== null && expiresAt <= now,
	};
}
