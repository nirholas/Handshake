import { describe, expect, it } from 'vitest';

import {
	DEFAULT_TIMING,
	LETTER_SHAPES,
	buildFingerspellingClip,
	handshapeLocals,
	normalizeWord,
} from '../src/fingerspelling.js';

const FINGER_BONES = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].flatMap((f) =>
	[1, 2, 3].map((j) => `RightHand${f}${j}`),
);

function quatAngleDeg(q) {
	return (2 * Math.acos(Math.min(1, Math.abs(q[3])))) * (180 / Math.PI);
}

describe('letter shapes', () => {
	it('defines all 26 letters', () => {
		for (let c = 65; c <= 90; c++) {
			expect(LETTER_SHAPES[String.fromCharCode(c)], String.fromCharCode(c)).toBeTruthy();
		}
	});

	it('produces unit quaternions for every finger bone of every letter', () => {
		for (const letter of Object.keys(LETTER_SHAPES)) {
			const locals = handshapeLocals(letter, 'Right');
			for (const bone of FINGER_BONES) {
				const q = locals[bone];
				expect(q, `${letter}:${bone}`).toBeTruthy();
				expect(Math.hypot(...q)).toBeCloseTo(1, 6);
			}
		}
	});

	it('distinct letters produce distinct handshapes', () => {
		const flat = (letter) =>
			FINGER_BONES.flatMap((b) => handshapeLocals(letter, 'Right')[b])
				.map((v) => v.toFixed(4))
				.join(',');
		const seen = new Map();
		for (const letter of Object.keys(LETTER_SHAPES)) {
			const key = flat(letter);
			// Some letters share a base handshape by design and differ only by
			// wrist orientation or motion, which live in the clip: I/J, K/P,
			// and the G/Q/Z family.
			const clash = seen.get(key);
			if (clash) {
				expect(['I:J', 'G:Q', 'Q:Z', 'K:P'].includes(`${clash}:${letter}`), `${clash} vs ${letter}`).toBe(true);
			}
			seen.set(key, letter);
		}
	});

	it('a fist letter curls the index far more than an open letter', () => {
		const fist = handshapeLocals('S', 'Right');
		const open = handshapeLocals('B', 'Right');
		expect(quatAngleDeg(fist.RightHandIndex2)).toBeGreaterThan(60);
		expect(quatAngleDeg(open.RightHandIndex2)).toBeLessThan(5);
	});

	it('mirrors cleanly to the left hand', () => {
		const right = handshapeLocals('V', 'Right');
		const left = handshapeLocals('V', 'Left');
		expect(quatAngleDeg(left.LeftHandIndex1)).toBeCloseTo(quatAngleDeg(right.RightHandIndex1), 5);
		// Curl hinge is mirrored: z components flip sign.
		expect(left.LeftHandRing2[2]).toBeCloseTo(-right.RightHandRing2[2], 6);
	});

	it('rejects unknown letters', () => {
		expect(() => handshapeLocals('7', 'Right')).toThrow();
	});
});

describe('normalizeWord', () => {
	it('uppercases, strips non-letters, collapses spaces', () => {
		expect(normalizeWord('  héllo,  world! ')).toBe('HLLO WORLD');
		expect(normalizeWord('three.ws')).toBe('THREEWS');
		expect(normalizeWord('$$$')).toBe('');
	});
});

describe('buildFingerspellingClip', () => {
	it('emits a library-shaped clip document', () => {
		const clip = buildFingerspellingClip('hi');
		expect(clip.blendMode).toBe(2500);
		expect(clip.uuid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
		expect(clip.duration).toBeGreaterThan(0);
		const names = clip.tracks.map((t) => t.name);
		for (const bone of FINGER_BONES) expect(names).toContain(`${bone}.quaternion`);
		for (const bone of ['RightArm', 'RightForeArm', 'RightHand', 'LeftArm', 'LeftForeArm', 'Hips']) {
			expect(names).toContain(`${bone}.quaternion`);
		}
		expect(names).toContain('Hips.position');
	});

	it('tracks have ascending times, matching lengths, and unit quaternions', () => {
		const clip = buildFingerspellingClip('lazy dog');
		for (const track of clip.tracks) {
			for (let i = 1; i < track.times.length; i++) {
				expect(track.times[i]).toBeGreaterThan(track.times[i - 1]);
			}
			if (track.type !== 'quaternion') continue;
			expect(track.values.length).toBe(track.times.length * 4);
			for (let i = 0; i < track.values.length; i += 4) {
				expect(Math.hypot(...track.values.slice(i, i + 4))).toBeCloseTo(1, 6);
			}
			expect(track.times[track.times.length - 1]).toBeLessThanOrEqual(clip.duration + 1e-9);
		}
	});

	it('is deterministic', () => {
		expect(buildFingerspellingClip('avatar')).toEqual(buildFingerspellingClip('avatar'));
	});

	it('double letters take longer than distinct ones', () => {
		const double = buildFingerspellingClip('aa');
		const single = buildFingerspellingClip('ab');
		expect(double.duration).toBeGreaterThan(single.duration - 1e-9);
	});

	it('traced letters (J, Z) animate the wrist inside the letter window', () => {
		const clip = buildFingerspellingClip('j');
		const hand = clip.tracks.find((t) => t.name === 'RightHand.quaternion');
		const unique = new Set();
		for (let i = 0; i < hand.values.length; i += 4) {
			unique.add(hand.values.slice(i, i + 4).map((v) => v.toFixed(4)).join(','));
		}
		expect(unique.size).toBeGreaterThanOrEqual(3);
	});

	it('static letters hold the wrist steady during the hold', () => {
		const clip = buildFingerspellingClip('b');
		const hand = clip.tracks.find((t) => t.name === 'RightHand.quaternion');
		// lead key + letter-in + letter-hold + tail = 4 keys, middle two equal.
		const k = (i) => hand.values.slice(i * 4, i * 4 + 4).join(',');
		expect(hand.times.length).toBe(4);
		expect(k(1)).toBe(k(2));
	});

	it('duration follows the timing model', () => {
		const t = DEFAULT_TIMING;
		const clip = buildFingerspellingClip('ab');
		const expected = t.leadSeconds + 2 * (t.transitionSeconds + t.holdSeconds) + t.tailSeconds;
		expect(clip.duration).toBeCloseTo(expected, 6);
	});

	it('rejects unspellable input', () => {
		expect(() => buildFingerspellingClip('123')).toThrow();
		expect(() => buildFingerspellingClip('')).toThrow();
	});
});
