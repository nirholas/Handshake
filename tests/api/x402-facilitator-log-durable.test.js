// Regression: the self-hosted facilitator must AWAIT its audit-log write before
// sending the /verify and /settle response. It used to fire-and-forget the
// INSERT, which on Vercel is dropped when the function freezes the instant the
// response is sent — leaving x402_self_facilitator_log (and every dashboard that
// reads it) empty despite live 200 traffic. These tests assert the response is
// gated on the log write resolving.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable sql template tag: each call returns a promise we resolve by hand,
// so the test can prove the handler is still pending until the write settles.
//
// Rows are shaped per statement rather than always []. The settle success path
// no longer writes one audit row and returns — it claims the settle credit
// (api/_lib/x402/settle-credit.js), which reads any prior credit for the
// signature and then INSERTs the claim. A blanket [] made that INSERT look like
// a lost race, sending the handler down the re-read/classify branch and into
// SQL calls this test never resolved, so it hung to the 120s vitest timeout.
// SELECT → [] (no prior credit for this signature); INSERT → one row (the claim
// is ours). That is the real granted-credit path, which is what the assertion
// below is about.
let pendingResolvers = [];
function rowsFor(query) {
	return /INSERT/i.test(query) ? [{ id: 1 }] : [];
}
vi.mock('../../api/_lib/db.js', () => ({
	sql: (strings) => {
		const query = Array.isArray(strings) ? strings.join(' ') : String(strings ?? '');
		return new Promise((resolve) => { pendingResolvers.push(() => resolve(rowsFor(query))); });
	},
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

// Keep verify deterministic and side-effect free — we only care about log timing.
vi.mock('../../api/_lib/x402/self-facilitator.js', () => ({
	SELF_FACILITATOR_ENABLED: true,
	verifyRingPayment: () => ({ isValid: true, network: 'solana:x', asset: 'MINT', payer: 'BUYER' }),
	settleRingPayment: async () => ({ success: true, transaction: 'SIG', network: 'solana:x', payer: 'BUYER' }),
}));

import handler from '../../api/x402-facilitator/[action].js';

function makeReq({ action, body }) {
	return { url: `/api/x402-facilitator/${action}`, method: 'POST', query: { action }, headers: {}, body };
}
function makeRes() {
	return {
		statusCode: 200,
		ended: false,
		_body: null,
		setHeader() {},
		end(b) { this.ended = true; this._body = b; },
	};
}

const REQ_BODY = {
	paymentPayload: { payload: { transaction: 'x' } },
	paymentRequirements: { network: 'solana:x', payTo: 'PAYTO', asset: 'MINT', amount: '10000' },
};

beforeEach(() => { pendingResolvers = []; });

describe('self-facilitator log durability', () => {
	it('verify does not respond until the audit-log write resolves', async () => {
		const res = makeRes();
		const done = handler(makeReq({ action: 'verify', body: REQ_BODY }), res);

		// Let the handler run up to the awaited logOp. It first awaits the two
		// rate-limit buckets (per-IP + global), then verify, then the log INSERT.
		// Drain enough microtasks to clear the limiter awaits and reach the log
		// await; the INSERT promise is still pending (we haven't resolved it), so
		// the response must NOT have been sent.
		for (let i = 0; i < 6; i++) await Promise.resolve();
		expect(res.ended).toBe(false);
		expect(pendingResolvers.length).toBe(1); // the log INSERT is in flight

		// Flush the write; only now may the handler respond.
		pendingResolvers.forEach((r) => r());
		await done;
		expect(res.ended).toBe(true);
		expect(JSON.parse(res._body).isValid).toBe(true);
	});

	it('settle does not respond until the audit-log write resolves', async () => {
		const res = makeRes();
		const done = handler(makeReq({ action: 'settle', body: REQ_BODY }), res);

		// settle awaits settleRingPayment (a resolved async) then awaits the settle
		// -credit claim. Drain a few microtasks to reach the first DB await, then
		// assert the response is still unsent while that write is in flight.
		for (let i = 0; i < 6; i++) await Promise.resolve();
		expect(res.ended).toBe(false);
		expect(pendingResolvers.length).toBe(1);

		// The claim is a SEQUENCE of statements (prior-credit read, then the
		// INSERT), each only issued once the previous resolves, so draining once is
		// not enough. Release writes as they appear until the handler finishes.
		// Bounded so a genuine hang still fails fast instead of spinning.
		for (let i = 0; i < 20 && !res.ended; i++) {
			pendingResolvers.splice(0).forEach((r) => r());
			await Promise.resolve();
			await Promise.resolve();
		}
		await done;
		expect(res.ended).toBe(true);
		expect(JSON.parse(res._body).success).toBe(true);
	});
});
