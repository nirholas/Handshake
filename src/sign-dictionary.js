// Lexical ASL signs — the vocabulary an avatar signs instead of spelling.
//
// Fingerspelling is a fallback, not a language: a signer spells names and
// loanwords and SIGNS everything else. This module holds the signs themselves,
// written the way ASL is actually described — a handshape, a place on or in
// front of the body, the direction the palm and fingers face, and a movement
// through those places. Both hands are first-class: two-handed signs are the
// normal case in ASL, and writing one is a single `both:` block because places
// and directions are body-relative (src/sign-clip.js), so the non-dominant hand
// mirrors for free.
//
// Every sign compiles through the same solver the alphabet uses: the wrist goes
// to a POINT in signing space and src/sign-rig.js's two-bone IK finds the
// shoulder, elbow, and wrist that put it there. Nothing is hand-tuned in joint
// angles, so a sign holds up on any rigged avatar the retargeter can drive.
//
// Coverage is deliberately a core vocabulary, not a claim to fluency. Words with
// no entry here fingerspell (src/sign-speech.js decides), and this file is meant
// to grow: add an entry, add a test asserting where the hands end up, done.
//
// Grammar note: these are citation-form signs strung together in English word
// order. That is "signed English", not ASL grammar (which reorders, inflects
// verbs spatially, and carries meaning in the face). The page says so plainly —
// we are not pretending otherwise.

import { SignTimeline, posePhase, restingPose } from './sign-clip.js';

// Where the non-dominant hand waits when it is a surface for the other hand to
// act on (FALL, HELP, GOOD, STOP): flat, palm up, in front of the chest.
const BASE_PALM = {
	shape: 'FLAT',
	at: { anchor: 'sternum', out: 0.06, up: -0.09, forward: 0.24 },
	fingers: ['forward', 'in'],
	palm: 'up',
};

// Neutral signing space in front of the chest, where most two-handed signs live.
const NEUTRAL = { anchor: 'sternum', out: 0.13, up: -0.02, forward: 0.26 };

/**
 * The vocabulary. Each sign is a list of phases; `t` is the seconds spent moving
 * INTO that phase and `hold` the seconds spent in it. `both` poses both hands
 * from one description, `right`/`left` override or act alone.
 *
 * @type {Record<string, { gloss: string, phases: object[] }>}
 */
export const SIGNS = Object.freeze({
	HELLO: {
		gloss: 'Flat hand salutes out from the temple.',
		phases: [
			{ t: 0.3, right: { shape: 'FLAT', at: { anchor: 'forehead', out: 0.11, up: -0.03, forward: 0.1 }, fingers: ['up', 'in'], palm: ['forward', 'down'] }, head: { nod: 2 }, hold: 0.1 },
			{ t: 0.32, right: { shape: 'FLAT', at: { anchor: 'forehead', out: 0.21, up: -0.07, forward: 0.18 }, fingers: ['up', 'out'], palm: 'forward' }, head: { nod: -2 }, hold: 0.18 },
		],
	},
	THANK: {
		gloss: 'Flat hand moves out and down from the chin.',
		phases: [
			{ t: 0.3, right: { shape: 'FLAT', at: { anchor: 'chin', out: 0.03, up: -0.03, forward: 0.12 }, fingers: ['up', 'in'], palm: 'back' }, head: { nod: 3 }, hold: 0.12 },
			{ t: 0.34, right: { shape: 'FLAT', at: { anchor: 'chin', out: 0.08, up: -0.16, forward: 0.28 }, fingers: ['forward', 'up'], palm: 'up' }, head: { nod: 6 }, hold: 0.16 },
		],
	},
	PLEASE: {
		gloss: 'Flat hand circles on the chest.',
		phases: [
			{ t: 0.3, right: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.02, up: 0.03, forward: 0.13 }, fingers: ['up', 'in'], palm: 'back' } },
			{ t: 0.26, right: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.09, up: -0.02, forward: 0.13 }, fingers: ['up', 'in'], palm: 'back' } },
			{ t: 0.26, right: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.02, up: -0.07, forward: 0.13 }, fingers: ['up', 'in'], palm: 'back' } },
			{ t: 0.26, right: { shape: 'FLAT', at: { anchor: 'sternum', out: -0.04, up: -0.02, forward: 0.13 }, fingers: ['up', 'in'], palm: 'back' } },
			{ t: 0.26, right: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.02, up: 0.03, forward: 0.13 }, fingers: ['up', 'in'], palm: 'back' }, hold: 0.1 },
		],
	},
	SORRY: {
		gloss: 'A-hand circles over the heart.',
		phases: [
			{ t: 0.3, right: { shape: 'A', at: { anchor: 'sternum', out: 0.03, up: 0.02, forward: 0.14 }, fingers: 'up', palm: 'back' }, head: { nod: 5, tilt: 3 } },
			{ t: 0.26, right: { shape: 'A', at: { anchor: 'sternum', out: 0.1, up: -0.04, forward: 0.14 }, fingers: 'up', palm: 'back' }, head: { nod: 5, tilt: 3 } },
			{ t: 0.26, right: { shape: 'A', at: { anchor: 'sternum', out: 0.03, up: -0.09, forward: 0.14 }, fingers: 'up', palm: 'back' }, head: { nod: 5, tilt: 3 } },
			{ t: 0.26, right: { shape: 'A', at: { anchor: 'sternum', out: 0.03, up: 0.02, forward: 0.14 }, fingers: 'up', palm: 'back' }, head: { nod: 5, tilt: 3 }, hold: 0.12 },
		],
	},
	YES: {
		gloss: 'S-hand nods at the wrist, like a head saying yes.',
		phases: [
			{ t: 0.28, right: { shape: 'S', at: NEUTRAL, fingers: 'up', palm: 'forward' }, head: { nod: 3 } },
			{ t: 0.18, right: { shape: 'S', at: NEUTRAL, fingers: ['forward', 'down'], palm: ['forward', 'down'] }, head: { nod: 7 } },
			{ t: 0.18, right: { shape: 'S', at: NEUTRAL, fingers: 'up', palm: 'forward' }, head: { nod: 2 } },
			{ t: 0.18, right: { shape: 'S', at: NEUTRAL, fingers: ['forward', 'down'], palm: ['forward', 'down'] }, head: { nod: 7 }, hold: 0.12 },
		],
	},
	NO: {
		gloss: 'Index and middle finger snap shut against the thumb.',
		phases: [
			{ t: 0.28, right: { shape: 'U', at: { anchor: 'chin', out: 0.14, up: -0.1, forward: 0.24 }, fingers: ['forward', 'up'], palm: ['down', 'forward'] }, head: { turn: 4 } },
			{ t: 0.2, right: { shape: 'FLAT_O', at: { anchor: 'chin', out: 0.14, up: -0.1, forward: 0.24 }, fingers: ['forward', 'up'], palm: ['down', 'forward'] }, head: { turn: -4 }, hold: 0.16 },
		],
	},
	HAPPY: {
		gloss: 'Both flat hands brush up the chest in circles.',
		phases: [
			{ t: 0.3, both: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.14, up: -0.13, forward: 0.16 }, fingers: ['up', 'in'], palm: 'back' }, head: { nod: -2 } },
			{ t: 0.24, both: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.16, up: 0.01, forward: 0.19 }, fingers: ['up', 'in'], palm: ['back', 'down'] }, head: { nod: -4 } },
			{ t: 0.24, both: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.14, up: -0.13, forward: 0.16 }, fingers: ['up', 'in'], palm: 'back' }, head: { nod: -2 } },
			{ t: 0.24, both: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.16, up: 0.01, forward: 0.19 }, fingers: ['up', 'in'], palm: ['back', 'down'] }, head: { nod: -4 }, hold: 0.14 },
		],
	},
	FALL: {
		gloss: 'Two legs stand on the flat palm, then tip over onto their back.',
		phases: [
			{ t: 0.32, left: BASE_PALM, right: { shape: 'V', at: { anchor: 'sternum', out: 0.02, up: 0.0, forward: 0.26 }, fingers: 'down', palm: 'back' }, hold: 0.16 },
			{ t: 0.3, left: BASE_PALM, right: { shape: 'V', at: { anchor: 'sternum', out: 0.16, up: -0.07, forward: 0.27 }, fingers: ['out', 'forward'], palm: 'up' }, head: { turn: -4, tilt: 4 }, hold: 0.2 },
		],
	},
	YALL: {
		gloss: 'Flat palm-up hand sweeps an arc across the group.',
		phases: [
			{ t: 0.3, right: { shape: 'FLAT', at: { anchor: 'sternum', out: -0.08, up: -0.06, forward: 0.28 }, fingers: ['forward', 'in'], palm: 'up' }, head: { turn: 5 } },
			{ t: 0.42, right: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.26, up: -0.04, forward: 0.24 }, fingers: ['forward', 'out'], palm: 'up' }, head: { turn: -6 }, hold: 0.16 },
		],
	},
	YOU: {
		gloss: 'Index finger points at the person addressed.',
		phases: [
			{ t: 0.28, right: { shape: '1', at: { anchor: 'sternum', out: 0.06, up: 0.04, forward: 0.3 }, fingers: 'forward', palm: 'down' }, head: { nod: 2 }, hold: 0.22 },
		],
	},
	ME: {
		gloss: 'Index finger points to the signer’s own chest.',
		phases: [
			{ t: 0.28, right: { shape: '1', at: { anchor: 'sternum', out: 0.05, up: -0.02, forward: 0.14 }, fingers: ['in', 'back'], palm: 'down' }, hold: 0.22 },
		],
	},
	NAME: {
		gloss: 'Two H-hands tap across each other.',
		phases: [
			{ t: 0.3, left: { shape: 'H', at: { anchor: 'sternum', out: 0.05, up: -0.02, forward: 0.25 }, fingers: ['forward', 'in'], palm: ['in', 'down'] }, right: { shape: 'H', at: { anchor: 'sternum', out: 0.05, up: 0.05, forward: 0.25 }, fingers: ['forward', 'in'], palm: 'down' } },
			{ t: 0.16, left: { shape: 'H', at: { anchor: 'sternum', out: 0.05, up: -0.02, forward: 0.25 }, fingers: ['forward', 'in'], palm: ['in', 'down'] }, right: { shape: 'H', at: { anchor: 'sternum', out: 0.05, up: 0.005, forward: 0.25 }, fingers: ['forward', 'in'], palm: 'down' } },
			{ t: 0.16, left: { shape: 'H', at: { anchor: 'sternum', out: 0.05, up: -0.02, forward: 0.25 }, fingers: ['forward', 'in'], palm: ['in', 'down'] }, right: { shape: 'H', at: { anchor: 'sternum', out: 0.05, up: 0.05, forward: 0.25 }, fingers: ['forward', 'in'], palm: 'down' } },
			{ t: 0.16, left: { shape: 'H', at: { anchor: 'sternum', out: 0.05, up: -0.02, forward: 0.25 }, fingers: ['forward', 'in'], palm: ['in', 'down'] }, right: { shape: 'H', at: { anchor: 'sternum', out: 0.05, up: 0.005, forward: 0.25 }, fingers: ['forward', 'in'], palm: 'down' }, hold: 0.14 },
		],
	},
	HELP: {
		gloss: 'A-hand rides the flat palm upward.',
		phases: [
			{ t: 0.32, left: BASE_PALM, right: { shape: 'A', at: { anchor: 'sternum', out: 0.03, up: -0.06, forward: 0.26 }, fingers: 'up', palm: 'in' } },
			{ t: 0.28, left: { ...BASE_PALM, at: { anchor: 'sternum', out: 0.06, up: 0.02, forward: 0.26 } }, right: { shape: 'A', at: { anchor: 'sternum', out: 0.03, up: 0.05, forward: 0.28 }, fingers: 'up', palm: 'in' }, hold: 0.16 },
		],
	},
	GOOD: {
		gloss: 'Flat hand comes down from the chin onto the other palm.',
		phases: [
			{ t: 0.3, right: { shape: 'FLAT', at: { anchor: 'chin', out: 0.03, up: -0.02, forward: 0.13 }, fingers: ['up', 'in'], palm: 'back' }, left: BASE_PALM, head: { nod: 3 } },
			{ t: 0.3, right: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.05, up: -0.02, forward: 0.25 }, fingers: ['forward', 'in'], palm: 'up' }, left: BASE_PALM, head: { nod: 5 }, hold: 0.18 },
		],
	},
	BAD: {
		gloss: 'Flat hand leaves the chin and turns palm-down.',
		phases: [
			{ t: 0.3, right: { shape: 'FLAT', at: { anchor: 'chin', out: 0.03, up: -0.02, forward: 0.13 }, fingers: ['up', 'in'], palm: 'back' }, head: { nod: 2 } },
			{ t: 0.3, right: { shape: 'FLAT', at: { anchor: 'chin', out: 0.14, up: -0.2, forward: 0.24 }, fingers: ['forward', 'out'], palm: 'down' }, head: { nod: -3, turn: -5 }, hold: 0.16 },
		],
	},
	LOVE: {
		gloss: 'Both arms cross over the heart.',
		phases: [
			{ t: 0.36, left: { shape: 'S', at: { anchor: 'sternum', out: -0.07, up: 0.02, forward: 0.15 }, fingers: ['up', 'in'], palm: 'back' }, right: { shape: 'S', at: { anchor: 'sternum', out: -0.07, up: -0.05, forward: 0.17 }, fingers: ['up', 'in'], palm: 'back' }, head: { nod: 4, tilt: 3 }, hold: 0.3 },
		],
	},
	LEARN: {
		gloss: 'Fingers lift knowledge off the palm to the forehead.',
		phases: [
			{ t: 0.32, left: BASE_PALM, right: { shape: 'CLAW', at: { anchor: 'sternum', out: 0.04, up: -0.04, forward: 0.27 }, fingers: 'down', palm: 'down' } },
			{ t: 0.2, left: BASE_PALM, right: { shape: 'FLAT_O', at: { anchor: 'sternum', out: 0.04, up: 0.02, forward: 0.26 }, fingers: 'down', palm: 'back' } },
			{ t: 0.32, left: BASE_PALM, right: { shape: 'FLAT_O', at: { anchor: 'forehead', out: 0.05, up: -0.05, forward: 0.1 }, fingers: ['up', 'back'], palm: 'down' }, hold: 0.16 },
		],
	},
	KNOW: {
		gloss: 'Fingertips tap the forehead.',
		phases: [
			{ t: 0.3, right: { shape: 'BENT_B', at: { anchor: 'forehead', out: 0.1, up: -0.06, forward: 0.07 }, fingers: ['up', 'in'], palm: 'back' } },
			{ t: 0.16, right: { shape: 'BENT_B', at: { anchor: 'forehead', out: 0.08, up: -0.06, forward: 0.04 }, fingers: ['up', 'in'], palm: 'back' }, hold: 0.14 },
		],
	},
	THINK: {
		gloss: 'Index finger touches the temple.',
		phases: [
			{ t: 0.3, right: { shape: '1', at: { anchor: 'forehead', out: 0.09, up: -0.06, forward: 0.06 }, fingers: ['in', 'up'], palm: 'down' }, head: { tilt: 3 }, hold: 0.24 },
		],
	},
	SEE: {
		gloss: 'V-hand moves out from the eyes.',
		phases: [
			{ t: 0.3, right: { shape: 'V', at: { anchor: 'nose', out: 0.08, up: 0.02, forward: 0.1 }, fingers: ['up', 'forward'], palm: 'back' } },
			{ t: 0.3, right: { shape: 'V', at: { anchor: 'nose', out: 0.11, up: -0.02, forward: 0.26 }, fingers: 'forward', palm: 'down' }, hold: 0.16 },
		],
	},
	WANT: {
		gloss: 'Both claw hands draw in toward the body.',
		phases: [
			{ t: 0.32, both: { shape: 'CLAW', at: { anchor: 'sternum', out: 0.11, up: -0.04, forward: 0.32 }, fingers: 'forward', palm: 'up' } },
			{ t: 0.3, both: { shape: 'CLAW', at: { anchor: 'sternum', out: 0.11, up: -0.08, forward: 0.19 }, fingers: ['forward', 'up'], palm: 'up' }, head: { nod: 3 }, hold: 0.16 },
		],
	},
	MORE: {
		gloss: 'Both flat-O hands tap fingertips together.',
		phases: [
			{ t: 0.3, both: { shape: 'FLAT_O', at: { anchor: 'sternum', out: 0.11, up: 0.0, forward: 0.26 }, fingers: 'in', palm: 'down' } },
			{ t: 0.18, both: { shape: 'FLAT_O', at: { anchor: 'sternum', out: 0.05, up: 0.0, forward: 0.26 }, fingers: 'in', palm: 'down' } },
			{ t: 0.18, both: { shape: 'FLAT_O', at: { anchor: 'sternum', out: 0.11, up: 0.0, forward: 0.26 }, fingers: 'in', palm: 'down' } },
			{ t: 0.18, both: { shape: 'FLAT_O', at: { anchor: 'sternum', out: 0.05, up: 0.0, forward: 0.26 }, fingers: 'in', palm: 'down' }, hold: 0.14 },
		],
	},
	STOP: {
		gloss: 'Flat hand chops down onto the other palm.',
		phases: [
			{ t: 0.3, left: { ...BASE_PALM, at: { anchor: 'sternum', out: 0.04, up: -0.06, forward: 0.26 } }, right: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.04, up: 0.09, forward: 0.26 }, fingers: ['forward', 'up'], palm: 'in' } },
			{ t: 0.2, left: { ...BASE_PALM, at: { anchor: 'sternum', out: 0.04, up: -0.06, forward: 0.26 } }, right: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.04, up: -0.03, forward: 0.26 }, fingers: 'forward', palm: 'in' }, head: { nod: 3 }, hold: 0.2 },
		],
	},
	WORK: {
		gloss: 'One fist taps the back of the other wrist twice.',
		phases: [
			{ t: 0.32, left: { shape: 'S', at: { anchor: 'sternum', out: 0.02, up: -0.08, forward: 0.26 }, fingers: ['forward', 'in'], palm: 'down' }, right: { shape: 'S', at: { anchor: 'sternum', out: 0.03, up: 0.02, forward: 0.24 }, fingers: ['forward', 'in'], palm: 'down' } },
			{ t: 0.16, left: { shape: 'S', at: { anchor: 'sternum', out: 0.02, up: -0.08, forward: 0.26 }, fingers: ['forward', 'in'], palm: 'down' }, right: { shape: 'S', at: { anchor: 'sternum', out: 0.03, up: -0.03, forward: 0.24 }, fingers: ['forward', 'in'], palm: 'down' } },
			{ t: 0.16, left: { shape: 'S', at: { anchor: 'sternum', out: 0.02, up: -0.08, forward: 0.26 }, fingers: ['forward', 'in'], palm: 'down' }, right: { shape: 'S', at: { anchor: 'sternum', out: 0.03, up: 0.02, forward: 0.24 }, fingers: ['forward', 'in'], palm: 'down' } },
			{ t: 0.16, left: { shape: 'S', at: { anchor: 'sternum', out: 0.02, up: -0.08, forward: 0.26 }, fingers: ['forward', 'in'], palm: 'down' }, right: { shape: 'S', at: { anchor: 'sternum', out: 0.03, up: -0.03, forward: 0.24 }, fingers: ['forward', 'in'], palm: 'down' }, hold: 0.14 },
		],
	},
	FRIEND: {
		gloss: 'Hooked index fingers link, then swap.',
		phases: [
			{ t: 0.32, left: { shape: 'X', at: { anchor: 'sternum', out: 0.05, up: -0.03, forward: 0.26 }, fingers: ['forward', 'in', 'up'], palm: 'up' }, right: { shape: 'X', at: { anchor: 'sternum', out: 0.05, up: 0.03, forward: 0.26 }, fingers: ['forward', 'in', 'down'], palm: 'down' }, hold: 0.14 },
			{ t: 0.26, left: { shape: 'X', at: { anchor: 'sternum', out: 0.05, up: 0.03, forward: 0.26 }, fingers: ['forward', 'in', 'down'], palm: 'down' }, right: { shape: 'X', at: { anchor: 'sternum', out: 0.05, up: -0.03, forward: 0.26 }, fingers: ['forward', 'in', 'up'], palm: 'up' }, hold: 0.16 },
		],
	},
	MEET: {
		gloss: 'Two upright index fingers come together.',
		phases: [
			{ t: 0.3, both: { shape: '1', at: { anchor: 'sternum', out: 0.17, up: 0.02, forward: 0.26 }, fingers: 'up', palm: 'in' } },
			{ t: 0.28, both: { shape: '1', at: { anchor: 'sternum', out: 0.04, up: 0.02, forward: 0.26 }, fingers: 'up', palm: 'in' }, head: { nod: 3 }, hold: 0.18 },
		],
	},
	NICE: {
		gloss: 'Flat hand slides cleanly across the other palm.',
		phases: [
			{ t: 0.32, left: { ...BASE_PALM, fingers: ['forward', 'out'] }, right: { shape: 'FLAT', at: { anchor: 'sternum', out: -0.04, up: -0.05, forward: 0.24 }, fingers: ['forward', 'out'], palm: 'down' } },
			{ t: 0.32, left: { ...BASE_PALM, fingers: ['forward', 'out'] }, right: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.19, up: -0.05, forward: 0.26 }, fingers: ['forward', 'out'], palm: 'down' }, hold: 0.16 },
		],
	},
	WELCOME: {
		gloss: 'Open palm sweeps in toward the body, inviting.',
		phases: [
			{ t: 0.32, right: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.22, up: -0.04, forward: 0.3 }, fingers: ['forward', 'out'], palm: 'up' }, head: { turn: -4 } },
			{ t: 0.34, right: { shape: 'FLAT', at: { anchor: 'sternum', out: 0.02, up: -0.06, forward: 0.22 }, fingers: ['forward', 'in'], palm: 'up' }, head: { nod: 4 }, hold: 0.18 },
		],
	},
	WHAT: {
		gloss: 'Both palms turn up and shake, with a questioning brow.',
		phases: [
			{ t: 0.3, both: { shape: '5', at: { anchor: 'sternum', out: 0.15, up: -0.08, forward: 0.26 }, fingers: ['forward', 'out'], palm: 'up' }, head: { tilt: 3, nod: -3 } },
			{ t: 0.16, both: { shape: '5', at: { anchor: 'sternum', out: 0.18, up: -0.06, forward: 0.26 }, fingers: ['forward', 'out'], palm: 'up' }, head: { tilt: 3, nod: -3 } },
			{ t: 0.16, both: { shape: '5', at: { anchor: 'sternum', out: 0.15, up: -0.08, forward: 0.26 }, fingers: ['forward', 'out'], palm: 'up' }, head: { tilt: 3, nod: -3 }, hold: 0.16 },
		],
	},
	FINISH: {
		gloss: 'Both open hands flick out and down — done.',
		phases: [
			{ t: 0.3, both: { shape: '5', at: { anchor: 'sternum', out: 0.1, up: 0.04, forward: 0.24 }, fingers: 'up', palm: 'back' } },
			{ t: 0.24, both: { shape: '5', at: { anchor: 'sternum', out: 0.2, up: -0.08, forward: 0.26 }, fingers: ['forward', 'out'], palm: 'down' }, head: { nod: 4 }, hold: 0.18 },
		],
	},
	AGAIN: {
		gloss: 'Bent hand arcs over and taps into the flat palm.',
		phases: [
			{ t: 0.32, left: BASE_PALM, right: { shape: 'BENT_B', at: { anchor: 'sternum', out: 0.2, up: 0.02, forward: 0.24 }, fingers: ['up', 'out'], palm: 'up' } },
			{ t: 0.3, left: BASE_PALM, right: { shape: 'BENT_B', at: { anchor: 'sternum', out: 0.06, up: -0.05, forward: 0.26 }, fingers: ['down', 'in'], palm: 'down' }, hold: 0.16 },
		],
	},
	THREE: {
		gloss: 'The number three, held up clearly.',
		phases: [
			{ t: 0.3, right: { shape: '3', at: { anchor: 'chin', out: 0.2, up: -0.06, forward: 0.22 }, fingers: 'up', palm: 'forward' }, hold: 0.26 },
		],
	},
});

// Everyday words that map onto a sign already in the table. Kept separate so the
// vocabulary itself stays one entry per sign.
const ALIASES = Object.freeze({
	HI: 'HELLO',
	HEY: 'HELLO',
	THANKS: 'THANK',
	THANKYOU: 'THANK',
	YEAH: 'YES',
	YEP: 'YES',
	OK: 'YES',
	NOPE: 'NO',
	GLAD: 'HAPPY',
	FELL: 'FALL',
	FALLS: 'FALL',
	YOURE: 'YOU',
	MY: 'ME',
	MINE: 'ME',
	I: 'ME',
	IM: 'ME',
	NEED: 'WANT',
	WANTS: 'WANT',
	LIKE: 'GOOD',
	GREAT: 'GOOD',
	NICELY: 'NICE',
	KNOWS: 'KNOW',
	THINKS: 'THINK',
	LOOK: 'SEE',
	WATCH: 'SEE',
	MEETS: 'MEET',
	WORKS: 'WORK',
	WORKING: 'WORK',
	DONE: 'FINISH',
	FINISHED: 'FINISH',
	AGAIN: 'AGAIN',
	REPEAT: 'AGAIN',
	FRIENDS: 'FRIEND',
	HELPS: 'HELP',
	HELPING: 'HELP',
	LEARNING: 'LEARN',
	NAMED: 'NAME',
	EVERYONE: 'YALL',
	EVERYBODY: 'YALL',
	YALL: 'YALL',
	SORRYY: 'SORRY',
});

/** Every word this dictionary can sign, including aliases. */
export const SIGNABLE_WORDS = Object.freeze([...Object.keys(SIGNS), ...Object.keys(ALIASES)].sort());

/**
 * Resolve a normalized word to its sign entry, or null when it must be spelled.
 * @param {string} word  already uppercased/normalized
 * @returns {{ name: string, sign: object }|null}
 */
export function lookupSign(word) {
	const key = String(word ?? '').toUpperCase();
	const name = SIGNS[key] ? key : ALIASES[key];
	return name && SIGNS[name] ? { name, sign: SIGNS[name] } : null;
}

export const DEFAULT_SIGN_TIMING = Object.freeze({
	leadSeconds: 0.3,
	tailSeconds: 0.38,
	/** Scales every authored phase duration — the tempo control for chat. */
	rate: 1,
});

/**
 * Build the AnimationClip document for one lexical sign.
 *
 * @param {string} word
 * @param {{ name?: string, base?: import('./sign-rig.js').Pose, settle?: boolean, rate?: number }} [opts]
 * @returns {object|null} clip document, or null when the word has no sign
 */
export function buildSignClip(word, opts = {}) {
	const found = lookupSign(word);
	if (!found) return null;
	const timing = { ...DEFAULT_SIGN_TIMING, ...opts };
	const rate = timing.rate > 0 ? timing.rate : 1;
	const base = opts.base ?? restingPose();
	const tl = new SignTimeline({ base });

	found.sign.phases.forEach((phase, i) => {
		const seconds = ((phase.t ?? 0.3) + (i === 0 ? timing.leadSeconds : 0)) / rate;
		tl.to(posePhase(phase, base), seconds, { ease: phase.ease ?? (i === 0 ? 'out' : 'smooth') });
		if (phase.hold) tl.hold(phase.hold / rate);
	});

	if (opts.settle === false) tl.hold(timing.tailSeconds / rate);
	else tl.settle(timing.tailSeconds / rate);

	return tl.build({
		name: opts.name ?? `sign-${found.name.toLowerCase()}`,
		seed: `sign:${found.name}:${rate}`,
	});
}

/**
 * A lookup function shaped for {@link import('./sign-speech.js').compileUtterance}:
 * pass it as `signs` and every word with an entry is SIGNED, the rest spelled.
 *
 * @param {{ base?: import('./sign-rig.js').Pose, rate?: number }} [opts]
 * @returns {(word: string) => object|null}
 */
export function signLookup(opts = {}) {
	const cache = new Map();
	return (word) => {
		if (!cache.has(word)) cache.set(word, buildSignClip(word, { ...opts, settle: false }));
		return cache.get(word);
	};
}

/** Human-readable description of a sign, for the vocabulary UI. */
export function signGloss(word) {
	return lookupSign(word)?.sign.gloss ?? null;
}
