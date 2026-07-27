// Unit tests for the shared autonomous-purchase plumbing (api/_lib/agent-purchase.js).
//
// The important property under test is that ONE daily budget governs BOTH
// purchase surfaces: skills (/api/marketplace/purchase-as-agent, skill_purchases)
// and whole assets (/api/marketplace/buy-asset with agent_id, asset_purchases).
// Before this was shared, an agent that spent its cap on skills could turn around
// and spend the same cap again on assets.
//
// Pure logic + a mocked `sql` tag. No DB, no RPC, no signing.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls = [];
let sqlResult = [{ total: '0' }];

vi.mock('../../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		sqlCalls.push({ text: strings.join('?'), values });
		return Promise.resolve(sqlResult);
	},
}));

const {
	readPurchaseCap,
	sumDailyPurchaseAtomics,
	capExceededMessage,
	dayStartIso,
	USDC_DECIMALS,
} = await import('../../api/_lib/agent-purchase.js');

beforeEach(() => {
	sqlCalls.length = 0;
	sqlResult = [{ total: '0' }];
});

describe('readPurchaseCap', () => {
	it('is disabled when the owner has set no limit', () => {
		expect(readPurchaseCap(null).enabled).toBe(false);
		expect(readPurchaseCap({}).enabled).toBe(false);
		expect(readPurchaseCap({ auto_purchase_daily_limit_usdc: null }).enabled).toBe(false);
	});

	it('converts a dollar limit to USDC atomics', () => {
		const cap = readPurchaseCap({ auto_purchase_daily_limit_usdc: 10 });
		expect(cap.enabled).toBe(true);
		expect(cap.limitUsdc).toBe(10);
		expect(cap.limitAtomics).toBe(10_000_000n);
		expect(USDC_DECIMALS).toBe(6);
	});

	it('handles fractional limits without floating-point drift', () => {
		expect(readPurchaseCap({ auto_purchase_daily_limit_usdc: 0.07 }).limitAtomics).toBe(70_000n);
		expect(readPurchaseCap({ auto_purchase_daily_limit_usdc: 1.23 }).limitAtomics).toBe(1_230_000n);
	});

	it('treats zero, negative, NaN and non-numbers as no cap (never as a zero budget)', () => {
		// A zero-or-garbage value must not silently block every purchase; the knob
		// is opt-in, so anything that isn't a positive number means "unset".
		for (const v of [0, -5, NaN, Infinity, '10', true, {}]) {
			expect(readPurchaseCap({ auto_purchase_daily_limit_usdc: v }).enabled).toBe(false);
		}
	});
});

describe('sumDailyPurchaseAtomics', () => {
	it('sums skill AND asset purchases in one query', async () => {
		sqlResult = [{ total: '2500000' }];
		const total = await sumDailyPurchaseAtomics({ userId: 'u1', currencyMint: 'MintABC' });

		expect(total).toBe(2_500_000n);
		expect(sqlCalls).toHaveLength(1);
		const { text, values } = sqlCalls[0];
		// Both tables are counted against the same budget.
		expect(text).toContain('skill_purchases');
		expect(text).toContain('asset_purchases');
		// Each table is keyed by its own buyer column.
		expect(text).toContain('user_id =');
		expect(text).toContain('buyer_user_id =');
		// Terminal failures never consume budget; pending does (it is in flight).
		expect(text).toContain("NOT IN ('failed', 'expired')");
		expect(values).toContain('u1');
		expect(values).toContain('MintABC');
	});

	it('returns 0n when the user has spent nothing today', async () => {
		sqlResult = [{ total: '0' }];
		expect(await sumDailyPurchaseAtomics({ userId: 'u1', currencyMint: 'M' })).toBe(0n);
	});

	it('returns a BigInt for amounts beyond Number.MAX_SAFE_INTEGER', async () => {
		// USDC atomics of a large treasury purchase must not lose precision.
		sqlResult = [{ total: '9007199254740993' }];
		const total = await sumDailyPurchaseAtomics({ userId: 'u1', currencyMint: 'M' });
		expect(total).toBe(9007199254740993n);
		expect(typeof total).toBe('bigint');
	});

	it('treats a missing row as zero rather than throwing', async () => {
		sqlResult = [];
		expect(await sumDailyPurchaseAtomics({ userId: 'u1', currencyMint: 'M' })).toBe(0n);
	});

	it('scopes the window to the start of the current UTC day', async () => {
		await sumDailyPurchaseAtomics({ userId: 'u1', currencyMint: 'M' });
		const since = sqlCalls[0].values.find((v) => typeof v === 'string' && v.endsWith('T00:00:00.000Z'));
		expect(since).toBeTruthy();
		expect(since).toBe(dayStartIso());
	});
});

describe('capExceededMessage', () => {
	it('names the limit and how to change it', () => {
		const msg = capExceededMessage(10);
		expect(msg).toContain('10 USDC');
		expect(msg).toContain('auto_purchase_daily_limit_usdc');
	});
});
