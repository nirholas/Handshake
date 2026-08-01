import { describe, expect, it } from 'vitest';
import { HANDSHAPES } from '../src/sign-handshapes.js';
import { HAND_CONNECTIONS, HAND_LANDMARKS, handshapeLandmarks, projectHand } from '../src/sign-hand-model.js';
import { GradeSmoother, gradeHandshape, handMetrics, handshapeMetrics, rankHandshapes } from '../src/sign-grader.js';

const LETTERS = 'ABCDEFGHIKLMNOPQRSTUVWXY'.split('');

/** Rigid-body transform: grading must not care where a hand is or how it is turned. */
function transform(points, { angle = 0, scale = 1, offset = [0, 0, 0] } = {}) {
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	return points.map(([x, y, z]) => [
		(x * c - z * s) * scale + offset[0],
		y * scale + offset[1],
		(x * s + z * c) * scale + offset[2],
	]);
}

/** Mirror across X, which is what a left hand is. */
const mirror = (points) => points.map(([x, y, z]) => [-x, y, z]);

describe('the reference hand', () => {
	it('lays a handshape out in MediaPipe landmark order', () => {
		const hand = handshapeLandmarks('B');
		expect(hand).toHaveLength(21);
		for (const p of hand) expect(p.every(Number.isFinite)).toBe(true);
		// Fingertips are further from the wrist than their own knuckles.
		const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
		const wrist = hand[HAND_LANDMARKS.WRIST];
		expect(dist(hand[HAND_LANDMARKS.INDEX_TIP], wrist)).toBeGreaterThan(dist(hand[HAND_LANDMARKS.INDEX_MCP], wrist));
	});

	it('builds every handshape in the catalogue', () => {
		for (const name of Object.keys(HANDSHAPES)) {
			expect(handshapeLandmarks(name), name).toHaveLength(21);
		}
	});

	it('draws with connections that stay inside the point set', () => {
		for (const [a, b] of HAND_CONNECTIONS) {
			expect(a).toBeGreaterThanOrEqual(0);
			expect(b).toBeLessThan(21);
		}
	});

	it('projects into the requested box', () => {
		const pts = projectHand(handshapeLandmarks('5'), { width: 200, height: 240, padding: 10 });
		expect(pts).toHaveLength(21);
		for (const { x, y } of pts) {
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(200);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(240);
		}
	});
});

describe('handMetrics', () => {
	it('reads a closed fist as curled and an open hand as straight', () => {
		const fist = handMetrics(handshapeLandmarks('S'));
		const open = handMetrics(handshapeLandmarks('5'));
		for (const finger of ['Index', 'Middle', 'Ring', 'Pinky']) {
			expect(fist.curl[finger], finger).toBeGreaterThan(180);
			expect(open.curl[finger], finger).toBeLessThan(60);
		}
	});

	it('separates a spread hand from a flat one', () => {
		const five = handMetrics(handshapeLandmarks('5'));
		const flat = handMetrics(handshapeLandmarks('B'));
		expect(five.spread['Index-Middle']).toBeGreaterThan(flat.spread['Index-Middle']);
	});

	it('measures V as two fingers apart and U as two fingers together', () => {
		expect(handMetrics(handshapeLandmarks('V')).spread['Index-Middle']).toBeGreaterThan(12);
		expect(handMetrics(handshapeLandmarks('U')).spread['Index-Middle']).toBeLessThan(4);
	});

	it('reads a pinch as a short thumb-to-fingertip distance', () => {
		// F closes the index onto the thumb and leaves the rest open.
		const f = handMetrics(handshapeLandmarks('F'));
		expect(f.pinch.Index).toBeLessThan(f.pinch.Pinky);
	});

	it('rejects anything that is not 21 points', () => {
		expect(() => handMetrics([])).toThrow(/21 landmarks/);
		expect(() => handMetrics(null)).toThrow(/21 landmarks/);
	});

	it('accepts MediaPipe {x, y, z} objects as well as arrays', () => {
		const arr = handshapeLandmarks('C');
		const objs = arr.map(([x, y, z]) => ({ x, y, z }));
		expect(handMetrics(objs).curl.Index).toBeCloseTo(handMetrics(arr).curl.Index, 6);
	});
});

describe('gradeHandshape', () => {
	it('gives the rig its own handshape back at full marks', () => {
		for (const letter of LETTERS) {
			expect(gradeHandshape(handshapeLandmarks(letter), letter).score, letter).toBeGreaterThan(99.5);
		}
	});

	it('scores a different letter far lower than the right one', () => {
		expect(gradeHandshape(handshapeLandmarks('B'), 'A').score).toBeLessThan(45);
		expect(gradeHandshape(handshapeLandmarks('A'), 'B').score).toBeLessThan(45);
	});

	it('ranks the correct letter first for every letter that has a shape of its own', () => {
		// G/Q and K/P are the same handshape in ASL and differ only by which way
		// the hand points, which a handshape score cannot and should not see.
		const shared = new Set(['G', 'Q', 'K', 'P']);
		for (const letter of LETTERS) {
			if (shared.has(letter)) continue;
			expect(rankHandshapes(handshapeLandmarks(letter), LETTERS)[0].name, letter).toBe(letter);
		}
	});

	it('is invariant to where the hand is, how big it is, and which way it faces', () => {
		const moved = transform(handshapeLandmarks('D'), { angle: 0.9, scale: 3.4, offset: [12, -5, 7] });
		expect(gradeHandshape(moved, 'D').score).toBeGreaterThan(99.5);
	});

	it('grades a left hand against a right-hand target', () => {
		expect(gradeHandshape(mirror(handshapeLandmarks('W')), 'W').score).toBeGreaterThan(99);
	});

	it('names the finger that is wrong', () => {
		// I is the pinky alone; holding up the index instead should call that out.
		const grade = gradeHandshape(handshapeLandmarks('D'), 'I');
		expect(grade.score).toBeLessThan(70);
		expect(grade.hint).toMatch(/index|pinky/i);
	});

	it('tells a learner to hold it once the shape is right', () => {
		expect(gradeHandshape(handshapeLandmarks('L'), 'L').hint).toMatch(/hold/i);
	});

	it('reports per-finger detail against the same target the avatar wears', () => {
		const grade = gradeHandshape(handshapeLandmarks('A'), 'A');
		expect(grade.fingers).toHaveLength(4);
		for (const f of grade.fingers) {
			expect(f.target).toBeCloseTo(handshapeMetrics('A').curl[f.finger], 6);
			expect(Math.abs(f.delta)).toBeLessThan(1e-6);
		}
	});

	it('refuses a handshape it does not know', () => {
		expect(() => gradeHandshape(handshapeLandmarks('A'), 'NOT_A_SHAPE')).toThrow(/handshape/i);
	});
});

describe('GradeSmoother', () => {
	const frame = (score) => ({ score, hint: 'x' });

	it('needs a sustained hold, not one lucky frame', () => {
		const s = new GradeSmoother({ alpha: 1, passScore: 80, holdMs: 500 });
		expect(s.push(frame(95), 1000).passed).toBe(false);
		expect(s.push(frame(95), 1200).passed).toBe(false);
		expect(s.push(frame(95), 1600).passed).toBe(true);
	});

	it('drops the hold when the hand leaves the shape', () => {
		const s = new GradeSmoother({ alpha: 1, passScore: 80, holdMs: 300 });
		s.push(frame(95), 0);
		expect(s.push(frame(20), 200).holding).toBe(false);
		expect(s.push(frame(95), 400).passed).toBe(false);
		expect(s.push(frame(95), 750).passed).toBe(true);
	});

	it('smooths a jittering score instead of following every frame', () => {
		const s = new GradeSmoother({ alpha: 0.25 });
		s.push(frame(90), 0);
		const jittered = s.push(frame(10), 40).score;
		expect(jittered).toBeGreaterThan(50);
		expect(jittered).toBeLessThan(90);
	});

	it('starts clean after a reset', () => {
		const s = new GradeSmoother({ alpha: 0.5 });
		s.push(frame(100), 0);
		s.reset();
		expect(s.push(frame(40), 100).score).toBe(40);
	});
});
