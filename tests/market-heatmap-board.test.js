// Market Heatmap board normalization (/api/x402/market-heatmap): unit tests
// for the two pure pieces a buyer's payload is built from.
//
// rankOr covers the upstream shape that produced a nonsense rank of 0: an
// unranked CoinGecko row sends `market_cap_rank: null`, and Number(null) is 0,
// which passes a plain finite check. breadth covers the advancer/decliner split
// including the dead band and unpriced coins.

import { describe, it, expect } from 'vitest';

// Discovery env must be set BEFORE the paid-endpoint stack loads. Same stub
// set tests/market-data-api.test.js uses.
Object.assign(process.env, {
	APP_ORIGIN: 'https://three.ws',
	X402_PAY_TO_BASE: '0x0000000000000000000000000000000000000001',
	X402_PAY_TO_SOLANA: 'So11111111111111111111111111111111111111112',
	X402_ASSET_ADDRESS_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
	X402_ASSET_MINT_SOLANA: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	X402_ASSET_ADDRESS_ARBITRUM: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
	X402_MAX_AMOUNT_REQUIRED: '1000',
	X402_FEE_PAYER_SOLANA: 'So11111111111111111111111111111111111111112',
});

const { finite, rankOr, breadth, OUTPUT_SCHEMA } = await import('../api/x402/market-heatmap.js');

describe('finite', () => {
	it('passes real numbers through, including a legitimate zero', () => {
		expect(finite(118250)).toBe(118250);
		expect(finite('2.4')).toBe(2.4);
		expect(finite(0)).toBe(0);
		expect(finite(-1.5)).toBe(-1.5);
	});

	it('reports an absent value as null instead of inventing a 0', () => {
		// Number(null) and Number('') are both 0: coercing first would publish a
		// "the coin moved 0%" claim for a window the upstream never priced.
		expect(finite(null)).toBeNull();
		expect(finite(undefined)).toBeNull();
		expect(finite('')).toBeNull();
		expect(finite('n/a')).toBeNull();
		expect(finite(Number.NaN)).toBeNull();
		expect(finite(Number.POSITIVE_INFINITY)).toBeNull();
	});
});

describe('rankOr', () => {
	it('keeps a real 1-based rank', () => {
		expect(rankOr(1, 99)).toBe(1);
		expect(rankOr('42', 99)).toBe(42);
	});

	it('falls back for every shape that is not a rank', () => {
		expect(rankOr(null, 7)).toBe(7); // the CoinGecko unranked row
		expect(rankOr(undefined, 7)).toBe(7);
		expect(rankOr(0, 7)).toBe(7);
		expect(rankOr(-3, 7)).toBe(7);
		expect(rankOr('n/a', 7)).toBe(7);
	});

	it('never emits a fractional rank (the output schema declares an integer)', () => {
		expect(rankOr(12.7, 99)).toBe(12);
		expect(OUTPUT_SCHEMA.properties.coins.items.properties.rank.type).toBe('integer');
	});
});

describe('breadth', () => {
	it('splits advancers, decliners, and flat around the dead band', () => {
		const coins = [
			{ change_24h: 3 },
			{ change_24h: 0.4 },
			{ change_24h: 0.01 }, // inside the dead band
			{ change_24h: -0.02 }, // inside the dead band
			{ change_24h: -1.6 },
		];
		expect(breadth(coins)).toEqual({
			advancers: 2,
			decliners: 1,
			flat: 2,
			avg_change_24h: 0.36,
			median_change_24h: 0.01,
		});
	});

	it('averages the even case across the two middle moves', () => {
		const out = breadth([{ change_24h: 1 }, { change_24h: 2 }, { change_24h: 3 }, { change_24h: 6 }]);
		expect(out.median_change_24h).toBe(2.5);
		expect(out.avg_change_24h).toBe(3);
	});

	it('excludes coins the upstream could not price', () => {
		const out = breadth([{ change_24h: 2 }, { change_24h: null }, { change_24h: undefined }]);
		expect(out).toEqual({
			advancers: 1,
			decliners: 0,
			flat: 0,
			avg_change_24h: 2,
			median_change_24h: 2,
		});
	});

	it('reports nulls rather than NaN on an empty board', () => {
		expect(breadth([])).toEqual({
			advancers: 0,
			decliners: 0,
			flat: 0,
			avg_change_24h: null,
			median_change_24h: null,
		});
	});
});
