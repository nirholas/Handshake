import { describe, it, expect } from 'vitest';

import { pumpCurveMarketFromCoin } from '../api/x402/crypto-intel.js';

// The universal pump.fun launch state: every bonding curve opens with 30 SOL of
// virtual reserves against 1.073e15 virtual tokens, pricing the fixed 1e15
// atomic (1B ui) supply at exactly 30/1.073 SOL of market cap.
const LAUNCH_MCAP_SOL = 30 / 1.073;
const NOW = 1_785_300_000_000;

const freshCoin = (over = {}) => ({
	mint: 'THREEsyntheticCurveCoin111111111111111pump',
	usd_market_cap: 2069.72,
	market_cap: LAUNCH_MCAP_SOL,
	total_supply: 1_000_000_000_000_000,
	created_timestamp: NOW - 3_600_000, // 1h old
	virtual_sol_reserves: 30_000_000_000,
	virtual_token_reserves: 1_073_000_000_000_000,
	complete: false,
	...over,
});

describe('crypto-intel — on-curve pump.fun market mapping', () => {
	it('prices a fresh coin from its usd market cap over the 1B supply', () => {
		const m = pumpCurveMarketFromCoin(freshCoin(), NOW);
		expect(m).toBeTruthy();
		expect(m.price_usd).toBeCloseTo(2069.72 / 1e9, 12);
	});

	it('reports 0% change for a coin still at the launch price', () => {
		const m = pumpCurveMarketFromCoin(freshCoin(), NOW);
		expect(m.change_24h).toBeCloseTo(0, 9);
	});

	it('derives the change since launch from the SOL-denominated cap', () => {
		const doubled = pumpCurveMarketFromCoin(
			freshCoin({ market_cap: LAUNCH_MCAP_SOL * 2 }),
			NOW,
		);
		expect(doubled.change_24h).toBeCloseTo(100, 6);
		const halved = pumpCurveMarketFromCoin(
			freshCoin({ market_cap: LAUNCH_MCAP_SOL / 2 }),
			NOW,
		);
		expect(halved.change_24h).toBeCloseTo(-50, 6);
	});

	it('refuses coins older than 24h — change-since-launch is no longer the 24h change', () => {
		const old = freshCoin({ created_timestamp: NOW - 25 * 3_600_000 });
		expect(pumpCurveMarketFromCoin(old, NOW)).toBeNull();
	});

	it('refuses graduated coins — their market lives on the AMM, not the curve', () => {
		const grad = freshCoin({ complete: true, raydium_pool: 'somepool' });
		expect(pumpCurveMarketFromCoin(grad, NOW)).toBeNull();
	});

	it('refuses records missing the fields an honest read needs', () => {
		expect(pumpCurveMarketFromCoin(null, NOW)).toBeNull();
		expect(pumpCurveMarketFromCoin(freshCoin({ usd_market_cap: null }), NOW)).toBeNull();
		expect(pumpCurveMarketFromCoin(freshCoin({ market_cap: 0 }), NOW)).toBeNull();
		expect(pumpCurveMarketFromCoin(freshCoin({ total_supply: null }), NOW)).toBeNull();
		expect(pumpCurveMarketFromCoin(freshCoin({ created_timestamp: null }), NOW)).toBeNull();
	});
});
