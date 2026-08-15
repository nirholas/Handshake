// Input-validation contract for POST /api/tx/explain, the endpoint the chat
// "explain this transaction" tool calls.
//
// The regression pinned here: the Solana branch validated the signature with a
// base58 alphabet + character-count check only. `'1'.repeat(88)` passes that and
// decodes to 88 zero bytes, not the 64 a signature is, so the RPC rejected it as
// a bad argument and the caller was told `502 upstream_error` for what is plainly
// their own malformed input. Worse, the request first spent a slot of the shared
// Helius cost ceiling and a call to the keyed enhanced-tx upstream. A signature is
// decoded and measured before anything leaves the process now.
//
// Every upstream (cache, Helius, RPC, LLM) is mocked, and the assertions below
// prove the rejected cases never reach one.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const cacheGet = vi.fn(async () => null);
const cacheSet = vi.fn(async () => {});
vi.mock('../api/_lib/cache.js', () => ({
	cacheGet: (...a) => cacheGet(...a),
	cacheSet: (...a) => cacheSet(...a),
}));

const heliusDasGlobal = vi.fn(async () => ({ success: true, limit: 100, remaining: 99, reset: Date.now() + 1000 }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		authedReadIp: vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: Date.now() + 1000 })),
		heliusDasGlobal: (...a) => heliusDasGlobal(...a),
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const getParsedTransaction = vi.fn(async () => null);
vi.mock('../api/_lib/solana/connection.js', () => ({
	solanaConnection: vi.fn(() => ({ getParsedTransaction: (...a) => getParsedTransaction(...a) })),
}));

// No summary lane in these cases: the endpoint's contract is the tx data.
vi.mock('../api/_lib/llm.js', () => ({
	llmConfigured: () => false,
	llmComplete: vi.fn(),
}));

vi.mock('../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));

import handler from '../api/tx/explain.js';

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		headersSent: false,
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(payload) { this.headersSent = true; this.writableEnded = true; this.body = payload; },
		get json() { return this.body ? JSON.parse(this.body) : null; },
	};
}

async function explain(body, method = 'POST') {
	const res = mockRes();
	await handler({ method, url: '/api/tx/explain', headers: { 'content-type': 'application/json' }, socket: {}, body }, res);
	return res;
}

// 64 real bytes of base58: the shape a Solana signature actually has.
const VALID_SIG = '5jUwmjLpwWnFVMPaMPnBrpVFhfDPHqCmk4Wf7Bwj1SPXHmoveEfXcNvEfxrGDMFqJTLdVvBzHmFSEZSKnvUppRSt';
const VALID_EVM_HASH = '0xa2bb8919c907fdc3e942962199520ed84171bb36a6290671dcc35ecbb1731c60';

const fetchMock = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	// Default: the keyed Helius enhanced lane rejects, which is what an unset
	// HELIUS_API_KEY produces, so the RPC fallback is the path under test.
	fetchMock.mockImplementation(async () => new Response('{}', { status: 401 }));
	cacheGet.mockResolvedValue(null);
	getParsedTransaction.mockResolvedValue(null);
	heliusDasGlobal.mockResolvedValue({ success: true, limit: 100, remaining: 99, reset: Date.now() + 1000 });
	vi.stubGlobal('fetch', fetchMock);
});

describe('POST /api/tx/explain input validation', () => {
	it('405s a GET', async () => {
		const res = await explain(undefined, 'GET');
		expect(res.statusCode).toBe(405);
	});

	it('400s a chain that is neither solana nor evm', async () => {
		const res = await explain({ chain: 'btc', sig: VALID_SIG });
		expect(res.statusCode).toBe(400);
		expect(res.json.error_description).toContain('solana or evm');
	});

	it('400s a missing signature', async () => {
		const res = await explain({ chain: 'solana' });
		expect(res.statusCode).toBe(400);
		expect(res.json.error_description).toBe('sig required');
	});

	it('400s base58 that is the right length but not 64 bytes', async () => {
		const res = await explain({ chain: 'solana', sig: '1'.repeat(88) });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('bad_request');
		expect(res.json.error_description).toContain('base58 transaction signature');
	});

	it('spends no upstream budget or call on a malformed signature', async () => {
		await explain({ chain: 'solana', sig: '1'.repeat(88) });
		expect(cacheGet).not.toHaveBeenCalled();
		expect(heliusDasGlobal).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(getParsedTransaction).not.toHaveBeenCalled();
	});

	it('400s characters outside the base58 alphabet', async () => {
		const res = await explain({ chain: 'solana', sig: '0OIl'.repeat(22) });
		expect(res.statusCode).toBe(400);
	});

	it('400s an EVM hash that is not 32 bytes', async () => {
		const res = await explain({ chain: 'evm', sig: '0xdeadbeef' });
		expect(res.statusCode).toBe(400);
		expect(res.json.error_description).toContain('32-byte tx hash');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('accepts a well-formed EVM hash and reaches the RPC chain', async () => {
		// A fresh Response per call: the handler fires getTransactionByHash and
		// getTransactionReceipt in parallel and a body can only be read once.
		fetchMock.mockImplementation(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 }));
		const res = await explain({ chain: 'evm', sig: VALID_EVM_HASH });
		expect(fetchMock).toHaveBeenCalled();
		expect(res.statusCode).toBe(404);
		expect(res.json.error).toBe('not_found');
	});

	it('404s a well-formed Solana signature with no matching transaction', async () => {
		const res = await explain({ chain: 'solana', sig: VALID_SIG });
		expect(getParsedTransaction).toHaveBeenCalledWith(VALID_SIG, expect.any(Object));
		expect(res.statusCode).toBe(404);
		expect(res.json.error).toBe('not_found');
	});

	it('502s a genuine RPC failure, keeping it distinct from a malformed input', async () => {
		getParsedTransaction.mockRejectedValue(new Error('all endpoints failed'));
		const res = await explain({ chain: 'solana', sig: VALID_SIG });
		expect(res.statusCode).toBe(502);
		expect(res.json.error).toBe('upstream_error');
	});

	it('serves a cached explanation without touching any upstream', async () => {
		cacheGet.mockResolvedValue({ tokenTransfers: [], nativeTransfers: [], feePayer: 'x', source: 'rpc-fallback' });
		const res = await explain({ chain: 'solana', sig: VALID_SIG });
		expect(res.statusCode).toBe(200);
		expect(res.json.feePayer).toBe('x');
		expect(heliusDasGlobal).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('429s when the shared Helius cost ceiling is exhausted', async () => {
		heliusDasGlobal.mockResolvedValue({ success: false, limit: 100, remaining: 0, reset: Date.now() + 60_000 });
		const res = await explain({ chain: 'solana', sig: VALID_SIG });
		expect(res.statusCode).toBe(429);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('reconstructs transfers from a parsed transaction when Helius is unavailable', async () => {
		getParsedTransaction.mockResolvedValue({
			transaction: { message: { accountKeys: [{ pubkey: 'Payer1111' }, { pubkey: 'Dest1111' }] } },
			meta: {
				preBalances: [1_000_000, 0],
				postBalances: [500_000, 495_000],
				preTokenBalances: [],
				postTokenBalances: [],
			},
		});
		const res = await explain({ chain: 'solana', sig: VALID_SIG });
		expect(res.statusCode).toBe(200);
		expect(res.json.source).toBe('rpc-fallback');
		expect(res.json.feePayer).toBe('Payer1111');
		expect(res.json.nativeTransfers).toEqual([
			{ account: 'Payer1111', amount: -500_000 },
			{ account: 'Dest1111', amount: 495_000 },
		]);
		expect(cacheSet).toHaveBeenCalled();
	});
});
