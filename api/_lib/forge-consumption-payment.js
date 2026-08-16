// Pay-per-use proof for Forge consumption actions other than High — the home for
// any priced, holder-gated Forge deliverable a non-holder may pay $THREE for once
// instead of holding (Game-Ready export today; future consumption actions next).
//
// It generalizes the proven, single-purpose forge-high-payment.js: same two-phase
// claim, same security model, but action-parameterized so one rail serves every
// new consumption action. forge.high keeps its own dedicated module + table
// (already shipped and tested) — this is the additive home for the rest, so adding
// a new paid Forge action never means touching the High path.
//
// A non-holder pays through the existing token rail (api/_lib/token: quote →
// settle), which records a settled `consumption` row in token_payments bound to
// ref_type:'forge' and the client nonce as ref_id. The client then retries the
// action with { payment_id, ref_id }, and this module is the server's authority on
// whether that proof satisfies the holder gate.
//
// Two-phase, so an action that fails before it is dispatched never costs the user
// their payment:
//   • assertForgePurchase()  — read-only validation at the gate: the payment is a
//     settled `consumption` for the action, ref-bound, correctly priced, recent,
//     and not already redeemed. Satisfies the gate; consumes nothing.
//   • redeemForgePurchase()  — the atomic single-use claim, taken immediately
//     before the worker dispatch. The PRIMARY KEY on payment_id makes it
//     race-safe: exactly one caller can claim a given payment, across all actions.
//   • releaseForgePurchase() — undo the claim when dispatch fails, so the settled
//     payment is reusable on retry. Never called after a successful dispatch.
//
// Single-use is global per payment (the payment_id PRIMARY KEY), so a payment can
// only ever fund one job, regardless of action. Cross-action redemption is blocked
// at assert time by the price check: a $0.10 Game-Ready payment can't satisfy a
// $0.50 High gate and vice versa.
//
// Security model: Forge has no login, so authorization rests on the (payment_id,
// ref_id) pair. payment_id is a server-minted UUID returned only to the settling
// client; ref_id is the client nonce recorded on the payment at quote time. An
// attacker would need both, and each pair buys exactly one dispatch.

import { sql } from './db.js';
import { priceForAction } from './pricing/catalog.js';
import { isUuid } from './validate.js';

// How long after settlement a payment may be redeemed. Generous — a paid action is
// normally redeemed seconds after settling, but a failed dispatch (released claim)
// may be retried later, and a holder may pay, get distracted, and come back. A
// settled payment older than this is treated as stale rather than letting an
// indefinitely-old proof unlock a dispatch.
const REDEMPTION_WINDOW_MS = 24 * 60 * 60 * 1000;

// The ref_type the client tags the quote with for every Forge consumption action,
// and the purpose every consumption payment carries. Both are matched exactly so a
// payment for some unrelated action (voice clone, MCP-3D) can never be redeemed
// here, and the per-action price (below) keeps the Forge actions apart.
const FORGE_REF_TYPE = 'forge';
const CONSUMPTION_PURPOSE = 'consumption';

function payErr(message, status, code, extra = {}) {
	return Object.assign(new Error(message), { status, code, ...extra });
}

// Direct lookup of one settled payment by id — lighter than listPayments (which
// pulls in the on-chain settle/verify module) and all this path needs. numeric
// columns come back as strings from the driver; callers coerce what they compare.
async function lookupPayment(paymentId) {
	const [row] = await sql`
		select id, purpose, usd, ref_type, ref_id, confirmed_at, created_at
		from token_payments
		where id = ${paymentId}
		limit 1
	`;
	return row || null;
}

async function isRedeemed(paymentId) {
	const [row] = await sql`
		select payment_id from forge_consumption_redemptions where payment_id = ${paymentId} limit 1
	`;
	return Boolean(row);
}

/**
 * Validate that a settled $THREE payment proves entitlement to one dispatch of the
 * given Forge consumption action. Read-only: satisfies the gate without consuming
 * the payment.
 *
 * @param {object} params
 * @param {string} params.action      a catalog action id (e.g. 'forge.gameready')
 * @param {string} params.paymentId   token_payments.id returned by settle
 * @param {string} params.refId       the client nonce the payment was bound to
 * @param {string} [params.refType]   the ref_type the quote was tagged with ('forge')
 * @param {number} [params.discountBps] holder fee discount (bps) when a tier pass
 *                                     also rides along, so the expected price
 *                                     matches what the client was quoted
 * @returns {Promise<{ ok: true, payment: { id, usd, settledAt } }>}
 * @throws  402 payment_invalid | 402 payment_expired | 409 payment_already_used | 400 bad_request
 */
export async function assertForgePurchase({ action, paymentId, refId, refType = FORGE_REF_TYPE, discountBps = 0 }) {
	if (!action) throw payErr('action is required', 400, 'bad_request');
	if (!paymentId || !refId) {
		throw payErr('payment_id and ref_id are required', 400, 'bad_request');
	}
	// token_payments.id is a uuid column, so a malformed payment_id can never match
	// a settled payment. Answer that as the contract error it is, BEFORE the query:
	// otherwise Postgres raises 22P02 and the driver error escapes this module with
	// the raw SQLSTATE as `code` and the raw cast message as `message`, which the
	// gate handlers then echo verbatim to an unauthenticated caller.
	if (!isUuid(paymentId)) {
		throw payErr('No settled $THREE payment found for this request.', 402, 'payment_invalid');
	}

	const payment = await lookupPayment(paymentId);
	if (!payment) {
		throw payErr('No settled $THREE payment found for this request.', 402, 'payment_invalid');
	}
	if (payment.purpose !== CONSUMPTION_PURPOSE || payment.ref_type !== refType) {
		throw payErr('This payment is not a Forge payment.', 402, 'payment_invalid');
	}
	if (payment.ref_id !== refId) {
		throw payErr('This payment does not match this request.', 402, 'payment_invalid');
	}

	// Price must equal the catalog price for the action (holder discount applied when
	// a pass rides along), so an underpaid `consumption` quote — or a payment for a
	// differently-priced Forge action — can't be redeemed here.
	const expectedUsd = Number(priceForAction(action, { discountBps }).usd);
	const paidUsd = Number(payment.usd);
	if (!(Math.abs(paidUsd - expectedUsd) < 0.005)) {
		throw payErr(
			`This payment ($${paidUsd.toFixed(2)}) does not cover this action ($${expectedUsd.toFixed(2)}).`,
			402,
			'payment_invalid',
		);
	}

	const settledAt = payment.confirmed_at || payment.created_at;
	const ageMs = Date.now() - new Date(settledAt).getTime();
	if (!(ageMs >= 0) || ageMs > REDEMPTION_WINDOW_MS) {
		throw payErr('This payment has expired — pay again to continue.', 402, 'payment_expired');
	}

	if (await isRedeemed(paymentId)) {
		throw payErr('This payment has already been used.', 409, 'payment_already_used');
	}

	return { ok: true, payment: { id: payment.id, usd: paidUsd, settledAt } };
}

/**
 * Atomically claim a validated payment for one dispatch. Race-safe via the
 * payment_id PRIMARY KEY: a concurrent claim of the same payment inserts nothing
 * and returns { redeemed: false }. Call immediately before dispatch.
 *
 * @param {object} params
 * @param {string} params.action      the catalog action this payment funds (audit)
 * @param {string} params.paymentId
 * @param {string} params.refId
 * @param {string} [params.jobId]      job/creation handle, when known
 * @param {string|Date} [params.settledAt]
 * @returns {Promise<{ redeemed: boolean }>}
 */
export async function redeemForgePurchase({ action, paymentId, refId, jobId = null, settledAt = null }) {
	const rows = await sql`
		insert into forge_consumption_redemptions (payment_id, action, ref_id, job_id, settled_at)
		values (${paymentId}, ${action}, ${refId}, ${jobId}, ${settledAt})
		on conflict (payment_id) do nothing
		returning payment_id
	`;
	return { redeemed: rows.length > 0 };
}

/**
 * Release a claim so the settled payment is reusable on retry. Called only when a
 * dispatch fails before any deliverable is produced — never after a successful
 * dispatch, so a delivered result can never be claimed twice.
 * @param {object} params
 * @param {string} params.paymentId
 */
export async function releaseForgePurchase({ paymentId }) {
	await sql`delete from forge_consumption_redemptions where payment_id = ${paymentId}`;
}
