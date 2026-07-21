// market-realness: the painted-stairstep detector, calibrated to the platform's
// own labeled outcomes (two-sided markets win ~52% vs a ~12% base).

import { describe, it, expect } from 'vitest';
import { assessMarketRealness } from '../api/_lib/market-realness.js';

describe('assessMarketRealness', () => {
	it('flags a painted one-sided rise (the honeypot stairstep)', () => {
		const m = assessMarketRealness({ unique_buyers: 4, unique_sellers: 0, buy_count: 11, sell_count: 0, concentration_top5: 0.94, timing_entropy: 0.3 });
		expect(m.painted).toBe(true);
		expect(m.twoSided).toBe(false);
		expect(m.realness).toBeLessThan(0.3);
		expect(m.flags).toContain('one_sided_no_sellers');
		expect(m.flags).toContain('whale_concentrated');
	});

	it('rewards a genuine two-sided market', () => {
		const m = assessMarketRealness({ unique_buyers: 31, unique_sellers: 8, buy_count: 60, sell_count: 22, concentration_top5: 0.42, timing_entropy: 0.8 });
		expect(m.twoSided).toBe(true);
		expect(m.painted).toBe(false);
		expect(m.realness).toBeGreaterThan(0.8);
	});

	it('stays neutral when there is not enough trading to read', () => {
		const m = assessMarketRealness({ unique_buyers: 1, buy_count: 1, sell_count: 0 });
		expect(m.painted).toBe(false);
		expect(m.twoSided).toBe(false);
		expect(m.realness).toBe(0.5);
		expect(m.flags).toContain('insufficient_trades');
	});

	it('does not convict on thin-crowd alone (needs two structural tells)', () => {
		// few buyers but real sellers and not whale-held → not painted
		const m = assessMarketRealness({ unique_buyers: 8, unique_sellers: 4, buy_count: 12, sell_count: 6, concentration_top5: 0.5, timing_entropy: 0.9 });
		expect(m.painted).toBe(false);
	});
});
