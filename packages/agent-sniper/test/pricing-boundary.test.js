// Pricing-boundary regression tests.
//
// Two upstream pump.fun changes made "the reserves decoded to nothing" a live
// possibility rather than a theoretical one:
//
//   · The bonding curve renamed its quote-side fields (virtual_sol_reserves →
//     virtual_quote_reserves, real_sol_reserves → real_quote_reserves). A
//     decoder still reading the old names gets `undefined`, which coerces to 0
//     rather than throwing, so a coin reads as 0% to graduation at a zero price.
//   · The PumpSwap Pool gained virtual_quote_reserves, and quotes now price on
//     pool_quote_token_account.amount + pool.virtual_quote_reserves. Pricing off
//     the raw vault balance is silently wrong, not an error.
//
// Both fail as bad NUMBERS, never as exceptions, and this engine spends real SOL
// on those numbers with no human in the loop. So the boundary where a quote
// enters the engine has to reject an unpriced quote instead of reading it as a
// zero, and the position sweep must not mistake a failed read for a wipeout.

import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

import {
	requireImpactPct,
	requireQuoteMint,
	requireQuoteOut,
} from '../src/adapters/solana/pump-client.js';
import { runPositionSweep } from '../src/positions.js';

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
// $THREE. A real, valid mint is needed because the sweep parses pos.mint into a
// PublicKey before it quotes; nothing here touches the chain.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

describe('quote boundary: requireImpactPct', () => {
	it('passes a real figure through, zero included', () => {
		expect(requireImpactPct(3.5, 'buy')).toBe(3.5);
		expect(requireImpactPct(0, 'buy')).toBe(0);
		expect(requireImpactPct('2.25', 'buy')).toBe(2.25);
	});

	it('throws rather than defaulting a missing impact to 0', () => {
		// `priceImpactPct ?? 0` here would hand the entry breaker a perfect score
		// for a quote that never priced.
		for (const bad of [undefined, null, NaN, 'abc', Infinity]) {
			expect(() => requireImpactPct(bad, 'buy')).toThrow(/priceImpactPct/);
		}
		expect(() => requireImpactPct(undefined, 'sell')).toThrow(
			expect.objectContaining({ code: 'quote_unpriced' }),
		);
	});
});

describe('quote boundary: requireQuoteMint', () => {
	it('passes the reported quote mint through', () => {
		expect(requireQuoteMint(WSOL, 'buy')).toBe(WSOL);
	});

	// The curve gained a quote_mint field; assuming wSOL when it is absent would
	// let a non-SOL-paired coin past a SOL-only strategy and denominate its P&L
	// in the wrong asset.
	it('throws rather than assuming wSOL', () => {
		expect(() => requireQuoteMint(undefined, 'buy')).toThrow(
			expect.objectContaining({ code: 'quote_mint_missing' }),
		);
		expect(() => requireQuoteMint({}, 'buy')).toThrow(/quoteMint/);
	});
});

describe('quote boundary: requireQuoteOut', () => {
	it('returns the quoted amount as a bigint', () => {
		expect(requireQuoteOut({ toString: () => '12345' }, 'sell')).toBe(12345n);
		expect(requireQuoteOut(7n, 'sell')).toBe(7n);
	});

	// Empty-reserve decode → a quote of 0. That is a failed read, not a
	// worthless bag, and the difference is a forced sale at the bottom.
	it('throws on a zero or missing valuation instead of reporting it', () => {
		expect(() => requireQuoteOut(0n, 'sell')).toThrow(/zero/);
		expect(() => requireQuoteOut(undefined, 'sell')).toThrow(/expectedQuoteOut/);
		expect(() => requireQuoteOut(null, 'sell')).toThrow(
			expect.objectContaining({ code: 'quote_unpriced' }),
		);
	});
});

// ── position sweep ───────────────────────────────────────────────────────────
// A second line of defence for adapters that are not the bundled one: even if a
// custom SolanaClient does return 0, the sweep must hold rather than exit.

function harness({ quoteForSell }) {
	const position = {
		id: 'pos_1',
		agent_id: 'agent_1',
		mint: THREE_MINT,
		base_amount: '1000000',
		slippage_bps: 500,
		entry_quote_lamports: '100000000',
		peak_value_lamports: '100000000',
		stop_loss_pct: 20,
		opened_at_ms: Date.now(),
		status: 'open',
	};
	const updatePosition = vi.fn(async () => {});
	const warn = vi.fn();
	return {
		position,
		updatePosition,
		warn,
		cfg: { network: 'mainnet', exitOnBearish: false },
		ports: {
			store: {
				getOpenPositions: async () => [position],
				updatePosition,
			},
			wallet: {
				loadKeypair: async () => {
					throw new Error('sweep must not reach the wallet on a bad quote');
				},
			},
			solana: { quoteForSell, connection: {} },
			executor: {
				submit: async () => {
					throw new Error('sweep must not broadcast on a bad quote');
				},
			},
			hooks: {},
			log: { info: () => {}, warn, error: () => {}, trade: () => {} },
		},
	};
}

describe('runPositionSweep', () => {
	it('holds the position when the re-quote values it at zero', async () => {
		const h = harness({
			quoteForSell: async () => ({ priceImpactPct: 0, expectedQuoteOut: 0n }),
		});
		await runPositionSweep(h.cfg, h.ports);
		// No valuation written, no exit attempted: the wallet/executor stubs
		// above would have thrown had the sell path run.
		expect(h.updatePosition).not.toHaveBeenCalled();
		expect(h.warn).toHaveBeenCalledWith(
			'position re-quote returned no usable value, holding',
			expect.objectContaining({ mint: h.position.mint }),
		);
	});

	it('holds when the re-quote omits expectedQuoteOut entirely', async () => {
		const h = harness({ quoteForSell: async () => ({ priceImpactPct: 1 }) });
		await runPositionSweep(h.cfg, h.ports);
		expect(h.updatePosition).not.toHaveBeenCalled();
	});

	it('records the valuation and holds when a real quote shows a healthy position', async () => {
		const h = harness({
			quoteForSell: async () => ({ priceImpactPct: 1, expectedQuoteOut: 110_000_000n }),
		});
		await runPositionSweep(h.cfg, h.ports);
		expect(h.updatePosition).toHaveBeenCalledWith('pos_1', {
			last_value_lamports: 110_000_000,
			peak_value_lamports: 110_000_000,
		});
	});

	it('still exits on a real quote that shows the position through its stop-loss', async () => {
		// 100_000_000 entry, 20% stop → a genuine 50_000_000 quote must sell. The
		// zero-guard must not become a way for a collapsing coin to be held.
		const h = harness({
			quoteForSell: async () => ({ priceImpactPct: 1, expectedQuoteOut: 50_000_000n }),
		});
		await runPositionSweep(h.cfg, h.ports);
		expect(h.updatePosition).toHaveBeenCalledWith('pos_1', {
			last_value_lamports: 50_000_000,
			peak_value_lamports: 100_000_000,
		});
		// The exit path runs: it marks the position 'closing' before selling, then
		// fails on the deliberately-throwing wallet stub and returns it to 'open'.
		const statuses = h.updatePosition.mock.calls.map(([, patch]) => patch.status).filter(Boolean);
		expect(statuses).toContain('closing');
	});
});
