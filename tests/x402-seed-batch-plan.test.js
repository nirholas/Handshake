// The seed cron must not fire a batch whose outcome is already decided.
//
// Regression guard for a live production failure (2026-07-26): the treasury ran
// dry, and because the seeder had no balance preflight it kept firing 60 paid
// calls per minute regardless. The facilitator failed every one — 6,314
// `fee_wallet_below_floor` settle failures and 745 `simulation_failed` verify
// rejects — which surfaced to callers as hours of 502s on /api/x402/dance-tip
// and burned Solana RPC for nothing. Both conditions are knowable from two
// balance reads before the first transaction is built.
//
// planSeedBatch() is that decision. Its contract:
//   • sponsor below the SOL settle floor → skip the whole tick
//   • payer cannot afford even one call  → skip the whole tick
//   • payer can afford some but not all  → send exactly what it can fund
//   • either balance unknown (null)      → proceed (an RPC blip is not "empty")
//
// The null-vs-zero distinction is load-bearing in both directions: it must stop
// a genuinely dry wallet and must never halt seeding over a failed read.

import { describe, it, expect, beforeAll } from 'vitest';

let planSeedBatch;
let FLOOR;

beforeAll(async () => {
	process.env.X402_ASSET_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
	process.env.CRON_SECRET = 'test-secret';
	({ planSeedBatch } = await import('../api/cron/x402-seed-cron.js'));
	({ SPONSOR_SOL_FLOOR_LAMPORTS: FLOOR } = await import('../api/_lib/x402/self-facilitator.js'));
});

// One tip costs $0.001 USDC; a healthy tick sends 60 of them.
const PRICE = 1_000;
const BATCH = 60;
const plan = (over) =>
	planSeedBatch({
		sponsorSolLamports: FLOOR * 10,
		payerUsdcAtomic: PRICE * BATCH * 100,
		priceAtomic: PRICE,
		batchSize: BATCH,
		...over,
	});

describe('planSeedBatch — the seeder preflight', () => {
	it('sends the full configured batch when both wallets are funded', () => {
		expect(plan()).toEqual({ skip: null, batch: BATCH });
	});

	it('skips the tick when the sponsor is below the SOL settle floor', () => {
		// The exact production condition: every settle fail-closes at this level.
		expect(plan({ sponsorSolLamports: FLOOR - 1 })).toEqual({
			skip: 'sponsor_sol_below_floor',
			batch: 0,
		});
	});

	it('treats a sponsor exactly at the floor as fundable', () => {
		// The facilitator rejects strictly below the floor, so the gate must match
		// it exactly or the seeder stalls one lamport early.
		expect(plan({ sponsorSolLamports: FLOOR }).skip).toBeNull();
	});

	it('skips the tick when the payer cannot afford a single call', () => {
		expect(plan({ payerUsdcAtomic: PRICE - 1 })).toEqual({
			skip: 'payer_usdc_exhausted',
			batch: 0,
		});
	});

	it('right-sizes the batch to what a partial float can fund', () => {
		// $0.0125 funds 12 calls, not 60: send 12 real payments rather than 60
		// attempts of which 48 die at verify.
		expect(plan({ payerUsdcAtomic: PRICE * 12 + 500 })).toEqual({ skip: null, batch: 12 });
	});

	it('never exceeds the configured batch however rich the payer is', () => {
		expect(plan({ payerUsdcAtomic: PRICE * 10_000 })).toEqual({ skip: null, batch: BATCH });
	});

	it('proceeds when the sponsor balance could not be read', () => {
		// null = unknown. A transient RPC failure must not halt the ring.
		expect(plan({ sponsorSolLamports: null })).toEqual({ skip: null, batch: BATCH });
	});

	it('proceeds at full batch when the payer balance could not be read', () => {
		expect(plan({ payerUsdcAtomic: null })).toEqual({ skip: null, batch: BATCH });
	});

	it('still enforces the sponsor floor when the payer balance is unknown', () => {
		// The two gates are independent; one unknown must not mask the other.
		expect(plan({ payerUsdcAtomic: null, sponsorSolLamports: FLOOR - 1 })).toEqual({
			skip: 'sponsor_sol_below_floor',
			batch: 0,
		});
	});

	it('falls back to the configured batch when the price is unusable', () => {
		// A zero/NaN price would make the affordability division meaningless.
		for (const priceAtomic of [0, Number.NaN]) {
			expect(plan({ priceAtomic })).toEqual({ skip: null, batch: BATCH });
		}
	});
});
