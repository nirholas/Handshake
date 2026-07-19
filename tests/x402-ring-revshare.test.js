// The treasury sweep's master revenue share: split math and the registry's
// reserved maintenance slots (the two halves of the July 2026 starvation fix).
import { describe, it, expect } from 'vitest';
import { splitSweep } from '../api/_lib/x402/pipelines/ring-rebalance.js';
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
