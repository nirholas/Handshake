/**
 * agent-sniper — oracle_crossing trigger + breakeven-armed trailing stop.
 *
 * Two behaviors shipped from the 90-trade postmortem (2026-07-23):
 *
 * 1. crossingCandidates() — pure selection of (strategy, coin) pairs when a
 *    coin's Oracle conviction crosses a strategy's threshold. Locks in the
 *    per-strategy threshold, the once-per-pair dedupe, and the default bar.
 *
 * 2. decideExit() trailing stop arms ONLY above breakeven. Across the fleet's
 *    first 90 real trades every below-breakeven trail realized a small loss
 *    while the hard stop-loss already capped the downside; the trail's job is
 *    to protect gains, not to front-run the stop.
 */

import { describe, it, expect } from 'vitest';
import { crossingCandidates } from '../workers/agent-sniper/oracle-crossing.js';
import { decideExit } from '../workers/agent-sniper/exit-logic.js';

describe('crossingCandidates', () => {
	const armA = { id: 'arm-a', min_oracle_score: 50 };
	const armB = { id: 'arm-b', min_oracle_score: 58 };

	it('selects only coins at or above each strategy threshold', () => {
		const rows = [
			{ mint: 'M1', score: 61 },
			{ mint: 'M2', score: 55 },
			{ mint: 'M3', score: 49 },
		];
		const picks = crossingCandidates(rows, [armA, armB], new Set());
		const keys = picks.map((p) => `${p.strat.id}:${p.coin.mint}`).sort();
		expect(keys).toEqual(['arm-a:M1', 'arm-a:M2', 'arm-b:M1']);
	});

	it('never selects the same (strategy, mint) pair twice', () => {
		const attempted = new Set();
		const rows = [{ mint: 'M1', score: 60 }];
		expect(crossingCandidates(rows, [armA], attempted)).toHaveLength(1);
		expect(crossingCandidates(rows, [armA], attempted)).toHaveLength(0);
		// a different strategy still gets its own attempt
		expect(crossingCandidates(rows, [armB], attempted)).toHaveLength(1);
	});

	it('defaults the bar to 50 when a strategy has no min_oracle_score', () => {
		const bare = { id: 'arm-bare', min_oracle_score: null };
		const picks = crossingCandidates(
			[{ mint: 'M1', score: 50 }, { mint: 'M2', score: 49 }],
			[bare],
			new Set(),
		);
		expect(picks.map((p) => p.coin.mint)).toEqual(['M1']);
	});

	it('handles string scores from the DB driver', () => {
		const picks = crossingCandidates([{ mint: 'M1', score: '52' }], [armA], new Set());
		expect(picks).toHaveLength(1);
	});
});

describe('trailing stop arms only above breakeven', () => {
	const EV = 1_000_000_000; // 1 SOL entry
	const pos = {
		entry_quote_lamports: String(EV),
		stop_loss_pct: 30,
		trailing_stop_pct: 20,
		take_profit_pct: null,
		max_hold_seconds: 3600,
		opened_at: new Date(Date.now() - 60_000).toISOString(),
	};

	it('does NOT fire when the peak never exceeded entry', () => {
		// peak 0.95x (entry-impact typical), value gave back >20% of peak: the old
		// behavior fired trailing_stop here and locked in a -24% loss.
		expect(decideExit(pos, 0.75 * EV, 0.95 * EV)).toBe(null);
	});

	it('still fires on a green position that gives back the trail', () => {
		// peak 1.5x, trail 20% → exit at or below 1.2x
		expect(decideExit(pos, 1.19 * EV, 1.5 * EV)).toBe('trailing_stop');
		expect(decideExit(pos, 1.25 * EV, 1.5 * EV)).toBe(null);
	});

	it('the hard stop-loss still caps an underwater position', () => {
		expect(decideExit(pos, 0.69 * EV, 0.95 * EV)).toBe('stop_loss');
	});
});
