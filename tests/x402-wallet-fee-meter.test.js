// Tests for the wallet fee meter's I/O half
// (api/_lib/x402/wallet-fee-meter.js).
//
// wallet-fee-governor.js holds the pure math (tests/x402-wallet-fee-governor
// .test.js); this file pins the I/O around it: the spent-today ledger read and
// its summation, the ~20s spent cache (including the documented multi-instance
// undercount bound and the UTC-day rollover), controlled-wallet scoping via the
// ring allowlist, the recordSettledFee optimistic debit, the refusal alert, and
// the known post-settle accounting gap in api/x402-facilitator/[action].js.
//
// DB, alerts, and the allowlist are mocked at the module boundary the way the
// neighboring x402 tests mock theirs; time is driven with vi.useFakeTimers so
// the cache-window tests never sleep.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const h = vi.hoisted(() => ({
	sql: vi.fn(),
	sendOpsAlert: vi.fn(async () => {}),
	ringAllowedAddresses: vi.fn(),
}));

vi.mock('../api/_lib/db.js', () => ({ sql: h.sql }));
vi.mock('../api/_lib/alerts.js', () => ({ sendOpsAlert: h.sendOpsAlert }));
vi.mock('../api/_lib/x402/ring-allowlist.js', () => ({
	ringAllowedAddresses: h.ringAllowedAddresses,
}));
// The meter only imports the floor constant; mocking pins it and keeps the
// heavy web3 module out of this unit test.
vi.mock('../api/_lib/x402/self-facilitator.js', () => ({
	SPONSOR_SOL_FLOOR_LAMPORTS: 20_000_000,
}));

const {
	facilitatorFeeMeter,
	recordSettledFee,
	resetWalletFeeMeterCaches,
} = await import('../api/_lib/x402/wallet-fee-meter.js');

const GOV = 'GovWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const GOV2 = 'GovWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const ORGANIC = 'OrganicBuyer111111111111111111111111111111111';

// Injected config: facilitatorFeeMeter takes it verbatim, so tests control the
// cache window and budget shape without touching process.env.
const CFG = { enabled: true, runwayDays: 1, minBudgetLamports: 0, spentCacheMs: 20_000 };

// With the mocked 0.02 SOL floor and runwayDays 1, this balance yields exactly
// a 1_000_000-lamport daily budget: (21_000_000 - 20_000_000) / 1.
const SOL_FOR_1M_BUDGET = 21_000_000;

const T0 = new Date('2026-07-28T12:00:00.000Z').getTime();

function meter(config = CFG) {
	return facilitatorFeeMeter({ config });
}

function call(fn, { feeWalletB58 = GOV, solLamports = SOL_FOR_1M_BUDGET, estFeeLamports = 5_000 } = {}) {
	return fn({ feeWalletB58, solLamports, estFeeLamports });
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
	resetWalletFeeMeterCaches();
	h.sql.mockReset().mockResolvedValue([{ spent: '0' }]);
	h.sendOpsAlert.mockReset().mockResolvedValue(undefined);
	h.ringAllowedAddresses.mockReset().mockResolvedValue(new Set([GOV, GOV2]));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('facilitatorFeeMeter construction', () => {
	it('returns null when the governor is disabled so the settle path skips metering', () => {
		expect(facilitatorFeeMeter({ config: { ...CFG, enabled: false } })).toBeNull();
	});

	it('returns a hook function when enabled', () => {
		expect(typeof meter()).toBe('function');
	});
});

describe('spent-today summation from the facilitator log', () => {
	it('queries the settle ledger scoped to the fee payer and today, and sums into the verdict', async () => {
		h.sql.mockResolvedValue([{ spent: '600000' }]);
		const v = await call(meter(), { estFeeLamports: 500_000 });
		// 600_000 spent + 500_000 next > 1_000_000 budget: the summed ledger value
		// flowed straight into the refusal reason.
		expect(v.ok).toBe(false);
		expect(v.reason).toBe('fee_runway_exhausted:600000+500000>1000000');

		expect(h.sql).toHaveBeenCalledTimes(1);
		const [strings, ...values] = h.sql.mock.calls[0];
		const text = strings.join('?');
		expect(text).toContain('SUM(fee_lamports)');
		expect(text).toContain('x402_self_facilitator_log');
		expect(text).toContain("action = 'settle'");
		expect(text).toContain('ok = true');
		expect(text).toContain("date_trunc('day', now())");
		// The only bind parameter is the governed wallet.
		expect(values).toEqual([GOV]);
	});

	it('admits while the summed spend plus the next fee fits the budget', async () => {
		h.sql.mockResolvedValue([{ spent: '400000' }]);
		const v = await call(meter(), { estFeeLamports: 500_000 });
		expect(v).toEqual({ ok: true, reason: null });
	});

	it('empty ledger (no rows) counts as zero spent', async () => {
		h.sql.mockResolvedValue([]);
		const v = await call(meter(), { estFeeLamports: 999_999 });
		expect(v.ok).toBe(true);
	});

	it('a row missing the spent column counts as zero spent', async () => {
		h.sql.mockResolvedValue([{}]);
		const v = await call(meter(), { estFeeLamports: 999_999 });
		expect(v.ok).toBe(true);
	});

	it('a non-numeric spent value fails OPEN (NaN spend admits; the SOL floor protects)', async () => {
		h.sql.mockResolvedValue([{ spent: 'not-a-number' }]);
		// Even a fee far over the budget is admitted on unknown spend.
		const v = await call(meter(), { estFeeLamports: 50_000_000 });
		expect(v).toEqual({ ok: true, reason: null });
	});

	it('a ledger read failure fails OPEN', async () => {
		h.sql.mockRejectedValue(new Error('relation does not exist'));
		const v = await call(meter(), { estFeeLamports: 50_000_000 });
		expect(v).toEqual({ ok: true, reason: null });
	});

	it('a failed read is not cached: the next call re-queries the ledger', async () => {
		h.sql.mockRejectedValueOnce(new Error('db blip'));
		await call(meter(), {});
		h.sql.mockResolvedValue([{ spent: '999000000' }]);
		const v = await call(meter(), { estFeeLamports: 500_000 });
		expect(h.sql).toHaveBeenCalledTimes(2);
		expect(v.ok).toBe(false);
	});
});

describe('the spentCacheMs cache window', () => {
	it('repeated calls inside the window serve the cached sum without re-querying', async () => {
		const fn = meter();
		await call(fn, {});
		expect(h.sql).toHaveBeenCalledTimes(1);

		vi.setSystemTime(T0 + 19_999);
		await call(fn, {});
		await call(fn, {});
		expect(h.sql).toHaveBeenCalledTimes(1);
	});

	it('after the window expires the ledger is re-summed', async () => {
		const fn = meter();
		await call(fn, {});
		expect(h.sql).toHaveBeenCalledTimes(1);

		// Exactly cacheMs later: now - at < cacheMs is false, so it re-queries.
		vi.setSystemTime(T0 + 20_000);
		await call(fn, {});
		expect(h.sql).toHaveBeenCalledTimes(2);
	});

	it('bounds the multi-instance undercount to one cache window, as documented', async () => {
		// Another instance's settles land in the ledger mid-window. This instance
		// keeps admitting on its cached (stale, lower) sum until the window rolls,
		// then sees the real spend and refuses. That is the documented bound:
		// at most one cache window of settles per instance can undercount.
		const fn = meter();
		h.sql.mockResolvedValueOnce([{ spent: '0' }]);
		await call(fn, {});

		h.sql.mockResolvedValue([{ spent: '999000000' }]);
		vi.setSystemTime(T0 + 10_000);
		const stale = await call(fn, { estFeeLamports: 500_000 });
		expect(stale.ok).toBe(true); // undercounting inside the window
		expect(h.sql).toHaveBeenCalledTimes(1);

		vi.setSystemTime(T0 + 20_001);
		const fresh = await call(fn, { estFeeLamports: 500_000 });
		expect(fresh.ok).toBe(false); // window rolled, real spend visible
	});

	it('a UTC-day rollover invalidates the cache even inside the window', async () => {
		const nearMidnight = new Date('2026-07-28T23:59:55.000Z').getTime();
		vi.setSystemTime(nearMidnight);
		const fn = meter();
		h.sql.mockResolvedValueOnce([{ spent: '900000' }]);
		await call(fn, {});
		expect(h.sql).toHaveBeenCalledTimes(1);

		// 10s later (well inside the 20s window) but a new UTC day: yesterday's
		// spend must not throttle today, so the meter re-queries.
		vi.setSystemTime(nearMidnight + 10_000);
		h.sql.mockResolvedValue([{ spent: '0' }]);
		const v = await call(fn, { estFeeLamports: 500_000 });
		expect(h.sql).toHaveBeenCalledTimes(2);
		expect(v.ok).toBe(true);
	});

	it('caches per wallet: reading one governed wallet does not warm the other', async () => {
		const fn = meter();
		await call(fn, { feeWalletB58: GOV });
		await call(fn, { feeWalletB58: GOV2 });
		expect(h.sql).toHaveBeenCalledTimes(2);
		expect(h.sql.mock.calls[0][1]).toBe(GOV);
		expect(h.sql.mock.calls[1][1]).toBe(GOV2);
	});
});

describe('controlled-wallet scoping', () => {
	it('an unknown (organic) wallet is always admitted without touching the ledger', async () => {
		const v = await call(meter(), { feeWalletB58: ORGANIC, estFeeLamports: 50_000_000 });
		expect(v).toEqual({ ok: true, reason: null });
		expect(h.sql).not.toHaveBeenCalled();
	});

	it('only the governed wallet is metered against its own budget', async () => {
		const fn = meter();
		h.sql.mockResolvedValue([{ spent: '999000000' }]);
		// Governed and over budget: refused.
		const gov = await call(fn, { feeWalletB58: GOV, estFeeLamports: 500_000 });
		expect(gov.ok).toBe(false);
		// Organic wallet with the same shape: admitted, and no ledger query was
		// issued for it (the one call above was GOV's).
		const organic = await call(fn, { feeWalletB58: ORGANIC, estFeeLamports: 500_000 });
		expect(organic.ok).toBe(true);
		expect(h.sql).toHaveBeenCalledTimes(1);
		expect(h.sql.mock.calls[0][1]).toBe(GOV);
	});

	it('an unreachable allowlist with no prior set governs nothing (fail open)', async () => {
		h.ringAllowedAddresses.mockRejectedValue(new Error('db down'));
		const v = await call(meter(), { estFeeLamports: 50_000_000 });
		expect(v).toEqual({ ok: true, reason: null });
		expect(h.sql).not.toHaveBeenCalled();
	});

	it('an allowlist blip after a prior load keeps governing with the previous set', async () => {
		const fn = meter();
		await call(fn, {});
		expect(h.ringAllowedAddresses).toHaveBeenCalledTimes(1);

		// Past the 60s allowlist TTL the refresh fails; the stale set must stay in
		// force so a DB blip does not un-govern a hot wallet mid-storm.
		vi.setSystemTime(T0 + 61_000);
		h.ringAllowedAddresses.mockRejectedValue(new Error('db blip'));
		h.sql.mockResolvedValue([{ spent: '999000000' }]);
		const v = await call(fn, { estFeeLamports: 500_000 });
		expect(v.ok).toBe(false);
	});

	it('the allowlist itself is cached across calls inside its TTL', async () => {
		const fn = meter();
		await call(fn, {});
		vi.setSystemTime(T0 + 30_000); // past the spent cache, inside the 60s allowlist TTL
		await call(fn, {});
		expect(h.ringAllowedAddresses).toHaveBeenCalledTimes(1);
		expect(h.sql).toHaveBeenCalledTimes(2);
	});
});

describe('recordSettledFee post-settle accounting', () => {
	it('debits the cached spend so a burst inside one window counts, without a DB round-trip', async () => {
		const fn = meter();
		h.sql.mockResolvedValue([{ spent: '300000' }]);
		await call(fn, {}); // warm the cache at 300_000
		expect(h.sql).toHaveBeenCalledTimes(1);

		recordSettledFee(GOV, 200_000);

		// Inside the window: cached 300_000 + recorded 200_000 = 500_000, and
		// 500_000 + 600_000 > 1_000_000 refuses. Still exactly one DB query.
		const v = await call(fn, { estFeeLamports: 600_000 });
		expect(v.ok).toBe(false);
		expect(v.reason).toBe('fee_runway_exhausted:500000+600000>1000000');
		expect(h.sql).toHaveBeenCalledTimes(1);
	});

	it('accumulates repeated settles', async () => {
		const fn = meter();
		await call(fn, {}); // cache at 0
		recordSettledFee(GOV, 400_000);
		recordSettledFee(GOV, 400_000);
		const v = await call(fn, { estFeeLamports: 300_000 });
		expect(v.reason).toBe('fee_runway_exhausted:800000+300000>1000000');
	});

	it('debits only the named wallet', async () => {
		const fn = meter();
		await call(fn, { feeWalletB58: GOV });
		await call(fn, { feeWalletB58: GOV2 });
		recordSettledFee(GOV, 900_000);

		const other = await call(fn, { feeWalletB58: GOV2, estFeeLamports: 500_000 });
		expect(other.ok).toBe(true); // GOV2 still at its own cached 0
		const gov = await call(fn, { feeWalletB58: GOV, estFeeLamports: 500_000 });
		expect(gov.ok).toBe(false);
	});

	it('coerces a numeric-string amount (ledger bigints arrive as strings)', async () => {
		const fn = meter();
		await call(fn, {});
		recordSettledFee(GOV, '700000');
		const v = await call(fn, { estFeeLamports: 500_000 });
		expect(v.reason).toBe('fee_runway_exhausted:700000+500000>1000000');
	});

	it('ignores invalid input: missing wallet, zero, negative, and NaN amounts', async () => {
		const fn = meter();
		await call(fn, {}); // cache at 0
		recordSettledFee('', 500_000);
		recordSettledFee(GOV, 0);
		recordSettledFee(GOV, -500_000);
		recordSettledFee(GOV, Number.NaN);
		recordSettledFee(GOV, 'garbage');
		const v = await call(fn, { estFeeLamports: 900_000 });
		expect(v.ok).toBe(true); // still 0 + 900_000 <= 1_000_000
	});

	it('is a no-op with no warm cache entry (the next DB sum includes the row anyway)', async () => {
		recordSettledFee(GOV, 900_000);
		h.sql.mockResolvedValue([{ spent: '0' }]);
		const v = await call(meter(), { estFeeLamports: 500_000 });
		// The pre-read record was dropped by design: the very next read re-sums
		// the ledger, where the settle's own log row already counts it.
		expect(h.sql).toHaveBeenCalledTimes(1);
		expect(v.ok).toBe(true);
	});

	it('does not debit a stale (previous-day) cache entry', async () => {
		const nearMidnight = new Date('2026-07-28T23:59:59.000Z').getTime();
		vi.setSystemTime(nearMidnight);
		const fn = meter();
		h.sql.mockResolvedValueOnce([{ spent: '900000' }]);
		await call(fn, {}); // warm on day 1

		vi.setSystemTime(nearMidnight + 2_000); // day 2
		recordSettledFee(GOV, 900_000); // must not mutate day 1's entry
		h.sql.mockResolvedValue([{ spent: '0' }]);
		const v = await call(fn, { estFeeLamports: 500_000 });
		expect(v.ok).toBe(true); // fresh day-2 read, un-poisoned by the stale debit
	});
});

describe('refusal alerting', () => {
	it('sends one throttle alert per refusal, deduped by wallet signature', async () => {
		h.sql.mockResolvedValue([{ spent: '999000000' }]);
		const v = await call(meter(), { estFeeLamports: 500_000 });
		expect(v.ok).toBe(false);
		expect(h.sendOpsAlert).toHaveBeenCalledTimes(1);
		const [title, detail, opts] = h.sendOpsAlert.mock.calls[0];
		expect(title).toContain('throttling settles');
		expect(detail).toContain(GOV);
		expect(detail).toContain('999000000');
		expect(opts).toMatchObject({ signature: `wallet-fee-governor:${GOV}`, severity: 'warn' });
	});

	it('does not alert on admission', async () => {
		const v = await call(meter(), {});
		expect(v.ok).toBe(true);
		expect(h.sendOpsAlert).not.toHaveBeenCalled();
	});

	it('an alert failure does not break the refusal verdict', async () => {
		h.sql.mockResolvedValue([{ spent: '999000000' }]);
		h.sendOpsAlert.mockRejectedValue(new Error('telegram down'));
		const v = await call(meter(), { estFeeLamports: 500_000 });
		expect(v.ok).toBe(false);
	});
});

describe('known accounting gap: recordSettledFee only fires on success', () => {
	// api/x402-facilitator/[action].js line "if (result.success) recordSettledFee
	// (result.feePayer, result.feeLamports)" only debits the in-process cache for
	// SUCCESSFUL settles. A settle that broadcasts but comes back non-success
	// (e.g. not_confirmed after the tx landed with an on-chain error) can still
	// burn real fee lamports that never debit the cached daily budget.
	//
	// This is pinned, not fixed, deliberately:
	// 1. settleRingPayment's failure results carry NO feePayer and NO feeLamports
	//    (broadcast_failed returns { success, reason }; not_confirmed adds only
	//    the signature), so a one-line change in [action].js has nothing to
	//    record. A real fix must thread fee data through the failure shapes in
	//    self-facilitator.js.
	// 2. Which failure classes actually burn fees is a judgment call:
	//    broadcast_failed with skipPreflight:false is mostly a preflight
	//    rejection that burns nothing; not_confirmed with a landed on-chain
	//    error DID burn the fee; confirm_timeout is unknowable at refusal time.
	//    Recording estFeeLamports for all of them would over-throttle the
	//    dominant (harmless) failure class.
	// 3. The undercount is bounded the same way the multi-instance one is: the
	//    ledger sum is the source of truth after each cache window, and failed
	//    settles are logged with ok=false, which the SUM query excludes, so the
	//    gap persists at most until the wallet's next successful window rollover
	//    plus however many failed-but-burned settles occur. The hard SOL floor
	//    in the settle path remains the real protection.

	it('the handler source pins the success-only guard', () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const src = readFileSync(
			path.join(here, '..', 'api', 'x402-facilitator', '[action].js'),
			'utf8',
		);
		expect(src).toMatch(/if \(result\.success\) recordSettledFee\(result\.feePayer, result\.feeLamports\);/);
	});

	it('a failed settle that burned fees leaves the cached budget undebited (CURRENT behavior)', async () => {
		const fn = meter();
		await call(fn, {}); // cache warmed at 0 spent

		// Reproduce the handler's exact post-settle contract for a settle that
		// broadcast, landed with an on-chain error (fee burned), and reported
		// non-success. Note the failure shape has no fee fields at all.
		const result = {
			success: false,
			reason: 'not_confirmed:{"InstructionError":[1,"Custom"]}',
			transaction: 'SigThatLandedWithAnError1111111111111111111',
		};
		if (result.success) recordSettledFee(result.feePayer, result.feeLamports);

		// The ~900_000 lamports actually burned by that failed settle are
		// invisible to the meter: a follow-up settle for the full remaining
		// budget is still admitted inside the cache window.
		const v = await call(fn, { estFeeLamports: 1_000_000 });
		expect(v.ok).toBe(true);

		// And because the ledger row for the failure is logged ok=false, the SUM
		// query excludes it even after the cache window rolls: the burn never
		// enters the daily budget from either path.
		vi.setSystemTime(T0 + 25_000);
		h.sql.mockResolvedValue([{ spent: '0' }]); // ok=true rows only, per the query
		const later = await call(fn, { estFeeLamports: 1_000_000 });
		expect(later.ok).toBe(true);
	});
});
