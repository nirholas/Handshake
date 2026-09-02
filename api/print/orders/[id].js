// GET /api/print/orders/:id: one print order and its full timeline.
//
// The timeline is print_order_events, appended once per transition and never
// mutated, so this is the order's whole story: when it was quoted, when the
// money landed, when it went to the floor, when it shipped, and any note an
// operator left along the way.
//
// Visible to the order's owner and to nobody else. An agent order (paid over
// x402, no session) is read back with the payer wallet's own signed access,
// which is the x402 lane's business; this endpoint is the human one and it
// answers 404, not 403, for an order that is not yours. Telling a stranger that
// an id exists is itself a leak.

import { cors, error, json, method, rateLimited, wrap } from '../../_lib/http.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';
import { getSessionUser } from '../../_lib/auth.js';
import { getOrderWithEvents } from '../../_lib/print-store.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The buyer-facing projection of an order row. Deliberately explicit rather
 * than a spread: print_orders holds the shipping address and the provider's own
 * state, and neither belongs in a response just because a column was added.
 */
export function publicOrder(row) {
	return {
		id: row.id,
		status: row.status,
		created_at: row.created_at,
		updated_at: row.updated_at,
		creation_id: row.creation_id,
		material_id: row.material_id,
		target_height_mm: row.target_height_mm,
		quantity: row.quantity,
		price_usdc: row.price_usdc,
		// The itemization the buyer agreed to, read back rather than recomputed.
		quote: row.quote ?? null,
		lead_time_days: row.lead_time_days,
		quote_expires_at: row.quote_expires_at,
		paid_at: row.paid_at,
		payment: {
			chain: row.payment_chain,
			reference: row.payment_reference,
			signature: row.payment_signature,
			explorer_url: row.payment_signature ? `https://solscan.io/tx/${row.payment_signature}` : null,
		},
		// Where the parcel is going, in the one form a buyer needs to confirm they
		// typed it correctly. The full address stays with the operator console.
		ship_to: row.shipping
			? { name: row.shipping.name, city: row.shipping.city, country: row.shipping.country }
			: null,
		tracking_number: row.tracking_number,
		carrier: row.carrier,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const id = String(req.query?.id || '').trim();
	if (!UUID_RE.test(id)) return error(res, 400, 'validation_error', 'invalid order id');

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const user = await getSessionUser(req).catch(() => null);
	if (!user) return error(res, 401, 'unauthorized', 'sign in to view an order');

	const order = await getOrderWithEvents(id);
	if (!order || order.user_id !== user.id) {
		return error(res, 404, 'not_found', 'no such print order');
	}

	return json(
		res,
		200,
		{
			order: publicOrder(order),
			events: order.events.map((e) => ({
				status: e.status,
				note: e.note,
				actor: e.actor,
				created_at: e.created_at,
			})),
		},
		{ 'cache-control': 'no-store' },
	);
});
