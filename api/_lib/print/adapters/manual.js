// @ts-check
// The `manual` fulfillment adapter: the launch lane.
//
// There is nothing simulated here. A print marketplace's first fulfillment lane
// is always a human: an operator takes the prepared STL/3MF off the queue,
// runs it on a real bureau's machines (or their own), and reports what
// happened. This adapter is the machine-readable face of that person. Its
// submit() puts the job on the operator's queue and pages the operator channel;
// its status() reads back what the operator recorded through the console.
//
// Consequences worth stating, because they are what makes this honest rather
// than a stub:
//   • The provider order id IS our order id. There is no second system, so
//     inventing an opaque handle would be a fiction the operator then has to
//     translate back by hand.
//   • status() is a database read, not a network call. The operator console's
//     transitions are the source of truth, so polling this adapter always
//     agrees with the order it is polling. That is exactly what the
//     reconciliation sweep needs to leave manual jobs alone until they are late.
//   • There is no webhook. verifyWebhook() refuses every delivery rather than
//     leaving an unauthenticated door open on a provider that cannot call it.

import { getOrder } from '../../print-store.js';
import { jobSummaryLines, notifyOperators } from '../ops-notify.js';

export const key = 'manual';
export const label = 'Manual fulfillment (operator console)';

export const capabilities = Object.freeze({
	// A human with a bureau relationship can run anything the catalog offers;
	// the constraint is the part, not the lane.
	materials: '*',
	// The largest build envelope reachable across the resin and SLS machines a
	// bureau operator routes to. A part larger than this needs splitting, which
	// is out of launch scope (00-CONTEXT: multi-part assemblies are later).
	maxBboxMm: { x: 380, y: 380, z: 600 },
	shipsFrom: 'US',
	// Hand-run jobs carry a bureau queue plus shipping. Ten days is the point
	// past which an operator should be asked what happened, not a promise to
	// the buyer: the buyer's estimate comes from the catalog's per-material
	// lead time in the quote.
	leadTimeDays: 10,
});

/** Always available: this lane needs a person, not a credential. */
export function configured() {
	return true;
}

/**
 * Put the job on the operator queue and page the channel.
 * @param {object} order
 * @param {{ stl?: string, '3mf'?: string, glb?: string }} [assets]
 */
export async function submit(order, assets = {}) {
	const formats = Object.keys(assets || {}).filter((k) => assets[k]);
	await notifyOperators({
		title: 'New print job ready to submit',
		lines: [
			...jobSummaryLines(order),
			formats.length ? `Prepared: ${formats.join(', ')}` : 'Prepared assets missing: check the order before running it',
		],
		orderId: order?.id,
	});
	return {
		providerOrderId: String(order?.id || ''),
		status: 'submitted',
		leadTimeDays: capabilities.leadTimeDays,
		note: 'Queued for the operator console.',
		state: { lane: 'manual', queued_at: new Date().toISOString(), formats },
	};
}

/**
 * What the operator has recorded. A read of our own order row, which for this
 * lane is the provider's system of record.
 * @param {string} providerOrderId
 */
export async function status(providerOrderId) {
	const order = await getOrder(providerOrderId);
	if (!order) {
		// Not an error the sweep should retry: a manual job whose order is gone
		// has nothing left to reconcile.
		return { status: null, note: 'order not found', state: { lane: 'manual', missing: true } };
	}
	return {
		// The order already carries the operator's latest word, so reporting it
		// back is a no-op transition by construction. Returning null keeps the
		// sweep from attempting a self-transition it would only have to refuse.
		status: null,
		trackingNumber: order.tracking_number || '',
		carrier: order.carrier || '',
		note: `Operator lane, currently ${order.status}.`,
		state: { lane: 'manual', operator_status: order.status },
	};
}

/**
 * Tell the operator to stop. The order's own transition to `canceled` is the
 * console's job; this is the page that makes sure nobody keeps printing.
 * @param {object} order
 * @param {string} [reason]
 */
export async function cancel(order, reason = '') {
	await notifyOperators({
		title: 'Print job cancellation requested',
		lines: [...jobSummaryLines(order), reason ? `Reason: ${reason}` : 'No reason given'],
		orderId: order?.id,
	});
	return { ok: true, note: 'Operator notified to stop the job.', state: { lane: 'manual', cancel_requested: true } };
}

/**
 * The manual lane has no callback URL, so every delivery to it is either a
 * misrouted partner payload or someone probing. Refusing outright is the only
 * correct answer; a permissive default here would be an unauthenticated write
 * into the state machine.
 */
export function verifyWebhook() {
	return { ok: false, deliveryId: '', reason: 'the manual lane has no webhook; operators transition orders in the console' };
}

/** Unreachable in practice (verifyWebhook always refuses), and says so. */
export function parseWebhook() {
	throw new Error('manual adapter receives no webhooks');
}

export default { key, label, capabilities, configured, submit, status, cancel, verifyWebhook, parseWebhook };
