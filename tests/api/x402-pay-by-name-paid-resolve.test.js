/**
 * /api/x402/pay-by-name: the PAID name-resolution lane (POST {"name":…} with
 * no payer_wallet / amount_usdc / mode).
 *
 * The point of this suite is the settlement ORDER. The endpoint sells one
 * thing: an on-chain address for a name. When the name resolves to nothing
 * there is no good to deliver, so the buyer's payment must be left unspent
 * (same rule the pipeline stages follow: never charge for a stage that
 * produced no output). Payment verify/settle are stubbed at the module
 * boundary; SNS and the DB are stubbed so the suite stays offline.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

beforeAll(() => {
	Object.assign(process.env, {
		APP_ORIGIN: 'https://three.ws',
		X402_PAY_TO_SOLANA: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		X402_FEE_PAYER_SOLANA: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		X402_ASSET_MINT_SOLANA: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		THREEWS_SOL_PARENT_DOMAIN: 'threews.sol',
	});
});

const verifyPaymentMock = vi.fn(async () => ({
	payer: 'HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk',
	requirement: { network: 'solana:mainnet', amount: '1000' },
}));
const settlePaymentMock = vi.fn(async () => ({ transaction: 'sig-1' }));
vi.mock('../../api/_lib/x402-spec.js', async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		verifyPayment: (...a) => verifyPaymentMock(...a),
		settlePayment: (...a) => settlePaymentMock(...a),
		encodePaymentResponseHeader: () => 'stub-payment-response',
	};
});

const sqlMock = vi.fn(async () => []);
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const snsResolveMock = vi.fn();
vi.mock('@bonfida/spl-name-service', () => ({ resolve: (...a) => snsResolveMock(...a) }));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { authIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => null),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: () => null,
}));

vi.mock('../../api/_lib/agent-pumpfun.js', () => ({
	solanaConnection: () => ({}),
	loadAgentForSigning: vi.fn(async () => ({ error: { status: 404, code: 'not_found', msg: 'nope' } })),
}));

const logPaymentEventMock = vi.fn();
vi.mock('../../api/_lib/x402/audit-log.js', () => ({ logPaymentEvent: (...a) => logPaymentEventMock(...a) }));

const { default: handler } = await import('../../api/x402/pay-by-name.js');

// An on-curve wallet, so `verified` comes back true on the happy path.
const WALLET = 'HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk';

function makeReq(body, headers = {}) {
	const req = {
		url: '/api/x402/pay-by-name',
		method: 'POST',
		headers: { host: 'three.ws', 'content-type': 'application/json', ...headers },
		query: {},
	};
	const buf = Buffer.from(JSON.stringify(body));
	let read = false;
	req.on = (event, cb) => {
		if (event === 'data' && !read) {
			cb(buf);
			read = true;
		} else if (event === 'end') queueMicrotask(cb);
		return req;
	};
	req.headers['content-length'] = String(buf.length);
	return req;
}

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

async function post(body, headers) {
	const res = makeRes();
	await handler(makeReq(body, headers), res);
	let parsed = null;
	try {
		parsed = JSON.parse(res._body);
	} catch {}
	return { res, body: parsed };
}

beforeEach(() => {
	verifyPaymentMock.mockClear();
	settlePaymentMock.mockClear();
	logPaymentEventMock.mockClear();
	sqlMock.mockReset().mockResolvedValue([]);
	snsResolveMock.mockReset();
});

describe('POST /api/x402/pay-by-name (paid resolution)', () => {
	it('challenges an unpaid call with a 402 carrying a Solana accept', async () => {
		const { res, body } = await post({ name: 'x402-audit-probe.sol' });
		expect(res.statusCode).toBe(402);
		expect(body.accepts).toHaveLength(1);
		expect(body.accepts[0].amount).toBe('1000');
		expect(settlePaymentMock).not.toHaveBeenCalled();
	});

	it('challenges a name-less probe rather than 400ing it (registry probes are body-less)', async () => {
		// Directory validators register a paid row by probing it with a bare POST
		// and reading the 402 back; a pre-payment 400 tells them the row sells
		// nothing, which is how this route stayed off the x402scan origin listing.
		// The challenge now comes first, and nothing on the payment path runs.
		const { res, body } = await post({ name: '   ' });
		expect(res.statusCode).toBe(402);
		expect(body.accepts).toHaveLength(1);
		expect(verifyPaymentMock).not.toHaveBeenCalled();
		expect(settlePaymentMock).not.toHaveBeenCalled();
	});

	it('rejects a missing name past the paywall, before verify or settle', async () => {
		const { res, body } = await post({ name: '   ' }, { 'x-payment': 'proof' });
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(verifyPaymentMock).not.toHaveBeenCalled();
		expect(settlePaymentMock).not.toHaveBeenCalled();
	});

	it('settles and returns the address when the name resolves', async () => {
		snsResolveMock.mockResolvedValue({ toBase58: () => WALLET });
		const { res, body } = await post({ name: 'x402-audit-probe.sol' }, { 'x-payment': 'proof' });
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({
			name: 'x402-audit-probe.sol',
			address: WALLET,
			verified: true,
			source: 'sns',
		});
		expect(settlePaymentMock).toHaveBeenCalledTimes(1);
		expect(res.getHeader('x-payment-response')).toBe('stub-payment-response');
	});

	it('does NOT settle when the name resolves to nothing', async () => {
		snsResolveMock.mockRejectedValue(new Error('domain not found'));
		const { res, body } = await post({ name: 'definitely-not-registered.sol' }, { 'x-payment': 'proof' });
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
		expect(body.error_description).toContain('payment was not taken');
		expect(verifyPaymentMock).toHaveBeenCalledTimes(1);
		expect(settlePaymentMock).not.toHaveBeenCalled();
		expect(logPaymentEventMock).not.toHaveBeenCalled();
	});

	it('re-challenges with a 402 when the payment does not verify', async () => {
		verifyPaymentMock.mockRejectedValueOnce(new Error('bad signature'));
		const { res, body } = await post({ name: 'x402-audit-probe.sol' }, { 'x-payment': 'garbage' });
		expect(res.statusCode).toBe(402);
		expect(body.error).toBe('bad signature');
		expect(settlePaymentMock).not.toHaveBeenCalled();
	});

	it('surfaces a settle failure as a 502 rather than a silent success', async () => {
		snsResolveMock.mockResolvedValue({ toBase58: () => WALLET });
		settlePaymentMock.mockRejectedValueOnce(new Error('facilitator down'));
		const { res, body } = await post({ name: 'x402-audit-probe.sol' }, { 'x-payment': 'proof' });
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('settle_failed');
	});
});
