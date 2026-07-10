/**
 * ui-juice — pure-logic coverage for the shared game-feel library.
 *
 * The library's primitives are DOM transition helpers, but their geometry/math
 * cores are pure and exported separately so they assert without a DOM:
 * count-up interpolation/formatting, sparkline path generation, ring arc math,
 * and FLIP key diffing. The instant (no-RAF) path of countUp is also covered
 * against a minimal fake element. Runs in the default `node` vitest env.
 */

import { describe, it, expect } from 'vitest';
import {
	countUp,
	updateValue,
	sparklinePath,
	sparkline,
	ringGeometry,
	ring,
	reorderedKeys,
	liveDot,
} from '../src/ui-juice.js';

describe('countUp — instant path (no requestAnimationFrame in node)', () => {
	it('sets the final formatted value instantly', () => {
		const el = { textContent: '', dataset: {} };
		countUp(el, 1000, 1875, { format: (n) => `$${Math.round(n)}` });
		expect(el.textContent).toBe('$1875');
	});

	it('preserves caller formatting including sign and units', () => {
		const el = { textContent: '', dataset: {} };
		countUp(el, -5, 12.5, { format: (n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)} SOL` });
		expect(el.textContent).toBe('+12.5 SOL');
	});

	it('records the target on dataset for the next updateValue', () => {
		const el = { textContent: '', dataset: {} };
		countUp(el, 0, 42, { format: (n) => String(Math.round(n)) });
		expect(el.dataset.juiceVal).toBe('42');
		expect(el.textContent).toBe('42');
	});

	it('no-ops on a null element without throwing', () => {
		expect(() => countUp(null, 0, 10)).not.toThrow();
	});
});

describe('countUp — animated path never paints outside [from, to]', () => {
	// requestAnimationFrame is not contractually on performance.now()'s time origin.
	// Polyfills and some embedders hand the callback a Date-derived timestamp, which
	// can sit *behind* a performance.now() start — driving the eased progress negative
	// and overshooting wildly (the real "-42797% there" seen on the $THREE gate).
	// Every frame must stay clamped between the endpoints regardless of clock skew.
	// Install a manually-pumped rAF so frames fire on demand with the timestamps we
	// choose, and stays installed for the frames countUp schedules from inside step().
	function withManualRaf(fn) {
		const realRaf = globalThis.requestAnimationFrame;
		const realCancel = globalThis.cancelAnimationFrame;
		let pending = null;
		globalThis.requestAnimationFrame = (cb) => { pending = cb; return 1; };
		globalThis.cancelAnimationFrame = () => { pending = null; };
		const frame = (t) => { const cb = pending; pending = null; if (cb) cb(t); };
		try { return fn(frame); } finally {
			globalThis.requestAnimationFrame = realRaf;
			globalThis.cancelAnimationFrame = realCancel;
		}
	}

	it('clamps a frame whose timestamp trails the start clock', () => {
		withManualRaf((frame) => {
			const el = { textContent: '', dataset: {} };
			const seen = [];
			countUp(el, 0, 40, { duration: 400, format: (n) => { seen.push(n); return String(Math.round(n)); } });
			// A Date-style timestamp far behind a performance.now() start. Pre-fix this
			// drove p negative and painted a large negative number.
			frame(0);
			frame(1);
			for (const n of seen) {
				expect(n).toBeGreaterThanOrEqual(0);
				expect(n).toBeLessThanOrEqual(40);
			}
			expect(Number(el.textContent)).toBeGreaterThanOrEqual(0);
			expect(Number(el.textContent)).toBeLessThanOrEqual(40);
		});
	});

	it('lands exactly on the target once the duration elapses', () => {
		withManualRaf((frame) => {
			const el = { textContent: '', dataset: {} };
			countUp(el, 0, 40, { duration: 400, format: (n) => String(Math.round(n)) });
			frame(1000);          // first frame seeds the start
			frame(1000 + 500);    // past `duration` → p === 1
			expect(el.textContent).toBe('40');
		});
	});
});

describe('updateValue', () => {
	it('counts from the element\'s last tracked value to the new one', () => {
		// flash:false isolates the count math from the DOM tint pulse
		const el = { textContent: '', dataset: { juiceVal: '100' } };
		updateValue(el, 250, (n) => String(Math.round(n)), { flash: false });
		expect(el.textContent).toBe('250');
		expect(el.dataset.juiceVal).toBe('250');
	});

	it('starts cold when no prior value is tracked', () => {
		const el = { textContent: '', dataset: {} };
		updateValue(el, 7, (n) => String(Math.round(n)));
		expect(el.textContent).toBe('7');
	});
});

describe('sparklinePath', () => {
	it('maps a known rising series to inverted-Y points across the box', () => {
		const geo = sparklinePath([0, 5, 10], 100, 20, 2);
		const pts = geo.points.split(' ');
		expect(pts).toHaveLength(3);
		expect(pts[0]).toBe('2.00,18.00'); // first: bottom-left (pad, max-y)
		expect(pts[2]).toBe('98.00,2.00'); // last: top-right (width-pad, min-y)
		expect(geo.last).toEqual({ x: 98, y: 2 });
		expect(geo.net).toBe(10); // net-positive
	});

	it('reports a net-negative series', () => {
		expect(sparklinePath([10, 4, 1], 100, 20).net).toBe(-9);
	});

	it('handles a flat series without dividing by zero', () => {
		const geo = sparklinePath([7, 7, 7], 100, 20, 2);
		expect(geo.points.split(' ').every((p) => /^[\d.]+,[\d.]+$/.test(p))).toBe(true);
	});

	it('returns empty geometry for no usable values', () => {
		expect(sparklinePath([], 100, 20).points).toBe('');
		expect(sparklinePath([NaN, undefined], 100, 20).points).toBe('');
	});

	it('sparkline() emits a valid svg with a polyline for a real series', () => {
		const svg = sparkline([1, 2, 3], { width: 80, height: 24 });
		expect(svg).toContain('<svg');
		expect(svg).toContain('<polyline');
		expect(svg).toContain('var(--success)'); // rising → success token
	});

	it('sparkline() colors a falling series with the danger token', () => {
		expect(sparkline([5, 3, 1])).toContain('var(--danger)');
	});
});

describe('ringGeometry', () => {
	it('computes circumference and offset for a known percentage', () => {
		const g = ringGeometry(50, 56, 5);
		const r = 28 - 2.5;
		const c = 2 * Math.PI * r;
		expect(g.r).toBeCloseTo(r, 2);
		expect(g.circumference).toBeCloseTo(c, 2);
		expect(g.offset).toBeCloseTo(c * 0.5, 2); // 50% → half the ring left empty
		expect(g.center).toBe(28);
	});

	it('clamps out-of-range percentages', () => {
		expect(ringGeometry(-20, 56, 5).pct).toBe(0);
		expect(ringGeometry(150, 56, 5).pct).toBe(100);
		// full ring → zero remaining offset
		expect(ringGeometry(100, 56, 5).offset).toBeCloseTo(0, 5);
	});

	it('ring() defaults the label to a rounded percentage', () => {
		expect(ring(72.4)).toContain('>72%<');
		expect(ring(50, { label: 'GO' })).toContain('>GO<');
		expect(ring(80, { color: 'var(--success)' })).toContain('var(--success)');
	});
});

describe('reorderedKeys', () => {
	it('returns only the keys whose index changed', () => {
		const moved = reorderedKeys(['a', 'b', 'c'], ['b', 'a', 'c']);
		expect(moved.sort()).toEqual(['a', 'b']); // c stayed at index 2
	});

	it('ignores keys that are new or removed', () => {
		expect(reorderedKeys(['a'], ['a', 'new'])).toEqual([]); // a unmoved, new absent before
		expect(reorderedKeys(['a', 'b'], ['a'])).toEqual([]); // a unmoved
	});

	it('reports a full reversal', () => {
		expect(reorderedKeys(['a', 'b', 'c'], ['c', 'b', 'a']).sort()).toEqual(['a', 'c']);
	});
});

describe('liveDot', () => {
	it('renders the connection state and label', () => {
		expect(liveDot('live')).toContain('data-state="live"');
		expect(liveDot('live')).toContain('>live</span>');
		expect(liveDot('connecting')).toContain('>connecting</span>');
		expect(liveDot('idle')).toContain('data-state="idle"');
		expect(liveDot('live', { label: 'streaming' })).toContain('>streaming</span>');
	});

	it('escapes a hostile label', () => {
		expect(liveDot('live', { label: '<x>' })).toContain('&lt;x&gt;');
	});
});
