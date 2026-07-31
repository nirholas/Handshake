// The handshape grader: score a hand a camera sees against the handshape the
// avatar is wearing, and say which finger is wrong.
//
// The trick is that nothing here describes a letter. The target is measured,
// not written down: `sign-hand-model.js` poses the canonical rig with the SAME
// handshape spec the avatar uses and hands back 21 landmark points, and this
// file runs one measurement function over both that reference hand and the
// hand in front of the camera. Grading is then a comparison of two vectors in
// identical units.
//
// Consequences worth knowing:
//   * Retuning a letter in HANDSHAPES retunes the grader. There is no second
//     table to keep in sync, and no way for the two to disagree.
//   * Every measurement is an angle or a ratio of the hand's own size, so the
//     score is invariant to where the hand is, how big it is, how far from the
//     lens, and which way it is rotated.
//   * Left and right hands measure the same, because mirroring a hand does not
//     change any joint angle or any fingertip distance.
//
// Nothing in this file touches the network or the DOM: give it 21 points and it
// returns a number and a sentence.

import { HAND_DIGITS, HAND_LANDMARKS, handScale, handshapeLandmarks } from './sign-hand-model.js';

const DEG = 180 / Math.PI;
const FINGER_NAMES = ['Index', 'Middle', 'Ring', 'Pinky'];
const SPREAD_PAIRS = [['Index', 'Middle'], ['Middle', 'Ring'], ['Ring', 'Pinky']];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], (a[2] ?? 0) - (b[2] ?? 0)];
const len = (v) => Math.hypot(v[0], v[1], v[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

/** Angle in degrees between two vectors, 0 when parallel. */
function angleBetween(a, b) {
	const la = len(a), lb = len(b);
	if (la < 1e-9 || lb < 1e-9) return 0;
	return Math.acos(clamp(dot(a, b) / (la * lb), -1, 1)) * DEG;
}

/** Bend at `b` on the chain a → b → c. 0 is a straight line. */
function bend(a, b, c) {
	return angleBetween(sub(b, a), sub(c, b));
}

/** A landmark array, tolerating `{x, y, z}` objects as MediaPipe returns them. */
function toPoints(landmarks) {
	if (!Array.isArray(landmarks) || landmarks.length < 21) {
		throw new Error(`a hand needs 21 landmarks, got ${Array.isArray(landmarks) ? landmarks.length : typeof landmarks}`);
	}
	return landmarks.map((p) => (Array.isArray(p) ? [p[0], p[1], p[2] ?? 0] : [p.x, p.y, p.z ?? 0]));
}

/**
 * Measure a hand. Every field is either degrees or a multiple of the hand's own
 * palm length, so two hands of any size and pose are directly comparable.
 *
 * @param {number[][]|{x:number,y:number,z?:number}[]} landmarks  21 points
 * @returns {{
 *   curl: Record<string, number>,
 *   spread: Record<string, number>,
 *   thumbCurl: number,
 *   thumbSpread: number,
 *   pinch: Record<string, number>,
 *   scale: number,
 * }}
 */
export function handMetrics(landmarks) {
	const p = toPoints(landmarks);
	const wrist = p[HAND_LANDMARKS.WRIST];
	const scale = handScale(p);

	const curl = {};
	const dir = {};
	const tip = {};
	for (const { name, points: [mcpI, pipI, dipI, tipI] } of HAND_DIGITS) {
		if (name === 'Thumb') continue;
		// Knuckle bend measures against the palm, so a finger folded at the
		// knuckle reads as curled even when its phalanges stay straight.
		curl[name] = bend(wrist, p[mcpI], p[pipI]) + bend(p[mcpI], p[pipI], p[dipI]) + bend(p[pipI], p[dipI], p[tipI]);
		dir[name] = sub(p[tipI], p[mcpI]);
		tip[name] = p[tipI];
	}

	const spread = {};
	for (const [a, b] of SPREAD_PAIRS) spread[`${a}-${b}`] = angleBetween(dir[a], dir[b]);

	// Signed sideways offset between neighbouring fingertips, along the palm's
	// own radial axis. An angle alone cannot tell fingers apart from fingers
	// crossed: R and V both read as "14 degrees between them". The sign can, and
	// it survives mirroring, because flipping the hand flips both the axis and
	// the offset.
	const radial = sub(p[HAND_LANDMARKS.INDEX_MCP], p[HAND_LANDMARKS.PINKY_MCP]);
	const rl = len(radial) || 1;
	const lateral = {};
	for (const [a, b] of SPREAD_PAIRS) {
		lateral[`${a}-${b}`] = dot(sub(tip[a], tip[b]), radial) / (rl * scale);
	}

	const thumbCurl =
		bend(p[HAND_LANDMARKS.THUMB_CMC], p[HAND_LANDMARKS.THUMB_MCP], p[HAND_LANDMARKS.THUMB_IP]) +
		bend(p[HAND_LANDMARKS.THUMB_MCP], p[HAND_LANDMARKS.THUMB_IP], p[HAND_LANDMARKS.THUMB_TIP]);
	// Measured at the wrist against the middle knuckle: both are rigid palm
	// points, so this stays meaningful when every finger is closed.
	const thumbSpread = angleBetween(sub(p[HAND_LANDMARKS.THUMB_TIP], wrist), sub(p[HAND_LANDMARKS.MIDDLE_MCP], wrist));

	const pinch = {};
	for (const { name, points } of HAND_DIGITS) {
		if (name === 'Thumb') continue;
		pinch[name] = len(sub(p[points[3]], p[HAND_LANDMARKS.THUMB_TIP])) / scale;
	}

	return { curl, spread, lateral, thumbCurl, thumbSpread, pinch, scale };
}

// How far a measurement may drift before it scores zero. Wide enough that a
// human hand held with ordinary care scores well, tight enough that a different
// letter never does. Degrees, except `pinch`, which is palm lengths.
const TOLERANCE = Object.freeze({ curl: 62, spread: 30, lateral: 0.34, thumbCurl: 52, thumbSpread: 34, pinch: 0.55 });

// What each measurement is worth. The four finger curls carry the letter; the
// thumb decides between look-alikes (A vs S, M vs N); pinch distance is what
// separates the closed circles (F, O, 6-9) from the open shapes.
const WEIGHT = Object.freeze({ curl: 1, spread: 0.35, lateral: 0.55, thumbCurl: 0.6, thumbSpread: 0.85, pinch: 0.5 });

const match = (err, tol) => clamp(1 - err / tol, 0, 1);

const _targets = new Map();
/** Measured metrics of the perfectly formed handshape (cached per name). */
export function handshapeMetrics(name) {
	let m = _targets.get(name);
	if (!m) {
		m = handMetrics(handshapeLandmarks(name));
		_targets.set(name, m);
	}
	return m;
}

function fingerHint(finger, delta) {
	const part = finger.toLowerCase();
	if (delta > 0) return `Curl your ${part} finger in more.`;
	return `Straighten your ${part} finger.`;
}

/**
 * Grade a hand against a handshape.
 *
 * @param {number[][]|{x:number,y:number,z?:number}[]} landmarks  21 points from a hand landmarker
 * @param {string} name  a HANDSHAPES key
 * @returns {{
 *   score: number,
 *   name: string,
 *   fingers: {finger: string, score: number, observed: number, target: number, delta: number}[],
 *   thumb: {score: number, curlDelta: number, spreadDelta: number},
 *   hint: string,
 *   metrics: ReturnType<typeof handMetrics>,
 * }}
 */
export function gradeHandshape(landmarks, name) {
	const observed = handMetrics(landmarks);
	const target = handshapeMetrics(name);

	let total = 0;
	let weighted = 0;
	/** @type {{key: string, weight: number, score: number, label: string, delta: number}[]} */
	const terms = [];
	const add = (key, err, tol, weight, label, delta) => {
		const s = match(err, tol);
		total += weight;
		weighted += weight * s;
		terms.push({ key, weight, score: s, label, delta });
		return s;
	};

	const fingers = FINGER_NAMES.map((finger) => {
		const delta = observed.curl[finger] - target.curl[finger];
		const s = add(`curl:${finger}`, Math.abs(delta), TOLERANCE.curl, WEIGHT.curl, fingerHint(finger, -delta), delta);
		return { finger, score: s, observed: observed.curl[finger], target: target.curl[finger], delta };
	});

	for (const [a, b] of SPREAD_PAIRS) {
		const key = `${a}-${b}`;
		const lower = `${a.toLowerCase()} and ${b.toLowerCase()} fingers`;
		const delta = observed.spread[key] - target.spread[key];
		add(
			`spread:${key}`,
			Math.abs(delta),
			TOLERANCE.spread,
			WEIGHT.spread,
			delta > 0 ? `Bring your ${lower} together.` : `Spread your ${lower} apart.`,
			delta,
		);
		const side = observed.lateral[key] - target.lateral[key];
		const crossed = target.lateral[key] < 0;
		add(
			`lateral:${key}`,
			Math.abs(side),
			TOLERANCE.lateral,
			WEIGHT.lateral,
			crossed ? `Cross your ${lower}: ${a.toLowerCase()} over ${b.toLowerCase()}.` : `Line your ${lower} up side by side.`,
			side,
		);
	}

	const curlDelta = observed.thumbCurl - target.thumbCurl;
	const thumbCurlScore = add(
		'thumbCurl',
		Math.abs(curlDelta),
		TOLERANCE.thumbCurl,
		WEIGHT.thumbCurl,
		curlDelta > 0 ? 'Straighten your thumb.' : 'Bend your thumb.',
		curlDelta,
	);
	const spreadDelta = observed.thumbSpread - target.thumbSpread;
	const thumbSpreadScore = add(
		'thumbSpread',
		Math.abs(spreadDelta),
		TOLERANCE.thumbSpread,
		WEIGHT.thumbSpread,
		spreadDelta > 0 ? 'Bring your thumb in toward your palm.' : 'Move your thumb further out from your palm.',
		spreadDelta,
	);

	for (const finger of FINGER_NAMES) {
		const delta = observed.pinch[finger] - target.pinch[finger];
		const label = delta > 0 ? `Touch your thumb to your ${finger.toLowerCase()} fingertip.` : `Move your thumb away from your ${finger.toLowerCase()} fingertip.`;
		add(`pinch:${finger}`, Math.abs(delta), TOLERANCE.pinch, WEIGHT.pinch, label, delta);
	}

	const score = total > 0 ? (weighted / total) * 100 : 0;
	// The hint is the single measurement costing the most points, so the advice
	// is always the one change that helps most.
	let worst = null;
	for (const t of terms) {
		const cost = t.weight * (1 - t.score);
		if (!worst || cost > worst.cost) worst = { ...t, cost };
	}
	const hint = score >= 88 ? 'That is the shape. Hold it.' : worst && worst.cost > 0.08 ? worst.label : 'Almost there: hold steady.';

	return {
		score,
		name,
		fingers,
		thumb: { score: (thumbCurlScore + thumbSpreadScore) / 2, curlDelta, spreadDelta },
		hint,
		metrics: observed,
	};
}

/**
 * Which handshape a hand looks most like. Used to tell a learner they have
 * formed a real letter, just not the one they were asked for, which is the
 * single most useful correction in the manual alphabet.
 *
 * @param {number[][]} landmarks
 * @param {string[]} candidates
 * @returns {{name: string, score: number}[]} best first
 */
export function rankHandshapes(landmarks, candidates) {
	return candidates
		.map((name) => ({ name, score: gradeHandshape(landmarks, name).score }))
		.sort((a, b) => b.score - a.score);
}

/**
 * Time smoothing for a live camera feed.
 *
 * A landmarker jitters frame to frame, and a raw score flickers enough to be
 * unreadable and to pass a letter the learner never actually held. This keeps
 * an exponential average and reports a hold only once the smoothed score has
 * stayed above the bar for a real stretch of time.
 */
export class GradeSmoother {
	/**
	 * @param {{ alpha?: number, passScore?: number, holdMs?: number }} [opts]
	 *   `alpha` is the weight of each new frame (lower is smoother), `passScore`
	 *   the bar to clear, `holdMs` how long it must stay cleared.
	 */
	constructor(opts = {}) {
		this.alpha = opts.alpha ?? 0.28;
		this.passScore = opts.passScore ?? 78;
		this.holdMs = opts.holdMs ?? 700;
		this.value = 0;
		this.since = 0;
		this.hint = '';
		this.seen = false;
	}

	/**
	 * Feed one graded frame.
	 * @param {{score: number, hint: string}} grade
	 * @param {number} now  a monotonic timestamp in ms
	 * @returns {{score: number, hint: string, holding: boolean, heldMs: number, passed: boolean}}
	 */
	push(grade, now) {
		this.value = this.seen ? this.value + (grade.score - this.value) * this.alpha : grade.score;
		this.seen = true;
		this.hint = grade.hint;
		const holding = this.value >= this.passScore;
		if (!holding) this.since = 0;
		else if (!this.since) this.since = now;
		const heldMs = holding ? now - this.since : 0;
		return { score: this.value, hint: this.hint, holding, heldMs, passed: heldMs >= this.holdMs };
	}

	/** Forget the current hold, e.g. after moving to the next letter. */
	reset() {
		this.value = 0;
		this.since = 0;
		this.seen = false;
		this.hint = '';
	}
}

export { TOLERANCE, WEIGHT };
