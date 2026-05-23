// /api/sns endpoint — forward + reverse Solana Name Service lookups. We mock
// the underlying `src/solana/sns.js` helpers so the test runs offline, and
// assert the HTTP envelope (input validation, 404 vs 200 shape, Cache-Control
// hints) plus the in-process positive/negative cache.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveSnsName = vi.fn();
const reverseLookupAddress = vi.fn();

vi.mock('../../src/solana/sns.js', () => ({
	resolveSnsName: (...a) => resolveSnsName(...a),
	reverseLookupAddress: (...a) => reverseLookupAddress(...a),
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { snsResolve: vi.fn(async () => ({ success: true })) },
	clientIp: () => '127.0.0.1',
}));

const ADDR = 'HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk';

const handlerMod = await import('../../api/sns.js');
const handler = handlerMod.default;
const { forwardCache, reverseCache } = handlerMod._internals;

function makeReq(url, method = 'GET') {
	return { url, method, headers: { host: 'x' }, query: {} };
}
function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}
async function call(url, method) {
	const res = makeRes();
	await handler(makeReq(url, method), res);
	let body = null;
	try { body = JSON.parse(res._body); } catch {}
	return { res, body };
}

beforeEach(() => {
	resolveSnsName.mockReset();
	reverseLookupAddress.mockReset();
	forwardCache.clear();
	reverseCache.clear();
});

describe('GET /api/sns?name=…', () => {
	it('resolves a valid .sol name and returns address + Cache-Control', async () => {
		resolveSnsName.mockResolvedValue(ADDR);
		const { res, body } = await call('/api/sns?name=bonfida.sol');
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({ name: 'bonfida.sol', address: ADDR, network: 'solana' });
		expect(res.getHeader('cache-control')).toMatch(/max-age=300/);
		expect(resolveSnsName).toHaveBeenCalledWith('bonfida');
	});

	it('accepts a bare label without .sol', async () => {
		resolveSnsName.mockResolvedValue(ADDR);
		const { body } = await call('/api/sns?name=bonfida');
		expect(body.data.name).toBe('bonfida.sol');
		expect(resolveSnsName).toHaveBeenCalledWith('bonfida');
	});

	it('accepts dotted subdomain names', async () => {
		resolveSnsName.mockResolvedValue(ADDR);
		const { res, body } = await call('/api/sns?name=nich.threews.sol');
		expect(res.statusCode).toBe(200);
		expect(body.data.name).toBe('nich.threews.sol');
		expect(resolveSnsName).toHaveBeenCalledWith('nich.threews');
	});

	it('returns 404 when the name has no owner', async () => {
		resolveSnsName.mockResolvedValue(null);
		const { res, body } = await call('/api/sns?name=does-not-exist.sol');
		expect(res.statusCode).toBe(404);
		expect(body.error_description).toMatch(/does not resolve/);
		expect(res.getHeader('cache-control')).toMatch(/max-age=30/);
	});

	it('rejects malformed names', async () => {
		const { res, body } = await call('/api/sns?name=NOT*A*NAME');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('validation_error');
		expect(resolveSnsName).not.toHaveBeenCalled();
	});

	it('caches positive lookups so repeated calls hit memory once', async () => {
		resolveSnsName.mockResolvedValue(ADDR);
		await call('/api/sns?name=bonfida.sol');
		await call('/api/sns?name=bonfida.sol');
		await call('/api/sns?name=BONFIDA.sol');
		expect(resolveSnsName).toHaveBeenCalledTimes(1);
	});
});

describe('GET /api/sns?address=…', () => {
	it('reverses a valid address to a .sol name', async () => {
		reverseLookupAddress.mockResolvedValue('bonfida.sol');
		const { res, body } = await call(`/api/sns?address=${ADDR}`);
		expect(res.statusCode).toBe(200);
		expect(body.data).toEqual({ name: 'bonfida.sol', address: ADDR, network: 'solana' });
		expect(reverseLookupAddress).toHaveBeenCalledWith(ADDR);
	});

	it('returns 404 when no primary domain is set', async () => {
		reverseLookupAddress.mockResolvedValue(null);
		const { res, body } = await call(`/api/sns?address=${ADDR}`);
		expect(res.statusCode).toBe(404);
		expect(body.error_description).toMatch(/no primary/);
	});

	it('rejects malformed addresses', async () => {
		const { res } = await call('/api/sns?address=not-an-address');
		expect(res.statusCode).toBe(400);
		expect(reverseLookupAddress).not.toHaveBeenCalled();
	});
});

describe('GET /api/sns (input validation)', () => {
	it('rejects calls with neither name nor address', async () => {
		const { res } = await call('/api/sns');
		expect(res.statusCode).toBe(400);
	});

	it('rejects calls with both name and address', async () => {
		const { res } = await call(`/api/sns?name=x.sol&address=${ADDR}`);
		expect(res.statusCode).toBe(400);
	});

	it('rejects non-GET methods', async () => {
		const { res } = await call('/api/sns?name=x.sol', 'POST');
		expect(res.statusCode).toBe(405);
	});
});
