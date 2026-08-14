/**
 * /api/x402/permit2-paid-demo: the Permit2-forced paid demo.
 *
 * This route deliberately advertises ONE accept (exact + Permit2 on Base) so a
 * client cannot silently fall back to EIP-3009. Two behaviours are load-bearing
 * and covered here:
 *
 *   1. Permit2 settlement runs through CDP, so without CDP credentials the
 *      route must emit a clean 402 with an empty `accepts` rather than let a
 *      buyer waste an EIP-2612 signature on a path we cannot honor.
 *   2. A bypass caller (internal key / subscription / OAuth) never signs a
 *      payment, so the CDP requirement is irrelevant to them. The bypass
 *      response must be reachable on a deployment with no CDP credentials.
 *
 * Payment verify/settle are stubbed at the module boundary; nothing here
 * touches a facilitator or the chain.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

beforeAll(() => {
	Object.assign(process.env, {
		APP_ORIGIN: 'https://three.ws',
		X402_PAY_TO_BASE: '0x0000000000000000000000000000000000000402',
		X402_ASSET_ADDRESS_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
	});
	delete process.env.CDP_API_KEY_ID;
	delete process.env.CDP_API_KEY_SECRET;
});

const verifyPaymentMock = vi.fn();
const settlePaymentMock = vi.fn();
vi.mock('../../api/_lib/x402-spec.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		verifyPayment: (...a) => verifyPaymentMock(...a),
		settlePayment: (...a) => settlePaymentMock(...a),
		encodePaymentResponseHeader: () => 'stub-payment-response',
	};
});

// The bypass hook is what this suite drives; installAccessControl's own
// API-key/OAuth resolution has its own suite, so it is stubbed to a
// test-controlled verdict here.
const accessVerdict = { value: null };
vi.mock('../../api/_lib/x402/access-control.js', () => ({
	installAccessControl: () => async () => accessVerdict.value,
}));

const { default: handler } = await import('../../api/x402/permit2-paid-demo.js');

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) {
			this._h[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._h[k.toLowerCase()];
		},
		end(body) {
			this._body = body;
		},
	};
}

async function get(headers = {}, method = 'GET') {
	const res = makeRes();
	await handler(
		{ url: '/api/x402/permit2-paid-demo', method, headers: { host: 'three.ws', ...headers }, query: {} },
		res,
	);
	let parsed = null;
	try {
		parsed = JSON.parse(res._body);
	} catch {}
	return { res, body: parsed };
}

beforeEach(() => {
	accessVerdict.value = null;
	verifyPaymentMock.mockReset();
	settlePaymentMock.mockReset();
});

describe('GET /api/x402/permit2-paid-demo without CDP credentials', () => {
	it('emits a 402 with no accepts instead of an unpayable challenge', async () => {
		const { res, body } = await get();
		expect(res.statusCode).toBe(402);
		expect(body.accepts).toEqual([]);
		expect(body.error).toContain('CDP_API_KEY_ID');
	});

	it('still serves a bypass caller, who never signs a payment', async () => {
		accessVerdict.value = { grantAccess: true, reason: 'internal', callerId: 'internal' };
		const { res, body } = await get();
		expect(res.statusCode).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.bypass).toBe('internal');
		expect(body.method).toBe('permit2');
		expect(body.network).toBe('eip155:8453');
		expect(body.asset).toBe(process.env.X402_ASSET_ADDRESS_BASE);
		expect(body.amountAtomics).toBe('1000');
		expect(body.transaction).toBeNull();
		expect(res.getHeader('x-payment-bypass')).toBe('internal');
		expect(verifyPaymentMock).not.toHaveBeenCalled();
		expect(settlePaymentMock).not.toHaveBeenCalled();
	});

	it('rejects an aborted access-control verdict with its own status', async () => {
		accessVerdict.value = { abort: true, status: 429, code: 'rate_limited', reason: 'quota exhausted' };
		const { res, body } = await get();
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
	});
});

describe('GET /api/x402/permit2-paid-demo with CDP credentials', () => {
	beforeEach(() => {
		process.env.CDP_API_KEY_ID = 'test-cdp-id';
		process.env.CDP_API_KEY_SECRET = 'test-cdp-secret';
	});

	it('advertises exactly one Permit2 accept and no EIP-3009 sibling', async () => {
		const { res, body } = await get();
		expect(res.statusCode).toBe(402);
		expect(body.accepts).toHaveLength(1);
		expect(body.accepts[0].network).toBe('eip155:8453');
		expect(body.accepts[0].extra.assetTransferMethod).toBe('permit2');
		expect(body.accepts[0].extra.supportsEip2612).toBe(true);
	});

	it('refuses a verified payment whose payload is not a Permit2 authorization', async () => {
		verifyPaymentMock.mockResolvedValue({ paymentPayload: { payload: { authorization: {} } } });
		const { res, body } = await get({ 'x-payment': 'eip3009-proof' });
		expect(res.statusCode).toBe(402);
		expect(body.error).toContain('permit2Authorization');
		expect(settlePaymentMock).not.toHaveBeenCalled();
	});

	it('settles a Permit2 payload and returns the tx hash plus a Basescan link', async () => {
		const txHash = '0x9c0a7e5ad5c9c0bb6f04f6ad9c52f4f44bb6c5d9c0a7e5ad5c9c0bb6f04f6ad9';
		verifyPaymentMock.mockResolvedValue({
			paymentPayload: { payload: { permit2Authorization: { nonce: '1' } } },
			payer: '0x0000000000000000000000000000000000000abc',
			requirement: {
				network: 'eip155:8453',
				asset: process.env.X402_ASSET_ADDRESS_BASE,
				amount: '1000',
			},
		});
		settlePaymentMock.mockResolvedValue({ transaction: txHash });
		const { res, body } = await get({ 'x-payment': 'permit2-proof' });
		expect(res.statusCode).toBe(200);
		expect(body.transaction).toBe(txHash);
		expect(body.explorer).toBe(`https://basescan.org/tx/${txHash}`);
		expect(body.proxy).toBe('0x402085c248EeA27D92E8b30b2C58ed07f9E20001');
		expect(res.getHeader('x-payment-response')).toBe('stub-payment-response');
	});

	it('answers a wrong-method call with 405', async () => {
		const { res, body } = await get({}, 'POST');
		expect(res.statusCode).toBe(405);
		expect(body.error).toBe('method_not_allowed');
	});
});
