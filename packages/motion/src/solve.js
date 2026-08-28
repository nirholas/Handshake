// Score to poses: the compiler.
//
// One beat becomes one solved skeleton, in a fixed order that matters:
//
//   root      where the hips are, which everything below hangs from
//   turn      the whole body's heading, so limbs solve in the turned frame
//   torso     lean, twist, side-bend, distributed along the spine
//   legs      ankles placed in WORLD space, so lowering the hips bends knees
//   balance   the hips nudged until the centre of mass sits over the feet
//   arms      wrists placed against anchors that ride the posed chest
//   hands     shape, after the wrist is where it belongs
//   gaze      last, so a look is relative to the chest it ended up on
//   face      expression weights
//
// Reversing any two of those produces a body that is subtly wrong in a way that
// is hard to see and impossible to fix downstream: solve the arms before the
// torso and every gesture sits where the chest used to be; solve the legs before
// the root and a crouch drives the feet through the floor.

import { anchorPoint, bodyDirection, restAnchor } from './rig/anchors.js';
import {
	ANKLE_REST_HEIGHT,
	BODY_FORWARD,
	BODY_LEFT,
	BODY_UP,
	STANDING_HIP_HEIGHT,
	boneLength,
	restPos,
} from './rig/skeleton.js';
import {
	FOOT_FLAT_DIR,
	PLANT_TILT,
	balanceOffset,
	shapeHand,
	solveArm,
	solveGaze,
	solveLeg,
	solveSpine,
	solveTurn,
} from './rig/ik.js';
import { Pose, restPose } from './rig/pose.js';
import { clamp, qAxisAngle, qRotate, vAdd, vCross, vDot, vLen, vNorm, vScale, vSub } from './rig/math.js';
import {
	ELBOW_POLES,
	EXPRESSIONS,
	GAZES,
	HAND_SHAPES,
	HAND_SHAPE_EXTENDED,
	POSTURES,
	STANCES,
} from './vocabulary.js';

/** How many times the balance pass runs. Two is enough; the third never moves. */
const BALANCE_PASSES = 3;

/** How much of the measured imbalance is corrected per pass. */
const BALANCE_GAIN = 0.75;

/** Balance closer than this is left alone: a body is never perfectly still. */
const BALANCE_TOLERANCE = 0.006;

/**
 * Solve one beat into a pose.
 *
 * @param {object} beat a normalized beat from `normalizeScore`
 * @returns {{ pose: import('./rig/pose.js').Pose, warnings: string[] }}
 */
export function solveBeat(beat) {
	const warnings = [];
	const posture = beat.posture ? POSTURES[beat.posture] : POSTURES.stand;
	const root = { height: posture.height, forward: 0, side: 0, rise: 0, turn: 0, ...beat.root };
	const torso = { ...posture.torso, ...beat.torso };
	const stance = STANCES[beat.legs.stance ?? posture.stance] ?? STANCES.neutral;
	const support = posture.support ?? 'feet';

	const pose = restPose();
	applyRoot(pose, root);
	solveTurn(pose, root.turn);
	solveSpine(pose, torso);

	const feet = footTargets(root, stance, beat.legs);
	placeFeet(pose, feet);

	if (support === 'feet') balanceOverFeet(pose, feet);

	for (const side of ['Left', 'Right']) {
		const spec = beat.arms[side.toLowerCase()];
		if (!spec) continue;
		const reached = placeArm(pose, side, spec);
		if (!reached) warnings.push(`the ${side.toLowerCase()} arm cannot reach ${describeArm(spec)}; it is extended toward it instead`);
	}

	for (const side of ['Left', 'Right']) {
		const spec = beat.arms[side.toLowerCase()];
		shapeFor(pose, side, spec?.hand);
	}

	applyGaze(pose, beat);
	if (beat.face) pose.setFace(expressionWeights(beat.face));

	return { pose, warnings };
}

/**
 * Solve every beat of a score.
 * @param {object} score a normalized score
 * @returns {{ keys: {time: number, pose: import('./rig/pose.js').Pose, beat: object}[], warnings: string[] }}
 */
export function solveScorePoses(score) {
	const warnings = [];
	const keys = score.beats.map((beat) => {
		const solved = solveBeat(beat);
		for (const w of solved.warnings) warnings.push(`beat at ${beat.at.toFixed(2)}s: ${w}`);
		return { time: beat.at, pose: solved.pose, beat };
	});
	return { keys, warnings };
}

// ── root ───────────────────────────────────────────────────────────────────

function applyRoot(pose, root) {
	const drop = STANDING_HIP_HEIGHT * (root.height - 1) + root.rise;
	const travel = vAdd(vScale(BODY_FORWARD, root.forward), vScale(BODY_LEFT, root.side));
	pose.setRootOffset([travel[0], drop + travel[1], travel[2]]);
}

// ── feet ───────────────────────────────────────────────────────────────────

const FOOT_LENGTH = boneLength('LeftFoot');

/**
 * Where each ankle goes, in world space.
 *
 * Feet are placed against the FLOOR and the body's travel, not against the
 * hips. That is the whole trick: the hips are free to drop, lean, and turn, and
 * the legs absorb it through IK, exactly as a real body does.
 */
function footTargets(root, stance, legs) {
	const heading = qAxisAngle(BODY_UP, root.turn);
	const planar = vAdd(
		vScale(BODY_FORWARD, root.forward),
		vScale(BODY_LEFT, root.side),
	);
	const out = {};
	for (const side of ['Left', 'Right']) {
		const key = side.toLowerCase();
		const spec = { ...(stance[key] ?? {}), ...(legs[key] ?? {}) };
		const outward = side === 'Left' ? (spec.out ?? 0.1) : -(spec.out ?? 0.1);
		const local = vAdd(vScale(BODY_LEFT, outward), vScale(BODY_FORWARD, spec.forward ?? 0));
		const ground = vAdd(planar, qRotate(heading, local));
		const plant = spec.plant ?? 'flat';
		const ankle = vAdd(
			[ground[0], 0, ground[2]],
			vScale(BODY_UP, ANKLE_REST_HEIGHT + (spec.lift ?? 0)),
		);
		out[side] = {
			ankle: vAdd(ankle, plantRise(plant, root.turn + (spec.heading ?? 0))),
			plant,
			heading: root.turn + (spec.heading ?? 0),
			bearing: spec.forward ?? 0,
		};
	}
	return out;
}

/**
 * How far the ankle rises when the foot rolls onto its toe or back onto its
 * heel. Derived by rotating the ankle-to-toe vector and keeping the contact
 * point still, which is what actually happens, rather than a tuned constant
 * that would be wrong for any other rig.
 */
function plantRise(plant, heading) {
	const tilt = PLANT_TILT[plant] ?? 0;
	if (!tilt) return [0, 0, 0];
	const yaw = qAxisAngle(BODY_UP, heading);
	const flat = qRotate(yaw, FOOT_FLAT_DIR);
	let across = vCross(BODY_UP, flat);
	if (vLen(across) < 1e-6) across = BODY_LEFT;
	const v = vScale(flat, FOOT_LENGTH);
	const rolled = qRotate(qAxisAngle(across, tilt), v);
	// A lifted foot is not in contact with anything, so it only hangs; it does
	// not push the ankle up.
	return plant === 'lift' ? [0, 0, 0] : vSub(v, rolled);
}

function placeFeet(pose, feet) {
	for (const side of ['Left', 'Right']) {
		const target = feet[side];
		solveLeg(pose, side, {
			ankle: target.ankle,
			heading: target.heading,
			plant: target.plant,
		});
	}
}

// ── balance ────────────────────────────────────────────────────────────────

/**
 * Nudge the hips horizontally until the centre of mass sits over the feet, then
 * put the legs back under the new hips.
 *
 * A lifted foot carries no weight, so the support base collapses onto the
 * standing foot and the body shifts over it, which is what makes a single-leg
 * beat read as standing on one leg instead of hovering.
 */
function balanceOverFeet(pose, feet) {
	const weights = {
		Left: feet.Left.plant === 'lift' ? 0 : 1,
		Right: feet.Right.plant === 'lift' ? 0 : 1,
	};
	if (!weights.Left && !weights.Right) return;
	for (let pass = 0; pass < BALANCE_PASSES; pass++) {
		const offset = balanceOffset(pose, weights);
		if (vLen(offset) < BALANCE_TOLERANCE) break;
		const corrected = vSub(pose.rootOffset, vScale(offset, BALANCE_GAIN));
		pose.setRootOffset(corrected);
		placeFeet(pose, feet);
	}
}

// ── arms ───────────────────────────────────────────────────────────────────

function placeArm(pose, side, spec) {
	const anchor = spec.at ?? 'side';
	const offset = {
		out: spec.out ?? 0,
		up: spec.up ?? 0,
		forward: spec.forward ?? 0,
		side,
	};
	const wrist = Array.isArray(anchor)
		? vAdd(anchor, pose.rootOffset)
		: anchorPoint(pose, anchor, offset);

	const pole = spec.elbow ? poleDirection(pose, side, spec.elbow) : null;
	const palm = spec.palm ? bodyDirection(pose, spec.palm, side) : null;
	const fingers = spec.point ? bodyDirection(pose, spec.point, side) : null;

	const shoulder = pose.worldPos(`${side}Arm`);
	const distance = vLen(vSub(wrist, shoulder));
	const reachable = distance <= (boneLength(`${side}Arm`) + boneLength(`${side}ForeArm`)) * 0.99;

	solveArm(pose, side, {
		wrist,
		palm,
		fingers,
		...(pole ? { pole } : {}),
	});
	return reachable;
}

function poleDirection(pose, side, name) {
	const spec = ELBOW_POLES[name];
	const outward = side === 'Left' ? spec.out : -spec.out;
	return vNorm(vAdd(
		vScale(BODY_LEFT, outward),
		vAdd(vScale(BODY_UP, spec.up), vScale(BODY_FORWARD, spec.forward)),
	));
}

function describeArm(spec) {
	const at = Array.isArray(spec.at) ? 'that point' : `"${spec.at ?? 'side'}"`;
	return at;
}

function shapeFor(pose, side, hand) {
	if (!hand) return;
	const base = hand.shape ? HAND_SHAPES[hand.shape] : HAND_SHAPES.relaxed;
	const spec = {
		curl: hand.curl ?? base.curl,
		thumb: hand.thumb ?? base.thumb,
		spread: hand.spread ?? base.spread,
	};
	const extended = hand.shape ? HAND_SHAPE_EXTENDED[hand.shape] : null;
	if (extended?.length) {
		// A pointing hand is a fist with one finger out, which one curl value
		// cannot say. Curl everything, then straighten the named fingers.
		shapeHand(pose, side, spec);
		shapeHand(pose, side, { curl: 0, thumb: spec.thumb, spread: 0, only: extended });
		return;
	}
	shapeHand(pose, side, spec);
}

// ── gaze and face ──────────────────────────────────────────────────────────

function applyGaze(pose, beat) {
	const spec = beat.gaze;
	if (!spec) return;
	const preset = spec.preset ? GAZES[spec.preset] : { yaw: 0, pitch: 0 };
	let yaw = spec.yaw ?? preset.yaw ?? 0;
	let pitch = spec.pitch ?? preset.pitch ?? 0;
	if (spec.preset === 'hands') {
		// Look at whichever hand is doing the work, measured rather than guessed.
		const target = activeHand(pose, beat);
		if (target) {
			const aim = aimAngles(pose, target);
			yaw = spec.yaw ?? aim.yaw;
			pitch = spec.pitch ?? aim.pitch;
		}
	}
	solveGaze(pose, { yaw, pitch, roll: spec.roll ?? 0 });
}

// The acting hand is the one furthest from where a hand hangs at rest.
function activeHand(pose, beat) {
	let best = null;
	let bestDist = 0.12;
	for (const side of ['Left', 'Right']) {
		if (!beat.arms[side.toLowerCase()]) continue;
		const here = pose.worldPos(`${side}Hand`);
		const rest = vAdd(restAnchor('side', { side }), pose.rootOffset);
		const dist = vLen(vSub(here, rest));
		if (dist > bestDist) {
			bestDist = dist;
			best = here;
		}
	}
	return best;
}

// Yaw and pitch from the head to a world point, in the body's own frame.
function aimAngles(pose, point) {
	const to = vSub(point, pose.worldPos('Head'));
	const ahead = vDot(to, BODY_FORWARD);
	const aside = vDot(to, BODY_LEFT);
	const yaw = Math.atan2(aside, ahead) * (180 / Math.PI);
	const pitch = Math.atan2(vDot(to, BODY_UP), Math.hypot(ahead, aside)) * (180 / Math.PI);
	// A neck does not turn 180 degrees. Clamped to a look a body can hold.
	return { yaw: clamp(yaw, -72, 72), pitch: clamp(pitch, -48, 38) };
}

/** Expand an expression spec into ARKit blendshape weights. */
export function expressionWeights(spec) {
	const out = {};
	for (const [key, value] of Object.entries(spec)) {
		const preset = EXPRESSIONS[key];
		if (preset) {
			for (const [shape, weight] of Object.entries(preset)) {
				out[shape] = Math.max(out[shape] ?? 0, weight * value);
			}
		} else {
			out[key] = value;
		}
	}
	return out;
}

export { Pose };
