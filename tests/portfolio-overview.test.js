// api/_lib/portfolio-overview.js is the pure arithmetic behind
// /api/crypto/portfolio and the /portfolio page. Same testing philosophy as
// tests/portfolio.test.js: hand-computed fixtures, no network, no mocks of
// upstreams (there are none to mock; the module is pure by design).

import { describe, it, expect } from 'vitest';
import {
	classifyToken,
	buildOverview,
	STABLE_SYMBOLS,
	MAJOR_SYMBOLS,
	TOP_ASSET_SLOTS,
} from '../api/_lib/portfolio-overview.js';

describe('classifyToken', () => {
	it('classifies stables, majors, and everything else', () => {
		expect(classifyToken('USDC')).toBe('stable');
		expect(classifyToken('usdt')).toBe('stable');
		expect(classifyToken('SOL')).toBe('major');
		expect(classifyToken('jitoSOL')).toBe('major');
		expect(classifyToken('WETH')).toBe('major');
		expect(classifyToken('BONK')).toBe('other');
		expect(classifyToken('')).toBe('other');
		expect(classifyToken(null)).toBe('other');
	});

	it('keeps the stable and major sets disjoint', () => {
		for (const s of STABLE_SYMBOLS) expect(MAJOR_SYMBOLS.has(s)).toBe(false);
	});
});

// 2 SOL @ $200 (+5%), 100 USDC @ $1 (0%), 1000 MEME @ $0.05 (-10%),
// and 5 DUST with no price.
const FIXTURE = {
	chain: 'solana',
	address: 'WaLLetAddr',
	native: { symbol: 'SOL', name: 'Solana', amount: 2, price: 200, usd: 400, change24h: null },
	tokens: [
		{ mint: 'UsdcMint', symbol: 'USDC', name: 'USD Coin', amount: 100, price: 1, usd: 100, change24h: null },
		{ mint: 'MemeMint', symbol: 'MEME', name: 'Meme Token', amount: 1000, price: 0.05, usd: 50, change24h: null },
		{ mint: 'DustMint', symbol: 'DUST', name: 'Dust', amount: 5, price: 0, usd: 0, change24h: null },
	],
};

const CHANGES = new Map([
	['native', 5],
	['UsdcMint', 0],
	['MemeMint', -10],
]);

describe('buildOverview', () => {
	it('totals, classifies, and ranks the fixture wallet', () => {
		const o = buildOverview(FIXTURE, CHANGES);

		expect(o.totalUsd).toBe(550);
		expect(o.tokenCount).toBe(4);
		expect(o.truncated).toBe(false);
		expect(o.unpricedCount).toBe(1);

		expect(o.summary.major).toEqual({ usd: 400, pct: 72.73, count: 1 });
		expect(o.summary.stable).toEqual({ usd: 100, pct: 18.18, count: 1 });
		// DUST counts as a held position even though it has no price.
		expect(o.summary.other).toEqual({ usd: 50, pct: 9.09, count: 2 });

		// Rows sorted by value descending; native first by value here.
		expect(o.rows.map((r) => r.symbol)).toEqual(['SOL', 'USDC', 'MEME', 'DUST']);
		expect(o.rows[0].kind).toBe('native');
		expect(o.rows[0].sharePct).toBe(72.73);
		// Unpriced rows surface usd: null, never a fake zero valuation.
		expect(o.rows[3].price).toBe(null);
		expect(o.rows[3].usd).toBe(null);
	});

	it('computes the exact 24h move over covered value only', () => {
		const o = buildOverview(FIXTURE, CHANGES);

		// SOL: 400 - 400/1.05 = 19.047619; MEME: 50 - 50/0.9 = -5.555556;
		// USDC: 0. Delta = 13.492063, previous covered value = 536.507937.
		expect(o.change24h.usd).toBe(13.49);
		expect(o.change24h.pct).toBe(2.51);
		expect(o.change24h.coveragePct).toBe(100);
	});

	it('reports partial coverage when some tokens have no change data', () => {
		const partial = new Map([['native', 5]]);
		const o = buildOverview(FIXTURE, partial);
		// Only SOL (400 of 550) is covered.
		expect(o.change24h.coveragePct).toBe(72.73);
		expect(o.change24h.usd).toBe(19.05);
	});

	it('returns change24h null when nothing is covered', () => {
		const o = buildOverview(FIXTURE, new Map());
		expect(o.change24h).toBe(null);
	});

	it('ignores a -100% change instead of dividing by zero', () => {
		const o = buildOverview(FIXTURE, new Map([['MemeMint', -100]]));
		expect(o.change24h).toBe(null);
	});

	it('prefers the enrichment map over a change baked into the snapshot', () => {
		const baked = {
			...FIXTURE,
			tokens: [{ mint: 'UsdcMint', symbol: 'USDC', name: 'USD Coin', amount: 100, price: 1, usd: 100, change24h: 9 }],
		};
		const o = buildOverview(baked, new Map([['UsdcMint', 1]]));
		const usdc = o.rows.find((r) => r.symbol === 'USDC');
		expect(usdc.change24h).toBe(1);
	});

	it('keeps a baked change when the map has no entry', () => {
		const baked = {
			...FIXTURE,
			tokens: [{ mint: 'UsdcMint', symbol: 'USDC', name: 'USD Coin', amount: 100, price: 1, usd: 100, change24h: 9 }],
		};
		const o = buildOverview(baked, null);
		expect(o.rows.find((r) => r.symbol === 'USDC').change24h).toBe(9);
	});

	it('folds allocation past the slot cap into Other', () => {
		const many = {
			chain: 'solana',
			address: 'W',
			native: { symbol: 'SOL', amount: 1, price: 100, usd: 100 },
			tokens: Array.from({ length: 7 }, (_, i) => ({
				mint: `M${i}`,
				symbol: `TK${i}`,
				name: `Token ${i}`,
				amount: 1,
				price: 50 - i,
				usd: 50 - i,
			})),
		};
		const o = buildOverview(many, null);
		expect(o.topAssets).toHaveLength(TOP_ASSET_SLOTS + 1);
		const other = o.topAssets.at(-1);
		expect(other.symbol).toBe('Other');
		expect(other.slot).toBe(0);
		expect(other.count).toBe(3);
		// Slots are assigned in rank order, never cycled.
		expect(o.topAssets.slice(0, TOP_ASSET_SLOTS).map((a) => a.slot)).toEqual([1, 2, 3, 4, 5]);
		// Percentages of named slots + Other account for the whole portfolio.
		const pctSum = o.topAssets.reduce((s, a) => s + a.pct, 0);
		expect(pctSum).toBeGreaterThan(99.9);
		expect(pctSum).toBeLessThan(100.1);
	});

	it('merges the same symbol across positions in the allocation', () => {
		const dup = {
			chain: 'evm',
			address: '0xW',
			native: { symbol: 'ETH', amount: 1, price: 3000, usd: 3000 },
			tokens: [
				{ contract: '0xA', symbol: 'AAA', amount: 10, price: 10, usd: 100 },
				{ contract: '0xB', symbol: 'AAA', amount: 5, price: 10, usd: 50 },
			],
		};
		const o = buildOverview(dup, null);
		const aaa = o.topAssets.find((a) => a.symbol === 'AAA');
		expect(aaa.usd).toBe(150);
		expect(o.topAssets).toHaveLength(2);
	});

	it('caps rows at maxRows and flags truncation', () => {
		const big = {
			chain: 'solana',
			address: 'W',
			native: { symbol: 'SOL', amount: 1, price: 100, usd: 100 },
			tokens: Array.from({ length: 250 }, (_, i) => ({
				mint: `M${i}`, symbol: `T${i}`, amount: 1, price: 1, usd: 1,
			})),
		};
		const o = buildOverview(big, null);
		expect(o.rows).toHaveLength(200);
		expect(o.tokenCount).toBe(251);
		expect(o.truncated).toBe(true);
	});

	it('handles an empty wallet without inventing anything', () => {
		const o = buildOverview({ chain: 'solana', address: 'W', native: { symbol: 'SOL', amount: 0, price: 200, usd: 0 }, tokens: [] }, null);
		expect(o.totalUsd).toBe(0);
		expect(o.rows).toEqual([]);
		expect(o.change24h).toBe(null);
		expect(o.topAssets).toEqual([]);
	});
});
