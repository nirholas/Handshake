/**
 * Trader Wrapped deck builder, pure logic tests.
 *
 * A recap is the artifact a trader posts publicly, so the thing worth pinning is
 * not that it renders but that it cannot flatter: the worst trade must survive,
 * a losing season must read as losing, a self-launched coin must never become
 * someone's signature win, and a slide with no evidence must be absent rather
 * than zero-filled.
 */

import { describe, it, expect } from 'vitest';
import { buildWrappedDeck, humanDuration } from '../api/_lib/wrapped.js';
import { computeTraderMetrics } from '../api/_lib/trader-stats.js';

const LAM = 1e9;

/** A closed round-trip row, in the shape both position ledgers normalize to. */
function pos(id, {
	entry = 1,
	pnlSol = 0,
	pnlPct = null,
	mint = `MINT${id}`,
	symbol = 'TICKER',
	open = '2026-07-01T00:00:00.000Z',
	close = '2026-07-01T01:00:00.000Z',
	status = 'closed',
} = {}) {
	return {
		id: String(id),
		mint,
		symbol,
		name: null,
		status,
		exit_reason: status === 'closed' ? 'take_profit' : null,
		entry_quote_lamports: String(Math.round(entry * LAM)),
		exit_quote_lamports: status === 'closed' ? String(Math.round((entry + pnlSol) * LAM)) : null,
		last_value_lamports: String(Math.round((entry + pnlSol) * LAM)),
		realized_pnl_lamports: status === 'closed' ? String(Math.round(pnlSol * LAM)) : null,
		realized_pnl_pct: status === 'closed' ? (pnlPct != null ? pnlPct : (pnlSol / entry) * 100) : null,
		buy_sig: `buy${id}`,
		sell_sig: status === 'closed' ? `sell${id}` : null,
		opened_at: open,
		closed_at: status === 'closed' ? close : null,
		moonbag_base_amount: null,
		moonbag_last_value_lamports: null,
		initials_recovered: null,
	};
}

/** Build the deck the way the endpoint does: metrics first, then slides. */
function deckOf(positions, ctx = {}) {
	const metrics = computeTraderMetrics(positions, { solUsd: ctx.solUsd ?? null, selfDealMints: ctx.selfDealMints ?? null });
	return {
		metrics,
		deck: buildWrappedDeck(positions, metrics, { window: '30d', agent: { name: 'Tester' }, ...ctx }),
	};
}

const kinds = (deck) => deck.slides.map((s) => s.kind);
const slide = (deck, kind) => deck.slides.find((s) => s.kind === kind);

describe('buildWrappedDeck', () => {
	it('assembles the full deck in reading order for a real season', () => {
		const positions = [
			pos(1, { entry: 1, pnlSol: 2 }),
			pos(2, { entry: 1, pnlSol: -0.5, mint: 'MINT2' }),
			pos(3, { entry: 1, pnlSol: 0.25, mint: 'MINT3' }),
		];
		const { deck } = deckOf(positions, { peers: { sample: 5, rank: 2, beat_pct: 75, min_closed: 3, rival: null } });
		expect(kinds(deck)).toEqual([
			'intro', 'scoreboard', 'best_trade', 'worst_trade', 'top_coins', 'rhythm', 'rank', 'receipt',
		]);
	});

	it('keeps the worst trade even when the season is green', () => {
		const positions = [
			pos(1, { entry: 1, pnlSol: 5 }),
			pos(2, { entry: 1, pnlSol: -0.4, mint: 'MINT2' }),
			pos(3, { entry: 1, pnlSol: 1, mint: 'MINT3' }),
		];
		const { deck } = deckOf(positions);
		const worst = slide(deck, 'worst_trade');
		expect(worst).toBeTruthy();
		expect(worst.trade.pnl_pct).toBeLessThan(0);
		expect(worst.trade.mint).toBe('MINT2');
	});

	it('calls a losing season red instead of spinning it', () => {
		const positions = [
			pos(1, { entry: 1, pnlSol: -0.6 }),
			pos(2, { entry: 1, pnlSol: -0.3, mint: 'MINT2' }),
			pos(3, { entry: 1, pnlSol: 0.1, mint: 'MINT3' }),
		];
		const { deck } = deckOf(positions);
		const score = slide(deck, 'scoreboard');
		expect(score.verdict).toBe('red');
		expect(score.realized_pnl_sol).toBeLessThan(0);
		expect(deck.headline).toContain('-0.80 SOL');
	});

	it('keeps small totals legible instead of rounding them to +0.00 SOL', () => {
		const positions = [
			pos(1, { entry: 0.05, pnlSol: 0.0004 }),
			pos(2, { entry: 0.05, pnlSol: 0.0002, mint: 'MINT2' }),
			pos(3, { entry: 0.05, pnlSol: 0.0002, mint: 'MINT3' }),
		];
		const { deck } = deckOf(positions);
		expect(deck.headline).not.toContain('+0.00 SOL');
		expect(deck.headline).toContain('+0.0008');
	});

	it('never lets a self-launched coin become the best trade', () => {
		const positions = [
			pos(1, { entry: 1, pnlSol: 20, mint: 'SELFMINT' }),
			pos(2, { entry: 1, pnlSol: 0.4, mint: 'MINT2' }),
			pos(3, { entry: 1, pnlSol: -0.2, mint: 'MINT3' }),
			pos(4, { entry: 1, pnlSol: 0.1, mint: 'MINT4' }),
		];
		const selfDealMints = new Set(['SELFMINT']);
		const { deck } = deckOf(positions, { selfDealMints });
		expect(slide(deck, 'best_trade').trade.mint).toBe('MINT2');
		expect(slide(deck, 'top_coins').top_coins.map((c) => c.mint)).not.toContain('SELFMINT');
		expect(slide(deck, 'receipt').self_dealing_count).toBe(1);
	});

	it('ranks a losing coin alongside the winners rather than hiding it', () => {
		const positions = [
			pos(1, { entry: 1, pnlSol: 1, mint: 'WINNER' }),
			pos(2, { entry: 1, pnlSol: -0.9, mint: 'LOSER' }),
			pos(3, { entry: 1, pnlSol: 0.2, mint: 'MIDDLE' }),
		];
		const { deck } = deckOf(positions);
		const top = slide(deck, 'top_coins');
		expect(top.top_coin.mint).toBe('WINNER');
		expect(top.top_coins.map((c) => c.mint)).toContain('LOSER');
	});

	it('drops the rank slide when the field is too small to mean anything', () => {
		const positions = [pos(1, { pnlSol: 1 }), pos(2, { pnlSol: 1, mint: 'MINT2' }), pos(3, { pnlSol: 1, mint: 'MINT3' })];
		expect(kinds(deckOf(positions, { peers: { sample: 1, rank: null, beat_pct: null, rival: null } }).deck)).not.toContain('rank');
		expect(kinds(deckOf(positions, { peers: null }).deck)).not.toContain('rank');
		expect(kinds(deckOf(positions, { peers: { sample: 4, rank: 1, beat_pct: 100, rival: null } }).deck)).toContain('rank');
	});

	it('omits the top-coins slide when no closed position carries a mint', () => {
		const positions = [
			pos(1, { pnlSol: 1, mint: null }),
			pos(2, { pnlSol: -0.2, mint: null }),
			pos(3, { pnlSol: 0.3, mint: null }),
		];
		const { deck } = deckOf(positions);
		expect(kinds(deck)).not.toContain('top_coins');
	});

	it('counts streaks, active days and the peak entry hour from real timestamps', () => {
		const positions = [
			pos(1, { pnlSol: 0.5, open: '2026-07-01T09:00:00.000Z', close: '2026-07-01T10:00:00.000Z' }),
			pos(2, { pnlSol: 0.5, mint: 'MINT2', open: '2026-07-01T09:30:00.000Z', close: '2026-07-01T11:00:00.000Z' }),
			pos(3, { pnlSol: -0.4, mint: 'MINT3', open: '2026-07-02T09:00:00.000Z', close: '2026-07-02T12:00:00.000Z' }),
			pos(4, { pnlSol: -0.4, mint: 'MINT4', open: '2026-07-02T14:00:00.000Z', close: '2026-07-02T15:00:00.000Z' }),
			pos(5, { pnlSol: -0.4, mint: 'MINT5', open: '2026-07-03T09:00:00.000Z', close: '2026-07-03T15:00:00.000Z' }),
		];
		const { deck } = deckOf(positions);
		const r = slide(deck, 'rhythm');
		expect(r.longest_win_streak).toBe(2);
		expect(r.longest_loss_streak).toBe(3);
		expect(r.active_days).toBe(3);
		expect(r.peak_hour.hour_utc).toBe(9);
		expect(r.best_day.day).toBe('2026-07-01');
		expect(r.worst_day.day).toBe('2026-07-02');
		expect(r.longest_hold.mint).toBe('MINT5');
	});

	it('prices in USD only when a SOL price was supplied', () => {
		const positions = [pos(1, { entry: 1, pnlSol: 2 }), pos(2, { entry: 1, pnlSol: -0.5, mint: 'MINT2' }), pos(3, { entry: 1, pnlSol: 0.5, mint: 'MINT3' })];
		expect(slide(deckOf(positions).deck, 'best_trade').trade.pnl_usd).toBeNull();
		expect(slide(deckOf(positions, { solUsd: 100 }).deck, 'best_trade').trade.pnl_usd).toBe(200);
	});

	it('excludes open positions from every superlative', () => {
		const positions = [
			pos(1, { entry: 1, pnlSol: 0.3 }),
			pos(2, { entry: 1, pnlSol: 0.2, mint: 'MINT2' }),
			pos(3, { entry: 1, pnlSol: -0.1, mint: 'MINT3' }),
			pos(4, { entry: 1, pnlSol: 99, mint: 'OPENMINT', status: 'open' }),
		];
		const { deck } = deckOf(positions);
		expect(slide(deck, 'best_trade').trade.mint).toBe('MINT1');
		expect(slide(deck, 'intro').closed_count).toBe(3);
	});
});

describe('humanDuration', () => {
	it('reads as time a person would say out loud', () => {
		expect(humanDuration(11)).toBe('11s');
		expect(humanDuration(186)).toBe('3m 6s');
		expect(humanDuration(3600)).toBe('1h');
		expect(humanDuration(7500)).toBe('2h 5m');
		expect(humanDuration(90000)).toBe('1d 1h');
	});

	it('never renders a negative or fractional hold', () => {
		expect(humanDuration(-5)).toBe('0s');
		expect(humanDuration(1.4)).toBe('1s');
	});
});
