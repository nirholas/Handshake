// api/_lib/pump-feed-fetch.js — the shared pump.fun read layer behind
// /api/crypto/trending and /api/crypto/whales.
//
// What is pinned here is exactly what used to break in production: pump.fun sits
// behind Cloudflare, a burst of per-coin trade pulls earns HTTP 429 ("error code:
// 1015"), and both endpoints then reported "upstream unavailable" while the feed
// was healthy. So: the cache collapses repeat pulls, a 429 is retried once, a
// rate-limited pull falls back to the last-known-good rows and flags them stale,
// and a genuinely empty answer is NOT reported as an outage.
//
// fetch is stubbed; no network is touched. The mint fixture is $THREE.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cache = new Map();
vi.mock('../../api/_lib/cache.js', () => ({
	cacheGet: async (k) => (cache.has(k) ? cache.get(k) : null),
	cacheSet: async (k, v) => { cache.set(k, v); },
}));

const { pumpFetchJson, fetchPumpTrades, fetchPumpBoard } = await import('../../api/_lib/pump-feed-fetch.js');

const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function jsonRes(body, status = 200, headers = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (h) => headers[h.toLowerCase()] ?? null },
		json: async () => body,
	};
}

const tradeRow = { type: 'buy', amountSol: '9.5', userAddress: 'HKKp49zUBeaABFMpBWKCJPoNDLiR4AEEr8FJKuZPn6Nk', tx: 'sig1', timestamp: '2026-08-12T20:00:00.000Z' };
const coinRow = { mint: THREE, symbol: 'THREE', name: 'three.ws', usd_market_cap: 1234 };

beforeEach(() => {
	cache.clear();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

// The module sleeps between retries; run timers as they are scheduled so the
// retry path completes without a real wall-clock wait.
async function withTimers(promise) {
	const settled = promise;
	await vi.runAllTimersAsync();
	return settled;
}

describe('pumpFetchJson — retry on a rate limit', () => {
	it('retries once on 429 and returns the recovered body', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonRes(null, 429, { 'retry-after': '0.2' }))
			.mockResolvedValueOnce(jsonRes({ ok: 1 }));
		vi.stubGlobal('fetch', fetchMock);
		const out = await withTimers(pumpFetchJson('https://swap-api.pump.fun/x'));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(out).toEqual({ ok: true, status: 200, body: { ok: 1 } });
	});

	it('gives up after the bounded retry and reports the failing status', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonRes(null, 429, {}));
		vi.stubGlobal('fetch', fetchMock);
		const out = await withTimers(pumpFetchJson('https://swap-api.pump.fun/x'));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(out.ok).toBe(false);
		expect(out.status).toBe(429);
	});

	it('does not retry a client error that will not recover', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonRes(null, 404, {}));
		vi.stubGlobal('fetch', fetchMock);
		const out = await withTimers(pumpFetchJson('https://swap-api.pump.fun/x'));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(out.ok).toBe(false);
	});

	it('never throws on a network failure', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('econnreset')));
		const out = await withTimers(pumpFetchJson('https://swap-api.pump.fun/x'));
		expect(out).toEqual({ ok: false, status: 0, body: null });
	});
});

describe('fetchPumpTrades — cache, envelopes, failure contract', () => {
	it('accepts both the array and the {trades} envelope', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes({ trades: [tradeRow] })));
		const wrapped = await withTimers(fetchPumpTrades(THREE, { limit: 100 }));
		expect(wrapped).toEqual({ rows: [tradeRow], stale: false });

		cache.clear();
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes([tradeRow])));
		const bare = await withTimers(fetchPumpTrades(THREE, { limit: 100 }));
		expect(bare.rows).toEqual([tradeRow]);
	});

	it('serves a second pull for the same mint from cache without a second fetch', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonRes({ trades: [tradeRow] }));
		vi.stubGlobal('fetch', fetchMock);
		await withTimers(fetchPumpTrades(THREE, { limit: 100 }));
		await withTimers(fetchPumpTrades(THREE, { limit: 100 }));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('an upstream that answers with no rows is data, not an outage', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes({ trades: [] })));
		const out = await withTimers(fetchPumpTrades(THREE, { limit: 100 }));
		expect(out).toEqual({ rows: [], stale: false });
	});

	it('falls back to last-known-good rows when the feed goes down, flagged stale', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes({ trades: [tradeRow] })));
		await withTimers(fetchPumpTrades(THREE, { limit: 100 }));
		// Live TTL lapses, last-known-good survives.
		cache.delete(`pump:feed:trades:${THREE}:100`);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(null, 429, {})));
		const out = await withTimers(fetchPumpTrades(THREE, { limit: 100 }));
		expect(out).toEqual({ rows: [tradeRow], stale: true });
	});

	it('returns null when the feed is down and nothing was ever cached', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes(null, 503, {})));
		const out = await withTimers(fetchPumpTrades(THREE, { limit: 100 }));
		expect(out).toBeNull();
	});
});

describe('fetchPumpBoard — coin filtering + cache', () => {
	it('keeps only rows carrying a plausible mint', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes([coinRow, { mint: 'short' }, null, { symbol: 'X' }])));
		const out = await withTimers(fetchPumpBoard({ limit: 20 }));
		expect(out.rows).toEqual([coinRow]);
		expect(out.stale).toBe(false);
	});

	it('reuses the cached board for the same limit', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonRes({ coins: [coinRow] }));
		vi.stubGlobal('fetch', fetchMock);
		await withTimers(fetchPumpBoard({ limit: 20 }));
		await withTimers(fetchPumpBoard({ limit: 20 }));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('null when the board is unreachable with no last-known-good copy', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
		expect(await withTimers(fetchPumpBoard({ limit: 20 }))).toBeNull();
	});
});
