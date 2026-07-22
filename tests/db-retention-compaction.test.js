// pickCompactionTargets — the pure selection bounds behind db-retention's
// section D (VACUUM FULL under storage pressure). The floors and ordering are
// what keep the rewrite step safe: never touch mostly-live tables, never
// rewrite more than the per-tick cap, and always free the small files first so
// each rewrite has headroom near a hard cap.
import { describe, it, expect } from 'vitest';
import { pickCompactionTargets } from '../api/cron/db-retention.js';

const pick = (candidates, over = {}) =>
	pickCompactionTargets({
		candidates,
		minFreeMb: 25,
		minFreeRatio: 0.3,
		maxTables: 3,
		...over,
	});

describe('pickCompactionTargets', () => {
	it('keeps only tables clearing both the absolute and ratio floors', () => {
		const targets = pick([
			{ table: 'bloated', tableMb: 100, freeMb: 60 }, // 60% free — in
			{ table: 'small_free', tableMb: 40, freeMb: 20 }, // 50% free but < 25 MB — out
			{ table: 'big_live', tableMb: 500, freeMb: 60 }, // 60 MB free but only 12% — out
			{ table: 'healthy', tableMb: 80, freeMb: 2 }, // out on both
		]);
		expect(targets.map((t) => t.table)).toEqual(['bloated']);
	});

	it('orders smallest file first so rewrites free headroom progressively', () => {
		const targets = pick([
			{ table: 'huge', tableMb: 500, freeMb: 300 },
			{ table: 'mid', tableMb: 120, freeMb: 70 },
			{ table: 'tiny', tableMb: 60, freeMb: 30 },
		]);
		expect(targets.map((t) => t.table)).toEqual(['tiny', 'mid', 'huge']);
	});

	it('caps the number of rewrites per tick', () => {
		const candidates = Array.from({ length: 6 }, (_, i) => ({
			table: `t${i}`,
			tableMb: 100 + i,
			freeMb: 50,
		}));
		expect(pick(candidates)).toHaveLength(3);
		expect(pick(candidates, { maxTables: 0 })).toHaveLength(0);
	});

	it('ignores zero-size tables instead of dividing by zero', () => {
		expect(pick([{ table: 'empty', tableMb: 0, freeMb: 0 }])).toEqual([]);
	});
});
