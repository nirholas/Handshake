// Pure scoring math behind /api/crypto/airdrops. Hand fixtures, no network.

import { describe, it, expect } from 'vitest';
import {
	evaluateCriterion,
	evaluateAirdrop,
	evaluateRegistry,
	summarize,
	QUALIFIED_SCORE,
	IN_PROGRESS_SCORE,
} from '../api/_lib/airdrop-eligibility.js';

const ACTIVITY = {
	family: 'solana',
	tx_count: 120,
	days_active: 45,
	account_age_days: 400,
	last_active_days: 2,
	unique_tokens: 8,
	contract_interactions: null,
	chains_active: 1,
	volume_usd: null,
};

describe('evaluateCriterion', () => {
	it('evaluates every operator', () => {
		expect(evaluateCriterion({ check: 'tx_count >= 120' }, ACTIVITY).met).toBe(true);
		expect(evaluateCriterion({ check: 'tx_count > 120' }, ACTIVITY).met).toBe(false);
		expect(evaluateCriterion({ check: 'last_active_days <= 7' }, ACTIVITY).met).toBe(true);
		expect(evaluateCriterion({ check: 'days_active < 45' }, ACTIVITY).met).toBe(false);
		expect(evaluateCriterion({ check: 'chains_active == 1' }, ACTIVITY).met).toBe(true);
	});

	it('treats an unmeasured field as unknown, never met', () => {
		const r = evaluateCriterion({ check: 'volume_usd >= 1000' }, ACTIVITY);
		expect(r.met).toBe(false);
		expect(r.unknown).toBe(true);
		expect(r.target).toBe(1000);
	});

	it('treats an unparseable or unwhitelisted check as unknown', () => {
		expect(evaluateCriterion({ check: 'spa_staked >= 1000' }, ACTIVITY).unknown).toBe(true);
		expect(evaluateCriterion({ check: 'nonsense' }, ACTIVITY).unknown).toBe(true);
		expect(evaluateCriterion({}, ACTIVITY).unknown).toBe(true);
	});
});

const ENTRY = {
	id: 'test-drop',
	name: 'Test Drop',
	chain: 'solana',
	family: 'solana',
	status: 'speculation',
	source: 'https://example.com',
	estimatedValue: '$100 - $1,000',
	criteria: [
		{ check: 'tx_count >= 50', description: '50+ transactions' },
		{ check: 'days_active >= 30', description: '30+ active days' },
		{ check: 'unique_tokens >= 20', description: '20+ tokens' },
		{ description: 'Stake in the protocol' },
	],
};

describe('evaluateAirdrop', () => {
	it('scores only checkable criteria and lists manual steps separately', () => {
		const o = evaluateAirdrop(ENTRY, ACTIVITY);
		// 2 of 3 scored criteria met; the manual step is excluded from the score.
		expect(o.score).toBe(67);
		expect(o.eligibility).toBe('in_progress');
		expect(o.met).toHaveLength(2);
		expect(o.missing).toHaveLength(1);
		expect(o.missing[0].recommendation).toMatch(/tokens/i);
		expect(o.manual).toEqual([{ description: 'Stake in the protocol' }]);
	});

	it('marks a wallet qualified at the shared threshold', () => {
		const o = evaluateAirdrop(
			{ ...ENTRY, criteria: ENTRY.criteria.slice(0, 2) },
			ACTIVITY,
		);
		expect(o.score).toBe(100);
		expect(o.score).toBeGreaterThanOrEqual(QUALIFIED_SCORE);
		expect(o.eligibility).toBe('qualified');
	});

	it('interpolates the airdrop name into recommendations', () => {
		const o = evaluateAirdrop(
			{ ...ENTRY, criteria: [{ check: 'tx_count >= 1000', description: 'lots' }] },
			ACTIVITY,
		);
		expect(o.missing[0].recommendation).toContain('Test Drop');
	});
});

describe('evaluateRegistry + summarize', () => {
	const REGISTRY = [
		ENTRY,
		{ ...ENTRY, id: 'evm-drop', name: 'EVM Drop', family: 'evm', chain: 'ethereum' },
		{
			...ENTRY,
			id: 'easy-drop',
			name: 'Easy Drop',
			estimatedValue: '$200 - $400',
			criteria: [{ check: 'tx_count >= 1', description: 'any tx' }],
		},
		{
			...ENTRY,
			id: 'hard-drop',
			name: 'Hard Drop',
			criteria: [{ check: 'tx_count >= 100000', description: 'whale only' }],
		},
	];

	it('splits the other chain family out unevaluated', () => {
		const { evaluated, otherFamily } = evaluateRegistry(REGISTRY, ACTIVITY, 'solana');
		expect(evaluated.map((o) => o.id)).not.toContain('evm-drop');
		expect(otherFamily).toHaveLength(1);
		expect(otherFamily[0].score).toBe(null);
		expect(otherFamily[0].eligibility).toBe('other_family');
	});

	it('sorts evaluated entries by score descending', () => {
		const { evaluated } = evaluateRegistry(REGISTRY, ACTIVITY, 'solana');
		expect(evaluated[0].id).toBe('easy-drop');
		expect(evaluated.at(-1).id).toBe('hard-drop');
	});

	it('summarizes counts and sums only qualified estimated ranges', () => {
		const { evaluated } = evaluateRegistry(REGISTRY, ACTIVITY, 'solana');
		const s = summarize(evaluated);
		expect(s.tracked).toBe(3);
		expect(s.qualified).toBe(1);
		expect(s.in_progress).toBe(1);
		expect(s.not_eligible).toBe(1);
		expect(s.estimatedValue).toEqual({ lo: 200, hi: 400, entries: 1 });
	});

	it('reports null estimated value when nothing qualified has a range', () => {
		const s = summarize([
			{ eligibility: 'not_eligible', estimatedValue: '$1 - $2' },
			{ eligibility: 'qualified', estimatedValue: null },
		]);
		expect(s.estimatedValue).toBe(null);
		expect(s.qualified).toBe(1);
	});

	it('keeps thresholds where the UI expects them', () => {
		expect(QUALIFIED_SCORE).toBe(80);
		expect(IN_PROGRESS_SCORE).toBe(30);
	});
});
