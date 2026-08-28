// The words a motion score is written in.
//
// Everything here is a named shorthand for a set of numbers a solver can use.
// The point is not brevity: it is that a score author (a person, or a language
// model given the schema) can say `posture: "crouch"` and get a crouch with
// correct hip height, knee travel, foot spacing and torso counter-lean, instead
// of guessing eight numbers and producing something that reads as a fall.
//
// Every entry is a starting point, not a lock. A beat may override any field it
// names, so `{ posture: "crouch", root: { height: 0.5 } }` is a deeper crouch
// with everything else the posture already got right.

import { ARM_REACH, SHOULDER_SPAN, STANDING_HIP_HEIGHT } from './rig/skeleton.js';

/**
 * Whole-body postures. `height` is a fraction of standing hip height, `stance`
 * is the foot arrangement, and the torso values are the counter-lean that keeps
 * the shape balanced.
 *
 * `support` says what is carrying the body's weight, which decides whether the
 * balance pass runs. A standing body must keep its centre of mass over its
 * feet or it is falling; a seated or kneeling one is held up by the thing it is
 * sitting on, and forcing it over its feet would drag it off the chair.
 */
export const POSTURES = Object.freeze({
	stand: { height: 1, stance: 'neutral', torso: {} },
	/** Weight settled, feet a little apart: the default idle. */
	easy: { height: 0.995, stance: 'neutral', torso: { lean: 2 } },
	/** Athletic ready stance: knees soft, weight forward. */
	ready: { height: 0.93, stance: 'wide', torso: { lean: 10 } },
	/** Knees bent, hips back, chest up. */
	crouch: { height: 0.72, stance: 'wide', torso: { lean: 22 } },
	/** All the way down, heels threatening to lift. */
	squat: { height: 0.55, stance: 'wide', torso: { lean: 30 } },
	/** One knee down. */
	kneel: { support: 'ground', height: 0.52, stance: 'kneel', torso: { lean: 8 } },
	/** Seated on a surface at chair height, thighs level. */
	sit: { support: 'seat', height: 0.47, stance: 'sit', torso: { lean: 6 } },
	/** Seated and settled back. */
	slouch: { support: 'seat', height: 0.44, stance: 'sit', torso: { lean: -8 } },
	/** Weight forward over the front foot. */
	lunge: { height: 0.82, stance: 'split', torso: { lean: 14 } },
	/** Up on the balls of both feet. */
	tiptoe: { height: 1.06, stance: 'narrow', torso: { lean: 4 } },
	/** Leaning in, feet planted: interest, listening, confiding. */
	lean_in: { height: 0.985, stance: 'neutral', torso: { lean: 16 } },
	/** Leaning away: doubt, recoil, taking something in. */
	lean_back: { height: 0.99, stance: 'neutral', torso: { lean: -12 } },
	/** A bow from the waist. */
	bow: { height: 0.96, stance: 'narrow', torso: { lean: 42 } },
	/** Slumped: shoulders forward, head low, hips settled. */
	slump: { height: 0.94, stance: 'narrow', torso: { lean: 12 } },
	/** Drawn up: chest open, weight tall. */
	proud: { height: 1.01, stance: 'neutral', torso: { lean: -4 } },
});

export const POSTURE_NAMES = Object.freeze(Object.keys(POSTURES));

/**
 * Foot arrangements. Offsets are in metres from the body's centre line, in the
 * body's own frame: `out` is lateral, `forward` is toward where the body faces.
 * `lift` raises the ankle off the floor.
 */
export const STANCES = Object.freeze({
	neutral: { left: { out: 0.1, forward: 0 }, right: { out: 0.1, forward: 0 } },
	narrow: { left: { out: 0.055, forward: 0 }, right: { out: 0.055, forward: 0 } },
	wide: { left: { out: 0.19, forward: 0, heading: 9 }, right: { out: 0.19, forward: 0, heading: -9 } },
	/** One foot forward, one back: a step held, or a lunge. */
	split: { left: { out: 0.11, forward: 0.34 }, right: { out: 0.11, forward: -0.2, plant: 'toe' } },
	/** The mirror of split, so a walk can alternate. */
	split_right: { left: { out: 0.11, forward: -0.2, plant: 'toe' }, right: { out: 0.11, forward: 0.34 } },
	/** Front knee down, back foot on the toe. */
	kneel: { left: { out: 0.13, forward: 0.3 }, right: { out: 0.12, forward: -0.24, plant: 'toe' } },
	/** Sitting: both feet ahead of the hips, flat. */
	sit: { left: { out: 0.13, forward: 0.34 }, right: { out: 0.13, forward: 0.34 } },
	/** Both heels raised. */
	toes: { left: { out: 0.09, forward: 0, plant: 'toe' }, right: { out: 0.09, forward: 0, plant: 'toe' } },
	/** Weight on the left, right foot swinging free. */
	step_left: { left: { out: 0.09, forward: 0 }, right: { out: 0.11, forward: 0.22, lift: 0.07, plant: 'lift' } },
	step_right: { left: { out: 0.11, forward: 0.22, lift: 0.07, plant: 'lift' }, right: { out: 0.09, forward: 0 } },
});

export const STANCE_NAMES = Object.freeze(Object.keys(STANCES));

/**
 * Hand shapes, as the three numbers the hand solver takes. Enough to cover what
 * a gesture actually needs; anything finer belongs in a mocap clip, not a score.
 */
export const HAND_SHAPES = Object.freeze({
	open: { curl: 0, thumb: 0, spread: 0.35 },
	flat: { curl: 0, thumb: 0.1, spread: 0 },
	relaxed: { curl: 0.28, thumb: 0.3, spread: 0.1 },
	loose: { curl: 0.45, thumb: 0.4, spread: 0 },
	fist: { curl: 1, thumb: 0.85, spread: -0.2 },
	point: { curl: 0.9, thumb: 0.6, spread: 0 },
	pinch: { curl: 0.55, thumb: 0.95, spread: -0.1 },
	cup: { curl: 0.5, thumb: 0.2, spread: 0.25 },
	thumbs_up: { curl: 1, thumb: 0, spread: -0.2 },
});

export const HAND_SHAPE_NAMES = Object.freeze(Object.keys(HAND_SHAPES));

// The point shape has to leave the index finger straight, which no single curl
// value can express. The solver reads this exception and skips the named fingers.
export const HAND_SHAPE_EXTENDED = Object.freeze({
	point: ['Index'],
	thumbs_up: [],
});

/** Where an elbow is pushed, as a body-frame direction for the IK pole. */
export const ELBOW_POLES = Object.freeze({
	down: { out: 0.42, up: -1, forward: -0.3 },
	in: { out: -0.1, up: -1, forward: -0.15 },
	out: { out: 1, up: -0.35, forward: -0.2 },
	back: { out: 0.3, up: -0.5, forward: -1 },
	up: { out: 0.4, up: 0.8, forward: -0.2 },
	forward: { out: 0.3, up: -0.5, forward: 0.8 },
});

export const ELBOW_NAMES = Object.freeze(Object.keys(ELBOW_POLES));

/** Named gaze targets, in degrees of yaw (toward the body's left) and pitch. */
export const GAZES = Object.freeze({
	forward: { yaw: 0, pitch: 0 },
	down: { yaw: 0, pitch: -26 },
	up: { yaw: 0, pitch: 24 },
	left: { yaw: 34, pitch: 0 },
	right: { yaw: -34, pitch: 0 },
	away: { yaw: -22, pitch: 10 },
	/** Down and to one side: thinking, remembering, avoiding. */
	aside: { yaw: 20, pitch: -14 },
	/** Following the acting hand, resolved by the compiler. */
	hands: { yaw: 0, pitch: -18 },
});

export const GAZE_NAMES = Object.freeze(Object.keys(GAZES));

/**
 * Facial expressions as ARKit blendshape weights. The names match the shapes
 * the platform's avatars carry, and the retargeter drops any a given face is
 * missing rather than failing, so a score can always ask for an expression.
 */
export const EXPRESSIONS = Object.freeze({
	neutral: {},
	smile: { mouthSmileLeft: 0.45, mouthSmileRight: 0.45, cheekSquintLeft: 0.25, cheekSquintRight: 0.25 },
	grin: { mouthSmileLeft: 0.8, mouthSmileRight: 0.8, jawOpen: 0.16, cheekSquintLeft: 0.45, cheekSquintRight: 0.45 },
	sad: { mouthFrownLeft: 0.45, mouthFrownRight: 0.45, browInnerUp: 0.55 },
	angry: { browDownLeft: 0.8, browDownRight: 0.8, mouthPressLeft: 0.4, mouthPressRight: 0.4, noseSneerLeft: 0.25, noseSneerRight: 0.25 },
	surprised: { browInnerUp: 0.8, browOuterUpLeft: 0.7, browOuterUpRight: 0.7, jawOpen: 0.35, eyeWideLeft: 0.5, eyeWideRight: 0.5 },
	focused: { browDownLeft: 0.35, browDownRight: 0.35, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 },
	doubt: { browOuterUpLeft: 0.55, browDownRight: 0.4, mouthPucker: 0.2 },
	wince: { eyeSquintLeft: 0.7, eyeSquintRight: 0.7, mouthPressLeft: 0.5, mouthPressRight: 0.5, browInnerUp: 0.4 },
	tired: { eyeBlinkLeft: 0.4, eyeBlinkRight: 0.4, browInnerUp: 0.3, jawOpen: 0.1 },
	speaking: { jawOpen: 0.22, mouthFunnel: 0.12 },
});

export const EXPRESSION_NAMES = Object.freeze(Object.keys(EXPRESSIONS));

/** Every blendshape any expression can touch, so a beat can zero the rest. */
export const EXPRESSION_SHAPES = Object.freeze([
	...new Set(Object.values(EXPRESSIONS).flatMap((e) => Object.keys(e))),
].sort());

/**
 * Effort, in the sense a movement director means it: how a motion is performed
 * rather than what shape it makes. Three dials, each 0 to 1.
 *
 *   weight  0 light, floating          1 heavy, committed
 *   time    0 sustained, unhurried     1 sudden, urgent
 *   flow    0 bound, controlled        1 free, released
 *
 * These are what make the same shapes read as a wave, a swat, or a salute. They
 * scale beat timing, pick the easing curve, and set how far a limb overshoots
 * its target before it settles.
 */
export const EFFORTS = Object.freeze({
	neutral: { weight: 0.5, time: 0.5, flow: 0.5 },
	gentle: { weight: 0.25, time: 0.25, flow: 0.65 },
	precise: { weight: 0.45, time: 0.6, flow: 0.15 },
	sharp: { weight: 0.6, time: 0.95, flow: 0.3 },
	heavy: { weight: 0.95, time: 0.35, flow: 0.25 },
	light: { weight: 0.1, time: 0.55, flow: 0.8 },
	sustained: { weight: 0.5, time: 0.08, flow: 0.6 },
	urgent: { weight: 0.7, time: 0.9, flow: 0.55 },
	weary: { weight: 0.85, time: 0.12, flow: 0.3 },
	playful: { weight: 0.3, time: 0.7, flow: 0.9 },
});

export const EFFORT_NAMES = Object.freeze(Object.keys(EFFORTS));

/** Easing curves a beat can be entered on. */
export const EASES = Object.freeze({
	linear: (u) => u,
	smooth: (u) => u * u * (3 - 2 * u),
	/** Fast out of the previous shape, soft into this one. */
	out: (u) => 1 - (1 - u) * (1 - u),
	/** Slow to leave, arriving at speed: a strike. */
	in: (u) => u * u,
	/** Almost no travel, then all of it: a snap. */
	snap: (u) => u * u * u * u,
	/** Overshoot and come back: weight arriving. */
	overshoot: (u) => {
		const s = 1.35;
		const v = u - 1;
		return v * v * ((s + 1) * v + s) + 1;
	},
	/** Settling: most of the way immediately, then a long tail. */
	settle: (u) => 1 - (1 - u) ** 3,
});

export const EASE_NAMES = Object.freeze(Object.keys(EASES));

/** Metric units a score's offsets are written in, exported so tools can label them. */
export const UNITS = Object.freeze({
	handWidth: SHOULDER_SPAN * 0.22,
	shoulderSpan: SHOULDER_SPAN,
	armReach: ARM_REACH,
	standingHipHeight: STANDING_HIP_HEIGHT,
});
