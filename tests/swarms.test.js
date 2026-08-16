/**
 * Trading-swarm pure logic — consensus tally + policy normalization.
 *
 * computeConsensus and normalizeSwarmPolicy are pure (no DB, no network), so the
 * reputation-weighting math and the policy guardrails are asserted directly here.
 */

import { describe, it, expect } from 'vitest';
import { computeConsensus, normalizeSwarmPolicy, parseContributionLamports, SwarmError } from '../api/_lib/swarms.js';

describe('computeConsensus', () => {
	const members = [
		{ agent_id: 'a', name: 'A', reputation: 80 }, // proven
		{ agent_id: 'b', name: 'B', reputation: 40 },
		{ agent_id: 'c', name: 'C', reputation: 0 }, // no track record → floor weight 5
	];
	const policy = normalizeSwarmPolicy({});

	it('weights agreement by reputation, not headcount', () => {
		// Only the proven member (weight 80) is long; total weight = 80+40+5 = 125.
		const r = computeConsensus({ members, longAgentIds: ['a'], policy });
		expect(r.members_long).toBe(1);
		expect(r.members_total).toBe(3);
		expect(r.consensus).toBeCloseTo(80 / 125, 5);
	});

	it('reaches full consensus when every member is long', () => {
		const r = computeConsensus({ members, longAgentIds: ['a', 'b', 'c'], policy });
		expect(r.consensus).toBe(1);
	});

	it('gives a zero-reputation member a non-zero floor weight', () => {
		// Only C (rep 0 → weight 5) long → 5/125.
		const r = computeConsensus({ members, longAgentIds: ['c'], policy });
		expect(r.consensus).toBeCloseTo(5 / 125, 5);
		expect(r.consensus).toBeGreaterThan(0);
	});

	it('lets smart-money lift conviction above raw consensus but never above 1', () => {
		const base = computeConsensus({ members, longAgentIds: ['a'], smartMoneyScore: 0, policy });
		const lifted = computeConsensus({ members, longAgentIds: ['a'], smartMoneyScore: 100, policy });
		expect(lifted.conviction).toBeGreaterThan(base.conviction);
		expect(lifted.conviction).toBeLessThanOrEqual(1);
		// Consensus itself is unchanged — smart-money scales conviction, not the vote.
		expect(lifted.consensus).toBe(base.consensus);
	});

	it('returns zero with no members', () => {
		const r = computeConsensus({ members: [], longAgentIds: [], policy });
		expect(r.consensus).toBe(0);
		expect(r.conviction).toBe(0);
	});

	it('emits a per-member breakdown for the audit log', () => {
		const r = computeConsensus({ members, longAgentIds: ['a', 'b'], policy });
		expect(r.breakdown).toHaveLength(3);
		expect(r.breakdown.find((x) => x.agent_id === 'a').long).toBe(true);
		expect(r.breakdown.find((x) => x.agent_id === 'c').long).toBe(false);
	});
});

describe('normalizeSwarmPolicy', () => {
	it('applies sane defaults', () => {
		const p = normalizeSwarmPolicy({});
		expect(p.min_consensus).toBe(0.6);
		expect(p.creator_fee_bps).toBe(0);
		expect(p.max_member_share_bps).toBe(5000);
		expect(p.exit_policy).toBe('settle_at_mark');
		expect(p.join_open).toBe(true);
		expect(p.firewall_level).toBe('block');
	});

	it('clamps min_consensus into [0.05, 1]', () => {
		expect(normalizeSwarmPolicy({ min_consensus: 5 }).min_consensus).toBe(1);
		expect(normalizeSwarmPolicy({ min_consensus: -1 }).min_consensus).toBe(0.05);
	});

	it('caps the creator fee at 20% and the member share floor at 10%', () => {
		expect(normalizeSwarmPolicy({ creator_fee_bps: 9999 }).creator_fee_bps).toBe(2000);
		expect(normalizeSwarmPolicy({ max_member_share_bps: 1 }).max_member_share_bps).toBe(1000);
	});

	it('never lets the daily budget fall below one max-per-trade', () => {
		const p = normalizeSwarmPolicy({ max_per_trade_lamports: 100_000_000, daily_budget_lamports: 1 });
		expect(BigInt(p.daily_budget_lamports)).toBeGreaterThanOrEqual(BigInt(p.max_per_trade_lamports));
	});

	it('only accepts the two documented exit policies', () => {
		expect(normalizeSwarmPolicy({ exit_policy: 'wait_to_close' }).exit_policy).toBe('wait_to_close');
		expect(normalizeSwarmPolicy({ exit_policy: 'nonsense' }).exit_policy).toBe('settle_at_mark');
	});
});

describe('parseContributionLamports', () => {
	// The amount a POST /api/swarms contribute moves on-chain. Anything this lets
	// through is signed for, and anything it throws must be a 400 the caller can
	// read, never a RangeError escaping as a 500.
	const reject = (body) => {
		let caught = null;
		try { parseContributionLamports(body); } catch (e) { caught = e; }
		expect(caught).toBeInstanceOf(SwarmError);
		expect(caught.status).toBe(400);
		expect(caught.code).toBe('bad_amount');
		return caught;
	};

	it('reads an explicit lamport count', () => {
		expect(parseContributionLamports({ lamports: 25_000_000 })).toBe(25_000_000n);
		expect(parseContributionLamports({ lamports: '25000000' })).toBe(25_000_000n);
	});

	it('converts SOL to lamports', () => {
		expect(parseContributionLamports({ sol: 0.025 })).toBe(25_000_000n);
		expect(parseContributionLamports({ sol: '1.5' })).toBe(1_500_000_000n);
	});

	it('prefers lamports when a body carries both', () => {
		expect(parseContributionLamports({ lamports: 7_000_000, sol: 99 })).toBe(7_000_000n);
	});

	it('rejects a non-numeric amount instead of throwing a RangeError', () => {
		// BigInt(NaN) throws RangeError, which used to escape wrap() as a 500
		// internal_error (plus a Sentry capture and an ops alert) on a caller typo.
		reject({ lamports: 'abc' });
		reject({ sol: 'abc' });
		reject({ lamports: {} });
	});

	it('rejects a non-finite amount', () => {
		reject({ sol: Infinity });
		reject({ lamports: -Infinity });
	});

	it('rejects an amount past the safe-integer range', () => {
		// 1e30 SOL is 1e39 lamports, and a double can no longer name that exact
		// integer, so the amount signed for would not be the amount requested.
		reject({ sol: 1e30 });
		reject({ lamports: Number.MAX_SAFE_INTEGER + 100 });
	});

	it('rejects zero, negative, and missing amounts', () => {
		reject({ lamports: 0 });
		reject({ sol: 0 });
		reject({ lamports: -5_000_000 });
		reject({});
		reject({ lamports: null, sol: null });
		reject(undefined);
	});
});
