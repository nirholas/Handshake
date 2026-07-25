/**
 * Trader track-record truth layer — pure-metric tests.
 *
 * Every assertion is hand-computed from the fixture below so the math can never
 * silently drift. computeTraderMetrics is pure (no DB, no network), so these run
 * fast and deterministically.
 */

import { describe, it, expect } from 'vitest';
import { computeTraderMetrics, windowStartIso, WINDOWS } from '../api/_lib/trader-stats.js';

const SOL = 1e9; // lamports per SOL

// Four closed positions + one open. Ordered so the equity curve has a clear,
// hand-checkable drawdown: +2 → +1.5 (−0.5 from peak 2 = 25%) → +2.0 → +2.01.
const FIXTURE = [
	// closed: A +2 SOL (+200%), 120s hold
	{
		status: 'closed', mint: 'AAAA', symbol: 'A', realized_pnl_lamports: String(2 * SOL),
		realized_pnl_pct: 200, entry_quote_lamports: String(1 * SOL), exit_quote_lamports: String(3 * SOL),
		opened_at: '2026-01-01T00:00:00.000Z', closed_at: '2026-01-01T00:02:00.000Z', buy_sig: 'b1', sell_sig: 's1',
	},
	// closed: B −0.5 SOL (−50%), 300s hold (the loser — never hidden)
	{
		status: 'closed', mint: 'BBBB', symbol: 'B', realized_pnl_lamports: String(-0.5 * SOL),
		realized_pnl_pct: -50, entry_quote_lamports: String(1 * SOL), exit_quote_lamports: String(0.5 * SOL),
		opened_at: '2026-01-01T00:03:00.000Z', closed_at: '2026-01-01T00:08:00.000Z', buy_sig: 'b2', sell_sig: 's2',
	},
	// closed: C +0.5 SOL (+50%), 60s hold
	{
		status: 'closed', mint: 'CCCC', symbol: 'C', realized_pnl_lamports: String(0.5 * SOL),
		realized_pnl_pct: 50, entry_quote_lamports: String(1 * SOL), exit_quote_lamports: String(1.5 * SOL),
		opened_at: '2026-01-01T00:09:00.000Z', closed_at: '2026-01-01T00:10:00.000Z', buy_sig: 'b3', sell_sig: 's3',
	},
	// closed: D +0.01 SOL (+1%), 10s hold → churn (fast in-and-out, near-flat)
	{
		status: 'closed', mint: 'DDDD', symbol: 'D', realized_pnl_lamports: String(0.01 * SOL),
		realized_pnl_pct: 1, entry_quote_lamports: String(1 * SOL), exit_quote_lamports: String(1.01 * SOL),
		opened_at: '2026-01-01T00:11:00.000Z', closed_at: '2026-01-01T00:11:10.000Z', buy_sig: 'b4', sell_sig: 's4',
	},
	// open: E, entry 1 SOL, now worth 1.5 SOL → +0.5 SOL unrealized
	{
		status: 'open', mint: 'EEEE', symbol: 'E', entry_quote_lamports: String(1 * SOL),
		last_value_lamports: String(1.5 * SOL), opened_at: '2026-01-01T00:15:00.000Z', buy_sig: 'b5',
	},
];

describe('computeTraderMetrics', () => {
	const m = computeTraderMetrics(FIXTURE, { solUsd: 200 });

	it('counts closed and open positions separately', () => {
		expect(m.closed_count).toBe(4);
		expect(m.open_count).toBe(1);
	});

	it('computes wins, losses, and win rate', () => {
		expect(m.wins).toBe(3);
		expect(m.losses).toBe(1);
		expect(m.win_rate).toBe(0.75);
	});

	it('sums realized P&L exactly in SOL and prices it to USD', () => {
		// 2 − 0.5 + 0.5 + 0.01 = 2.01 SOL
		expect(m.realized_pnl_sol).toBeCloseTo(2.01, 6);
		expect(m.realized_pnl_usd).toBeCloseTo(402, 2); // 2.01 × 200
	});

	it('tracks open exposure and unrealized P&L', () => {
		expect(m.open_exposure_sol).toBeCloseTo(1, 6);
		expect(m.unrealized_pnl_sol).toBeCloseTo(0.5, 6);
		expect(m.unrealized_pnl_usd).toBeCloseTo(100, 2);
	});

	it('computes profit factor (gross profit / gross loss)', () => {
		// (2 + 0.5 + 0.01) / 0.5 = 5.02
		expect(m.profit_factor).toBeCloseTo(5.02, 2);
	});

	it('computes ROI against invested capital', () => {
		// 2.01 / 4 × 100 = 50.25%
		expect(m.roi_pct).toBeCloseTo(50.25, 1);
	});

	it('reports best/worst/avg trade pct', () => {
		expect(m.best_pnl_pct).toBe(200);
		expect(m.worst_pnl_pct).toBe(-50);
		expect(m.avg_pnl_pct).toBeCloseTo(50.25, 1); // (200 − 50 + 50 + 1) / 4
	});

	it('computes max drawdown from the realized equity curve', () => {
		// peak +2, trough +1.5 → 0.5 SOL drop = 25% of peak
		expect(m.max_drawdown_sol).toBeCloseTo(0.5, 6);
		expect(m.max_drawdown_pct).toBeCloseTo(25, 5);
	});

	it('computes hold-time stats', () => {
		expect(m.avg_hold_seconds).toBe(123); // (120+300+60+10)/4 = 122.5 → 123
		expect(m.median_hold_seconds).toBe(90); // sorted [10,60,120,300] → (60+120)/2
	});

	it('counts unique coins and flags churn heuristically', () => {
		expect(m.unique_coins).toBe(4);
		expect(m.churn_pct).toBeCloseTo(25, 5); // 1 of 4 closed is churn
	});

	it('does NOT grant the verified badge below the trade threshold', () => {
		expect(m.verified).toBe(false); // only 4 closed, badge needs >= 12
	});

	it('produces a bounded composite score', () => {
		expect(m.score).toBeGreaterThan(0);
		expect(m.score).toBeLessThanOrEqual(100);
	});

	it('records first/last active timestamps', () => {
		expect(m.first_active_at).toBe('2026-01-01T00:00:00.000Z');
		expect(m.last_active_at).toBe('2026-01-01T00:15:00.000Z'); // open E opened latest
	});

	it('surfaces the top-earning coin ("what they made it on")', () => {
		// A made the most: +2 SOL on 1 SOL invested → +200% ROI, priced to USD.
		expect(m.top_coin).toMatchObject({
			mint: 'AAAA', symbol: 'A', pnl_sol: 2, roi_pct: 200, trades: 1, wins: 1,
		});
		expect(m.top_coin.pnl_usd).toBeCloseTo(400, 2); // 2 × 200
	});

	it('ranks the per-coin breakdown best-first, losers included', () => {
		// Best→worst: A (+2), C (+0.5), D (+0.01) — B (−0.5) falls outside the top 3.
		expect(m.top_coins.map((c) => c.symbol)).toEqual(['A', 'C', 'D']);
		expect(m.top_coins[0].pnl_sol).toBe(2);
	});
});

describe('computeTraderMetrics — degenerate inputs', () => {
	it('handles an empty book without throwing and regresses score to neutral', () => {
		const m = computeTraderMetrics([], { solUsd: 200 });
		expect(m.closed_count).toBe(0);
		expect(m.open_count).toBe(0);
		expect(m.win_rate).toBe(0);
		expect(m.realized_pnl_sol).toBe(0);
		expect(m.realized_pnl_usd).toBe(0);
		expect(m.verified).toBe(false);
		expect(m.score).toBe(42); // confidence 0 → fully regressed to NEUTRAL_RAW
		expect(m.top_coin).toBeNull(); // no closed positions → no coin to credit
		expect(m.top_coins).toEqual([]);
	});

	it('omits USD fields when no SOL price is available', () => {
		const m = computeTraderMetrics(FIXTURE, { solUsd: null });
		expect(m.realized_pnl_sol).toBeCloseTo(2.01, 6); // SOL stays exact
		expect(m.realized_pnl_usd).toBeNull();
		expect(m.unrealized_pnl_usd).toBeNull();
	});

	it('handles an all-losses book (zero gross profit → profit factor 0)', () => {
		const losses = [
			{ status: 'closed', mint: 'X', realized_pnl_lamports: String(-1 * SOL), realized_pnl_pct: -40,
			  entry_quote_lamports: String(1 * SOL), opened_at: '2026-01-01T00:00:00Z', closed_at: '2026-01-01T00:05:00Z' },
		];
		const m = computeTraderMetrics(losses, { solUsd: 200 });
		expect(m.wins).toBe(0);
		expect(m.win_rate).toBe(0);
		expect(m.profit_factor).toBe(0);
		expect(m.realized_pnl_sol).toBeCloseTo(-1, 6);
	});
});

describe('computeTraderMetrics — self-dealing exclusion (anti-gaming)', () => {
	// Two honest trades + two fat round-trips on the trader's OWN coins. A faker
	// would pump SELF1/SELF2 and post a 100% win rate; the credited record must not.
	const BOOK = [
		{ status: 'closed', mint: 'AAAA', realized_pnl_lamports: String(2 * SOL), realized_pnl_pct: 200,
		  entry_quote_lamports: String(1 * SOL), opened_at: '2026-01-01T00:00:00Z', closed_at: '2026-01-01T00:02:00Z' },
		{ status: 'closed', mint: 'BBBB', realized_pnl_lamports: String(-0.5 * SOL), realized_pnl_pct: -50,
		  entry_quote_lamports: String(1 * SOL), opened_at: '2026-01-01T00:03:00Z', closed_at: '2026-01-01T00:08:00Z' },
		{ status: 'closed', mint: 'SELF1', realized_pnl_lamports: String(10 * SOL), realized_pnl_pct: 1000,
		  entry_quote_lamports: String(1 * SOL), opened_at: '2026-01-01T00:09:00Z', closed_at: '2026-01-01T00:10:00Z' },
		{ status: 'closed', mint: 'SELF2', realized_pnl_lamports: String(5 * SOL), realized_pnl_pct: 500,
		  entry_quote_lamports: String(1 * SOL), opened_at: '2026-01-01T00:11:00Z', closed_at: '2026-01-01T00:12:00Z' },
	];
	const selfDealMints = new Set(['SELF1', 'SELF2']);

	it('credits NOTHING from self-dealt coins — score reflects only honest trades', () => {
		const m = computeTraderMetrics(BOOK, { solUsd: 200, selfDealMints });
		expect(m.closed_count).toBe(2); // SELF1/SELF2 split out
		expect(m.wins).toBe(1);
		expect(m.losses).toBe(1);
		expect(m.win_rate).toBe(0.5); // NOT 1.0
		expect(m.realized_pnl_sol).toBeCloseTo(1.5, 6); // 2 − 0.5, the 15 SOL of self-deals excluded
		expect(m.unique_coins).toBe(2);
	});

	it('reports the excluded self-dealing total transparently', () => {
		const m = computeTraderMetrics(BOOK, { solUsd: 200, selfDealMints });
		expect(m.self_dealing_count).toBe(2);
		expect(m.self_dealing_excluded_pnl_sol).toBeCloseTo(15, 6);
		expect(m.self_dealing_excluded_pnl_usd).toBeCloseTo(3000, 2); // 15 × 200
	});

	it('excludes self-dealt coins from the top-coin breakdown', () => {
		const m = computeTraderMetrics(BOOK, { solUsd: 200, selfDealMints });
		// SELF1 (+10) would top the board if credited — the honest top coin is AAAA (+2).
		expect(m.top_coin.mint).toBe('AAAA');
		expect(m.top_coins.map((c) => c.mint)).toEqual(['AAAA', 'BBBB']);
	});

	it('accepts a plain object as well as a Set for selfDealMints', () => {
		const m = computeTraderMetrics(BOOK, { selfDealMints: { SELF1: true, SELF2: true } });
		expect(m.closed_count).toBe(2);
		expect(m.self_dealing_count).toBe(2);
	});

	it('credits every position when no self-deal evidence is supplied (legacy)', () => {
		const m = computeTraderMetrics(BOOK, { solUsd: 200 });
		expect(m.closed_count).toBe(4);
		expect(m.win_rate).toBe(0.75);
		expect(m.realized_pnl_sol).toBeCloseTo(16.5, 6);
		expect(m.self_dealing_count).toBe(0);
		expect(m.self_dealing_excluded_pnl_sol).toBe(0);
	});
});

describe('computeTraderMetrics — snipe hit-rate', () => {
	// Same launch time for A/B/C; D has no proven birth. A & C enter inside the
	// 5-min window (A wins, C loses); B enters 10 min later (not a snipe).
	const LAUNCH = '2026-01-01T00:00:00.000Z';
	const BOOK = [
		{ status: 'closed', mint: 'A', realized_pnl_lamports: String(2 * SOL), realized_pnl_pct: 200,
		  entry_quote_lamports: String(1 * SOL), opened_at: '2026-01-01T00:00:30Z', closed_at: '2026-01-01T00:02:00Z' },
		{ status: 'closed', mint: 'B', realized_pnl_lamports: String(1 * SOL), realized_pnl_pct: 100,
		  entry_quote_lamports: String(1 * SOL), opened_at: '2026-01-01T00:10:00Z', closed_at: '2026-01-01T00:12:00Z' },
		{ status: 'closed', mint: 'C', realized_pnl_lamports: String(-0.5 * SOL), realized_pnl_pct: -50,
		  entry_quote_lamports: String(1 * SOL), opened_at: '2026-01-01T00:01:00Z', closed_at: '2026-01-01T00:03:00Z' },
		{ status: 'closed', mint: 'D', realized_pnl_lamports: String(0.3 * SOL), realized_pnl_pct: 30,
		  entry_quote_lamports: String(1 * SOL), opened_at: '2026-01-01T00:00:10Z', closed_at: '2026-01-01T00:05:00Z' },
	];
	const mintCreatedAt = { A: LAUNCH, B: LAUNCH, C: LAUNCH }; // D unknown on purpose

	it('counts only entries inside the snipe window, scoped to proven launches', () => {
		const m = computeTraderMetrics(BOOK, { mintCreatedAt });
		expect(m.snipe_sample).toBe(3); // A, B, C have a known birth; D does not
		expect(m.snipe_count).toBe(2); // A and C are inside 5 min; B is 10 min out
		expect(m.snipe_wins).toBe(1); // A won, C lost
		expect(m.snipe_hit_rate).toBe(0.5);
	});

	it('tolerates small negative clock skew between open time and block time', () => {
		const m = computeTraderMetrics(
			[{ status: 'closed', mint: 'A', realized_pnl_lamports: String(1 * SOL), realized_pnl_pct: 100,
			   entry_quote_lamports: String(1 * SOL), opened_at: '2025-12-31T23:59:58Z', closed_at: '2026-01-01T00:01:00Z' }],
			{ mintCreatedAt: { A: LAUNCH } }, // opened 2s "before" launch
		);
		expect(m.snipe_count).toBe(1);
		expect(m.snipe_hit_rate).toBe(1);
	});

	it('returns a null hit-rate (not a fake zero) when no launch times are known', () => {
		const m = computeTraderMetrics(BOOK, {});
		expect(m.snipe_sample).toBe(0);
		expect(m.snipe_count).toBe(0);
		expect(m.snipe_hit_rate).toBeNull();
	});

	it('excludes self-dealt coins from the snipe sample too', () => {
		const m = computeTraderMetrics(BOOK, { mintCreatedAt, selfDealMints: new Set(['A']) });
		expect(m.snipe_sample).toBe(2); // A removed before snipe accounting
		expect(m.snipe_count).toBe(1); // only C remains in-window
		expect(m.snipe_wins).toBe(0);
		expect(m.snipe_hit_rate).toBe(0);
	});
});

// A trader who earns their record through Strategy Objects is exactly as proven
// as a sniper — the DB layer aliases agent_strategy_positions into this same
// canonical shape (entry_lamports→entry_quote_lamports, exit_sig→sell_sig, …).
// This pins that a normalized strategy record is first-class toward verification,
// so the unified truth layer can never quietly drop a whole real trading surface.
describe('strategy-origin records earn the same verified badge', () => {
	const COINS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'];
	// 12 real round-trips across 6 distinct coins, net-positive, no churn — the
	// canonical shape produced after aliasing strategy position rows.
	const strategyRecord = COINS.flatMap((mint, i) => [
		{
			status: 'closed', mint, symbol: mint, realized_pnl_lamports: String(0.4 * SOL),
			realized_pnl_pct: 40, entry_quote_lamports: String(1 * SOL), exit_quote_lamports: String(1.4 * SOL),
			opened_at: `2026-02-0${(i % 9) + 1}T00:00:00.000Z`, closed_at: `2026-02-0${(i % 9) + 1}T01:00:00.000Z`,
			buy_sig: `sb${i}a`, sell_sig: `ss${i}a`,
		},
		{
			status: 'closed', mint, symbol: mint, realized_pnl_lamports: String(0.1 * SOL),
			realized_pnl_pct: 10, entry_quote_lamports: String(1 * SOL), exit_quote_lamports: String(1.1 * SOL),
			opened_at: `2026-02-1${i % 9}T00:00:00.000Z`, closed_at: `2026-02-1${i % 9}T02:00:00.000Z`,
			buy_sig: `sb${i}b`, sell_sig: `ss${i}b`,
		},
	]);

	it('verifies a clean 12-trade, 6-coin, net-positive strategy record', () => {
		const m = computeTraderMetrics(strategyRecord);
		expect(m.closed_count).toBe(12);
		expect(m.unique_coins).toBe(6);
		expect(m.realized_pnl_sol).toBeGreaterThan(0);
		expect(m.churn_pct).toBe(0);
		expect(m.verified).toBe(true);
	});
});

describe('computeTraderMetrics — pnl_series (sparkline source)', () => {
	it('is the cumulative realized-equity curve, oldest→newest, ending at realized P&L', () => {
		const m = computeTraderMetrics(FIXTURE, { solUsd: 200 });
		// Closes ordered A(+2) → B(−0.5) → C(+0.5) → D(+0.01): cumulative 2, 1.5, 2, 2.01.
		expect(m.pnl_series).toEqual([2, 1.5, 2, 2.01]);
		// Endpoint must equal the headline realized P&L so the sparkline can't lie.
		expect(m.pnl_series[m.pnl_series.length - 1]).toBeCloseTo(m.realized_pnl_sol, 6);
	});

	it('is empty under two closed trades (renders the "no trend" placeholder)', () => {
		const one = computeTraderMetrics(
			[{ status: 'closed', mint: 'X', realized_pnl_lamports: String(SOL), realized_pnl_pct: 100,
			   entry_quote_lamports: String(SOL), opened_at: '2026-01-01T00:00:00.000Z', closed_at: '2026-01-01T00:01:00.000Z' }],
			{ solUsd: 200 },
		);
		expect(one.pnl_series).toEqual([]);
		expect(computeTraderMetrics([], { solUsd: 200 }).pnl_series).toEqual([]);
	});

	it('downsamples to at most 24 points while preserving the final equity', () => {
		const many = Array.from({ length: 60 }, (_, i) => ({
			status: 'closed', mint: `M${i}`, realized_pnl_lamports: String(0.1 * SOL), realized_pnl_pct: 10,
			entry_quote_lamports: String(SOL),
			opened_at: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
			closed_at: `2026-01-01T01:${String(i).padStart(2, '0')}:00.000Z`,
		}));
		const m = computeTraderMetrics(many, { solUsd: 200 });
		expect(m.pnl_series.length).toBeLessThanOrEqual(24);
		expect(m.pnl_series[m.pnl_series.length - 1]).toBeCloseTo(m.realized_pnl_sol, 4);
	});
});

describe('windowStartIso', () => {
	const NOW = Date.parse('2026-06-15T12:00:00.000Z');

	it('returns null for the all-time window', () => {
		expect(windowStartIso('all', NOW)).toBeNull();
	});

	it('computes the lower bound for 24h / 7d / 30d', () => {
		expect(windowStartIso('24h', NOW)).toBe(new Date(NOW - 86_400_000).toISOString());
		expect(windowStartIso('7d', NOW)).toBe(new Date(NOW - 604_800_000).toISOString());
		expect(windowStartIso('30d', NOW)).toBe(new Date(NOW - 2_592_000_000).toISOString());
	});

	it('exposes the supported window set', () => {
		expect([...WINDOWS].sort()).toEqual(['24h', '30d', '7d', 'all']);
	});
});

describe('moon-bag legibility (a closed row with a bag is NOT a 100% sell)', () => {
	const SOLL = 1e9;
	const bagged = {
		status: 'closed', mint: 'MOON', symbol: 'M', realized_pnl_lamports: String(1 * SOLL),
		realized_pnl_pct: 125, entry_quote_lamports: String(1 * SOLL), exit_quote_lamports: String(2 * SOLL),
		opened_at: '2026-01-02T00:00:00.000Z', closed_at: '2026-01-02T00:10:00.000Z', buy_sig: 'b9', sell_sig: 's9',
		moonbag_base_amount: '10224801450', moonbag_last_value_lamports: String(0.25 * SOLL), initials_recovered: true,
	};

	it('shapeClosed carries the held bag and its live value', async () => {
		const { shapeClosed } = await import('../api/_lib/trader-stats.js');
		const row = shapeClosed(bagged, 'mainnet');
		expect(row.moonbag_held).toBe(true);
		expect(row.moonbag_value_sol).toBeCloseTo(0.25);
	});

	it('shapeClosed reports no bag for a genuine full exit (and legacy rows)', async () => {
		const { shapeClosed } = await import('../api/_lib/trader-stats.js');
		expect(shapeClosed({ ...bagged, moonbag_base_amount: '0' }, 'mainnet').moonbag_held).toBe(false);
		expect(shapeClosed({ ...bagged, moonbag_base_amount: null, moonbag_last_value_lamports: null }, 'mainnet').moonbag_held).toBe(false);
	});

	it('metrics count bags held and sum their riding value', () => {
		const m = computeTraderMetrics([...FIXTURE, bagged], { solUsd: 200 });
		expect(m.moonbags_held).toBe(1);
		expect(m.moonbag_value_sol).toBeCloseTo(0.25);
	});

	it('a book with no bags reports zero, not null', () => {
		const m = computeTraderMetrics(FIXTURE, { solUsd: 200 });
		expect(m.moonbags_held).toBe(0);
		expect(m.moonbag_value_sol).toBe(0);
	});
});
