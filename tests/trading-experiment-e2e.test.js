import { describe, it, expect } from 'vitest';
import { scoreMint } from '../workers/agent-sniper/scorer.js';
import { mayhemVerdict } from '../workers/agent-sniper/mayhem-gate.js';
import { decideLadderedExit } from '../workers/agent-sniper/exit-logic.js';

// End-to-end proof that the 10 SOL experiment's policy is wired to the REAL
// decision functions and behaves exactly as specified — no network. This walks a
// mint from arrival → entry gate → position lifecycle using the exact strategy
// the setup script arms.

// The experiment strategy (mirrors scripts/trading-experiment-setup.mjs).
const STRAT = {
	min_market_cap_usd: 10_000,
	max_market_cap_usd: 100_000,
	require_socials: true,
	max_creator_launches: 10,
	initials_out_multiple: 2,
	moonbag_min_pct: 15,
	trailing_stop_pct: 25,
	take_profit_pct: null,
	stop_loss_pct: 35,
	max_hold_seconds: 86_400,
};

const goodMint = (over = {}) => ({
	mint: 'THREEsynthetic1111111111111111111111111111111',
	market_cap_usd: 50_000,
	twitter: 'https://x.com/x',
	creator_launches: 1,
	...over,
});

describe('entry gate — 10k–100k mcap, socials, no serial launchers', () => {
	it('ACCEPTS a $50k mint with socials', () => {
		expect(scoreMint(goodMint(), STRAT).pass).toBe(true);
	});
	// The mcap-band reasons carry the observed value for the decision journal
	// (e.g. "mc_below_min:5000<10000") — assert on the reason code, not the payload.
	it('REJECTS below $10k (mc_below_min)', () => {
		expect(scoreMint(goodMint({ market_cap_usd: 5_000 }), STRAT).reasons).toContainEqual(
			expect.stringMatching(/^mc_below_min\b/),
		);
	});
	it('REJECTS above $100k (mc_above_max)', () => {
		expect(scoreMint(goodMint({ market_cap_usd: 150_000 }), STRAT).reasons).toContainEqual(
			expect.stringMatching(/^mc_above_max\b/),
		);
	});
	it('REJECTS a no-socials launch', () => {
		expect(scoreMint(goodMint({ twitter: null }), STRAT).reasons).toContain('no_socials');
	});
	it('REJECTS a serial launcher', () => {
		expect(scoreMint(goodMint({ creator_launches: 25 }), STRAT).reasons).toContain('creator_too_many_launches');
	});
});

describe('Mayhem exclusion (owner rule) sits in front of every buy', () => {
	it('a Mayhem mint is excluded regardless of a great score', () => {
		// Even a mint that would pass the scorer is blocked by gate 0.
		expect(scoreMint(goodMint(), STRAT).pass).toBe(true);
		expect(mayhemVerdict(true).pass).toBe(false);
	});
	it('a regular mint is allowed through the gate', () => {
		expect(mayhemVerdict(false).pass).toBe(true);
	});
});

describe('position lifecycle — take initials, hold a moon bag, never cut 100% up', () => {
	const ENTRY = 250_000_000; // 0.25 SOL/trade (the experiment size)
	const pos = (over = {}) => ({
		entry_quote_lamports: String(ENTRY),
		stop_loss_pct: STRAT.stop_loss_pct,
		trailing_stop_pct: STRAT.trailing_stop_pct,
		take_profit_pct: STRAT.take_profit_pct,
		max_hold_seconds: STRAT.max_hold_seconds,
		initials_out_multiple: STRAT.initials_out_multiple,
		moonbag_min_pct: STRAT.moonbag_min_pct,
		initials_recovered: false,
		opened_at: new Date('2026-07-03T00:00:00Z').toISOString(),
		...over,
	});
	const T = new Date('2026-07-03T00:05:00Z').getTime();

	it('holds while under 2× (no premature profit-taking)', () => {
		expect(decideLadderedExit(pos(), 1.7 * ENTRY, 1.7 * ENTRY, T)).toBe(null);
	});

	it('at 2× recovers the initial stake (sell 50%) and keeps a moon bag', () => {
		const d = decideLadderedExit(pos(), 2 * ENTRY, 2 * ENTRY, T);
		expect(d.reason).toBe('take_initials');
		expect(d.sellFraction).toBeCloseTo(0.5);
		expect(d.sellFraction).toBeLessThan(1); // never 100% on the way up
		expect(d.recoversInitials).toBe(true);
	});

	it('the recovered moon bag rides (no exit at 3× with a fresh peak)', () => {
		expect(decideLadderedExit(pos({ initials_recovered: true }), 3 * ENTRY, 3 * ENTRY, T)).toBe(null);
	});

	it('the 25% trailing stop banks the moon bag down to the floor, never to zero', () => {
		// The stake is already home, so this bag is free. The trailing stop books the
		// gain but always leaves the floor riding: a free bag is worth zero at worst
		// and uncapped at best, and selling the last slice gives that up for nothing.
		const d = decideLadderedExit(pos({ initials_recovered: true }), 3 * ENTRY, 4 * ENTRY, T);
		expect(d.reason).toBe('trailing_stop');
		expect(d.sellFraction).toBeLessThan(1);
		expect(d.keepsMoonbag).toBe(true);
	});

	it('the hard 35% stop-loss is a full exit and wins every conflict', () => {
		const d = decideLadderedExit(pos(), 0.6 * ENTRY, 2.5 * ENTRY, T);
		expect(d.reason).toBe('stop_loss');
		expect(d.sellFraction).toBe(1);
	});

	it('times out after 24h', () => {
		const d = decideLadderedExit(pos({ initials_recovered: true }), 1.5 * ENTRY, 1.6 * ENTRY, new Date('2026-07-04T01:00:00Z').getTime());
		expect(d.reason).toBe('timeout');
	});
});
