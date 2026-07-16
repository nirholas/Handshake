// api/pump/price-history.js — GeckoTerminal resilience under a poll-storm.
//
// Regression: /terminal, /trades, and /pump-dashboard each mount several chart
// widgets that poll different mints at once, so a single page load is itself
// a burst of near-simultaneous requests. Confirmed live in production
// 2026-07-16 (fresh page-audit run): several distinct mints 502'd with
// "Price history is unavailable" even though GeckoTerminal itself recovers
// within seconds — the old code only retried once, only on 429, with no cap
// on how many of OUR OWN requests could be in flight at once and no sharing
// between concurrent callers asking for the identical window. This file pins
// the fix: a concurrency gate, retry on 429/5xx/network error, and in-flight
// de-duplication.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/_lib/birdeye.js', () => ({
	birdeyeConfigured: () => false,
	fetchBirdeyeOhlcv: vi.fn(),
}));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));

import handler, { snapWindow, POLL_BUCKET_SECONDS } from '../../api/pump/price-history.js';

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo7';

function makeReq(qs) {
	return { url: `/api/pump/price-history?${qs}`, method: 'GET', headers: {} };
}
function makeRes() {
	const res = {
		statusCode: 200,
		_headers: {},
		_body: null,
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
	return res;
}
function getJson(res) { return JSON.parse(res._body); }

function poolResponse() {
	return { ok: true, status: 200, json: async () => ({ data: [{ attributes: { address: POOL } }] }) };
}
function ohlcvResponse() {
	return {
		ok: true,
		status: 200,
		json: async () => ({ data: { attributes: { ohlcv_list: [[Math.floor(Date.now() / 1000) - 60, 1, 1.1, 0.9, 1.05, 100]] } } }),
	};
}

// Base58 alphabet (no 0/O/I/l) so a generated test mint always passes
// isPlausibleMint's base58 regex.
const BASE58_SAFE = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz123456789';
function safeSuffix(n) {
	let s = '', x = n + 1;
	for (let i = 0; i < 6; i++) { s += BASE58_SAFE[x % BASE58_SAFE.length]; x = Math.floor(x / BASE58_SAFE.length); }
	return s;
}

// A fresh mint AND a fresh, un-bucket-collided window per test so neither the
// pool-address cache nor the candle/in-flight cache (both module-level, keyed
// by mint) can leak state between tests.
let seq = 0;
function freshQuery(mint) {
	seq += 1;
	const m = mint || `${MINT.slice(0, 34)}${safeSuffix(seq)}pump`;
	const now = Math.floor(Date.now() / 1000) + seq * 10_000; // force a new snapWindow bucket
	const { from, to } = snapWindow({ interval: '5m', from: now - 3600, to: now });
	return `mint=${m}&interval=5m&from=${from}&to=${to}`;
}

beforeEach(() => {
	vi.restoreAllMocks();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe('geckoFetch retry (via the handler)', () => {
	it('recovers from a single 429 (existing behavior, still works)', async () => {
		let call = 0;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			call += 1;
			if (call === 1) return poolResponse();
			if (call === 2) return { ok: false, status: 429, json: async () => ({}) };
			return ohlcvResponse();
		});
		const res = makeRes();
		await handler(makeReq(freshQuery()), res);
		expect(res.statusCode).toBe(200);
		expect(getJson(res).source).toBe('gecko');
	});

	it('recovers from a transient 502 from GeckoTerminal — the case that used to 502 the caller', async () => {
		let call = 0;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			call += 1;
			if (call === 1) return poolResponse();
			if (call === 2) return { ok: false, status: 502, json: async () => ({}) };
			return ohlcvResponse();
		});
		const res = makeRes();
		await handler(makeReq(freshQuery()), res);
		expect(res.statusCode).toBe(200);
		expect(getJson(res).source).toBe('gecko');
	});

	it('recovers from a dropped connection (fetch throws) — previously not retried at all', async () => {
		let call = 0;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			call += 1;
			if (call === 1) return poolResponse();
			if (call === 2) throw new Error('network error');
			return ohlcvResponse();
		});
		const res = makeRes();
		await handler(makeReq(freshQuery()), res);
		expect(res.statusCode).toBe(200);
	});

	it('still 502s honestly when every attempt fails and there is no stale fallback', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
		const res = makeRes();
		await handler(makeReq(freshQuery()), res);
		expect(res.statusCode).toBe(502);
		expect(getJson(res).error).toBe('upstream_error');
	});

	it('serves the honest no_market 404 for a mint GeckoTerminal has never indexed, without retrying', async () => {
		let poolCalls = 0;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (String(url).includes('/pools?')) { poolCalls += 1; return { ok: false, status: 404, json: async () => ({}) }; }
			throw new Error('should never reach the ohlcv endpoint');
		});
		const res = makeRes();
		await handler(makeReq(freshQuery()), res);
		expect(res.statusCode).toBe(404);
		expect(getJson(res).error).toBe('no_market');
		expect(poolCalls).toBe(1); // a 404 is a real answer, not a transient failure — never retried
	});
});

describe('concurrency gate', () => {
	it('never runs more than 4 GeckoTerminal fetches at once, even under a burst across many mints', async () => {
		let active = 0;
		let maxActive = 0;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 5));
			active -= 1;
			if (String(url).includes('/pools?')) return poolResponse();
			return ohlcvResponse();
		});

		// 10 distinct mints (distinct pool-cache keys) fired at once — a realistic
		// stand-in for a page mounting several chart widgets simultaneously.
		const mints = Array.from({ length: 10 }, (_, i) => `${MINT.slice(0, 34)}${safeSuffix(10_000 + i)}pump`);
		await Promise.all(mints.map((m) => {
			const res = makeRes();
			return handler(makeReq(freshQuery(m)), res).then(() => res);
		}));

		expect(maxActive).toBeLessThanOrEqual(4);
	});
});

describe('in-flight de-duplication', () => {
	it('collapses concurrent identical requests into one upstream resolution', async () => {
		let poolCalls = 0;
		let ohlcvCalls = 0;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			await new Promise((r) => setTimeout(r, 10));
			if (String(url).includes('/pools?')) { poolCalls += 1; return poolResponse(); }
			ohlcvCalls += 1;
			return ohlcvResponse();
		});

		const qs = freshQuery();
		const results = await Promise.all(
			Array.from({ length: 5 }, () => {
				const res = makeRes();
				return handler(makeReq(qs), res).then(() => res);
			}),
		);

		for (const res of results) expect(res.statusCode).toBe(200);
		// 5 concurrent identical requests share ONE resolution — one pool lookup,
		// one ohlcv fetch — not five independent chains.
		expect(poolCalls).toBe(1);
		expect(ohlcvCalls).toBe(1);
	});
});
