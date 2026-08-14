// Reputation Staking Market: net conviction (spec §3.3).
//
// `GET /api/agents/solana-reputation` reports what is STILL staked behind an
// agent, not what was ever staked. A settled position's conviction is retired the
// moment the escrow's threews.unstake.v1 memo lands, so these tests pin the one
// rule that keeps the reputation card honest: withdrawn conviction is not
// conviction.
//
// Invariants under test:
//   1. A stake with no settlement counts in full.
//   2. A settled stake stops counting, and stops counting for its staker.
//   3. Retirement is clamped per stake signature, so an over-stated settlement
//      can never eat a different staker's conviction or drive the total negative.
//   4. Duplicate settlements naming one stake retire it once, never twice.
//   5. Gross is still reported alongside net, so the history is not erased.
//   6. Lamport values survive past Number.MAX_SAFE_INTEGER.

import { describe, it, expect } from 'vitest';

import { netConviction } from '../api/_lib/reputation-market.js';

const ALICE = 'THREEsyntheticStaker11111111111111111Alice';
const BOB = 'THREEsyntheticStaker11111111111111111111Bob';
const SIG_A = 'a'.repeat(88);
const SIG_B = 'b'.repeat(88);
const SIG_C = 'c'.repeat(88);

const stake = (signature, attester, lamports, score = 4) => ({ signature, attester, lamports, score });
const retire = (stake_signature, principal) => ({ stake_signature, principal });

describe('netConviction', () => {
	it('counts an unsettled stake in full', () => {
		const out = netConviction({ stakes: [stake(SIG_A, ALICE, '2000000')], retirements: [] });
		expect(out.total_lamports).toBe('2000000');
		expect(out.gross_lamports).toBe('2000000');
		expect(out.retired_lamports).toBe('0');
		expect(out.count).toBe(1);
		expect(out.unique_stakers).toBe(1);
		expect(out.top_stakers).toEqual([{ attester: ALICE, lamports: '2000000', score: 4 }]);
	});

	it('retires a settled stake from the total and from its staker', () => {
		const out = netConviction({
			stakes: [stake(SIG_A, ALICE, '2000000'), stake(SIG_B, BOB, '3000000')],
			retirements: [retire(SIG_A, '2000000')],
		});
		expect(out.total_lamports).toBe('3000000');
		expect(out.gross_lamports).toBe('5000000');
		expect(out.retired_lamports).toBe('2000000');
		expect(out.retired_count).toBe(1);
		expect(out.count).toBe(1);
		expect(out.top_stakers).toEqual([{ attester: BOB, lamports: '3000000', score: 4 }]);
	});

	it('reports zero once every position is settled, never a negative', () => {
		const out = netConviction({
			stakes: [stake(SIG_A, ALICE, '2000000')],
			retirements: [retire(SIG_A, '9000000')],
		});
		expect(out.total_lamports).toBe('0');
		expect(out.retired_lamports).toBe('2000000');
		expect(out.count).toBe(0);
		expect(out.unique_stakers).toBe(0);
		expect(out.top_stakers).toEqual([]);
	});

	it('clamps an over-stated settlement to its own stake, leaving others whole', () => {
		const out = netConviction({
			stakes: [stake(SIG_A, ALICE, '1000000'), stake(SIG_B, BOB, '4000000')],
			retirements: [retire(SIG_A, '99000000')],
		});
		expect(out.total_lamports).toBe('4000000');
		expect(out.top_stakers).toEqual([{ attester: BOB, lamports: '4000000', score: 4 }]);
	});

	it('retires a stake once even when two settlements name it', () => {
		const out = netConviction({
			stakes: [stake(SIG_A, ALICE, '5000000')],
			retirements: [retire(SIG_A, '2000000'), retire(SIG_A, '2000000')],
		});
		expect(out.total_lamports).toBe('3000000');
		expect(out.retired_lamports).toBe('2000000');
		expect(out.retired_count).toBe(1);
	});

	it('ignores a settlement naming a stake this agent never received', () => {
		const out = netConviction({
			stakes: [stake(SIG_A, ALICE, '2000000')],
			retirements: [retire(SIG_C, '2000000')],
		});
		expect(out.total_lamports).toBe('2000000');
		expect(out.retired_count).toBe(0);
	});

	it('sums a staker who holds several positions and drops only the settled one', () => {
		const out = netConviction({
			stakes: [stake(SIG_A, ALICE, '1000000', 5), stake(SIG_B, ALICE, '2000000', 3), stake(SIG_C, BOB, '1500000')],
			retirements: [retire(SIG_A, '1000000')],
		});
		expect(out.total_lamports).toBe('3500000');
		expect(out.unique_stakers).toBe(2);
		expect(out.top_stakers).toEqual([
			{ attester: ALICE, lamports: '2000000', score: 3 },
			{ attester: BOB, lamports: '1500000', score: 4 },
		]);
	});

	it('carries lamport values past Number.MAX_SAFE_INTEGER without loss', () => {
		const out = netConviction({
			stakes: [stake(SIG_A, ALICE, '9007199254740993')],
			retirements: [retire(SIG_A, '1')],
		});
		expect(out.total_lamports).toBe('9007199254740992');
	});

	it('answers an empty market with zeroes rather than throwing', () => {
		const out = netConviction();
		expect(out).toEqual({
			total_lamports: '0',
			count: 0,
			unique_stakers: 0,
			gross_lamports: '0',
			retired_lamports: '0',
			retired_count: 0,
			top_stakers: [],
		});
	});
});
