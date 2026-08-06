// The treasury sweep's master revenue share: split math and the registry's
// reserved maintenance slots (the two halves of the July 2026 starvation fix).
import { describe, it, expect } from 'vitest';
import { splitSweep, payerFloatDeficit } from '../api/_lib/x402/pipelines/ring-rebalance.js';
import { getFullRegistry } from '../api/_lib/x402/autonomous-registry.js';

describe('splitSweep', () => {
	it('routes the configured bps to the master and the rest to the payer', () => {
		const { payerCut, masterCut } = splitSweep(100_000_000n, 2_000);
		expect(masterCut).toBe(20_000_000n);
		expect(payerCut).toBe(80_000_000n);
		expect(payerCut + masterCut).toBe(100_000_000n);
	});

	it('drops a dust-sized master leg entirely', () => {
		const { payerCut, masterCut } = splitSweep(400_000n, 2_000); // 20% = $0.08 < $0.10 floor
		expect(masterCut).toBe(0n);
		expect(payerCut).toBe(400_000n);
	});

	it('bps=0 disables the master leg', () => {
		const { payerCut, masterCut } = splitSweep(50_000_000n, 0);
		expect(masterCut).toBe(0n);
		expect(payerCut).toBe(50_000_000n);
	});

	it('bps=10000 sends the full sweep to the master', () => {
		const { payerCut, masterCut } = splitSweep(50_000_000n, 10_000);
		expect(masterCut).toBe(50_000_000n);
		expect(payerCut).toBe(0n);
	});

	it('never loses atomics to rounding', () => {
		const { payerCut, masterCut } = splitSweep(1_234_567n, 3_333);
		expect(payerCut + masterCut).toBe(1_234_567n);
	});
});

// The float drain the revshare caused in a CLOSED loop: the same principal laps
// payer -> treasury -> payer many times a day, so a cut on every sweep is a cut on
// the working capital taken again on every lap. Mainnet 2026-07-25 to 2026-08-06:
// $54 of payer float, $268 of `revshare` booked in x402_ring_ledger, $0.77 of
// float left. The cut now comes out of the surplus above the payer's float floor.
describe('splitSweep payer-float protection', () => {
	it('pays the master nothing while the payer is short of its float floor', () => {
		// $1.00 sweep, payer $5.00 short: the whole sweep goes back to the float.
		const { payerCut, masterCut } = splitSweep(1_000_000n, 3_500, 5_000_000n);
		expect(masterCut).toBe(0n);
		expect(payerCut).toBe(1_000_000n);
	});

	it('shares only the surplus once the sweep covers the deficit', () => {
		// $10 sweep, payer $4 short: $6 is surplus, 35% of that is $2.10.
		const { payerCut, masterCut } = splitSweep(10_000_000n, 3_500, 4_000_000n);
		expect(masterCut).toBe(2_100_000n);
		expect(payerCut).toBe(7_900_000n);
		expect(payerCut + masterCut).toBe(10_000_000n);
	});

	it('behaves exactly as before once the payer is whole', () => {
		const gated = splitSweep(100_000_000n, 2_000, 0n);
		const legacy = splitSweep(100_000_000n, 2_000);
		expect(gated).toEqual(legacy);
		expect(gated.masterCut).toBe(20_000_000n);
	});

	it('cannot be driven negative by a nonsense deficit', () => {
		const { payerCut, masterCut } = splitSweep(1_000_000n, 3_500, -5n);
		expect(masterCut).toBe(350_000n);
		expect(payerCut).toBe(650_000n);
	});

	it('survives the compounding case the drain came from', () => {
		// Repeated $1 laps against a payer stuck at $0.20 of a $6 floor never skim.
		let float = 200_000n;
		for (let i = 0; i < 20; i += 1) {
			const { payerCut, masterCut } = splitSweep(1_000_000n, 3_500, payerFloatDeficit(float, 6_000_000n));
			expect(masterCut).toBe(0n);
			float += payerCut - 1_000_000n; // pays it straight back out next lap
		}
		expect(float).toBe(200_000n);
	});
});

describe('payerFloatDeficit', () => {
	it('is zero at or above the floor', () => {
		expect(payerFloatDeficit(6_000_000n, 6_000_000n)).toBe(0n);
		expect(payerFloatDeficit(9_000_000n, 6_000_000n)).toBe(0n);
	});

	it('measures the shortfall below the floor', () => {
		expect(payerFloatDeficit(232_050n, 6_000_000n)).toBe(5_767_950n);
		expect(payerFloatDeficit(0n, 6_000_000n)).toBe(6_000_000n);
	});
});

describe('autonomous registry maintenance slots', () => {
	it('marks every recirculation pipeline as maintenance so the loop reserves it a slot', () => {
		const registry = getFullRegistry();
		const byId = Object.fromEntries(registry.map((e) => [e.id, e]));
		for (const id of ['ring-rebalance', 'ring-float-topup', 'ring-pool-fund']) {
			expect(byId[id], `${id} present`).toBeTruthy();
			expect(byId[id].maintenance, `${id}.maintenance`).toBe(true);
		}
	});

	it('keeps maintenance a small reserved set, not a backdoor around MAX_PER_TICK', () => {
		const maint = getFullRegistry().filter((e) => e.maintenance);
		expect(maint.length).toBeLessThanOrEqual(5);
		for (const e of maint) expect(typeof e.run).toBe('function');
	});
});

describe('signer floor env overrides', () => {
	it('SIGNER_MIN_SOL_<NAME> overrides a registry floor at load', async () => {
		process.env.SIGNER_MIN_SOL_COIN_LAUNCHER_MASTER = '0.05';
		const { SOLANA_SIGNERS } = await import('../api/_lib/solana-signers.js?floor-override');
		const spec = SOLANA_SIGNERS.find((s) => s.name === 'coin-launcher-master');
		expect(spec.minSol).toBe(0.05);
		delete process.env.SIGNER_MIN_SOL_COIN_LAUNCHER_MASTER;
	});
});
