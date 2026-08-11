// Reputation Staking Market — the earnings engine.
//
// These tests pin the contract in specs/REPUTATION_STAKING_MARKET.md §4-§5. The
// numbers here are the ones a staker is quoted and the ones the escrow pays, so
// a change that moves any of them is a change to what people are owed.

import { describe, it, expect } from 'vitest';

import {
	EPOCH_SECONDS,
	MIN_STAKE_LAMPORTS,
	MARKET_TAG,
	NEUTRAL_QUALITY,
	epochOf,
	epochBounds,
	epochFraction,
	positionEpochs,
	foldActions,
	agentEpochWeight,
	distributeEpoch,
	accruePosition,
	realizedApr,
	clampSettlement,
	toBigInt,
	formatSol,
} from '../src/shared/reputation-staking.js';
import { KIND_MAP, validatePayload } from '../api/_lib/solana-attestations.js';

const AGENT_A = 'THREEsynthetic1111111111111111111111111111A';
const AGENT_B = 'THREEsynthetic1111111111111111111111111111B';

/** An epoch boundary far from any real date, so the maths is readable. */
const E = 20_000;
const { start: E_START } = epochBounds(E);

const feedback = (score, taskAccepted = false) => ({
	kind: 'threews.feedback.v1',
	verified: true,
	score,
	taskAccepted,
	blockTime: E_START + 10,
});
const validation = (passed) => ({
	kind: 'threews.validation.v1',
	verified: true,
	passed,
	blockTime: E_START + 10,
});
const accept = () => ({ kind: 'threews.accept.v1', verified: true, blockTime: E_START + 10 });

describe('epochs', () => {
	it('buckets a timestamp into its UTC day', () => {
		expect(EPOCH_SECONDS).toBe(86_400);
		expect(epochOf(0)).toBe(0);
		expect(epochOf(86_399)).toBe(0);
		expect(epochOf(86_400)).toBe(1);
		expect(epochBounds(1)).toEqual({ start: 86_400, end: 172_800 });
	});

	it('credits only the fraction of the epoch a position was actually open', () => {
		// Opened at noon, still open at the end of the day: half the epoch.
		const half = epochFraction({ openedAt: E_START + EPOCH_SECONDS / 2, closedAt: null }, E, E_START + EPOCH_SECONDS);
		expect(half).toBe(0.5);
	});

	it('gives no free day to a stake placed one second before midnight', () => {
		const sliver = epochFraction({ openedAt: E_START + EPOCH_SECONDS - 1, closedAt: null }, E, E_START + EPOCH_SECONDS);
		expect(sliver).toBeCloseTo(1 / 86_400, 12);
	});

	it('never accrues past `now`, even for an open position', () => {
		const now = E_START + 3_600;
		expect(epochFraction({ openedAt: E_START, closedAt: null }, E, now)).toBe(round9(3_600 / 86_400));
	});

	it('returns zero for an epoch the position did not overlap', () => {
		expect(epochFraction({ openedAt: E_START, closedAt: E_START + 10 }, E + 5, E_START + 10 * EPOCH_SECONDS)).toBe(0);
	});

	it('enumerates every epoch a position spanned, inclusive', () => {
		const epochs = positionEpochs({ openedAt: E_START, closedAt: E_START + 2 * EPOCH_SECONDS }, E_START + 3 * EPOCH_SECONDS);
		expect(epochs).toEqual([E, E + 1, E + 2]);
	});
});

describe('foldActions', () => {
	it('weights each attested action per the spec table', () => {
		const folded = foldActions([accept(), validation(true), feedback(5, true), feedback(4, false)]);
		// 1.00 accept + 1.00 passed validation + 0.75 verified feedback + 0.35 plain feedback
		expect(folded.work).toBe(3.1);
		expect(folded.faults).toBe(0);
		expect(folded.feedbackCount).toBe(2);
	});

	it('charges faults for failed validations, disputes and revocations', () => {
		const folded = foldActions([
			validation(false),
			{ kind: 'threews.dispute.v1', verified: true },
			{ kind: 'threews.revoke.v1', verified: true },
		]);
		expect(folded.work).toBe(0);
		expect(folded.faults).toBe(3);
	});

	it('counts conviction as worth nothing, so the market cannot pay itself', () => {
		const folded = foldActions([
			{ kind: 'threews.stake.v1', verified: true, score: 5 },
			{ kind: 'threews.unstake.v1', verified: true },
		]);
		expect(folded.work).toBe(0);
		expect(folded.faults).toBe(0);
	});

	it('ignores unverified rows and unknown kinds', () => {
		const folded = foldActions([
			{ kind: 'threews.accept.v1', verified: false },
			{ kind: 'threews.future-kind.v9', verified: true },
		]);
		expect(folded.work).toBe(0);
	});
});

describe('agentEpochWeight', () => {
	it('treats an agent with no feedback as neutral quality, not as bad', () => {
		const w = agentEpochWeight([accept(), accept()]);
		expect(w.quality).toBe(NEUTRAL_QUALITY);
		expect(w.integrity).toBe(1);
		// 0.5 * log2(1 + 2)
		expect(w.weight).toBeCloseTo(0.5 * Math.log2(3), 8);
	});

	it('maps the 1-5 feedback scale onto [0, 1]', () => {
		expect(agentEpochWeight([feedback(1)]).quality).toBe(0);
		expect(agentEpochWeight([feedback(3)]).quality).toBe(0.5);
		expect(agentEpochWeight([feedback(5)]).quality).toBe(1);
	});

	it('charges a fault at double the rate work is credited', () => {
		// work 1.0 (one passed validation), faults 1.0 (one failed) => 1 / (1 + 2)
		const w = agentEpochWeight([validation(true), validation(false)]);
		expect(w.integrity).toBeCloseTo(1 / 3, 9);
	});

	it('pays nothing for an idle epoch', () => {
		expect(agentEpochWeight([]).weight).toBe(0);
	});

	it('is concave in activity, so spraying attestations does not buy proportional yield', () => {
		const ten = agentEpochWeight(Array.from({ length: 10 }, accept)).weight;
		const twenty = agentEpochWeight(Array.from({ length: 20 }, accept)).weight;
		expect(twenty).toBeGreaterThan(ten);
		expect(twenty).toBeLessThan(ten * 2);
	});
});

describe('distributeEpoch', () => {
	const positions = [
		{ id: 'a', agentAsset: AGENT_A, principalLamports: 1_000_000_000n, openedAt: E_START, closedAt: null },
		{ id: 'b', agentAsset: AGENT_A, principalLamports: 3_000_000_000n, openedAt: E_START, closedAt: null },
	];

	it('splits an agent share strictly in proportion to principal', () => {
		const { payouts } = distributeEpoch({
			epoch: E,
			positions,
			agentWeights: new Map([[AGENT_A, 1]]),
			poolLamports: 4_000_000n,
			now: E_START + EPOCH_SECONDS,
		});
		expect(payouts.get('a').lamports).toBe(1_000_000n);
		expect(payouts.get('b').lamports).toBe(3_000_000n);
	});

	it('never distributes more than the pool', () => {
		const { payouts, distributed } = distributeEpoch({
			epoch: E,
			positions: [
				...positions,
				{ id: 'c', agentAsset: AGENT_A, principalLamports: 7n, openedAt: E_START, closedAt: null },
			],
			agentWeights: new Map([[AGENT_A, 1]]),
			poolLamports: 1_000_001n,
			now: E_START + EPOCH_SECONDS,
		});
		const sum = [...payouts.values()].reduce((acc, v) => acc + v.lamports, 0n);
		expect(sum).toBe(distributed);
		expect(sum).toBeLessThanOrEqual(1_000_001n);
	});

	it('pays a staker of an idle agent nothing while a working agent still earns', () => {
		const { payouts } = distributeEpoch({
			epoch: E,
			positions: [
				{ id: 'working', agentAsset: AGENT_A, principalLamports: 1_000_000_000n, openedAt: E_START, closedAt: null },
				{ id: 'idle', agentAsset: AGENT_B, principalLamports: 1_000_000_000n, openedAt: E_START, closedAt: null },
			],
			agentWeights: new Map([
				[AGENT_A, 1],
				[AGENT_B, 0],
			]),
			poolLamports: 1_000_000n,
			now: E_START + EPOCH_SECONDS,
		});
		expect(payouts.get('working').lamports).toBe(1_000_000n);
		expect(payouts.get('idle').lamports).toBe(0n);
	});

	it('pays nothing at all when the pool is unfunded', () => {
		const { payouts } = distributeEpoch({
			epoch: E,
			positions,
			agentWeights: new Map([[AGENT_A, 1]]),
			poolLamports: 0n,
			now: E_START + EPOCH_SECONDS,
		});
		expect(payouts.get('a').lamports).toBe(0n);
		expect(payouts.get('a').posWeight).toBeGreaterThan(0);
	});

	it('halves the share of a position that was only open for half the epoch', () => {
		const { payouts } = distributeEpoch({
			epoch: E,
			positions: [
				{ id: 'full', agentAsset: AGENT_A, principalLamports: 1_000_000_000n, openedAt: E_START, closedAt: null },
				{
					id: 'half',
					agentAsset: AGENT_A,
					principalLamports: 1_000_000_000n,
					openedAt: E_START + EPOCH_SECONDS / 2,
					closedAt: null,
				},
			],
			agentWeights: new Map([[AGENT_A, 1]]),
			poolLamports: 3_000_000n,
			now: E_START + EPOCH_SECONDS,
		});
		expect(payouts.get('full').lamports).toBe(2_000_000n);
		expect(payouts.get('half').lamports).toBe(1_000_000n);
	});
});

describe('accruePosition', () => {
	it('sums a position across every epoch it overlapped', () => {
		const position = { id: 'a', agentAsset: AGENT_A, principalLamports: 1_000_000_000n, openedAt: E_START, closedAt: null };
		const cohort = [position];
		const agentWeights = new Map([[AGENT_A, 1]]);
		const epochInputs = new Map([
			[E, { poolLamports: 1_000_000n, positions: cohort, agentWeights }],
			[E + 1, { poolLamports: 1_000_000n, positions: cohort, agentWeights }],
		]);
		const { lamports, byEpoch } = accruePosition({ position, epochInputs, now: E_START + 2 * EPOCH_SECONDS });
		expect(lamports).toBe(2_000_000n);
		expect(byEpoch.map((r) => r.epoch)).toEqual([E, E + 1]);
	});

	it('stops accruing the moment the position closes', () => {
		const position = {
			id: 'a',
			agentAsset: AGENT_A,
			principalLamports: 1_000_000_000n,
			openedAt: E_START,
			closedAt: E_START + EPOCH_SECONDS,
		};
		const agentWeights = new Map([[AGENT_A, 1]]);
		const epochInputs = new Map([
			[E, { poolLamports: 1_000_000n, positions: [position], agentWeights }],
			[E + 1, { poolLamports: 1_000_000n, positions: [position], agentWeights }],
		]);
		const { lamports } = accruePosition({ position, epochInputs, now: E_START + 5 * EPOCH_SECONDS });
		expect(lamports).toBe(1_000_000n);
	});
});

describe('realizedApr', () => {
	it('annualises what actually accrued, never a projection', () => {
		const apr = realizedApr({
			principalLamports: 1_000_000_000n,
			earningsLamports: 10_000_000n,
			openedAt: E_START,
			closedAt: E_START + 365 * EPOCH_SECONDS,
			now: E_START + 365 * EPOCH_SECONDS,
		});
		expect(apr).toBeCloseTo(0.01, 9);
	});

	it('is zero before any time has passed', () => {
		expect(realizedApr({ principalLamports: 1n, earningsLamports: 1n, openedAt: E_START, closedAt: E_START, now: E_START })).toBe(0);
	});
});

describe('clampSettlement', () => {
	it('returns principal in full even when the reward surplus is empty', () => {
		const s = clampSettlement({ principalLamports: 5_000_000n, earningsLamports: 900n, surplusLamports: 0n });
		expect(s.principal).toBe(5_000_000n);
		expect(s.earnings).toBe(0n);
		expect(s.clamped).toBe(true);
	});

	it('pays earnings whole when the surplus covers them', () => {
		const s = clampSettlement({ principalLamports: 5_000_000n, earningsLamports: 900n, surplusLamports: 10_000n });
		expect(s.earnings).toBe(900n);
		expect(s.clamped).toBe(false);
	});
});

describe('lamport helpers', () => {
	it('parses decimal strings past Number.MAX_SAFE_INTEGER without loss', () => {
		expect(toBigInt('9007199254740993')).toBe(9007199254740993n);
		expect(toBigInt('not a number')).toBe(0n);
	});

	it('formats lamports as SOL', () => {
		expect(formatSol(1_500_000_000n)).toBe('1.5000');
	});

	it('pins the market constants the wire format depends on', () => {
		expect(MIN_STAKE_LAMPORTS).toBe(1_000_000n);
		expect(MARKET_TAG).toBe('rsm.v1');
	});
});

describe('registry extension: threews.unstake.v1', () => {
	const SIG = '5'.repeat(88);

	it('is a registered attestation kind', () => {
		expect(KIND_MAP.unstake).toBe('threews.unstake.v1');
	});

	it('accepts a well-formed unstake envelope', () => {
		expect(
			validatePayload({
				v: 1,
				kind: 'threews.unstake.v1',
				agent: AGENT_A,
				stake: SIG,
				principal: '1000000',
			}),
		).toBe(true);
	});

	it('rejects a principal sent as a number instead of a decimal string', () => {
		expect(
			validatePayload({ v: 1, kind: 'threews.unstake.v1', agent: AGENT_A, stake: SIG, principal: 1_000_000 }),
		).toBe(false);
	});

	it('rejects an envelope that names no stake', () => {
		expect(validatePayload({ v: 1, kind: 'threews.unstake.v1', agent: AGENT_A, principal: '1' })).toBe(false);
	});
});

function round9(n) {
	return Math.round(n * 1e9) / 1e9;
}
