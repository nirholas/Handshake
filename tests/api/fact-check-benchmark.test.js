// Tests for the fact-check accuracy benchmark (prompt 20 core: the checkable
// quality bar) — the curated fixture's schema/coverage and the runner's pure
// scoring math, which ship independent of the live LLM chain.
//
// Kept separate from tests/api/fact-check-v2.test.js (the free-lane/quota suite
// owned by the concurrent storefront work) so the two layer cleanly.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	isDegraded,
	runClaims,
	scoreResults,
	validateFixture,
} from '../../api/_lib/fact-check-benchmark.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(HERE, '../fixtures/fact-check-benchmark.json'), 'utf8'));

const CLASSES = ['supported', 'contradicted', 'mixed', 'insufficient'];

describe('fact-check benchmark fixture', () => {
	it('has ≥40 claims with ≥10 per verdict class and passes validation', () => {
		const claims = validateFixture(fixture); // throws if malformed
		expect(claims.length).toBeGreaterThanOrEqual(40);
		for (const cls of CLASSES) {
			expect(claims.filter((c) => c.expected_verdict === cls).length).toBeGreaterThanOrEqual(10);
		}
	});

	it('every claim is fully specified (claim, expected_verdict, rationale, difficulty)', () => {
		for (const c of fixture.claims) {
			expect(typeof c.claim).toBe('string');
			expect(c.claim.length).toBeGreaterThan(0);
			expect(CLASSES).toContain(c.expected_verdict);
			expect(typeof c.rationale).toBe('string');
			expect(['easy', 'medium', 'hard']).toContain(c.difficulty);
		}
	});

	it('rejects a fixture that starves a verdict class (≥40 total but <10 mixed)', () => {
		// Keep the full 40 so the count check passes, then reclassify every mixed
		// claim as supported — the per-class floor for "mixed" must still fail.
		const broken = { claims: fixture.claims.map((c) => (c.expected_verdict === 'mixed' ? { ...c, expected_verdict: 'supported' } : c)) };
		expect(() => validateFixture(broken)).toThrow(/mixed/);
	});

	it('rejects a fixture with an invalid verdict', () => {
		const broken = { claims: [...fixture.claims, { claim: 'x', expected_verdict: 'nonsense', rationale: 'y', difficulty: 'easy' }] };
		expect(() => validateFixture(broken)).toThrow(/invalid/);
	});
});

describe('scoreResults', () => {
	const results = [
		{ claim: 'a', expected_verdict: 'supported', difficulty: 'easy', actual_verdict: 'supported' },
		{ claim: 'b', expected_verdict: 'contradicted', difficulty: 'medium', actual_verdict: 'contradicted' },
		{ claim: 'c', expected_verdict: 'mixed', difficulty: 'hard', actual_verdict: 'supported' }, // miss
		{ claim: 'd', expected_verdict: 'insufficient', difficulty: 'easy', actual_verdict: null }, // error
	];

	it('computes overall accuracy, correct count, and error count', () => {
		const s = scoreResults(results);
		expect(s.total).toBe(4);
		expect(s.correct).toBe(2);
		expect(s.errors).toBe(1);
		expect(s.accuracy_pct).toBe(50);
	});

	it('breaks accuracy down per verdict class', () => {
		const s = scoreResults(results);
		expect(s.by_class.supported).toEqual({ total: 1, correct: 1, accuracy_pct: 100 });
		expect(s.by_class.mixed).toEqual({ total: 1, correct: 0, accuracy_pct: 0 });
		expect(s.by_class.insufficient).toEqual({ total: 1, correct: 0, accuracy_pct: 0 });
	});

	it('breaks accuracy down per difficulty', () => {
		const s = scoreResults(results);
		expect(s.by_difficulty.easy.total).toBe(2);
		expect(s.by_difficulty.easy.correct).toBe(1);
		expect(s.by_difficulty.hard).toEqual({ total: 1, correct: 0, accuracy_pct: 0 });
	});

	it('builds an expected→actual confusion matrix over checked claims only', () => {
		const s = scoreResults(results);
		expect(s.confusion.supported.supported).toBe(1);
		expect(s.confusion.mixed.supported).toBe(1);
		expect(s.confusion.insufficient).toEqual({}); // null actual excluded
	});

	it('scores a perfect run at 100% and an all-error run at 0%', () => {
		const perfect = fixture.claims.map((c) => ({ ...c, actual_verdict: c.expected_verdict }));
		expect(scoreResults(perfect).accuracy_pct).toBe(100);
		const zero = fixture.claims.map((c) => ({ ...c, actual_verdict: null }));
		expect(scoreResults(zero).accuracy_pct).toBe(0);
		expect(scoreResults(zero).errors).toBe(fixture.claims.length);
	});
});

describe('isDegraded', () => {
	// The refusal exists because a run that mostly errored measures provider
	// availability, not verdict accuracy: publishing it states a false accuracy
	// figure for a paid product.
	it('passes a clean run and a run at exactly the 10% ceiling', () => {
		expect(isDegraded({ total: 40, errors: 0 })).toBe(false);
		expect(isDegraded({ total: 40, errors: 4 })).toBe(false);
	});

	it('refuses a run above the ceiling, and an empty run', () => {
		expect(isDegraded({ total: 40, errors: 5 })).toBe(true);
		expect(isDegraded({ total: 40, errors: 30 })).toBe(true);
		expect(isDegraded({ total: 0, errors: 0 })).toBe(true);
	});
});

describe('runClaims', () => {
	const claims = Array.from({ length: 9 }, (_, i) => ({
		claim: `claim ${i}`,
		expected_verdict: 'supported',
		difficulty: 'easy',
	}));

	it('runs every claim and preserves fixture order regardless of completion order', async () => {
		// Reverse the latency so later claims finish first: results must still line
		// up with the input, otherwise the confusion matrix attributes verdicts to
		// the wrong claims.
		const results = await runClaims(
			claims,
			async (claim) => {
				const i = Number(claim.split(' ')[1]);
				await new Promise((r) => setTimeout(r, (claims.length - i) * 2));
				return `v${i}`;
			},
			{ concurrency: 4 },
		);
		expect(results.map((r) => r.claim)).toEqual(claims.map((c) => c.claim));
		expect(results.map((r) => r.actual_verdict)).toEqual(claims.map((_, i) => `v${i}`));
	});

	it('never exceeds the concurrency cap', async () => {
		let inFlight = 0;
		let peak = 0;
		await runClaims(
			claims,
			async () => {
				peak = Math.max(peak, ++inFlight);
				await new Promise((r) => setTimeout(r, 5));
				inFlight--;
				return 'supported';
			},
			{ concurrency: 3 },
		);
		expect(peak).toBeLessThanOrEqual(3);
	});

	it('records a thrown claim as an error rather than dropping it', async () => {
		const results = await runClaims(
			claims,
			async (claim) => {
				if (claim === 'claim 2') throw new Error('provider down');
				return 'supported';
			},
			{ concurrency: 2 },
		);
		expect(results).toHaveLength(claims.length);
		expect(results[2].actual_verdict).toBeNull();
		expect(scoreResults(results).errors).toBe(1);
	});

	it('counts deadline-cut claims as errors, so a truncated run trips the refusal', async () => {
		const results = await runClaims(
			claims,
			async () => {
				await new Promise((r) => setTimeout(r, 30));
				return 'supported';
			},
			{ concurrency: 1, deadlineMs: 45 },
		);
		expect(results).toHaveLength(claims.length);
		const score = scoreResults(results);
		expect(score.errors).toBeGreaterThan(0);
		expect(isDegraded(score)).toBe(true);
	});
});
