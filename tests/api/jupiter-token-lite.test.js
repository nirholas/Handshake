// Jupiter keyless lite-tier token intelligence (api/_lib/token/jupiter.js).
//
// Pins the four read-only wrappers added next to the swap lane: token search,
// the ranked category lists, the recent-mints feed, and Shield warnings.
// Upstream quirks these tests exist to hold (verified against the REAL
// lite-api.jup.ag on 2026-08-06):
// - an unknown category 200s with junk instead of 404ing, so the wrapper must
//   validate category/interval itself;
// - /tokens/v2/recent ignores its limit param and always returns the fixed
//   page, so trimming is client-side;
// - /ultra/v1/shield answers at most 30 mints per request and silently drops
//   the rest, so the wrapper dedupes and batches.
//
// No live network: global.fetch is stubbed per case.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
	jupiterTokenSearch,
	jupiterTokenList,
	jupiterRecentTokens,
	jupiterShield,
	JUP_TOKEN_CATEGORIES,
	JUP_TOKEN_INTERVALS,
} from '../../api/_lib/token/jupiter.js';

const realFetch = global.fetch;
afterEach(() => {
	global.fetch = realFetch;
	vi.restoreAllMocks();
});

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

// Trimmed real-shaped /tokens/v2 record.
const THREE_RECORD = {
	id: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	name: 'three.ws',
	symbol: 'three',
	decimals: 6,
	launchpad: 'pump.fun',
	holderCount: 15830,
	usdPrice: 0.001764119479092505,
	mcap: 1763536.0054396437,
	liquidity: 236617.60682663386,
};

describe('jupiterTokenSearch', () => {
	it('queries /tokens/v2/search with query + limit and returns the raw records', async () => {
		global.fetch = vi.fn().mockResolvedValue(ok([THREE_RECORD]));
		const out = await jupiterTokenSearch('three.ws', { limit: 5 });
		expect(out).toEqual([THREE_RECORD]);
		const url = new URL(String(global.fetch.mock.calls[0][0]));
		expect(url.origin + url.pathname).toBe('https://lite-api.jup.ag/tokens/v2/search');
		expect(url.searchParams.get('query')).toBe('three.ws');
		expect(url.searchParams.get('limit')).toBe('5');
	});

	it('requires a query and normalizes a non-array body to []', async () => {
		await expect(jupiterTokenSearch('')).rejects.toMatchObject({ code: 'bad_query' });
		global.fetch = vi.fn().mockResolvedValue(ok({ unexpected: true }));
		expect(await jupiterTokenSearch('three')).toEqual([]);
	});

	it('surfaces upstream failures as coded jupiter errors', async () => {
		global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
		await expect(jupiterTokenSearch('three')).rejects.toMatchObject({
			code: 'jupiter_error',
			status: 429,
		});
	});
});

describe('jupiterTokenList', () => {
	it('builds /tokens/v2/{category}/{interval} for every valid pair', async () => {
		global.fetch = vi.fn().mockResolvedValue(ok([THREE_RECORD]));
		const out = await jupiterTokenList('toptrending', '1h', { limit: 10 });
		expect(out).toEqual([THREE_RECORD]);
		const url = new URL(String(global.fetch.mock.calls[0][0]));
		expect(url.pathname).toBe('/tokens/v2/toptrending/1h');
		expect(url.searchParams.get('limit')).toBe('10');
	});

	it('defaults the interval to 24h', async () => {
		global.fetch = vi.fn().mockResolvedValue(ok([]));
		await jupiterTokenList('toptraded');
		expect(new URL(String(global.fetch.mock.calls[0][0])).pathname).toBe('/tokens/v2/toptraded/24h');
	});

	it('rejects unknown categories/intervals locally (upstream 200s with junk)', async () => {
		global.fetch = vi.fn();
		await expect(jupiterTokenList('nope')).rejects.toMatchObject({ code: 'bad_category' });
		await expect(jupiterTokenList('toptrending', '2d')).rejects.toMatchObject({
			code: 'bad_interval',
		});
		expect(global.fetch).not.toHaveBeenCalled();
		expect(JUP_TOKEN_CATEGORIES).toEqual(['toporganicscore', 'toptraded', 'toptrending']);
		expect(JUP_TOKEN_INTERVALS).toEqual(['5m', '1h', '6h', '24h']);
	});
});

describe('jupiterRecentTokens', () => {
	it('trims the fixed upstream page client-side (upstream ignores limit)', async () => {
		const page = Array.from({ length: 30 }, (_, i) => ({ id: `M${i}`, symbol: `S${i}` }));
		global.fetch = vi.fn().mockResolvedValue(ok(page));
		const out = await jupiterRecentTokens({ limit: 3 });
		expect(out).toHaveLength(3);
		expect(out[0].id).toBe('M0');
		// No limit param is sent upstream; there is nothing there to honor it.
		expect(new URL(String(global.fetch.mock.calls[0][0])).search).toBe('');
	});

	it('returns the whole page without a limit and [] on a malformed body', async () => {
		global.fetch = vi.fn().mockResolvedValue(ok([{ id: 'A' }, { id: 'B' }]));
		expect(await jupiterRecentTokens()).toHaveLength(2);
		global.fetch = vi.fn().mockResolvedValue(ok(null));
		expect(await jupiterRecentTokens()).toEqual([]);
	});
});

describe('jupiterShield', () => {
	it('dedupes mints and merges warnings from a single batch', async () => {
		global.fetch = vi.fn().mockResolvedValue(
			ok({ warnings: { A: [], B: [{ type: 'HAS_FREEZE_AUTHORITY', severity: 'warning' }] } }),
		);
		const out = await jupiterShield(['A', 'B', 'A']);
		expect(Object.keys(out)).toEqual(['A', 'B']);
		expect(out.B[0].type).toBe('HAS_FREEZE_AUTHORITY');
		const url = new URL(String(global.fetch.mock.calls[0][0]));
		expect(url.pathname).toBe('/ultra/v1/shield');
		expect(url.searchParams.get('mints')).toBe('A,B');
	});

	it('splits >30 mints into 30-mint batches so upstream truncation never bites', async () => {
		const mints = Array.from({ length: 70 }, (_, i) => `MINT${i}`);
		global.fetch = vi.fn(async (input) => {
			const batch = new URL(String(input)).searchParams.get('mints').split(',');
			expect(batch.length).toBeLessThanOrEqual(30);
			return ok({ warnings: Object.fromEntries(batch.map((m) => [m, []])) });
		});
		const out = await jupiterShield(mints);
		expect(global.fetch).toHaveBeenCalledTimes(3); // 30 + 30 + 10
		expect(Object.keys(out)).toHaveLength(70);
	});

	it('accepts a single mint string, requires at least one, and normalizes a bad body', async () => {
		global.fetch = vi.fn().mockResolvedValue(ok({ warnings: { M: [] } }));
		expect(await jupiterShield('M')).toEqual({ M: [] });
		await expect(jupiterShield([])).rejects.toMatchObject({ code: 'bad_mints' });
		global.fetch = vi.fn().mockResolvedValue(ok({}));
		expect(await jupiterShield('M')).toEqual({});
	});
});
