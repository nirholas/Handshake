/**
 * Free-API market fallback normalizers — unit tests.
 *
 * Each provider (CoinGecko / CoinPaprika / CoinLore) returns a different upstream
 * shape; the normalizers collapse them to the single shape the /coins endpoints
 * emit. These tests pin that mapping with fixtures captured from the real live
 * APIs, plus the miss semantics (a payload with no headline number returns null
 * so failover-fetch moves to the next source rather than serving a blank).
 */

import { describe, it, expect } from 'vitest';
import {
	normalizeGeckoGlobal,
	normalizePaprikaGlobal,
	normalizeLoreGlobal,
	normalizeGeckoRow,
} from '../api/_lib/market-fallbacks.js';

describe('global stats normalizers', () => {
	it('CoinGecko /global → top-2 dominance, largest first', () => {
		const out = normalizeGeckoGlobal({
			data: {
				total_market_cap: { usd: 2_300_000_000_000 },
				total_volume: { usd: 111_000_000_000 },
				market_cap_change_percentage_24h_usd: 0.92,
				active_cryptocurrencies: 11979,
				market_cap_percentage: { btc: 55.56, eth: 10.1, usdt: 4.2 },
			},
		});
		expect(out.market_cap_usd).toBe(2_300_000_000_000);
		expect(out.volume_24h_usd).toBe(111_000_000_000);
		expect(out.active_coins).toBe(11979);
		expect(out.dominance).toEqual([
			{ symbol: 'BTC', pct: 55.56 },
			{ symbol: 'ETH', pct: 10.1 },
		]);
	});

	it('CoinPaprika /global → BTC dominance only', () => {
		const out = normalizePaprikaGlobal({
			market_cap_usd: 2_323_129_039_659,
			volume_24h_usd: 111_219_134_442,
			bitcoin_dominance_percentage: 55.56,
			cryptocurrencies_number: 11979,
			market_cap_change_24h: 0.92,
		});
		expect(out.market_cap_usd).toBe(2_323_129_039_659);
		expect(out.active_coins).toBe(11979);
		expect(out.market_cap_change_pct_24h).toBe(0.92);
		expect(out.dominance).toEqual([{ symbol: 'BTC', pct: 55.56 }]);
	});

	it('CoinLore /global → BTC + ETH dominance from an array payload', () => {
		const out = normalizeLoreGlobal([
			{
				coins_count: 14471,
				total_mcap: 2_212_184_671_659,
				total_volume: 59_664_122_147,
				btc_d: '58.14',
				eth_d: '10.10',
				mcap_change: '1.04',
			},
		]);
		expect(out.market_cap_usd).toBe(2_212_184_671_659);
		expect(out.active_coins).toBe(14471);
		expect(out.market_cap_change_pct_24h).toBeCloseTo(1.04);
		expect(out.dominance).toEqual([
			{ symbol: 'BTC', pct: 58.14 },
			{ symbol: 'ETH', pct: 10.1 },
		]);
	});

	it('returns null (a miss) when the headline market cap is absent', () => {
		expect(normalizeGeckoGlobal({ data: {} })).toBeNull();
		expect(normalizeGeckoGlobal(null)).toBeNull();
		expect(normalizePaprikaGlobal({})).toBeNull();
		expect(normalizeLoreGlobal([])).toBeNull();
		expect(normalizeLoreGlobal([{ btc_d: '55' }])).toBeNull();
	});
});

describe('markets table row normalizer', () => {
	it('CoinGecko row → shaped row with a downsampled 7d sparkline', () => {
		const spark = Array.from({ length: 168 }, (_, i) => 100 + i);
		const row = normalizeGeckoRow({
			id: 'bitcoin',
			symbol: 'btc',
			name: 'Bitcoin',
			image: 'https://img/btc.png',
			market_cap_rank: 1,
			current_price: 64_000,
			price_change_percentage_24h_in_currency: 0.58,
			price_change_percentage_7d_in_currency: 1.71,
			market_cap: 1_290_000_000_000,
			total_volume: 12_700_000_000,
			sparkline_in_7d: { price: spark },
		});
		expect(row.id).toBe('bitcoin');
		expect(row.symbol).toBe('BTC');
		expect(row.rank).toBe(1);
		expect(row.price).toBe(64_000);
		expect(row.change_24h).toBeCloseTo(0.58);
		expect(row.change_7d).toBeCloseTo(1.71);
		// Downsampled to at most 32 points, endpoints preserved.
		expect(row.sparkline.length).toBeLessThanOrEqual(32);
		expect(row.sparkline.length).toBeGreaterThan(1);
		expect(row.sparkline[0]).toBe(100);
		expect(row.sparkline[row.sparkline.length - 1]).toBe(spark[spark.length - 1]);
	});

	it('falls back to the plain 24h field and null-safe numbers', () => {
		const row = normalizeGeckoRow({
			id: 'x',
			symbol: null,
			name: null,
			price_change_percentage_24h: -3.2,
			current_price: 'not-a-number',
		});
		expect(row.symbol).toBe('');
		expect(row.name).toBe('x');
		expect(row.change_24h).toBeCloseTo(-3.2);
		expect(row.price).toBeNull();
		expect(row.sparkline).toEqual([]);
	});
});
