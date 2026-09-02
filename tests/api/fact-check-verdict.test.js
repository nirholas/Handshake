/**
 * Unit tests for api/x402/fact-check.js#computeVerdict, the weighted verdict
 * calculus behind every fact-check answer and behind the published accuracy
 * benchmark on /fact-check.
 *
 * Written against SYNTHETIC stance distributions on purpose. The benchmark
 * fixture is 40 real claims scored through the live chain; shaping the calculus
 * to those ten `mixed` claims would fit the fixture rather than fix the rule.
 * These cases pin the rule itself:
 *   • the clear-cut distributions (unanimous, near-unanimous, empty, silent)
 *     keep their verdicts, so the mixed band can never swallow them
 *   • `partial` weight is stance-bearing but takes neither side, which is the
 *     route by which a claim every source calls "true in one respect, wrong in
 *     another" reaches `mixed` instead of `contradicted`
 *   • confidence for `mixed` measures how strongly the evidence establishes
 *     mixedness, not how lopsided the split was
 */

import { describe, it, expect } from 'vitest';
import { _computeVerdict as computeVerdict } from '../../api/x402/fact-check.js';

/** Build n sources of one stance at a uniform weight. */
const of = (stance, n, weight = 0.8) =>
	Array.from({ length: n }, (_v, i) => ({ url: `https://example.com/${stance}/${i}`, stance, weight }));

describe('computeVerdict — clear-cut distributions keep their verdicts', () => {
	it('unanimous support is supported', () => {
		expect(computeVerdict(of('supports', 5)).verdict).toBe('supported');
	});

	it('unanimous contradiction is contradicted', () => {
		expect(computeVerdict(of('contradicts', 5)).verdict).toBe('contradicted');
	});

	it('exactly 70% of stance weight one way still lands on that side', () => {
		// 7 supporting + 3 contradicting at equal weight is the boundary itself.
		expect(computeVerdict([...of('supports', 7), ...of('contradicts', 3)]).verdict).toBe('supported');
		expect(computeVerdict([...of('contradicts', 7), ...of('supports', 3)]).verdict).toBe('contradicted');
	});

	it('one dissenting source does not unseat a dominant side', () => {
		expect(computeVerdict([...of('supports', 4), ...of('contradicts', 1)]).verdict).toBe('supported');
		expect(computeVerdict([...of('contradicts', 4), ...of('supports', 1)]).verdict).toBe('contradicted');
	});

	it('authority weight, not source count, decides direction', () => {
		// Two low-authority blogs cannot outvote one encyclopedic source.
		const verdict = computeVerdict([
			{ url: 'https://en.wikipedia.org/wiki/X', stance: 'supports', weight: 0.9 },
			{ url: 'https://blog.example/a', stance: 'contradicts', weight: 0.15 },
			{ url: 'https://blog.example/b', stance: 'contradicts', weight: 0.15 },
		]);
		expect(verdict.verdict).toBe('supported');
	});

	it('fewer than two sources is insufficient, never a verdict', () => {
		expect(computeVerdict([]).verdict).toBe('insufficient');
		expect(computeVerdict(of('supports', 1)).verdict).toBe('insufficient');
	});

	it('evidence that never engages the claim is insufficient, not mixed', () => {
		// The 2026-07-08 regression: all-neutral used to return "mixed".
		expect(computeVerdict(of('neutral', 5)).verdict).toBe('insufficient');
	});

	it('zero total weight is insufficient', () => {
		expect(computeVerdict(of('supports', 3, 0)).verdict).toBe('insufficient');
	});

	it('a single stance-bearing source lost among silent ones is insufficient', () => {
		const sources = [
			{ url: 'https://example.com/one', stance: 'supports', weight: 0.2 },
			...of('neutral', 4, 0.9),
		];
		expect(computeVerdict(sources).verdict).toBe('insufficient');
	});

	it('a lone partial source lost among silent ones is insufficient too', () => {
		// `partial` is stance-bearing, so it goes through the same coverage floor:
		// one loosely-matched page must not decide a verdict on its own.
		const sources = [
			{ url: 'https://example.com/one', stance: 'partial', weight: 0.2 },
			...of('neutral', 4, 0.9),
		];
		expect(computeVerdict(sources).verdict).toBe('insufficient');
	});
});

describe('computeVerdict — mixed by inter-source disagreement', () => {
	it('an even split is mixed', () => {
		expect(computeVerdict([...of('supports', 3), ...of('contradicts', 3)]).verdict).toBe('mixed');
	});

	it('a split just short of the 70% bar is mixed', () => {
		// 2 vs 1 is 66.7% support: below the bar, so neither side owns it.
		expect(computeVerdict([...of('supports', 2), ...of('contradicts', 1)]).verdict).toBe('mixed');
	});

	it('neutral sources dilute confidence but do not change the verdict', () => {
		const tight = computeVerdict([...of('supports', 3), ...of('contradicts', 3)]);
		const diluted = computeVerdict([...of('supports', 3), ...of('contradicts', 3), ...of('neutral', 12)]);
		expect(diluted.verdict).toBe(tight.verdict);
		expect(diluted.confidence).toBeLessThan(tight.confidence);
	});
});

describe('computeVerdict — mixed by intra-source partiality', () => {
	it('unanimous partial evidence is mixed, not contradicted', () => {
		// The defect this stance exists to fix: every source reads the same
		// nuance ("a tomato is botanically a fruit and culinarily a vegetable"),
		// so before `partial` existed they all projected onto one side and the
		// whole mixed class scored 0/10.
		expect(computeVerdict(of('partial', 5)).verdict).toBe('mixed');
	});

	it('partial weight blocks a side from clearing the 70% bar', () => {
		// 3 supports + 2 partial: 60% support, below the bar.
		expect(computeVerdict([...of('supports', 3), ...of('partial', 2)]).verdict).toBe('mixed');
		expect(computeVerdict([...of('contradicts', 3), ...of('partial', 2)]).verdict).toBe('mixed');
	});

	it('a lone partial source does not unseat an otherwise dominant side', () => {
		// 8 supports + 1 partial is still 88.9% support. `partial` dilutes
		// dominance; it does not veto it.
		expect(computeVerdict([...of('supports', 8), ...of('partial', 1)]).verdict).toBe('supported');
	});

	it('partial mixed with both directions is mixed', () => {
		expect(
			computeVerdict([...of('supports', 2), ...of('contradicts', 2), ...of('partial', 2)]).verdict,
		).toBe('mixed');
	});
});

describe('computeVerdict — confidence semantics', () => {
	it('broad engagement outscores thin engagement at the same dominance', () => {
		const broad = computeVerdict(of('supports', 5, 0.8));
		const thin = computeVerdict([...of('supports', 2, 0.8), ...of('neutral', 8, 0.8)]);
		expect(broad.confidence).toBeGreaterThan(thin.confidence);
	});

	it('an even split is MORE confidently mixed than a lopsided one', () => {
		// The old rule scored mixed confidence as max(support, contra), so the
		// closer a split came to breaking one way, the more sure it claimed to be
		// that it had not. Mixedness is the thing being measured now.
		const even = computeVerdict([...of('supports', 3), ...of('contradicts', 3)]);
		const lopsided = computeVerdict([...of('supports', 2), ...of('contradicts', 1)]);
		expect(even.confidence).toBeGreaterThan(lopsided.confidence);
	});

	it('unanimous partial is as confidently mixed as an even split', () => {
		const partial = computeVerdict(of('partial', 6));
		const split = computeVerdict([...of('supports', 3), ...of('contradicts', 3)]);
		expect(partial.confidence).toBe(split.confidence);
	});

	it('every confidence is a bounded, rounded probability', () => {
		const cases = [
			of('supports', 5),
			of('contradicts', 5),
			of('partial', 5),
			[...of('supports', 3), ...of('contradicts', 3)],
			[...of('supports', 3), ...of('partial', 2), ...of('neutral', 4)],
			of('neutral', 5),
			of('supports', 1),
		];
		for (const sources of cases) {
			const { confidence } = computeVerdict(sources);
			expect(confidence).toBeGreaterThan(0);
			expect(confidence).toBeLessThanOrEqual(0.98);
			expect(Math.round(confidence * 100)).toBe(confidence * 100);
		}
	});
});
