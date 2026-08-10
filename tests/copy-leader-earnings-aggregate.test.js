/**
 * accruedLeaderEarnings: the public "this trader has earned X for being copied"
 * figure. It backs a cached public endpoint, so it reads every copier in ONE
 * grouped query and applies the high-water-mark math per row. These pin the math
 * over that shape and the degrade-to-zeros path for a DB that has not migrated.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows = [];
let dbError = null;
const queries = [];
vi.mock('../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		queries.push({ text: strings.join('?'), values });
		if (dbError) return Promise.reject(dbError);
		return Promise.resolve(rows);
	},
}));

const { accruedLeaderEarnings } = await import('../api/_lib/copy-earnings.js');

beforeEach(() => {
	queries.length = 0;
	dbError = null;
	rows = [];
});

describe('accruedLeaderEarnings', () => {
	it('reads every copier in a single query', async () => {
		rows = [
			{ id: 's1', high_water_mark_sol: 0, perf_fee_bps: 1000, profit_sol: '0.025' },
			{ id: 's2', high_water_mark_sol: 0, perf_fee_bps: 1000, profit_sol: '1' },
			{ id: 's3', high_water_mark_sol: 0, perf_fee_bps: 1000, profit_sol: '0' },
		];
		const r = await accruedLeaderEarnings('leader-1', 'mainnet');
		expect(queries).toHaveLength(1);
		expect(r).toEqual({ copiers: 3, accrued_fee_sol: 0.1025, copier_profit_sol: 1.025 });
	});

	it('bills only profit above each copier\'s own high-water mark', async () => {
		rows = [
			{ id: 's1', high_water_mark_sol: 10, perf_fee_bps: 1000, profit_sol: '15' }, // 5 new
			{ id: 's2', high_water_mark_sol: 10, perf_fee_bps: 1000, profit_sol: '8' },  // drawdown
		];
		const r = await accruedLeaderEarnings('leader-1', 'mainnet');
		expect(r.accrued_fee_sol).toBeCloseTo(0.5, 6);
		expect(r.copier_profit_sol).toBeCloseTo(23, 6);
	});

	it('never counts a losing copier against the leader\'s accrued fee', async () => {
		rows = [{ id: 's1', high_water_mark_sol: 0, perf_fee_bps: 1000, profit_sol: '-4' }];
		const r = await accruedLeaderEarnings('leader-1', 'mainnet');
		expect(r).toEqual({ copiers: 1, accrued_fee_sol: 0, copier_profit_sol: 0 });
	});

	it('honors each subscription\'s own fee rate and defaults a missing one to 10%', async () => {
		rows = [
			{ id: 's1', high_water_mark_sol: 0, perf_fee_bps: 2000, profit_sol: '10' },
			{ id: 's2', high_water_mark_sol: 0, perf_fee_bps: null, profit_sol: '10' },
		];
		const r = await accruedLeaderEarnings('leader-1', 'mainnet');
		expect(r.accrued_fee_sol).toBeCloseTo(3, 6); // 2 + 1
	});

	it('degrades to zeros when the copy tables are unreadable', async () => {
		dbError = new Error('relation "copy_subscriptions" does not exist');
		const r = await accruedLeaderEarnings('leader-1', 'mainnet');
		expect(r).toEqual({ copiers: 0, accrued_fee_sol: 0, copier_profit_sol: 0 });
	});
});
