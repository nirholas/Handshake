// api/_lib/x402/spent-payments.js
//
// Durable spent-payment record: the replay guard that outlives the cache TTL.
//
// paidEndpoint()'s always-on replay key (`proof:<paymentHash>`) lives in the
// idempotency cache and expires with X402_PAYMENT_IDENTIFIER_TTL. After that,
// a captured X-PAYMENT header can re-enter the handler and re-run its side
// effects (the good is delivered a second time). The money leg is already
// covered (settle-credit.js refuses a second credit for one signature), but
// DELIVERY is not, because the wrapper delivers before it settles on the
// default path.
//
// This module closes that leg with a Postgres row per honoured proof:
//
//   · isPaymentSpent():   one indexed lookup, run BEFORE the handler so a
//                          replay never reaches the side effects.
//   · claimSpentPayment(): the atomic claim, run once settlement and receipt
//                          work succeeded: `INSERT … ON CONFLICT DO NOTHING
//                          RETURNING` on the primary key. Zero rows back means
//                          another request already honoured this proof, i.e.
//                          a replay that raced past the lookup.
//
// The claim runs LAST in the settle path on purpose. A payment that settled
// but then failed a downstream step (SIWX grant write, receipt sign) leaves no
// spent row, so the payer's retry with the same header still works. The row is
// written only for a payment that was actually honoured end to end.
//
// Failure policy: FAIL OPEN, deliberately. The in-cache guard, the payment
// identifier reservation and the on-chain settle-credit gate all remain in
// force, so a Neon outage degrades this control to "cache-window replay
// protection" rather than 5xx-ing a payment whose funds already moved. That is
// the opposite of settle-credit.js (which fails closed) because the failure
// modes are not symmetric: refusing there costs a retry, refusing here would
// break every paid route for the duration of a DB outage. Both the missing
// table (a deploy that ran ahead of its migration) and a dead DB take the same
// open path.

import { sql } from '../db.js';

/** Postgres `undefined_table`: the migration has not been applied here yet. */
const UNDEFINED_TABLE = '42P01';

function classifyUnavailable(err) {
	const code = err?.code || err?.sourceError?.code;
	return code === UNDEFINED_TABLE ? 'table_missing' : 'db_unavailable';
}

function logDegraded(op, err) {
	console.error(
		`[x402-spent-payments] ${op} degraded (${classifyUnavailable(err)}):`,
		err?.message || err,
	);
}

/**
 * Has this payment proof already been honoured?
 *
 * @param {string|null|undefined} paymentHash Hash of the signed X-PAYMENT proof.
 * @returns {Promise<{ spent: boolean, unavailable: boolean }>}
 *   `spent` is true only on a positive, durable answer. `unavailable` marks the
 *   fail-open path so the caller can log it rather than silently trusting a
 *   "not spent" that was never actually checked.
 */
export async function isPaymentSpent(paymentHash) {
	if (!paymentHash) return { spent: false, unavailable: false };
	try {
		const rows = await sql`
			SELECT 1 FROM x402_spent_payments WHERE payment_hash = ${paymentHash} LIMIT 1
		`;
		return { spent: Boolean(rows?.length), unavailable: false };
	} catch (err) {
		logDegraded('lookup', err);
		return { spent: false, unavailable: true };
	}
}

/**
 * Claim the proof as spent. Atomic: the primary key is the arbiter, so of any
 * set of concurrent requests carrying one X-PAYMENT header exactly one claim
 * returns a row.
 *
 * @param {object} args
 * @param {string|null|undefined} args.paymentHash
 * @param {string} args.endpoint Route the proof was spent on (audit context).
 * @param {string|number|null} [args.amountAtomics] Price paid, in asset atomics.
 * @returns {Promise<{ granted: boolean, replay: boolean, unavailable: boolean }>}
 */
export async function claimSpentPayment({ paymentHash, endpoint, amountAtomics = null }) {
	// No hash means no signed proof to key on (never produced by the paid-endpoint
	// path, which derives the hash before it gets here). Nothing to claim, and
	// nothing that could double-deliver under this key either.
	if (!paymentHash) return { granted: true, replay: false, unavailable: false };
	try {
		const rows = await sql`
			INSERT INTO x402_spent_payments (payment_hash, endpoint, amount_atomics)
			VALUES (${paymentHash}, ${endpoint}, ${amountAtomics == null ? null : String(amountAtomics)})
			ON CONFLICT (payment_hash) DO NOTHING
			RETURNING payment_hash
		`;
		if (rows?.length) return { granted: true, replay: false, unavailable: false };
		return { granted: false, replay: true, unavailable: false };
	} catch (err) {
		logDegraded('claim', err);
		return { granted: true, replay: false, unavailable: true };
	}
}

/**
 * 409 for a proof that was already honoured. Distinct from the idempotency
 * conflict/in-flight 409s (`x-x402-idempotent: conflict` / `in-flight`) so a
 * client can tell "you replayed a spent payment" from "your id collided" and
 * from "your own request is still running".
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{ route: string }} ctx
 */
export function writeReplayed(res, { route }) {
	res.statusCode = 409;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.setHeader('x-x402-idempotent', 'replayed');
	res.end(
		JSON.stringify({
			error: 'payment_replayed',
			error_description:
				'this payment proof was already used for this resource; ' +
				'pay again to buy it a second time',
			route,
		}),
	);
}
