// Settle-before-flush safety for api/_lib/x402-paid-endpoint.js.
//
// The wrapper's default contract is deliver-then-settle: the handler RETURNS a
// value and the wrapper settles, then serialises + flushes it. A handler that
// ends its OWN response (binary download, res.pipe, SSE) on a default route
// would deliver the good BEFORE settlement runs — the buyer gets it for free.
// Two guarantees are exercised here:
//   1. `streaming: true` routes settle FIRST (settle-then-stream) and emit the
//      x-payment-response header up-front, so a self-flushing handler is paid by
//      construction.
//   2. A default (non-streaming) handler that flushes its own body is caught:
//      the wrapper never silently settle-skips — it logs `payment_unsettled_flush`
//      and throws instead of returning a free good.
//
// We drive the real paidEndpoint() handler with a stubbed req/res and mock only
// the facilitator-facing verifyPayment + settlePayment; every other export runs
// for real against the in-memory idempotency cache fallback.

import { Readable } from 'node:stream';

import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';

const verifyPayment = vi.fn();
const settlePayment = vi.fn();
vi.mock('../../api/_lib/x402-spec.js', async (importActual) => {
	const actual = await importActual();
	return { ...actual, verifyPayment, settlePayment };
});

// Capture audit events so the "fail loudly" path is directly observable — the
// throw itself is swallowed by wrap() once the response is already flushed.
const auditEvents = [];
vi.mock('../../api/_lib/x402/audit-log.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		logPaymentEvent: (event) => {
			auditEvents.push(event);
		},
	};
});

// Heavy upstreams imported transitively — stub so the suite is fast + offline.
vi.mock('@coinbase/x402', () => ({ createCdpAuthHeaders: vi.fn(async () => ({})) }));

let paidEndpoint;
let cacheMod;

const BASE = 'eip155:8453';
const PAY_TO_BASE = '0x4022de2d36c334e73c7a108805cea11c0564f402';
const ASSET_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ROUTE = '/api/x402/streaming-test';

const HANDLER_BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'object', properties: {}, required: [] },
		output: { type: 'object', properties: { ok: { type: 'boolean' } } },
	},
	schema: { type: 'object' },
};

function mockReqRes({ method = 'GET', headers = {}, url = ROUTE } = {}) {
	const lowerHeaders = {};
	for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v;
	const req = Object.assign(new Readable({ read() {} }), {
		method,
		url,
		headers: lowerHeaders,
		connection: { remoteAddress: '127.0.0.1' },
		socket: { remoteAddress: '127.0.0.1' },
	});
	req.push(null);
	const chunks = [];
	const resHeaders = {};
	const res = {
		statusCode: 200,
		writableEnded: false,
		setHeader(k, v) {
			resHeaders[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return resHeaders[k.toLowerCase()];
		},
		end(body) {
			if (body !== undefined) chunks.push(body);
			res.writableEnded = true;
		},
		write(chunk) {
			chunks.push(chunk);
		},
		get body() {
			return chunks.join('');
		},
		get headers() {
			return resHeaders;
		},
	};
	return { req, res };
}

// A base64 X-PAYMENT header; `salt` varies the signed proof so distinct
// payments hash distinctly across tests.
function paymentHeader({ salt = 'a' } = {}) {
	const payload = {
		x402Version: 2,
		scheme: 'exact',
		network: BASE,
		payload: { authorization: { value: '1000', to: PAY_TO_BASE, salt } },
	};
	return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function makeEndpoint(handler, spec = {}) {
	return paidEndpoint({
		route: ROUTE,
		method: 'GET',
		networks: ['base'],
		description: 'settle-before-flush test',
		bazaar: HANDLER_BAZAAR,
		offerReceipt: false,
		handler,
		...spec,
	});
}

const ORIG_ENV = { ...process.env };

beforeAll(async () => {
	process.env.X402_ALLOW_MEMORY_FALLBACK = '1';
	paidEndpoint = (await import('../../api/_lib/x402-paid-endpoint.js')).paidEndpoint;
	cacheMod = await import('../../api/_lib/x402/idempotency-cache.js');
});

beforeEach(() => {
	process.env.X402_PAY_TO_BASE = PAY_TO_BASE;
	process.env.X402_ASSET_ADDRESS_BASE = ASSET_BASE;
	process.env.X402_MAX_AMOUNT_REQUIRED = '1000';
	process.env.X402_ADVERTISE_BASE = 'true';
	delete process.env.CDP_API_KEY_ID;
	delete process.env.CDP_API_KEY_SECRET;
	delete process.env.X402_BUILDER_CODE_APP;
	cacheMod._resetMemoryStore();
	auditEvents.length = 0;
	verifyPayment.mockReset();
	settlePayment.mockReset();
	verifyPayment.mockImplementation(async () => ({
		paymentPayload: {},
		requirement: { scheme: 'exact', network: BASE, payTo: PAY_TO_BASE, asset: ASSET_BASE, amount: '1000' },
		payer: 'PAYER',
	}));
	settlePayment.mockImplementation(async () => ({
		success: true,
		transaction: '0xdeadbeef',
		network: BASE,
		payer: 'PAYER',
	}));
});

afterAll(() => {
	for (const k of Object.keys(process.env)) if (!(k in ORIG_ENV)) delete process.env[k];
	Object.assign(process.env, ORIG_ENV);
});

describe('paidEndpoint() settle-before-flush safety', () => {
	it('streaming:true settles BEFORE the handler flushes its own body, and emits x-payment-response up-front', async () => {
		let seq = 0;
		let settledAt = 0;
		let flushedAt = 0;
		settlePayment.mockImplementation(async () => {
			settledAt = ++seq;
			return { success: true, transaction: '0xdeadbeef', network: BASE, payer: 'PAYER' };
		});

		const handler = makeEndpoint(
			async ({ res, settled }) => {
				// The wrapper must have settled before handing us the response, AND
				// the settlement context is available to the streaming handler.
				expect(settled).toMatchObject({ success: true, transaction: '0xdeadbeef' });
				// Header must be in place before the first streamed byte.
				expect(res.getHeader('x-payment-response')).toBeTruthy();
				res.setHeader('content-type', 'application/octet-stream');
				res.write('BINARY');
				flushedAt = ++seq;
				res.end();
			},
			{ streaming: true },
		);

		const { req, res } = mockReqRes({ headers: { 'x-payment': paymentHeader() } });
		await handler(req, res);

		expect(settlePayment).toHaveBeenCalledTimes(1);
		expect(settledAt).toBeGreaterThan(0);
		expect(flushedAt).toBeGreaterThan(settledAt); // settled first, then streamed
		expect(res.body).toBe('BINARY');
		expect(res.getHeader('content-type')).toBe('application/octet-stream');
		expect(res.getHeader('x-payment-response')).toBeTruthy();
		expect(auditEvents.some((e) => e.eventType === 'payment_settled')).toBe(true);
		expect(auditEvents.some((e) => e.eventType === 'payment_unsettled_flush')).toBe(false);
	});

	it('streaming:true with a settle failure never runs the handler or ships the body', async () => {
		settlePayment.mockRejectedValueOnce(
			Object.assign(new Error('facilitator down'), { status: 502, code: 'settle_failed' }),
		);
		let handlerRan = false;
		const handler = makeEndpoint(
			async ({ res }) => {
				handlerRan = true;
				res.write('BINARY');
				res.end();
			},
			{ streaming: true },
		);

		const { req, res } = mockReqRes({ headers: { 'x-payment': paymentHeader() } });
		await handler(req, res);

		expect(res.statusCode).toBe(502);
		expect(handlerRan).toBe(false);
		expect(res.body).not.toContain('BINARY');
	});

	it('streaming:true handler that RETURNS a value (no self-flush) still gets a buffered, settled body', async () => {
		const handler = makeEndpoint(async () => ({ ok: true, kind: 'buffered' }), { streaming: true });

		const { req, res } = mockReqRes({ headers: { 'x-payment': paymentHeader() } });
		await handler(req, res);

		expect(settlePayment).toHaveBeenCalledTimes(1);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toMatchObject({ ok: true, kind: 'buffered' });
		expect(res.getHeader('x-payment-response')).toBeTruthy();
	});

	it('a DEFAULT (non-streaming) handler that flushes its own body is caught: NO settle, logs payment_unsettled_flush', async () => {
		let handlerRan = false;
		const handler = makeEndpoint(async ({ res }) => {
			handlerRan = true;
			// Antipattern: a default route must return a value, not flush. Delivering
			// here ships the good before settlement — the wrapper must refuse to
			// silently settle-skip.
			res.write('LEAKED-GOOD');
			res.end();
		});

		const { req, res } = mockReqRes({ headers: { 'x-payment': paymentHeader() } });
		await handler(req, res); // wrap() swallows the throw once the response is flushed

		expect(handlerRan).toBe(true);
		// The good was flushed, but settlement was NOT run — and the wrapper took
		// the loud path rather than the old silent `return`.
		expect(settlePayment).not.toHaveBeenCalled();
		const flushEvent = auditEvents.find((e) => e.eventType === 'payment_unsettled_flush');
		expect(flushEvent).toBeTruthy();
		expect(flushEvent.settlementStatus).toBe('failed');
		expect(auditEvents.some((e) => e.eventType === 'payment_settled')).toBe(false);
	});

	it('a normal JSON-returning handler on the default path is unaffected: settles and serialises as before', async () => {
		const handler = makeEndpoint(async ({ payer }) => ({ ok: true, payer }));

		const { req, res } = mockReqRes({ headers: { 'x-payment': paymentHeader() } });
		await handler(req, res);

		expect(settlePayment).toHaveBeenCalledTimes(1);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toMatchObject({ ok: true, payer: 'PAYER' });
		expect(res.getHeader('x-payment-response')).toBeTruthy();
		expect(res.getHeader('content-type')).toMatch(/application\/json/);
		expect(auditEvents.some((e) => e.eventType === 'payment_settled')).toBe(true);
	});
});
