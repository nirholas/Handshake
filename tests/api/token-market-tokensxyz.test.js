// The Tokens API rung inside api/_lib/market/token-market.js.
//
// Two properties matter and neither is obvious from reading the cascade:
//   1. Without TOKENS_XYZ_API_KEY the rung must be completely inert, so an
//      unconfigured deployment keeps the exact source order it had before.
//   2. With the key it must sit behind Birdeye and ahead of DexScreener, and a
//      throttled key must reach the circuit breaker rather than being swallowed
//      inside the client.
//
// Fetch is fully stubbed; no network. The mint is a synthetic placeholder.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let fetchCalls = [];
let fetchResponses = [];
vi.stubGlobal('fetch', (url) => {
	fetchCalls.push(String(url));
	const resp = fetchResponses.shift();
	if (!resp) throw new Error(`Unexpected fetch: ${url}`);
	return Promise.resolve({
		ok: resp.ok ?? true,
		status: resp.status ?? 200,
		json: async () => resp.body,
		text: async () => (typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)),
	});
});

import { fetchTokenMarketData, __resetMarketCache } from '../../api/_lib/market/token-market.js';

const MINT = 'THREEsynthetic111111111111111111111111111111';

const BIRDEYE_DOWN = { ok: false, status: 500, body: 'upstream down' };
const TOKENS_XYZ_OK = {
	body: {
		variants: [
			{
				mint: MINT,
				assetId: 'three',
				chain: 'solana',
				market: {
					price: 0.25,
					liquidity: 90_000,
					volume24hUSD: 12_000,
					marketCap: 250_000,
					priceChange24hPercent: 3.2,
					decimals: 6,
					holder: 4_211,
					circulatingSupply: 900_000,
					metricsSource: 'birdeye',
				},
				executionQuality: null,
			},
		],
	},
};
const DEX_OK = {
	body: {
		pairs: [
			{ priceUsd: '0.5', marketCap: 500_000, liquidity: { usd: 100_000 }, volume: { h24: 5_000 }, priceChange: { h24: 1.5 } },
		],
	},
};

beforeEach(() => {
	fetchCalls = [];
	fetchResponses = [];
	__resetMarketCache();
});

afterEach(() => {
	delete process.env.BIRDEYE_API_KEY;
	delete process.env.TOKENS_XYZ_API_KEY;
	if (fetchResponses.length) throw new Error(`Test left ${fetchResponses.length} unconsumed fetch mock(s)`);
});

describe('tokens.xyz rung', () => {
	it('is skipped entirely when the key is absent', async () => {
		fetchResponses = [DEX_OK];
		const out = await fetchTokenMarketData(MINT, { fresh: true });

		expect(out.source).toBe('dexscreener');
		expect(fetchCalls.some((u) => u.includes('tokens.xyz'))).toBe(false);
	});

	it('answers ahead of DexScreener once the key is configured', async () => {
		process.env.TOKENS_XYZ_API_KEY = 'test-key';
		fetchResponses = [TOKENS_XYZ_OK];
		const out = await fetchTokenMarketData(MINT, { fresh: true });

		expect(out).toMatchObject({
			source: 'tokensxyz',
			price_usd: 0.25,
			price_change_24h: 3.2,
			market_cap: 250_000,
			volume_24h: 12_000,
			liquidity: 90_000,
			decimals: 6,
			// The whole point of the rung: a Birdeye-grade row, holders included,
			// on the reads where our own Birdeye quota is spent.
			holders: 4_211,
			supply: 900_000,
		});
		expect(fetchCalls.some((u) => u.includes('dexscreener'))).toBe(false);
	});

	it('derives supply from cap over price when the row omits circulating supply', async () => {
		process.env.TOKENS_XYZ_API_KEY = 'test-key';
		fetchResponses = [
			{ body: { variants: [{ mint: MINT, assetId: 'three', chain: 'solana', market: { price: 0.25, marketCap: 250_000 }, executionQuality: null }] } },
		];
		const out = await fetchTokenMarketData(MINT, { fresh: true });

		expect(out.supply).toBe(1_000_000);
		expect(out.holders).toBeNull();
	});

	it('sits behind Birdeye and takes over when Birdeye is down', async () => {
		process.env.BIRDEYE_API_KEY = 'birdeye-key';
		process.env.TOKENS_XYZ_API_KEY = 'test-key';
		fetchResponses = [BIRDEYE_DOWN, TOKENS_XYZ_OK];
		const out = await fetchTokenMarketData(MINT, { fresh: true });

		expect(out.source).toBe('tokensxyz');
		expect(fetchCalls[0]).toContain('birdeye');
		expect(fetchCalls[1]).toContain('tokens.xyz');
	});

	it('falls through to DexScreener when the mint has no cached snapshot upstream', async () => {
		process.env.TOKENS_XYZ_API_KEY = 'test-key';
		fetchResponses = [
			{ body: { variants: [{ mint: MINT, assetId: null, chain: 'solana', market: null, executionQuality: null }] } },
			DEX_OK,
		];
		const out = await fetchTokenMarketData(MINT, { fresh: true });

		expect(out.source).toBe('dexscreener');
	});

	it('benches the source for the cooldown window after a 429', async () => {
		process.env.TOKENS_XYZ_API_KEY = 'test-key';
		fetchResponses = [
			{ ok: false, status: 429, body: { error: { _tag: 'RateLimitedError', message: 'slow down' } } },
			DEX_OK,
		];
		const first = await fetchTokenMarketData(MINT, { fresh: true });
		expect(first.source).toBe('dexscreener');

		// Second read must not touch tokens.xyz again: the breaker holds it down.
		fetchCalls = [];
		fetchResponses = [DEX_OK];
		const second = await fetchTokenMarketData(MINT, { fresh: true });
		expect(second.source).toBe('dexscreener');
		expect(fetchCalls.some((u) => u.includes('tokens.xyz'))).toBe(false);
	});
});
