import { describe, it, expect } from 'vitest';
import { runTickPicks } from '../api/_lib/x402/ring-tick-exec.js';
import { ringTickConfig } from '../api/_lib/x402/ring-tick-plan.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const pick = (key) => ({ key, path: `/api/x402/${key}`, method: 'POST' });
const picks = (n, withSettle = false) => {
	const out = withSettle ? [pick('ring-settle')] : [];
	for (let i = out.length; i < n; i++) out.push(pick(`cheap-${i}`));
	return out;
};

const paidResult = (amount, txSig = 'sig') => ({
	result: { success: true, paid: true, status: 200, txSig },
	paidAmount: amount,
});
const failedResult = (errorMsg = 'boom') => ({
	result: { success: false, paid: false, status: 502, errorMsg },
	paidAmount: 0,
});

const FLOOR = (r) => /sol_floor/.test(r?.errorMsg || '');
const CHEAP_PRICE = 1_000; // $0.001
const RESERVE = 20_000; // $0.02 worst case
const SETTLE_PRICE = 1_000_000; // $1.00

// ── runTickPicks ─────────────────────────────────────────────────────────────

describe('runTickPicks', () => {
	it('runs the settle carrier first, then all cheap picks, and accounts spend', async () => {
		const order = [];
		const out = await runTickPicks({
			picks: picks(5, true),
			remaining: 2_000_000,
			concurrency: 4,
			settleFirst: true,
			ringSettlePriceAtomic: SETTLE_PRICE,
			worstCaseCheapAtomic: RESERVE,
			isFloorSignal: FLOOR,
			pay: async (ep) => {
				order.push(ep.key);
				return paidResult(ep.key === 'ring-settle' ? SETTLE_PRICE : CHEAP_PRICE, `tx-${ep.key}`);
			},
		});
		expect(order[0]).toBe('ring-settle');
		expect(out.calls).toBe(5);
		expect(out.paid).toBe(5);
		expect(out.errors).toBe(0);
		expect(out.spent).toBe(SETTLE_PRICE + 4 * CHEAP_PRICE);
		expect(out.remaining).toBe(2_000_000 - out.spent);
		expect(out.lastTxSig).toMatch(/^tx-/);
		expect(out.results).toHaveLength(5);
		expect(out.results[0].key).toBe('ring-settle');
	});

	it('never spends beyond the budget when calls consume their full reservation', async () => {
		// Budget fits exactly 3 worst-case reservations and every call spends the
		// whole slice — no refunds, so exactly 3 launch.
		const out = await runTickPicks({
			picks: picks(10),
			remaining: 3 * RESERVE,
			concurrency: 8,
			settleFirst: false,
			ringSettlePriceAtomic: SETTLE_PRICE,
			worstCaseCheapAtomic: RESERVE,
			isFloorSignal: FLOOR,
			pay: async () => paidResult(RESERVE),
		});
		expect(out.calls).toBe(3);
		expect(out.capReached).toBe(true);
		expect(out.spent).toBe(3 * RESERVE);
		expect(out.remaining).toBe(0);
		expect(out.results).toHaveLength(3);
	});

	it('recycles refunded reservations into more launches without exceeding the budget', async () => {
		// Same tight budget, but calls spend only $0.001 of each $0.02 slice —
		// refunds flow back, all 10 picks fire, and spend stays under budget.
		const out = await runTickPicks({
			picks: picks(10),
			remaining: 3 * RESERVE,
			concurrency: 8,
			settleFirst: false,
			ringSettlePriceAtomic: SETTLE_PRICE,
			worstCaseCheapAtomic: RESERVE,
			isFloorSignal: FLOOR,
			pay: async () => paidResult(CHEAP_PRICE),
		});
		expect(out.calls).toBe(10);
		expect(out.spent).toBe(10 * CHEAP_PRICE);
		expect(out.spent).toBeLessThanOrEqual(3 * RESERVE);
		expect(out.remaining).toBe(3 * RESERVE - 10 * CHEAP_PRICE);
	});

	it('passes each call its own reservation as the cap', async () => {
		const caps = [];
		await runTickPicks({
			picks: picks(2),
			remaining: 10 * RESERVE,
			concurrency: 1,
			settleFirst: false,
			ringSettlePriceAtomic: SETTLE_PRICE,
			worstCaseCheapAtomic: RESERVE,
			isFloorSignal: FLOOR,
			pay: async (_ep, cap) => { caps.push(cap); return paidResult(CHEAP_PRICE); },
		});
		expect(caps).toEqual([RESERVE, RESERVE]);
	});

	it('clamps the settle reservation to the remaining budget', async () => {
		const caps = [];
		const out = await runTickPicks({
			picks: picks(1, true),
			remaining: 300_000, // less than the $1.00 settle
			concurrency: 2,
			settleFirst: true,
			ringSettlePriceAtomic: SETTLE_PRICE,
			worstCaseCheapAtomic: RESERVE,
			isFloorSignal: FLOOR,
			pay: async (_ep, cap) => { caps.push(cap); return failedResult('cap_exceeded'); },
		});
		expect(caps).toEqual([300_000]);
		expect(out.errors).toBe(1);
		expect(out.remaining).toBe(300_000); // full refund on an unpaid call
	});

	it('stops launching after a floor signal and drains in-flight work', async () => {
		let launched = 0;
		const out = await runTickPicks({
			picks: picks(20),
			remaining: 10_000_000,
			concurrency: 1, // deterministic: floor on the first call
			settleFirst: false,
			ringSettlePriceAtomic: SETTLE_PRICE,
			worstCaseCheapAtomic: RESERVE,
			isFloorSignal: FLOOR,
			pay: async () => { launched += 1; return failedResult('sponsor sol_floor crossed'); },
		});
		expect(launched).toBe(1);
		expect(out.floorHit).toBe(true);
		expect(out.calls).toBe(1);
		expect(out.results).toHaveLength(1);
	});

	it('bounds in-flight calls to the concurrency lanes', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const out = await runTickPicks({
			picks: picks(24),
			remaining: 100_000_000,
			concurrency: 6,
			settleFirst: false,
			ringSettlePriceAtomic: SETTLE_PRICE,
			worstCaseCheapAtomic: RESERVE,
			isFloorSignal: FLOOR,
			pay: async () => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 5));
				inFlight -= 1;
				return paidResult(CHEAP_PRICE);
			},
		});
		expect(out.calls).toBe(24);
		expect(maxInFlight).toBeLessThanOrEqual(6);
		expect(maxInFlight).toBeGreaterThan(1);
	});

	it('counts a throwing pay() as an error and refunds its reservation', async () => {
		const out = await runTickPicks({
			picks: picks(2),
			remaining: 10 * RESERVE,
			concurrency: 2,
			settleFirst: false,
			ringSettlePriceAtomic: SETTLE_PRICE,
			worstCaseCheapAtomic: RESERVE,
			isFloorSignal: FLOOR,
			pay: async (ep) => {
				if (ep.key === 'cheap-0') throw new Error('network down');
				return paidResult(CHEAP_PRICE);
			},
		});
		expect(out.calls).toBe(2);
		expect(out.errors).toBe(1);
		expect(out.paid).toBe(1);
		expect(out.remaining).toBe(10 * RESERVE - CHEAP_PRICE);
	});
});

// ── ringTickConfig concurrency knob ──────────────────────────────────────────

describe('ringTickConfig concurrency', () => {
	it('defaults to 12 lanes', () => {
		expect(ringTickConfig({}).concurrency).toBe(12);
	});
	it('reads X402_RING_TICK_CONCURRENCY and floors at 1', () => {
		expect(ringTickConfig({ X402_RING_TICK_CONCURRENCY: '20' }).concurrency).toBe(20);
		expect(ringTickConfig({ X402_RING_TICK_CONCURRENCY: '0' }).concurrency).toBe(1);
		expect(ringTickConfig({ X402_RING_TICK_CONCURRENCY: 'junk' }).concurrency).toBe(12);
	});
});
