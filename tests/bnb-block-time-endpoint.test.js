/**
 * GET /api/bnb/block-time integration tests.
 *
 * `probeBlockTime` (api/_lib/bnb/chains.js) and `api/_lib/rate-limit.js` are
 * mocked so the suite runs deterministically without a live BSC RPC. The
 * probe's own sampling math is covered in tests/bnb-chains.test.js; this file
 * exercises the HTTP boundary only: network validation, the per-network TTL
 * cache, RPC-failure mapping, rate limiting, and method/CORS handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rl = { ok: true };
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => ({ success: rl.ok, reset: Date.now() + 60_000, reason: rl.ok ? undefined : 'quota' })) },
	clientIp: () => '127.0.0.1',
}));

const probeState = { calls: 0, fail: false };
vi.mock('../api/_lib/bnb/chains.js', async () => {
	const actual = await vi.importActual('../api/_lib/bnb/chains.js');
	return {
		...actual,
		probeBlockTime: vi.fn(async (network, sampleBlocks) => {
			probeState.calls += 1;
			if (probeState.fail) {
				throw new actual.BnbRpcError('every RPC refused', { tried: ['https://bsc-dataseed.bnbchain.org'] });
			}
			return {
				network,
				avgBlockTimeMs: network === 'bscMainnet' ? 450 : 1500,
				latestBlock: 115_000_000,
				sampleBlocks,
				target: network === 'bscMainnet' ? 450 : null,
				measuredAt: new Date().toISOString(),
			};
		}),
	};
});

const { default: handler } = await import('../api/bnb/block-time.js');

function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	r.end = (b) => { r._b = b; };
	Object.defineProperty(r, '_s', { get() { return this.statusCode; } });
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}
async function call(qs = '', { method = 'GET' } = {}) {
	const req = {
		method,
		url: `/api/bnb/block-time${qs}`,
		headers: { origin: 'https://three.ws', host: 'three.ws' },
		socket: { remoteAddress: '127.0.0.1' },
	};
	const res = makeRes();
	await handler(req, res);
	return res;
}

beforeEach(() => {
	rl.ok = true;
	probeState.calls = 0;
	probeState.fail = false;
});
afterEach(() => {
	vi.clearAllMocks();
});

describe('GET /api/bnb/block-time measured response', () => {
	it('200 with a measured mainnet interval and its published target', async () => {
		const r = await call('?network=mainnet');
		expect(r._s).toBe(200);
		const body = r.json();
		expect(body.network).toBe('bscMainnet');
		expect(body.avgBlockTimeMs).toBe(450);
		expect(body.target).toBe(450);
		expect(body.latestBlock).toBeGreaterThan(0);
		expect(typeof body.measuredAt).toBe('string');
	});

	it('probes the testnet lane on request, where no published target exists', async () => {
		const r = await call('?network=testnet');
		expect(r._s).toBe(200);
		expect(r.json().network).toBe('bscTestnet');
		expect(r.json().target).toBe(null);
	});

	it('accepts the chain-id and bscMainnet spellings the /bnb page sends', async () => {
		expect((await call('?network=bscMainnet')).json().network).toBe('bscMainnet');
		expect((await call('?network=97')).json().network).toBe('bscTestnet');
	});

	it('400 on an unknown network instead of silently answering about mainnet', async () => {
		const r = await call('?network=polygon');
		expect(r._s).toBe(400);
		expect(r.json().error).toBe('bad_request');
		expect(probeState.calls).toBe(0);
	});

	it('caches per network, so a second call inside the TTL does not re-probe', async () => {
		await call('?network=mainnet');
		const before = probeState.calls;
		await call('?network=mainnet');
		expect(probeState.calls).toBe(before);
		await call('?network=testnet');
		expect(probeState.calls).toBe(before + 1);
	});
});

describe('GET /api/bnb/block-time failure paths', () => {
	it('502 with the tried endpoints when every RPC is unreachable', async () => {
		probeState.fail = true;
		const r = await call('?network=mainnet');
		expect(r._s).toBe(502);
		const body = r.json();
		expect(body.error).toBe('upstream_error');
		expect(body.tried).toEqual(['https://bsc-dataseed.bnbchain.org']);
	});

	it('429 carries retry-after so the polling /bnb page can back off', async () => {
		rl.ok = false;
		const r = await call('?network=mainnet');
		expect(r._s).toBe(429);
		expect(r.json().error).toBe('rate_limited');
		expect(Number(r.getHeader('retry-after'))).toBeGreaterThan(0);
	});

	it('405 on a non-GET method', async () => {
		const r = await call('', { method: 'POST' });
		expect(r._s).toBe(405);
	});

	it('204 on the CORS preflight', async () => {
		const r = await call('', { method: 'OPTIONS' });
		expect(r._s).toBe(204);
		expect(r.getHeader('access-control-allow-methods')).toContain('GET');
	});
});
