/**
 * Tournament scoring engine — pure tests.
 *
 * computeStandings / filterWindowPositions / evaluateEligibility / allocatePrizes are
 * all pure (no DB, no network), so every assertion is hand-computed from the fixtures
 * below. These pin the fairness rules: window scoping by OPEN time, the real-trade
 * gate on prize brackets, the verification gates, and basis-point prize allocation.
 */

import { describe, it, expect } from 'vitest';
import {
	filterWindowPositions,
	isRealTrade,
	evaluateEligibility,
	allocatePrizes,
	computeStandings,
	resolveGates,
	scoreValue,
	DEFAULT_GATES,
} from '../api/_lib/tournament-scoring.js';

const SOL = 1e9;

const START = '2026-03-01T00:00:00.000Z';
const END = '2026-03-02T00:00:00.000Z';
const AFTER_END = new Date(new Date(END).getTime() + 1000).toISOString();

/** Build a closed position with sane defaults. */
function pos(over = {}) {
	return {
		status: 'closed',
		mint: over.mint || 'MINT1111',
		symbol: 'X',
		realized_pnl_lamports: String(Math.round((over.pnl ?? 1) * SOL)),
		realized_pnl_pct: over.pct ?? 100,
		entry_quote_lamports: String(Math.round((over.entry ?? 1) * SOL)),
		exit_quote_lamports: String(Math.round(((over.entry ?? 1) + (over.pnl ?? 1)) * SOL)),
		opened_at: over.opened || '2026-03-01T06:00:00.000Z',
		closed_at: over.closed || '2026-03-01T06:10:00.000Z',
		buy_sig: 'buy' in over ? over.buy : 'b-real',
		sell_sig: 's-real',
		...('extra' in over ? over.extra : {}),
	};
}

describe('isRealTrade', () => {
	it('treats SIMULATED / missing buy sigs as paper', () => {
		expect(isRealTrade(pos({ buy: 'b-real' }))).toBe(true);
		expect(isRealTrade(pos({ buy: 'SIMULATED' }))).toBe(false);
		expect(isRealTrade(pos({ buy: null }))).toBe(false);
	});
});

describe('filterWindowPositions', () => {
	const positions = [
		pos({ mint: 'IN1', opened: '2026-03-01T06:00:00.000Z' }), // inside
		pos({ mint: 'BEFORE', opened: '2026-02-28T23:00:00.000Z' }), // before window
		pos({ mint: 'AFTER', opened: '2026-03-02T01:00:00.000Z' }), // after window
		pos({ mint: 'PAPER', opened: '2026-03-01T07:00:00.000Z', buy: 'SIMULATED' }), // paper, inside
	];

	it('keeps only real trades opened inside the window for a prize bracket', () => {
		const kept = filterWindowPositions(positions, { startIso: START, endIso: END, bracket: 'prize' });
		expect(kept.map((p) => p.mint).sort()).toEqual(['IN1']);
	});

	it('keeps paper trades for a practice bracket', () => {
		const kept = filterWindowPositions(positions, { startIso: START, endIso: END, bracket: 'practice' });
		expect(kept.map((p) => p.mint).sort()).toEqual(['IN1', 'PAPER']);
	});
});

describe('resolveGates', () => {
	it('falls back to defaults and accepts overrides', () => {
		expect(resolveGates({})).toEqual(DEFAULT_GATES);
		expect(resolveGates({ entry_rules: { min_closed: 10, max_churn_pct: 20 } })).toEqual({
			min_closed: 10,
			min_unique_coins: DEFAULT_GATES.min_unique_coins,
			max_churn_pct: 20,
		});
	});
});

describe('evaluateEligibility', () => {
	const gates = { min_closed: 3, min_unique_coins: 2, max_churn_pct: 60 };

	it('passes a clean entrant in a prize bracket', () => {
		const metrics = { closed_count: 5, unique_coins: 4, churn_pct: 10 };
		const r = evaluateEligibility({ metrics, gates, bracket: 'prize', realTrades: 5 });
		expect(r.eligible).toBe(true);
		expect(r.reasons).toEqual([]);
	});

	it('rejects too few trades / coins and flags it, never eligible', () => {
		const metrics = { closed_count: 1, unique_coins: 1, churn_pct: 10 };
		const r = evaluateEligibility({ metrics, gates, bracket: 'prize', realTrades: 1 });
		expect(r.eligible).toBe(false);
		expect(r.reasons).toContain('min_closed_3');
		expect(r.reasons).toContain('min_unique_coins_2');
	});

	it('flags wash-suspected on single-coin high churn', () => {
		const metrics = { closed_count: 6, unique_coins: 1, churn_pct: 80 };
		const r = evaluateEligibility({ metrics, gates, bracket: 'prize', realTrades: 6 });
		expect(r.wash_suspected).toBe(true);
		expect(r.eligible).toBe(false);
	});

	it('never makes a practice bracket prize-eligible', () => {
		const metrics = { closed_count: 9, unique_coins: 5, churn_pct: 5 };
		const r = evaluateEligibility({ metrics, gates, bracket: 'practice', realTrades: 9 });
		expect(r.eligible).toBe(false);
		expect(r.reasons).toContain('practice_bracket');
	});
});

describe('allocatePrizes', () => {
	const pool = 1_000_000n; // 1,000,000 atomics
	const splits = [
		{ rank: 1, bps: 6000 },
		{ rank: 2, bps: 3000 },
		{ rank: 3, bps: 1000 },
	];

	it('allocates by basis points to eligible ranks', () => {
		const ranked = [
			{ agent_id: 'a', rank: 1, eligible: true },
			{ agent_id: 'b', rank: 2, eligible: true },
			{ agent_id: 'c', rank: 3, eligible: true },
		];
		const out = allocatePrizes(pool, splits, ranked);
		expect(out.get('a')).toBe(600_000n);
		expect(out.get('b')).toBe(300_000n);
		expect(out.get('c')).toBe(100_000n);
	});

	it('leaves an ineligible rank UNALLOCATED — never redistributed', () => {
		const ranked = [
			{ agent_id: 'a', rank: 1, eligible: true },
			{ agent_id: 'b', rank: 2, eligible: false }, // ineligible — its 3000 bps go unpaid
			{ agent_id: 'c', rank: 3, eligible: true },
		];
		const out = allocatePrizes(pool, splits, ranked);
		expect(out.get('a')).toBe(600_000n);
		expect(out.has('b')).toBe(false);
		expect(out.get('c')).toBe(100_000n);
		const total = [...out.values()].reduce((s, v) => s + v, 0n);
		expect(total).toBe(700_000n); // 300k stays in the pool
	});

	it('pays nothing from an empty pool', () => {
		expect(allocatePrizes(0n, splits, [{ agent_id: 'a', rank: 1, eligible: true }]).size).toBe(0);
	});
});

describe('scoreValue', () => {
	const metrics = { score: 73, realized_pnl_sol: 4.2, roi_pct: 55 };
	it('maps each scoring mode to its metric', () => {
		expect(scoreValue(metrics, 'score')).toBe(73);
		expect(scoreValue(metrics, 'realized_pnl')).toBe(4.2);
		expect(scoreValue(metrics, 'roi_pct')).toBe(55);
		expect(scoreValue(metrics, 'unknown')).toBe(73); // defaults to score
	});
});

describe('computeStandings', () => {
	const tournament = {
		id: 't1',
		network: 'mainnet',
		scoring: 'realized_pnl',
		bracket: 'prize',
		starts_at: START,
		ends_at: END,
		entry_rules: { min_closed: 2, min_unique_coins: 2, max_churn_pct: 60 },
	};

	// Alice: 2 winning real trades on 2 coins, opened in-window → eligible, +3 SOL.
	const alice = {
		entry: { agent_id: 'alice', agent_name: 'Alice', status: 'active', wallet: 'WALLETalice' },
		positions: [
			pos({ mint: 'COIN_A', pnl: 2, opened: '2026-03-01T01:00:00.000Z' }),
			pos({ mint: 'COIN_B', pnl: 1, opened: '2026-03-01T02:00:00.000Z' }),
		],
	};
	// Bob: 1 real trade only (below min_closed) → ranked but ineligible, +5 SOL.
	const bob = {
		entry: { agent_id: 'bob', agent_name: 'Bob', status: 'active', wallet: 'WALLETbob' },
		positions: [pos({ mint: 'COIN_C', pnl: 5, opened: '2026-03-01T03:00:00.000Z' })],
	};
	// Carol: all paper trades → in a prize bracket she has zero counted trades.
	const carol = {
		entry: { agent_id: 'carol', agent_name: 'Carol', status: 'active', wallet: 'WALLETcarol' },
		positions: [
			pos({ mint: 'COIN_D', pnl: 9, opened: '2026-03-01T04:00:00.000Z', buy: 'SIMULATED' }),
			pos({ mint: 'COIN_E', pnl: 9, opened: '2026-03-01T05:00:00.000Z', buy: 'SIMULATED' }),
		],
	};
	// Dave: withdrawn → excluded from the board entirely.
	const dave = {
		entry: { agent_id: 'dave', agent_name: 'Dave', status: 'withdrawn', wallet: 'WALLETdave' },
		positions: [pos({ mint: 'COIN_F', pnl: 100, opened: '2026-03-01T04:30:00.000Z' })],
	};

	it('ranks by realized PnL, excludes withdrawn, flags eligibility honestly', () => {
		const { standings } = computeStandings(tournament, [alice, bob, carol, dave], { now: Date.parse(AFTER_END) });
		// Dave (withdrawn) is gone.
		expect(standings.find((s) => s.agent_id === 'dave')).toBeUndefined();
		// Bob (+5) ranks above Alice (+3) on realized_pnl, but Bob is ineligible.
		const bobRow = standings.find((s) => s.agent_id === 'bob');
		const aliceRow = standings.find((s) => s.agent_id === 'alice');
		const carolRow = standings.find((s) => s.agent_id === 'carol');
		expect(bobRow.rank).toBe(1);
		expect(bobRow.eligible).toBe(false);
		expect(bobRow.score_value).toBe(5);
		expect(aliceRow.rank).toBe(2);
		expect(aliceRow.eligible).toBe(true);
		expect(aliceRow.score_value).toBe(3);
		// Carol's paper trades don't count in a prize bracket.
		expect(carolRow.in_window_trades).toBe(0);
		expect(carolRow.eligible).toBe(false);
	});

	it('prize allocation skips the ineligible leader (Bob), pays the eligible Alice', () => {
		const { standings } = computeStandings(tournament, [alice, bob, carol], { now: Date.parse(AFTER_END) });
		const out = allocatePrizes(1_000_000n, [{ rank: 1, bps: 10000 }], standings);
		// Rank 1 is Bob, ineligible → nothing allocated at all.
		expect(out.size).toBe(0);
		// But a structure paying rank 2 reaches eligible Alice.
		const out2 = allocatePrizes(1_000_000n, [{ rank: 2, bps: 5000 }], standings);
		expect(out2.get('alice')).toBe(500_000n);
	});

	// Idle: entered the bracket and never opened a thing. Realized P&L of exactly 0.
	const idle = {
		entry: { agent_id: 'idle', agent_name: 'Idle', status: 'active', wallet: 'WALLETidle' },
		positions: [],
	};
	// Loser: two real in-window trades that both went against it, so it is eligible
	// for prizes but its realized P&L is negative.
	const loser = {
		entry: { agent_id: 'loser', agent_name: 'Loser', status: 'active', wallet: 'WALLETloser' },
		positions: [
			pos({ mint: 'COIN_G', pnl: -0.4, opened: '2026-03-01T07:00:00.000Z' }),
			pos({ mint: 'COIN_H', pnl: -0.2, opened: '2026-03-01T08:00:00.000Z' }),
		],
	};

	it('ranks an agent who actually traded above an idle entrant with a clean zero', () => {
		const { standings } = computeStandings(tournament, [idle, loser], { now: Date.parse(AFTER_END) });
		const idleRow = standings.find((s) => s.agent_id === 'idle');
		const loserRow = standings.find((s) => s.agent_id === 'loser');
		// On raw realized P&L the idle entrant's 0 beats the loser's -0.6, but it
		// produced no result, so it sorts last.
		expect(loserRow.score_value).toBeLessThan(idleRow.score_value);
		expect(loserRow.rank).toBe(1);
		expect(idleRow.rank).toBe(2);
		expect(idleRow.in_window_trades).toBe(0);
	});

	it('hands the prize to the trader, not to the idle entrant sitting on zero', () => {
		const { standings } = computeStandings(tournament, [idle, loser], { now: Date.parse(AFTER_END) });
		const out = allocatePrizes(1_000_000n, [{ rank: 1, bps: 10000 }], standings);
		expect(out.get('loser')).toBe(1_000_000n);
		expect(out.get('idle')).toBeUndefined();
	});

	it('keeps idle entrants below traders without disturbing the traders’ own order', () => {
		const { standings } = computeStandings(tournament, [carol, bob, idle, alice], { now: Date.parse(AFTER_END) });
		// Bob (+5) then Alice (+3) as before; Carol and Idle both closed nothing.
		expect(standings.map((s) => s.agent_id).slice(0, 2)).toEqual(['bob', 'alice']);
		expect(standings.slice(2).map((s) => s.in_window_trades)).toEqual([0, 0]);
	});

	it('a practice bracket counts paper trades and ranks everyone, prizes nobody', () => {
		const practice = { ...tournament, bracket: 'practice' };
		const { standings } = computeStandings(practice, [carol], { now: Date.parse(AFTER_END) });
		const carolRow = standings.find((s) => s.agent_id === 'carol');
		expect(carolRow.in_window_trades).toBe(2); // paper trades now count
		expect(carolRow.eligible).toBe(false); // but never prize-eligible
	});
});
