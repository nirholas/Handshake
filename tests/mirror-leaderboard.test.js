import { describe, it, expect } from 'vitest';
import { rankLeaders } from '../api/mirror/leaderboard.js';

// Rows in the exact shape postgres hands back for GET /api/mirror/leaderboard:
// every lamport SUM is cast ::text (bigint sums overflow JS numbers), counts are
// ::int, and an agent with no closed round-trips carries the COALESCE'd zeros.
const row = (o) => ({
	id: o.id,
	name: o.name,
	avatar_url: o.avatar_url ?? null,
	profile_image_url: o.profile_image_url ?? null,
	settled: o.settled ?? 0,
	wins: o.wins ?? 0,
	pnl_lamports: o.pnl_lamports ?? '0',
	entry_lamports: o.entry_lamports ?? '0',
	trades: o.trades ?? 0,
	buy_lamports: o.buy_lamports ?? '0',
	last_trade_at: o.last_trade_at ?? null,
	followers: o.followers ?? 0,
	active_followers: o.active_followers ?? 0,
});

// 20 settled round-trips, 13 wins, +2 SOL on 20 SOL deployed: a real track record.
const CONSISTENT = row({
	id: 'aaaaaaaa-0000-4000-8000-000000000001',
	name: 'Consistent',
	settled: 20, wins: 13,
	pnl_lamports: '2000000000', entry_lamports: '20000000000',
	followers: 3, active_followers: 2,
});
// One lucky round-trip that doubled: same 100% ROI, no sample behind it.
const FLUKE = row({
	id: 'aaaaaaaa-0000-4000-8000-000000000002',
	name: 'Fluke',
	settled: 1, wins: 1,
	pnl_lamports: '1000000000', entry_lamports: '1000000000',
});
// Discretionary-only: real custody volume, nothing settled, so no P&L to show.
const DISCRETIONARY = row({
	id: 'aaaaaaaa-0000-4000-8000-000000000003',
	name: 'Discretionary',
	trades: 7, buy_lamports: '4500000000',
	last_trade_at: '2026-08-04T08:57:12.524Z',
	followers: 1, active_followers: 1,
});
// A real loser: down 1.5 SOL over 12 settled trades. Losers stay on the board.
const LOSER = row({
	id: 'aaaaaaaa-0000-4000-8000-000000000004',
	name: 'Loser',
	settled: 12, wins: 3,
	pnl_lamports: '-1500000000', entry_lamports: '10000000000',
	followers: 9, active_followers: 8,
});

const ALL = [CONSISTENT, FLUKE, DISCRETIONARY, LOSER];
const byId = (ranked, id) => ranked.find((l) => l.agent_id === id);

describe('rankLeaders', () => {
	it('ranks real rows by composite score and numbers them from 1', () => {
		const ranked = rankLeaders(ALL, { sort: 'score', limit: 25 });
		expect(ranked).toHaveLength(4);
		expect(ranked.map((l) => l.rank)).toEqual([1, 2, 3, 4]);
		expect(ranked[0].agent_id).toBe(CONSISTENT.id);
	});

	it('weights ROI by sample size so a single lucky trade cannot top a track record', () => {
		const ranked = rankLeaders([FLUKE, CONSISTENT], { sort: 'score' });
		expect(ranked[0].agent_id).toBe(CONSISTENT.id);
		// The fluke's 100% ROI is real and still shown, just discounted in the score.
		expect(byId(ranked, FLUKE.id).roi_pct).toBe(100);
		expect(byId(ranked, FLUKE.id).score).toBeLessThan(byId(ranked, CONSISTENT.id).score);
	});

	it('converts lamport strings to SOL without losing the sign or precision', () => {
		const ranked = rankLeaders(ALL);
		expect(byId(ranked, CONSISTENT.id).pnl_sol).toBe(2);
		expect(byId(ranked, CONSISTENT.id).roi_pct).toBe(10);
		expect(byId(ranked, CONSISTENT.id).win_rate).toBe(65);
		expect(byId(ranked, LOSER.id).pnl_sol).toBe(-1.5);
		expect(byId(ranked, LOSER.id).roi_pct).toBe(-15);
		expect(byId(ranked, DISCRETIONARY.id).volume_sol).toBe(4.5);
	});

	it('reports no track record as null, never a fabricated number', () => {
		const d = byId(rankLeaders(ALL), DISCRETIONARY.id);
		expect(d.win_rate).toBeNull();
		expect(d.roi_pct).toBeNull();
		expect(d.pnl_sol).toBe(0);
		expect(d.settled).toBe(0);
		expect(d.trades).toBe(7);
	});

	it('keeps losing agents on the board', () => {
		const ranked = rankLeaders(ALL, { sort: 'pnl' });
		expect(byId(ranked, LOSER.id)).toBeDefined();
		expect(ranked[ranked.length - 1].agent_id).toBe(LOSER.id);
	});

	it('honours every supported sort', () => {
		expect(rankLeaders(ALL, { sort: 'pnl' })[0].agent_id).toBe(CONSISTENT.id);
		expect(rankLeaders(ALL, { sort: 'followers' })[0].agent_id).toBe(LOSER.id);
		expect(rankLeaders(ALL, { sort: 'volume' })[0].agent_id).toBe(DISCRETIONARY.id);
		expect(rankLeaders(ALL, { sort: 'winrate' })[0].agent_id).toBe(FLUKE.id);
	});

	it('sorts agents with no win rate last instead of ahead of real ones', () => {
		const ranked = rankLeaders(ALL, { sort: 'winrate' });
		expect(ranked[ranked.length - 1].agent_id).toBe(DISCRETIONARY.id);
		expect(ranked[ranked.length - 1].win_rate).toBeNull();
	});

	it('falls back to score for an unknown sort and defaults the limit', () => {
		const ranked = rankLeaders(ALL, { sort: 'not-a-sort' });
		expect(ranked.map((l) => l.agent_id)).toEqual(rankLeaders(ALL, { sort: 'score' }).map((l) => l.agent_id));
	});

	it('applies the limit after ranking, not before', () => {
		const ranked = rankLeaders(ALL, { sort: 'score', limit: 2 });
		expect(ranked).toHaveLength(2);
		expect(ranked[0].agent_id).toBe(CONSISTENT.id);
		expect(ranked.map((l) => l.rank)).toEqual([1, 2]);
	});

	it('ranks tied agents in one fixed order regardless of row order', () => {
		const tieA = row({ id: 'bbbbbbbb-0000-4000-8000-000000000001', name: 'Tie A', trades: 2 });
		const tieB = row({ id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'Tie B', trades: 2 });
		expect(tieA.buy_lamports).toBe(tieB.buy_lamports);
		const forward = rankLeaders([tieA, tieB]).map((l) => l.agent_id);
		const reversed = rankLeaders([tieB, tieA]).map((l) => l.agent_id);
		expect(forward).toEqual(reversed);
		expect(forward[0]).toBe(tieA.id);
	});

	it('returns an empty board for no candidates', () => {
		expect(rankLeaders([])).toEqual([]);
		expect(rankLeaders([], { sort: 'pnl', limit: 5 })).toEqual([]);
	});

	// /clip-director mints a card from a closed round-trip, so an agent with none
	// is unusable to it. It used to over-fetch by score and filter client side,
	// which silently emptied the page: the composite score does not correlate
	// with having settled trades, so the only eligible agent ranked below the
	// window and every visitor saw "no agents with closed trades yet".
	it('drops agents below settledMin so a caller that needs a track record gets one', () => {
		const ranked = rankLeaders(ALL, { settledMin: 1 });
		expect(ranked.map((l) => l.agent_id)).not.toContain(DISCRETIONARY.id);
		expect(ranked.every((l) => l.settled > 0)).toBe(true);
		expect(ranked.map((l) => l.rank)).toEqual([1, 2, 3]);
	});

	it('filters before the limit, so settledMin cannot be starved by unfiltered rows', () => {
		const ranked = rankLeaders([DISCRETIONARY, CONSISTENT], { settledMin: 1, limit: 1 });
		expect(ranked).toHaveLength(1);
		expect(ranked[0].agent_id).toBe(CONSISTENT.id);
	});

	it('leaves the board untouched when settledMin is absent or zero', () => {
		expect(rankLeaders(ALL).map((l) => l.agent_id)).toEqual(rankLeaders(ALL, { settledMin: 0 }).map((l) => l.agent_id));
		expect(rankLeaders(ALL, { settledMin: 0 })).toHaveLength(4);
	});

	// agent_sniper_positions.entry_quote_lamports is nullable, so a settled
	// round-trip can carry a realized P&L with nothing summed into the entry
	// denominator. Dividing anyway would produce Infinity or NaN, which
	// JSON.stringify silently flattens to `null`: a corrupt number that reads
	// exactly like the honest "no track record" null the board already uses.
	it('never emits Infinity or NaN when a settled position has no recorded entry size', () => {
		const noEntry = row({
			id: 'cccccccc-0000-4000-8000-000000000001',
			name: 'No entry recorded',
			settled: 5, wins: 2,
			pnl_lamports: '250000000', entry_lamports: '0',
		});
		const [l] = rankLeaders([noEntry]);
		expect(l.roi_pct).toBeNull();
		expect(l.pnl_sol).toBe(0.25);
		expect(l.win_rate).toBe(40);
		expect(Number.isFinite(l.score)).toBe(true);
	});

	// Lamport sums are cast ::text in SQL precisely because a bigint sum overflows
	// a JS number. The ranking must stay finite and correctly ordered for a whale
	// row rather than degrading to NaN and sorting arbitrarily.
	it('ranks lamport sums past the safe-integer range without losing finiteness or order', () => {
		const whale = row({
			id: 'cccccccc-0000-4000-8000-000000000002',
			name: 'Whale',
			settled: 40, wins: 25,
			pnl_lamports: '9007199254740993000', entry_lamports: '90071992547409930000',
		});
		const ranked = rankLeaders([CONSISTENT, whale], { sort: 'pnl' });
		expect(ranked[0].agent_id).toBe(whale.id);
		expect(Number.isFinite(ranked[0].pnl_sol)).toBe(true);
		expect(ranked[0].pnl_sol).toBeGreaterThan(9e9);
		expect(ranked[0].roi_pct).toBe(10);
		expect(Number.isFinite(ranked[0].score)).toBe(true);
	});
});
