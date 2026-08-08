// Unit tests for api/_lib/sniper-solvency.js: the fleet's "can it afford to
// trade at all?" verdict.
//
// The incident this pins down: from 2026-07-29 to 2026-08-08 the sniper fleet
// booked 1,000+ consecutive failed entries and closed zero trades while
// /api/sniper/status reported state:"live" throughout. Every liveness fact was
// true (process up, feed connected, 13 strategies armed) and the wallets held
// 0.0048 SOL against a 0.012 SOL operational floor, so nothing could fill. The
// funding master that should have refilled them held 0.0018 SOL, so the
// auto-funder was a no-op too, and nothing alerted on either fact.
//
// The load-bearing invariant here is the LAST describe block: solvency must be
// decided by resolveEntrySize, the same function the executor uses to size or
// skip a real entry. If these two ever disagree, the status page starts claiming
// wallets are tradeable that the executor silently skips: the original bug,
// one level up.
//
// Pure functions, no mocks needed.

import { describe, it, expect } from 'vitest';
import {
	walletTradeState,
	summarizeFleetSolvency,
	describeSolvency,
	deriveSniperState,
	MASTER_COVER_BUFFER_SOL,
} from '../api/_lib/sniper-solvency.js';
import { resolveEntrySize, MIN_OPERATIONAL_WALLET_SOL } from '../api/_lib/agent-trade-guards.js';
import { fundTargetSol } from '../api/_lib/agent-funding-policy.js';

const MIN_TRADE = 10_000n;

describe('walletTradeState', () => {
	it('reports funded when the wallet covers the arm size plus overhead', () => {
		expect(walletTradeState(0.5, 0.05)).toBe('funded');
	});

	it('reports starved for the exact balance that produced the live outage', () => {
		// 0.0048 SOL — above the entry headroom, below the operational floor, so
		// every attempt died at a simulation the wallet could not afford to run.
		expect(walletTradeState(0.0048, 0.05)).toBe('starved');
	});

	it('reports starved for an empty wallet', () => {
		expect(walletTradeState(0, 0.05)).toBe('starved');
		expect(walletTradeState(0.0000001, 0.05)).toBe('starved');
	});

	it('reports shrunk when the wallet can trade, but under the configured size', () => {
		// Above the operational floor, short of the configured size + headroom:
		// the executor shrinks rather than skips (learning > profit).
		const state = walletTradeState(MIN_OPERATIONAL_WALLET_SOL + 0.02, 0.5);
		expect(state).toBe('shrunk');
	});

	it('does not call a wallet starved just because its arm has no configured size', () => {
		expect(walletTradeState(0.5, 0)).toBe('funded');
	});
});

describe('summarizeFleetSolvency', () => {
	const wallet = (balanceSol, perTradeSol = 0.05, agentId = 'a') => ({
		agentId, address: `addr-${agentId}`, balanceSol, perTradeSol,
	});

	it('is unknown when nothing has been measured', () => {
		expect(summarizeFleetSolvency({ wallets: [] }).state).toBe('unknown');
		expect(summarizeFleetSolvency({}).state).toBe('unknown');
	});

	it('is funded when every wallet can place its configured size', () => {
		const s = summarizeFleetSolvency({ wallets: [wallet(0.5, 0.05, 'a'), wallet(0.4, 0.05, 'b')] });
		expect(s.state).toBe('funded');
		expect(s.tradeable).toBe(2);
		expect(s.starved).toBe(0);
		expect(s.deficitSol).toBe(0);
	});

	it('is starved when no wallet can place any entry — the live outage shape', () => {
		const s = summarizeFleetSolvency({
			wallets: [wallet(0.0048, 0.05, 'a'), wallet(0.0002, 0.05, 'b')],
			masterSol: 0.0018,
		});
		expect(s.state).toBe('starved');
		expect(s.agents).toBe(2);
		expect(s.starved).toBe(2);
		expect(s.tradeable).toBe(0);
		expect(s.deficitSol).toBeGreaterThan(0);
		// The master held dust, so this could never have healed on its own.
		expect(s.masterCanCover).toBe(false);
	});

	it('is degraded when at least one wallet can still trade', () => {
		const s = summarizeFleetSolvency({ wallets: [wallet(0.5, 0.05, 'a'), wallet(0.0048, 0.05, 'b')] });
		expect(s.state).toBe('degraded');
		expect(s.tradeable).toBe(1);
		expect(s.starved).toBe(1);
	});

	it('treats an unread balance as unmeasured, never as zero', () => {
		// An RPC blip must not page everyone with a false starvation report.
		const s = summarizeFleetSolvency({ wallets: [wallet(0.5, 0.05, 'a'), wallet(null, 0.05, 'b')] });
		expect(s.agents).toBe(1);
		expect(s.state).toBe('funded');
		expect(s.wallets).toHaveLength(1);
	});

	it('prices the deficit as the cost of lifting every starved wallet to its refill target', () => {
		const s = summarizeFleetSolvency({ wallets: [wallet(0, 0.05, 'a')] });
		expect(s.deficitSol).toBeCloseTo(fundTargetSol({ perTradeSol: 0.05 }), 9);
	});

	it('only claims the master can cover the deficit with fee headroom to spare', () => {
		const deficit = summarizeFleetSolvency({ wallets: [wallet(0, 0.05, 'a')] }).deficitSol;
		// Exactly the deficit is not enough: the transfers themselves cost fees.
		expect(summarizeFleetSolvency({ wallets: [wallet(0, 0.05, 'a')], masterSol: deficit }).masterCanCover).toBe(false);
		const covered = summarizeFleetSolvency({
			wallets: [wallet(0, 0.05, 'a')],
			masterSol: deficit + MASTER_COVER_BUFFER_SOL,
		});
		expect(covered.masterCanCover).toBe(true);
	});

	it('reports an unknown master balance as unknown, not as failure to cover', () => {
		const s = summarizeFleetSolvency({ wallets: [wallet(0, 0.05, 'a')] });
		expect(s.masterCanCover).toBeNull();
		expect(s.masterSol).toBeNull();
	});
});

describe('describeSolvency', () => {
	it('names the human action when the master cannot refill', () => {
		const s = summarizeFleetSolvency({ wallets: [{ balanceSol: 0.0048, perTradeSol: 0.05 }], masterSol: 0.0018 });
		const text = describeSolvency(s);
		expect(text).toMatch(/No armed wallet can place an entry/);
		expect(text).toMatch(/CANNOT refill/);
	});

	it('says it will self-heal when the master is funded', () => {
		const s = summarizeFleetSolvency({ wallets: [{ balanceSol: 0, perTradeSol: 0.05 }], masterSol: 50 });
		expect(describeSolvency(s)).toMatch(/refill them automatically/);
	});

	it('handles the unmeasured case without inventing a verdict', () => {
		expect(describeSolvency(summarizeFleetSolvency({ wallets: [] }))).toMatch(/No armed wallet balances measured/);
		expect(describeSolvency(null)).toMatch(/No armed wallet balances measured/);
	});
});

describe('deriveSniperState', () => {
	const healthy = { alive: true, feedLive: true, feedSilent: false };

	it('reports live only when the process, the feed, and the money are all fine', () => {
		expect(deriveSniperState({ ...healthy, solvencyState: 'funded' })).toBe('live');
	});

	it('does NOT report live for a starved fleet (the ten-day bug)', () => {
		// Exactly the observed production state: heartbeat fresh, feed connected,
		// strategies armed, wallets empty. This used to return 'live'.
		expect(deriveSniperState({ ...healthy, solvencyState: 'starved' })).toBe('starved');
	});

	it('ranks a dead process above every other signal', () => {
		expect(deriveSniperState({ alive: false, feedLive: false, feedSilent: true, solvencyState: 'starved' })).toBe('down');
	});

	it('ranks starvation above a feed problem (the more actionable diagnosis)', () => {
		expect(deriveSniperState({ alive: true, feedLive: false, feedSilent: true, solvencyState: 'starved' })).toBe('starved');
	});

	it('degrades on a silent feed or a partially starved fleet', () => {
		expect(deriveSniperState({ ...healthy, feedSilent: true, solvencyState: 'funded' })).toBe('degraded');
		expect(deriveSniperState({ ...healthy, solvencyState: 'degraded' })).toBe('degraded');
	});

	it('never downgrades on an unmeasured fleet', () => {
		// Older worker builds publish no solvency at all; absence must not read as
		// insolvency, or every pre-upgrade deploy would page as broken.
		expect(deriveSniperState({ ...healthy, solvencyState: 'unknown' })).toBe('live');
		expect(deriveSniperState(healthy)).toBe('live');
	});
});

describe('solvency agrees with the executor (no second source of truth)', () => {
	// Sweep the whole interesting range and assert the two never disagree about
	// whether a wallet can trade. This is the drift guard: solvency must ask
	// resolveEntrySize rather than re-deriving its thresholds.
	it('never calls a wallet tradeable that the executor would skip', () => {
		const perTradeSol = 0.05;
		const want = BigInt(Math.round(perTradeSol * 1e9));
		for (let i = 0; i <= 400; i++) {
			const balanceSol = i * 0.0005; // 0 .. 0.2 SOL
			const wallet = BigInt(Math.round(balanceSol * 1e9));
			const executorSkips = !!resolveEntrySize(wallet, want, MIN_TRADE).skip;
			const solvencyStarved = walletTradeState(balanceSol, perTradeSol, MIN_TRADE) === 'starved';
			expect(solvencyStarved, `disagreement at ${balanceSol} SOL`).toBe(executorSkips);
		}
	});
});
