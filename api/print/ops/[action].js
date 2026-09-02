// @ts-check
// Materialize operator console API: /api/print/ops/{queue,order,transition,
// submit,tracking,cancel,refund,adapters}.
//
// This is the working surface of the manual fulfillment lane. A human takes a
// paid, screened order off the queue here, hands the prepared files to a print
// bureau, and reports back what happened; every report is a transition through
// api/_lib/print-store.js, attributed to them on the order's timeline.
//
// AUTHORIZATION: every action calls requireOperator() before it reads anything.
// The page at /materialize/ops is a client of this API, never a gate in front
// of it. The gate fails closed in development too, because these responses
// carry shipping addresses.
//
// MONEY: `refund` marks the order refunded and records who decided it. It does
// NOT move funds. Sending USDC is a CLAUDE.md gate-1 action and stays with the
// owner, so the response renders the exact recipient and amount for them to
// execute and the timeline carries the decision either way.

import { error, json, method, readJson, wrap } from '../../_lib/http.js';
import { sql } from '../../_lib/db.js';
import { requireOperator } from '../../_lib/print/ops-auth.js';
import { PrintStoreError, appendEvent, getOrder, getOrderWithEvents, transition } from '../../_lib/print-store.js';
import {
	allowedTransitions,
	countOrdersByStatus,
	listOrders,
	listWebhookDeliveries,
	printStoreEnabled,
} from '../../_lib/print/fulfillment-queries.js';
import { adapterSummaries } from '../../_lib/print/adapters/index.js';
import { FulfillmentError, cancelWithProvider, submitOrder } from '../../_lib/print/fulfillment.js';
import { AdapterContractError, AdapterUpstreamError } from '../../_lib/print/adapters/contract.js';
import { notifyOperators } from '../../_lib/print/ops-notify.js';

/** Guard shared by every action: no database, no console. */
function requireStore(res) {
	if (printStoreEnabled()) return true;
	error(res, 503, 'not_configured', 'the fulfillment console needs a configured database');
	return false;
}

/** Read the order named by ?id= / body.order_id, 404ing when it does not exist. */
async function loadOrder(req, res, body = null) {
	const url = new URL(req.url, 'http://x');
	const id = String(body?.order_id || url.searchParams.get('id') || '').trim();
	if (!id) {
		error(res, 400, 'validation_error', 'order id is required');
		return null;
	}
	const order = await getOrder(id);
	if (!order) {
		error(res, 404, 'not_found', `no print order ${id}`);
		return null;
	}
	return order;
}

// ── queue ────────────────────────────────────────────────────────────────────

/**
 * GET /api/print/ops/queue?status=paid,screening&limit=50
 * The console's left rail (counts) and its list, in one read so the two can
 * never disagree.
 */
async function handleQueue(req, res) {
	const url = new URL(req.url, 'http://x');
	const statusParam = url.searchParams.get('status') || '';
	const statuses = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
	const limit = Number(url.searchParams.get('limit')) || 50;
	const offset = Number(url.searchParams.get('offset')) || 0;

	const [counts, orders] = await Promise.all([
		countOrdersByStatus(),
		listOrders({ status: statuses, limit, offset }),
	]);

	return json(res, 200, {
		counts,
		orders: orders.map(queueRow),
		adapters: adapterSummaries(),
	});
}

// The queue list deliberately omits the shipping address: a list view has no
// use for a street address, and not sending it is cheaper than redacting it in
// the browser. The detail view, which an operator opens on purpose, has it.
function queueRow(order) {
	return {
		id: order.id,
		status: order.status,
		material_id: order.material_id,
		quantity: order.quantity,
		target_height_mm: order.target_height_mm,
		price_usdc: order.price_usdc,
		provider: order.provider,
		provider_order_id: order.provider_order_id,
		tracking_number: order.tracking_number,
		carrier: order.carrier,
		lead_time_days: order.lead_time_days,
		ship_to_country: order.shipping?.country || null,
		submitted_at: order.submitted_at,
		created_at: order.created_at,
		updated_at: order.updated_at,
		next: allowedTransitions(order.status),
	};
}

// ── order detail ─────────────────────────────────────────────────────────────

/** GET /api/print/ops/order?id=… — everything needed to run one job. */
async function handleOrderDetail(req, res) {
	const order = await loadOrder(req, res);
	if (!order) return;
	const [withEvents, deliveries] = await Promise.all([
		getOrderWithEvents(order.id),
		listWebhookDeliveries(order.id),
	]);
	const { events, ...row } = withEvents || { ...order, events: [] };
	return json(res, 200, {
		order: { ...row, next: allowedTransitions(row.status) },
		events,
		webhook_deliveries: deliveries,
		adapters: adapterSummaries(),
	});
}

// ── transitions ──────────────────────────────────────────────────────────────

/**
 * POST /api/print/ops/transition { order_id, to, note }
 * The generic move. The store refuses anything not on the whitelist, so this
 * handler does not re-implement the rules; it maps the refusal to a 409.
 */
async function handleTransition(req, res, operator) {
	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'validation_error', 'JSON body required');
	const order = await loadOrder(req, res, body);
	if (!order) return;
	const to = String(body.to || '').trim();
	const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : '';

	// `submitted` has a lane behind it; routing it through the generic mover
	// would set a status with no provider attached.
	if (to === 'submitted') {
		return error(res, 400, 'validation_error', 'use /api/print/ops/submit to hand an order to a fulfillment lane');
	}

	const { order: updated, event } = await transition({
		orderId: order.id,
		to,
		note: note || `Operator moved the order to ${to}.`,
		actor: 'operator',
		actorId: operator.actorId,
	});
	return json(res, 200, { order: { ...updated, next: allowedTransitions(updated.status) }, event });
}

/** POST /api/print/ops/submit { order_id, adapter? } */
async function handleSubmit(req, res, operator) {
	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'validation_error', 'JSON body required');
	const order = await loadOrder(req, res, body);
	if (!order) return;

	const result = await submitOrder({
		order,
		adapterKey: String(body.adapter || '').trim(),
		actor: 'operator',
		actorId: operator.actorId,
	});
	return json(res, 200, {
		order: { ...result.order, next: allowedTransitions(result.order.status) },
		adapter: result.adapter,
		provider_order_id: result.providerOrderId,
	});
}

/**
 * POST /api/print/ops/tracking { order_id, tracking_number, carrier, note, ship }
 * Entering a tracking number is the moment a job becomes shipped, so `ship`
 * (default true) performs the transition in the same call. An operator who is
 * only correcting a typo passes ship: false.
 */
async function handleTracking(req, res, operator) {
	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'validation_error', 'JSON body required');
	const order = await loadOrder(req, res, body);
	if (!order) return;

	const trackingNumber = String(body.tracking_number || '').trim().slice(0, 120);
	const carrier = String(body.carrier || '').trim().slice(0, 120);
	if (!trackingNumber) return error(res, 400, 'validation_error', 'tracking_number is required');

	const ship = body.ship !== false && order.status !== 'shipped';
	const note = typeof body.note === 'string' && body.note.trim()
		? body.note.slice(0, 2000)
		: `Tracking ${trackingNumber}${carrier ? ` via ${carrier}` : ''}.`;

	if (ship) {
		const { order: updated, event } = await transition({
			orderId: order.id,
			to: 'shipped',
			note,
			actor: 'operator',
			actorId: operator.actorId,
			patch: { tracking_number: trackingNumber, carrier: carrier || null },
		});
		return json(res, 200, { order: { ...updated, next: allowedTransitions(updated.status) }, event });
	}

	// Correction only: no lifecycle change, so no transition.
	const rows = await sql`
		update print_orders set tracking_number = ${trackingNumber}, carrier = ${carrier || null}
		where id = ${order.id} returning *`;
	const event = await appendEvent({
		orderId: order.id,
		status: order.status,
		note,
		actor: 'operator',
		actorId: operator.actorId,
	});
	return json(res, 200, { order: { ...rows[0], next: allowedTransitions(rows[0].status) }, event });
}

/**
 * POST /api/print/ops/cancel { order_id, reason }
 * Tells the lane to stop first, then moves the order. If the provider refuses,
 * the order is not moved: claiming a cancellation we did not get is worse than
 * an order stuck in `printing` that an operator can see and chase.
 */
async function handleCancel(req, res, operator) {
	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'validation_error', 'JSON body required');
	const order = await loadOrder(req, res, body);
	if (!order) return;
	const reason = String(body.reason || '').slice(0, 2000);

	let providerNote = 'No fulfillment lane had the job yet.';
	if (order.provider && order.provider_order_id) {
		const result = await cancelWithProvider(order, reason);
		if (!result.ok) {
			await appendEvent({
				orderId: order.id,
				status: order.status,
				note: `Cancellation refused by ${order.provider}: ${result.note}`,
				actor: 'operator',
				actorId: operator.actorId,
			});
			return error(res, 409, 'provider_refused', `${order.provider} did not accept the cancellation: ${result.note}`);
		}
		providerNote = result.note;
	}

	const { order: updated, event } = await transition({
		orderId: order.id,
		to: 'canceled',
		note: reason ? `Canceled: ${reason}. ${providerNote}` : `Canceled by operator. ${providerNote}`,
		actor: 'operator',
		actorId: operator.actorId,
	});
	return json(res, 200, { order: { ...updated, next: allowedTransitions(updated.status) }, event });
}

/**
 * POST /api/print/ops/refund { order_id, note }
 * Marks the order refunded and records the decision. The USDC send itself is
 * owner-executed (CLAUDE.md gate 1), so the response carries the exact payout
 * instruction rather than performing it.
 */
async function handleRefund(req, res, operator) {
	const body = await readJson(req).catch(() => null);
	if (!body) return error(res, 400, 'validation_error', 'JSON body required');
	const order = await loadOrder(req, res, body);
	if (!order) return;
	const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : '';

	const recipient = order.payer_wallet || null;
	const { order: updated, event } = await transition({
		orderId: order.id,
		to: 'refunded',
		note: note || 'Refund approved by operator.',
		actor: 'operator',
		actorId: operator.actorId,
	});

	await notifyOperators({
		title: 'Print order marked refunded',
		lines: [
			`Order ${order.id.slice(0, 8)} · ${Number(order.price_usdc || 0).toFixed(2)} USDC`,
			recipient ? `Send to ${recipient} (Solana USDC)` : 'Payer is a platform account: refund through the account ledger',
		],
		orderId: order.id,
	});

	return json(res, 200, {
		order: { ...updated, next: allowedTransitions(updated.status) },
		event,
		// The owner action, spelled out. Nothing here moves money.
		payout: {
			required: true,
			executed: false,
			amount_usdc: order.price_usdc,
			recipient,
			chain: 'solana',
			asset: 'USDC',
			instruction: recipient
				? 'Owner-executed: send this amount of USDC on Solana to the recipient, then note the signature on the order.'
				: 'Owner-executed: this order was paid from a platform session, refund through the account ledger.',
		},
	});
}

/** GET /api/print/ops/adapters — the lanes this deployment can route to. */
async function handleAdapters(_req, res) {
	return json(res, 200, { adapters: adapterSummaries() });
}

// ── dispatcher ───────────────────────────────────────────────────────────────

const DISPATCH = {
	queue: { methods: ['GET'], fn: handleQueue },
	order: { methods: ['GET'], fn: handleOrderDetail },
	adapters: { methods: ['GET'], fn: handleAdapters },
	transition: { methods: ['POST'], fn: handleTransition },
	submit: { methods: ['POST'], fn: handleSubmit },
	tracking: { methods: ['POST'], fn: handleTracking },
	cancel: { methods: ['POST'], fn: handleCancel },
	refund: { methods: ['POST'], fn: handleRefund },
};

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
	const route = DISPATCH[action];
	if (!route) return error(res, 404, 'not_found', `unknown fulfillment action: ${action}`);
	if (!method(req, res, route.methods)) return;

	// Authorization BEFORE anything else reads an order. Every action, no
	// exceptions, including the read-only ones: the queue carries order ids and
	// the detail carries a shipping address.
	const operator = await requireOperator(req, res);
	if (!operator) return;
	if (!requireStore(res)) return;

	try {
		return await route.fn(req, res, operator);
	} catch (err) {
		if (err instanceof PrintStoreError) {
			const status = err.code === 'order_not_found' ? 404 : 409;
			return error(res, status, err.code, err.message);
		}
		if (err instanceof FulfillmentError) return error(res, 409, err.code, err.message);
		if (err instanceof AdapterUpstreamError) return error(res, 502, 'provider_unreachable', err.message);
		if (err instanceof AdapterContractError) return error(res, 502, 'provider_contract', err.message);
		throw err;
	}
});
