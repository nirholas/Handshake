// @ts-check
// Materialize order store: the one module that owns a physical print order's
// status.
//
// An order's status is a state machine. Every surface that moves an order
// (checkout, the operator console, a provider webhook, the reconciliation
// sweep) calls transitionOrder() and nothing else; no handler writes `status`
// directly. Two properties fall out of that and both are load-bearing:
//
//   1. An illegal move throws instead of corrupting the order. A provider that
//      reports "shipped" for a job we never submitted, or a double-clicked
//      operator button, is refused at the one place that can see the current
//      state.
//   2. The move is atomic. The UPDATE carries `where status = <expected>`, so
//      two concurrent callers racing the same transition produce exactly one
//      winner and one PrintTransitionError, without a lock or a transaction
//      spanning the event insert.
//
// History lives in print_order_events, appended per transition. No column is
// ever mutated to represent the past, so an order's story is reconstructable
// and an operator's note cannot be overwritten by the next status change.

import { sql, isDbUnavailableError } from './db.js';
import { databaseConfigured } from './env.js';
import { publishUserEvent } from './feed.js';

/** Every status the DB check constraint allows, in lifecycle order. */
export const PRINT_STATUSES = Object.freeze([
	'created',
	'quoted',
	'paid',
	'screening',
	'submitted',
	'printing',
	'quality_check',
	'shipped',
	'delivered',
	'rejected',
	'canceled',
	'refunded',
]);

/** Who caused a transition. Mirrors the print_order_events check constraint. */
export const PRINT_ACTORS = Object.freeze(['system', 'operator', 'provider', 'buyer']);

// The whitelist. Read it as "from → the only places it can go next".
//
// Money-relevant edges, spelled out because they are the ones people get wrong:
//   • `paid → screening` is automatic; screening is the fabrication-safety gate
//     that runs a second time after payment (00-CONTEXT, order 06).
//   • `screening → rejected` is the refusal path. `rejected → refunded` is the
//     operator closing it out; the on-chain send itself is owner-gated and
//     never happens inside this module.
//   • `quality_check → printing` exists because a failed QC is a re-print, not
//     a dead order. It is the one backwards edge and it is deliberate.
//   • `delivered → refunded` exists because returns happen after delivery.
//     Everything else out of `delivered` is closed.
const TRANSITIONS = Object.freeze({
	created: ['quoted', 'canceled'],
	quoted: ['paid', 'canceled'],
	paid: ['screening', 'canceled', 'refunded'],
	screening: ['submitted', 'rejected', 'canceled'],
	submitted: ['printing', 'canceled', 'rejected'],
	printing: ['quality_check', 'canceled', 'rejected'],
	quality_check: ['shipped', 'printing', 'rejected'],
	shipped: ['delivered', 'refunded'],
	delivered: ['refunded'],
	rejected: ['refunded'],
	canceled: ['refunded'],
	refunded: [],
});

/** Statuses from which nothing can move. Terminal in the strict sense. */
export const TERMINAL_STATUSES = Object.freeze(
	PRINT_STATUSES.filter((s) => TRANSITIONS[s].length === 0),
);

/**
 * Statuses where a fulfillment provider owns the job and the reconciliation
 * sweep should keep polling. Matches the print_orders_open_idx partial index.
 */
export const OPEN_PROVIDER_STATUSES = Object.freeze([
	'submitted',
	'printing',
	'quality_check',
	'shipped',
]);

/** Thrown when a caller asks for a move the machine does not allow. */
export class PrintTransitionError extends Error {
	/**
	 * @param {string} from
	 * @param {string} to
	 * @param {string} [detail]
	 */
	constructor(from, to, detail = '') {
		super(`illegal print order transition ${from} → ${to}${detail ? `: ${detail}` : ''}`);
		this.name = 'PrintTransitionError';
		this.code = 'illegal_transition';
		this.from = from;
		this.to = to;
	}
}

/** Thrown when the order id does not resolve. Separated so handlers can 404. */
export class PrintOrderNotFoundError extends Error {
	/** @param {string} orderId */
	constructor(orderId) {
		super(`print order not found: ${orderId}`);
		this.name = 'PrintOrderNotFoundError';
		this.code = 'not_found';
		this.orderId = orderId;
	}
}

/** True when this deployment can persist orders at all. */
export function printStoreEnabled() {
	return Boolean(databaseConfigured());
}

/** @param {string} status */
export function isPrintStatus(status) {
	return PRINT_STATUSES.includes(status);
}

/** @param {string} status */
export function isTerminalStatus(status) {
	return TERMINAL_STATUSES.includes(status);
}

/**
 * The moves allowed out of a status. Returns a copy so a caller cannot mutate
 * the machine; an unknown status yields an empty list rather than throwing,
 * because the console renders this to build its action buttons.
 * @param {string} status
 * @returns {string[]}
 */
export function allowedTransitions(status) {
	return [...(TRANSITIONS[status] || [])];
}

/**
 * @param {string} from
 * @param {string} to
 */
export function canTransition(from, to) {
	return allowedTransitions(from).includes(to);
}

/**
 * Throws PrintTransitionError unless `from → to` is on the whitelist. Exported
 * so callers (and tests) can check a move without touching the database.
 * @param {string} from
 * @param {string} to
 */
export function assertTransition(from, to) {
	if (!isPrintStatus(to)) throw new PrintTransitionError(from, to, 'unknown status');
	if (!canTransition(from, to)) throw new PrintTransitionError(from, to);
}

// Columns a transition is allowed to set alongside the status. Anything else a
// caller passes in `patch` is dropped rather than interpolated: this list is
// the whole write surface of a status change, so a provider payload can never
// reach a column nobody vetted.
const PATCHABLE = Object.freeze([
	'provider',
	'provider_order_id',
	'provider_state',
	'tracking_number',
	'carrier',
	'lead_time_days',
	'submitted_at',
	'stall_alerted_at',
	'shipping',
]);

const JSONB_COLUMNS = new Set(['provider_state', 'shipping', 'quote', 'analysis', 'prepared_asset_urls']);

// Literal column expressions for every patchable key. Keeping them as data
// (rather than interpolating `key`) means a future patchable column has to be
// added here on purpose, and a typo fails loudly at import instead of emitting
// a query with an attacker-shaped identifier.
const COLUMN_SQL = Object.freeze({
	provider: 'provider',
	provider_order_id: 'provider_order_id',
	provider_state: 'provider_state',
	tracking_number: 'tracking_number',
	carrier: 'carrier',
	lead_time_days: 'lead_time_days',
	submitted_at: 'submitted_at',
	stall_alerted_at: 'stall_alerted_at',
	shipping: 'shipping',
});

/**
 * Build the `set` fragment for the patched columns. Returns null when nothing
 * survives the whitelist, which the caller reads as "status only".
 * @param {Record<string, unknown>} patch
 */
function patchFragment(patch) {
	const entries = Object.entries(patch || {}).filter(([k]) => PATCHABLE.includes(k));
	if (entries.length === 0) return null;
	return entries.reduce((acc, [key, value], i) => {
		const bound = JSONB_COLUMNS.has(key) ? JSON.stringify(value ?? {}) : value;
		// sql.unsafe is not available on the Neon HTTP driver, and the key here is
		// never caller-controlled (it survived the PATCHABLE whitelist above), so
		// the column name is spliced by an explicit switch-free lookup instead.
		const frag = sql([`, ${COLUMN_SQL[key]} = `, ''], bound);
		return i === 0 ? frag : sql(['', ''], acc, frag);
	}, null);
}

/** Columns every read returns. Excludes nothing: the console needs all of it. */
const ORDER_COLUMNS = sql([
	`id, user_id, payer_wallet, creation_id, source_glb_url, prepared_asset_urls, analysis,
	 material_id, target_height_mm, quantity, quote, price_usdc, status, provider,
	 provider_order_id, provider_state, shipping, tracking_number, carrier, lead_time_days,
	 submitted_at, stall_alerted_at, created_at, updated_at`,
]);

/**
 * @param {string} orderId
 * @returns {Promise<object|null>}
 */
export async function getOrder(orderId) {
	if (!printStoreEnabled() || !orderId) return null;
	const rows = await sql`select ${ORDER_COLUMNS} from print_orders where id = ${orderId}`;
	return rows[0] || null;
}

/**
 * Resolve an order by the provider's own identifier. This is how a webhook
 * finds the job: a partner knows their id, never ours.
 * @param {string} provider
 * @param {string} providerOrderId
 */
export async function getOrderByProviderId(provider, providerOrderId) {
	if (!printStoreEnabled() || !provider || !providerOrderId) return null;
	const rows = await sql`
		select ${ORDER_COLUMNS} from print_orders
		where provider = ${provider} and provider_order_id = ${providerOrderId}`;
	return rows[0] || null;
}

/**
 * The operator queue. `status` may be a single status, a list, or omitted for
 * everything. Newest first, which is the order the console renders.
 * @param {{ status?: string|string[], limit?: number, offset?: number }} [opts]
 */
export async function listOrders({ status, limit = 50, offset = 0 } = {}) {
	if (!printStoreEnabled()) return [];
	const statuses = (Array.isArray(status) ? status : status ? [status] : []).filter(isPrintStatus);
	const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
	const skip = Math.max(Number(offset) || 0, 0);
	const where = statuses.length ? sql`where status = any(${statuses})` : sql`where true`;
	return sql`
		select ${ORDER_COLUMNS} from print_orders
		${where}
		order by created_at desc
		limit ${cap} offset ${skip}`;
}

/** Per-status counts for the console's queue rail. Returns a plain object. */
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
 * The timeline, oldest first: the order in which a human reads a story.
 * @param {string} orderId
 */
export async function listOrderEvents(orderId) {
	if (!printStoreEnabled() || !orderId) return [];
	return sql`
		select id, order_id, status, note, actor, actor_id, created_at
		from print_order_events
		where order_id = ${orderId}
		order by created_at asc, id asc`;
}

/**
 * Append a timeline row without changing the order's status. Used for notes an
 * operator leaves on a job that is not moving yet, and for the provider's
 * "still printing" heartbeats.
 * @param {{ orderId: string, status: string, note?: string, actor?: string, actorId?: string|null }} input
 */
export async function appendOrderEvent({ orderId, status, note = '', actor = 'system', actorId = null }) {
	if (!printStoreEnabled()) return null;
	const safeActor = PRINT_ACTORS.includes(actor) ? actor : 'system';
	const rows = await sql`
		insert into print_order_events (order_id, status, note, actor, actor_id)
		values (${orderId}, ${status}, ${note ? String(note).slice(0, 2000) : null}, ${safeActor}, ${actorId})
		returning id, order_id, status, note, actor, actor_id, created_at`;
	return rows[0] || null;
}

// What a buyer is told, per status. A status with no line here is internal
// plumbing the buyer has no reason to see (`screening` is deliberately quiet:
// telling someone their model is being safety-checked invites a fight with a
// gate that has already decided).
const BUYER_NOTICE = Object.freeze({
	submitted: 'Your print is with the fulfillment lane.',
	printing: 'Your print is on the machine.',
	quality_check: 'Your print is finished and in quality check.',
	shipped: 'Your print has shipped.',
	delivered: 'Your print was delivered.',
	rejected: 'Your print order could not be fulfilled.',
	canceled: 'Your print order was canceled.',
	refunded: 'Your print order was refunded.',
});

/**
 * Move an order. The whole write surface of a status change.
 *
 * Concurrency: the UPDATE matches on the expected current status, so a lost
 * race updates zero rows and raises PrintTransitionError with the state the
 * winner left behind. Callers that legitimately race (a webhook and the
 * reconciliation sweep reporting the same provider event) treat that as a
 * no-op, which is why `expect` is separable from `to`.
 *
 * @param {object} input
 * @param {string} input.orderId
 * @param {string} input.to             target status
 * @param {string} [input.note]         free text stored on the timeline row
 * @param {string} [input.actor]        system | operator | provider | buyer
 * @param {string|null} [input.actorId] the operator's user id, when actor='operator'
 * @param {Record<string, unknown>} [input.patch] whitelisted columns to set with the move
 * @returns {Promise<{ order: object, event: object|null }>}
 */
export async function transitionOrder({ orderId, to, note = '', actor = 'system', actorId = null, patch = {} }) {
	if (!printStoreEnabled()) throw new Error('print store requires a configured database');
	const current = await getOrder(orderId);
	if (!current) throw new PrintOrderNotFoundError(orderId);

	assertTransition(current.status, to);

	const extra = patchFragment(patch);
	const rows = await sql`
		update print_orders
		set status = ${to}${extra || sql([''])}
		where id = ${orderId} and status = ${current.status}
		returning ${ORDER_COLUMNS}`;

	if (rows.length === 0) {
		// Somebody else moved it between our read and our write.
		const now = await getOrder(orderId);
		throw new PrintTransitionError(current.status, to, `order is now '${now?.status || 'gone'}'`);
	}

	const order = rows[0];
	const event = await appendOrderEvent({ orderId, status: to, note, actor, actorId });
	notifyBuyer(order, to);
	return { order, event };
}

/**
 * Tell the buyer, in their notification bell, that their order moved. Silent
 * for agent orders (no user id to notify) and for statuses with no buyer-facing
 * line. Fire-and-forget by contract: publishUserEvent never throws.
 * @param {object} order
 * @param {string} status
 */
function notifyBuyer(order, status) {
	const line = BUYER_NOTICE[status];
	if (!line || !order?.user_id) return;
	publishUserEvent(order.user_id, {
		type: 'print',
		status,
		order_id: order.id,
		message: line,
		tracking_number: order.tracking_number || null,
		link: `/materialize/orders/${order.id}`,
	});
}

/**
 * Orders a provider owns that have been quiet longer than their declared lead
 * time. The reconciliation sweep's working set.
 *
 * `graceDays` is added on top of the order's own lead_time_days, so a job is
 * only a stall once it is late by a margin, not the moment it hits its
 * estimate. Orders already alerted within `realertHours` are excluded, which is
 * what stops a stuck job paging the operator every five minutes.
 *
 * @param {{ graceDays?: number, realertHours?: number, limit?: number }} [opts]
 */
export async function listStalledOrders({ graceDays = 2, realertHours = 24, limit = 50 } = {}) {
	if (!printStoreEnabled()) return [];
	const grace = Math.max(Number(graceDays) || 0, 0);
	const realert = Math.max(Number(realertHours) || 0, 0);
	const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
	return sql`
		select ${ORDER_COLUMNS} from print_orders
		where status = any(${[...OPEN_PROVIDER_STATUSES]})
		  and submitted_at is not null
		  and submitted_at < now() - make_interval(days => (coalesce(lead_time_days, 0) + ${grace})::int)
		  and (stall_alerted_at is null or stall_alerted_at < now() - make_interval(hours => ${realert}::int))
		order by submitted_at asc
		limit ${cap}`;
}

/**
 * Orders a provider owns, for the reconciliation poll. Unlike listStalledOrders
 * this returns everything live, late or not: polling is how we learn a job
 * shipped when a webhook was lost.
 * @param {{ limit?: number }} [opts]
 */
export async function listOpenProviderOrders({ limit = 100 } = {}) {
	if (!printStoreEnabled()) return [];
	const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
	return sql`
		select ${ORDER_COLUMNS} from print_orders
		where status = any(${[...OPEN_PROVIDER_STATUSES]})
		  and provider is not null
		  and provider_order_id is not null
		order by submitted_at asc nulls first
		limit ${cap}`;
}

/**
 * Record that the operator has been told about a stalled order, so the next
 * sweep stays quiet. Deliberately not a transition: nothing about the order's
 * lifecycle changed.
 * @param {string[]} orderIds
 */
export async function markStallAlerted(orderIds) {
	if (!printStoreEnabled() || !orderIds?.length) return 0;
	const rows = await sql`
		update print_orders set stall_alerted_at = now()
		where id = any(${orderIds})
		returning id`;
	return rows.length;
}

/**
 * Claim a webhook delivery. Returns true exactly once per (provider,
 * delivery_id) pair: the insert is the lock, so a provider retrying a delivery
 * (every serious one does) cannot append the timeline row twice even if two
 * retries land concurrently on two containers.
 *
 * @param {{ provider: string, deliveryId: string, orderId?: string|null }} input
 * @returns {Promise<{ fresh: boolean }>}
 */
export async function claimWebhookDelivery({ provider, deliveryId, orderId = null }) {
	if (!printStoreEnabled()) throw new Error('webhook idempotency requires a configured database');
	const rows = await sql`
		insert into print_webhook_deliveries (provider, delivery_id, order_id)
		values (${provider}, ${deliveryId}, ${orderId})
		on conflict (provider, delivery_id) do nothing
		returning delivery_id`;
	return { fresh: rows.length > 0 };
}

/**
 * Mark a claimed delivery as having actually driven a state change, so an
 * operator reading the ledger can tell "we saw it and it was a duplicate" from
 * "we saw it and it moved the order".
 * @param {{ provider: string, deliveryId: string, orderId?: string|null }} input
 */
export async function markWebhookApplied({ provider, deliveryId, orderId = null }) {
	if (!printStoreEnabled()) return;
	await sql`
		update print_webhook_deliveries
		set applied = true, order_id = coalesce(${orderId}, order_id)
		where provider = ${provider} and delivery_id = ${deliveryId}`;
}

/** Deliveries recorded for an order, newest first. Diagnostic read. */
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

export { isDbUnavailableError };
