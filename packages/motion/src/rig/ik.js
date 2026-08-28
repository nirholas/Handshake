// Inverse kinematics for a humanoid: two-bone limb solvers for the arms and
// legs, a distributed spine, a gaze chain, and hand shaping.
//
// Every solver takes world-space intent ("the wrist goes here", "the sole is
// flat on the floor there", "the chest leans 20 degrees") and writes local bone
// rotations. Nothing here reads the score format, so the same solvers serve the
// score compiler, an interactive editor, and a caller doing its own posing.
//
// The limb solvers share one shape on purpose: place the end joint on the
// circle of valid elbow/knee solutions, push that joint toward a pole so the
// bend goes the anatomically correct way, then let the twist fall out of the
// hand or foot orientation rather than leaving it in the wrist or ankle. That
// last step is the difference between a solved limb and a broken-looking one.

import {
	IDENTITY,
	clamp,
	orientQuat,
	qBetween,
	qSlerp,
	qAxisAngle,
	qConj,
	qMul,
	qRotate,
	vAdd,
	vCross,
	vDot,
	vLen,
	vNorm,
	vReject,
	vScale,
	vSub,
} from './math.js';
import {
	BODY_FORWARD,
	BODY_LEFT,
	BODY_UP,
	boneAxis,
	boneLength,
	hasBone,
	palmAxis,
	radialAxis,
	restLocal,
	restPalmWorld,
	restPos,
	restRadialWorld,
	restWorld,
} from './skeleton.js';

/**
 * Two-bone IK, shared by arms and legs.
 *
 * @param {import('./pose.js').Pose} pose mutated in place
 * @param {{ upper: string, lower: string, end: string }} chain bone names
 * @param {number[]} target world position for the end joint
 * @param {number[]} pole world direction the middle joint is pushed toward
 * @param {number} reach 0-1 cap on how straight the limb may lock
 * @returns {{ upper: number[], lower: number[], end: number[], reached: boolean }}
 *   the solved joint positions, and whether the target was inside range
 */
export function solveTwoBone(pose, chain, target, pole, reach) {
	const root = pose.worldPos(chain.upper);
	const lu = boneLength(chain.upper);
	const ll = boneLength(chain.lower);

	let toTarget = vSub(target, root);
	let dist = vLen(toTarget);
	const maxReach = (lu + ll) * reach;
	const minReach = Math.abs(lu - ll) + 1e-3;
	const reached = dist <= maxReach && dist >= minReach;
	if (dist < 1e-6) {
		toTarget = [0, -1, 0];
		dist = minReach;
	}
	dist = clamp(dist, minReach, maxReach);
	const toDir = vNorm(toTarget);

	let polePerp = vReject(pole, toDir);
	if (vLen(polePerp) < 1e-6) polePerp = vReject([0, -1, 0], toDir);
	polePerp = vNorm(polePerp);

	// Law of cosines: how far along the root-to-target line the middle joint sits.
	const cosRoot = clamp((lu * lu + dist * dist - ll * ll) / (2 * lu * dist), -1, 1);
	const sinRoot = Math.sqrt(Math.max(0, 1 - cosRoot * cosRoot));
	const middle = vAdd(root, vAdd(vScale(toDir, lu * cosRoot), vScale(polePerp, lu * sinRoot)));
	const end = vAdd(root, vScale(toDir, dist));

	return {
		upper: root,
		lower: middle,
		end,
		reached,
		upperDir: vNorm(vSub(middle, root)),
		lowerDir: vNorm(vSub(end, middle)),
		polePerp,
	};
}

/** Longest the clavicle is allowed to swing toward a target, in degrees. */
const MAX_CLAVICLE_ASSIST = 38;

/**
 * Let the shoulder girdle help.
 *
 * An arm is not two bones hanging off a fixed socket: the clavicle protracts,
 * elevates, and rotates, and that is worth ten to fifteen centimetres of reach
 * plus most of what makes a reach read as a whole body reaching. Without it the
 * reference rig cannot put a wrist on its own thigh, which is not a limit of
 * human anatomy, it is a limit of pretending the shoulder is bolted down.
 *
 * The assist only engages past a comfort radius and scales in from there, so a
 * gesture inside easy reach keeps a still, quiet shoulder line.
 */
function assistWithClavicle(pose, side, target) {
	const clavicle = `${side}Shoulder`;
	if (!hasBone(clavicle)) return;
	const shoulder = pose.worldPos(`${side}Arm`);
	const reach = boneLength(`${side}Arm`) + boneLength(`${side}ForeArm`);
	const distance = vLen(vSub(target, shoulder));
	const comfort = reach * 0.82;
	if (distance <= comfort) return;
	const assist = clamp((distance - comfort) / (reach * 0.45), 0, 1);

	// Aim the clavicle a fraction of the way from where it points to where the
	// target is, which both carries the socket toward the target and gives the
	// shoulder the rise a real reach has.
	const from = pose.worldDir(clavicle);
	const to = vNorm(vSub(target, pose.worldPos(clavicle)));
	const swing = qSlerp(IDENTITY, qBetween(from, to), assist * (MAX_CLAVICLE_ASSIST / 90));
	pose.setWorldQuat(clavicle, qMul(swing, pose.worldQuat(clavicle)));
}

/**
 * Place a `side` wrist at a world point with a natural elbow, then orient the
 * hand.
 *
 * The elbow lands on the circle of valid solutions, pushed toward `pole`. The
 * default drops it down, back, and slightly out, where a relaxed arm's elbow
 * actually sits; a raised elbow is something a motion asks for, never something
 * the solver does on its own.
 *
 * Roll is anatomical: the upper arm twists so the elbow flexes in the plane the
 * pole defines, and the forearm carries the pronation the palm direction
 * implies, so the wrist itself only ever holds the small residual.
 *
 * @param {import('./pose.js').Pose} pose mutated in place
 * @param {'Left'|'Right'} side
 * @param {{ wrist: number[], fingers?: number[], palm?: number[], pole?: number[], reach?: number, clavicle?: boolean }} spec
 *   `clavicle` defaults to true and lets the shoulder girdle assist a long
 *   reach; pass false when a caller is driving the clavicle itself.
 * @returns {import('./pose.js').Pose} the same pose
 */
export function solveArm(pose, side, spec) {
	const upper = `${side}Arm`;
	const lower = `${side}ForeArm`;
	const hand = `${side}Hand`;
	const outSign = side === 'Right' ? -1 : 1;
	const pole = spec.pole ?? [outSign * 0.42, -1, -0.3];

	if (spec.clavicle !== false) assistWithClavicle(pose, side, spec.wrist);

	const solved = solveTwoBone(
		pose,
		{ upper, lower, end: hand },
		spec.wrist,
		pole,
		spec.reach ?? 0.985,
	);

	// The direction the forearm swings toward as the elbow closes: the anterior
	// side of the arm. Falls back to the pole when the arm is nearly straight.
	let flexDir = vReject(solved.lowerDir, solved.upperDir);
	if (vLen(flexDir) < 1e-4) flexDir = vScale(solved.polePerp, -1);
	flexDir = vNorm(flexDir);

	// On this rest pose (arms out, palms down) elbow flexion carries the hand
	// toward its radial side, so that rest direction is the upper arm's flexion
	// reference. Measured, not assumed.
	const upperRefLocal = vNorm(qRotate(qConj(restWorld(upper)), restRadialWorld(side)));
	pose.setWorldQuat(upper, orientQuat(boneAxis(upper), upperRefLocal, solved.upperDir, flexDir));

	const palmTarget = spec.palm ? vNorm(spec.palm) : null;
	const lowerRefLocal = vNorm(qRotate(qConj(restWorld(lower)), restPalmWorld(side)));
	pose.setWorldQuat(
		lower,
		orientQuat(boneAxis(lower), lowerRefLocal, solved.lowerDir, palmTarget ?? flexDir),
	);

	const fingersDir = spec.fingers ? vNorm(spec.fingers) : solved.lowerDir;
	if (palmTarget) {
		pose.setWorldQuat(hand, orientQuat(boneAxis(hand), palmAxis(hand), fingersDir, palmTarget));
	} else {
		pose.aim(hand, fingersDir);
	}
	return pose;
}

/**
 * The measured direction a flat foot points at rest: forward and sloping down
 * from the ankle to the ball, in model space.
 */
export const FOOT_FLAT_DIR = Object.freeze(
	vNorm(vSub(restPos('LeftToeBase'), restPos('LeftFoot'))),
);

// Turn the flat-foot geometry into the two world directions the foot bone is
// oriented by: where the toe points, and which way the sole faces.
function footFrame(spec) {
	if (spec.toe && spec.sole) return { toe: vNorm(spec.toe), sole: vNorm(spec.sole) };
	const yaw = qAxisAngle(BODY_UP, spec.heading ?? 0);
	const flat = qRotate(yaw, FOOT_FLAT_DIR);
	const tilt = PLANT_TILT[spec.plant ?? 'flat'] ?? 0;
	// Roll about the foot's own across-axis, so a raised heel pitches the foot
	// forward rather than swinging it sideways.
	let across = vCross(BODY_UP, flat);
	if (vLen(across) < 1e-6) across = BODY_LEFT;
	const roll = qAxisAngle(across, tilt);
	return {
		toe: vNorm(spec.toe ?? qRotate(roll, flat)),
		sole: vNorm(spec.sole ?? qRotate(roll, vScale(BODY_UP, -1))),
	};
}

/**
 * How far the foot rolls off flat, in degrees, for each way of standing on it.
 * Positive tips the toe down, which is what raising the heel does.
 */
export const PLANT_TILT = Object.freeze({ flat: 0, toe: 26, heel: -22, lift: 12 });

/**
 * Place a `side` ankle at a world point with the knee bending forward, then set
 * the foot down.
 *
 * The foot's resting direction already slopes from ankle to toe, so a flat foot
 * is that measured direction turned by `heading`, not a horizontal one: aiming
 * the foot along the floor plane instead lifts the toe off the ground by the
 * height of the ankle, which is the single most visible thing wrong with a
 * naively solved leg.
 *
 * @param {import('./pose.js').Pose} pose mutated in place
 * @param {'Left'|'Right'} side
 * @param {{
 *   ankle: number[],
 *   heading?: number,
 *   plant?: 'flat'|'toe'|'heel'|'lift',
 *   toe?: number[],
 *   sole?: number[],
 *   pole?: number[],
 *   reach?: number,
 * }} spec  `heading` turns the foot in degrees toward the body's left; `plant`
 *   picks how it meets the floor. `toe`/`sole` override both with explicit world
 *   directions when a caller is driving the foot itself.
 * @returns {import('./pose.js').Pose} the same pose
 */
export function solveLeg(pose, side, spec) {
	const upper = `${side}UpLeg`;
	const lower = `${side}Leg`;
	const foot = `${side}Foot`;
	// The knee goes forward and very slightly outward. A knee pole that is purely
	// forward makes a deep squat look pigeon-toed.
	const outSign = side === 'Right' ? -1 : 1;
	const pole = spec.pole ?? vAdd(BODY_FORWARD, vScale(BODY_LEFT, outSign * -0.18));

	const solved = solveTwoBone(
		pose,
		{ upper, lower, end: foot },
		spec.ankle,
		pole,
		// Legs lock much straighter than arms: a standing pose should reproduce the
		// rig's own rest, and a visible knee bend at full extension reads as a limp.
		spec.reach ?? 0.9995,
	);

	let flexDir = vReject(solved.lowerDir, solved.upperDir);
	if (vLen(flexDir) < 1e-4) flexDir = vScale(solved.polePerp, -1);
	flexDir = vNorm(flexDir);

	// At rest the knee flexes toward the back of the leg, so the body's backward
	// direction is the thigh's flexion reference.
	const backLocal = vNorm(qRotate(qConj(restWorld(upper)), vScale(BODY_FORWARD, -1)));
	pose.setWorldQuat(upper, orientQuat(boneAxis(upper), backLocal, solved.upperDir, vScale(flexDir, -1)));

	const shinRefLocal = vNorm(qRotate(qConj(restWorld(lower)), vScale(BODY_FORWARD, -1)));
	pose.setWorldQuat(lower, orientQuat(boneAxis(lower), shinRefLocal, solved.lowerDir, vScale(flexDir, -1)));

	// The foot points down its toe; the sole normal resolves the roll. Both are
	// world directions, so a foot stays flat on the floor no matter what the leg
	// above it is doing, which is the whole point of solving the leg this way.
	const { toe: toeDir, sole: soleDir } = footFrame(spec);
	const footAxis = boneAxis(foot);
	const soleLocal = vNorm(qRotate(qConj(restWorld(foot)), vScale(BODY_UP, -1)));
	pose.setWorldQuat(foot, orientQuat(footAxis, soleLocal, toeDir, soleDir));
	return pose;
}

// ── spine, neck, and gaze ──────────────────────────────────────────────────

// A torso bend is shared out along the chain rather than slammed into one
// joint. Lower vertebrae take less: that is what makes a lean read as a spine
// and not as a hinge at the waist.
const SPINE_CHAIN = Object.freeze([
	{ bone: 'Hips', share: 0.12 },
	{ bone: 'Spine', share: 0.26 },
	{ bone: 'Spine1', share: 0.3 },
	{ bone: 'Spine2', share: 0.32 },
]);

/**
 * Bend, twist, and side-bend the torso, in degrees, distributed along the spine.
 *
 * @param {import('./pose.js').Pose} pose mutated in place
 * @param {{ lean?: number, twist?: number, sideBend?: number }} spec
 *   `lean` is positive forward, `twist` positive toward the body's left,
 *   `sideBend` positive leaning left.
 * @returns {import('./pose.js').Pose} the same pose
 */
export function solveSpine(pose, { lean = 0, twist = 0, sideBend = 0 } = {}) {
	if (!lean && !twist && !sideBend) return pose;
	// Rotating about the body's own axes rather than the world's keeps a twist
	// square to the shoulders even when the body has already turned.
	const leanAxis = BODY_LEFT;
	const twistAxis = BODY_UP;
	const bendAxis = BODY_FORWARD;
	for (const { bone, share } of SPINE_CHAIN) {
		if (!hasBone(bone)) continue;
		let world = pose.worldQuat(bone);
		if (lean) world = qMul(qAxisAngle(leanAxis, lean * share), world);
		if (twist) world = qMul(qAxisAngle(twistAxis, twist * share), world);
		if (sideBend) world = qMul(qAxisAngle(bendAxis, sideBend * share), world);
		pose.setWorldQuat(bone, world);
	}
	return pose;
}

/**
 * Turn the whole body about its vertical axis, from the root, so the legs and
 * arms below follow. Degrees, positive toward the body's left.
 */
export function solveTurn(pose, degrees) {
	if (!degrees) return pose;
	pose.setWorldQuat('Hips', qMul(qAxisAngle(BODY_UP, degrees), pose.worldQuat('Hips')));
	return pose;
}

// Neck takes the smaller half of a look: the head does most of it, which is how
// a person actually looks at something, and it keeps the chin off the chest.
const GAZE_CHAIN = Object.freeze([
	{ bone: 'Neck', share: 0.38 },
	{ bone: 'Head', share: 0.62 },
]);

/**
 * Look `yaw` degrees toward the body's left and `pitch` degrees up, relative to
 * wherever the chest ended up facing.
 *
 * @param {import('./pose.js').Pose} pose mutated in place
 * @param {{ yaw?: number, pitch?: number, roll?: number }} spec
 * @returns {import('./pose.js').Pose} the same pose
 */
export function solveGaze(pose, { yaw = 0, pitch = 0, roll = 0 } = {}) {
	if (!yaw && !pitch && !roll) return pose;
	// Yaw about the chest's own up, pitch about the chest's own left, so a look
	// stays level after the torso has leaned.
	const chest = hasBone('Spine2') ? 'Spine2' : 'Spine';
	const chestQ = pose.worldQuat(chest);
	const chestUp = vNorm(qRotate(chestQ, qRotate(qConj(restWorld(chest)), BODY_UP)));
	const chestLeft = vNorm(qRotate(chestQ, qRotate(qConj(restWorld(chest)), BODY_LEFT)));
	const chestForward = vNorm(vCross(chestUp, chestLeft));
	for (const { bone, share } of GAZE_CHAIN) {
		if (!hasBone(bone)) continue;
		let world = pose.worldQuat(bone);
		if (yaw) world = qMul(qAxisAngle(chestUp, yaw * share), world);
		// Negated: a positive rotation about the body's left tips a bone that
		// points UP forward, which is what a spine lean wants, and tips a gaze
		// that points FORWARD down, which is the opposite of what a look up means.
		if (pitch) world = qMul(qAxisAngle(chestLeft, -pitch * share), world);
		if (roll) world = qMul(qAxisAngle(chestForward, roll * share), world);
		pose.setWorldQuat(bone, world);
	}
	return pose;
}

/**
 * Where the head is looking under this pose: a unit world direction. Used to
 * check a solved gaze, and by callers that want to aim something else at what
 * the avatar is looking at.
 */
export function gazeDirection(pose) {
	const head = hasBone('Head') ? 'Head' : 'Neck';
	return vNorm(qRotate(pose.worldQuat(head), qRotate(qConj(restWorld(head)), BODY_FORWARD)));
}

// ── hands ──────────────────────────────────────────────────────────────────

export const FINGERS = Object.freeze(['Index', 'Middle', 'Ring', 'Pinky']);

/** The three phalanx bones of one finger, root to tip. */
export function fingerBones(side, finger) {
	return [1, 2, 3].map((j) => `${side}Hand${finger}${j}`);
}

/**
 * Curl a hand. `curl` closes every finger 0 (flat) to 1 (fist); `thumb` closes
 * the thumb independently; `spread` fans the fingers apart. A hand shape is
 * three numbers rather than twenty joint angles, because a motion score is
 * written by a language model and twenty joint angles is not something to write.
 *
 * @param {import('./pose.js').Pose} pose mutated in place
 * @param {'Left'|'Right'} side
 * @param {{ curl?: number, thumb?: number, spread?: number, only?: string[] }} spec
 *   `only` restricts the shaping to the named fingers, which is how a pointing
 *   hand is built: curl everything, then straighten the index back out.
 * @returns {import('./pose.js').Pose} the same pose
 */
export function shapeHand(pose, side, { curl = 0, thumb = null, spread = 0, only = null } = {}) {
	const closed = clamp(curl, 0, 1);
	const thumbClosed = clamp(thumb ?? closed * 0.75, 0, 1);
	const fan = clamp(spread, -1, 1);

	for (const finger of FINGERS) {
		if (only && !only.includes(finger)) continue;
		const bones = fingerBones(side, finger);
		if (!hasBone(bones[0])) continue;
		// Knuckle, middle, tip: the middle joint closes hardest, which is what
		// gives a curled hand its shape instead of three even bends.
		const perJoint = [72, 88, 62];
		const splayDeg = fan * (FINGERS.indexOf(finger) - 1.5) * 6;
		bones.forEach((bone, j) => {
			if (!hasBone(bone)) return;
			const curlAxis = radialAxis(bone);
			const splayAxis = palmAxis(bone);
			let q = only ? restLocal(bone) : pose.getLocal(bone);
			q = qMul(q, qAxisAngle(curlAxis, side === 'Right' ? -perJoint[j] * closed : perJoint[j] * closed));
			if (j === 0 && splayDeg) q = qMul(q, qAxisAngle(splayAxis, splayDeg));
			pose.setLocal(bone, q);
		});
	}

	if (only) return pose;

	// The thumb opposes across the palm rather than curling in the finger plane.
	const thumbBones = [1, 2, 3].map((j) => `${side}HandThumb${j}`);
	const thumbDeg = [42, 52, 38];
	thumbBones.forEach((bone, j) => {
		if (!hasBone(bone)) return;
		const axis = palmAxis(bone);
		pose.setLocal(
			bone,
			qMul(pose.getLocal(bone), qAxisAngle(axis, side === 'Right' ? thumbDeg[j] * thumbClosed : -thumbDeg[j] * thumbClosed)),
		);
	});
	return pose;
}

// ── measurements ───────────────────────────────────────────────────────────

/**
 * The support polygon's centre under this pose: the midpoint of whatever feet
 * are carrying weight, on the floor. The balance check compares the centre of
 * mass against it.
 */
export function supportCentre(pose, weights = { Left: 0.5, Right: 0.5 }) {
	const total = (weights.Left ?? 0) + (weights.Right ?? 0);
	if (total < 1e-6) return [pose.worldPos('Hips')[0], 0, pose.worldPos('Hips')[2]];
	const left = pose.worldPos('LeftFoot');
	const right = pose.worldPos('RightFoot');
	return [
		(left[0] * (weights.Left ?? 0) + right[0] * (weights.Right ?? 0)) / total,
		0,
		(left[2] * (weights.Left ?? 0) + right[2] * (weights.Right ?? 0)) / total,
	];
}

// Segment masses as a fraction of body mass, from the standard anthropometric
// table (Winter, Biomechanics and Motor Control of Human Movement). Enough of
// the body to place the centre of mass honestly without modelling every bone.
const MASS_SEGMENTS = Object.freeze([
	{ bone: 'Hips', mass: 0.142 },
	{ bone: 'Spine1', mass: 0.216 },
	{ bone: 'Spine2', mass: 0.139 },
	{ bone: 'Head', mass: 0.081 },
	{ bone: 'LeftArm', mass: 0.028 },
	{ bone: 'RightArm', mass: 0.028 },
	{ bone: 'LeftForeArm', mass: 0.022 },
	{ bone: 'RightForeArm', mass: 0.022 },
	{ bone: 'LeftUpLeg', mass: 0.1 },
	{ bone: 'RightUpLeg', mass: 0.1 },
	{ bone: 'LeftLeg', mass: 0.0465 },
	{ bone: 'RightLeg', mass: 0.0465 },
	{ bone: 'LeftFoot', mass: 0.0145 },
	{ bone: 'RightFoot', mass: 0.0145 },
]);

/**
 * The pose's centre of mass in model space, mass-weighted over the segments
 * that carry most of a body's weight.
 */
export function centreOfMass(pose) {
	let total = 0;
	let acc = [0, 0, 0];
	for (const { bone, mass } of MASS_SEGMENTS) {
		if (!hasBone(bone)) continue;
		acc = vAdd(acc, vScale(pose.worldPos(bone), mass));
		total += mass;
	}
	return total > 0 ? vScale(acc, 1 / total) : [0, 0, 0];
}

/**
 * How far the centre of mass sits outside the support base, in metres on the
 * floor plane. Zero means balanced. The score compiler uses it to nudge the
 * hips back over the feet, which is what stops a deep lean from looking like a
 * fall.
 */
export function balanceError(pose, weights) {
	const com = centreOfMass(pose);
	const support = supportCentre(pose, weights);
	return vLen([com[0] - support[0], 0, com[2] - support[2]]);
}

/** The horizontal offset from the support base to the centre of mass. */
export function balanceOffset(pose, weights) {
	const com = centreOfMass(pose);
	const support = supportCentre(pose, weights);
	return [com[0] - support[0], 0, com[2] - support[2]];
}

/** Where the `side` wrist actually landed: the reachability check tests assert on. */
export function wristPosition(pose, side) {
	return pose.worldPos(`${side}Hand`);
}

/** Where the `side` ankle actually landed. */
export function anklePosition(pose, side) {
	return pose.worldPos(`${side}Foot`);
}

/** The rest (bind) position of a bone, re-exported so callers need one import. */
export { restPos, vDot };
