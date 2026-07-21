// market-realness: the painted-stairstep detector, calibrated to the platform's
// own labeled outcomes over the active cohort (scripts/rug-signature.mjs). The
// proven tells are front-loading (snipe_ratio), whale concentration
// (concentration_top10), and thin crowd (unique_buyers) — NOT seller presence.

import { describe, it, expect } from 'vitest';
import { assessMarketRealness } from '../api/_lib/market-realness.js';

describe('assessMarketRealness', () => {
	it('flags a front-loaded, whale-held, thin-crowd rise (the honeypot signature)', () => {
		// rug-median shape: few buyers, opening-candle-heavy, float held by ~10 wallets.
		const m = assessMarketRealness({ unique_buyers: 15, unique_sellers: 10, buy_count: 16, sell_count: 11, snipe_ratio: 0.74, concentration_top10: 1.0, bundle_score: 0.31 });
		expect(m.painted).toBe(true);
		expect(m.realness).toBeLessThan(0.3);
		expect(m.flags).toContain('front_loaded_candle');
		expect(m.flags).toContain('whale_held_float');
		expect(m.flags).toContain('thin_crowd');
	});

	it('rewards a genuine coin: real crowd, not front-loaded, not whale-held', () => {
		// winner-median shape.
		const m = assessMarketRealness({ unique_buyers: 34, unique_sellers: 18, buy_count: 37, sell_count: 23, snipe_ratio: 0.47, concentration_top10: 0.9, bundle_score: 0.19 });
		expect(m.painted).toBe(false);
		expect(m.realness).toBeGreaterThan(0.55);
		expect(m.flags).toContain('real_crowd');
	});

	it('does NOT reward seller presence alone (two-sided is a near-useless 1.03x tell)', () => {
		// Plenty of sellers, but front-loaded on a whale-held thin float: still painted.
		const m = assessMarketRealness({ unique_buyers: 12, unique_sellers: 8, buy_count: 14, sell_count: 9, snipe_ratio: 0.8, concentration_top10: 0.98, bundle_score: 0.1 });
		expect(m.painted).toBe(true);
		expect(m.realness).toBeLessThan(0.4);
	});

	it('stays neutral when there is not enough trading to read', () => {
		const m = assessMarketRealness({ unique_buyers: 1, buy_count: 1, sell_count: 0 });
		expect(m.painted).toBe(false);
		expect(m.twoSided).toBe(false);
		expect(m.realness).toBe(0.5);
		expect(m.flags).toContain('insufficient_trades');
	});

	it('does not convict on a single structural tell (needs two of three proven tells)', () => {
		// Whale-ish concentration but a real crowd and no front-loading: not painted.
		const m = assessMarketRealness({ unique_buyers: 40, unique_sellers: 20, buy_count: 45, sell_count: 25, snipe_ratio: 0.3, concentration_top10: 0.96, bundle_score: 0.1 });
		expect(m.painted).toBe(false);
	});
});
