// Unit tests for the Granite Oracle's keyless OHLCV source (GeckoTerminal), with
// a URL-routing fetch mock so no network is touched. The Granite TimeSeries
// forecast helper is covered by tests/api-watsonx-forecast.test.js and Granite
// Guardian by tests/watsonx-guardian.test.js.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
	fetchOhlcv,
	trendingPools,
	topPoolForToken,
	freqFor,
} from '../../api/_lib/market/ohlcv.js';

const realFetch = global.fetch;
afterAll(() => {
	global.fetch = realFetch;
});

function mres(obj, ok = true, status = 200) {
	return { ok, status, text: async () => JSON.stringify(obj) };
}

beforeEach(() => {
	global.fetch = vi.fn(async (url) => {
		if (url.includes('/trending_pools'))
			return mres({
				data: [
					{
						id: 'solana_POOLX',
						attributes: {
							name: 'A / SOL',
							address: 'POOLX',
							base_token_price_usd: '1.5',
							price_change_percentage: { h24: '3.2' },
						},
						relationships: { base_token: { data: { id: 'solana_MINTX' } } },
					},
				],
			});
		if (url.includes('/tokens/') && url.includes('/pools'))
			return mres({ data: [{ id: 'solana_TOPPOOL', attributes: { address: 'TOPPOOL' } }] });
		if (url.includes('/ohlcv/'))
			return mres({
				data: {
					attributes: {
						ohlcv_list: [
							[200, 2, 2, 2, 2, 5],
							[100, 1, 1, 1, 1, 9],
							[150, 0, 0, 0, 0, 0], // c=0 → filtered out
						],
					},
				},
				meta: {
					base: { name: 'Base', symbol: 'BSY', address: 'a' },
					quote: { name: 'Sol', symbol: 'SOL', address: 'q' },
				},
			});
		return mres({}, false, 404);
	});
});

describe('GeckoTerminal OHLCV lib', () => {
	it('maps freq strings', () => {
		expect(freqFor('hour', 1)).toBe('1h');
		expect(freqFor('minute', 15)).toBe('15min');
		expect(freqFor('day', 1)).toBe('1D');
	});

	it('parses, filters and sorts candles oldest→newest', async () => {
		const { candles, base, quote, freq } = await fetchOhlcv({ pool: 'P1' });
		expect(candles).toHaveLength(2); // the zero-price row is dropped
		expect(candles[0].t).toBe(100);
		expect(candles[1].t).toBe(200);
		expect(base.symbol).toBe('BSY');
		expect(quote.symbol).toBe('SOL');
		expect(freq).toBe('1h');
	});

	it('normalises trending pools', async () => {
		const pools = await trendingPools('solana', 8);
		expect(pools[0]).toMatchObject({
			pool: 'POOLX',
			name: 'A / SOL',
			baseMint: 'MINTX',
			priceUsd: 1.5,
			change24h: 3.2,
		});
	});

	it('resolves a token to its top pool', async () => {
		expect(await topPoolForToken('MINTX')).toBe('TOPPOOL');
	});

	it('retries a transient 429 with backoff, then succeeds', async () => {
		let calls = 0;
		global.fetch = vi.fn(async () => {
			calls += 1;
			if (calls === 1) return mres({ status: { error_code: 429 } }, false, 429);
			return mres({ data: [{ id: 'solana_TOPPOOL', attributes: { address: 'TOPPOOL' } }] });
		});
		// Use a fresh pool id so the in-module 20s cache can't serve a prior value.
		expect(await topPoolForToken('MINTX-429-once')).toBe('TOPPOOL');
		expect(calls).toBe(2); // first 429 retried, second call served
	});

	// topPoolForToken falls back to DexScreener and Birdeye once GeckoTerminal is
	// exhausted, and those rungs go through the same stubbed fetch. Count the
	// GeckoTerminal calls specifically so these still assert its retry ladder
	// rather than the total traffic of the whole chain.
	const countGecko = (urls) => urls.filter((u) => String(u).includes('geckoterminal')).length;

	it('throws a 429-tagged error once retries are exhausted', async () => {
		const urls = [];
		global.fetch = vi.fn(async (url) => {
			urls.push(url);
			return mres({ status: { error_code: 429 } }, false, 429);
		});
		await expect(topPoolForToken('MINTX-429-always')).rejects.toMatchObject({ status: 429 });
		expect(countGecko(urls)).toBe(3); // MAX_ATTEMPTS exhausted, status preserved as 429
	});

	it('does not retry a 404 (fail fast)', async () => {
		const urls = [];
		global.fetch = vi.fn(async (url) => {
			urls.push(url);
			return mres({}, false, 404);
		});
		await expect(topPoolForToken('MINTX-404')).rejects.toMatchObject({ status: 404 });
		expect(countGecko(urls)).toBe(1); // client error is not retried
	});
});
