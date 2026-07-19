// Market Mood volatility enrichment — unit tests for the DVOL summarizer and
// the schema guarantee that volatility stays OPTIONAL (a Deribit outage must
// never make a paid response schema-invalid, because the component is
// best-effort and non-gating by contract).

import { describe, it, expect } from 'vitest';

// Discovery env must be set BEFORE the paid-endpoint stack loads — same stub
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

const { summarizeDvol, OUTPUT_SCHEMA } = await import('../api/x402/market-mood.js');

describe('summarizeDvol', () => {
	it('takes the newest close and the 24h change from the oldest close', () => {
		const rows = [
			[1_784_380_000_000, 36.19, 36.38, 36.15, 36.34],
			[1_784_383_600_000, 36.34, 36.34, 36.25, 36.25],
			[1_784_387_200_000, 36.25, 36.35, 36.24, 35.91],
		];
		expect(summarizeDvol(rows)).toEqual({ value: 35.91, change_24h: -0.43 });
	});

	it('a single row yields a value with a null change', () => {
		expect(summarizeDvol([[1, 36, 36, 36, 36.5]])).toEqual({ value: 36.5, change_24h: null });
	});

	it('misses (null) on empty or malformed windows', () => {
		expect(summarizeDvol([])).toBeNull();
		expect(summarizeDvol(null)).toBeNull();
		expect(summarizeDvol([[1, 2, 3, 4, 'x']])).toBeNull();
	});
});

describe('volatility stays optional in the paid contract', () => {
	it('is declared nullable and NOT required at either level', () => {
		const components = OUTPUT_SCHEMA.properties.components;
		expect(components.required).toEqual(['fear_greed', 'news']);
		expect(components.properties.volatility.type).toContain('null');
		expect(OUTPUT_SCHEMA.required).not.toContain('volatility');
	});
});
