// ASL fingerspelling — turn a word into a canonical-skeleton animation clip that
// spells it letter by letter on the dominant hand.
//
// Fingerspelling has a real citation form and this module follows it: the hand
// sits in front of the dominant shoulder at about jaw height, palm to the person
// reading, elbow down and relaxed. Only the handshape changes between letters —
// the hand itself stays put, which is exactly what makes fingerspelling readable
// and what a signer would correct first in a bad avatar.
//
// The pose is SOLVED, not authored: `src/sign-clip.js` places the wrist at a
// point in signing space and `src/sign-rig.js` runs two-bone IK against the
// reference skeleton's measured bind pose to find the shoulder, elbow, and wrist
// rotations. Handshapes come from the shared catalogue in
// `src/sign-handshapes.js`. The result is the SAME AnimationClip JSON document
// the pre-baked library and the motion-capture lanes produce, so a spelled word
// retargets onto any rigged avatar through `src/animation-retarget.js` with zero
// new playback machinery.
//
// Letters with movement carry it as real movement in space: J hooks the pinky
// down and around, Z draws the zig-zag with the index. Double letters bounce
// outward between the two holds, the way signers disambiguate them.
//
// Scope note: fingerspelling spells English words; it is not grammatical ASL.
// Lexical signs live in `src/sign-dictionary.js`, and `src/sign-speech.js`
// prefers them, falling back here for anything with no sign of its own.

import { HANDSHAPES, handshapeLocals } from './sign-handshapes.js';
import { SignTimeline, posePhase, restingPose } from './sign-clip.js';

export { HANDSHAPES, handshapeLocals, restingPose };

/** Back-compat alias: the letter/digit subset of the handshape catalogue. */
export const LETTER_SHAPES = HANDSHAPES;

// Where fingerspelling happens: in front of the dominant shoulder, jaw height,
// far enough forward to clear the body and be read comfortably.
const SPELLING_PLACE = { anchor: 'chin', out: 0.24, up: -0.03, forward: 0.21 };

// The citation orientation is fingers up, palm to the reader, and every letter
// keeps it — the alphabet is unchanged. Only the four letters that are DEFINED
// by a different orientation depart from it. Directions are body-relative:
// `out` is away from the signer's midline, `in` toward it, `forward` toward the
// person reading.
const LETTER_ORIENT = {
	// G and H lie the hand over: fingers point at the reader, palm toward the
	// signer's other side.
	G: { fingers: ['forward', 'up'], palm: 'in', at: { anchor: 'chin', out: 0.19, up: -0.11, forward: 0.21 } },
	H: { fingers: ['forward', 'up'], palm: 'in', at: { anchor: 'chin', out: 0.19, up: -0.11, forward: 0.21 } },
	// P and Q are K and G turned down toward the floor, and sit lower.
	P: { fingers: ['down', 'forward'], palm: 'in', at: { anchor: 'chin', out: 0.19, up: -0.24, forward: 0.2 } },
	Q: { fingers: ['down', 'forward'], palm: 'back', at: { anchor: 'chin', out: 0.17, up: -0.26, forward: 0.18 } },
};

// Traced letters. Each step offsets the hand from the spelling place (metres,
// body-relative) and may re-aim the fingers and palm — J swings the pinky down
// and hooks it back in, Z jabs the index through the three strokes.
const LETTER_MOTION = {
	J: [
		{ at: 0.0, offset: { up: 0.02 }, palm: ['forward', 'in'] },
		{ at: 0.45, offset: { up: -0.1, out: 0.02 }, palm: ['forward', 'in'] },
		{ at: 0.75, offset: { up: -0.14, out: -0.05 }, palm: ['up', 'forward'] },
		{ at: 1.0, offset: { up: -0.09, out: -0.08 }, palm: ['up', 'in'] },
	],
	Z: [
		{ at: 0.0, offset: { out: 0.05, up: 0.06 } },
		{ at: 0.33, offset: { out: -0.07, up: 0.06 } },
		{ at: 0.66, offset: { out: 0.05, up: -0.05 } },
		{ at: 1.0, offset: { out: -0.07, up: -0.05 } },
	],
};

export const DEFAULT_TIMING = Object.freeze({
	holdSeconds: 0.5,
	transitionSeconds: 0.22,
	motionSeconds: 0.9,
	leadSeconds: 0.35,
	tailSeconds: 0.4,
});

/**
 * Uppercase, drop anything unspellable, collapse whitespace. A–Z, 0–9 and
 * single spaces survive.
 * @param {string} word
 * @returns {string}
 */
export function normalizeWord(word) {
	return String(word ?? '')
		.toUpperCase()
		.replace(/[^A-Z0-9 ]+/g, '')
		.replace(/ +/g, ' ')
		.trim();
}

const SIDE = 'Right';

/** The letter's place in signing space, plus an optional metre offset. */
function letterPlace(letter, offset) {
	const spec = { ...SPELLING_PLACE, ...(LETTER_ORIENT[letter]?.at ?? {}) };
	if (offset) {
		spec.out = (spec.out ?? 0) + (offset.out ?? 0);
		spec.up = (spec.up ?? 0) + (offset.up ?? 0);
		spec.forward = (spec.forward ?? 0) + (offset.forward ?? 0);
	}
	return spec;
}

/**
 * Full-body pose for one letter, optionally displaced (double-letter bounce) or
 * re-aimed (a step of a traced letter).
 * @param {string} letter
 * @param {{ offset?: object, fingers?: any, palm?: any }} [opts]
 * @param {import('./sign-rig.js').Pose} [base]
 */
export function letterPose(letter, opts = {}, base = restingPose()) {
	if (!HANDSHAPES[letter]) throw new Error(`no handshape for letter "${letter}"`);
	const orient = LETTER_ORIENT[letter] ?? {};
	return posePhase(
		{
			right: {
				shape: letter,
				at: letterPlace(letter, opts.offset),
				fingers: opts.fingers ?? orient.fingers ?? 'up',
				palm: opts.palm ?? orient.palm ?? 'forward',
			},
			// The reading eye follows the hand: a small turn and tilt toward the
			// spelling hand is what a signer does and what makes this look alive.
			head: { turn: -3, tilt: 1.5 },
			torso: { turn: -2 },
		},
		base,
	);
}

/** The neutral hand a word starts and ends from: same place, open and relaxed. */
function readyPose(base) {
	return posePhase(
		{
			right: { shape: 'RELAXED', at: letterPlace('A', { up: -0.03, forward: -0.03 }), fingers: 'up', palm: ['forward', 'in'] },
			head: { turn: -3, tilt: 1.5 },
			torso: { turn: -2 },
		},
		base,
	);
}

/**
 * Build an AnimationClip JSON document that fingerspells `word` on the dominant
 * hand. Letters A–Z, digits 0–9, and spaces survive normalization; anything else
 * is dropped.
 *
 * @param {string} word
 * @param {Partial<typeof DEFAULT_TIMING> & { name?: string, base?: import('./sign-rig.js').Pose, settle?: boolean }} [opts]
 * @returns {object} clip document, ready for THREE.AnimationClip.parse + retarget
 */
export function buildFingerspellingClip(word, opts = {}) {
	const timing = { ...DEFAULT_TIMING, ...opts };
	const letters = normalizeWord(word);
	if (!letters) throw new Error('word has no spellable characters (A-Z, 0-9)');

	const base = opts.base ?? restingPose();
	const tl = new SignTimeline({ base });
	const ready = readyPose(base);

	// Lift into signing space, then spell.
	tl.to(ready, timing.leadSeconds, { ease: 'out' });

	let prev = null;
	for (const ch of letters) {
		if (ch === ' ') {
			// A word break is a small drop and re-set of the hand, not a pause.
			tl.to(readyPose(base), timing.transitionSeconds, { ease: 'smooth' });
			tl.hold(timing.holdSeconds * 0.5);
			prev = null;
			continue;
		}
		if (prev === ch) {
			// Doubled letter: bounce outward and back rather than holding one shape
			// twice, which would read as a single letter.
			tl.to(letterPose(ch, { offset: { out: 0.045, forward: -0.01 } }, base), timing.transitionSeconds * 0.55, { ease: 'out' });
		}
		const motion = LETTER_MOTION[ch];
		if (motion) {
			const step = (s) => letterPose(ch, { offset: s.offset, fingers: s.fingers, palm: s.palm }, base);
			tl.to(step(motion[0]), timing.transitionSeconds, { ease: 'smooth' });
			for (let i = 1; i < motion.length; i++) {
				const span = (motion[i].at - motion[i - 1].at) * timing.motionSeconds;
				tl.to(step(motion[i]), span, { ease: i === motion.length - 1 ? 'in' : 'linear' });
			}
		} else {
			tl.to(letterPose(ch, {}, base), timing.transitionSeconds, { ease: 'smooth' });
			tl.hold(timing.holdSeconds);
		}
		prev = ch;
	}

	// Drop the hand back to rest unless the caller is stitching more signing on.
	if (opts.settle === false) tl.hold(timing.tailSeconds);
	else tl.settle(timing.tailSeconds);

	return tl.build({
		name: opts.name ?? `fingerspell-${letters.toLowerCase().replace(/ /g, '-')}`,
		seed: `fingerspell:${letters}:${timing.holdSeconds}:${timing.transitionSeconds}:${timing.leadSeconds}:${timing.tailSeconds}`,
	});
}

/** The citation place for fingerspelling, so other lanes can match it. */
export { SPELLING_PLACE };
