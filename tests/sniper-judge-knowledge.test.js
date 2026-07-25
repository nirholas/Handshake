/**
 * The judge's earned knowledge pack: bucket selection.
 *
 * The conditional win-rate table can carry dozens of near-baseline rows. Handing
 * all of them to a model teaches it nothing and costs tokens; the pack must
 * surface the buckets that actually diverge from the baseline, in both
 * directions, since "this bucket loses badly" is as actionable as the reverse.
 */

import { describe, expect, it } from 'vitest';
import { topBuckets } from '../workers/agent-sniper/judge-knowledge.js';

const table = {
	bundle_score: {
		clean: { win_rate: 0.31, count: 400, baseline_win_rate: 0.12 },   // +19pt
		high: { win_rate: 0.02, count: 250, baseline_win_rate: 0.12 },    // -10pt
		medium: { win_rate: 0.13, count: 180, baseline_win_rate: 0.12 },  // +1pt
	},
	unique_buyers: {
		'>=50': { win_rate: 0.44, count: 90, baseline_win_rate: 0.12 },   // +32pt
		'<5': { win_rate: 0.11, count: 900, baseline_win_rate: 0.12 },    // -1pt
	},
};

describe('topBuckets', () => {
	it('ranks by absolute divergence from the baseline', () => {
		const top = topBuckets(table, 3);
		expect(top.map((b) => b.bucket)).toEqual(['>=50', 'clean', 'high']);
	});

	it('keeps strongly negative buckets, not just winners', () => {
		const top = topBuckets(table, 3);
		const negative = top.find((b) => b.bucket === 'high');
		expect(negative).toBeTruthy();
		expect(negative.lift).toBeLessThan(0);
	});

	it('honours the limit', () => {
		expect(topBuckets(table, 2)).toHaveLength(2);
		expect(topBuckets(table, 99)).toHaveLength(5);
	});

	it('carries the sample count so the model can weigh the evidence', () => {
		const [best] = topBuckets(table, 1);
		expect(best).toMatchObject({ signal: 'unique_buyers', bucket: '>=50', count: 90 });
	});

	it('drops malformed rows instead of emitting NaN into a prompt', () => {
		const dirty = {
			ok: { a: { win_rate: 0.5, count: 10, baseline_win_rate: 0.1 } },
			bad: {
				noCount: { win_rate: 0.9, count: 0, baseline_win_rate: 0.1 },
				noRate: { win_rate: null, count: 10, baseline_win_rate: 0.1 },
				garbage: { win_rate: 'x', count: 'y', baseline_win_rate: 'z' },
			},
		};
		const out = topBuckets(dirty);
		expect(out).toHaveLength(1);
		expect(out[0].signal).toBe('ok');
	});

	it('returns nothing rather than throwing on absent input', () => {
		expect(topBuckets(null)).toEqual([]);
		expect(topBuckets(undefined)).toEqual([]);
		expect(topBuckets({})).toEqual([]);
		expect(topBuckets('not an object')).toEqual([]);
	});
});
