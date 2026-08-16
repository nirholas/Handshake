// Unit tests for the generic Forge consumption pay-per-use proof
// (api/_lib/forge-consumption-payment.js).
//
// The consumption lever, generalized beyond High: a settled $THREE `consumption`
// payment, bound to ref_type:'forge' + the client nonce + the action's price,
// stands in for holding $THREE on one dispatch of a priced Forge action
// (Game-Ready export today). These prove the validation contract (action/purpose/
// ref/price/recency/single-use), the atomic single-use claim, the release path,
// and — crucially — that a payment for one Forge action can't satisfy a
// differently-priced one.
//
// The DB is mocked: a tagged-template `sql` that returns whatever the test queues.
// priceForAction is the real pure catalog ($0.10 for forge.gameready, $0.50 for
// forge.high), so a silent price change fails here.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queue = [];
vi.mock('../api/_lib/db.js', () => {
	const sql = vi.fn(async () => (queue.length ? queue.shift() : []));
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

import {
	assertForgePurchase,
	redeemForgePurchase,
	releaseForgePurchase,
} from '../api/_lib/forge-consumption-payment.js';
import { sql } from '../api/_lib/db.js';
import { priceForAction } from '../api/_lib/pricing/catalog.js';

const ACTION = 'forge.gameready';
const GR_USD = Number(priceForAction(ACTION).usd); // 0.10 from the catalog
const HIGH_USD = Number(priceForAction('forge.high').usd); // 0.50
const REF_ID = 'forge-gameready-abc123';
// token_payments.id is a `uuid` column (2026-06-01-token-payments.sql), so every
// real payment id is one. The fixtures use real uuids so the module is exercised
// against ids of the shape production actually hands it.
const PAY_ID = '3f1c8e9a-4d21-4b6e-9f07-2a5c8d13b7e4';
const UNKNOWN_PAY_ID = '9b2d7c14-8e35-4a90-b1f6-0c47ae2d5938';

function paymentRow(over = {}) {
	return {
		id: PAY_ID,
		purpose: 'consumption',
		usd: GR_USD.toFixed(6),
		ref_type: 'forge',
		ref_id: REF_ID,
		confirmed_at: new Date().toISOString(),
		created_at: new Date().toISOString(),
		...over,
	};
}

// Queue the two reads assertForgePurchase makes: the payment lookup, then the
// redemption-existence check.
function queueAssert({ payment = paymentRow(), redeemed = false } = {}) {
	queue.push(payment ? [payment] : []); // lookupPayment
	queue.push(redeemed ? [{ payment_id: PAY_ID }] : []); // isRedeemed
}

beforeEach(() => {
	queue.length = 0;
	vi.clearAllMocks();
});

describe('assertForgePurchase', () => {
	it('accepts a settled, ref-bound, correctly-priced, recent, unredeemed payment', async () => {
		queueAssert();
		const r = await assertForgePurchase({ action: ACTION, paymentId: PAY_ID, refId: REF_ID });
		expect(r.ok).toBe(true);
		expect(r.payment).toMatchObject({ id: PAY_ID, usd: GR_USD });
		expect(r.payment.settledAt).toBeTruthy();
	});

	it('requires action, payment_id and ref_id', async () => {
		await expect(assertForgePurchase({ action: '', paymentId: PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			status: 400,
			code: 'bad_request',
		});
		await expect(assertForgePurchase({ action: ACTION, paymentId: '', refId: REF_ID })).rejects.toMatchObject({
			status: 400,
			code: 'bad_request',
		});
		await expect(assertForgePurchase({ action: ACTION, paymentId: PAY_ID, refId: '' })).rejects.toMatchObject({
			status: 400,
			code: 'bad_request',
		});
	});

	it('rejects an unknown payment as payment_invalid (402)', async () => {
		queue.push([]); // lookupPayment → none
		await expect(assertForgePurchase({ action: ACTION, paymentId: UNKNOWN_PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			status: 402,
			code: 'payment_invalid',
		});
	});

	// Regression: a malformed payment_id used to reach the `where id = $1` lookup
	// against a uuid column, so Postgres raised 22P02 and the driver error escaped
	// this module carrying the SQLSTATE as `code` and the raw cast message
	// ("invalid input syntax for type uuid: ...") as `message`. The Game-Ready gate
	// echoes both to an unauthenticated caller, so a 402 leaked the storage engine
	// and the column type. It must be answered as a plain payment_invalid, decided
	// before any query runs.
	it('rejects a malformed payment_id as payment_invalid without querying the database', async () => {
		await expect(assertForgePurchase({ action: ACTION, paymentId: 'deadbeef', refId: REF_ID })).rejects.toMatchObject({
			status: 402,
			code: 'payment_invalid',
		});
		expect(sql).not.toHaveBeenCalled();
	});

	// The malformed and the merely-unknown id must be indistinguishable, so the
	// endpoint is never an oracle for which payment ids exist.
	it('answers a malformed and an unknown payment id identically', async () => {
		const malformed = await assertForgePurchase({ action: ACTION, paymentId: 'deadbeef', refId: REF_ID }).catch((e) => e);
		queue.push([]); // lookupPayment → none
		const unknown = await assertForgePurchase({ action: ACTION, paymentId: UNKNOWN_PAY_ID, refId: REF_ID }).catch((e) => e);
		expect(malformed.code).toBe(unknown.code);
		expect(malformed.status).toBe(unknown.status);
		expect(malformed.message).toBe(unknown.message);
	});

	it('rejects a non-consumption / non-forge payment', async () => {
		queueAssert({ payment: paymentRow({ purpose: 'spin' }) });
		await expect(assertForgePurchase({ action: ACTION, paymentId: PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			code: 'payment_invalid',
		});

		queueAssert({ payment: paymentRow({ ref_type: 'voice' }) });
		await expect(assertForgePurchase({ action: ACTION, paymentId: PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			code: 'payment_invalid',
		});
	});

	it('rejects a payment bound to a different ref_id', async () => {
		queueAssert({ payment: paymentRow({ ref_id: 'someone-elses-nonce' }) });
		await expect(assertForgePurchase({ action: ACTION, paymentId: PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			code: 'payment_invalid',
		});
	});

	it('rejects a payment priced for a DIFFERENT forge action (High $0.50 ≠ Game-Ready $0.10)', async () => {
		// A $0.50 High payment must not unlock a $0.10 Game-Ready export — the price
		// check is what keeps same-ref_type Forge actions apart.
		expect(HIGH_USD).not.toBe(GR_USD);
		queueAssert({ payment: paymentRow({ usd: HIGH_USD.toFixed(6) }) });
		await expect(assertForgePurchase({ action: ACTION, paymentId: PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			code: 'payment_invalid',
		});
	});

	it('rejects a payment older than the redemption window (payment_expired)', async () => {
		const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
		queueAssert({ payment: paymentRow({ confirmed_at: old, created_at: old }) });
		await expect(assertForgePurchase({ action: ACTION, paymentId: PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			status: 402,
			code: 'payment_expired',
		});
	});

	it('rejects an already-redeemed payment (409 payment_already_used)', async () => {
		queueAssert({ redeemed: true });
		await expect(assertForgePurchase({ action: ACTION, paymentId: PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			status: 409,
			code: 'payment_already_used',
		});
	});

	it('applies the holder discount to the expected price when a discount rides along', async () => {
		const discounted = Number(priceForAction(ACTION, { discountBps: 500 }).usd); // 5% off
		queueAssert({ payment: paymentRow({ usd: discounted.toFixed(6) }) });
		const r = await assertForgePurchase({ action: ACTION, paymentId: PAY_ID, refId: REF_ID, discountBps: 500 });
		expect(r.ok).toBe(true);
		// The same discounted payment fails at full price (no discount presented).
		queueAssert({ payment: paymentRow({ usd: discounted.toFixed(6) }) });
		await expect(assertForgePurchase({ action: ACTION, paymentId: PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			code: 'payment_invalid',
		});
	});
});

describe('redeemForgePurchase', () => {
	it('claims a payment when the insert wins (returns a row)', async () => {
		queue.push([{ payment_id: PAY_ID }]);
		const r = await redeemForgePurchase({ action: ACTION, paymentId: PAY_ID, refId: REF_ID });
		expect(r.redeemed).toBe(true);
		expect(sql).toHaveBeenCalledOnce();
	});

	it('does not claim when the row already exists (ON CONFLICT DO NOTHING → no row)', async () => {
		queue.push([]); // conflict → nothing returned
		const r = await redeemForgePurchase({ action: ACTION, paymentId: PAY_ID, refId: REF_ID });
		expect(r.redeemed).toBe(false);
	});
});

describe('releaseForgePurchase', () => {
	it('deletes the claim so the payment is reusable on retry', async () => {
		queue.push([]);
		await releaseForgePurchase({ paymentId: PAY_ID });
		expect(sql).toHaveBeenCalledOnce();
		expect(sql.mock.calls[0].slice(1).map(String)).toContain(PAY_ID);
	});
});
