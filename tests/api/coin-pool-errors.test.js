// /api/coin/pool: every upstream outcome maps to a status the client can act on.
//
// The /coin/:id page mounts the GeckoTerminal chart embed only when this route
// resolves a pool, and falls back to an "open on GeckoTerminal" link otherwise.
// That decision hangs entirely on the status, so the mapping is the contract:
// no indexed pool is a 404 (a real answer about a real token), a throttle is a
// 429 the client can retry, and anything else is a 502.
//
// The catch block also has to survive a rejection that carries no `status` at
// all. `AbortSignal.timeout` rejects with a DOMException, and a bare `throw`
// deeper in the stack can reject with a non-object; reading `.status` off those
// unguarded turned a routine upstream timeout into an unhandled 500.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: () => {} }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { marketDataIp: async () => ({ success: true }) },
	clientIp: () => '203.0.113.1',
}));

// Re-created per test rather than cleared between them: clearing a vitest mock
// detaches the rejection tracking attached to its promise result, so a
// `mockRejectedValue` lane surfaces as an unhandled rejection even though the
// handler awaited and caught it.
let topPoolForToken = vi.fn();
vi.mock('../../api/_lib/market/ohlcv.js', () => ({
	topPoolForToken: (...a) => topPoolForToken(...a),
}));

const pool = (await import('../../api/coin/pool.js')).default;

// $THREE, the platform's own mint: a real, indexed Solana token.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const EVM_TOKEN = '0x1234567890abcdef1234567890abcdef12345678';

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}
async function call(query) {
	const res = makeRes();
	await pool({ url: `/api/coin/pool?${query}`, method: 'GET', headers: {} }, res);
	return { res, body: JSON.parse(res._body) };
}

describe('/api/coin/pool status mapping', () => {
	beforeEach(() => { topPoolForToken = vi.fn(); });

	it('resolves the most-liquid pool for a Solana mint', async () => {
		topPoolForToken.mockResolvedValue('5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z');
		const { res, body } = await call(`address=${THREE_MINT}&network=solana`);
		expect(res.statusCode).toBe(200);
		expect(body).toEqual({
			network: 'solana',
			address: THREE_MINT,
			pool: '5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z',
		});
		expect(res.getHeader('cache-control')).toMatch(/s-maxage=\d+/);
	});

	it('defaults to the home chain when no network is given', async () => {
		topPoolForToken.mockResolvedValue('pool123');
		const { res } = await call(`address=${THREE_MINT}`);
		expect(res.statusCode).toBe(200);
		expect(topPoolForToken).toHaveBeenCalledWith(THREE_MINT, 'solana');
	});

	it('accepts an EVM token on an EVM network', async () => {
		topPoolForToken.mockResolvedValue('0xpool');
		const { res } = await call(`address=${EVM_TOKEN}&network=base`);
		expect(res.statusCode).toBe(200);
	});

	it('rejects an unsupported network before any upstream call', async () => {
		const { res, body } = await call(`address=${THREE_MINT}&network=fakenet`);
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_network');
		expect(topPoolForToken).not.toHaveBeenCalled();
	});

	it('rejects an EVM address submitted as a Solana mint', async () => {
		const { res, body } = await call(`address=${EVM_TOKEN}&network=solana`);
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_address');
		expect(topPoolForToken).not.toHaveBeenCalled();
	});

	it('rejects a Solana mint submitted as an EVM address', async () => {
		const { res, body } = await call(`address=${THREE_MINT}&network=base`);
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('bad_address');
		expect(topPoolForToken).not.toHaveBeenCalled();
	});

	it('reports an unindexed token as 404, not an outage', async () => {
		const err = new Error('not found');
		err.status = 404;
		topPoolForToken.mockRejectedValue(err);
		const { res, body } = await call(`address=${THREE_MINT}&network=solana`);
		expect(res.statusCode).toBe(404);
		expect(body.error).toBe('no_pool');
	});

	it('passes a throttle through as 429 so the client can back off', async () => {
		const err = new Error('too many requests');
		err.status = 429;
		topPoolForToken.mockRejectedValue(err);
		const { res, body } = await call(`address=${THREE_MINT}&network=solana`);
		expect(res.statusCode).toBe(429);
		expect(body.error).toBe('rate_limited');
	});

	it('answers 502 for a timeout that carries no status', async () => {
		// AbortSignal.timeout rejects with a DOMException: an object with no
		// `.status`. Reading it unguarded used to throw inside the catch.
		topPoolForToken.mockRejectedValue(new DOMException('The operation was aborted.', 'TimeoutError'));
		const { res, body } = await call(`address=${THREE_MINT}&network=solana`);
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});

	it('answers 502 for a non-object rejection instead of a 500', async () => {
		topPoolForToken.mockRejectedValue(undefined);
		const { res, body } = await call(`address=${THREE_MINT}&network=solana`);
		expect(res.statusCode).toBe(502);
		expect(body.error).toBe('upstream_error');
	});
});
