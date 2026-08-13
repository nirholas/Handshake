/**
 * Sentiment heatmap data layer — unit tests.
 *
 * Covers the pure transforms behind the 3D field: token normalisation
 * (momentum + magnitude), the momentum→colour ramp, glow intensity, the
 * poll-to-poll spike diff, mover ranking, and the narration-context builder.
 * No DOM, no network — every function under test is pure.
 */

import { describe, it, expect } from 'vitest';
import {
	normalizeToken,
	normalizeField,
	momentumColor,
	glowIntensity,
	diffSpikes,
	rankMovers,
	buildNarrationContext,
	MOMENTUM_FULL_SCALE_PCT,
} from '../src/sentiment-heatmap-data.js';

describe('normalizeToken', () => {
	it('maps 24h change to momentum in [-1, 1] at full scale', () => {
		const up = normalizeToken({ id: 'a', symbol: 'A', change24h: MOMENTUM_FULL_SCALE_PCT });
		const down = normalizeToken({ id: 'b', symbol: 'B', change24h: -MOMENTUM_FULL_SCALE_PCT });
		expect(up.momentum).toBe(1);
		expect(down.momentum).toBe(-1);
	});

	it('clamps momentum beyond full scale', () => {
		const t = normalizeToken({ id: 'a', change24h: MOMENTUM_FULL_SCALE_PCT * 5 });
		expect(t.momentum).toBe(1);
		const t2 = normalizeToken({ id: 'a', change24h: -MOMENTUM_FULL_SCALE_PCT * 5 });
		expect(t2.momentum).toBe(-1);
	});

	it('treats missing change as flat (zero) momentum', () => {
		const t = normalizeToken({ id: 'a' });
		expect(t.momentum).toBe(0);
	});

	it('log-normalises volume to magnitude in [0, 1] against the field max', () => {
		const loud = normalizeToken({ id: 'a', volume24h: 1e7 }, { maxLogVolume: 7 });
		const quiet = normalizeToken({ id: 'b', volume24h: 10 }, { maxLogVolume: 7 });
		expect(loud.magnitude).toBeCloseTo(1, 5);
		expect(quiet.magnitude).toBeGreaterThan(0);
		expect(quiet.magnitude).toBeLessThan(loud.magnitude);
	});

	it('zero / negative volume yields zero magnitude', () => {
		expect(normalizeToken({ id: 'a', volume24h: 0 }).magnitude).toBe(0);
		expect(normalizeToken({ id: 'a', volume24h: -5 }).magnitude).toBe(0);
	});

	it('derives a label and preserves featured + the anchor flow pulse', () => {
		const t = normalizeToken({ id: 'mintmintmint', featured: true, flow: { score: 0.4, buyPct: 70 } });
		expect(t.label).toBe('mint…');
		expect(t.featured).toBe(true);
		expect(t.flow.buyPct).toBe(70);
	});
});

describe('normalizeField', () => {
	it('scales magnitude relative to the loudest token in the field', () => {
		const field = normalizeField([
			{ id: 'a', volume24h: 1e6 },
			{ id: 'b', volume24h: 1e3 },
		]);
		const a = field.find((t) => t.id === 'a');
		const b = field.find((t) => t.id === 'b');
		expect(a.magnitude).toBeCloseTo(1, 5); // loudest → full
		expect(b.magnitude).toBeLessThan(a.magnitude);
	});

	it('handles an empty field without throwing', () => {
		expect(normalizeField([])).toEqual([]);
		expect(normalizeField(null)).toEqual([]);
	});
});

describe('momentumColor', () => {
	it('is cold blue at -1, slate at 0, green-hot at +1', () => {
		const cold = momentumColor(-1);
		const neutral = momentumColor(0);
		const hot = momentumColor(1);
		// cold: blue dominant
		expect(cold.b).toBeGreaterThan(cold.r);
		expect(cold.b).toBeGreaterThan(cold.g);
		// hot: green dominant
		expect(hot.g).toBeGreaterThan(hot.r);
		expect(hot.g).toBeGreaterThan(hot.b);
		// neutral: desaturated, no channel blown out
		expect(neutral.r).toBeLessThan(0.5);
		expect(neutral.g).toBeLessThan(0.5);
	});

	it('returns channels within [0, 1] and clamps out-of-range momentum', () => {
		for (const m of [-5, -1, -0.3, 0, 0.7, 1, 9]) {
			const c = momentumColor(m);
			for (const ch of ['r', 'g', 'b']) {
				expect(c[ch]).toBeGreaterThanOrEqual(0);
				expect(c[ch]).toBeLessThanOrEqual(1);
			}
		}
	});

	it('is monotonic toward green as momentum rises on the positive side', () => {
		expect(momentumColor(1).g).toBeGreaterThan(momentumColor(0.5).g);
		expect(momentumColor(0.5).g).toBeGreaterThan(momentumColor(0).g);
	});
});

describe('glowIntensity', () => {
	it('is low for a flat, quiet tile and high for a loud mover', () => {
		const calm = glowIntensity(0, 0);
		const blazing = glowIntensity(1, 1);
		expect(calm).toBeLessThan(0.2);
		expect(blazing).toBeGreaterThan(calm);
	});

	it('treats a strong dump as bright as a strong pump (uses |momentum|)', () => {
		expect(glowIntensity(-1, 0.5)).toBeCloseTo(glowIntensity(1, 0.5), 10);
	});
});

describe('diffSpikes', () => {
	const prev = [
		{ id: 'a', label: 'A', momentum: 0.1, change24h: 2 },
		{ id: 'b', label: 'B', momentum: -0.1, change24h: -2 },
	];

	it('flags a token whose momentum jumped beyond the threshold', () => {
		const next = [
			{ id: 'a', label: 'A', momentum: 0.5, change24h: 12 }, // +0.4 jump
			{ id: 'b', label: 'B', momentum: -0.1, change24h: -2 }, // flat
		];
		const spikes = diffSpikes(prev, next, 0.18);
		expect(spikes).toHaveLength(1);
		expect(spikes[0].id).toBe('a');
		expect(spikes[0].direction).toBe('heating');
	});

	it('does not flag sub-threshold drift', () => {
		const next = [
			{ id: 'a', label: 'A', momentum: 0.2, change24h: 5 }, // +0.1 only
			{ id: 'b', label: 'B', momentum: -0.1, change24h: -2 },
		];
		expect(diffSpikes(prev, next, 0.18)).toHaveLength(0);
	});

	it('tags a sharp drop as cooling', () => {
		const next = [
			{ id: 'a', label: 'A', momentum: 0.1, change24h: 2 },
			{ id: 'b', label: 'B', momentum: -0.6, change24h: -15 }, // -0.5 jump
		];
		const spikes = diffSpikes(prev, next, 0.18);
		expect(spikes[0].id).toBe('b');
		expect(spikes[0].direction).toBe('cooling');
	});

	it('treats a freshly-arrived hot token as a spike, a fresh calm one not', () => {
		const next = [
			...prev,
			{ id: 'c', label: 'C', momentum: 0.8, change24h: 20 }, // new + hot
			{ id: 'd', label: 'D', momentum: 0.1, change24h: 2 },  // new + calm
		];
		const spikes = diffSpikes(prev, next, 0.18);
		const ids = spikes.map((s) => s.id);
		expect(ids).toContain('c');
		expect(ids).not.toContain('d');
		expect(spikes.find((s) => s.id === 'c').fresh).toBe(true);
	});

	it('sorts movers by absolute delta, biggest first', () => {
		const next = [
			{ id: 'a', label: 'A', momentum: 0.5, change24h: 12 },  // +0.4
			{ id: 'b', label: 'B', momentum: -0.9, change24h: -22 }, // -0.8
		];
		const spikes = diffSpikes(prev, next, 0.18);
		expect(spikes[0].id).toBe('b');
		expect(spikes[1].id).toBe('a');
	});

	it('handles an empty previous snapshot (first poll)', () => {
		const next = [{ id: 'x', label: 'X', momentum: 0.9, change24h: 25 }];
		const spikes = diffSpikes([], next, 0.18);
		expect(spikes.map((s) => s.id)).toContain('x');
	});
});

describe('rankMovers', () => {
	const tokens = [
		{ id: 't', label: 'THREE', featured: true, momentum: 0.2, change24h: 5 },
		{ id: 'a', label: 'A', momentum: 0.6, change24h: 15 },
		{ id: 'b', label: 'B', momentum: -0.4, change24h: -10 },
		{ id: 'c', label: 'C', momentum: 0.1, change24h: 2 },
	];

	it('separates gainers from losers and finds the anchor', () => {
		const m = rankMovers(tokens, { count: 2 });
		expect(m.gainers[0].label).toBe('A'); // biggest gainer first
		expect(m.losers[0].label).toBe('B');
		expect(m.anchor.label).toBe('THREE');
		expect(m.total).toBe(4);
	});

	it('computes an average momentum across the field', () => {
		const m = rankMovers(tokens);
		expect(m.avgMomentum).toBeCloseTo((0.2 + 0.6 - 0.4 + 0.1) / 4, 6);
	});
});

describe('buildNarrationContext', () => {
	it('always names $THREE for the anchor and folds in its order flow', () => {
		const movers = {
			anchor: { label: 'THREE', featured: true, change24h: 8, flow: { score: 0.4, buyPct: 70, buys24h: 70, sells24h: 30 } },
			gainers: [{ label: 'A', change24h: 15 }],
			losers: [{ label: 'B', change24h: -10 }],
			avgMomentum: 0.2,
			total: 4,
		};
		const ctx = buildNarrationContext({ spikes: [], movers });
		expect(ctx).toMatch(/\$THREE/);
		expect(ctx).toMatch(/Heating across the board/);
		expect(ctx).toMatch(/order flow buyers leading \(70% buys of 100 trades 24h\)/);
	});

	it('describes a cooling tape and a fresh spike', () => {
		const movers = { anchor: null, gainers: [], losers: [{ label: 'B', change24h: -12 }], avgMomentum: -0.3, total: 3 };
		const spikes = [{ label: 'B', change24h: -12, direction: 'cooling' }];
		const ctx = buildNarrationContext({ spikes, movers });
		expect(ctx).toMatch(/Cooling across the board/);
		expect(ctx).toMatch(/Just cooling: B/);
	});
});
