import { describe, it, expect } from 'vitest';
import { planRebalance } from '../api/_lib/economy-rebalance.js';

// Fixed bounds so the test doesn't depend on env: $3/swap, $6/run, keep 0.03 SOL
// and $2 USDC in reserve, skip needs under $0.50.
const bounds = { solReserve: 0.03, usdcReserve: 2, perSwapUsd: 3, runCapUsd: 6, dustUsd: 0.5 };
const SOL = 150; // $/SOL

describe('planRebalance', () => {
	it('converts SOL → USDC for a wallet below its USDC floor, capped per-swap', () => {
		const { plan } = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [{ name: 'ring', pubkey: 'R', sol: 1, usdc: 0, wants: 'usdc', floorUsd: 10 }],
		});
		expect(plan).toHaveLength(1);
		expect(plan[0].dir).toBe('sol->usdc');
		// shortfall $10 but per-swap cap is $3
		expect(plan[0].inUsd).toBe(3);
	});

	it('never swaps the SOL reserve away', () => {
		// Only 0.05 SOL total; reserve is 0.03 → 0.02 SOL ($3) swappable, but the
		// need is $10 so it converts the whole $3 surplus and no more.
		const { plan } = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [{ name: 'ring', pubkey: 'R', sol: 0.05, usdc: 0, wants: 'usdc', floorUsd: 10 }],
		});
		expect(plan[0].inUsd).toBeCloseTo(3, 5); // min($10 need, $3 surplus, $3 per-swap)
	});

	it('skips a wallet already at/above its floor (dust)', () => {
		const { plan, skipped } = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [{ name: 'ring', pubkey: 'R', sol: 1, usdc: 9.8, wants: 'usdc', floorUsd: 10 }],
		});
		expect(plan).toHaveLength(0);
		expect(skipped[0].reason).toBe('above_floor');
	});

	it('honors the per-run cap across multiple wallets, neediest first', () => {
		const { plan } = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [
				{ name: 'a2a', pubkey: 'A', sol: 1, usdc: 4, wants: 'usdc', floorUsd: 5 }, // need $1
				{ name: 'ring', pubkey: 'R', sol: 1, usdc: 0, wants: 'usdc', floorUsd: 10 }, // need $10
			],
		});
		// run cap $6: ring (neediest) takes $3, a2a takes $1 → total $4 ≤ $6, both served
		const total = plan.reduce((s, p) => s + p.inUsd, 0);
		expect(total).toBeLessThanOrEqual(6);
		expect(plan.find((p) => p.name === 'ring').inUsd).toBe(3);
		expect(plan[0].name).toBe('ring'); // neediest first
	});

	it('converts USDC → SOL when a SOL-spending wallet is starved but holds USDC', () => {
		const { plan } = planRebalance({
			solPriceUsd: SOL,
			bounds,
			wallets: [{ name: 'gas', pubkey: 'G', sol: 0.0, usdc: 20, wants: 'sol', floorUsd: 5 }],
		});
		expect(plan[0].dir).toBe('usdc->sol');
		expect(plan[0].inUsd).toBe(3); // per-swap cap
	});

	it('aborts everything if the SOL price is unavailable', () => {
		const { plan, skipped } = planRebalance({
			solPriceUsd: 0,
			bounds,
			wallets: [{ name: 'ring', pubkey: 'R', sol: 1, usdc: 0, wants: 'usdc', floorUsd: 10 }],
		});
		expect(plan).toHaveLength(0);
		expect(skipped[0].reason).toBe('no_sol_price');
	});
});
