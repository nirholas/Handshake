/**
 * Category-scoped market table: last-known-good rung.
 *
 * CoinGecko is the only free source with a category taxonomy, so before this
 * rung existed a rate-limited key made every /category/:id page 502 while the
 * unscoped table stayed up on its CoinLore fallback (observed in production
 * 2026-07-28: /api/coin/markets?category=<any> returned 502 for every category
 * while the same endpoint without a category returned 200). The fallback
 * replays REAL rows this endpoint fetched earlier, flagged stale, and never
 * synthesizes data: a cold cache still surfaces the upstream failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { cacheStore, fetchFirstMock } = vi.hoisted(() => ({
	cacheStore: new Map(),
	fetchFirstMock: vi.fn(),
}));

vi.mock('../src/shared/failover-fetch.js', () => ({
	fetchFirst: (...args) => fetchFirstMock(...args),
}));
vi.mock('../api/_lib/cache.js', () => ({
	cacheGet: async (key) => (cacheStore.has(key) ? cacheStore.get(key) : null),
	cacheSet: async (key, value) => {
		cacheStore.set(key, value);
	},
}));

const { fetchMarketsTable } = await import('../api/_lib/market-fallbacks.js');

const ROWS = [
	{ id: 'aave', symbol: 'AAVE', name: 'Aave', price: 92.9 },
	{ id: 'gho', symbol: 'GHO', name: 'GHO', price: 1.0 },
];

beforeEach(() => {
	cacheStore.clear();
	fetchFirstMock.mockReset();
});

describe('fetchMarketsTable: live path', () => {
	it('returns live rows and records them as last-known-good for the category', async () => {
		fetchFirstMock.mockResolvedValue({ value: ROWS, source: 'coingecko' });
		const out = await fetchMarketsTable({ page: 1, perPage: 100, category: 'aave-tokens' });

		expect(out).toMatchObject({ rows: ROWS, source: 'coingecko' });
		expect(out.stale).toBeUndefined();
		expect([...cacheStore.keys()]).toEqual(['coin:markets:lkg:aave-tokens:p1:pp100']);
	});

	it('caches per category, page and page size so pages never bleed into each other', async () => {
		fetchFirstMock.mockResolvedValue({ value: ROWS, source: 'coingecko' });
		await fetchMarketsTable({ page: 1, perPage: 100, category: 'aave-tokens' });
		await fetchMarketsTable({ page: 2, perPage: 100, category: 'aave-tokens' });
		await fetchMarketsTable({ page: 1, perPage: 50, category: 'layer-1' });

		expect([...cacheStore.keys()].sort()).toEqual([
			'coin:markets:lkg:aave-tokens:p1:pp100',
			'coin:markets:lkg:aave-tokens:p2:pp100',
			'coin:markets:lkg:layer-1:p1:pp50',
		]);
	});

	it('never records a last-known-good entry for the uncategorized table', async () => {
		// The unscoped table has a live CoinLore rung, so it must keep failing
		// loudly rather than quietly serving yesterday's top-100.
		fetchFirstMock.mockResolvedValue({ value: ROWS, source: 'coinlore' });
		await fetchMarketsTable({ page: 1, perPage: 100, category: '' });
		expect(cacheStore.size).toBe(0);
	});

	it('does not record an empty result as last-known-good', async () => {
		fetchFirstMock.mockResolvedValue({ value: [], source: 'coingecko' });
		await fetchMarketsTable({ page: 1, perPage: 100, category: 'aave-tokens' });
		expect(cacheStore.size).toBe(0);
	});
});

describe('fetchMarketsTable: upstream failure', () => {
	it('replays the cached category rows flagged stale instead of throwing', async () => {
		fetchFirstMock.mockResolvedValueOnce({ value: ROWS, source: 'coingecko' });
		await fetchMarketsTable({ page: 1, perPage: 100, category: 'aave-tokens' });

		fetchFirstMock.mockRejectedValue(new Error('markets-table: all providers failed'));
		const out = await fetchMarketsTable({ page: 1, perPage: 100, category: 'aave-tokens' });

		expect(out.rows).toEqual(ROWS);
		expect(out.stale).toBe(true);
		expect(out.source).toBe('last-known-good');
		expect(typeof out.asOf).toBe('number');
	});

	it('still throws for a category with no cached rows (cold cache stays honest)', async () => {
		fetchFirstMock.mockRejectedValue(new Error('markets-table: all providers failed'));
		await expect(
			fetchMarketsTable({ page: 1, perPage: 100, category: 'brand-new' }),
		).rejects.toThrow(/all providers failed/);
	});

	it('still throws for the uncategorized table however warm the cache is', async () => {
		cacheStore.set('coin:markets:lkg::p1:pp100', { rows: ROWS, at: Date.now() });
		fetchFirstMock.mockRejectedValue(new Error('markets-table: all providers failed'));
		await expect(fetchMarketsTable({ page: 1, perPage: 100, category: '' })).rejects.toThrow(
			/all providers failed/,
		);
	});

	it("does not serve one category's rows for another", async () => {
		fetchFirstMock.mockResolvedValueOnce({ value: ROWS, source: 'coingecko' });
		await fetchMarketsTable({ page: 1, perPage: 100, category: 'aave-tokens' });

		fetchFirstMock.mockRejectedValue(new Error('markets-table: all providers failed'));
		await expect(
			fetchMarketsTable({ page: 1, perPage: 100, category: 'layer-1' }),
		).rejects.toThrow(/all providers failed/);
	});

	it('surfaces the upstream error when the cached entry is empty or malformed', async () => {
		cacheStore.set('coin:markets:lkg:aave-tokens:p1:pp100', { rows: [], at: Date.now() });
		fetchFirstMock.mockRejectedValue(new Error('markets-table: all providers failed'));
		await expect(
			fetchMarketsTable({ page: 1, perPage: 100, category: 'aave-tokens' }),
		).rejects.toThrow(/all providers failed/);

		cacheStore.set('coin:markets:lkg:aave-tokens:p1:pp100', {
			rows: 'not-an-array',
			at: Date.now(),
		});
		await expect(
			fetchMarketsTable({ page: 1, perPage: 100, category: 'aave-tokens' }),
		).rejects.toThrow(/all providers failed/);
	});
});

/**
 * Sparkline opt-out. /screener renders 250 rows and no 7d chart column, so it
 * asks the endpoint to leave the price series out: measured against live
 * CoinGecko that is a 219,911-byte response versus 69,754 for the same rows.
 * The flag only shapes the CoinGecko rung (the fallbacks never carry a series),
 * and the two shapes must not share a last-known-good cache entry, or a
 * sparkline-less replay would blank the /coins chart column.
 */
describe('fetchMarketsTable: sparkline opt-out', () => {
	const geckoUrl = () => fetchFirstMock.mock.calls.at(-1)[0][0].url;

	it('requests the 7d series by default', async () => {
		fetchFirstMock.mockResolvedValue({ value: ROWS, source: 'coingecko' });
		await fetchMarketsTable({ page: 1, perPage: 250, category: '' });
		expect(geckoUrl()).toContain('sparkline=true');
	});

	it('drops the 7d series when the caller renders no chart column', async () => {
		fetchFirstMock.mockResolvedValue({ value: ROWS, source: 'coingecko' });
		await fetchMarketsTable({ page: 1, perPage: 250, category: '', sparkline: false });
		expect(geckoUrl()).toContain('sparkline=false');
		expect(geckoUrl()).toContain('price_change_percentage=24h,7d');
	});

	it('keeps the two row shapes in separate last-known-good entries', async () => {
		fetchFirstMock.mockResolvedValue({ value: ROWS, source: 'coingecko' });
		await fetchMarketsTable({ page: 1, perPage: 100, category: 'aave-tokens' });
		await fetchMarketsTable({
			page: 1,
			perPage: 100,
			category: 'aave-tokens',
			sparkline: false,
		});

		expect([...cacheStore.keys()].sort()).toEqual([
			'coin:markets:lkg:aave-tokens:p1:pp100',
			'coin:markets:lkg:aave-tokens:p1:pp100:nospark',
		]);
	});
});
