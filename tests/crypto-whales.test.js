import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	normalizeTrade,
	computeSignal,
	buildWhaleResult,
	scanTokenWhales,
	scanMarketWhales,
} from '../api/_lib/pump-whale-scan.js';
import { fetchPumpTrades, fetchPumpBoard } from '../api/_lib/pump-feed-fetch.js';

// The shared pump.fun read layer is exercised in tests/api/pump-feed-fetch.js;
// here it is stubbed so the scan's own degraded/stale reasoning is what is under
// test, with no network involved.
vi.mock('../api/_lib/pump-feed-fetch.js', () => ({
	fetchPumpTrades: vi.fn(),
	fetchPumpBoard: vi.fn(),
}));

// Synthetic pump.fun trades — no real third-party mints/wallets (CLAUDE.md).
// Wallets are placeholder base58-ish strings; the aggregation only keys on them.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function buy(wallet, sol, extra = {}) {
	return { type: 'buy', amountSol: sol, userAddress: wallet, signature: `sig-${wallet}-${sol}`, timestamp: 1783382400, ...extra };
}
function sell(wallet, sol, extra = {}) {
	return { type: 'sell', amountSol: sol, userAddress: wallet, signature: `sig-${wallet}-${sol}`, timestamp: 1783382400, ...extra };
}

describe('normalizeTrade', () => {
	it('parses a buy with defensive field names', () => {
		const t = normalizeTrade({ txType: 'BUY', sol_amount: '3.5', user: 'WalletA', tx: 'abc', createdAt: 1783382400 });
		expect(t).toEqual({ side: 'buy', sol: 3.5, wallet: 'WalletA', txHash: 'abc', ts: '2026-07-07T00:00:00.000Z' });
	});

	it('normalizes millisecond timestamps and ISO strings', () => {
		expect(normalizeTrade(buy('W', 5, { timestamp: 1783382400000 })).ts).toBe('2026-07-07T00:00:00.000Z');
		expect(normalizeTrade(buy('W', 5, { timestamp: '2026-07-07T00:00:00Z' })).ts).toBe('2026-07-07T00:00:00.000Z');
	});

	it('rejects non-buy/sell, zero-amount, and wallet-less trades', () => {
		expect(normalizeTrade({ type: 'transfer', amountSol: 5, userAddress: 'W' })).toBeNull();
		expect(normalizeTrade({ type: 'buy', amountSol: 0, userAddress: 'W' })).toBeNull();
		expect(normalizeTrade({ type: 'buy', amountSol: 5 })).toBeNull();
		expect(normalizeTrade(null)).toBeNull();
	});
});

describe('computeSignal — deterministic net-whale-flow rule', () => {
	const minSol = 5;
	it('neutral when there is no whale activity at all', () => {
		expect(computeSignal({ whaleBuySol: 0, whaleSellSol: 0, buyCount: 0, sellCount: 0 }, minSol)).toBe('neutral');
	});
	it('bullish when net whale flow ≥ +minSol (accumulation)', () => {
		expect(computeSignal({ whaleBuySol: 30, whaleSellSol: 10, buyCount: 4, sellCount: 1 }, minSol)).toBe('bullish');
	});
	it('bearish when net whale flow ≤ −minSol (distribution)', () => {
		expect(computeSignal({ whaleBuySol: 6, whaleSellSol: 20, buyCount: 1, sellCount: 3 }, minSol)).toBe('bearish');
	});
	it('neutral when net flow is within ±minSol (balanced)', () => {
		expect(computeSignal({ whaleBuySol: 12, whaleSellSol: 10, buyCount: 2, sellCount: 2 }, minSol)).toBe('neutral');
	});
	it('scales with minSol — same net flow flips as threshold changes', () => {
		const flow = { whaleBuySol: 12, whaleSellSol: 4, buyCount: 2, sellCount: 1 }; // net +8
		expect(computeSignal(flow, 5)).toBe('bullish'); // 8 ≥ 5
		expect(computeSignal(flow, 10)).toBe('neutral'); // 8 < 10
	});
});

describe('buildWhaleResult — threshold filter', () => {
	it('keeps only buys at/above minSol', () => {
		const trades = [buy('W1', 10), buy('W2', 4.9), buy('W3', 5)];
		const r = buildWhaleResult({ trades, scope: 'token', mint: THREE_MINT, minSol: 5, limit: 10 });
		expect(r.whaleCount).toBe(2);
		expect(r.whales.map((w) => w.solMoved).sort((a, b) => a - b)).toEqual([5, 10]);
		expect(r.totalSolMoved).toBe(15);
	});
});

describe('buildWhaleResult — token scope (per-buy rows)', () => {
	it('returns one row per qualifying buy, largest first, carrying tx + ts', () => {
		const trades = [buy('W1', 6), buy('W1', 20), buy('W2', 8)];
		const r = buildWhaleResult({ trades, scope: 'token', mint: THREE_MINT, minSol: 5, limit: 10 });
		expect(r.scope).toBe('token');
		expect(r.mint).toBe(THREE_MINT);
		expect(r.whales.map((w) => w.solMoved)).toEqual([20, 8, 6]); // per-buy, not aggregated
		expect(r.whaleCount).toBe(3);
		expect(r.whales[0].txHash).toBeTruthy();
		expect(r.whales[0].ts).toBe('2026-07-07T00:00:00.000Z');
	});

	it('respects the limit', () => {
		const trades = [buy('W1', 6), buy('W2', 7), buy('W3', 8)];
		const r = buildWhaleResult({ trades, scope: 'token', mint: THREE_MINT, minSol: 5, limit: 2 });
		expect(r.whales).toHaveLength(2);
		expect(r.whaleCount).toBe(3); // count reflects all qualifiers, list is capped
	});
});

describe('buildWhaleResult — market scope (per-wallet aggregation)', () => {
	it('aggregates a wallet across coins; solMoved sums, txHash = largest buy', () => {
		const trades = [buy('Whale', 6), buy('Whale', 20), buy('Other', 8)];
		const r = buildWhaleResult({ trades, scope: 'market', mint: null, minSol: 5, limit: 10 });
		expect(r.scope).toBe('market');
		expect(r.mint).toBeNull();
		const whale = r.whales.find((w) => w.wallet === 'Whale');
		expect(whale.solMoved).toBe(26); // 6 + 20 summed
		expect(whale.txHash).toBe('sig-Whale-20'); // representative = largest buy
		expect(r.whaleCount).toBe(2); // distinct wallets, not buys
	});
});

describe('buildWhaleResult — empty case', () => {
	it('no whales over threshold → empty + neutral, not an error', () => {
		const trades = [buy('W1', 1), sell('W2', 2)];
		const r = buildWhaleResult({ trades, scope: 'market', mint: null, minSol: 5, limit: 10 });
		expect(r.whales).toEqual([]);
		expect(r.whaleCount).toBe(0);
		expect(r.totalSolMoved).toBe(0);
		expect(r.signal).toBe('neutral');
		expect(r.source).toBe('pump.fun');
	});

	it('empty trade list → empty + neutral', () => {
		const r = buildWhaleResult({ trades: [], scope: 'token', mint: THREE_MINT, minSol: 5, limit: 10 });
		expect(r.whales).toEqual([]);
		expect(r.signal).toBe('neutral');
	});
});

// ── scan orchestration: what "degraded" is allowed to mean ───────────────────
// A quiet mint and a downed feed both produce an empty whale set, and the
// endpoint prints an outage note for one of them. Conflating the two is what
// made a brand-new mint with no trades look like a pump.fun outage, so the
// distinction is pinned here.
describe('scanTokenWhales / scanMarketWhales — degraded + stale', () => {
	beforeEach(() => {
		fetchPumpTrades.mockReset();
		fetchPumpBoard.mockReset();
	});

	it('token scope: rows present → not degraded', async () => {
		fetchPumpTrades.mockResolvedValue({ rows: [buy('W1', 9)], stale: false });
		const r = await scanTokenWhales({ mint: THREE_MINT, minSol: 5, limit: 10 });
		expect(r.degraded).toBe(false);
		expect(r.whales).toHaveLength(1);
		expect(r.stale).toBeUndefined();
	});

	it('token scope: a quiet mint answers empty WITHOUT claiming an outage', async () => {
		fetchPumpTrades.mockResolvedValue({ rows: [], stale: false });
		const r = await scanTokenWhales({ mint: THREE_MINT, minSol: 5, limit: 10 });
		expect(r.degraded).toBe(false);
		expect(r.whales).toEqual([]);
		expect(r.signal).toBe('neutral');
	});

	it('token scope: an unreachable feed IS degraded', async () => {
		fetchPumpTrades.mockResolvedValue(null);
		const r = await scanTokenWhales({ mint: THREE_MINT, minSol: 5, limit: 10 });
		expect(r.degraded).toBe(true);
		expect(r.whales).toEqual([]);
	});

	it('token scope: last-known-good rows are flagged stale', async () => {
		fetchPumpTrades.mockResolvedValue({ rows: [buy('W1', 9)], stale: true });
		const r = await scanTokenWhales({ mint: THREE_MINT, minSol: 5, limit: 10 });
		expect(r.degraded).toBe(false);
		expect(r.stale).toBe(true);
	});

	it('market scope: aggregates the sampled coins and stays live', async () => {
		fetchPumpBoard.mockResolvedValue({ rows: [{ mint: 'M1' }, { mint: 'M2' }], stale: false });
		fetchPumpTrades.mockResolvedValue({ rows: [buy('W1', 7)], stale: false });
		const r = await scanMarketWhales({ minSol: 5, limit: 10 });
		expect(fetchPumpTrades).toHaveBeenCalledTimes(2);
		expect(r.degraded).toBe(false);
		expect(r.whaleCount).toBe(1);
		expect(r.totalSolMoved).toBe(14);
	});

	it('market scope: an unreachable board is degraded', async () => {
		fetchPumpBoard.mockResolvedValue(null);
		const r = await scanMarketWhales({ minSol: 5, limit: 10 });
		expect(r.degraded).toBe(true);
		expect(fetchPumpTrades).not.toHaveBeenCalled();
	});

	it('market scope: degraded only when EVERY sampled trade pull failed', async () => {
		fetchPumpBoard.mockResolvedValue({ rows: [{ mint: 'M1' }, { mint: 'M2' }], stale: false });
		fetchPumpTrades.mockResolvedValue(null);
		const r = await scanMarketWhales({ minSol: 5, limit: 10 });
		expect(r.degraded).toBe(true);

		fetchPumpTrades.mockReset();
		fetchPumpTrades.mockResolvedValueOnce(null).mockResolvedValueOnce({ rows: [buy('W1', 8)], stale: false });
		const partial = await scanMarketWhales({ minSol: 5, limit: 10 });
		expect(partial.degraded).toBe(false);
		expect(partial.whaleCount).toBe(1);
	});

	it('market scope: one stale leg flags the whole result stale', async () => {
		fetchPumpBoard.mockResolvedValue({ rows: [{ mint: 'M1' }, { mint: 'M2' }], stale: false });
		fetchPumpTrades
			.mockResolvedValueOnce({ rows: [buy('W1', 8)], stale: true })
			.mockResolvedValueOnce({ rows: [buy('W2', 6)], stale: false });
		const r = await scanMarketWhales({ minSol: 5, limit: 10 });
		expect(r.stale).toBe(true);
	});
});
