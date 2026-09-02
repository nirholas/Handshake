// @ts-check
// The Materialize order state machine: the one module allowed to move a print
// order from one status to the next.
//
// The database carries the vocabulary as a check constraint so no handler can
// invent a state; the legal MOVES live here, next to the events they emit,
// because a transition is never just a column write. Every accepted move
// appends a print_order_events row (the timeline is that table, never a mutated
// column) and, where the buyer is a signed-in human, publishes one user
// notification. An illegal move throws rather than silently no-ops, because a
// silently ignored transition is how an order goes quiet forever.
//
// Reaching `shipped` also issues the order's certificate: the SHA-256 of the
// printed bytes, the edition number, and a Solana memo attesting both
// (api/_lib/print/certificate.js). That side effect is deliberately hung off
// the transition rather than polled, so the certificate exists the moment the
// box does. It is fail-soft: a certificate that cannot attest right now is
// retried by api/cron/print-orders-sync.js, and a shipment is never blocked by
// an RPC having a bad minute.
//
// createOrder() opens an order from a verified quote token and nothing else:
// the price, the geometry and the material all come out of the token's signed
// payload, never out of the request, so neither checkout lane can be talked
// into a price this server did not sign.

import { sql } from './db.js';
import { publishUserEvent } from './feed.js';
import { issueCertificateForOrder } from './print/certificate.js';
import { assertEditionAvailable } from './print/editions.js';

/** Every status the print_orders check constraint accepts. */
export const PRINT_STATUSES = Object.freeze([
	'created', 'quoted', 'paid', 'screening', 'submitted', 'printing',
	'quality_check', 'shipped', 'delivered', 'rejected', 'canceled', 'refunded',
]);

/** Statuses nothing moves out of. */
export const TERMINAL_STATUSES = Object.freeze(['delivered', 'rejected', 'canceled', 'refunded']);

/**
 * The whitelist, as data. Read it as "from this status, only these are legal".
 * Anything absent is illegal, including a same-status write.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const LEGAL_TRANSITIONS = Object.freeze({
	created:       ['quoted', 'canceled'],
	quoted:        ['paid', 'canceled'],
	// A paid order is screened before a provider ever sees it; a failed screen
	// goes to rejected, which is the refund path's entry point.
	paid:          ['screening', 'canceled', 'refunded'],
	screening:     ['submitted', 'rejected', 'refunded'],
	submitted:     ['printing', 'quality_check', 'canceled', 'refunded'],
	printing:      ['quality_check', 'refunded'],
	quality_check: ['shipped', 'printing', 'refunded'],
	shipped:       ['delivered', 'refunded'],
	delivered:     [],
	rejected:      ['refunded'],
	canceled:      ['refunded'],
	refunded:      [],
});

/** Who caused a transition. Matches the print_order_events actor constraint. */
export const ACTORS = Object.freeze(['system', 'operator', 'provider', 'buyer']);

/** Typed failure so handlers map a cause to a status code. */
export class PrintStoreError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 * @param {Record<string, unknown>} [extra]
	 */
	constructor(code, message, extra = {}) {
		super(message);
		this.name = 'PrintStoreError';
		this.code = code;
		Object.assign(this, extra);
	}
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
	return (LEGAL_TRANSITIONS[from] || []).includes(to);
}

/** @param {string} id */
export async function getOrder(id) {
	const [row] = await sql`select * from print_orders where id = ${id} limit 1`;
	return row || null;
}

/** The order plus its timeline, oldest first. @param {string} id */
export async function getOrderWithEvents(id) {
	const order = await getOrder(id);
	if (!order) return null;
	const events = await sql`
		select status, note, actor, created_at
		from print_order_events where order_id = ${id} order by created_at asc
	`;
	return { ...order, events };
}

/**
 * Append a timeline row. Exported because an operator note about an order that
 * did not change status is still part of its story.
 * @param {{ orderId: string, status: string, note?: string|null, actor?: string, actorId?: string|null }} input
 */
export async function appendEvent({ orderId, status, note = null, actor = 'system', actorId = null }) {
	const who = ACTORS.includes(actor) ? actor : 'system';
	const [row] = await sql`
		insert into print_order_events (order_id, status, note, actor, actor_id)
		values (${orderId}, ${status}, ${note}, ${who}, ${actorId})
		returning id, status, note, actor, created_at
	`;
	return row;
}

/** Human-readable line for the buyer's notification bell. */
function notificationLine(status) {
	switch (status) {
		case 'paid':          return 'Payment received. Your print is queued for screening.';
		case 'screening':     return 'Your model is being checked for printability and safety.';
		case 'submitted':     return 'Your print has been sent to the production floor.';
		case 'printing':      return 'Your print is on the printer.';
		case 'quality_check': return 'Your print is finished and in quality check.';
		case 'shipped':       return 'Your print has shipped, with its certificate of authenticity.';
		case 'delivered':     return 'Your print was delivered.';
		case 'rejected':      return 'Your print could not be produced. A refund is being arranged.';
		case 'canceled':      return 'Your print order was canceled.';
		case 'refunded':      return 'Your print order was refunded.';
		default:              return null;
	}
}

/**
 * Move an order to a new status.
 *
 * @param {object} input
 * @param {string} input.orderId
 * @param {string} input.to                target status
 * @param {string} [input.note]            timeline note
 * @param {string} [input.actor]           system | operator | provider | buyer
 * @param {string|null} [input.actorId]    the operator's user id, when actor is 'operator'
 * @param {Record<string, unknown>} [input.patch] columns to write with the move
 *   (tracking_number, carrier, provider, provider_order_id, submitted_at,
 *   payment_signature, payment_chain, payment_amount_atomics)
 * @returns {Promise<{ order: any, event: any, certificate: any|null }>}
 */
export async function transition({ orderId, to, note = null, actor = 'system', actorId = null, patch = {} }) {
	if (!PRINT_STATUSES.includes(to)) {
		throw new PrintStoreError('unknown_status', `${to} is not a print order status`);
	}
	const order = await getOrder(orderId);
	if (!order) throw new PrintStoreError('order_not_found', `no print order ${orderId}`);
	if (!canTransition(order.status, to)) {
		throw new PrintStoreError(
			'illegal_transition',
			`a print order cannot go from ${order.status} to ${to}`,
			{ from: order.status, to },
		);
	}

	// Scarcity is enforced where the price is set, so a sold-out edition is
	// refused before a buyer is ever asked for money.
	//
	// An order printing a bare GLB is skipped, not failed: editions are numbered
	// against a creation, and an upload that belongs to no creation belongs to no
	// series, so there is nothing for it to be sold out of. Without this guard the
	// series key is underivable and a perfectly valid direct-upload order 500s at
	// the moment it is quoted.
	if (to === 'quoted' && order.creation_id) {
		await assertEditionAvailable({
			creationId: order.creation_id,
			quantity: order.quantity || 1,
		});
	}

	const [updated] = await sql`
		update print_orders set
			status            = ${to},
			provider          = coalesce(${patch.provider ?? null}, provider),
			provider_order_id = coalesce(${patch.provider_order_id ?? null}, provider_order_id),
			tracking_number   = coalesce(${patch.tracking_number ?? null}, tracking_number),
			carrier           = coalesce(${patch.carrier ?? null}, carrier),
			lead_time_days    = coalesce(${patch.lead_time_days ?? null}, lead_time_days),
			payment_signature = coalesce(${patch.payment_signature ?? null}, payment_signature),
			payment_chain     = coalesce(${patch.payment_chain ?? null}, payment_chain),
			payment_amount_atomics = coalesce(${patch.payment_amount_atomics ?? null}, payment_amount_atomics),
			submitted_at      = case when ${to} = 'submitted' then coalesce(submitted_at, now()) else submitted_at end,
			-- Stamped by the move itself rather than by the caller, so the paid
			-- time is always the time the order actually became paid.
			paid_at           = case when ${to} = 'paid' then coalesce(paid_at, now()) else paid_at end,
			stall_alerted_at  = null,
			updated_at        = now()
		where id = ${orderId} and status = ${order.status}
		returning *
	`;
	// The status guard in the WHERE clause is the concurrency lock: whoever
	// moved the order first wins, and the loser is told what actually happened
	// rather than overwriting it.
	if (!updated) {
		const current = await getOrder(orderId);
		throw new PrintStoreError(
			'transition_raced',
			`this order moved to ${current?.status} while the change to ${to} was in flight`,
			{ from: order.status, to, current: current?.status ?? null },
		);
	}

	const event = await appendEvent({ orderId, status: to, note, actor, actorId });

	let certificate = null;
	if (to === 'shipped') {
		try {
			const issued = await issueCertificateForOrder({ orderId });
			certificate = issued.certificate;
		} catch (err) {
			// A shipment is a physical fact; it is never rolled back because a
			// certificate could not be minted. The sweep picks this up.
			console.error('[print-store] certificate issuance failed for', orderId, err?.message);
			await appendEvent({
				orderId,
				status: to,
				note: `certificate issuance deferred: ${String(err?.message || err).slice(0, 300)}`,
				actor: 'system',
			});
		}
	}

	if (updated.user_id) {
		const line = notificationLine(to);
		if (line) {
			publishUserEvent(updated.user_id, {
				type: 'print_update',
				status: to,
				order_id: orderId,
				message: line,
				certificate_id: certificate?.id ?? null,
				link: certificate?.id ? `/cert/${certificate.id}` : `/materialize/orders/${orderId}`,
			});
		}
	}

	return { order: updated, event, certificate };
}

// ── Order creation ───────────────────────────────────────────────────────────
// Both checkout lanes land here. Everything money hangs off (material, height,
// quantity, volume, total) is read from the VERIFIED quote token, never from
// the request body, so a caller who edits a price in flight gets the price this
// server signed or nothing at all. The handlers verify the token; this function
// refuses to open an order without the decoded payload it produces.

/** Shipping fields we store, and the only ones. Anything else is dropped. */
const SHIPPING_FIELDS = Object.freeze([
	'name', 'line1', 'line2', 'city', 'region', 'postal_code', 'country', 'phone',
]);
const SHIPPING_REQUIRED = Object.freeze(['name', 'line1', 'city', 'postal_code', 'country']);
const SHIPPING_MAX_LEN = 120;

/**
 * Normalize a shipping address down to the minimum this platform is willing to
 * hold. PII discipline is a schema decision, not a policy document: a field
 * that is never accepted is a field that can never leak.
 *
 * @param {Record<string, unknown>} input
 * @returns {{ name: string, line1: string, line2: string|null, city: string,
 *   region: string|null, postal_code: string, country: string, phone: string|null }}
 */
export function normalizeShipping(input) {
	if (!input || typeof input !== 'object') {
		throw new PrintStoreError('shipping_required', 'a shipping address is required');
	}
	/** @type {Record<string, string|null>} */
	const out = {};
	for (const field of SHIPPING_FIELDS) {
		const raw = input[field];
		const value = raw == null ? '' : String(raw).trim().slice(0, SHIPPING_MAX_LEN);
		out[field] = value || null;
	}
	for (const field of SHIPPING_REQUIRED) {
		if (!out[field]) {
			throw new PrintStoreError('shipping_incomplete', `shipping.${field} is required`, { field });
		}
	}
	out.country = String(out.country).toUpperCase();
	if (!/^[A-Z]{2}$/.test(out.country)) {
		throw new PrintStoreError('shipping_incomplete', 'shipping.country must be an ISO 3166-1 alpha-2 code', {
			field: 'country',
		});
	}
	return /** @type {any} */ (out);
}

/**
 * Open a print order in `created`. The caller transitions it to `quoted` once
 * the row exists, so the edition check that guards scarcity runs against a real
 * order rather than against a request.
 *
 * Exactly one of userId (a signed-in human) or payerWallet (an agent that paid
 * over x402) must be present; the DB carries that as a check constraint and
 * this refuses it earlier, with a message a handler can return.
 *
 * @param {object} input
 * @param {string|null} [input.userId]
 * @param {string|null} [input.payerWallet]
 * @param {object} input.quote        the decoded, verified quote-token payload
 * @param {object} input.itemization  the full itemization the buyer was shown
 * @param {object} input.report       the printability report at order time
 * @param {string} input.sourceGlbUrl
 * @param {string|null} [input.creationId]
 * @param {object} input.shipping     already through normalizeShipping()
 * @param {string|null} [input.paymentReference]  Solana Pay reference pubkey
 * @param {string|null} [input.paymentChain]
 */
export async function createOrder({
	userId = null,
	payerWallet = null,
	quote,
	itemization,
	report,
	sourceGlbUrl,
	creationId = null,
	shipping,
	paymentReference = null,
	paymentChain = null,
}) {
	if (!userId && !payerWallet) {
		throw new PrintStoreError('owner_required', 'an order needs either a session user or a payer wallet');
	}
	if (!quote || !quote.materialId || !(Number(quote.total) > 0)) {
		throw new PrintStoreError('quote_required', 'a verified quote token is required to open an order');
	}
	if (!sourceGlbUrl) {
		throw new PrintStoreError('source_required', 'an order needs the model it is printing');
	}

	const [row] = await sql`
		insert into print_orders (
			user_id, payer_wallet, creation_id, source_glb_url, analysis,
			material_id, target_height_mm, quantity, quote, price_usdc,
			shipping, status, payment_reference, payment_chain, quote_expires_at
		) values (
			${userId}, ${payerWallet}, ${creationId}, ${sourceGlbUrl},
			${JSON.stringify(report ?? {})}::jsonb,
			${quote.materialId}, ${quote.targetHeightMm}, ${quote.quantity},
			${JSON.stringify(itemization ?? {})}::jsonb, ${quote.total},
			${JSON.stringify(shipping)}::jsonb, 'created',
			${paymentReference}, ${paymentChain},
			${quote.expiresAt ? new Date(quote.expiresAt).toISOString() : null}
		)
		returning *
	`;
	await appendEvent({
		orderId: row.id,
		status: 'created',
		note: `${quote.quantity} x ${quote.materialId} at ${quote.targetHeightMm} mm, ${quote.total} USDC`,
		actor: userId ? 'buyer' : 'system',
		actorId: userId,
	});
	return row;
}

/**
 * A buyer's own orders, newest first. Never returns another account's rows: the
 * only selector is the caller's own user id.
 * @param {string} userId
 * @param {{ limit?: number }} [opts]
 */
export async function listOrdersForUser(userId, { limit = 50 } = {}) {
	const capped = Math.min(Math.max(Number(limit) || 50, 1), 100);
	return sql`
		select id, status, material_id, target_height_mm, quantity, price_usdc,
		       tracking_number, carrier, lead_time_days, created_at, updated_at
		from print_orders
		where user_id = ${userId}
		order by created_at desc
		limit ${capped}
	`;
}

/**
 * The order behind a Solana Pay reference, for the confirm path. The reference
 * is unique, so this is a lookup rather than a search.
 * @param {string} reference
 */
export async function getOrderByPaymentReference(reference) {
	const [row] = await sql`select * from print_orders where payment_reference = ${reference} limit 1`;
	return row || null;
}
