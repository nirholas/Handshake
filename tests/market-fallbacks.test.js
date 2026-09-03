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
	parseKrakenTicker,
	parseCoinbaseSpot,
	parseBitfinexTicker,
	normalizeKrakenChart,
	normalizeCoinbaseChart,
	EXCHANGE_PAIRS,
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

	// Number(null) is 0, so an absent field used to arrive as a confident zero:
	// CoinGecko reports market_cap_rank: null for coins it has not ranked, and
	// that became rank 0, which sorted the coin above Bitcoin at the top of the
	// /coins and /screener tables (observed live 2026-09-03 on
	// tradable-singapore-fintech-ssl-2). Absent stays absent.
	it('keeps an unreported number null instead of coercing it to zero', () => {
		const row = normalizeGeckoRow({
			id: 'tradable-singapore-fintech-ssl-2',
			symbol: 'pc0000023',
			name: 'Tradable Singapore Fintech SSL',
			market_cap_rank: null,
			current_price: 1,
			market_cap: 114_500_000,
			total_volume: null,
			price_change_percentage_24h_in_currency: null,
			price_change_percentage_7d_in_currency: undefined,
		});
		expect(row.rank).toBeNull();
		expect(row.volume_24h).toBeNull();
		expect(row.change_24h).toBeNull();
		expect(row.change_7d).toBeNull();
		// A genuine zero is still a zero.
		expect(normalizeGeckoRow({ id: 'z', total_volume: 0 }).volume_24h).toBe(0);
	});
});

describe('exchange spot ticker parsers', () => {
	it("Kraken ticker → last trade price under Kraken's internal pair alias", () => {
		// Querying XBTUSD comes back keyed XXBTZUSD; the parser must not depend
		// on knowing the alias.
		const raw = { error: [], result: { XXBTZUSD: { a: ['64000.1'], c: ['63980.5', '0.01'] } } };
		expect(parseKrakenTicker(raw)).toBeCloseTo(63980.5);
	});

	it('Coinbase spot → data.amount', () => {
		expect(
			parseCoinbaseSpot({ data: { base: 'BTC', currency: 'USD', amount: '64010.55' } }),
		).toBeCloseTo(64010.55);
	});

	it('Bitfinex ticker array → LAST_PRICE at index 6', () => {
		const t = [63900, 12.5, 63901, 8.1, -120, -0.0019, 63975.2, 480.7, 64890, 63500];
		expect(parseBitfinexTicker(t)).toBeCloseTo(63975.2);
	});

	it('misses (null) on empty or malformed payloads', () => {
		expect(parseKrakenTicker({ error: ['EQuery:Unknown asset pair'], result: {} })).toBeNull();
		expect(parseCoinbaseSpot({})).toBeNull();
		expect(parseBitfinexTicker(['error'])).toBeNull();
		expect(parseBitfinexTicker(null)).toBeNull();
	});

	it('maps exactly the headline assets, all three exchanges each', () => {
		for (const id of ['bitcoin', 'ethereum', 'solana']) {
			expect(Object.keys(EXCHANGE_PAIRS[id]).sort()).toEqual([
				'bitfinex',
				'coinbase',
				'kraken',
			]);
		}
	});
});

describe('exchange candle chart normalizers', () => {
	const now = 1_784_467_200_000; // fixed "now" so window clipping is deterministic
	const hour = 3_600_000;

	it('Kraken OHLC → [[ts_ms, close]] clipped to the window, oldest first', () => {
		const rows = [
			[(now - 30 * hour) / 1000, '100', '110', '95', '105', '102', '10', 5], // outside 1d window
			[(now - 20 * hour) / 1000, '105', '112', '101', '108', '106', '12', 6],
			[(now - 2 * hour) / 1000, '108', '115', '107', '111', '110', '9', 4],
		];
		const out = normalizeKrakenChart({ result: { XXBTZUSD: rows, last: 12345 } }, 1, now);
		expect(out).toEqual([
			[now - 20 * hour, 108],
			[now - 2 * hour, 111],
		]);
	});

	it('Coinbase candles → newest-first input re-sorted oldest first', () => {
		const raw = [
			[(now - 1 * hour) / 1000, 107, 112, 108, 111, 20], // [t, low, high, open, close, vol]
			[(now - 2 * hour) / 1000, 101, 109, 102, 108, 15],
			[(now - 50 * hour) / 1000, 90, 100, 92, 99, 30], // outside 1d window
		];
		const out = normalizeCoinbaseChart(raw, 1, now);
		expect(out).toEqual([
			[now - 2 * hour, 108],
			[now - 1 * hour, 111],
		]);
	});

	it('misses (null) when every candle is outside the window or malformed', () => {
		expect(normalizeKrakenChart({ result: {} }, 1, now)).toBeNull();
		expect(normalizeKrakenChart(null, 1, now)).toBeNull();
		expect(normalizeCoinbaseChart({ message: 'NotFound' }, 1, now)).toBeNull();
		expect(
			normalizeCoinbaseChart([[(now - 100 * hour) / 1000, 1, 2, 1, 2, 3]], 1, now),
		).toBeNull();
	});
});
