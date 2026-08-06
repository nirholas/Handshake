// Tests for the two keyless oracle rungs in the SOL price failover chain:
// RedStone (api/_lib/redstone.js) and Switchboard-via-Crossbar
// (api/_lib/switchboard.js), plus their wiring into api/_lib/sol-price.js.
//
// No live network here. The parsers are pure functions, so they are exercised
// against fixtures captured from the REAL endpoints on 2026-08-05:
//   https://api.redstone.finance/prices?symbol=SOL&provider=redstone&limit=1
//   https://crossbar.switchboard.xyz/v2/simulate/0x8225...caa9
// plus malformed and stale payloads, and the chain test asserts the rungs sit
// in the oracle band of PROVIDERS (after DIA, before the final Bitfinex rung).

import { describe, it, expect } from 'vitest';
import { parseRedstonePrice, redstoneProvider } from '../../api/_lib/redstone.js';
import {
	parseCrossbarSimulation,
	switchboardProvider,
	SWITCHBOARD_SOL_USD_FEED,
} from '../../api/_lib/switchboard.js';
import { PROVIDERS } from '../../api/_lib/sol-price.js';

// ── Fixtures: trimmed but real-shaped captures ───────────────────────────────

// api.redstone.finance/prices?symbol=SOL&provider=redstone&limit=1 (2026-08-05).
// `source` trimmed to three of the ~20 real exchange keys.
const REDSTONE_TS = 1785974310000;
const redstoneRow = (over = {}) => ({
	id: '40511043-4567-47cf-b56b-dfcc6d0ebd01',
	symbol: 'SOL',
	provider: 'I-5rWUehEv-MjdK9gFw09RxfSLQX9DIHxG614Wf8qo0',
	value: 73.9544894,
	source: { 'kraken-usd': 73.98, 'coinbase-usd': 73.96, 'bitstamp-usd': 73.963 },
	timestamp: REDSTONE_TS,
	minutes: 58,
	...over,
});

// crossbar.switchboard.xyz/v2/simulate/{feedHash} (2026-08-05).
const CROSSBAR_V2 = {
	feeds: [
		{
			feedHash: SWITCHBOARD_SOL_USD_FEED,
			feedName: 'Surge Stream SOL/USD, WEIGHTED',
			results: ['74.02000000'],
			receipts: null,
			network: 'mainnet',
		},
	],
	totalFeeds: 1,
	successfulFeeds: 1,
	failedFeeds: 0,
};

// Legacy bare-array shape from GET /simulate/{feedHash}, same capture date.
const CROSSBAR_LEGACY = [
	{ feedHash: SWITCHBOARD_SOL_USD_FEED, results: ['74.03000000'], receipts: null },
];

/** Minimal Response stand-in: parse() only calls r.json(). */
const asResponse = (body) => /** @type {Response} */ ({ json: async () => body });

// ── RedStone ─────────────────────────────────────────────────────────────────

describe('parseRedstonePrice', () => {
	// "now" 90 seconds after the captured data point: comfortably fresh.
	const NOW = REDSTONE_TS + 90_000;

	it('extracts the value from a real capture', () => {
		expect(parseRedstonePrice([redstoneRow()], 'SOL', NOW)).toBe(73.9544894);
	});

	it('matches the symbol case-insensitively', () => {
		expect(parseRedstonePrice([redstoneRow()], 'sol', NOW)).toBe(73.9544894);
	});

	it('rejects a stale data point (stuck oracle is a miss, not a price)', () => {
		expect(parseRedstonePrice([redstoneRow()], 'SOL', REDSTONE_TS + 11 * 60_000)).toBeNull();
	});

	it('rejects a row missing its timestamp', () => {
		expect(parseRedstonePrice([redstoneRow({ timestamp: undefined })], 'SOL', NOW)).toBeNull();
	});

	it('rejects a row for a different symbol', () => {
		expect(parseRedstonePrice([redstoneRow({ symbol: 'BONK' })], 'SOL', NOW)).toBeNull();
	});

	it('rejects non-positive and non-numeric values', () => {
		expect(parseRedstonePrice([redstoneRow({ value: 0 })], 'SOL', NOW)).toBeNull();
		expect(parseRedstonePrice([redstoneRow({ value: -1 })], 'SOL', NOW)).toBeNull();
		expect(parseRedstonePrice([redstoneRow({ value: 'oops' })], 'SOL', NOW)).toBeNull();
	});

	it('returns null on an empty array (unknown symbol upstream)', () => {
		expect(parseRedstonePrice([], 'SOL', NOW)).toBeNull();
	});

	it('returns null on a non-array body', () => {
		expect(parseRedstonePrice({ error: 'nope' }, 'SOL', NOW)).toBeNull();
		expect(parseRedstonePrice(null, 'SOL', NOW)).toBeNull();
	});
});

describe('redstoneProvider', () => {
	it('builds the keyless single-symbol URL', () => {
		expect(redstoneProvider('SOL').url).toBe(
			'https://api.redstone.finance/prices?symbol=SOL&provider=redstone&limit=1',
		);
	});

	it('uppercases the symbol in both URL and match', async () => {
		const p = redstoneProvider('sol');
		expect(p.url).toContain('symbol=SOL');
		const fresh = redstoneRow({ timestamp: Date.now() - 30_000 });
		await expect(p.parse(asResponse([fresh]))).resolves.toBe(73.9544894);
	});

	it('parses a fresh live-shaped body and misses on a stale one', async () => {
		const p = redstoneProvider('SOL');
		await expect(p.parse(asResponse([redstoneRow({ timestamp: Date.now() - 5_000 })]))).resolves.toBe(
			73.9544894,
		);
		const stale = redstoneRow({ timestamp: Date.now() - 11 * 60_000 });
		await expect(p.parse(asResponse([stale]))).resolves.toBeNull();
	});
});

// ── Switchboard / Crossbar ───────────────────────────────────────────────────

describe('parseCrossbarSimulation', () => {
	it('extracts the value from the v2 object shape', () => {
		expect(parseCrossbarSimulation(CROSSBAR_V2, SWITCHBOARD_SOL_USD_FEED)).toBe(74.02);
	});

	it('extracts the value from the legacy bare-array shape', () => {
		expect(parseCrossbarSimulation(CROSSBAR_LEGACY, SWITCHBOARD_SOL_USD_FEED)).toBe(74.03);
	});

	it('treats the 0x prefix as optional on both sides', () => {
		const bare = SWITCHBOARD_SOL_USD_FEED.slice(2);
		expect(parseCrossbarSimulation(CROSSBAR_V2, bare)).toBe(74.02);
		const payload = { feeds: [{ ...CROSSBAR_V2.feeds[0], feedHash: bare }] };
		expect(parseCrossbarSimulation(payload, SWITCHBOARD_SOL_USD_FEED)).toBe(74.02);
	});

	it('takes the median when a feed carries several oracle samples', () => {
		const feed = { feedHash: SWITCHBOARD_SOL_USD_FEED, results: ['74.05', '74.01', '74.03'] };
		expect(parseCrossbarSimulation({ feeds: [feed] }, SWITCHBOARD_SOL_USD_FEED)).toBe(74.03);
		const even = { feedHash: SWITCHBOARD_SOL_USD_FEED, results: ['74.00', '74.02'] };
		expect(parseCrossbarSimulation({ feeds: [even] }, SWITCHBOARD_SOL_USD_FEED)).toBeCloseTo(74.01, 10);
	});

	it('ignores non-positive and non-numeric samples', () => {
		const feed = { feedHash: SWITCHBOARD_SOL_USD_FEED, results: ['0', '-1', 'NaN', '74.02'] };
		expect(parseCrossbarSimulation({ feeds: [feed] }, SWITCHBOARD_SOL_USD_FEED)).toBe(74.02);
	});

	it('misses on a dead feed (the real empty-results shape Crossbar returns)', () => {
		const dead = [{ feedHash: '0x', results: [], result: '0', stdev: '0', variance: '0' }];
		expect(parseCrossbarSimulation(dead, SWITCHBOARD_SOL_USD_FEED)).toBeNull();
	});

	it('misses when the requested feed is absent or results are empty', () => {
		expect(parseCrossbarSimulation({ feeds: [] }, SWITCHBOARD_SOL_USD_FEED)).toBeNull();
		const empty = { feeds: [{ feedHash: SWITCHBOARD_SOL_USD_FEED, results: [] }] };
		expect(parseCrossbarSimulation(empty, SWITCHBOARD_SOL_USD_FEED)).toBeNull();
	});

	it('returns null on garbage payloads', () => {
		expect(parseCrossbarSimulation(null, SWITCHBOARD_SOL_USD_FEED)).toBeNull();
		expect(parseCrossbarSimulation('nope', SWITCHBOARD_SOL_USD_FEED)).toBeNull();
		expect(parseCrossbarSimulation({}, SWITCHBOARD_SOL_USD_FEED)).toBeNull();
	});
});

describe('switchboardProvider', () => {
	it('builds the /v2/simulate URL with a normalized 0x hash', () => {
		const expected = `https://crossbar.switchboard.xyz/v2/simulate/${SWITCHBOARD_SOL_USD_FEED}`;
		expect(switchboardProvider(SWITCHBOARD_SOL_USD_FEED).url).toBe(expected);
		expect(switchboardProvider(SWITCHBOARD_SOL_USD_FEED.slice(2)).url).toBe(expected);
	});

	it('parses a live-shaped v2 body', async () => {
		const p = switchboardProvider(SWITCHBOARD_SOL_USD_FEED);
		await expect(p.parse(asResponse(CROSSBAR_V2))).resolves.toBe(74.02);
	});
});

// ── Chain wiring in sol-price.js ─────────────────────────────────────────────

describe('sol-price provider chain', () => {
	const names = PROVIDERS.map((p) => p.name);

	it('includes both oracle rungs exactly once', () => {
		expect(names.filter((n) => n === 'redstone')).toHaveLength(1);
		expect(names.filter((n) => n === 'switchboard')).toHaveLength(1);
	});

	it('places them in the oracle band: after DIA, before the final rung', () => {
		const dia = names.indexOf('dia');
		const redstone = names.indexOf('redstone');
		const switchboard = names.indexOf('switchboard');
		expect(dia).toBeGreaterThanOrEqual(0);
		expect(redstone).toBeGreaterThan(dia);
		expect(switchboard).toBeGreaterThan(redstone);
		expect(Math.max(redstone, switchboard)).toBeLessThan(names.length - 1);
	});

	it('keeps CoinGecko first (it alone carries the 24h change for free)', () => {
		expect(names[0]).toBe('coingecko');
	});

	it('gives every rung the fields failover-fetch requires', () => {
		for (const p of PROVIDERS) {
			expect(typeof p.name).toBe('string');
			expect(p.url).toMatch(/^https:\/\//);
			expect(typeof p.parse).toBe('function');
		}
	});

	it('points the oracle rungs at the verified keyless endpoints', () => {
		const byName = Object.fromEntries(PROVIDERS.map((p) => [p.name, p.url]));
		expect(byName.redstone).toBe(
			'https://api.redstone.finance/prices?symbol=SOL&provider=redstone&limit=1',
		);
		expect(byName.switchboard).toBe(
			`https://crossbar.switchboard.xyz/v2/simulate/${SWITCHBOARD_SOL_USD_FEED}`,
		);
	});
});
