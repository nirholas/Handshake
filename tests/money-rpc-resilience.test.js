// Single-point-of-failure removal on the money and RPC paths (2026-08-27 audit).
//
// Pins, per module, the one behaviour that used to be missing:
// - token/jupiter.js: a quote retries through a 429/5xx; a swap build retries
//   ONCE on a 5xx/network failure and never on a 4xx; deadlines exist.
// - token/price.js: DefiLlama answers when Jupiter and the market chain miss.
// - x402-spending-price.js: the spend-cap oracle walks the shared price chain
//   and serves last-known-good on a total outage; only a never-priced symbol
//   throws.
// - coin/randomness.js: a dead drand relay rolls to the next one; a 404 is a
//   real answer and stops the chain.
// - gcp-auth.js: a failed refresh keeps serving a token that is still valid.
//
// No live network: global.fetch is stubbed per case.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';

vi.mock('../api/_lib/cache.js', async (importOriginal) => {
	const real = await importOriginal();
	return real;
});
vi.mock('../api/_lib/db.js', () => ({ sql: vi.fn(async () => []) }));

import { jupiterQuote, jupiterSwapTx } from '../api/_lib/token/jupiter.js';
import { getTokenPriceUsd } from '../api/_lib/token/price.js';
import { TOKEN_MINT } from '../api/_lib/token/config.js';
import { toMicroUsd } from '../api/_lib/x402-spending-price.js';
import { fetchDrandRound, DRAND_RELAYS, QUICKNET_CHAIN_HASH } from '../api/_lib/coin/randomness.js';
import { getGcpAccessToken, _resetGcpTokenCache } from '../api/_lib/gcp-auth.js';
import { _resetBreakers } from '../api/_lib/resilience.js';
import { __resetMarketCache } from '../api/_lib/market/token-market.js';
import { cacheDel } from '../api/_lib/cache.js';

const json = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const realFetch = global.fetch;
beforeEach(() => {
	_resetBreakers();
	__resetMarketCache();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	global.fetch = realFetch;
	vi.restoreAllMocks();
});

describe('jupiter quote + swap build', () => {
	const QUOTE = { inputMint: 'a', outputMint: 'b', amount: 1000, slippageBps: 50 };

	it('retries a quote through a transient 503 and returns the route', async () => {
		let n = 0;
		global.fetch = vi.fn(async () => (++n === 1 ? json({ error: 'down' }, 503) : json({ outAmount: '42' })));
		const q = await jupiterQuote(QUOTE);
		expect(q.outAmount).toBe('42');
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it('gives every attempt a deadline signal', async () => {
		global.fetch = vi.fn(async (url, init) => {
			expect(init.signal).toBeInstanceOf(AbortSignal);
			return json({ outAmount: '1' });
		});
		await jupiterQuote(QUOTE);
	});

	it('surfaces a 400 on the quote at once with the jupiter_error shape', async () => {
		global.fetch = vi.fn(async () => json({ error: 'no route' }, 400));
		await expect(jupiterQuote(QUOTE)).rejects.toMatchObject({ code: 'jupiter_error', status: 400 });
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('retries the swap build exactly once on a network failure', async () => {
		let n = 0;
		global.fetch = vi.fn(async () => {
			if (++n === 1) throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
			return json({ swapTransaction: 'AQID' });
		});
		const tx = await jupiterSwapTx({ quote: { outAmount: '1' }, userPublicKey: 'pk' });
		expect(tx).toBe('AQID');
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it('retries the swap build once on a 5xx, then gives up with the jupiter_error shape', async () => {
		global.fetch = vi.fn(async () => json({ error: 'boom' }, 502));
		await expect(jupiterSwapTx({ quote: { outAmount: '1' }, userPublicKey: 'pk' }))
			.rejects.toMatchObject({ code: 'jupiter_error', status: 502 });
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it('never retries a swap build that was answered with a 4xx or a 429', async () => {
		global.fetch = vi.fn(async () => json({ error: 'slippage' }, 422));
		await expect(jupiterSwapTx({ quote: { outAmount: '1' }, userPublicKey: 'pk' }))
			.rejects.toMatchObject({ code: 'jupiter_error', status: 422 });
		expect(global.fetch).toHaveBeenCalledTimes(1);

		global.fetch = vi.fn(async () => json({ error: 'slow down' }, 429));
		await expect(jupiterSwapTx({ quote: { outAmount: '1' }, userPublicKey: 'pk' }))
			.rejects.toMatchObject({ code: 'jupiter_error', status: 429 });
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});
});

describe('token price: DefiLlama rung', () => {
	it('prices from DefiLlama when Jupiter and the rest of the market chain miss', async () => {
		const key = `solana:${TOKEN_MINT}`;
		global.fetch = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes('coins.llama.fi')) return json({ coins: { [key]: { price: 0.00031 } } });
			return json({ error: 'down' }, 503);
		});
		const p = await getTokenPriceUsd({ fresh: true });
		expect(p.priceUsd).toBe(0.00031);
		expect(p.source).toBe('llama');
		const llamaCalls = global.fetch.mock.calls.filter(([u]) => String(u).includes('coins.llama.fi'));
		expect(llamaCalls[0][0]).toBe(`https://coins.llama.fi/prices/current/${key}`);
	});
});

describe('x402 spending price oracle', () => {
	const solRequirement = { asset: 'So11111111111111111111111111111111111111112', extra: { name: 'SOL', decimals: 9 } };

	beforeEach(async () => {
		const { __resetLocalCache } = await import('../api/_lib/x402-spending-price.js');
		__resetLocalCache();
		await cacheDel('spot-usd:SOL');
		await cacheDel('spot-usd:SOL:lkg');
		await cacheDel('spot-usd:BNB');
		await cacheDel('spot-usd:BNB:lkg');
	});

	it('falls through the shared chain when CoinGecko is down and prices the spend', async () => {
		global.fetch = vi.fn(async (url) => {
			const u = String(url);
			if (u.includes('coins.llama.fi')) return json({ coins: { 'coingecko:solana': { price: 150 } } });
			return json({}, 503);
		});
		// 1 SOL at $150 = 150_000_000 micro-USD.
		const micro = await toMicroUsd('1000000000', solRequirement);
		expect(micro).toBe(150_000_000n);
		expect(global.fetch.mock.calls.some(([u]) => String(u).includes('coins.llama.fi'))).toBe(true);
	});

	it('serves the last-known-good price when every source is down', async () => {
		// Warm the last-good tier through a real load first (local micro-cache
		// cold), then fail everything and read again.
		global.fetch = vi.fn(async (url) => (String(url).includes('coins.llama.fi')
			? json({ coins: { 'coingecko:solana': { price: 150 } } })
			: json({}, 500)));
		const first = await toMicroUsd('1000000000', solRequirement);
		expect(first).toBe(150_000_000n);
		// Evict the live keys so the next read must reload, then take every source down.
		await cacheDel('spot-usd:SOL');
		const { __resetLocalCache } = await import('../api/_lib/x402-spending-price.js');
		__resetLocalCache();
		global.fetch = vi.fn(async () => { throw new TypeError('network down'); });
		const again = await toMicroUsd('1000000000', solRequirement);
		expect(again).toBe(150_000_000n);
	});

	it('throws only when a symbol has never been priced', async () => {
		global.fetch = vi.fn(async () => { throw new TypeError('network down'); });
		await expect(toMicroUsd('1000', { asset: '0xdeadbeef', extra: { name: 'BNB', decimals: 18 } }))
			.rejects.toThrow(/spending-price: every price source for BNB-USD failed/);
	});
});

describe('drand relay chain', () => {
	it('rolls past a dead relay to the next one', async () => {
		const path = `/${QUICKNET_CHAIN_HASH}/public/7`;
		const signature = 'abcdef';
		const randomness = Buffer.from(sha256(Buffer.from(signature, 'hex'))).toString('hex');
		global.fetch = vi.fn(async (url) => {
			const u = String(url);
			expect(u.endsWith(path)).toBe(true);
			if (u.startsWith(DRAND_RELAYS[0])) throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });
			return json({ round: 7, randomness, signature });
		});
		const out = await fetchDrandRound(7);
		expect(out.round).toBe(7);
		const hosts = global.fetch.mock.calls.map(([u]) => new URL(String(u)).origin);
		expect(hosts).toContain(new URL(DRAND_RELAYS[0]).origin);
		expect(hosts).toContain(new URL(DRAND_RELAYS[1]).origin);
	});

	it('treats a 404 as "round not published yet" and does not ask another relay', async () => {
		global.fetch = vi.fn(async () => json({}, 404));
		await expect(fetchDrandRound(999_999_999)).rejects.toThrow(/drand_round_unavailable/);
		const hosts = new Set(global.fetch.mock.calls.map(([u]) => new URL(String(u)).origin));
		expect(hosts.size).toBe(1);
	});
});

describe('gcp-auth token cache', () => {
	const priorSa = process.env.GCP_SERVICE_ACCOUNT_JSON;
	beforeEach(() => {
		_resetGcpTokenCache();
		delete process.env.GCP_SERVICE_ACCOUNT_JSON;
	});
	afterEach(() => {
		if (priorSa !== undefined) process.env.GCP_SERVICE_ACCOUNT_JSON = priorSa;
		else delete process.env.GCP_SERVICE_ACCOUNT_JSON;
		vi.useRealTimers();
	});

	it('retries the metadata server through a transient failure', async () => {
		let n = 0;
		global.fetch = vi.fn(async () => (++n === 1 ? json({}, 503) : json({ access_token: 't1', expires_in: 3600 })));
		expect(await getGcpAccessToken()).toBe('t1');
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it('keeps serving a still-valid token when the refresh fails', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-27T00:00:00Z'));
		global.fetch = vi.fn(async () => json({ access_token: 't1', expires_in: 3600 }));
		expect(await getGcpAccessToken()).toBe('t1');
		// Inside the refresh-ahead window (>5 min before expiry): no fetch at all.
		global.fetch = vi.fn(async () => { throw new TypeError('metadata down'); });
		vi.setSystemTime(new Date('2026-08-27T00:50:00Z'));
		expect(await getGcpAccessToken()).toBe('t1');
		expect(global.fetch).not.toHaveBeenCalled();
		// Past the refresh point but with >60s of validity left: refresh fails, the
		// cached token is still served.
		vi.setSystemTime(new Date('2026-08-27T00:57:00Z'));
		const p = getGcpAccessToken();
		await vi.runAllTimersAsync();
		expect(await p).toBe('t1');
		expect(global.fetch).toHaveBeenCalled();
		// Inside the last 60s: the stale token is no longer safe to hand out.
		vi.setSystemTime(new Date('2026-08-27T00:59:30Z'));
		const q = getGcpAccessToken();
		const settled = q.then(() => 'ok', (e) => e.code);
		await vi.runAllTimersAsync();
		expect(await settled).toBe('metadata_unavailable');
	});
});
