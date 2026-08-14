/**
 * Ghost-copy simulator, pure logic tests.
 *
 * The number this module produces is the one a visitor decides to trade on, so
 * every arithmetic path is pinned: sizing, the cash constraint, daily budget,
 * concurrency, the equity curve, drawdown, unrealized marks, and the honesty
 * block. A ghost result that flatters the leader is worse than no result.
 */

import { describe, it, expect } from 'vitest';
import {
	buildGhostSubscription,
	simulateGhostCopy,
	normalizeLeaderTrades,
	downsampleCurve,
	maxDrawdownPct,
} from '../api/_lib/ghost-copy.js';

const LAM = 1e9;

/** A closed round-trip: entry SOL in, pnl pct out. */
function trade(id, { entry = 1, pnlPct = 0, open = '2026-07-01T00:00:00.000Z', close = '2026-07-01T01:00:00.000Z', symbol = 'TICKER', status = 'closed' } = {}) {
	return {
		id: String(id),
		mint: `MINT${id}`,
		symbol,
		name: null,
		status,
		entry_sol: entry,
		pnl_pct: pnlPct,
		mark_pct: null,
		opened_at: open,
		closed_at: status === 'closed' ? close : null,
		exit_reason: status === 'closed' ? 'take_profit' : null,
		buy_sig: `buy${id}`,
		sell_sig: status === 'closed' ? `sell${id}` : null,
		coin: null,
	};
}

function ghost(budget, overrides = {}) {
	const built = buildGhostSubscription({ budgetSol: budget, ...overrides });
	expect(built.ok).toBe(true);
	return built.value;
}

describe('buildGhostSubscription', () => {
	it('derives every guard from the budget alone', () => {
		const { ok, value } = buildGhostSubscription({ budgetSol: 1 });
		expect(ok).toBe(true);
		expect(value.status).toBe('active');
		expect(value.sizing_rule).toBe('fixed');
		expect(value.fixed_sol).toBeCloseTo(0.1, 9);      // ten slices
		expect(value.per_trade_cap_sol).toBeCloseTo(0.25, 9); // never a quarter in one trade
		expect(value.daily_budget_sol).toBeCloseTo(1, 9);
		expect(value.max_open_copies).toBe(5);
	});

	it('never accrues a performance fee, because nothing was earned', () => {
		expect(buildGhostSubscription({ budgetSol: 5 }).value.perf_fee_bps).toBe(0);
	});

	it('rejects a non-positive budget instead of guessing one', () => {
		expect(buildGhostSubscription({ budgetSol: 0 }).ok).toBe(false);
		expect(buildGhostSubscription({ budgetSol: -1 }).ok).toBe(false);
		expect(buildGhostSubscription({}).ok).toBe(false);
	});

	it('rejects an unrecognized sizing rule instead of silently replaying a different one', () => {
		// A caller asking for a rule we do not have used to get a `fixed` replay
		// with no signal that the request was dropped, which makes the whole
		// simulation answer a question nobody asked.
		const bad = buildGhostSubscription({ budgetSol: 1, sizing_rule: 'martingale' });
		expect(bad.ok).toBe(false);
		expect(bad.error).toMatch(/fixed.*multiplier/);
		// The two real rules, and the absent-means-default case, still pass.
		expect(buildGhostSubscription({ budgetSol: 1, sizing_rule: 'fixed' }).value.sizing_rule).toBe('fixed');
		expect(buildGhostSubscription({ budgetSol: 1, sizing_rule: 'multiplier' }).value.sizing_rule).toBe('multiplier');
		expect(buildGhostSubscription({ budgetSol: 1, sizing_rule: undefined }).value.sizing_rule).toBe('fixed');
	});

	it('honors explicit overrides over the derived defaults', () => {
		const { value } = buildGhostSubscription({ budgetSol: 2, fixed_sol: 0.05, max_open_copies: 2 });
		expect(value.fixed_sol).toBe(0.05);
		expect(value.max_open_copies).toBe(2);
	});

	it('surfaces the copy-engine validation error rather than silently clamping', () => {
		const res = buildGhostSubscription({ budgetSol: 1, min_order_sol: 5, per_trade_cap_sol: 0.1 });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/min_order_sol/);
	});

	it('supports multiplier sizing off the leader entry', () => {
		const sub = ghost(10, { sizing_rule: 'multiplier', multiplier: 0.5 });
		const out = simulateGhostCopy({
			trades: [trade(1, { entry: 4, pnlPct: 0 })],
			budgetSol: 10,
			subscription: sub,
		});
		// 4 SOL leader entry x 0.5 = 2, under the 2.5 cap.
		expect(out.fills[0].order_sol).toBeCloseTo(2, 9);
	});
});

describe('simulateGhostCopy', () => {
	it('compounds a winner and reports the realized headline', () => {
		const out = simulateGhostCopy({
			trades: [trade(1, { entry: 1, pnlPct: 100 })],
			budgetSol: 1,
			subscription: ghost(1),
		});
		expect(out.fills).toHaveLength(1);
		expect(out.fills[0].order_sol).toBeCloseTo(0.1, 9);
		expect(out.fills[0].pnl_sol).toBeCloseTo(0.1, 9);
		expect(out.fills[0].multiple).toBe(2);
		expect(out.summary.end_sol).toBeCloseTo(1.1, 9);
		expect(out.summary.realized_pnl_sol).toBeCloseTo(0.1, 9);
		expect(out.summary.realized_pnl_pct).toBeCloseTo(10, 6);
		expect(out.summary.win_rate_pct).toBe(100);
	});

	it('counts losses, never hides them', () => {
		const out = simulateGhostCopy({
			trades: [
				trade(1, { pnlPct: -50, open: '2026-07-01T00:00:00.000Z', close: '2026-07-01T00:30:00.000Z' }),
				trade(2, { pnlPct: -100, open: '2026-07-01T01:00:00.000Z', close: '2026-07-01T01:30:00.000Z' }),
			],
			budgetSol: 1,
			subscription: ghost(1),
		});
		expect(out.summary.wins).toBe(0);
		expect(out.summary.losses).toBe(2);
		expect(out.summary.win_rate_pct).toBe(0);
		// 0.1 lost half, 0.1 lost entirely.
		expect(out.summary.realized_pnl_sol).toBeCloseTo(-0.15, 9);
		expect(out.summary.end_sol).toBeCloseTo(0.85, 9);
	});

	it('locks capital while a copy is open and reports the skip when cash runs out', () => {
		// Five concurrent 0.25 SOL copies exhaust a 1 SOL wallet; the sixth cannot fill.
		const trades = [];
		for (let i = 1; i <= 6; i++) {
			trades.push(trade(i, {
				entry: 1,
				pnlPct: 0,
				open: `2026-07-01T00:0${i}:00.000Z`,
				close: '2026-07-02T00:00:00.000Z',
			}));
		}
		const out = simulateGhostCopy({
			trades,
			budgetSol: 1,
			// Daily budget lifted out of the way so the CASH constraint is the one
			// under test, not the per-day cap.
			subscription: ghost(1, { fixed_sol: 0.25, max_open_copies: 10, daily_budget_sol: 100 }),
		});
		expect(out.fills).toHaveLength(4);
		const cashSkips = out.skipped.filter((s) => s.reason === 'ghost_cash_locked');
		expect(cashSkips.length).toBe(2);
		expect(cashSkips[0].detail).toMatch(/locked in open copies/);
	});

	it('enforces the concurrent-copy cap through the production copy engine', () => {
		const trades = [];
		for (let i = 1; i <= 5; i++) {
			trades.push(trade(i, { entry: 1, open: `2026-07-01T00:0${i}:00.000Z`, close: '2026-07-09T00:00:00.000Z' }));
		}
		const out = simulateGhostCopy({
			trades,
			budgetSol: 100,
			subscription: ghost(100, { fixed_sol: 1, max_open_copies: 2 }),
		});
		expect(out.fills.length + out.summary.still_open_count).toBe(2);
		expect(out.skipped.some((s) => s.reason === 'max_open_copies')).toBe(true);
	});

	it('applies the daily budget per UTC day and resets the next day', () => {
		const out = simulateGhostCopy({
			trades: [
				trade(1, { entry: 1, pnlPct: 0, open: '2026-07-01T01:00:00.000Z', close: '2026-07-01T02:00:00.000Z' }),
				trade(2, { entry: 1, pnlPct: 0, open: '2026-07-01T03:00:00.000Z', close: '2026-07-01T04:00:00.000Z' }),
				trade(3, { entry: 1, pnlPct: 0, open: '2026-07-02T01:00:00.000Z', close: '2026-07-02T02:00:00.000Z' }),
			],
			budgetSol: 10,
			subscription: ghost(10, { fixed_sol: 1, daily_budget_sol: 1 }),
		});
		expect(out.fills).toHaveLength(2); // one on day 1, one on day 2
		expect(out.skipped.some((s) => s.reason === 'daily_budget_spent')).toBe(true);
	});

	it('marks still-open positions at the leader last quote, outside the realized headline', () => {
		const t = trade(1, { entry: 1, status: 'open' });
		t.mark_pct = 40;
		const out = simulateGhostCopy({ trades: [t], budgetSol: 1, subscription: ghost(1) });

		expect(out.summary.copied).toBe(0);
		expect(out.summary.realized_pnl_sol).toBe(0);
		expect(out.summary.still_open_count).toBe(1);
		expect(out.summary.unrealized_pnl_sol).toBeCloseTo(0.04, 9);
		expect(out.summary.mark_to_market_sol).toBeCloseTo(1.04, 9);
		expect(out.still_open[0].marked).toBe('leader_last_quote');
	});

	it('falls back to cost basis when the leader has no live mark', () => {
		const out = simulateGhostCopy({ trades: [trade(1, { entry: 1, status: 'open' })], budgetSol: 1, subscription: ghost(1) });
		expect(out.still_open[0].marked).toBe('cost');
		expect(out.summary.unrealized_pnl_sol).toBe(0);
	});

	it('settles a close before a same-instant open so freed cash is reusable', () => {
		const ts = '2026-07-01T00:00:00.000Z';
		const out = simulateGhostCopy({
			trades: [
				{ ...trade(1, { entry: 1, pnlPct: 0 }), opened_at: '2026-06-30T00:00:00.000Z', closed_at: ts },
				trade(2, { entry: 1, pnlPct: 0, open: ts, close: '2026-07-01T02:00:00.000Z' }),
			],
			budgetSol: 1,
			subscription: ghost(1, { fixed_sol: 1 }),
		});
		expect(out.fills).toHaveLength(2);
		expect(out.skipped).toHaveLength(0);
	});

	it('ignores a close for a trade the ghost never entered', () => {
		const out = simulateGhostCopy({
			trades: [trade(1, { entry: 1, pnlPct: 500 })],
			budgetSol: 1,
			subscription: ghost(1, { fixed_sol: 0.5, per_trade_cap_sol: 0.5, min_order_sol: 0.4, daily_budget_sol: 0.2 }),
		});
		// The remaining daily budget clamps the order under the minimum, so nothing
		// is entered and the leader's 5x cannot leak into the ghost's P&L.
		expect(out.fills).toHaveLength(0);
		expect(out.summary.realized_pnl_sol).toBe(0);
		expect(out.skipped[0].reason).toBe('below_min_order');
	});

	it('builds an equity curve anchored at the first event and stepping on each close', () => {
		const out = simulateGhostCopy({
			trades: [
				trade(1, { pnlPct: 100, open: '2026-07-01T00:00:00.000Z', close: '2026-07-01T01:00:00.000Z' }),
				trade(2, { pnlPct: -50, open: '2026-07-01T02:00:00.000Z', close: '2026-07-01T03:00:00.000Z' }),
			],
			budgetSol: 1,
			subscription: ghost(1),
		});
		expect(out.equity_curve).toHaveLength(3);
		expect(out.equity_curve[0].t).toBe('2026-07-01T00:00:00.000Z');
		expect(out.equity_curve[0].equity_sol).toBe(1);
		expect(out.equity_curve[1].equity_sol).toBeCloseTo(1.1, 9);
		// Sizing is fixed at a tenth of the ORIGINAL budget, so the second copy is
		// 0.1 SOL again (not a tenth of the compounded 1.1).
		expect(out.equity_curve[2].equity_sol).toBeCloseTo(1.05, 9);
	});

	it('reports an empty, honest result for a leader with no trades', () => {
		const out = simulateGhostCopy({ trades: [], budgetSol: 1, subscription: ghost(1) });
		expect(out.fills).toHaveLength(0);
		expect(out.summary.copied).toBe(0);
		expect(out.summary.win_rate_pct).toBeNull();
		expect(out.summary.best).toBeNull();
		expect(out.summary.end_sol).toBe(1);
		expect(out.equity_curve[0].t).toBeNull();
	});

	it('always discloses that it is paper and that slippage is not modelled', () => {
		const out = simulateGhostCopy({ trades: [trade(1, { pnlPct: 20 })], budgetSol: 1, subscription: ghost(1) });
		expect(out.honesty.join(' ')).toMatch(/Paper only/);
		expect(out.honesty.join(' ')).toMatch(/slippage/);
		expect(out.honesty.join(' ')).toMatch(/do not predict/);
	});

	it('discloses the skipped trades in the honesty block when the budget blocked any', () => {
		const out = simulateGhostCopy({
			trades: [trade(1, { entry: 1 }), trade(2, { entry: 1, open: '2026-07-01T00:10:00.000Z', close: '2026-07-01T02:00:00.000Z' })],
			budgetSol: 1,
			subscription: ghost(1, { fixed_sol: 0.9, max_open_copies: 1 }),
		});
		expect(out.summary.skipped_count).toBeGreaterThan(0);
		expect(out.honesty.join(' ')).toMatch(/were NOT copied/);
	});
});

describe('normalizeLeaderTrades', () => {
	it('derives the percentage from exact chain lamports, not the stored column', () => {
		const { trades } = normalizeLeaderTrades([{
			id: 1, mint: 'M', symbol: 'T', status: 'closed',
			entry_quote_lamports: 2 * LAM,
			realized_pnl_lamports: 1 * LAM,
			realized_pnl_pct: 999,            // a drifted stored value must not win
			opened_at: '2026-07-01T00:00:00.000Z', closed_at: '2026-07-01T01:00:00.000Z',
		}]);
		expect(trades).toHaveLength(1);
		expect(trades[0].pnl_pct).toBeCloseTo(50, 9);
	});

	it('falls back to the stored percentage only when P&L lamports are absent', () => {
		const { trades } = normalizeLeaderTrades([{
			id: 1, mint: 'M', status: 'closed',
			entry_quote_lamports: 1 * LAM, realized_pnl_lamports: null, realized_pnl_pct: 25,
			opened_at: '2026-07-01T00:00:00.000Z', closed_at: '2026-07-01T01:00:00.000Z',
		}]);
		expect(trades[0].pnl_pct).toBe(25);
	});

	it('drops unpriceable rows and counts them rather than guessing', () => {
		const { trades, unpriced } = normalizeLeaderTrades([
			{ id: 1, mint: 'A', status: 'closed', entry_quote_lamports: null, opened_at: '2026-07-01T00:00:00.000Z' },
			{ id: 2, mint: 'B', status: 'closed', entry_quote_lamports: 0, opened_at: '2026-07-01T00:00:00.000Z' },
			{ id: 3, mint: 'C', status: 'closed', entry_quote_lamports: LAM, realized_pnl_lamports: null, realized_pnl_pct: null, opened_at: '2026-07-01T00:00:00.000Z' },
		]);
		expect(trades).toHaveLength(0);
		expect(unpriced).toBe(3);
	});

	it('computes the open-position mark from the last on-chain quote', () => {
		const { trades } = normalizeLeaderTrades([{
			id: 1, mint: 'M', status: 'open',
			entry_quote_lamports: 1 * LAM, last_value_lamports: 1.5 * LAM,
			opened_at: '2026-07-01T00:00:00.000Z',
		}]);
		expect(trades[0].mark_pct).toBeCloseTo(50, 9);
	});

	it('sorts oldest first so the replay is chronological regardless of query order', () => {
		const { trades } = normalizeLeaderTrades([
			{ id: 2, mint: 'B', status: 'closed', entry_quote_lamports: LAM, realized_pnl_lamports: 0, opened_at: '2026-07-05T00:00:00.000Z', closed_at: '2026-07-05T01:00:00.000Z' },
			{ id: 1, mint: 'A', status: 'closed', entry_quote_lamports: LAM, realized_pnl_lamports: 0, opened_at: '2026-07-01T00:00:00.000Z', closed_at: '2026-07-01T01:00:00.000Z' },
		]);
		expect(trades.map((t) => t.id)).toEqual(['1', '2']);
	});
});

describe('curve helpers', () => {
	it('measures peak-to-trough drawdown as a pct of the running peak', () => {
		expect(maxDrawdownPct([
			{ equity_sol: 1 }, { equity_sol: 2 }, { equity_sol: 1.5 }, { equity_sol: 1.8 },
		])).toBe(25);
	});

	it('reports zero drawdown for a monotonically rising curve', () => {
		expect(maxDrawdownPct([{ equity_sol: 1 }, { equity_sol: 1.2 }, { equity_sol: 1.4 }])).toBe(0);
	});

	it('downsamples while keeping the exact first and last points', () => {
		const curve = Array.from({ length: 400 }, (_, i) => ({ t: `t${i}`, equity_sol: i }));
		const out = downsampleCurve(curve, 50);
		expect(out).toHaveLength(50);
		expect(out[0]).toBe(curve[0]);
		expect(out[out.length - 1]).toBe(curve[curve.length - 1]);
	});

	it('leaves a short curve untouched', () => {
		const curve = [{ equity_sol: 1 }, { equity_sol: 2 }];
		expect(downsampleCurve(curve, 50)).toBe(curve);
	});
});
