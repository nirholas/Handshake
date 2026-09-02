// @ts-check
// Fulfillment orchestration: the one place adapter output meets the state
// machine.
//
// Adapters speak; the store decides. Every path in here takes a normalized
// adapter result and turns it into at most one transitionOrder() call, so the
// rules about what may follow what live in print-store.js and nowhere else.
//
// The interesting case is a provider reporting something the machine refuses:
// a partner announcing "shipped" for a job we already refunded, or a webhook
// arriving out of order after a later one already landed. That is not an
// exception to propagate to the provider (they would retry it forever) and not
// something to silently drop (an operator needs to see it). It is recorded on
// the timeline as a provider event with the refusal in its note, and the HTTP
// caller gets a 200 that says `applied: false`.

import { sql } from '../db.js';
import { PrintStoreError, appendEvent, getOrder, transition } from '../print-store.js';
import {
	normalizeCancelResult,
	normalizeStatusResult,
	normalizeSubmitResult,
	adapterSupportsOrder,
} from './adapters/contract.js';
import { getAdapter, routeOrder } from './adapters/index.js';

/**
 * Hand a screened order to a fulfillment lane.
 *
 * @param {object} input
 * @param {object} input.order      the order row, status must be 'screening'
 * @param {string} [input.adapterKey] force a lane; omit to route by capability
 * @param {string} [input.actor]    who asked (operator | system)
 * @param {string|null} [input.actorId]
 * @returns {Promise<{ order: object, adapter: string, providerOrderId: string }>}
 */
export async function submitOrder({ order, adapterKey = '', actor = 'operator', actorId = null }) {
	const assets = order?.prepared_asset_urls || {};
	let adapter;
	if (adapterKey) {
		adapter = getAdapter(adapterKey);
		if (!adapter) throw new FulfillmentError('adapter_unavailable', `no configured adapter '${adapterKey}'`);
		const verdict = adapterSupportsOrder(adapter, order);
		if (!verdict.ok) throw new FulfillmentError('adapter_incapable', verdict.reason);
	} else {
		const routed = routeOrder(order);
		if (!routed.adapter) {
			const why = routed.declined.map((d) => `${d.key}: ${d.reason}`).join('; ') || 'no adapters are configured';
			throw new FulfillmentError('no_route', `no fulfillment lane can run this order (${why})`);
		}
		adapter = routed.adapter;
	}

	const raw = await adapter.submit(order, assets);
	const result = normalizeSubmitResult(adapter.key, raw);

	const { order: updated } = await transitionOrder({
		orderId: order.id,
		to: result.status,
		note: result.note || `Submitted to ${adapter.label}.`,
		actor,
		actorId,
		patch: {
			provider: adapter.key,
			provider_order_id: result.providerOrderId,
			provider_state: result.state,
			lead_time_days: result.leadTimeDays || adapter.capabilities.leadTimeDays,
			submitted_at: new Date().toISOString(),
			stall_alerted_at: null,
		},
	});

	return { order: updated, adapter: adapter.key, providerOrderId: result.providerOrderId };
}

/** A fulfillment routing/lane failure with a code a handler can map to HTTP. */
export class FulfillmentError extends Error {
	/** @param {string} code @param {string} message */
	constructor(code, message) {
		super(message);
		this.name = 'FulfillmentError';
		this.code = code;
	}
}

/**
 * Apply one provider-reported event (from a webhook or from a status poll) to
 * an order. Idempotent by construction: an event that reports the status the
 * order already has updates tracking and returns `applied: false`.
 *
 * @param {object} input
 * @param {object} input.order
 * @param {{ status: string|null, trackingNumber?: string, carrier?: string, note?: string, state?: object }} input.event
 * @param {string} [input.actor] provider | system
 * @returns {Promise<{ applied: boolean, order: object, reason: string }>}
 */
export async function applyProviderEvent({ order, event, actor = 'provider' }) {
	const patch = {};
	if (event.trackingNumber && event.trackingNumber !== order.tracking_number) patch.tracking_number = event.trackingNumber;
	if (event.carrier && event.carrier !== order.carrier) patch.carrier = event.carrier;
	if (event.state && Object.keys(event.state).length) patch.provider_state = event.state;

	// No status, or the status we already hold: this is news about the job, not
	// a move. Record what changed and stop.
	if (!event.status || event.status === order.status) {
		const changed = await patchOnly(order, patch);
		if (event.note) {
			await appendOrderEvent({
				orderId: order.id,
				status: order.status,
				note: event.note,
				actor,
			});
		}
		return { applied: false, order: changed, reason: event.status ? 'already in that status' : 'no status change reported' };
	}

	try {
		const { order: updated } = await transitionOrder({
			orderId: order.id,
			to: event.status,
			note: event.note || `Provider reported ${event.status}.`,
			actor,
			patch,
		});
		return { applied: true, order: updated, reason: '' };
	} catch (err) {
		if (err instanceof PrintTransitionError) {
			// Out-of-order or impossible: keep it on the timeline where an operator
			// will see it, and tell the caller it was not applied.
			await appendOrderEvent({
				orderId: order.id,
				status: order.status,
				note: `Refused provider report '${event.status}': ${err.message}`,
				actor,
			});
			const current = (await getOrder(order.id)) || order;
			return { applied: false, order: current, reason: err.message };
		}
		throw err;
	}
}

/**
 * Write patched columns without a status change. Used when a provider reports
 * a tracking number before (or after) the transition that carries it.
 * @param {object} order
 * @param {Record<string, unknown>} patch
 */
async function patchOnly(order, patch) {
	if (!patch || Object.keys(patch).length === 0) return order;
	// transitionOrder is the only writer of `status`; a no-op self transition is
	// not legal, so patch-only writes go through a dedicated statement here. It
	// touches no lifecycle column, which is why it does not need the machine.
	const rows = await sql`
		update print_orders set
			tracking_number = coalesce(${patch.tracking_number ?? null}, tracking_number),
			carrier = coalesce(${patch.carrier ?? null}, carrier),
			provider_state = coalesce(${patch.provider_state ? JSON.stringify(patch.provider_state) : null}::jsonb, provider_state)
		where id = ${order.id}
		returning *`;
	return rows[0] || order;
}

/**
 * Poll a lane for one order and apply whatever it says.
 * @param {object} order
 * @returns {Promise<{ applied: boolean, order: object, reason: string, polled: boolean }>}
 */
export async function reconcileOrder(order) {
	const adapter = getAdapter(order.provider);
	if (!adapter) {
		return { applied: false, order, reason: `adapter '${order.provider}' is not configured here`, polled: false };
	}
	const raw = await adapter.status(order.provider_order_id);
	const event = normalizeStatusResult(adapter.key, raw);
	const result = await applyProviderEvent({ order, event, actor: 'provider' });
	return { ...result, polled: true };
}

/**
 * Ask the lane to stop. The order's own move to `canceled` is the caller's, so
 * a provider that refuses cannot leave us claiming a cancellation we did not
 * get.
 * @param {object} order
 * @param {string} [reason]
 */
export async function cancelWithProvider(order, reason = '') {
	const adapter = getAdapter(order.provider);
	if (!adapter) return { ok: false, note: `adapter '${order.provider || 'none'}' is not configured here`, state: {} };
	const raw = await adapter.cancel(order, reason);
	return normalizeCancelResult(adapter.key, raw);
}
