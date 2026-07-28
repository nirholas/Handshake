import { describe, it, expect } from 'vitest';

import { ringTickConfig, sponsorGovernor } from '../api/_lib/x402/ring-tick-plan.js';

// The sponsor governor is the ring tick's view of the facilitator's fee wallet
// (X402_FEE_PAYER_SOLANA): the wallet that actually starved in the 2026-07-28
// outage. Three regimes: unreadable balance passes through (the facilitator
// fail-closes at settle time), below the hard floor skips the tick, above it
// the payer-governor runway math tapers the call rate.
describe('sponsorGovernor: regimes', () => {
	const BASE = {
		configuredCalls: 6,
		floorLamports: 4_000_000,
		feePerSettleLamports: 6_000,
		runwayDays: 1,
		minCalls: 1,
	};

	it('passes through untouched when the balance read failed', () => {
		const g = sponsorGovernor({ ...BASE, sponsorLamports: Number.NaN });
		expect(g).toMatchObject({ skip: false, calls: 6, throttled: false, known: false });
	});

	it('skips the whole tick below the hard floor', () => {
		const g = sponsorGovernor({ ...BASE, sponsorLamports: 3_920_014 });
		expect(g).toMatchObject({ skip: true, calls: 0, throttled: true, known: true });
	});

	it('skips exactly at one lamport under the floor, runs at the floor', () => {
		expect(sponsorGovernor({ ...BASE, sponsorLamports: 3_999_999 }).skip).toBe(true);
		expect(sponsorGovernor({ ...BASE, sponsorLamports: 4_000_000 }).skip).toBe(false);
	});

	it('runs at the full configured rate with ample runway', () => {
		// 0.1 SOL spendable over the floor: 100M/6000/1d ≈ 16,666 calls/day ≈ 11/min.
		const g = sponsorGovernor({ ...BASE, sponsorLamports: 104_000_000 });
		expect(g).toMatchObject({ skip: false, calls: 6, throttled: false, known: true });
	});

	it('tapers below the full rate as spendable SOL shrinks', () => {
		// ~0.03 SOL spendable: 30M/6000/1d = 5,000 calls/day ≈ 3/min: half rate.
		const g = sponsorGovernor({ ...BASE, sponsorLamports: 34_000_000 });
		expect(g.skip).toBe(false);
		expect(g.throttled).toBe(true);
		expect(g.calls).toBeGreaterThanOrEqual(1);
		expect(g.calls).toBeLessThan(BASE.configuredCalls);
	});

	it('keeps the heartbeat above the floor even when runway math says zero', () => {
		// 10k lamports spendable is under two settles' worth: runway budget rounds
		// to 0/min, but the hard floor is the real stop, so the heartbeat holds.
		const g = sponsorGovernor({ ...BASE, sponsorLamports: 4_010_000 });
		expect(g.skip).toBe(false);
		expect(g.calls).toBe(1);
		expect(g.throttled).toBe(true);
	});

	it('never raises the rate above configuredCalls however rich the sponsor is', () => {
		const g = sponsorGovernor({ ...BASE, sponsorLamports: 5_000_000_000 });
		expect(g.calls).toBe(6);
	});
});

describe('ringTickConfig: sponsor knobs', () => {
	it('defaults the sponsor fee estimate and runway, clamped sane', () => {
		const cfg = ringTickConfig({});
		expect(cfg.sponsorFeePerSettleLamports).toBe(6_000);
		expect(cfg.sponsorRunwayDays).toBe(1);
	});

	it('reads the env overrides and floors bad values', () => {
		const cfg = ringTickConfig({
			X402_RING_SPONSOR_FEE_PER_SETTLE_LAMPORTS: '9000',
			X402_RING_SPONSOR_RUNWAY_DAYS: '2',
		});
		expect(cfg.sponsorFeePerSettleLamports).toBe(9_000);
		expect(cfg.sponsorRunwayDays).toBe(2);
		const bad = ringTickConfig({
			X402_RING_SPONSOR_FEE_PER_SETTLE_LAMPORTS: '-5',
			X402_RING_SPONSOR_RUNWAY_DAYS: '0',
		});
		expect(bad.sponsorFeePerSettleLamports).toBeGreaterThanOrEqual(1);
		expect(bad.sponsorRunwayDays).toBeGreaterThanOrEqual(0.5);
	});
});
