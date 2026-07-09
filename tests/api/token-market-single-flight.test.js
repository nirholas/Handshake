// Single-flight (fleet-wide lock) tests for api/_lib/market/token-market.js.
//
// TASK-10: on a cold/expired cache under load, every concurrent lambda used to
// run the full Birdeye → DexScreener → GeckoTerminal cascade at once, which
// rate-limited all three free quotas simultaneously. The fix takes a fleet-wide
// lock (cache.js acquireLock) so ONE caller does the live fetch and the rest
// serve the winner's shared-cache write instead of duplicating upstream calls.
//
// We drive the lock through Redis so the "loser" branch is exercised: the cache
// REST endpoint is mocked, and a real Birdeye/Dex/Gecko call would throw
// "Unexpected upstream fetch", proving the loser never hit an upstream.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A tiny in-memory Redis emulating the Upstash REST command surface cache.js
// uses: GET / SET (with NX / EX) / DEL. Returned via the mocked fetch below.
const store = new Map();
function redisExec(args) {
	const [cmd, key] = args;
	if (cmd === 'GET') {
		const hit = store.get(key);
		if (!hit || (hit.exp && Date.now() > hit.exp)) return null;
		return hit.val;
	}
	if (cmd === 'SET') {
		const nx = args.includes('NX');
		const exIdx = args.indexOf('EX');
		const ttlMs = exIdx > -1 ? Number(args[exIdx + 1]) * 1000 : 0;
		if (nx && store.has(key) && (!store.get(key).exp || Date.now() < store.get(key).exp)) return null;
		store.set(key, { val: args[2], exp: ttlMs ? Date.now() + ttlMs : 0 });
		return 'OK';
	}
	if (cmd === 'DEL') {
		store.delete(key);
		return 1;
	}
	return null;
}

let upstreamCalls = [];
let upstreamResponses = [];

vi.stubGlobal('fetch', (url, opts) => {
	const u = String(url);
	// Upstash REST: cache.js POSTs the command array as the JSON body.
	if (u.includes('upstash.io')) {
		const args = JSON.parse(opts.body);
		return Promise.resolve({ ok: true, status: 200, json: async () => ({ result: redisExec(args) }) });
	}
	// Anything else is a real market upstream — should be tightly controlled.
	upstreamCalls.push(u);
	const resp = upstreamResponses.shift();
	if (!resp) throw new Error(`Unexpected upstream fetch: ${u}`);
	return Promise.resolve({
		ok: resp.ok ?? true,
		status: resp.status ?? 200,
		json: async () => resp.body,
		text: async () => (typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)),
	});
});

import { fetchTokenMarketData, __resetMarketCache } from '../../api/_lib/market/token-market.js';

// Unique mint per test case: cache.js's 2s read-memo persists across cases
// (it isn't reset by __resetMarketCache), so reusing one mint would let a prior
// case's memoized value satisfy a later case's L2 read and mask the path we mean
// to exercise. A fresh mint per case sidesteps that entirely.
let _mintSeq = 0;
const nextMint = () => `THREEsynthetic${String(++_mintSeq).padEnd(30, '3')}`;
const DEX_OK = {
	pairs: [
		{ priceUsd: '0.5', marketCap: 500000, liquidity: { usd: 100000 }, volume: { h24: 5000 }, priceChange: { h24: 1.5 } },
	],
};

beforeEach(() => {
	upstreamCalls = [];
	upstreamResponses = [];
	store.clear();
	delete process.env.BIRDEYE_API_KEY; // DexScreener is the first source
	// Point cache.js at the mocked Upstash so acquireLock uses a real SET NX.
	process.env.UPSTASH_CACHE_REST_URL = 'https://unit-test.upstash.io';
	process.env.UPSTASH_CACHE_REST_TOKEN = 'unit-test-token';
	__resetMarketCache();
});

afterEach(() => {
	delete process.env.UPSTASH_CACHE_REST_URL;
	delete process.env.UPSTASH_CACHE_REST_TOKEN;
	if (upstreamResponses.length) {
		throw new Error(`Test left ${upstreamResponses.length} unconsumed upstream mock(s)`);
	}
});

describe('token-market fleet-wide single-flight', () => {
	it('a lock-loser waits for the winner\'s shared write instead of firing its own cascade', async () => {
		// Winner holds the lock; L2 is still empty when the loser arrives. The
		// winner publishes shortly after (within the loser's wait budget). The
		// loser must poll L2, serve that value, and never touch an upstream — even
		// though its own first L2 read memoized a miss.
		const MINT = nextMint();
		store.set('mktlock:v1:' + MINT, { val: '1', exp: Date.now() + 20_000 });
		const published = { price_usd: 0.5, source: 'dexscreener', decimals: 6 };
		setTimeout(() => {
			store.set('mktdata:v1:' + MINT, { val: JSON.stringify(published), exp: Date.now() + 60_000 });
		}, 300);

		const md = await fetchTokenMarketData(MINT);
		expect(md).not.toBeNull();
		expect(md.price_usd).toBe(0.5);
		expect(md.source).toBe('dexscreener');
		expect(upstreamCalls).toHaveLength(0); // never touched an upstream
	});

	it('the lock winner fetches live and publishes to the shared cache', async () => {
		const MINT = nextMint();
		upstreamResponses = [{ body: DEX_OK }];
		const md = await fetchTokenMarketData(MINT);
		expect(md.source).toBe('dexscreener');
		expect(upstreamCalls).toHaveLength(1);
		expect(upstreamCalls[0]).toContain('dexscreener');
		// The publish and the lock DEL are deliberately fire-and-forget (the hot
		// path must not pay a Redis RTT before returning), so poll for them
		// instead of asserting synchronously — cacheSet's async encodeForWire step
		// means the write lands a few ticks after fetchTokenMarketData resolves.
		await vi.waitFor(() => {
			// Published for siblings to serve.
			expect(store.has('mktdata:v1:' + MINT)).toBe(true);
			// Lock released after the fetch (best-effort DEL).
			expect(store.has('mktlock:v1:' + MINT)).toBe(false);
		});
	});

	it('fresh:true bypasses the lock entirely (cron / explicit refresh path)', async () => {
		// A held lock must NOT block a fresh:true caller — it fetches live regardless.
		const MINT = nextMint();
		store.set('mktlock:v1:' + MINT, { val: '1', exp: Date.now() + 20_000 });
		upstreamResponses = [{ body: DEX_OK }];
		const md = await fetchTokenMarketData(MINT, { fresh: true });
		expect(md.source).toBe('dexscreener');
		expect(upstreamCalls).toHaveLength(1);
	});
});
