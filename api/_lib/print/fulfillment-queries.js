// @ts-check
// The reads and the ledger the fulfillment lane needs, alongside the state
// machine rather than inside it.
//
// api/_lib/print-store.js owns one thing: moving an order from one status to
// the next, and everything that must happen when it does. This module owns the
// questions fulfillment asks about orders it is not moving: what is in the
// operator queue, which jobs a provider still owes us, which of those are late,
// and whether we have already seen a given webhook delivery.
//
// Keeping them apart matters. The store is the file every reviewer reads to
// learn the rules; padding it with queue pagination and a delivery ledger makes
// those rules harder to see, and a read that does not transition an order has
// no business living next to the code that does.

import { sql } from '../db.js';
import { databaseConfigured } from '../env.js';
import { LEGAL_TRANSITIONS, PRINT_STATUSES } from '../print-store.js';

/** True when this deployment can persist orders at all. */
export function printStoreEnabled() {
	return Boolean(databaseConfigured());
}

/**
 * Statuses a fulfillment provider is allowed to drive. Everything before
 * `submitted` is ours (quoting, payment, safety screening) and no adapter may
 * reach back into it; `refunded` is a money decision and stays operator-only.
 */
export const ADAPTER_DRIVABLE_STATUSES = Object.freeze([
	'submitted', 'printing', 'quality_check', 'shipped', 'delivered', 'canceled', 'rejected',
]);

/**
 * Statuses where a provider owns the job and the reconciliation sweep should
 * keep polling. Matches the print_orders_open_idx partial index.
 */
export const OPEN_PROVIDER_STATUSES = Object.freeze(['submitted', 'printing', 'quality_check', 'shipped']);

/**
 * The moves allowed out of a status, as a fresh array so a caller cannot mutate
 * the machine. The console renders this to build its action buttons, which is
 * why an unknown status yields an empty list instead of throwing.
 * @param {string} status
 * @returns {string[]}
 */
export function allowedTransitions(status) {
	return [...(LEGAL_TRANSITIONS[status] || [])];
}

/**
 * The operator queue. `status` may be one status, a list, or omitted for
 * everything. Newest first, which is the order the console renders.
 * @param {{ status?: string|string[], limit?: number, offset?: number }} [opts]
 */
export async function listOrders({ status, limit = 50, offset = 0 } = {}) {
	if (!printStoreEnabled()) return [];
	const statuses = (Array.isArray(status) ? status : status ? [status] : []).filter((s) => PRINT_STATUSES.includes(s));
	const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
	const skip = Math.max(Number(offset) || 0, 0);
	const where = statuses.length ? sql`where status = any(${statuses})` : sql`where true`;
	return sql`select * from print_orders ${where} order by created_at desc limit ${cap} offset ${skip}`;
}

/** Per-status counts for the console's queue rail. Every status is present. */
export async function countOrdersByStatus() {
	if (!printStoreEnabled()) return {};
	const rows = await sql`select status, count(*)::int as n from print_orders group by status`;
	/** @type {Record<string, number>} */
	const out = {};
	for (const s of PRINT_STATUSES) out[s] = 0;
	for (const r of rows) out[r.status] = r.n;
	return out;
}

/**
 * Resolve an order by the provider's own identifier. This is how a webhook
 * finds the job: a partner knows their id, never ours.
 * @param {string} provider
 * @param {string} providerOrderId
 */
export async function getOrderByProviderId(provider, providerOrderId) {
	if (!printStoreEnabled() || !provider || !providerOrderId) return null;
	const [row] = await sql`
		select * from print_orders
		where provider = ${provider} and provider_order_id = ${providerOrderId}
		limit 1`;
	return row || null;
}

/**
 * Live jobs a provider owns, for the reconciliation poll. Late or not: polling
 * is how we learn a job shipped when a webhook was lost.
 * @param {{ limit?: number }} [opts]
 */
export async function listOpenProviderOrders({ limit = 100 } = {}) {
	if (!printStoreEnabled()) return [];
	const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
	return sql`
		select * from print_orders
		where status = any(${[...OPEN_PROVIDER_STATUSES]})
		  and provider is not null
		  and provider_order_id is not null
		order by submitted_at asc nulls first
		limit ${cap}`;
}

/**
 * Jobs a provider has been quiet on for longer than their declared lead time.
 *
 * `graceDays` is added on top of the order's own lead_time_days, so a job is a
 * stall only once it is late by a margin, not the moment it hits its estimate.
 * Orders alerted within `realertHours` are excluded, which is what stops one
 * stuck job paging the operator on every sweep.
 *
 * @param {{ graceDays?: number, realertHours?: number, limit?: number }} [opts]
 */
export async function listStalledOrders({ graceDays = 2, realertHours = 24, limit = 50 } = {}) {
	if (!printStoreEnabled()) return [];
	const grace = Math.max(Number(graceDays) || 0, 0);
	const realert = Math.max(Number(realertHours) || 0, 0);
	const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
	return sql`
		select * from print_orders
		where status = any(${[...OPEN_PROVIDER_STATUSES]})
		  and submitted_at is not null
		  and submitted_at < now() - make_interval(days => (coalesce(lead_time_days, 0) + ${grace})::int)
		  and (stall_alerted_at is null or stall_alerted_at < now() - make_interval(hours => ${realert}::int))
		order by submitted_at asc
		limit ${cap}`;
}

/**
 * Record that the operator has been told about a stalled order. Deliberately
 * not a transition: nothing about the order's lifecycle changed.
 * @param {string[]} orderIds
 */
export async function markStallAlerted(orderIds) {
	if (!printStoreEnabled() || !orderIds?.length) return 0;
	const rows = await sql`update print_orders set stall_alerted_at = now() where id = any(${orderIds}) returning id`;
	return rows.length;
}

/**
 * Write the provider's last-seen payload and shipment details WITHOUT a status
 * change, for the case where a provider reports news that is not a move (a
 * tracking number that arrives before the shipment event, a heartbeat).
 *
 * provider_state is diagnostic only: nothing reads it to make a decision, which
 * is what keeps a partner changing their payload shape from being able to break
 * the state machine.
 *
 * @param {string} orderId
 * @param {{ tracking_number?: string, carrier?: string, provider_state?: object }} patch
 */
export async function patchProviderDetails(orderId, patch = {}) {
	if (!printStoreEnabled()) return null;
	const [row] = await sql`
		update print_orders set
			tracking_number = coalesce(${patch.tracking_number ?? null}, tracking_number),
			carrier         = coalesce(${patch.carrier ?? null}, carrier),
			provider_state  = coalesce(${patch.provider_state ? JSON.stringify(patch.provider_state) : null}::jsonb, provider_state),
			updated_at      = now()
		where id = ${orderId}
		returning *`;
	return row || null;
}

// ── webhook idempotency ledger ───────────────────────────────────────────────

/**
 * Claim a webhook delivery. Returns fresh: true exactly once per (provider,
 * delivery_id) pair. The insert IS the lock, so a provider retrying a delivery
 * (every serious one does) cannot append the timeline row twice even when two
 * retries land concurrently on two containers.
 *
 * @param {{ provider: string, deliveryId: string, orderId?: string|null }} input
 * @returns {Promise<{ fresh: boolean }>}
 */
export async function claimWebhookDelivery({ provider, deliveryId, orderId = null }) {
	const rows = await sql`
		insert into print_webhook_deliveries (provider, delivery_id, order_id)
		values (${provider}, ${deliveryId}, ${orderId})
		on conflict (provider, delivery_id) do nothing
		returning delivery_id`;
	return { fresh: rows.length > 0 };
}

/**
 * Mark a claimed delivery as having actually driven a change, so an operator
 * reading the ledger can tell "seen and duplicate" from "seen and it moved the
 * order".
 * @param {{ provider: string, deliveryId: string, orderId?: string|null }} input
 */
export async function markWebhookApplied({ provider, deliveryId, orderId = null }) {
	await sql`
		update print_webhook_deliveries
		set applied = true, order_id = coalesce(${orderId}, order_id)
		where provider = ${provider} and delivery_id = ${deliveryId}`;
}

/**
 * Deliveries recorded against an order, newest first. Diagnostic read for the
 * console: "did their webhook actually reach us?" is the first question when a
 * job looks stuck.
 * @param {string} orderId
 * @param {number} [limit]
 */
export async function listWebhookDeliveries(orderId, limit = 50) {
	if (!printStoreEnabled() || !orderId) return [];
	const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
	return sql`
		select provider, delivery_id, applied, received_at
		from print_webhook_deliveries
		where order_id = ${orderId}
		order by received_at desc
		limit ${cap}`;
}
