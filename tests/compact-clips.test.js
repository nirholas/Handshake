// scripts/compact-clips.mjs: baked clip JSON is stored at float32 precision.
// The baker applies compactClipJson() to every clip it writes and the CLI
// rewrites the committed library the same way, so both rely on the same
// guarantees: numbers round to 7 significant digits, integers and non-numeric
// data pass through untouched, and a second pass changes nothing.
import { describe, it, expect } from 'vitest';
import { compactNumber, compactClipJson, compactClipText } from '../scripts/compact-clips.mjs';

describe('compactNumber', () => {
	it('rounds a double-printed float32 to 7 significant digits', () => {
		expect(compactNumber(0.03333333507180214)).toBe(0.03333334);
		expect(compactNumber(15.800000190734863)).toBe(15.8);
		expect(compactNumber(-0.9998477101325989)).toBe(-0.9998477);
	});
	it('leaves integers, zero, and non-finite values alone', () => {
		expect(compactNumber(30)).toBe(30);
		expect(compactNumber(0)).toBe(0);
		expect(compactNumber(-3)).toBe(-3);
		expect(compactNumber(Infinity)).toBe(Infinity);
		expect(Number.isNaN(compactNumber(NaN))).toBe(true);
	});
	it('keeps tiny values instead of flushing them to zero (precision is relative)', () => {
		expect(compactNumber(-1e-12)).toBe(-1e-12);
		expect(compactNumber(3.4028234e-38)).toBe(3.402823e-38);
	});
	it('keeps the relative error within float32 precision', () => {
		for (const v of [0.123456789, 1234.56789, 3.4028234e-5, 0.7071067811865476]) {
			expect(Math.abs(compactNumber(v) - v) / Math.abs(v)).toBeLessThan(1e-6);
		}
	});
});

describe('compactClipJson', () => {
	const clip = {
		name: 'idle',
		duration: 15.800000190734863,
		tracks: [
			{ name: 'Hips.position', type: 'vector', times: [0, 0.03333333507180214], values: [0, 0.9800000190734863, 0.012345678901234] },
			{ name: 'Spine.quaternion', type: 'quaternion', times: [0], values: [0, 0, 0, 1] },
		],
		uuid: 'abc-123',
		blendMode: 2500,
	};
	it('compacts every number in tracks and metadata, preserving structure', () => {
		const out = compactClipJson(clip);
		expect(out.duration).toBe(15.8);
		expect(out.tracks[0].times).toEqual([0, 0.03333334]);
		expect(out.tracks[0].values).toEqual([0, 0.98, 0.01234568]);
		expect(out.tracks[1].values).toEqual([0, 0, 0, 1]);
		expect(out.name).toBe('idle');
		expect(out.uuid).toBe('abc-123');
		expect(out.blendMode).toBe(2500);
		expect(out.tracks[1].type).toBe('quaternion');
	});
	it('does not mutate its input', () => {
		const before = JSON.stringify(clip);
		compactClipJson(clip);
		expect(JSON.stringify(clip)).toBe(before);
	});
	it('is idempotent as text', () => {
		const once = compactClipText(JSON.stringify(clip));
		expect(compactClipText(once)).toBe(once);
	});
	it('shrinks a double-precision clip substantially', () => {
		const times = Array.from({ length: 300 }, (_, i) => i / 30);
		const values = times.map((t) => Math.sin(t) * 0.5);
		const raw = JSON.stringify({ name: 'wave', duration: times[times.length - 1], tracks: [{ name: 'Arm.position', times, values }] });
		const compact = compactClipText(raw);
		expect(compact.length).toBeLessThan(raw.length * 0.6);
	});
});
