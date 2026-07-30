// Unit tests for resolveEntrySize (api/_lib/agent-trade-guards.js): the guard
// that decides whether an underfunded sniper arm shrinks its buy or sits out.
//
// The bug this pins down: a wallet holding more than the entry headroom (fee +
// ATA rent) but less than MIN_OPERATIONAL_WALLET_SOL passed the old inline check
// and then aborted at the firewall round-trip probe / pre-broadcast CU
// simulation it could not afford to run. The arm re-attempted every candidate
// and booked a SIM_FAILED each time. Observed live on the boost-ride arm: 82
// consecutive SIM_FAILED in 24h from a 0.0048 SOL wallet, zero buys.
//
// Pure function, no mocks needed.

import { describe, it, expect } from 'vitest';
import {
	resolveEntrySize,
	ENTRY_HEADROOM_LAMPORTS,
	MIN_OPERATIONAL_WALLET_SOL,
} from '../api/_lib/agent-trade-guards.js';

const MIN_TRADE = 10_000n; // SNIPER_MIN_TRADE_LAMPORTS default
const OPERATIONAL = BigInt(Math.round(MIN_OPERATIONAL_WALLET_SOL * 1e9));
const sol = (n) => BigInt(Math.round(n * 1e9));

describe('resolveEntrySize', () => {
	it('trades the configured size when the wallet fully covers it', () => {
		const want = sol(0.05);
		const got = resolveEntrySize(want + ENTRY_HEADROOM_LAMPORTS, want, MIN_TRADE);
		expect(got.skip).toBeUndefined();
		expect(got.sizeLamports).toBe(want);
	});

	it('shrinks to what is left when the wallet is short but still operational', () => {
		// Comfortably above the operational floor, below want + headroom.
		const wallet = OPERATIONAL * 4n;
		const want = wallet; // more than it can afford once headroom is reserved
		const got = resolveEntrySize(wallet, want, MIN_TRADE);
		expect(got.skip).toBeUndefined();
		expect(got.sizeLamports).toBe(wallet - ENTRY_HEADROOM_LAMPORTS);
		expect(got.sizeLamports).toBeLessThan(want);
	});

	it('sits out below the operational floor even when headroom alone would pass', () => {
		// The regression case. This balance clears headroom + minTrade, so the old
		// headroom-only gate shrank and attempted; it cannot afford the simulations.
		const wallet = ENTRY_HEADROOM_LAMPORTS + MIN_TRADE + 1n;
		expect(wallet).toBeGreaterThan(ENTRY_HEADROOM_LAMPORTS + MIN_TRADE);
		expect(wallet).toBeLessThan(OPERATIONAL);
		const got = resolveEntrySize(wallet, sol(0.0254), MIN_TRADE);
		expect(got.skip).toBe('insufficient_sol');
		expect(got.sizeLamports).toBeUndefined();
	});

	it('sits out at the live boost-ride balance that produced the SIM_FAILED loop', () => {
		const got = resolveEntrySize(sol(0.004773), sol(0.0254), MIN_TRADE);
		expect(got.skip).toBe('insufficient_sol');
	});

	it('sits out when the wallet cannot cover even a minimum-sized trade', () => {
		const got = resolveEntrySize(ENTRY_HEADROOM_LAMPORTS, sol(0.05), MIN_TRADE);
		expect(got.skip).toBe('insufficient_sol');
	});

	it('accepts number and string balances, not just bigint', () => {
		const want = sol(0.05);
		const wallet = want + ENTRY_HEADROOM_LAMPORTS;
		expect(resolveEntrySize(Number(wallet), Number(want), 10_000).sizeLamports).toBe(want);
		expect(resolveEntrySize(String(wallet), String(want), '10000').sizeLamports).toBe(want);
	});

	it('never returns a size the wallet cannot pay for', () => {
		for (const balance of [0, 1, 5_000, 6_039_280, 8_000_000, 12_000_000, 50_000_000]) {
			const got = resolveEntrySize(balance, sol(0.05), MIN_TRADE);
			if (got.skip) continue;
			expect(got.sizeLamports + ENTRY_HEADROOM_LAMPORTS).toBeLessThanOrEqual(BigInt(balance));
		}
	});
});
