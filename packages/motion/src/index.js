// @three-ws/motion: text and structure to real, full-body animation.
//
// Two entry points cover almost every use:
//
//   compileScore(score)   a Motion Score in, an AnimationClip document out
//   motionFromText(text)  a prompt in, the same document out, no model needed
//
// Everything else here is the machinery those two are built from, exported
// because an editor, a solver front end, or a different score format is a
// reasonable thing to build on this and should not have to fork it.

import { buildClip, restClip, stableUuid, MOTION_BONES } from './clip.js';
import { composeScore, ACTION_NAMES } from './compose.js';
import { describeScore, normalizeScore, scoreSchema, validateScore, MOTION_SCORE_VERSION, LIMITS } from './score.js';
import { solveBeat, solveScorePoses, expressionWeights } from './solve.js';

export {
	MOTION_SCORE_VERSION,
	LIMITS,
	MOTION_BONES,
	ACTION_NAMES,
	normalizeScore,
	validateScore,
	scoreSchema,
	describeScore,
	composeScore,
	solveBeat,
	solveScorePoses,
	expressionWeights,
	buildClip,
	restClip,
	stableUuid,
};

export * from './vocabulary.js';
export { ANCHORS, ANCHOR_NAMES, DIRECTIONS, anchorPoint, restAnchor, bodyDirection } from './rig/anchors.js';
export { Pose, restPose, blendPose } from './rig/pose.js';
export {
	balanceError,
	balanceOffset,
	centreOfMass,
	shapeHand,
	solveArm,
	solveGaze,
	solveLeg,
	solveSpine,
	solveTurn,
	supportCentre,
	PLANT_TILT,
} from './rig/ik.js';
export {
	ARM_REACH,
	BODY_FORWARD,
	BODY_LEFT,
	BODY_UP,
	CANONICAL_BONES,
	GROUND_Y,
	LEG_LENGTH,
	SHOULDER_SPAN,
	STANDING_HIP_HEIGHT,
	boneLength,
	hasBone,
	restPos,
} from './rig/skeleton.js';

/**
 * Compile a Motion Score into an AnimationClip document.
 *
 * The same score always compiles to the same document, byte for byte, which is
 * what makes a motion cacheable, diffable, and safe to regenerate.
 *
 * @param {object} score a raw or normalized score
 * @param {{ idle?: boolean, rootMotion?: boolean, fingers?: boolean, name?: string }} [opts]
 *   `idle` layers breathing and micro-sway on top (default true). `rootMotion`
 *   emits the hip translation track (default true; turn it off for a clip that
 *   must play in place). `fingers` emits the finger bones (default true).
 * @returns {{ clip: object, score: object, warnings: string[] }}
 */
export function compileScore(score, opts = {}) {
	const normalized = normalizeScore(score);
	const { keys, warnings } = solveScorePoses(normalized);
	const clip = buildClip(keys, {
		name: opts.name ?? normalized.name,
		seed: `${normalized.seed}|${MOTION_SCORE_VERSION}|${opts.idle === false ? 'still' : 'alive'}|${opts.rootMotion === false ? 'fixed' : 'travel'}`,
		loop: normalized.loop,
		idle: opts.idle,
		rootMotion: opts.rootMotion,
		fingers: opts.fingers,
	});
	return { clip, score: normalized, warnings };
}

/**
 * Compile a prompt straight to a clip using the model-free lane.
 *
 * @param {string} prompt for example "wave hello twice, excitedly"
 * @param {{ loop?: boolean, effort?: string, name?: string, idle?: boolean, rootMotion?: boolean, fingers?: boolean }} [opts]
 * @returns {{ clip: object, score: object, matched: string, warnings: string[] }}
 * @throws {Error} when the prompt names no action this lane knows. The message
 *   lists what it does know, so a caller can escalate to a model or tell the
 *   user something useful.
 */
export function motionFromText(prompt, opts = {}) {
	const { score, matched, reason } = composeScore(prompt, opts);
	if (!score) throw Object.assign(new Error(reason), { code: 'unrecognized_motion' });
	const compiled = compileScore(score, opts);
	return { ...compiled, matched };
}

/**
 * Everything a score author needs in one object: the schema, the vocabulary,
 * and the limits. This is what a tool definition or a system prompt is built
 * from, so the words offered to a model can never drift from the words the
 * solver accepts.
 * @returns {object}
 */
export function motionCapabilities() {
	return {
		version: MOTION_SCORE_VERSION,
		schema: scoreSchema(),
		limits: LIMITS,
		actions: ACTION_NAMES,
	};
}
