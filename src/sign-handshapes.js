// ASL handshapes — the finger configurations both lanes of the signing stack
// share: the manual alphabet (fingerspelling) and the lexical sign dictionary.
//
// A handshape is described the way a signer would describe it — how far each
// finger curls, how the fingers spread, where the thumb sits — never as raw
// joint quaternions. The compiler turns that description into local rotations
// about axes MEASURED from the reference skeleton (src/sign-rig.js), so the same
// description drives either hand with no mirrored sign flipping, and a rig whose
// finger bones rest at a different angle still curls its fingers into the palm
// instead of sideways.
//
// Handshape names follow standard ASL naming: the letters and digits that double
// as shapes (`B`, `S`, `1`, `5`, …) plus the named ones that don't (`CLAW`,
// `FLAT_O`, `BENT_B`, `OPEN_8`).

import { adductAxis, curlAxis, qAxisAngle, qMul, qNorm, splayAxis } from './sign-rig.js';

export const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];
export const FINGER_JOINTS = [1, 2, 3];

/** Every finger bone of one hand, in the order the clip tracks are emitted. */
export function fingerBones(side) {
	return [...FINGERS, 'Thumb'].flatMap((f) => FINGER_JOINTS.map((j) => `${side}Hand${f}${j}`));
}

// Share of a full curl carried by each joint. The proximal knuckle leads, the
// middle joint closes hardest, the tip trails — the proportions a relaxed hand
// actually closes with, which is what keeps a fist from reading as a claw.
const CURL_WEIGHTS = [78, 100, 62];

// Thumb positions, as adduction (toward the fingers, across the palm) plus a
// per-joint curl. Every ASL handshape uses one of these five.
const THUMB_PRESETS = {
	/** Alongside the index, pointing with the fingers — A, G, L-less shapes. */
	side: { adduct: 18, curl: [10, 12, 6], lift: 6 },
	/** Extended clear of the palm — L, Y, 5, and the "thumb out" shapes. */
	out: { adduct: -48, curl: [0, 0, 0], lift: 10 },
	/** Folded across the closed fingers — B, S, E, M, N. */
	across: { adduct: 52, curl: [26, 40, 26], lift: -4 },
	/** Opposing the fingertips, as in O, C, F and the 6–9 digits. */
	oppose: { adduct: 36, curl: [20, 32, 24], lift: 2 },
	/** Tucked between fingers — T, K, P. */
	between: { adduct: 34, curl: [24, 30, 16], lift: -2 },
};

/**
 * The handshape catalogue. `curl` is 0–1 per finger (or explicit per-joint
 * degrees), `splay` is degrees toward the thumb (negative = toward the pinky),
 * `knuckle` bends only the proximal joint (the flat-then-bent shapes), and
 * `thumb` names a preset.
 */
export const HANDSHAPES = Object.freeze({
	A: { curl: { Index: 1, Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'side' },
	B: { curl: {}, splay: { Index: 2, Middle: 1, Ring: -1, Pinky: -3 }, thumb: 'across' },
	C: { curl: { Index: 0.42, Middle: 0.45, Ring: 0.48, Pinky: 0.5 }, thumb: 'oppose' },
	D: { curl: { Middle: 0.72, Ring: 0.72, Pinky: 0.72 }, thumb: 'oppose' },
	E: { curl: { Index: 0.82, Middle: 0.85, Ring: 0.85, Pinky: 0.82 }, thumb: 'across' },
	F: { curl: { Index: 0.55 }, splay: { Middle: 7, Ring: 0, Pinky: -9 }, thumb: 'oppose' },
	G: { curl: { Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'side' },
	H: { curl: { Ring: 1, Pinky: 1 }, splay: { Index: 2, Middle: -2 }, thumb: 'side' },
	I: { curl: { Index: 1, Middle: 1, Ring: 1 }, thumb: 'across' },
	J: { curl: { Index: 1, Middle: 1, Ring: 1 }, thumb: 'across' },
	K: { curl: { Middle: [42, 12, 8], Ring: 1, Pinky: 1 }, splay: { Index: 10, Middle: -6 }, thumb: 'between' },
	L: { curl: { Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'out' },
	M: { curl: { Index: 0.72, Middle: 0.74, Ring: 0.76, Pinky: 0.95 }, thumb: 'across' },
	N: { curl: { Index: 0.72, Middle: 0.74, Ring: 0.95, Pinky: 0.95 }, thumb: 'across' },
	O: { curl: { Index: 0.52, Middle: 0.55, Ring: 0.58, Pinky: 0.6 }, thumb: 'oppose' },
	P: { curl: { Middle: [42, 12, 8], Ring: 1, Pinky: 1 }, splay: { Index: 10, Middle: -6 }, thumb: 'between' },
	Q: { curl: { Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'side' },
	R: { curl: { Ring: 1, Pinky: 1 }, splay: { Index: -7, Middle: 9 }, thumb: 'across' },
	S: { curl: { Index: 1, Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'across' },
	T: { curl: { Index: 0.88, Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'between' },
	U: { curl: { Ring: 1, Pinky: 1 }, splay: { Index: 1, Middle: -1 }, thumb: 'across' },
	V: { curl: { Ring: 1, Pinky: 1 }, splay: { Index: 10, Middle: -10 }, thumb: 'across' },
	W: { curl: { Pinky: 1 }, splay: { Index: 11, Middle: 0, Ring: -11 }, thumb: 'across' },
	X: { curl: { Index: [18, 92, 78], Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'side' },
	Y: { curl: { Index: 1, Middle: 1, Ring: 1 }, thumb: 'out' },
	Z: { curl: { Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'side' },

	// ASL number handshapes. 6–9 touch the thumb to one fingertip, so the
	// touched finger half-curls to meet the opposing thumb.
	0: { curl: { Index: 0.52, Middle: 0.55, Ring: 0.58, Pinky: 0.6 }, thumb: 'oppose' },
	1: { curl: { Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'across' },
	2: { curl: { Ring: 1, Pinky: 1 }, splay: { Index: 10, Middle: -10 }, thumb: 'across' },
	3: { curl: { Ring: 1, Pinky: 1 }, splay: { Index: 10, Middle: -10 }, thumb: 'out' },
	4: { curl: {}, splay: { Index: 11, Middle: 4, Ring: -5, Pinky: -13 }, thumb: 'across' },
	5: { curl: {}, splay: { Index: 12, Middle: 4, Ring: -5, Pinky: -14 }, thumb: 'out' },
	6: { curl: { Pinky: 0.55 }, splay: { Index: 9, Middle: 0, Ring: -9 }, thumb: 'oppose' },
	7: { curl: { Ring: 0.55 }, splay: { Index: 9, Middle: 0, Pinky: -11 }, thumb: 'oppose' },
	8: { curl: { Middle: 0.55 }, splay: { Index: 9, Ring: -7, Pinky: -13 }, thumb: 'oppose' },
	9: { curl: { Index: 0.55 }, splay: { Middle: 5, Ring: -5, Pinky: -13 }, thumb: 'oppose' },

	// Shapes with no letter name of their own.
	/** Spread and curved, like holding a ball — used by many "grab" signs. */
	CLAW: { curl: { Index: 0.45, Middle: 0.45, Ring: 0.45, Pinky: 0.45 }, splay: { Index: 10, Middle: 3, Ring: -4, Pinky: -12 }, thumb: 'oppose' },
	/** Flat hand, fingers together — the citation "flat B" used everywhere. */
	FLAT: { curl: {}, splay: { Index: 2, Middle: 1, Ring: -1, Pinky: -3 }, thumb: 'side' },
	/** Flat hand bent at the knuckles — HAPPY, THANK YOU's release, YOUR. */
	BENT_B: { curl: {}, knuckle: 52, thumb: 'across' },
	/** Fingers together pinched to the thumb — the closing shape of many signs. */
	FLAT_O: { curl: { Index: 0.6, Middle: 0.62, Ring: 0.64, Pinky: 0.66 }, knuckle: 22, thumb: 'oppose' },
	/** Open hand with the middle finger dropped to the palm — FEEL, SICK. */
	OPEN_8: { curl: { Middle: 0.62 }, splay: { Index: 9, Ring: -6, Pinky: -12 }, thumb: 'out' },
	/** Relaxed, slightly-curled hand: what a hand does when it isn't signing. */
	RELAXED: { curl: { Index: 0.18, Middle: 0.22, Ring: 0.26, Pinky: 0.3 }, thumb: 'side' },
	/** Index and pinky out — the ILY / "rock on" family. */
	ILY: { curl: { Middle: 1, Ring: 1 }, splay: { Index: 6, Pinky: -6 }, thumb: 'out' },
});

/** Names of every handshape, for docs and tooling. */
export const HANDSHAPE_NAMES = Object.freeze(Object.keys(HANDSHAPES));

function jointDegrees(spec) {
	if (Array.isArray(spec)) return spec;
	const amount = typeof spec === 'number' ? spec : 0;
	return CURL_WEIGHTS.map((w) => w * amount);
}

/**
 * Compile a handshape into local rotations for one hand's finger bones.
 *
 * @param {string} name  a HANDSHAPES key (letter, digit, or named shape)
 * @param {'Left'|'Right'} [side]
 * @returns {Record<string, number[]>} bone → [x,y,z,w]
 */
export function handshapeLocals(name, side = 'Right') {
	const shape = HANDSHAPES[name];
	if (!shape) throw new Error(`no handshape "${name}"`);
	const locals = {};

	for (const finger of FINGERS) {
		const curl = jointDegrees(shape.curl?.[finger] ?? 0);
		const splay = shape.splay?.[finger] ?? 0;
		for (const j of FINGER_JOINTS) {
			const bone = `${side}Hand${finger}${j}`;
			const bend = curl[j - 1] + (j === 1 ? (shape.knuckle ?? 0) : 0);
			let q = qAxisAngle(curlAxis(bone), bend);
			// Spread happens at the knuckle only, and always outside the curl so
			// a curled finger still fans from the same origin.
			if (j === 1 && splay) q = qMul(qAxisAngle(splayAxis(bone), splay), q);
			locals[bone] = qNorm(q);
		}
	}

	const thumb = THUMB_PRESETS[shape.thumb ?? 'side'];
	for (const j of FINGER_JOINTS) {
		const bone = `${side}HandThumb${j}`;
		let q = qAxisAngle(curlAxis(bone), thumb.curl[j - 1]);
		if (j === 1) {
			// The base joint also swings the thumb across the palm (adduction) and
			// lifts it off the palm plane, which is what separates an A from an S.
			q = qMul(qMul(qAxisAngle(adductAxis(bone), thumb.adduct), qAxisAngle(splayAxis(bone), thumb.lift ?? 0)), q);
		}
		locals[bone] = qNorm(q);
	}
	return locals;
}

/**
 * Apply a handshape to a {@link import('./sign-rig.js').Pose} in place.
 * @param {import('./sign-rig.js').Pose} pose
 * @param {string} name
 * @param {'Left'|'Right'} side
 */
export function applyHandshape(pose, name, side) {
	for (const [bone, q] of Object.entries(handshapeLocals(name, side))) pose.setLocal(bone, q);
	return pose;
}
