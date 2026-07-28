import { describe, it, expect } from 'vitest';
import { planUsdcTopups } from '../api/_lib/economy-usdc-topup.js';

// Fixed caps so the tests do not depend on env: keep $10 on the master, move at
// most $15 per transfer and $40 per day, refill to 1.5x floor, skip under $1.
const caps = { masterKeep: 10, perTransferUsd: 15, dailyUsd: 40, refillMultiple: 1.5, minTransferUsd: 1 };

describe('planUsdcTopups', () => {
	it('refills a below-floor wallet toward floor x multiple from master surplus', () => {
		// The 2026-07-28 shape: payer at 5 USDC against a $10 floor while the
		// master idles at 48. Target 15, so it sends 10.
		const { plan } = planUsdcTopups({
			masterUsdc: 48,
			spentTodayUsd: 0,
			caps,
			wallets: [{ name: 'x402-ring-payer', pubkey: 'P', usdc: 5, floorUsd: 10 }],
		});
		expect(plan).toHaveLength(1);
		expect(plan[0].sendUsd).toBe(10);
	});

	it('arms only below the floor: a wallet between floor and target is stable', () => {
		// 12 USDC sits above the $10 floor but below the $15 target. Topping it up
		// anyway would re-trigger a trickle every run; it must hold steady.
		const { plan, skipped } = planUsdcTopups({
			masterUsdc: 48,
			spentTodayUsd: 0,
			caps,
			wallets: [{ name: 'x402-ring-payer', pubkey: 'P', usdc: 12, floorUsd: 10 }],
		});
		expect(plan).toHaveLength(0);
		expect(skipped[0].reason).toBe('above_floor');
	});

	it('never spends the master below its keep floor', () => {
		// Master holds 11 against a $10 keep: only $1 is spendable.
		const { plan } = planUsdcTopups({
			masterUsdc: 11,
			spentTodayUsd: 0,
			caps,
			wallets: [{ name: 'x402-ring-payer', pubkey: 'P', usdc: 2, floorUsd: 10 }],
		});
		expect(plan).toHaveLength(1);
		expect(plan[0].sendUsd).toBe(1);
	});

	it('reports master_at_keep_floor when there is nothing spendable', () => {
		const { plan, skipped } = planUsdcTopups({
			masterUsdc: 10,
			spentTodayUsd: 0,
			caps,
			wallets: [{ name: 'x402-ring-payer', pubkey: 'P', usdc: 2, floorUsd: 10 }],
		});
		expect(plan).toHaveLength(0);
		expect(skipped[0].reason).toBe('master_at_keep_floor');
	});

	it('honors the daily cap across runs', () => {
		const { plan, skipped } = planUsdcTopups({
			masterUsdc: 100,
			spentTodayUsd: 39.5,
			caps,
			wallets: [{ name: 'x402-ring-payer', pubkey: 'P', usdc: 2, floorUsd: 10 }],
		});
		expect(plan).toHaveLength(0);
		expect(skipped[0].reason).toBe('daily_cap_reached');
	});

	it('serves the neediest wallet first and shares the budgets', () => {
		// Master surplus is $12 ($22 - $10 keep). Ring (shortfall $8) beats a2a
		// (shortfall $3); ring wants $13 to reach target but the surplus leaves
		// only $12, then a2a gets nothing.
		const { plan, skipped } = planUsdcTopups({
			masterUsdc: 22,
			spentTodayUsd: 0,
			caps,
			wallets: [
				{ name: 'a2a-payer', pubkey: 'A', usdc: 2, floorUsd: 5 },
				{ name: 'x402-ring-payer', pubkey: 'P', usdc: 2, floorUsd: 10 },
			],
		});
		expect(plan[0].name).toBe('x402-ring-payer');
		expect(plan[0].sendUsd).toBe(12);
		expect(skipped.find((s) => s.name === 'a2a-payer').reason).toBe('master_at_keep_floor');
	});

	it('caps a single transfer at the per-transfer bound', () => {
		const bigFloor = { ...caps, perTransferUsd: 5 };
		const { plan } = planUsdcTopups({
			masterUsdc: 100,
			spentTodayUsd: 0,
			caps: bigFloor,
			wallets: [{ name: 'x402-ring-payer', pubkey: 'P', usdc: 0, floorUsd: 10 }],
		});
		expect(plan[0].sendUsd).toBe(5);
	});
});
