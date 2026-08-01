// Tests for the caller-side fee admission gate
// (assessFeeAdmission in api/_lib/x402/wallet-fee-meter.js).
//
// The settle-path meter refuses an unfundable settle at the LAST step of the
// x402 handshake, after the caller has already read the receiver ATA, signed a
// transfer, and paid for a facilitator `verify` that simulates against an RPC
// node. Measured on production 2026-08-01: 85,264 of 90,041 daily settle
// attempts were refused with `fee_runway_exhausted`, each having burned that
// work first. assessFeeAdmission answers the same question before any of it.
//
// These tests pin the three properties that make the gate safe to put in front
// of every paid call:
//   1. It never refuses a call the settle path would have funded (parity).
//   2. It fails OPEN on every unreadable input, so it can only remove doomed
//      work, never block a fundable payment.
//   3. Its refusal cache collapses a storm without outliving the UTC-midnight
//      budget reset that ends the refusal.
//
// DB, alerts, allowlist, RPC, and env are mocked at the module boundary the way
// the neighboring x402 tests mock theirs; time is driven with fake timers so the
// cache-window tests never sleep.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
	sql: vi.fn(),
	sendOpsAlert: vi.fn(async () => {}),
	ringAllowedAddresses: vi.fn(),
	sponsorSolLamports: vi.fn(),
	solanaConnection: vi.fn(() => ({})),
}));

vi.mock('../api/_lib/db.js', () => ({ sql: h.sql }));
vi.mock('../api/_lib/alerts.js', () => ({ sendOpsAlert: h.sendOpsAlert }));
vi.mock('../api/_lib/env.js', () => ({ env: { SOLANA_RPC_URL: 'https://rpc.test' } }));
vi.mock('../api/_lib/solana/connection.js', () => ({ solanaConnection: h.solanaConnection }));
vi.mock('../api/_lib/x402/ring-allowlist.js', () => ({
	ringAllowedAddresses: h.ringAllowedAddresses,
}));
// Pinning the floor keeps the budget arithmetic readable below; stubbing the
// balance read keeps the heavy web3 module and a real RPC out of a unit test.
vi.mock('../api/_lib/x402/self-facilitator.js', () => ({
	SPONSOR_SOL_FLOOR_LAMPORTS: 20_000_000,
	sponsorSolLamports: h.sponsorSolLamports,
}));

const {
	assessFeeAdmission,
	facilitatorFeeMeter,
	resetWalletFeeMeterCaches,
} = await import('../api/_lib/x402/wallet-fee-meter.js');

const GOV = 'GovWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ORGANIC = 'OrganicBuyer111111111111111111111111111111111';

// With the mocked 0.02 SOL floor and runwayDays 1, this balance yields exactly a
// 1_000_000-lamport daily budget: (21_000_000 - 20_000_000) / 1.
const SOL_FOR_1M_BUDGET = 21_000_000;

// Pacing is exercised in its own test; the arithmetic tests turn it off so the
// budget is the full daily figure regardless of what time the suite runs.
const CFG = {
	enabled: true,
	runwayDays: 1,
	minBudgetLamports: 0,
	spentCacheMs: 20_000,
	paceDay: false,
	paceMinSliceLamports: 0,
};

const T0 = new Date('2026-07-28T12:00:00.000Z').getTime();

function admit(overrides = {}) {
	return assessFeeAdmission({
		feeWalletB58: GOV, estFeeLamports: 5_000, config: CFG, ...overrides,
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
	resetWalletFeeMeterCaches();
	h.sql.mockReset().mockResolvedValue([{ spent: '0' }]);
	h.sendOpsAlert.mockReset().mockResolvedValue(undefined);
	h.ringAllowedAddresses.mockReset().mockResolvedValue(new Set([GOV]));
	h.sponsorSolLamports.mockReset().mockResolvedValue(SOL_FOR_1M_BUDGET);
	h.solanaConnection.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('scope: only platform-controlled wallets are gated', () => {
	it('admits an organic buyer without reading its balance or the ledger', async () => {
		const v = await admit({ feeWalletB58: ORGANIC });
		expect(v.ok).toBe(true);
		// Refusing an external self-payer would be refusing revenue, and pricing it
		// would cost an RPC read per organic call for a verdict we never act on.
		expect(h.sponsorSolLamports).not.toHaveBeenCalled();
		expect(h.sql).not.toHaveBeenCalled();
	});

	it('admits everything when the governor is disabled', async () => {
		const v = await admit({ config: { ...CFG, enabled: false } });
		expect(v.ok).toBe(true);
		expect(h.sponsorSolLamports).not.toHaveBeenCalled();
	});

	it('admits when the caller has no fee wallet to price', async () => {
		expect((await admit({ feeWalletB58: null })).ok).toBe(true);
		expect(h.sponsorSolLamports).not.toHaveBeenCalled();
	});
});

describe('budget arithmetic', () => {
	it('refuses once the day spend plus this fee exceeds the budget', async () => {
		h.sql.mockResolvedValue([{ spent: '996000' }]);
		const v = await admit({ estFeeLamports: 5_000 });
		expect(v.ok).toBe(false);
		expect(v.reason).toBe('fee_runway_exhausted:996000+5000>1000000');
		expect(v.budgetLamports).toBe(1_000_000);
		expect(v.spentTodayLamports).toBe(996_000);
	});

	it('admits while the fee still fits', async () => {
		h.sql.mockResolvedValue([{ spent: '990000' }]);
		expect((await admit({ estFeeLamports: 5_000 })).ok).toBe(true);
	});

	it('the boundary is inclusive: exactly filling the budget still admits', async () => {
		h.sql.mockResolvedValue([{ spent: '995000' }]);
		expect((await admit({ estFeeLamports: 5_000 })).ok).toBe(true);
	});

	it('honors intraday pacing when enabled: midday unlocks half the day budget', async () => {
		// T0 is 12:00 UTC, so half of the 1_000_000 budget (500_000) is unlocked.
		// A spend that fits the full day budget but not the paced slice is refused.
		h.sql.mockResolvedValue([{ spent: '600000' }]);
		const v = await admit({
			estFeeLamports: 5_000,
			config: { ...CFG, paceDay: true, paceMinSliceLamports: 0 },
		});
		expect(v.ok).toBe(false);
		expect(v.budgetLamports).toBe(500_000);
	});
});

describe('fail-open contract', () => {
	it('admits when the balance read throws (RPC lane exhausted)', async () => {
		h.sponsorSolLamports.mockRejectedValue(new Error('429 rate limited'));
		const v = await admit();
		expect(v.ok).toBe(true);
		// A wallet we cannot price is not a wallet that is broke. The settle path's
		// own meter and hard SOL floor still stand behind this.
		expect(h.sql).not.toHaveBeenCalled();
	});

	it('admits when the settle ledger is unreadable', async () => {
		h.sql.mockRejectedValue(new Error('db down'));
		expect((await admit()).ok).toBe(true);
	});

	it('admits when the allowlist is unreachable and nothing was cached', async () => {
		h.ringAllowedAddresses.mockRejectedValue(new Error('db down'));
		expect((await admit()).ok).toBe(true);
	});
});

describe('verdict cache', () => {
	it('serves a refusal from cache for a minute instead of re-reading every call', async () => {
		h.sql.mockResolvedValue([{ spent: '996000' }]);
		const first = await admit();
		expect(first.ok).toBe(false);
		expect(first.cached).toBe(false);

		// The storm this collapses is ~3,700 calls an hour, all with the same answer.
		h.sponsorSolLamports.mockClear();
		for (let i = 0; i < 5; i++) {
			const v = await admit();
			expect(v.ok).toBe(false);
			expect(v.cached).toBe(true);
		}
		expect(h.sponsorSolLamports).not.toHaveBeenCalled();
	});

	it('re-reads after the refusal window so a top-up reopens the rail', async () => {
		h.sql.mockResolvedValue([{ spent: '996000' }]);
		expect((await admit()).ok).toBe(false);

		vi.setSystemTime(T0 + 60_001);
		// The wallet was topped up: same spend, much larger budget.
		h.sponsorSolLamports.mockResolvedValue(SOL_FOR_1M_BUDGET + 10_000_000);
		const v = await admit();
		expect(v.ok).toBe(true);
		expect(v.cached).toBe(false);
	});

	it('caches an admission only for the spent-read window', async () => {
		expect((await admit()).cached).toBe(false);
		expect((await admit()).cached).toBe(true);

		// An admission decays faster than a refusal: the budget drains as settles
		// land, so a stale "yes" is the dangerous direction.
		vi.setSystemTime(T0 + 20_001);
		expect((await admit()).cached).toBe(false);
	});

	it('never serves a verdict across the UTC-midnight budget reset', async () => {
		const beforeMidnight = new Date('2026-07-28T23:59:40.000Z').getTime();
		vi.setSystemTime(beforeMidnight);
		h.sql.mockResolvedValue([{ spent: '996000' }]);
		expect((await admit()).ok).toBe(false);

		// 30s later is a new UTC day: the refusal cache would still be inside its
		// 60s TTL, but the budget has reset, so the verdict must be recomputed.
		vi.setSystemTime(beforeMidnight + 30_000);
		h.sql.mockResolvedValue([{ spent: '0' }]);
		const v = await admit();
		expect(v.ok).toBe(true);
		expect(v.cached).toBe(false);
	});
});

describe('parity with the settle-path meter', () => {
	// The gate's whole value is that it predicts the settle path's answer. A laxer
	// admission re-creates the wasted handshakes it exists to remove; a stricter
	// one silently drops settles the rail could have funded. Pin them together so
	// a future change to either budget path has to move both.
	const cases = [
		{ name: 'refuses', spent: '996000', est: 5_000 },
		{ name: 'admits', spent: '100000', est: 5_000 },
		{ name: 'at the boundary', spent: '995000', est: 5_000 },
		{ name: 'with an unreadable ledger', spent: null, est: 5_000 },
	];

	for (const c of cases) {
		it(`agrees with facilitatorFeeMeter when it ${c.name}`, async () => {
			if (c.spent === null) h.sql.mockRejectedValue(new Error('db down'));
			else h.sql.mockResolvedValue([{ spent: c.spent }]);

			const meterVerdict = await facilitatorFeeMeter({ config: CFG })({
				feeWalletB58: GOV,
				solLamports: SOL_FOR_1M_BUDGET,
				estFeeLamports: c.est,
			});
			resetWalletFeeMeterCaches();
			const admissionVerdict = await admit({ estFeeLamports: c.est });

			expect(admissionVerdict.ok).toBe(meterVerdict.ok);
			expect(admissionVerdict.reason ?? null).toBe(meterVerdict.reason ?? null);
		});
	}
});
