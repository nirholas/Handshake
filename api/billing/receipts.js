/**
 * GET /api/billing/receipts
 *
 * Two receipt forms, both auth-gated to the owning user:
 *   ?event_id=<id>      — a per-CHARGE receipt from the usage ledger: action,
 *                         units, price, fee, holder discount applied, the
 *                         settlement tx link, and the timestamp (api/_lib/metering.js).
 *   ?purchase_id=<uuid> — the signed receipt JSON for a confirmed skill purchase.
 */

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { getReceipt } from '../_lib/metering.js';
import { isUuid } from '../_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id || bearer?.userId;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const params = new URL(req.url, 'http://x').searchParams;

	// Per-charge receipt from the usage ledger.
	const eventId = params.get('event_id');
	if (eventId) {
		if (!/^\d+$/.test(eventId)) return error(res, 400, 'bad_request', 'event_id must be numeric');
		const receipt = await getReceipt({ userId, eventId: Number(eventId) });
		if (!receipt) return error(res, 404, 'not_found', 'receipt not found for this charge');
		return json(res, 200, { data: receipt }, { 'cache-control': 'no-store' });
	}

	const purchaseId = params.get('purchase_id');
	if (!purchaseId) return error(res, 400, 'bad_request', 'event_id or purchase_id required');
	// `skill_purchases.id` is a uuid column: a malformed value makes Postgres
	// raise 22P02, turning a client typo into a 500.
	if (!isUuid(purchaseId)) return error(res, 400, 'bad_request', 'purchase_id must be a UUID');

	// Verify ownership before returning receipt
	const [purchase] = await sql`
		SELECT id, user_id FROM skill_purchases
		WHERE id = ${purchaseId}
	`;
	if (!purchase) return error(res, 404, 'not_found', 'purchase not found');
	if (purchase.user_id !== userId) return error(res, 403, 'forbidden', 'not your purchase');

	const [receipt] = await sql`
		SELECT receipt_json, signature, created_at
		FROM purchase_receipts
		WHERE purchase_id = ${purchaseId}
	`;

	if (!receipt) return error(res, 404, 'not_found', 'receipt not found for this purchase');

	return json(res, 200, {
		data: {
			purchase_id: purchaseId,
			receipt: receipt.receipt_json,
			signature: receipt.signature,
			issued_at: receipt.created_at,
		},
	});
});
