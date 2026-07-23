// Regression guard for the 2026-07-23 audit finding (payment replay race):
// the hand-rolled paid endpoints (api/x402/{model-check,mint-to-mesh,vanity,
// vanity-verifiable,forge,pipeline,vanity-premium}.js) ran check-then-act —
// cache lookup, verify, paid work, settle, THEN store — with no in-flight
// reservation, so N concurrent requests carrying the same X-PAYMENT all
// missed the cache, all ran the paid work, and all settled: one payment,
// N deliveries. claimSlotOrRespond is the NX claim every one of those
// endpoints now makes right after its cache lookup. These tests pin its
// concurrency contract against the real in-process store.

import { describe, it, expect, beforeEach } from 'vitest';
import {
	claimSlotOrRespond,
	storeResponse,
	releaseSlot,
} from '../api/_lib/x402/payment-identifier-server.js';
import { _resetMemoryStore } from '../api/_lib/x402/idempotency-cache.js';

const ROUTE = '/api/x402/test-slot';

function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k.toLowerCase()] = v; };
	r.getHeader = (k) => r._h[k.toLowerCase()];
	r.end = (b) => { r._b = b; };
	Object.defineProperty(r, 'body', { get: () => (r._b ? JSON.parse(r._b) : null) });
	return r;
}

const claim = (res, paymentId = 'proof:abc123') =>
	claimSlotOrRespond({
		res,
		route: ROUTE,
		paymentId,
		payloadHash: 'payload-hash-1',
		paymentHash: 'proof-hash-1',
	});

beforeEach(() => {
	_resetMemoryStore();
});

describe('claimSlotOrRespond', () => {
	it('the first claim wins the slot', async () => {
		const res = makeRes();
		expect(await claim(res)).toBe(true);
		// No response was written; the caller proceeds to verify+deliver+settle.
		expect(res._b).toBeNull();
	});

	it('a concurrent claim for the same payment is answered in-flight, not admitted', async () => {
		expect(await claim(makeRes())).toBe(true);
		const res2 = makeRes();
		expect(await claim(res2)).toBe(false);
		expect(res2.statusCode).toBe(409);
		expect(res2._h['x-x402-idempotent']).toBe('in-flight');
		expect(res2.body.error).toBe('payment_in_flight');
	});

	it('a concurrent RACE admits exactly one winner', async () => {
		const [a, b] = await Promise.all([claim(makeRes()), claim(makeRes()), claim(makeRes())]);
		expect([a, b].filter(Boolean)).toHaveLength(1);
	});

	it('after the winner stores its response, later claims replay the cache', async () => {
		expect(await claim(makeRes())).toBe(true);
		await storeResponse({
			route: ROUTE,
			paymentId: 'proof:abc123',
			payloadHash: 'payload-hash-1',
			paymentHash: 'proof-hash-1',
			status: 200,
			body: JSON.stringify({ ok: true }),
			contentType: 'application/json; charset=utf-8',
			paymentResponseHeader: null,
		});

		const res = makeRes();
		expect(await claim(res)).toBe(false);
		expect(res.statusCode).toBe(200);
		expect(res._h['x-x402-idempotent']).toBe('replay');
		expect(res.body).toEqual({ ok: true });
	});

	it('a released slot (failure path) lets the payer retry instead of locking them out', async () => {
		expect(await claim(makeRes())).toBe(true);
		await releaseSlot({ route: ROUTE, paymentId: 'proof:abc123' });
		// The retry wins the slot again — a transient verify/settle failure must
		// never strand the payer on a stale in-flight marker.
		expect(await claim(makeRes())).toBe(true);
	});

	it('different payments never block each other', async () => {
		expect(await claim(makeRes(), 'proof:aaa')).toBe(true);
		expect(await claim(makeRes(), 'proof:bbb')).toBe(true);
	});
});
