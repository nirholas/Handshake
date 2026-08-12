// GET /api/crypto/whales — the free whale-activity endpoint contract.
//
// The scan engine's pure aggregation (threshold filter, per-scope shaping, the
// net-flow signal) is covered in tests/crypto-whales.test.js. Here we pin the
// ENDPOINT: method + input validation, scope selection, the clamps on minSol and
// limit, the degraded note, the stale flag, and the cache header. The scan module
// is mocked so no pump.fun request is made. Fixtures use $THREE (CA in CLAUDE.md)
// and a synthetic mint, never a real third-party mint.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const scanTokenWhalesMock = vi.fn();
const scanMarketWhalesMock = vi.fn();

vi.mock('../../api/_lib/pump-whale-scan.js', () => ({
	scanTokenWhales: (...a) => scanTokenWhalesMock(...a),
	scanMarketWhales: (...a) => scanMarketWhalesMock(...a),
	WHALE_MIN_SOL_DEFAULT: 5,
	WHALE_LIMIT_DEFAULT: 10,
	WHALE_LIMIT_MAX: 25,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { marketDataIp: vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: 0 })) },
	clientIp: () => '127.0.0.1',
}));

const { default: handler } = await import('../../api/crypto/whales.js');
const { limits } = await import('../../api/_lib/rate-limit.js');

const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}

async function call(url, method = 'GET') {
	const res = makeRes();
	await handler({ url, method, headers: { host: 'x' } }, res);
	let body = null;
	try { body = JSON.parse(res._body); } catch {}
	return { res, body };
}

function scanResult(over = {}) {
	return {
		scope: 'market',
		mint: null,
		whales: [{ wallet: 'HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk', solMoved: 12.5, txHash: 'sig1', ts: '2026-08-12T20:00:00.000Z' }],
		whaleCount: 1,
		totalSolMoved: 12.5,
		signal: 'bullish',
		ts: '2026-08-12T20:00:01.000Z',
		source: 'pump.fun',
		degraded: false,
		...over,
	};
}

beforeEach(() => {
	scanTokenWhalesMock.mockReset();
	scanMarketWhalesMock.mockReset();
	scanMarketWhalesMock.mockResolvedValue(scanResult());
	scanTokenWhalesMock.mockResolvedValue(scanResult({ scope: 'token', mint: THREE }));
	limits.marketDataIp.mockResolvedValue({ success: true, limit: 60, remaining: 59, reset: 0 });
});

describe('GET /api/crypto/whales — scope selection', () => {
	it('no mint scans the market and never calls the token scan', async () => {
		const { res, body } = await call('/api/crypto/whales');
		expect(res.statusCode).toBe(200);
		expect(scanMarketWhalesMock).toHaveBeenCalledTimes(1);
		expect(scanTokenWhalesMock).not.toHaveBeenCalled();
		expect(body.scope).toBe('market');
		expect(body.minSol).toBe(5);
		expect(body.signal).toBe('bullish');
		expect(res.getHeader('cache-control')).toMatch(/s-maxage=15/);
	});

	it('a mint scans that token and echoes it back', async () => {
		const { body } = await call(`/api/crypto/whales?mint=${THREE}`);
		expect(scanTokenWhalesMock).toHaveBeenCalledWith({ mint: THREE, minSol: 5, limit: 10 });
		expect(body.scope).toBe('token');
		expect(body.mint).toBe(THREE);
	});
});

describe('GET /api/crypto/whales — input validation', () => {
	it('405s a non-GET method', async () => {
		const { res, body } = await call('/api/crypto/whales', 'POST');
		expect(res.statusCode).toBe(405);
		expect(body.error).toBe('method_not_allowed');
		expect(scanMarketWhalesMock).not.toHaveBeenCalled();
	});

	it('400s a malformed mint before any scan', async () => {
		const { res, body } = await call('/api/crypto/whales?mint=not-base58!!');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_mint');
		expect(body.example).toContain('mint=');
		expect(scanTokenWhalesMock).not.toHaveBeenCalled();
	});

	it('400s a non-numeric or non-positive minSol', async () => {
		for (const bad of ['abc', '0', '-3']) {
			const { res, body } = await call(`/api/crypto/whales?minSol=${bad}`);
			expect(res.statusCode).toBe(400);
			expect(body.error).toBe('invalid_min_sol');
		}
		expect(scanMarketWhalesMock).not.toHaveBeenCalled();
	});

	it('400s a limit below 1', async () => {
		const { res, body } = await call('/api/crypto/whales?limit=0');
		expect(res.statusCode).toBe(400);
		expect(body.error).toBe('invalid_limit');
	});

	it('clamps minSol to the 0.1 floor and limit to the 25 ceiling', async () => {
		await call('/api/crypto/whales?minSol=0.0001&limit=9999');
		expect(scanMarketWhalesMock).toHaveBeenCalledWith({ minSol: 0.1, limit: 25 });
	});

	it('429s with the rate-limit headers when the IP bucket is exhausted', async () => {
		limits.marketDataIp.mockResolvedValue({ success: false, limit: 60, remaining: 0, reset: 1_800_000_000 });
		const { res, body } = await call('/api/crypto/whales');
		expect(res.statusCode).toBe(429);
		expect(body.error).toBeTruthy();
		expect(scanMarketWhalesMock).not.toHaveBeenCalled();
	});
});

describe('GET /api/crypto/whales — degraded + stale honesty', () => {
	it('feed down → 200 with an empty set and a retry note, never a 5xx', async () => {
		scanMarketWhalesMock.mockResolvedValue(
			scanResult({ whales: [], whaleCount: 0, totalSolMoved: 0, signal: 'neutral', degraded: true }),
		);
		const { res, body } = await call('/api/crypto/whales');
		expect(res.statusCode).toBe(200);
		expect(body.whales).toEqual([]);
		expect(body.signal).toBe('neutral');
		expect(body.note).toMatch(/temporarily unavailable/i);
		expect(body.degraded).toBeUndefined();
	});

	it('a quiet market answers empty WITHOUT the outage note', async () => {
		scanMarketWhalesMock.mockResolvedValue(
			scanResult({ whales: [], whaleCount: 0, totalSolMoved: 0, signal: 'neutral', degraded: false }),
		);
		const { body } = await call('/api/crypto/whales');
		expect(body.whales).toEqual([]);
		expect(body.note).toBeUndefined();
	});

	it('passes a stale flag through when the scan served last-known-good rows', async () => {
		scanMarketWhalesMock.mockResolvedValue(scanResult({ stale: true }));
		const { body } = await call('/api/crypto/whales');
		expect(body.stale).toBe(true);
	});
});
