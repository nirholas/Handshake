// Tests for api/_lib/skill-royalty.js: the per-call author royalty split
// (pure math) plus the royalty_ledger accrual writer, and for the
// SKILL_ROYALTIES_EVM_7710_ENABLED flag gate on the EIP-7710 redeem leg in
// api/_lib/royalty.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sqlMock = vi.fn(() => Promise.resolve([{ id: 'ledger-1' }]));
vi.mock('../api/_lib/db.js', () => ({ sql: sqlMock }));

const {
	computeSkillRoyaltySplit,
	skillRoyaltyPlatformBps,
	accrueSkillCallRoyalty,
	SKILL_ROYALTY_DEFAULT_PLATFORM_BPS,
	SKILL_ROYALTY_MAX_PLATFORM_BPS,
} = await import('../api/_lib/skill-royalty.js');

beforeEach(() => {
	sqlMock.mockClear();
	sqlMock.mockResolvedValue([{ id: 'ledger-1' }]);
	delete process.env.X402_SKILL_ROYALTY_PLATFORM_BPS;
});

afterEach(() => {
	delete process.env.X402_SKILL_ROYALTY_PLATFORM_BPS;
});

describe('skillRoyaltyPlatformBps', () => {
	it('defaults to the marketplace fee rate (250 bps)', () => {
		expect(SKILL_ROYALTY_DEFAULT_PLATFORM_BPS).toBe(250);
		expect(skillRoyaltyPlatformBps({})).toBe(250);
	});

	it('honors a valid env override', () => {
		expect(skillRoyaltyPlatformBps({ X402_SKILL_ROYALTY_PLATFORM_BPS: '500' })).toBe(500);
	});

	it('clamps an out-of-range override to the max', () => {
		expect(skillRoyaltyPlatformBps({ X402_SKILL_ROYALTY_PLATFORM_BPS: '9000' })).toBe(
			SKILL_ROYALTY_MAX_PLATFORM_BPS,
		);
	});

	it('falls back to the default on garbage or negative input', () => {
		expect(skillRoyaltyPlatformBps({ X402_SKILL_ROYALTY_PLATFORM_BPS: 'abc' })).toBe(250);
		expect(skillRoyaltyPlatformBps({ X402_SKILL_ROYALTY_PLATFORM_BPS: '-5' })).toBe(250);
	});
});

describe('computeSkillRoyaltySplit', () => {
	it('splits a 0.01 USDC call at the default 2.5% platform rate', () => {
		const s = computeSkillRoyaltySplit({ priceAtomics: 10_000n });
		expect(s.platformAtomics).toBe(250n);
		expect(s.authorAtomics).toBe(9_750n);
		expect(s.authorUsd).toBeCloseTo(0.00975, 9);
		expect(s.platformUsd).toBeCloseTo(0.00025, 9);
	});

	it('conserves value: author + platform === price for many inputs', () => {
		const prices = [1n, 7n, 999n, 10_000n, 1_000_000n, 3_333_333n, 123_456_789n];
		const rates = [0, 1, 250, 1000, 5000];
		for (const p of prices) {
			for (const r of rates) {
				const s = computeSkillRoyaltySplit({ priceAtomics: p, platformBps: r });
				expect(s.authorAtomics + s.platformAtomics).toBe(p);
				expect(s.authorAtomics >= 0n).toBe(true);
				expect(s.platformAtomics >= 0n).toBe(true);
			}
		}
	});

	it('the author rounds up on odd atomics (platform absorbs rounding dust)', () => {
		// 3 atomics at 33%: floor(3*3333/10000)=0 platform, author keeps all 3.
		const s = computeSkillRoyaltySplit({ priceAtomics: 3n, platformBps: 3333 });
		expect(s.platformAtomics).toBe(0n);
		expect(s.authorAtomics).toBe(3n);
	});

	it('a 0 bps rate pays the author everything', () => {
		const s = computeSkillRoyaltySplit({ priceAtomics: 1_000_000n, platformBps: 0 });
		expect(s.platformAtomics).toBe(0n);
		expect(s.authorAtomics).toBe(1_000_000n);
	});

	it('clamps a platform rate above the hard max', () => {
		const s = computeSkillRoyaltySplit({ priceAtomics: 1_000_000n, platformBps: 9999 });
		expect(s.platformBps).toBe(SKILL_ROYALTY_MAX_PLATFORM_BPS);
		expect(s.platformAtomics).toBe(500_000n);
		expect(s.authorAtomics).toBe(500_000n);
	});

	it('coerces string and number prices and rejects garbage', () => {
		expect(computeSkillRoyaltySplit({ priceAtomics: '1000000' }).authorAtomics).toBe(975_000n);
		expect(computeSkillRoyaltySplit({ priceAtomics: 10_000 }).priceAtomics).toBe(10_000n);
		expect(computeSkillRoyaltySplit({ priceAtomics: 'not-a-number' }).priceAtomics).toBe(0n);
		expect(computeSkillRoyaltySplit({ priceAtomics: -5 }).priceAtomics).toBe(0n);
	});
});

describe('accrueSkillCallRoyalty', () => {
	const base = {
		skillId: '11111111-1111-1111-1111-111111111111',
		authorId: '22222222-2222-2222-2222-222222222222',
		payer: 'BuyerWallet111',
		network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
		txHash: 'sig-abc',
	};

	it('inserts a settled x402 accrual row with provenance and returns the split', async () => {
		const out = await accrueSkillCallRoyalty({ ...base, priceAtomics: 10_000n });
		expect(out.ok).toBe(true);
		expect(out.accrual.authorAtomics).toBe(9_750n);
		expect(out.accrual.platformAtomics).toBe(250n);
		expect(out.accrual.ledgerId).toBe('ledger-1');

		expect(sqlMock).toHaveBeenCalledTimes(1);
		const [strings, ...values] = sqlMock.mock.calls[0];
		const text = strings.join('?');
		expect(text).toMatch(/INSERT INTO royalty_ledger/i);
		// author share (0.00975) then platform fee (0.00025) land as USD values.
		expect(values).toContain(base.skillId);
		expect(values).toContain(null); // agent_id is null for x402 callers
		expect(values).toContain(base.authorId);
		expect(values).toContain(0.00975);
		expect(values).toContain('settled');
		expect(values).toContain('sig-abc');
		expect(values).toContain('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
		expect(values).toContain('BuyerWallet111');
		expect(values).toContain('x402');
		expect(values).toContain(0.00025);
	});

	it('refuses to write without a skill or author', async () => {
		expect((await accrueSkillCallRoyalty({ ...base, skillId: null, priceAtomics: 10_000n })).ok).toBe(false);
		expect((await accrueSkillCallRoyalty({ ...base, authorId: null, priceAtomics: 10_000n })).ok).toBe(false);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('skips a zero-price call without writing', async () => {
		const out = await accrueSkillCallRoyalty({ ...base, priceAtomics: 0n });
		expect(out.ok).toBe(false);
		expect(out.reason).toBe('zero_price');
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('never throws when the insert fails (fire-and-forget contract)', async () => {
		sqlMock.mockRejectedValueOnce(new Error('neon down'));
		const out = await accrueSkillCallRoyalty({ ...base, priceAtomics: 10_000n });
		expect(out.ok).toBe(false);
		expect(out.reason).toMatch(/neon down/);
	});
});

describe('settle-royalties EVM flag gate (api/_lib/royalty.js)', () => {
	afterEach(() => {
		delete process.env.SKILL_ROYALTIES_EVM_7710_ENABLED;
		vi.resetModules();
	});

	it('settleAllPendingRoyalties is a no-op while the flag is off', async () => {
		delete process.env.SKILL_ROYALTIES_EVM_7710_ENABLED;
		vi.resetModules();
		sqlMock.mockClear();
		const { settleAllPendingRoyalties } = await import('../api/_lib/royalty.js');
		const report = await settleAllPendingRoyalties();
		expect(report).toMatchObject({ settled: 0, failed: 0, authors: 0, skipped: true });
		// No author lookup query ever runs while the leg is gated.
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('settleRoyalties skips an author while the flag is off', async () => {
		process.env.SKILL_ROYALTIES_EVM_7710_ENABLED = 'false';
		vi.resetModules();
		sqlMock.mockClear();
		const { settleRoyalties } = await import('../api/_lib/royalty.js');
		const report = await settleRoyalties('22222222-2222-2222-2222-222222222222');
		expect(report).toMatchObject({ skipped: true, reason: 'evm_7710_disabled' });
		expect(sqlMock).not.toHaveBeenCalled();
	});
});
