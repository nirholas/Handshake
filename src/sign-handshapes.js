// ASL handshapes: the finger configurations the signing stack shares between
// the manual alphabet (src/fingerspelling.js) and the lexical sign dictionary
// (src/sign-dictionary.js).
//
// A handshape is described the way a signer describes it: how far each finger
// curls, how the fingers spread, where the thumb sits: and compiled to local
// rotations on the canonical finger bones. This is the ORIGINAL, hand-tuned
// handshape model, moved here unchanged so both lanes can share it: the letter
// table, the curl weights, the thumb presets, and the axes they are tuned
// against are exactly what the alphabet already spelled with. Nothing in this
// file changes the shape of a letter.
//
// Handshape names follow standard ASL naming: the letters and digits that double
// as shapes (`B`, `S`, `1`, `5`, …) plus the named ones that don't (`CLAW`,
// `FLAT_O`, `BENT_B`, `OPEN_8`), which the lexical signs need and the alphabet
// never used.

import {
	FINGERS,
	FINGER_JOINTS,
	fingerBones,
	qAxisAngle,
	qConj,
	qMul,
	qNorm,
	qRotate,
	restDirWorld,
	restPalmWorld,
	restRadialWorld,
	restWorld,
	vCross,
	vNorm,
} from './sign-rig.js';

// The skeleton's own structure lives in sign-rig.js; re-exported here so callers
// that think in handshapes have one import.
export { FINGERS, FINGER_JOINTS, fingerBones };

// Per-joint shares of a full curl (proximal knuckles carry most of it).
const CURL_WEIGHTS = [85, 100, 65];

/**
 * The four axes a handshape rotates about, derived from the rig instead of
 * written down.
 *
 * A handshape sets each finger bone's local rotation OUTRIGHT, so the axes act
 * in the parent's rest frame, not the bone's. Getting that frame wrong is
 * invisible in a screenshot and fatal in the geometry: the previous hardcoded
 * axes curled the fingers sideways across the palm rather than into it, and
 * applied splay about each finger's own length, which is a pure twist that
 * moves no fingertip at all (V collapsed onto U, W onto B).
 *
 * Reading them off `restPalmWorld` / `restRadialWorld` / `restDirWorld` costs
 * one rotation per side, is exact for both hands without a mirror term, and
 * follows the rig if the rest pose is ever re-measured.
 */
const HAND_AXES = new Map();
function handAxes(side) {
	let axes = HAND_AXES.get(side);
	if (axes) return axes;
	const toParent = (v) => vNorm(qRotate(qConj(restWorld(`${side}Hand`)), v));
	const palm = toParent(restPalmWorld(side));
	const radial = toParent(restRadialWorld(side));
	const finger = toParent(restDirWorld(`${side}HandIndex1`));
	const thumb = toParent(restDirWorld(`${side}HandThumb1`));
	axes = {
		// Rotating a bone about (direction x palm) swings its tip toward the palm.
		curl: vNorm(vCross(finger, palm)),
		// ... and about (direction x radial) toward the thumb side of the hand.
		splay: vNorm(vCross(finger, radial)),
		thumbCurl: vNorm(vCross(thumb, palm)),
		// The thumb swings across the palm about the palm's own normal.
		thumbAdduct: palm,
	};
	HAND_AXES.set(side, axes);
	return axes;
}

/** The axes a given side's handshapes rotate about, for tooling and tests. */
export const handshapeAxes = (side = 'Right') => ({ ...handAxes(side) });

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
	// barely engaged: the hand between letters and at rest
	neutral: { adduct: 0, curl: [4, 4, 4] },
};

/**
 * The handshape catalogue. `curl` is 0-1 per finger (or explicit per-joint
 * degrees), `splay` is degrees toward the thumb, `knuckle` adds bend at the
 * proximal joint only, and `thumb` names a preset.
 *
 * A-Z and 0-9 are the manual alphabet, unchanged.
 */
export const HANDSHAPES = Object.freeze({
	A: { curl: { Index: 1, Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'side' },
	B: { curl: {}, thumb: 'across' },
	C: { curl: { Index: 0.45, Middle: 0.45, Ring: 0.45, Pinky: 0.45 }, thumb: 'oppose' },
	D: { curl: { Middle: 0.7, Ring: 0.7, Pinky: 0.7 }, thumb: 'oppose' },
	E: { curl: { Index: 0.85, Middle: 0.85, Ring: 0.85, Pinky: 0.85 }, thumb: 'across' },
	F: { curl: { Index: 0.55 }, splay: { Middle: 6, Ring: 0, Pinky: -8 }, thumb: 'oppose' },
	G: { curl: { Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'side' },
	H: { curl: { Ring: 1, Pinky: 1 }, thumb: 'side' },
	I: { curl: { Index: 1, Middle: 1, Ring: 1 }, thumb: 'across' },
	J: { curl: { Index: 1, Middle: 1, Ring: 1 }, thumb: 'across' },
	K: { curl: { Middle: [40, 15, 10], Ring: 1, Pinky: 1 }, thumb: 'between' },
	L: { curl: { Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'out' },
	M: { curl: { Index: 0.75, Middle: 0.75, Ring: 0.75, Pinky: 0.95 }, thumb: 'across' },
	N: { curl: { Index: 0.75, Middle: 0.75, Ring: 0.95, Pinky: 0.95 }, thumb: 'across' },
	O: { curl: { Index: 0.55, Middle: 0.55, Ring: 0.55, Pinky: 0.55 }, thumb: 'oppose' },
	P: { curl: { Middle: [40, 15, 10], Ring: 1, Pinky: 1 }, thumb: 'between' },
	Q: { curl: { Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'side' },
	R: { curl: { Ring: 1, Pinky: 1 }, splay: { Index: -6, Middle: 8 }, thumb: 'across' },
	S: { curl: { Index: 1, Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'across' },
	T: { curl: { Index: 0.9, Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'between' },
	U: { curl: { Ring: 1, Pinky: 1 }, thumb: 'across' },
	V: { curl: { Ring: 1, Pinky: 1 }, splay: { Index: 9, Middle: -9 }, thumb: 'across' },
	W: { curl: { Pinky: 1 }, splay: { Index: 10, Middle: 0, Ring: -10 }, thumb: 'across' },
	X: { curl: { Index: [15, 95, 80], Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'side' },
	Y: { curl: { Index: 1, Middle: 1, Ring: 1 }, thumb: 'out' },
	Z: { curl: { Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'side' },

	// ASL number handshapes 0-9 (static). 6-9 touch the thumb to one
	// fingertip; the touched finger half-curls to meet the opposing thumb.
	0: { curl: { Index: 0.55, Middle: 0.55, Ring: 0.55, Pinky: 0.55 }, thumb: 'oppose' },
	1: { curl: { Middle: 1, Ring: 1, Pinky: 1 }, thumb: 'across' },
	2: { curl: { Ring: 1, Pinky: 1 }, splay: { Index: 9, Middle: -9 }, thumb: 'across' },
	3: { curl: { Ring: 1, Pinky: 1 }, splay: { Index: 9, Middle: -9 }, thumb: 'out' },
	4: { curl: {}, splay: { Index: 10, Middle: 3, Ring: -4, Pinky: -12 }, thumb: 'across' },
	5: { curl: {}, splay: { Index: 10, Middle: 3, Ring: -4, Pinky: -12 }, thumb: 'out' },
	6: { curl: { Pinky: 0.55 }, splay: { Index: 9, Middle: 0, Ring: -8 }, thumb: 'oppose' },
	7: { curl: { Ring: 0.55 }, splay: { Index: 9, Middle: 0, Pinky: -10 }, thumb: 'oppose' },
	8: { curl: { Middle: 0.55 }, splay: { Index: 9, Ring: -6, Pinky: -12 }, thumb: 'oppose' },
	9: { curl: { Index: 0.55 }, splay: { Middle: 4, Ring: -4, Pinky: -12 }, thumb: 'oppose' },

	// ── shapes with no letter of their own, used by the lexical signs ────────
	/** The hand between letters and at rest: barely engaged, not a pose. */
	RELAXED: { curl: { Index: [12, 12, 12], Middle: [12, 12, 12], Ring: [12, 12, 12], Pinky: [12, 12, 12] }, thumb: 'neutral' },
	/** Flat hand, fingers together: the citation "flat B" used everywhere. */
	FLAT: { curl: {}, thumb: 'side' },
	/** Flat hand bent at the knuckles: HAPPY, YOUR, the release of THANK-YOU. */
	BENT_B: { curl: {}, knuckle: 50, thumb: 'across' },
	/** Spread and curved, like holding a ball. */
	CLAW: { curl: { Index: 0.45, Middle: 0.45, Ring: 0.45, Pinky: 0.45 }, splay: { Index: 10, Middle: 3, Ring: -4, Pinky: -12 }, thumb: 'oppose' },
	/** Fingers together pinched to the thumb: the closing shape of many signs. */
	FLAT_O: { curl: { Index: 0.6, Middle: 0.6, Ring: 0.6, Pinky: 0.6 }, knuckle: 20, thumb: 'oppose' },
	/** Open hand with the middle finger dropped to the palm: FEEL, SICK. */
	OPEN_8: { curl: { Middle: 0.62 }, splay: { Index: 9, Ring: -6, Pinky: -12 }, thumb: 'out' },
	/** Index and pinky out: the ILY / "rock on" family. */
	ILY: { curl: { Middle: 1, Ring: 1 }, splay: { Index: 6, Pinky: -6 }, thumb: 'out' },
});

/** Names of every handshape, for docs and tooling. */
export const HANDSHAPE_NAMES = Object.freeze(Object.keys(HANDSHAPES));

function fingerJointDegrees(spec) {
	if (Array.isArray(spec)) return spec;
	const amount = typeof spec === 'number' ? spec : 0;
	return CURL_WEIGHTS.map((w) => w * amount);
}

/**
 * Compile one handshape into finger-bone local quats for one side.
 *
 * @param {string} name  a HANDSHAPES key (letter, digit, or named shape)
 * @param {'Left'|'Right'} [side]
 * @returns {Record<string, number[]>} bone → [x,y,z,w]
 */
export function handshapeLocals(name, side = 'Right') {
	const shape = HANDSHAPES[name];
	if (!shape) throw new Error(`no handshape for letter "${name}"`);
	const axes = handAxes(side);
	const locals = {};
	for (const finger of FINGERS) {
		const deg = fingerJointDegrees(shape.curl?.[finger] ?? 0);
		const splay = shape.splay?.[finger] ?? 0;
		for (let j = 0; j < 3; j++) {
			let q = qAxisAngle(axes.curl, deg[j] + (j === 0 ? (shape.knuckle ?? 0) : 0));
			// Abduction belongs to the knuckle and happens in the plane of the
			// palm, so it composes BEFORE the curl: a finger that is already
			// folded does not abduct along its folded direction.
			if (j === 0 && splay) q = qMul(qAxisAngle(axes.splay, splay), q);
			locals[`${side}Hand${finger}${j + 1}`] = qNorm(q);
		}
	}
	const preset = THUMB_PRESETS[shape.thumb ?? 'side'];
	// Adduction swings the thumb about the palm normal (positive lays it across
	// the palm, negative takes it out to the side); curl bends its hinge toward
	// the palm on top of that.
	for (let j = 0; j < 3; j++) {
		let q = qAxisAngle(axes.thumbCurl, preset.curl[j]);
		if (j === 0) q = qMul(qAxisAngle(axes.thumbAdduct, preset.adduct), q);
		locals[`${side}HandThumb${j + 1}`] = qNorm(q);
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
