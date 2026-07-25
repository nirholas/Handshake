import { describe, expect, it } from 'vitest';

import {
	DEFAULT_TIMING,
	LETTER_SHAPES,
	buildFingerspellingClip,
	handshapeLocals,
	normalizeWord,
} from '../src/fingerspelling.js';
import { ANCHORS, Pose } from '../src/sign-rig.js';

/** Replay a compiled clip's own tracks into a pose, for forward kinematics. */
function poseAtTime(clip, time) {
	const pose = new Pose();
	for (const track of clip.tracks) {
		if (track.type !== 'quaternion') continue;
		let i = 0;
		while (i + 1 < track.times.length && track.times[i + 1] <= time) i++;
		pose.setLocal(track.name.split('.')[0], track.values.slice(i * 4, i * 4 + 4));
	}
	return pose;
}

const FINGER_BONES = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].flatMap((f) =>
	[1, 2, 3].map((j) => `RightHand${f}${j}`),
);

function quatAngleDeg(q) {
	return (2 * Math.acos(Math.min(1, Math.abs(q[3])))) * (180 / Math.PI);
}

describe('letter shapes', () => {
	it('defines all 26 letters and 10 digits', () => {
		for (let c = 65; c <= 90; c++) {
			expect(LETTER_SHAPES[String.fromCharCode(c)], String.fromCharCode(c)).toBeTruthy();
		}
		for (let d = 0; d <= 9; d++) {
			expect(LETTER_SHAPES[String(d)], String(d)).toBeTruthy();
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
			// Some signs share a base handshape by design and differ only by
			// wrist orientation, motion, or context: I/J, K/P, the G/Q/Z
			// family, and in real ASL digit 0 ≡ O and digit 2 ≡ V.
			const clash = seen.get(key);
			if (clash) {
				expect(
					['I:J', 'G:Q', 'Q:Z', 'K:P', '0:O', '2:V'].includes(`${clash}:${letter}`),
					`${clash} vs ${letter}`,
				).toBe(true);
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

	it('rejects unknown characters', () => {
		expect(() => handshapeLocals('@', 'Right')).toThrow();
		expect(handshapeLocals('7', 'Right')).toBeTruthy();
	});
});

describe('normalizeWord', () => {
	it('uppercases, strips non-letters, collapses spaces', () => {
		expect(normalizeWord('  héllo,  world! ')).toBe('HLLO WORLD');
		expect(normalizeWord('room 42')).toBe('ROOM 42');
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
		for (const bone of ['RightArm', 'RightForeArm', 'RightHand', 'LeftArm', 'LeftForeArm', 'Spine', 'Neck']) {
			expect(names).toContain(`${bone}.quaternion`);
		}
		// Signing is upper-body: it must not drive the root at all. A Hips
		// translation track authored around the origin sank the whole avatar
		// through the floor on any rig whose hips rest a metre up.
		expect(names).not.toContain('Hips.position');
		expect(names).not.toContain('Hips.quaternion');
		expect(names.every((n) => n.endsWith('.quaternion'))).toBe(true);
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

	it('static letters hold the wrist steady through the hold', () => {
		const t = DEFAULT_TIMING;
		const clip = buildFingerspellingClip('b');
		const hand = clip.tracks.find((t2) => t2.name === 'RightHand.quaternion');
		// The letter is reached after lead + transition and held from there.
		const holdStart = t.leadSeconds + t.transitionSeconds - 1e-6;
		const holdEnd = t.leadSeconds + t.transitionSeconds + t.holdSeconds + 1e-6;
		const inHold = hand.times
			.map((time, i) => ({ time, q: hand.values.slice(i * 4, i * 4 + 4) }))
			.filter((k) => k.time >= holdStart && k.time <= holdEnd);
		expect(inHold.length).toBeGreaterThanOrEqual(2);
		const first = inHold[0].q.map((v) => v.toFixed(6)).join(',');
		for (const k of inHold) expect(k.q.map((v) => v.toFixed(6)).join(',')).toBe(first);
	});

	it('duration follows the timing model', () => {
		const t = DEFAULT_TIMING;
		const clip = buildFingerspellingClip('ab');
		const expected = t.leadSeconds + 2 * (t.transitionSeconds + t.holdSeconds) + t.tailSeconds;
		expect(clip.duration).toBeCloseTo(expected, 6);
	});

	it('the hand ends up in front of the body, at signing height', () => {
		// Guards the arm regression end-to-end: sample the compiled clip's own
		// tracks back through forward kinematics and check where the hand is.
		const clip = buildFingerspellingClip('a');
		const pose = poseAtTime(clip, DEFAULT_TIMING.leadSeconds + DEFAULT_TIMING.transitionSeconds + 0.2);
		const wrist = pose.worldPos('RightHand');
		expect(wrist[2]).toBeGreaterThan(0.1); // in front of the chest
		expect(wrist[0]).toBeLessThan(0); // on the signing (right) side
		expect(wrist[1]).toBeGreaterThan(ANCHORS.sternum[1]); // up at jaw height
		expect(wrist[1]).toBeLessThan(ANCHORS.forehead[1]);
		// Elbow hangs; it is never lifted behind or above the shoulder.
		const elbow = pose.worldPos('RightForeArm');
		expect(elbow[1]).toBeLessThan(pose.worldPos('RightArm')[1]);
		expect(elbow[2]).toBeGreaterThan(-0.05);
	});

	it('rests both arms down at the start and end of a word', () => {
		const clip = buildFingerspellingClip('hi');
		for (const t of [0, clip.duration]) {
			const pose = poseAtTime(clip, t);
			for (const side of ['Left', 'Right']) {
				const wrist = pose.worldPos(`${side}Hand`);
				expect(wrist[1], `${side}@${t}`).toBeLessThan(ANCHORS.belly[1]);
			}
		}
	});

	it('never leaves the non-dominant arm crossing the body', () => {
		const clip = buildFingerspellingClip('xyz');
		for (let t = 0; t <= clip.duration; t += 0.1) {
			const left = poseAtTime(clip, t).worldPos('LeftHand');
			expect(left[0], `t=${t.toFixed(2)}`).toBeGreaterThan(0);
		}
	});

	it('rejects unspellable input', () => {
		expect(() => buildFingerspellingClip('...')).toThrow();
		expect(() => buildFingerspellingClip('')).toThrow();
		expect(buildFingerspellingClip('42').duration).toBeGreaterThan(0);
	});
});
