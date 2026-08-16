// Pay-per-use proof for Forge High — the consumption lever of Token Utility.
//
// A non-holder pays $THREE per High generation instead of holding. The payment
// runs through the existing token rail (api/_lib/token: quote → settle), which
// records a settled `consumption` row in token_payments bound to ref_type:'forge'
// and the client nonce as ref_id. The client then retries POST /api/forge for
// High with { payment_id, ref_id }, and this module is the server's authority on
// whether that proof satisfies the holder gate.
//
// Two-phase, so a generation that fails before it is dispatched never costs the
// user their payment:
//   • assertForgePayment()  — read-only validation at the gate: the payment is a
//     settled `consumption` for forge.high, ref-bound, correctly priced, recent,
//     and not already redeemed. Satisfies the gate; consumes nothing.
//   • redeemForgePayment()  — the atomic single-use claim, taken immediately
//     before the provider dispatch. The PRIMARY KEY on payment_id makes it
//     race-safe: exactly one caller can claim a given payment.
//   • releaseForgePayment() — undo the claim when dispatch fails, so the settled
//     payment is reusable on retry. Never called after a successful dispatch.
//
// Security model: forge has no login, so authorization rests on the (payment_id,
// ref_id) pair. payment_id is a server-minted UUID returned only to the settling
// client; ref_id is the client nonce recorded on the payment at quote time. An
// attacker would need both, and each pair buys exactly one generation.

import { sql } from './db.js';
import { priceForAction } from './pricing/catalog.js';
import { isUuid } from './validate.js';

// How long after settlement a payment may be redeemed. Generous — a paid
// generation is normally redeemed seconds after settling, but a failed dispatch
// (released claim) may be retried later, and a holder may pay, get distracted,
// and come back. A settled payment older than this is treated as stale rather
// than letting an indefinitely-old proof unlock a generation.
const REDEMPTION_WINDOW_MS = 24 * 60 * 60 * 1000;

// Catalog action this proof unlocks, and the ref_type the client tags the quote
// with. Both are matched exactly so a `consumption` payment for some other action
// (voice clone, MCP-3D) can never be redeemed as a Forge High generation.
const FORGE_HIGH_ACTION = 'forge.high';
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
		select payment_id from forge_high_redemptions where payment_id = ${paymentId} limit 1
	`;
	return Boolean(row);
}

/**
 * Validate that a settled $THREE payment proves entitlement to one Forge High
 * generation. Read-only: satisfies the gate without consuming the payment.
 *
 * @param {object} params
 * @param {string} params.paymentId   token_payments.id returned by settle
 * @param {string} params.refId       the client nonce the payment was bound to
 * @param {number} [params.discountBps] holder fee discount (bps) when a tier pass
 *                                     also rides along, so the expected price
 *                                     matches what the client was quoted
 * @returns {Promise<{ ok: true, payment: { id, usd, settledAt } }>}
 * @throws  402 payment_invalid | 409 payment_already_used | 400 bad_request
 */
export async function assertForgePayment({ paymentId, refId, discountBps = 0 }) {
	if (!paymentId || !refId) {
		throw payErr('payment_id and ref_id are required', 400, 'bad_request');
	}
	// token_payments.id is a uuid column, so a malformed payment_id can never match
	// a settled payment. Answer that as the contract error it is, BEFORE the query:
	// otherwise Postgres raises 22P02 and the driver error escapes this module with
	// the raw SQLSTATE as `code` and the raw cast message as `message`, which the
	// gate handlers then echo verbatim to an unauthenticated caller.
	if (!isUuid(paymentId)) {
		throw payErr('No settled $THREE payment found for this generation.', 402, 'payment_invalid');
	}

	const payment = await lookupPayment(paymentId);
	if (!payment) {
		throw payErr('No settled $THREE payment found for this generation.', 402, 'payment_invalid');
	}
	if (payment.purpose !== CONSUMPTION_PURPOSE || payment.ref_type !== FORGE_REF_TYPE) {
		throw payErr('This payment is not a Forge generation payment.', 402, 'payment_invalid');
	}
	if (payment.ref_id !== refId) {
		throw payErr('This payment does not match this generation.', 402, 'payment_invalid');
	}

	// Price must equal the catalog price for forge.high (holder discount applied
	// when a pass rides along), so an underpaid `consumption` quote can't be
	// redeemed as a High generation.
	const expectedUsd = Number(priceForAction(FORGE_HIGH_ACTION, { discountBps }).usd);
	const paidUsd = Number(payment.usd);
	if (!(Math.abs(paidUsd - expectedUsd) < 0.005)) {
		throw payErr(
			`This payment ($${paidUsd.toFixed(2)}) does not cover a High generation ($${expectedUsd.toFixed(2)}).`,
			402,
			'payment_invalid',
		);
	}

	const settledAt = payment.confirmed_at || payment.created_at;
	const ageMs = Date.now() - new Date(settledAt).getTime();
	if (!(ageMs >= 0) || ageMs > REDEMPTION_WINDOW_MS) {
		throw payErr('This payment has expired — pay again to generate.', 402, 'payment_expired');
	}

	if (await isRedeemed(paymentId)) {
		throw payErr(
			'This payment has already been used for a generation.',
			409,
			'payment_already_used',
		);
	}

	return { ok: true, payment: { id: payment.id, usd: paidUsd, settledAt } };
}

/**
 * Atomically claim a validated payment for one generation. Race-safe via the
 * payment_id PRIMARY KEY: a concurrent claim of the same payment inserts nothing
 * and returns { redeemed: false }. Call immediately before dispatch.
 *
 * @param {object} params
 * @param {string} params.paymentId
 * @param {string} params.refId
 * @param {string} [params.jobId]      forge job/creation handle, when known
 * @param {string|Date} [params.settledAt]
 * @returns {Promise<{ redeemed: boolean }>}
 */
export async function redeemForgePayment({ paymentId, refId, jobId = null, settledAt = null }) {
	const rows = await sql`
		insert into forge_high_redemptions (payment_id, ref_id, job_id, settled_at)
		values (${paymentId}, ${refId}, ${jobId}, ${settledAt})
		on conflict (payment_id) do nothing
		returning payment_id
	`;
	return { redeemed: rows.length > 0 };
}

/**
 * Release a claim so the settled payment is reusable on retry. Called only when a
 * generation fails before a model is delivered — never after a successful
 * dispatch, so a delivered generation can never be repeated.
 * @param {object} params
 * @param {string} params.paymentId
 */
export async function releaseForgePayment({ paymentId }) {
	await sql`delete from forge_high_redemptions where payment_id = ${paymentId}`;
}
