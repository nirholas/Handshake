// Route-handler tests for api/wallet/balances.js (POST /api/wallet/balances).
//
// This is the one balance reader whose address comes straight off the wire
// (every other getBalances() caller reads a wallet out of our own DB), so the
// HTTP boundary is the only thing standing between caller junk and an upstream
// RPC call. What is covered here:
//
//   1. Address shape is enforced per chain BEFORE any upstream work. Helius/DAS
//      answers "no assets" for base58-shaped garbage, so an unvalidated bad
//      address used to come back as a 200 with a native amount of 0 and an empty
//      token list: indistinguishable from a real empty wallet, and a free
//      arbitrary-length round trip against our RPC quota.
//   2. The success path passes the trimmed address through and returns the
//      reader's payload verbatim.
//   3. The two upstream failure shapes getBalances() raises stay mapped to
//      their intended statuses (503 not_configured with the missing key named,
//      502 for a bad upstream) rather than collapsing into a 500.
//   4. A body that could not be READ keeps readJson()'s own status (415 for a
//      non-JSON content-type, 413 for an oversize payload) instead of being
//      reported as a field-validation fault, and a body that was read and
//      rejected comes back as the platform's validation_error shape: one
//      readable line plus a field-level `issues` array, not zod's raw
//      multi-line JSON dump of every issue.

import { Readable } from 'node:stream';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// A clearly-synthetic wallet: these cases assert routing and validation only, so
// a real mainnet address would add nothing but a claim we do not mean.
const WALLET = 'THREEsynthetic1111111111111111111111111111';
const EVM_WALLET = '0x1111111111111111111111111111111111111111';

const balancesState = { result: null, error: null, calls: [] };

vi.mock('../api/_lib/balances.js', () => ({
	getBalances: vi.fn(async (args) => {
		balancesState.calls.push(args);
		if (balancesState.error) throw balancesState.error;
		return balancesState.result;
	}),
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { authedReadIp: vi.fn(async () => ({ success: true })) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const handler = (await import('../api/wallet/balances.js')).default;

function makeReq({ method = 'POST', rawBody = null, contentType = 'application/json' } = {}) {
	const req = Readable.from(rawBody == null ? [] : [Buffer.from(rawBody)]);
	req.method = method;
	req.url = '/api/wallet/balances';
	req.headers = {
		host: 'localhost',
		...(rawBody == null ? {} : { 'content-type': contentType }),
	};
	return req;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
	};
}

async function call(body, { method = 'POST', contentType } = {}) {
	const rawBody = body === undefined ? null : JSON.stringify(body);
	const res = makeRes();
	await handler(makeReq({ method, rawBody, contentType }), res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

// Bypasses JSON.stringify so a case can put arbitrary bytes on the wire.
async function callRaw(rawBody, { contentType = 'application/json' } = {}) {
	const res = makeRes();
	await handler(makeReq({ rawBody, contentType }), res);
	return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

beforeEach(() => {
	balancesState.calls = [];
	balancesState.error = null;
	balancesState.result = {
		chain: 'solana',
		address: WALLET,
		native: { symbol: 'SOL', name: 'Solana', amount: 1.5, price: 100, change24h: null, usd: 150 },
		tokens: [],
	};
});

describe('wallet balances: address validation', () => {
	it('rejects a Solana address that is not base58, without calling upstream', async () => {
		const { status, body } = await call({ chain: 'solana', address: 'not-a-real-address' });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(body.error_description).toContain('base58');
		expect(balancesState.calls).toHaveLength(0);
	});

	it('rejects an over-long address instead of paying for the RPC round trip', async () => {
		const { status } = await call({ chain: 'solana', address: 'A'.repeat(5000) });
		expect(status).toBe(400);
		expect(balancesState.calls).toHaveLength(0);
	});

	it('rejects a Solana-shaped address on the evm chain', async () => {
		const { status, body } = await call({ chain: 'evm', address: WALLET });
		expect(status).toBe(400);
		expect(body.error_description).toContain('0x-prefixed');
		expect(balancesState.calls).toHaveLength(0);
	});

	it('rejects an unknown chain', async () => {
		const { status, body } = await call({ chain: 'bitcoin', address: WALLET });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(balancesState.calls).toHaveLength(0);
	});

	it('accepts an evm address on the evm chain', async () => {
		balancesState.result = { chain: 'evm', address: EVM_WALLET, native: null, tokens: [] };
		const { status } = await call({ chain: 'evm', address: EVM_WALLET });
		expect(status).toBe(200);
		expect(balancesState.calls[0]).toEqual({ chain: 'evm', address: EVM_WALLET });
	});
});

describe('wallet balances: unreadable bodies keep their own status', () => {
	it('answers a non-JSON content-type with 415, not a field-validation 400', async () => {
		const { status, body } = await callRaw('chain=solana', { contentType: 'text/plain' });
		expect(status).toBe(415);
		expect(body.error).toBe('unsupported_media_type');
		expect(balancesState.calls).toHaveLength(0);
	});

	it('answers an oversize body with 413 rather than blaming the caller fields', async () => {
		const oversize = JSON.stringify({ chain: 'solana', address: WALLET, pad: 'x'.repeat(1_200_000) });
		const { status, body } = await callRaw(oversize);
		expect(status).toBe(413);
		expect(body.error).toBe('payload_too_large');
		expect(balancesState.calls).toHaveLength(0);
	});

	it('answers an unparseable body with 400 and no validation issues list', async () => {
		const { status, body } = await callRaw('{"chain":');
		expect(status).toBe(400);
		expect(body.error).toBe('bad_request');
		expect(body.issues).toBeUndefined();
		expect(balancesState.calls).toHaveLength(0);
	});
});

describe('wallet balances: rejected bodies use the platform validation shape', () => {
	it('returns one readable line plus a field-level issues array', async () => {
		const { status, body } = await call({ chain: 'solana', address: 'not-a-real-address' });
		expect(status).toBe(400);
		expect(body.error).toBe('validation_error');
		// One line naming the field, never zod's multi-line JSON dump of the issues.
		expect(body.error_description).toBe('address: must be a base58 Solana address (32-44 chars)');
		expect(body.error_description).not.toContain('\n');
		expect(body.issues).toEqual([
			{ path: ['address'], code: 'custom', message: 'must be a base58 Solana address (32-44 chars)' },
		]);
	});

	it('names the offending field for a bad chain too', async () => {
		const { body } = await call({ chain: 'bitcoin', address: WALLET });
		expect(body.error_description).toMatch(/^chain: /);
		expect(body.issues[0].path).toEqual(['chain']);
	});
});

describe('wallet balances: success path', () => {
	it('returns the reader payload and passes the trimmed address through', async () => {
		const { status, body } = await call({ chain: 'solana', address: `  ${WALLET}  ` });
		expect(status).toBe(200);
		expect(balancesState.calls[0]).toEqual({ chain: 'solana', address: WALLET });
		expect(body.native.amount).toBe(1.5);
		expect(body.tokens).toEqual([]);
	});

	it('answers a wrong method with 405 rather than running the reader', async () => {
		const { status } = await call(undefined, { method: 'GET' });
		expect(status).toBe(405);
		expect(balancesState.calls).toHaveLength(0);
	});
});

describe('wallet balances: upstream failures', () => {
	it('maps a missing provider key to 503 and names the key', async () => {
		balancesState.error = Object.assign(new Error('not_configured: ALCHEMY_API_KEY'), {
			code: 'not_configured',
			missing: 'ALCHEMY_API_KEY',
		});
		const { status, body } = await call({ chain: 'evm', address: EVM_WALLET });
		expect(status).toBe(503);
		expect(body.error).toBe('not_configured');
		expect(body.missing_key).toBe('ALCHEMY_API_KEY');
	});

	it('maps a bad upstream response to 502', async () => {
		balancesState.error = Object.assign(new Error('upstream 500: boom'), { status: 502 });
		const { status, body } = await call({ chain: 'solana', address: WALLET });
		expect(status).toBe(502);
		expect(body.error).toBe('upstream_error');
	});
});
