// Tests for /api/x402/stablecoin-health: the paid stablecoin peg monitor.
//
// Pure-logic only: we exercise the exported normalizer (toCoin) and the peg
// classifier (pegStatus) rather than the paidEndpoint HTTP wrapper, keeping the
// suite off the network while covering what a buyer actually pays for: the
// on-peg / drifting / depegged verdict and the depeg alert list.
//
// Regression under test: stablecoins.llama.fi reports `price: null` for a large
// minority of the USD-pegged assets it tracks (75 of them on 2026-08-14). The
// handler used to coerce that with Number(), which turns null into 0, so every
// unquoted asset was scored at -10000 bps and shipped in the `depegged` alert
// list. A paid depeg monitor must never invent a depeg out of a missing quote.

import { describe, it, expect } from 'vitest';
import { toCoin, pegStatus, OUTPUT_SCHEMA } from '../../api/x402/stablecoin-health.js';

const asset = (over = {}) => ({
	pegType: 'peggedUSD',
	symbol: 'TEST',
	name: 'Test Dollar',
	price: 1,
	pegMechanism: 'fiat-backed',
	circulating: { peggedUSD: 1_000_000 },
	circulatingPrevDay: { peggedUSD: 900_000 },
	chainCirculating: { Solana: {}, Ethereum: {} },
	...over,
});

describe('pegStatus: deviation thresholds', () => {
	it('classifies a tight peg as on-peg', () => {
		expect(pegStatus(0)).toBe('on-peg');
		expect(pegStatus(24)).toBe('on-peg');
		expect(pegStatus(-24)).toBe('on-peg');
	});

	it('classifies 25 bps or more as drifting', () => {
		expect(pegStatus(25)).toBe('drifting');
		expect(pegStatus(-99)).toBe('drifting');
	});

	it('classifies 100 bps or more as depegged', () => {
		expect(pegStatus(100)).toBe('depegged');
		expect(pegStatus(-1_340)).toBe('depegged');
	});

	it('classifies a missing deviation as unknown, never as a depeg', () => {
		expect(pegStatus(null)).toBe('unknown');
		expect(pegStatus(undefined)).toBe('unknown');
	});
});

describe('toCoin: price normalization', () => {
	it('scores a real quote into a deviation and a status', () => {
		const c = toCoin(asset({ price: 0.9467 }));
		expect(c.price).toBe(0.9467);
		expect(c.deviation_bps).toBe(-533);
		expect(c.status).toBe('depegged');
	});

	it('reports an unquoted asset as unknown rather than a total depeg', () => {
		for (const price of [null, undefined, 'n/a']) {
			const c = toCoin(asset({ price }));
			expect(c.price).toBeNull();
			expect(c.deviation_bps).toBeNull();
			expect(c.status).toBe('unknown');
		}
	});

	it('still honors a genuine zero price as a total depeg', () => {
		const c = toCoin(asset({ price: 0 }));
		expect(c.price).toBe(0);
		expect(c.deviation_bps).toBe(-10_000);
		expect(c.status).toBe('depegged');
	});

	it('carries supply flow and chain count through', () => {
		const c = toCoin(asset());
		expect(c.circulating_usd).toBe(1_000_000);
		expect(c.change_24h_pct).toBeCloseTo(11.111, 3);
		expect(c.change_7d_pct).toBeNull();
		expect(c.chains).toBe(2);
	});
});

describe('toCoin: assets the monitor must skip', () => {
	it('skips anything that is not USD-pegged', () => {
		expect(toCoin(asset({ pegType: 'peggedEUR' }))).toBeNull();
		expect(toCoin(asset({ pegType: undefined }))).toBeNull();
	});

	it('skips assets with no real circulating supply', () => {
		expect(toCoin(asset({ circulating: { peggedUSD: 0 } }))).toBeNull();
		expect(toCoin(asset({ circulating: null }))).toBeNull();
		expect(toCoin(asset({ circulating: { peggedUSD: 'many' } }))).toBeNull();
	});

	it('never throws on a malformed upstream row', () => {
		for (const bad of [null, undefined, {}, { pegType: 'peggedUSD' }]) {
			expect(() => toCoin(bad)).not.toThrow();
		}
	});
});

describe('OUTPUT_SCHEMA: the wire contract buyers validate against', () => {
	it('declares every status the classifier can emit', () => {
		const statuses = OUTPUT_SCHEMA.properties.coins.items.properties.status.enum;
		expect(statuses).toEqual(expect.arrayContaining(['on-peg', 'drifting', 'depegged', 'unknown']));
	});

	it('allows a null price and a null deviation for unquoted coins', () => {
		const props = OUTPUT_SCHEMA.properties.coins.items.properties;
		expect(props.price.type).toContain('null');
		expect(props.deviation_bps.type).toContain('null');
	});
});
