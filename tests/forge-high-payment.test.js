// Unit tests for the Forge High pay-per-use proof (api/_lib/forge-high-payment.js).
//
// The consumption lever: a settled $THREE `consumption` payment, bound to
// ref_type:'forge' + the client nonce, stands in for holding $THREE on one High
// generation. These prove the validation contract (purpose/ref/price/recency/
// single-use), the atomic single-use claim, and the release-on-failure path that
// keeps a payment reusable when a generation fails before delivering a model.
//
// The DB is mocked: a tagged-template `sql` that returns whatever the test queues.
// priceForAction is the real pure catalog ($0.50 for forge.high), so a silent
// price change fails here.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queue = [];
vi.mock('../api/_lib/db.js', () => {
	const sql = vi.fn(async () => (queue.length ? queue.shift() : []));
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

import {
	assertForgePayment,
	redeemForgePayment,
	releaseForgePayment,
} from '../api/_lib/forge-high-payment.js';
import { sql } from '../api/_lib/db.js';
import { priceForAction } from '../api/_lib/pricing/catalog.js';

const HIGH_USD = Number(priceForAction('forge.high').usd); // 0.50 from the catalog
const REF_ID = 'forge-high-abc123';
// token_payments.id is a `uuid` column (2026-06-01-token-payments.sql), so every
// real payment id is one. The fixtures use real uuids so the module is exercised
// against ids of the shape production actually hands it.
const PAY_ID = '7c4e1b93-2a68-4f0d-8b52-1e93af6c04d7';
const UNKNOWN_PAY_ID = '05a9d6f2-b731-4c8e-9a14-6d2f83be5710';

// A settled consumption payment row as token_payments returns it (numeric usd
// comes back as a string from the driver). `confirmed_at` defaults to now.
function paymentRow(over = {}) {
	return {
		id: PAY_ID,
		purpose: 'consumption',
		usd: HIGH_USD.toFixed(6),
		ref_type: 'forge',
		ref_id: REF_ID,
		confirmed_at: new Date().toISOString(),
		created_at: new Date().toISOString(),
		...over,
	};
}

// Queue the two reads assertForgePayment makes: the payment lookup, then the
// redemption-existence check.
function queueAssert({ payment = paymentRow(), redeemed = false } = {}) {
	queue.push(payment ? [payment] : []); // lookupPayment
	queue.push(redeemed ? [{ payment_id: PAY_ID }] : []); // isRedeemed
}

beforeEach(() => {
	queue.length = 0;
	vi.clearAllMocks();
});

describe('assertForgePayment', () => {
	it('accepts a settled, ref-bound, correctly-priced, recent, unredeemed payment', async () => {
		queueAssert();
		const r = await assertForgePayment({ paymentId: PAY_ID, refId: REF_ID });
		expect(r.ok).toBe(true);
		expect(r.payment).toMatchObject({ id: PAY_ID, usd: HIGH_USD });
		expect(r.payment.settledAt).toBeTruthy();
	});

	it('requires both payment_id and ref_id', async () => {
		await expect(assertForgePayment({ paymentId: '', refId: REF_ID })).rejects.toMatchObject({
			status: 400,
			code: 'bad_request',
		});
		await expect(assertForgePayment({ paymentId: PAY_ID, refId: '' })).rejects.toMatchObject({
			status: 400,
			code: 'bad_request',
		});
	});

	it('rejects an unknown payment as payment_invalid (402)', async () => {
		queue.push([]); // lookupPayment → none
		await expect(assertForgePayment({ paymentId: UNKNOWN_PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			status: 402,
			code: 'payment_invalid',
		});
	});

	// Regression: a malformed payment_id used to reach the `where id = $1` lookup
	// against a uuid column, so Postgres raised 22P02 and the driver error escaped
	// this module carrying the SQLSTATE as `code` and the raw cast message as
	// `message`, both of which the High gate in api/forge.js echoes straight to
	// the caller. It must be a plain payment_invalid, decided before any query.
	it('rejects a malformed payment_id as payment_invalid without querying the database', async () => {
		await expect(assertForgePayment({ paymentId: 'deadbeef', refId: REF_ID })).rejects.toMatchObject({
			status: 402,
			code: 'payment_invalid',
		});
		expect(sql).not.toHaveBeenCalled();
	});

	it('rejects a non-consumption / non-forge payment (a different action) ', async () => {
		queueAssert({ payment: paymentRow({ purpose: 'spin' }) });
		await expect(assertForgePayment({ paymentId: PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			code: 'payment_invalid',
		});

		queueAssert({ payment: paymentRow({ ref_type: 'voice' }) });
		await expect(assertForgePayment({ paymentId: PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			code: 'payment_invalid',
		});
	});

	it('rejects a payment bound to a different ref_id', async () => {
		queueAssert({ payment: paymentRow({ ref_id: 'someone-elses-nonce' }) });
		await expect(assertForgePayment({ paymentId: PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			code: 'payment_invalid',
		});
	});

	it('rejects an underpaid payment (price must cover forge.high)', async () => {
		queueAssert({ payment: paymentRow({ usd: '0.100000' }) });
		await expect(assertForgePayment({ paymentId: PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			code: 'payment_invalid',
		});
	});

	it('rejects a payment older than the redemption window (payment_expired)', async () => {
		const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
		queueAssert({ payment: paymentRow({ confirmed_at: old, created_at: old }) });
		await expect(assertForgePayment({ paymentId: PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			status: 402,
			code: 'payment_expired',
		});
	});

	it('rejects an already-redeemed payment (409 payment_already_used)', async () => {
		queueAssert({ redeemed: true });
		await expect(assertForgePayment({ paymentId: PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			status: 409,
			code: 'payment_already_used',
		});
	});

	it('applies the holder discount to the expected price when a discount rides along', async () => {
		const discounted = Number(priceForAction('forge.high', { discountBps: 500 }).usd); // 0.475
		expect(discounted).toBeLessThan(HIGH_USD);
		// A payment for the discounted amount clears with the discount applied…
		queueAssert({ payment: paymentRow({ usd: discounted.toFixed(6) }) });
		const r = await assertForgePayment({ paymentId: PAY_ID, refId: REF_ID, discountBps: 500 });
		expect(r.ok).toBe(true);
		// …but the same discounted payment fails at full price (no discount presented).
		queueAssert({ payment: paymentRow({ usd: discounted.toFixed(6) }) });
		await expect(assertForgePayment({ paymentId: PAY_ID, refId: REF_ID })).rejects.toMatchObject({
			code: 'payment_invalid',
		});
	});
});

describe('redeemForgePayment', () => {
	it('claims a payment when the insert wins (returns a row)', async () => {
		queue.push([{ payment_id: PAY_ID }]);
		const r = await redeemForgePayment({ paymentId: PAY_ID, refId: REF_ID });
		expect(r.redeemed).toBe(true);
		expect(sql).toHaveBeenCalledOnce();
	});

	it('does not claim when the row already exists (ON CONFLICT DO NOTHING → no row)', async () => {
		queue.push([]); // conflict → nothing returned
		const r = await redeemForgePayment({ paymentId: PAY_ID, refId: REF_ID });
		expect(r.redeemed).toBe(false);
	});
});

describe('releaseForgePayment', () => {
	it('deletes the claim so the payment is reusable on retry', async () => {
		queue.push([]);
		await releaseForgePayment({ paymentId: PAY_ID });
		expect(sql).toHaveBeenCalledOnce();
		// The interpolated payment id is passed as the query's 2nd arg.
		expect(sql.mock.calls[0].slice(1).map(String)).toContain(PAY_ID);
	});
});
