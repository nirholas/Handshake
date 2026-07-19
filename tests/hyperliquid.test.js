// Hyperliquid perp normalizer — unit tests.
//
// Pins the metaAndAssetCtxs → derivatives-ticker-row mapping (fixture shaped
// like the real API response) and the unit conversions the comparability of
// the /derivatives table depends on: hourly funding decimal → 8h-equivalent
// percent, and base-asset open interest → USD notional.

import { describe, it, expect } from 'vitest';
import { normalizeHyperliquidPerps } from '../api/_lib/hyperliquid.js';

const FIXTURE = [
	{
		universe: [
			{ szDecimals: 5, name: 'BTC', maxLeverage: 40 },
			{ szDecimals: 4, name: 'ETH', maxLeverage: 25 },
			{ szDecimals: 1, name: 'MATIC', maxLeverage: 20, isDelisted: true },
			{ szDecimals: 2, name: 'SOL', maxLeverage: 20 },
		],
	},
	[
		{
			markPx: '64000',
			prevDayPx: '62500',
			funding: '0.0000125',
			openInterest: '10000',
			dayNtlVlm: '2500000000',
		},
		{
			markPx: '3200',
			prevDayPx: '3300',
			funding: '-0.00002',
			openInterest: '250000',
			dayNtlVlm: '900000000',
		},
		// delisted MATIC still occupies its index slot in the ctx array
		{ markPx: '0.4', prevDayPx: '0.4', funding: '0', openInterest: '0', dayNtlVlm: '0' },
		{
			markPx: '150',
			prevDayPx: '150',
			funding: '0.0000125',
			openInterest: '2000000',
			dayNtlVlm: '3100000000',
		},
	],
];

describe('normalizeHyperliquidPerps', () => {
	it('maps assets to derivatives ticker rows, volume-sorted, delisted dropped', () => {
		const rows = normalizeHyperliquidPerps(FIXTURE);
		expect(rows.map((r) => r.index_id)).toEqual(['SOL', 'BTC', 'ETH']);
		expect(rows.every((r) => r.market === 'Hyperliquid')).toBe(true);
		expect(rows[1].symbol).toBe('BTC-USD');
	});

	it('converts units: hourly funding → 8h percent, OI coins → USD notional', () => {
		const btc = normalizeHyperliquidPerps(FIXTURE).find((r) => r.index_id === 'BTC');
		expect(btc.price).toBe(64000);
		expect(btc.change_24h).toBeCloseTo(2.4, 5); // 64000/62500 - 1 = +2.4%
		expect(btc.funding_rate).toBeCloseTo(0.01, 6); // 0.0000125/h ≈ 0.01% per 8h
		expect(btc.open_interest).toBe(640_000_000); // 10k BTC × $64k
		expect(btc.volume_24h).toBe(2_500_000_000);
	});

	it('null-safes a partial ctx and keeps a negative funding sign', () => {
		const eth = normalizeHyperliquidPerps(FIXTURE).find((r) => r.index_id === 'ETH');
		expect(eth.change_24h).toBeCloseTo(-3.0303, 3);
		expect(eth.funding_rate).toBeCloseTo(-0.016, 6);

		const rows = normalizeHyperliquidPerps([
			{ universe: [{ name: 'X' }] },
			[{ markPx: '2' }],
		]);
		expect(rows).toEqual([
			{
				market: 'Hyperliquid',
				symbol: 'X-USD',
				index_id: 'X',
				price: 2,
				change_24h: null,
				funding_rate: null,
				open_interest: null,
				volume_24h: null,
			},
		]);
	});

	it('returns [] on malformed or empty payloads (assets without a mark price dropped)', () => {
		expect(normalizeHyperliquidPerps(null)).toEqual([]);
		expect(normalizeHyperliquidPerps([{}, []])).toEqual([]);
		expect(normalizeHyperliquidPerps([{ universe: [{ name: 'Y' }] }, [{ markPx: '0' }]])).toEqual([]);
	});
});
