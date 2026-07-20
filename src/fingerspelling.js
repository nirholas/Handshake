// ASL fingerspelling clip builder — turn a word into a canonical-skeleton
// animation clip that spells it letter by letter on the dominant (right) hand.
//
// Every handshape is defined parametrically (per-finger curl, splay, a thumb
// preset, optional wrist orientation) and compiled to local joint rotations on
// the canonical bones (RightHandIndex1 … RightHandThumb3 plus the right arm
// chain), emitting the SAME AnimationClip JSON document the animation library
// and the motion-capture lanes produce. That means a spelled word retargets
// onto any rigged avatar through src/animation-retarget.js with zero new
// playback machinery.
//
// Letters with movement (J traces from I, Z traces with the index) carry wrist
// keyframes inside their letter window. Double letters get a small outward
// bounce between the two holds, matching how signers disambiguate them.
//
// Scope note: fingerspelling is the receptive-friendly, deterministic subset
// of sign language — it spells English words; it is not grammatical ASL.
// Lexical sign clips come from the motion-capture lane (video2motion), not
// from this module.

// ── quaternion + vector helpers ([x, y, z, w], matching three.js) ──────────

const IDENT = [0, 0, 0, 1];

function qMul(a, b) {
	const [ax, ay, az, aw] = a;
	const [bx, by, bz, bw] = b;
	return [
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz,
	];
}

function qConj(q) {
	return [-q[0], -q[1], -q[2], q[3]];
}

function qNorm(q) {
	const n = Math.hypot(q[0], q[1], q[2], q[3]);
	if (n < 1e-8) return [...IDENT];
	return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

function qAxisAngle(axis, deg) {
	const [x, y, z] = vNorm(axis);
	const half = (deg * Math.PI) / 360;
	const s = Math.sin(half);
	return [x * s, y * s, z * s, Math.cos(half)];
}

function vNorm(v) {
	const n = Math.hypot(v[0], v[1], v[2]);
	if (n < 1e-8) return [0, 0, 0];
	return [v[0] / n, v[1] / n, v[2] / n];
}

function vCross(a, b) {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function vDot(a, b) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vRot(q, v) {
	const p = qMul(qMul(q, [v[0], v[1], v[2], 0]), qConj(q));
	return [p[0], p[1], p[2]];
}

function shortestArc(from, to) {
	const f = vNorm(from);
	const t = vNorm(to);
	const d = vDot(f, t);
	if (d > 1 - 1e-9) return [...IDENT];
	if (d < -1 + 1e-9) {
		let axis = vCross(f, [1, 0, 0]);
		if (Math.hypot(...axis) < 1e-6) axis = vCross(f, [0, 1, 0]);
		const [x, y, z] = vNorm(axis);
		return [x, y, z, 0];
	}
	const axis = vCross(f, t);
	return qNorm([axis[0], axis[1], axis[2], 1 + d]);
}

// Orientation carrying rest axes (restDir, restNormal) onto (dir, normal):
// swing to the direction, then a pure twist about it to line up the normal.
function frameQuat(dir, normal, restDir, restNormal) {
	const swing = shortestArc(restDir, dir);
	const d = vNorm(dir);
	let n = vNorm(normal);
	n = vNorm([n[0] - d[0] * vDot(n, d), n[1] - d[1] * vDot(n, d), n[2] - d[2] * vDot(n, d)]);
	if (Math.hypot(...n) < 1e-5) return swing;
	let carried = vRot(swing, restNormal);
	carried = vNorm([
		carried[0] - d[0] * vDot(carried, d),
		carried[1] - d[1] * vDot(carried, d),
		carried[2] - d[2] * vDot(carried, d),
	]);
	if (Math.hypot(...carried) < 1e-5) return swing;
	const twist = shortestArc(carried, n);
	const a = vDot([twist[0], twist[1], twist[2]], d);
	return qMul(qNorm([d[0] * a, d[1] * a, d[2] * a, twist[3]]), swing);
}

// ── the signing arm pose (right hand raised, palm out, left arm relaxed) ───
//
// Canonical rest is a T-pose (arms along ±X, palms down), so every arm bone
// needs a pose even when "static": zero rotation would leave the avatar
// signing from a T-pose. Locals are derived from target global directions the
// same way the capture solver does it, so they read naturally on any rig.

function chainLocals(side, upperDir, lowerDir, handDir, handNormal) {
	const s = side === 'Left' ? 1 : -1;
	const rest = [s, 0, 0];
	const gUpper = shortestArc(rest, upperDir);
	const lowerLocalDir = vRot(qConj(gUpper), lowerDir);
	const lowerLocal = shortestArc(rest, lowerLocalDir);
	const gLower = qMul(gUpper, lowerLocal);
	const gHand = frameQuat(handDir, handNormal, rest, [0, 1, 0]);
	const handLocal = qMul(qConj(gLower), gHand);
	return {
		[`${side}Arm`]: qNorm(gUpper),
		[`${side}ForeArm`]: qNorm(lowerLocal),
		[`${side}Hand`]: qNorm(handLocal),
		[`__g${side}Hand`]: gHand,
		[`__g${side}Lower`]: gLower,
	};
}

// Right hand up in signing space beside the shoulder: fingers up, palm to the
// viewer (+Z), elbow dropped. The left arm hangs relaxed at the side using
// locals sampled from the baked idle clip's first frame (the library's own
// convention), which reads naturally after the retargeter's bind correction
// where a geometrically-derived "down" did not.
function signingPose() {
	const right = chainLocals('Right', vNorm([-0.3, -0.85, 0.3]), vNorm([0.1, 0.8, 0.45]), [0, 1, 0], [0, 0, -1]);
	return {
		...right,
		LeftArm: qNorm([0.5402, 0.1202, -0.0234, 0.8326]),
		LeftForeArm: qNorm([0.0199, 0.0244, 0.1378, 0.99]),
		LeftHand: qNorm([-0.0098, -0.0091, -0.029, 0.9995]),
	};
}

// ── handshape model ────────────────────────────────────────────────────────

const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];

// Per-joint shares of a full curl (proximal knuckles carry most of it).
const CURL_WEIGHTS = [85, 100, 65];

// Thumb presets, as [joint1, joint2, joint3] rotations composed from curl
// about the thumb hinge and swing toward/away from the palm. Tuned for the
// right hand and mirrored for the left via axis sign.
const THUMB_PRESETS = {
	// resting against the index side, pointing along the fingers
	side: { adduct: 22, curl: [8, 10, 5] },
	// extended away from the palm (L / Y / thumbs-out shapes)
	out: { adduct: -55, curl: [0, 0, 0] },
	// folded across the palm, under or over the curled fingers
	across: { adduct: 55, curl: [30, 45, 30] },
	// opposing the fingertips (O / F / D circles)
	oppose: { adduct: 40, curl: [18, 30, 22] },
	// tip pinned between index and middle (T) / at the middle knuckle (K)
	between: { adduct: 38, curl: [22, 30, 15] },
};

// A handshape: curl 0..1 per finger (or [j1,j2,j3] explicit degrees), splay
// in degrees (+ toward the thumb), a thumb preset, an optional wrist offset
// {pitch,yaw,roll} in degrees applied on top of the signing pose, and an
// optional motion ('J' | 'Z') traced inside the letter's time window.
export const LETTER_SHAPES = {
	A: { curl: { Index: 1, Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'side' },
	B: { curl: {}, thumb: 'across' },
	C: { curl: { Index: 0.45, Middle: 0.45, Ring: 0.45, Pinky: 0.45 }, thumb: 'oppose' },
	D: { curl: { Middle: 0.7, Ring: 0.7, Pinky: 0.7 }, thumb: 'oppose' },
	E: { curl: { Index: 0.85, Middle: 0.85, Ring: 0.85, Pinky: 0.85 }, thumb: 'across' },
	F: { curl: { Index: 0.55 }, splay: { Middle: 6, Ring: 0, Pinky: -8 }, thumb: 'oppose' },
	G: { curl: { Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'side', wrist: { local: [0, 1, 0], deg: 85 } },
	H: { curl: { Ring: 1, Pinky: 1 }, thumb: 'side', wrist: { local: [0, 1, 0], deg: 85 } },
	I: { curl: { Index: 1, Middle: 1, Ring: 1 }, thumb: 'across' },
	J: { curl: { Index: 1, Middle: 1, Ring: 1 }, thumb: 'across', motion: 'J' },
	K: { curl: { Middle: [40, 15, 10], Ring: 1, Pinky: 1 }, thumb: 'between' },
	L: { curl: { Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'out' },
	M: { curl: { Index: 0.75, Middle: 0.75, Ring: 0.75, Pinky: 0.95 }, thumb: 'across' },
	N: { curl: { Index: 0.75, Middle: 0.75, Ring: 0.95, Pinky: 0.95 }, thumb: 'across' },
	O: { curl: { Index: 0.55, Middle: 0.55, Ring: 0.55, Pinky: 0.55 }, thumb: 'oppose' },
	P: { curl: { Middle: [40, 15, 10], Ring: 1, Pinky: 1 }, thumb: 'between', wrist: { dir: [0.15, -0.85, 0.5], normal: [0, 1, 0.2] } },
	Q: { curl: { Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'side', wrist: { dir: [0.15, -0.85, 0.5], normal: [0, 1, 0.2] } },
	R: { curl: { Ring: 1, Pinky: 1 }, splay: { Index: -6, Middle: 8 }, thumb: 'across' },
	S: { curl: { Index: 1, Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'across' },
	T: { curl: { Index: 0.9, Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'between' },
	U: { curl: { Ring: 1, Pinky: 1 }, thumb: 'across' },
	V: { curl: { Ring: 1, Pinky: 1 }, splay: { Index: 9, Middle: -9 }, thumb: 'across' },
	W: { curl: { Pinky: 1 }, splay: { Index: 10, Middle: 0, Ring: -10 }, thumb: 'across' },
	X: { curl: { Index: [15, 95, 80], Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'side' },
	Y: { curl: { Index: 1, Middle: 1, Ring: 1 }, thumb: 'out' },
	Z: { curl: { Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'side', motion: 'Z' },
};

// Wrist paths for the traced letters, keyed 0..1 across the letter window —
// absolute {dir, normal} orientations like every other wrist spec. J dips and
// supinates so the pinky draws the hook; Z jabs the index through the zigzag.
const MOTIONS = {
	J: [
		{ at: 0.0, wrist: { dir: [0, 1, 0], normal: [0, 0, -1] } },
		{ at: 0.45, wrist: { dir: [0.15, 0.5, 0.85], normal: [0, -0.8, 0.2] } },
		{ at: 1.0, wrist: { dir: [0.55, 0.6, 0.55], normal: [-0.8, 0, 0.2] } },
	],
	Z: [
		{ at: 0.0, wrist: { dir: [0.35, 1, 0.1], normal: [0, 0, -1] } },
		{ at: 0.3, wrist: { dir: [-0.35, 1, 0.1], normal: [0, 0, -1] } },
		{ at: 0.7, wrist: { dir: [0.45, 0.65, 0.45], normal: [0, 0, -1] } },
		{ at: 1.0, wrist: { dir: [-0.3, 0.6, 0.45], normal: [0, 0, -1] } },
	],
};

function fingerJointDegrees(spec) {
	if (Array.isArray(spec)) return spec;
	const amount = typeof spec === 'number' ? spec : 0;
	return CURL_WEIGHTS.map((w) => w * amount);
}

// Compile one handshape into finger-bone local quats for one side.
export function handshapeLocals(letter, side = 'Right') {
	const shape = LETTER_SHAPES[letter];
	if (!shape) throw new Error(`no handshape for letter "${letter}"`);
	const s = side === 'Left' ? 1 : -1;
	const curlAxis = [0, 0, -s]; // hinge toward the palm (palms-down rest)
	const splayAxis = [0, 1, 0];
	const locals = {};
	for (const finger of FINGERS) {
		const deg = fingerJointDegrees(shape.curl?.[finger] ?? 0);
		const splay = shape.splay?.[finger] ?? 0;
		for (let j = 0; j < 3; j++) {
			let q = qAxisAngle(curlAxis, deg[j]);
			if (j === 0 && splay) q = qMul(q, qAxisAngle(splayAxis, splay * -s));
			locals[`${side}Hand${finger}${j + 1}`] = qNorm(q);
		}
	}
	const preset = THUMB_PRESETS[shape.thumb ?? 'side'];
	// Thumb rest points ~45° between the fingers and the palm-forward axis;
	// adduction swings it about the palm normal (toward/away from the palm
	// centre), curl bends its hinge toward the palm. Axes are side-mirrored.
	const thumbHinge = vNorm([-s * 0.5, 0, -0.85]);
	for (let j = 0; j < 3; j++) {
		let q = qAxisAngle(thumbHinge, preset.curl[j]);
		if (j === 0) q = qMul(qAxisAngle([0, 1, 0], preset.adduct * -s), q);
		locals[`${side}HandThumb${j + 1}`] = qNorm(q);
	}
	return locals;
}

// Hand local for an ABSOLUTE authored orientation: fingers toward `dir`, back
// of hand toward `normal`, in the same authoring frame as the signing pose
// (avatar faces +Z, up +Y, the right side of the body toward -X). Relative
// deltas on the base wrist do not survive the retargeter's per-rig bind
// correction, but absolute orientations built like the base pose do — the base
// pose itself is the proof.
function wristLocal(spec, gLower, restHand) {
	// Escape hatch for orientations that degenerate under absolute authoring
	// (a target direction near the bone's rest axis collapses to a pure twist,
	// which the bind correction scrambles): a plain local pre-rotation on the
	// base wrist, tuned against the live renderer (G / H use it).
	if (spec.local) return qNorm(qMul(restHand, qAxisAngle(spec.local, spec.deg)));
	const gHand = frameQuat(vNorm(spec.dir), vNorm(spec.normal), [-1, 0, 0], [0, 1, 0]);
	return qNorm(qMul(qConj(gLower), gHand));
}

// ── clip assembly ──────────────────────────────────────────────────────────

export const DEFAULT_TIMING = Object.freeze({
	holdSeconds: 0.5,
	transitionSeconds: 0.22,
	motionSeconds: 0.9,
	leadSeconds: 0.35,
	tailSeconds: 0.4,
});

export function normalizeWord(word) {
	const cleaned = String(word ?? '')
		.toUpperCase()
		.replace(/[^A-Z ]+/g, '')
		.replace(/ +/g, ' ')
		.trim();
	return cleaned;
}

const NORMAL_BLEND_MODE = 2500;

function stableUuid(seed) {
	// FNV-1a over the seed, expanded to uuid shape — deterministic like the
	// capture lanes, so identical words produce identical documents.
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < seed.length; i++) {
		h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
		h2 = Math.imul((h2 + seed.charCodeAt(i)) ^ (h1 >>> 5), 0x85ebca6b) >>> 0;
	}
	const hex = (n) => n.toString(16).padStart(8, '0');
	const full = hex(h1) + hex(h2) + hex((h1 ^ 0x9e3779b9) >>> 0) + hex((h2 ^ 0x7f4a7c15) >>> 0);
	return `${full.slice(0, 8)}-${full.slice(8, 12)}-${full.slice(12, 16)}-${full.slice(16, 20)}-${full.slice(20, 32)}`.toUpperCase();
}

/**
 * Build an AnimationClip JSON document that fingerspells `word` on the right
 * hand. Only A–Z and spaces survive normalization; anything else is dropped.
 * Returns the same document shape the animation library serves, ready for
 * THREE.AnimationClip.parse + the platform retarget engine.
 */
export function buildFingerspellingClip(word, opts = {}) {
	const timing = { ...DEFAULT_TIMING, ...opts };
	const letters = normalizeWord(word);
	if (!letters) throw new Error('word has no spellable characters (A-Z)');

	const pose = signingPose();
	const restHand = pose.RightHand;
	const gLower = pose.__gRightLower;
	const neutralFingers = {};
	for (const finger of [...FINGERS, 'Thumb']) {
		for (let j = 1; j <= 3; j++) neutralFingers[`RightHand${finger}${j}`] = qAxisAngle([0, 0, 1], finger === 'Thumb' ? 4 : 12);
	}

	// Build the keyframe timeline: {time, locals} snapshots. Every snapshot
	// carries the full right-hand bone set so tracks stay aligned.
	const keys = [];
	const pushKey = (time, fingers, wristSpec) => {
		const locals = { ...fingers };
		locals.RightHand = wristSpec ? wristLocal(wristSpec, gLower, restHand) : restHand;
		keys.push({ time, locals });
	};

	let t = 0;
	pushKey(0, neutralFingers, null);
	t = timing.leadSeconds;
	let prevLetter = null;
	for (const ch of letters) {
		if (ch === ' ') {
			pushKey(t + timing.transitionSeconds, neutralFingers, null);
			t += timing.transitionSeconds + timing.holdSeconds * 0.6;
			prevLetter = null;
			continue;
		}
		const shape = LETTER_SHAPES[ch];
		const fingers = handshapeLocals(ch, 'Right');
		const isDouble = prevLetter === ch;
		if (isDouble) {
			// Small outward bounce between repeated letters.
			pushKey(t + timing.transitionSeconds * 0.6, { ...fingers }, { dir: [-0.3, 1, 0.1], normal: [0, 0, -1] });
			t += timing.transitionSeconds * 0.6;
		}
		const wristBase = shape.wrist ?? null;
		if (shape.motion && MOTIONS[shape.motion]) {
			const start = t + timing.transitionSeconds;
			for (const step of MOTIONS[shape.motion]) {
				pushKey(start + step.at * timing.motionSeconds, fingers, step.wrist);
			}
			t = start + timing.motionSeconds;
		} else {
			pushKey(t + timing.transitionSeconds, fingers, wristBase);
			pushKey(t + timing.transitionSeconds + timing.holdSeconds, fingers, wristBase);
			t += timing.transitionSeconds + timing.holdSeconds;
		}
		prevLetter = ch;
	}
	pushKey(t + timing.tailSeconds, neutralFingers, null);

	// Static body pose: keep the whole figure composed while the hand spells.
	const staticBones = {
		RightArm: pose.RightArm,
		RightForeArm: pose.RightForeArm,
		LeftArm: pose.LeftArm,
		LeftForeArm: pose.LeftForeArm,
		LeftHand: pose.LeftHand,
		Hips: [...IDENT],
		Spine: qAxisAngle([1, 0, 0], 2),
		Spine1: [...IDENT],
		Spine2: [...IDENT],
		Neck: qAxisAngle([1, 0, 0], -3),
		Head: [...IDENT],
	};

	const duration = keys[keys.length - 1].time;
	const trackBones = Object.keys(keys[0].locals);
	const tracks = [];
	for (const bone of trackBones) {
		const times = keys.map((k) => k.time);
		const values = keys.flatMap((k) => k.locals[bone] ?? [...IDENT]);
		tracks.push({ type: 'quaternion', name: `${bone}.quaternion`, times, values });
	}
	for (const [bone, q] of Object.entries(staticBones)) {
		tracks.push({ type: 'quaternion', name: `${bone}.quaternion`, times: [0, duration], values: [...q, ...q] });
	}
	tracks.push({ type: 'vector', name: 'Hips.position', times: [0], values: [0, 0, 0] });

	return {
		name: opts.name ?? `fingerspell-${letters.toLowerCase().replace(/ /g, '-')}`,
		duration,
		tracks,
		uuid: stableUuid(`fingerspell:${letters}:${timing.holdSeconds}:${timing.transitionSeconds}`),
		blendMode: NORMAL_BLEND_MODE,
	};
}
