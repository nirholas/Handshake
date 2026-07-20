// Adaptive rate governor: circulation must scale its paid-action budget to the
// treasury it actually has, so a lean treasury yields a quieter-but-live tick
// instead of a wall of guaranteed "treasury balance too low" skips.
import { describe, it, expect } from 'vitest';
import { planBudget } from '../api/_lib/circulation.js';

const COST = 0.012; // est. just-in-time top-up per paid action
const RESERVE = 0.005; // treasury keeps this for its own tx fees

const plan = (treasurySol, actionsPerTick = 4) =>
	planBudget({ treasurySol, actionsPerTick, reserveSol: RESERVE, costPerActionSol: COST });

describe('planBudget', () => {
	it('funds the full rate when the treasury is healthy', () => {
		const b = plan(1.0);
		expect(b.paidBudget).toBe(4);
		expect(b.throttled).toBe(false);
		expect(b.reason).toBeNull();
	});

	it('throttles proportionally as the treasury drains', () => {
		// spendable = 0.05 - 0.005 = 0.045 -> floor(0.045/0.012) = 3
		expect(plan(0.05).paidBudget).toBe(3);
		// spendable = 0.03 - 0.005 = 0.025 -> 2
		expect(plan(0.03).paidBudget).toBe(2);
		// spendable = 0.02 - 0.005 = 0.015 -> 1
		expect(plan(0.02).paidBudget).toBe(1);
	});

	it('reports throttled with a reason when partially funded', () => {
		const b = plan(0.03);
		expect(b.throttled).toBe(true);
		expect(b.reason).toBe('treasury_low');
	});

	it('drops paid actions to zero at/below the reserve (the observed dead state)', () => {
		// 0.0012 SOL is the exact balance that produced 11h of dead circulation.
		const b = plan(0.0012);
		expect(b.paidBudget).toBe(0);
		expect(b.throttled).toBe(true);
		expect(b.reason).toBe('treasury_below_reserve');
	});

	it('never spends the reserve itself', () => {
		expect(plan(RESERVE).paidBudget).toBe(0);
		expect(plan(RESERVE).spendableSol).toBe(0);
	});

	it('handles a zero or negative balance without going negative', () => {
		for (const bal of [0, -1]) {
			const b = plan(bal);
			expect(b.paidBudget).toBe(0);
			expect(b.spendableSol).toBe(0);
		}
	});

	it('never exceeds the configured rate no matter how rich the treasury', () => {
		expect(plan(1000, 4).paidBudget).toBe(4);
		expect(plan(1000, 2).paidBudget).toBe(2);
	});

	it('recovers automatically as the revenue share refills the treasury', () => {
		// The self-balancing property: budget is monotonic in treasury balance,
		// so refill alone restores throughput with no human intervention.
		const curve = [0.001, 0.01, 0.02, 0.04, 0.06].map((s) => plan(s).paidBudget);
		expect(curve).toEqual([...curve].sort((a, b) => a - b));
		expect(curve[0]).toBe(0);
		expect(curve[curve.length - 1]).toBe(4);
	});
});
