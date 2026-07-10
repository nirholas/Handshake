import { describe, it, expect, vi, beforeEach } from 'vitest';

// Test the endpoint's COMPOSITION + branching (input validation, not-found →
// 400, upstream-down → 503, success shape), not the network beneath it.
vi.mock('../api/_lib/http.js', () => ({
	wrap: (fn) => fn,
	cors: () => false,
	method: () => true,
	rateLimited: (res) => {
		res._json = { status: 429, body: { error: 'rate_limited' } };
		return res;
	},
	error: (res, status, code, message, extra = {}) => {
		res._json = { status, body: { error: code, error_description: message, ...extra } };
		return res;
	},
	json: (res, status, body) => {
		res._json = { status, body };
		return res;
	},
}));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { marketDataIp: vi.fn(async () => ({ success: true })) },
	clientIp: () => '1.2.3.4',
}));
vi.mock('../api/_lib/pump-bonding.js', () => ({
	getBondingStatus: vi.fn(),
}));

import handler from '../api/crypto/bonding.js';
import { getBondingStatus } from '../api/_lib/pump-bonding.js';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function fakeRes() {
	return { setHeader() {}, end() {}, statusCode: 200 };
}
function call(url) {
	const res = fakeRes();
	return handler({ method: 'GET', url, headers: {} }, res).then(() => res);
}

beforeEach(() => {
	getBondingStatus.mockReset();
});

describe('GET /api/crypto/bonding', () => {
	it('400s when mint is missing (no upstream call)', async () => {
		const res = await call('/api/crypto/bonding');
		expect(res._json.status).toBe(400);
		expect(res._json.body.error).toBe('missing_mint');
		expect(getBondingStatus).not.toHaveBeenCalled();
	});

	it('400s on a non-base58 mint before any upstream call', async () => {
		const res = await call('/api/crypto/bonding?mint=not-a-real-mint!!');
		expect(res._json.status).toBe(400);
		expect(res._json.body.error).toBe('invalid_mint');
		expect(getBondingStatus).not.toHaveBeenCalled();
	});

	it('400s a valid-looking but non-pump.fun mint with a discovery pointer', async () => {
		getBondingStatus.mockResolvedValue({ kind: 'not_found' });
		const res = await call(`/api/crypto/bonding?mint=${THREE_MINT}`);
		expect(res._json.status).toBe(400);
		expect(res._json.body.error).toBe('not_pumpfun_mint');
		expect(res._json.body.error_description).toContain('/api/crypto/launches');
	});

	it('503s (never 500) when the pump.fun feed is down, with retry hint', async () => {
		getBondingStatus.mockResolvedValue({ kind: 'upstream_down' });
		const res = await call(`/api/crypto/bonding?mint=${THREE_MINT}`);
		expect(res._json.status).toBe(503);
		expect(res._json.body.error).toBe('upstream_unavailable');
		expect(res._json.body.retry_after).toBe(15);
	});

	it('200s an on-curve coin with the documented shape', async () => {
		getBondingStatus.mockResolvedValue({
			kind: 'ok',
			status: {
				onCurve: true,
				graduated: false,
				migratedTo: null,
				bondingProgressPct: 62.5,
				solInCurve: 40,
				tokensRemaining: 297_412_500,
				marketCapUsd: 48000,
				source: 'pumpfun',
			},
		});
		const res = await call(`/api/crypto/bonding?mint=${THREE_MINT}`);
		expect(res._json.status).toBe(200);
		const b = res._json.body;
		expect(b).toMatchObject({
			mint: THREE_MINT,
			onCurve: true,
			graduated: false,
			migratedTo: null,
			bondingProgressPct: 62.5,
			solInCurve: 40,
			tokensRemaining: 297_412_500,
			marketCapUsd: 48000,
			source: 'pumpfun',
		});
		expect(typeof b.ts).toBe('string');
	});

	it('200s a graduated coin with graduated:true + migratedTo and nulled curve fields', async () => {
		getBondingStatus.mockResolvedValue({
			kind: 'ok',
			status: {
				onCurve: false,
				graduated: true,
				migratedTo: 'pumpswap',
				bondingProgressPct: 100,
				solInCurve: null,
				tokensRemaining: null,
				marketCapUsd: 71000,
				source: 'pumpfun',
			},
		});
		const res = await call(`/api/crypto/bonding?mint=${THREE_MINT}`);
		expect(res._json.status).toBe(200);
		expect(res._json.body).toMatchObject({
			graduated: true,
			onCurve: false,
			migratedTo: 'pumpswap',
			bondingProgressPct: 100,
			solInCurve: null,
			tokensRemaining: null,
		});
	});

	it('429s when the per-IP limiter denies', async () => {
		const { limits } = await import('../api/_lib/rate-limit.js');
		limits.marketDataIp.mockResolvedValueOnce({ success: false });
		const res = await call(`/api/crypto/bonding?mint=${THREE_MINT}`);
		expect(res._json.status).toBe(429);
		expect(getBondingStatus).not.toHaveBeenCalled();
	});
});
