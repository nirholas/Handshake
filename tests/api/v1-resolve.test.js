// GET /api/v1/resolve — free ENS + SNS name resolution.
//
// The endpoint wraps two existing platform resolvers rather than
// reimplementing them: viem's ENS Universal Resolver over the shared EVM
// failover transport (api/_lib/evm/rpc.js `evmTransport`) and
// src/solana/sns.js's `resolveSnsName` / `reverseLookupAddress`
// (the exact module api/sns.js and api/sns-subdomain.js already share for
// SNS). These tests mock those two modules at the boundary and exercise the
// real handler: forward .eth / .sol resolution, reverse address lookups in
// both directions, an unsupported suffix (400), an unresolvable name/address
// (404, not 500), the per-IP rate limit (429), and the catalog registration.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

const THREE_ETH_ADDR = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const THREE_SOL_ADDR = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// Switchable per-IP quota result — flip `quotaOk` per test.
let quotaOk = true;
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		apiV1: async () => ({ success: true, limit: 120, remaining: 119, reset: Date.now() + 60_000 }),
		resolveIp: async () =>
			quotaOk
				? { success: true, limit: 30, remaining: 29, reset: Date.now() + 60_000 }
				: { success: false, limit: 30, remaining: 0, reset: Date.now() + 60_000 },
	},
	clientIp: () => '203.0.113.9',
}));

// SNS resolver stub — mirrors api/sns.js's own dependency, src/solana/sns.js.
let snsForward = async () => null;
let snsReverse = async () => null;
vi.mock('../../src/solana/sns.js', () => ({
	resolveSnsName: (name) => snsForward(name),
	reverseLookupAddress: (addr) => snsReverse(addr),
}));

// ENS stub. The handler resolves through viem's Universal Resolver client
// (one eth_call per direction) built on the shared failover transport, so the
// boundary to stub is viem's public client rather than an ethers provider.
// `evmTransport` is still mocked so no test ever opens a real RPC socket.
let ensForward = async () => null;
let ensReverse = async () => null;
vi.mock('../../api/_lib/evm/rpc.js', () => ({
	evmTransport: () => 'stub-transport',
}));
vi.mock('viem', async (importOriginal) => ({
	...(await importOriginal()),
	createPublicClient: () => ({
		getEnsAddress: ({ name }) => ensForward(name),
		getEnsName: ({ address }) => ensReverse(address),
	}),
}));

beforeEach(() => {
	quotaOk = true;
	snsForward = async () => null;
	snsReverse = async () => null;
	ensForward = async () => null;
	ensReverse = async () => null;
});
afterEach(() => {
	vi.restoreAllMocks();
});

function makeReq({ url = '/api/v1/resolve', host = 'three.ws' } = {}) {
	const stream = Readable.from([]);
	stream.method = 'GET';
	stream.url = url;
	stream.headers = { host };
	return stream;
}

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; this.writableEnded = true; },
	};
}

async function dispatch(req, res) {
	const mod = await import('../../api/v1/resolve.js');
	await mod.default(req, res);
	return { res, body: res._body ? JSON.parse(res._body) : null };
}

// ── Forward resolution ──────────────────────────────────────────────────────
describe('GET /api/v1/resolve — forward', () => {
	it('resolves a .eth name to its Ethereum address via ENS', async () => {
		ensForward = async (name) => (name === 'vitalik.eth' ? THREE_ETH_ADDR : null);
		const { res, body } = await dispatch(makeReq({ url: '/api/v1/resolve?name=vitalik.eth' }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({
			name: 'vitalik.eth',
			chain: 'ethereum',
			address: THREE_ETH_ADDR,
			source: 'ens',
		});
		expect(res.getHeader('cache-control')).toMatch(/max-age=300/);
	});

	it('resolves a .sol name to its Solana owner via SNS', async () => {
		snsForward = async (name) => (name === 'bonfida.sol' ? THREE_SOL_ADDR : null);
		const { res, body } = await dispatch(makeReq({ url: '/api/v1/resolve?name=bonfida.sol' }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({
			name: 'bonfida.sol',
			chain: 'solana',
			address: THREE_SOL_ADDR,
			source: 'sns',
		});
	});

	it('returns 404 not_found (never 500) when an ENS name does not resolve', async () => {
		ensForward = async () => null;
		const { res, body } = await dispatch(makeReq({ url: '/api/v1/resolve?name=doesnotexist12345.eth' }), makeRes());
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('returns 404 not_found (never 500) when a .sol name does not resolve', async () => {
		snsForward = async () => null;
		const { res, body } = await dispatch(makeReq({ url: '/api/v1/resolve?name=doesnotexist12345.sol' }), makeRes());
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('rejects an unsupported suffix with 400 naming the supported suffixes', async () => {
		const { res, body } = await dispatch(makeReq({ url: '/api/v1/resolve?name=foo.com' }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('unsupported_suffix');
		expect(body.error_description).toMatch(/\.eth/);
		expect(body.error_description).toMatch(/\.sol/);
	});

	it('rejects a request with neither name nor address', async () => {
		const { res, body } = await dispatch(makeReq({ url: '/api/v1/resolve' }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('rejects a request passing both name and address', async () => {
		const url = `/api/v1/resolve?name=vitalik.eth&address=${THREE_SOL_ADDR}`;
		const { res, body } = await dispatch(makeReq({ url }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});
});

// ── Reverse resolution ──────────────────────────────────────────────────────
describe('GET /api/v1/resolve — reverse', () => {
	it('reverse-resolves a Solana address to its primary SNS domain', async () => {
		snsReverse = async (addr) => (addr === THREE_SOL_ADDR ? 'bonfida.sol' : null);
		const { res, body } = await dispatch(makeReq({ url: `/api/v1/resolve?address=${THREE_SOL_ADDR}` }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({
			address: THREE_SOL_ADDR,
			chain: 'solana',
			name: 'bonfida.sol',
			source: 'sns',
		});
	});

	it('reverse-resolves an Ethereum address to its primary ENS name', async () => {
		ensReverse = async (addr) => (addr === THREE_ETH_ADDR ? 'vitalik.eth' : null);
		const { res, body } = await dispatch(makeReq({ url: `/api/v1/resolve?address=${THREE_ETH_ADDR}` }), makeRes());
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({
			address: THREE_ETH_ADDR,
			chain: 'ethereum',
			name: 'vitalik.eth',
			source: 'ens',
		});
	});

	it('returns 404 not_found when a Solana address has no favorite domain', async () => {
		snsReverse = async () => null;
		const { res, body } = await dispatch(makeReq({ url: `/api/v1/resolve?address=${THREE_SOL_ADDR}` }), makeRes());
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('rejects a malformed address with 400', async () => {
		const { res, body } = await dispatch(makeReq({ url: '/api/v1/resolve?address=not-an-address' }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});

	it('rejects a chain hint that mismatches the address format', async () => {
		const url = `/api/v1/resolve?address=${THREE_SOL_ADDR}&chain=ethereum`;
		const { res, body } = await dispatch(makeReq({ url }), makeRes());
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
	});
});

// ── Rate limit ───────────────────────────────────────────────────────────────
describe('GET /api/v1/resolve — rate limit', () => {
	it('returns 429 when the per-IP quota is exhausted', async () => {
		quotaOk = false;
		const { res, body } = await dispatch(makeReq({ url: '/api/v1/resolve?name=vitalik.eth' }), makeRes());
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
		expect(res.getHeader('retry-after')).toBeTruthy();
	});
});

// ── Catalog registration ────────────────────────────────────────────────────
describe('/api/v1 catalog', () => {
	it('registers the resolve endpoint as a free, public GET', async () => {
		const { CATALOG } = await import('../../api/v1/_catalog.js');
		const entry = CATALOG.find((e) => e.id === 'v1.resolve');
		expect(entry).toBeTruthy();
		expect(entry.method).toBe('GET');
		expect(entry.path).toBe('/api/v1/resolve');
		expect(entry.auth).toBe('public');
		expect(entry.params.name).toBeTruthy();
		expect(entry.params.address).toBeTruthy();
	});
});
