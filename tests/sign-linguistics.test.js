/**
 * ASL phonological constraints: a lint over the sign vocabulary.
 *
 * Two-handed signs are not free-form. Battison (1978) described two constraints
 * that hold across the whole language, and a sign that breaks one is almost
 * always an authoring mistake rather than a real exception:
 *
 *   Symmetry Condition: if BOTH hands move, they use the same handshape and
 *     their movement is symmetrical.
 *   Dominance Condition: if the two hands take DIFFERENT handshapes, only the
 *     dominant hand may move and the passive hand is limited to a small set of
 *     unmarked handshapes. Two hands sharing one handshape are unrestricted,
 *     which is why NAME (both hands in H, only the dominant one taps) is fine.
 *
 * Encoding them here means a new entry in src/sign-dictionary.js is checked
 * against the language, not just against whether it renders. That matters more
 * as the vocabulary grows and as signs arrive from people who did not write the
 * solver.
 */

import { describe, expect, it } from 'vitest';

import { SIGNS } from '../src/sign-dictionary.js';
import { HANDSHAPES } from '../src/sign-handshapes.js';

// The unmarked handshapes: the ones a passive hand is allowed to take. These are
// the maximally distinct, easiest-to-produce shapes of the language.
const UNMARKED = new Set(['A', 'S', 'B', 'FLAT', '5', 'C', 'O', '0', '1', 'BENT_B', 'FLAT_O', 'CLAW']);

/** Resolve each phase into what each hand is doing. */
function handTrack(sign, side) {
	return sign.phases.map((phase) => {
		const own = phase[side];
		if (own === 'rest') return null;
		const merged = phase.both ? { ...phase.both, ...(own ?? {}) } : own;
		if (!merged) return null;
		return {
			shape: merged.shape ?? null,
			// Everything that determines WHERE the hand is. Two phases that differ
			// in any of these mean the hand moved.
			place: JSON.stringify([merged.at ?? null, merged.touch ?? null, merged.fingers ?? null, merged.palm ?? null]),
		};
	});
}

function moves(track) {
	const active = track.filter(Boolean);
	if (active.length < 2) return false;
	return active.some((p) => p.place !== active[0].place);
}

/** The last handshape a hand is given (shapes carry forward between phases). */
function shapeOf(track) {
	let shape = null;
	for (const phase of track) if (phase?.shape) shape = phase.shape;
	return shape;
}

const ENTRIES = Object.entries(SIGNS).map(([word, sign]) => ({
	word,
	sign,
	right: handTrack(sign, 'right'),
	left: handTrack(sign, 'left'),
}));

const twoHanded = ENTRIES.filter((e) => e.right.some(Boolean) && e.left.some(Boolean));

describe('handshapes referenced by the vocabulary', () => {
	it('every shape a sign names actually exists', () => {
		for (const { word, sign } of ENTRIES) {
			for (const phase of sign.phases) {
				for (const hand of [phase.both, phase.left, phase.right]) {
					if (!hand || hand === 'rest' || !hand.shape) continue;
					expect(HANDSHAPES[hand.shape], `${word}: "${hand.shape}"`).toBeTruthy();
				}
			}
		}
	});
});

describe('Battison’s Symmetry Condition', () => {
	it('when both hands move, both use the same handshape', () => {
		for (const entry of twoHanded) {
			if (!moves(entry.right) || !moves(entry.left)) continue;
			const right = shapeOf(entry.right);
			const left = shapeOf(entry.left);
			expect(left, `${entry.word}: both hands move, so both must take one handshape`).toBe(right);
		}
	});
});

describe('Battison’s Dominance Condition', () => {
	it('a passive hand of its own handshape only ever takes an unmarked one', () => {
		for (const entry of twoHanded) {
			const rightMoves = moves(entry.right);
			const leftMoves = moves(entry.left);
			if (rightMoves === leftMoves) continue; // both move, or neither: not this rule
			const active = shapeOf(rightMoves ? entry.right : entry.left);
			const passive = shapeOf(rightMoves ? entry.left : entry.right);
			if (!passive || passive === active) continue; // one shared shape is unrestricted
			expect(
				UNMARKED.has(passive),
				`${entry.word}: the hands differ, so the passive "${passive}" must be an unmarked handshape`,
			).toBe(true);
		}
	});
});

describe('vocabulary hygiene', () => {
	it('no sign leaves a hand with a place but no handshape', () => {
		for (const { word, sign } of ENTRIES) {
			for (const [i, phase] of sign.phases.entries()) {
				for (const side of ['left', 'right']) {
					const hand = phase.both ? { ...phase.both, ...(phase[side] ?? {}) } : phase[side];
					if (!hand || hand === 'rest') continue;
					const first = sign.phases.findIndex(
						(p) => p.both?.shape || p[side]?.shape,
					);
					expect(first >= 0 && first <= i, `${word} phase ${i} (${side})`).toBe(true);
				}
			}
		}
	});

	it('every phase moves the hands somewhere new', () => {
		// A phase identical to the one before it is dead time, not a sign.
		for (const { word, right, left } of ENTRIES) {
			for (let i = 1; i < right.length; i++) {
				const same =
					right[i]?.place === right[i - 1]?.place &&
					left[i]?.place === left[i - 1]?.place &&
					right[i]?.shape === right[i - 1]?.shape;
				expect(same, `${word}: phase ${i} repeats phase ${i - 1}`).toBe(false);
			}
		}
	});
});
