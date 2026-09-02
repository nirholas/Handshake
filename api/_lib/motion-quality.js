// @ts-check
// Automated quality gate for generated motion clips.
//
// The text-to-motion lane (workers/model-text2motion, reached through
// POST /api/forge-motion) samples a motion diffusion model, so its output is a
// distribution, not a guarantee: a prompt can come back frozen in bind pose,
// torn by a single-frame discontinuity, or "walking" with both feet skating
// across the floor. None of those may reach the public library, and none of
// them is visible from the clip's metadata. This module decides, from the clip
// JSON alone, whether a generated clip is good enough to publish beside the
// curated Mixamo catalog.
//
// It is deliberately deterministic and dependency-free: no GPU, no renderer,
// no model call. Every check is arithmetic over the keyframes, so the same
// verdict is reachable from the seeding cron, from the batch runner on a
// workstation, and from a unit test.
//
// The interesting check is FOOT SLIDE, and it is measured rather than guessed.
// src/animation-canonical-rest.js carries the reference rig completely: every
// canonical bone's world bind rotation, its world rest position, and its
// parent. That is enough to run forward kinematics on each frame of the clip
// and put the feet in world space, root translation included. A correct walk
// plants a foot and lets the world carry it backwards; a skating walk drags
// the planted foot. The gate measures the drift of each foot across the frames
// it is actually in contact with the ground and rejects on the worst span.
//
// Thresholds are calibrated against the curated library rather than invented:
// a generated clip is held to the standard the Mixamo clips already meet, so
// the gate can never reject motion that the platform itself ships. See
// scripts/gcp/calibrate-motion-gate.mjs, which replays this module over both
// catalogs and prints the distributions the bounds below are drawn from.

import {
	CANONICAL_PARENT,
	CANONICAL_REST_POSITION,
	CANONICAL_REST_WORLD,
} from '../../src/animation-canonical-rest.js';
import { worldMotionMetrics, footContactMetrics } from './motion-seed.js';

export const MOTION_GATE_VERSION = 2;

/**
 * Every bound the gate enforces, in one frozen object so a caller (or a report)
 * can name the rule it tripped without reading the code.
 */
export const MOTION_BOUNDS = Object.freeze({
	// Structure.
	minDurationSeconds: 0.8,
	maxDurationSeconds: 12,
	minFrames: 12,
	maxFrames: 1800,
	minRotationTracks: 12,
	// How far the delivered clip may miss the requested length. The sampler
	// rounds to whole frames, so this is loose on purpose; it exists to catch a
	// lane that silently returned somebody else's clip.
	durationTolerance: 0.35,
	// A quaternion track whose keys are not unit length will be renormalised by
	// three.js and silently change the pose, so refuse it here instead.
	quatNormTolerance: 0.05,

	// Motion content.
	// Averaged angular speed across every rotation track. A clip below this is
	// standing in bind pose: technically valid, worthless in a library.
	minMeanAngularSpeedDeg: 5,
	// Largest single-frame WORLD step of a witness joint, over that joint's own
	// p95 step. Measured on local rotations instead, this test cannot work: the
	// sampler emits a 180 degree twist about a bone's own axis that the child
	// bone cancels, which is invisible on the mesh but maxes out any local
	// angular bound, and the authored library itself reaches 121 degrees in a
	// single frame. A local threshold therefore rejects real motion and genuine
	// tears alike (measured: 100% of generated clips and 66% of the authored
	// library). Judging joint POSITIONS separates them. Authored clips score a
	// median of 1.69 and a worst case of 5.79, so 6.5 leaves headroom.
	// See docs/animation-seeding.md.
	maxWorldStepRatio: 6.5,
	// Loop clips only: the pose distance between the first and last frame. A
	// seam wider than this visibly pops every cycle.
	maxLoopSeamDeg: 30,

	// Space.
	// Planted-foot drift as a multiple of the stride the clip actually covers,
	// counting only frames where a foot is on this clip's own floor AND the hips
	// are upright over it. Without the upright test, floor work (a fall, a crawl,
	// a breakdance flair) reads as skating because the "lower" foot is merely the
	// one that happens to be less high.
	maxSlidePerStride: 0.85,
	// A foot below the ground plane by more than this (metres) is clipping
	// through the floor.
	maxGroundPenetration: 0.15,
	// Hips translation speed. The diffusion model occasionally launches the root.
	maxRootSpeedMetresPerSecond: 6,
});

/**
 * Bones a humanoid clip must drive to be worth publishing. Fingers are not
 * required: the text-to-motion lane emits a 22-joint SMPL body and the retarget
 * engine leaves unlisted bones at rest, which is correct.
 */
export const REQUIRED_BONES = Object.freeze([
	'Hips',
	'Spine',
	'Head',
	'LeftArm',
	'LeftForeArm',
	'RightArm',
	'RightForeArm',
	'LeftUpLeg',
	'LeftLeg',
	'LeftFoot',
	'RightUpLeg',
	'RightLeg',
	'RightFoot',
]);

// ── Quaternion / vector helpers ──────────────────────────────────────────────
// [x, y, z, w] throughout, matching three.js and the clip JSON.

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

function qConjugate(q) {
	return [-q[0], -q[1], -q[2], q[3]];
}

function qRotate(q, v) {
	// v' = q * (v, 0) * q⁻¹, expanded to avoid two full quaternion products.
	const [x, y, z, w] = q;
	const [vx, vy, vz] = v;
	const tx = 2 * (y * vz - z * vy);
	const ty = 2 * (z * vx - x * vz);
	const tz = 2 * (x * vy - y * vx);
	return [
		vx + w * tx + y * tz - z * ty,
		vy + w * ty + z * tx - x * tz,
		vz + w * tz + x * ty - y * tx,
	];
}

/** Shortest rotation angle between two unit quaternions, in degrees. */
function qAngleDeg(a, b) {
	const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
	return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

function qNorm(q) {
	return Math.hypot(q[0], q[1], q[2], q[3]);
}

const IDENTITY_Q = [0, 0, 0, 1];

// ── Reference skeleton ───────────────────────────────────────────────────────

/**
 * Local rest offset of each bone in its parent's bind frame, derived once from
 * the reference rig. Forward kinematics needs the offset in the parent's local
 * space, while the generated table stores world rest positions, so each is
 * rotated back through the parent's world bind rotation.
 */
const LOCAL_REST_OFFSET = (() => {
	/** @type {Record<string, number[]>} */
	const out = {};
	for (const [bone, parent] of Object.entries(CANONICAL_PARENT)) {
		const here = CANONICAL_REST_POSITION[bone];
		if (!here) continue;
		if (!parent) {
			out[bone] = [...here];
			continue;
		}
		const up = CANONICAL_REST_POSITION[parent];
		if (!up) continue;
		const parentWorld = CANONICAL_REST_WORLD[parent] || IDENTITY_Q;
		out[bone] = qRotate(qConjugate(parentWorld), [
			here[0] - up[0],
			here[1] - up[1],
			here[2] - up[2],
		]);
	}
	return Object.freeze(out);
})();

/** Hip height of the reference rig, the scale every distance is reported in. */
export const REFERENCE_HIP_HEIGHT = CANONICAL_REST_POSITION.Hips?.[1] || 1;

/** Ground plane: the lowest rest point of the reference rig's feet. */
const REST_FLOOR_Y = Math.min(
	CANONICAL_REST_POSITION.LeftToeBase?.[1] ?? CANONICAL_REST_POSITION.LeftFoot?.[1] ?? 0,
	CANONICAL_REST_POSITION.RightToeBase?.[1] ?? CANONICAL_REST_POSITION.RightFoot?.[1] ?? 0,
);

// Walk the parents first so a single pass can compose world transforms.
const FK_ORDER = (() => {
	const seen = new Set();
	/** @type {string[]} */
	const order = [];
	const visit = (bone) => {
		if (seen.has(bone) || !(bone in CANONICAL_PARENT)) return;
		seen.add(bone);
		const parent = CANONICAL_PARENT[bone];
		if (parent) visit(parent);
		order.push(bone);
	};
	for (const bone of Object.keys(CANONICAL_PARENT)) visit(bone);
	return Object.freeze(order.filter((b) => LOCAL_REST_OFFSET[b]));
})();

// ── Clip parsing ─────────────────────────────────────────────────────────────

/**
 * A structural problem the gate could not look past: the clip is not a clip.
 * Thrown only by readClip; every quality verdict comes back as data.
 */
export class MotionClipShapeError extends Error {}

/**
 * Normalise a three.js AnimationClip JSON into the sampled form the checks
 * work on: one quaternion per bone per frame plus the root translation.
 *
 * The clip's tracks are keyframed independently, so the checks resample every
 * track onto the union of its own key times. The text-to-motion lane emits all
 * tracks on one uniform time base, and so does the Mixamo bake, so in practice
 * this is a straight read; the nearest-key lookup only matters for a clip
 * authored elsewhere.
 *
 * @param {unknown} raw
 * @returns {{ name: string, duration: number, frames: number, times: number[],
 *   rotations: Record<string, number[][]>, rootPositions: number[][] | null,
 *   trackNames: string[], rotationTrackCount: number }}
 */
export function readClip(raw) {
	if (!raw || typeof raw !== 'object') throw new MotionClipShapeError('clip is not an object');
	const clip = /** @type {any} */ (raw);
	const tracks = Array.isArray(clip.tracks) ? clip.tracks : null;
	if (!tracks || tracks.length === 0) throw new MotionClipShapeError('clip carries no tracks');

	/** @type {Record<string, number[][]>} */
	const rotations = {};
	/** @type {number[][] | null} */
	let rootPositions = null;
	/** @type {number[] | null} */
	let times = null;
	const trackNames = [];
	let rotationTrackCount = 0;

	for (const track of tracks) {
		const name = typeof track?.name === 'string' ? track.name : '';
		const keyTimes = Array.isArray(track?.times) ? track.times.map(Number) : null;
		const values = Array.isArray(track?.values) ? track.values.map(Number) : null;
		if (!name || !keyTimes || !values) {
			throw new MotionClipShapeError(`track ${name || '(unnamed)'} is missing times or values`);
		}
		trackNames.push(name);

		const [bone, property] = splitTrackName(name);
		const stride = property === 'quaternion' ? 4 : 3;
		if (values.length !== keyTimes.length * stride) {
			throw new MotionClipShapeError(
				`track ${name} has ${values.length} values for ${keyTimes.length} keys at stride ${stride}`,
			);
		}
		const framesHere = [];
		for (let i = 0; i < keyTimes.length; i++) {
			framesHere.push(values.slice(i * stride, i * stride + stride));
		}
		if (property === 'quaternion') {
			rotations[bone] = framesHere;
			rotationTrackCount++;
			if (!times || keyTimes.length > times.length) times = keyTimes;
		} else if (property === 'position' && bone === 'Hips') {
			rootPositions = framesHere;
			if (!times) times = keyTimes;
		}
	}

	if (!times || times.length === 0) throw new MotionClipShapeError('clip has no keyframe times');
	if (rotationTrackCount === 0) throw new MotionClipShapeError('clip drives no rotations');

	const duration = Number(clip.duration);
	return {
		name: typeof clip.name === 'string' ? clip.name : '',
		duration: Number.isFinite(duration) ? duration : times[times.length - 1],
		frames: times.length,
		times,
		rotations,
		rootPositions,
		trackNames,
		rotationTrackCount,
	};
}

function splitTrackName(name) {
	const dot = name.lastIndexOf('.');
	return dot < 0 ? [name, ''] : [name.slice(0, dot), name.slice(dot + 1)];
}

// ── Forward kinematics ───────────────────────────────────────────────────────

/**
 * Place every reference bone in world space for one frame of the clip.
 * Bones the clip does not drive keep their bind rotation, exactly as the
 * retarget engine leaves them.
 *
 * @param {ReturnType<typeof readClip>} clip
 * @param {number} frame
 * @returns {{ positions: Record<string, number[]>, rotations: Record<string, number[]> }}
 */
export function poseAtFrame(clip, frame) {
	/** @type {Record<string, number[]>} */
	const positions = {};
	/** @type {Record<string, number[]>} */
	const worldRotations = {};

	const root = clip.rootPositions?.[Math.min(frame, clip.rootPositions.length - 1)] || null;

	for (const bone of FK_ORDER) {
		const parent = CANONICAL_PARENT[bone];
		const track = clip.rotations[bone];
		const local = track ? track[Math.min(frame, track.length - 1)] : null;
		const localQ = local && local.length === 4 ? local : CANONICAL_REST_WORLD[bone] && !parent ? IDENTITY_Q : IDENTITY_Q;

		if (!parent) {
			worldRotations[bone] = localQ;
			// Hips.position is the clip's root track when present; otherwise the
			// character stands at its rest hip position.
			positions[bone] = root ? [...root] : [...CANONICAL_REST_POSITION[bone]];
			continue;
		}
		const parentQ = worldRotations[parent] || IDENTITY_Q;
		const parentP = positions[parent] || [0, 0, 0];
		const offset = qRotate(parentQ, LOCAL_REST_OFFSET[bone]);
		positions[bone] = [parentP[0] + offset[0], parentP[1] + offset[1], parentP[2] + offset[2]];
		worldRotations[bone] = qMul(parentQ, localQ);
	}
	return { positions, rotations: worldRotations };
}

/**
 * Foot trajectories in world space, one entry per frame.
 * @param {ReturnType<typeof readClip>} clip
 */
function footTrajectories(clip) {
	const left = [];
	const right = [];
	for (let f = 0; f < clip.frames; f++) {
		const { positions } = poseAtFrame(clip, f);
		left.push(positions.LeftToeBase || positions.LeftFoot || [0, 0, 0]);
		right.push(positions.RightToeBase || positions.RightFoot || [0, 0, 0]);
	}
	return { left, right };
}

/**
 * Worst horizontal drift of a foot while it is planted, in metres.
 *
 * "Planted" is the frames where the foot sits in the lowest band of its own
 * vertical range: a walk cycle's stance phase, an idle's whole timeline. Drift
 * is measured per contiguous span, so a foot that lifts, travels and lands
 * again is not charged for the step it legitimately took.
 *
 * @param {number[][]} trajectory
 * @param {number} contactBand  metres above the foot's own minimum that still counts as contact
 */
function worstPlantedDrift(trajectory, contactBand) {
	if (trajectory.length < 2) return 0;
	let minY = Infinity;
	for (const p of trajectory) minY = Math.min(minY, p[1]);
	const ceiling = minY + contactBand;

	let worst = 0;
	/** @type {number[] | null} */
	let spanStart = null;
	let spanDrift = 0;
	/** @type {number[] | null} */
	let previous = null;

	for (const p of trajectory) {
		if (p[1] <= ceiling) {
			if (!spanStart) {
				spanStart = p;
				spanDrift = 0;
			} else if (previous) {
				spanDrift += Math.hypot(p[0] - previous[0], p[2] - previous[2]);
			}
			previous = p;
		} else {
			if (spanStart) worst = Math.max(worst, spanDrift);
			spanStart = null;
			previous = null;
			spanDrift = 0;
		}
	}
	if (spanStart) worst = Math.max(worst, spanDrift);
	return worst;
}

// ── Measurement ──────────────────────────────────────────────────────────────

/**
 * Every number the gate decides on. Exported separately from the verdict so the
 * calibration script can print distributions across a whole catalog without
 * re-deriving them.
 *
 * @param {ReturnType<typeof readClip>} clip
 */
export function measureClip(clip) {
	const fps = clip.frames > 1 ? (clip.frames - 1) / Math.max(clip.duration, 1e-6) : 0;

	let nonFinite = 0;
	let worstQuatNormError = 0;
	let timeRegressions = 0;
	for (let i = 1; i < clip.times.length; i++) {
		if (!(clip.times[i] > clip.times[i - 1])) timeRegressions++;
	}
	for (const t of clip.times) if (!Number.isFinite(t)) nonFinite++;

	let angularStepSum = 0;
	let angularStepCount = 0;
	let maxFrameStepDeg = 0;
	for (const frames of Object.values(clip.rotations)) {
		for (const q of frames) {
			for (const c of q) if (!Number.isFinite(c)) nonFinite++;
			worstQuatNormError = Math.max(worstQuatNormError, Math.abs(qNorm(q) - 1));
		}
		for (let i = 1; i < frames.length; i++) {
			const step = qAngleDeg(frames[i - 1], frames[i]);
			if (!Number.isFinite(step)) {
				nonFinite++;
				continue;
			}
			angularStepSum += step;
			angularStepCount++;
			maxFrameStepDeg = Math.max(maxFrameStepDeg, step);
		}
	}
	const meanStepDeg = angularStepCount ? angularStepSum / angularStepCount : 0;
	const meanAngularSpeedDeg = meanStepDeg * (fps || 0);

	// Loop seam: how far the last frame's pose is from the first across all
	// driven bones. Reported for every clip; only enforced on loops.
	let seamDeg = 0;
	for (const frames of Object.values(clip.rotations)) {
		if (frames.length < 2) continue;
		seamDeg = Math.max(seamDeg, qAngleDeg(frames[0], frames[frames.length - 1]));
	}

	let rootSpeed = 0;
	let rootTravel = 0;
	if (clip.rootPositions && clip.rootPositions.length > 1) {
		for (let i = 1; i < clip.rootPositions.length; i++) {
			const a = clip.rootPositions[i - 1];
			const b = clip.rootPositions[i];
			for (const c of b) if (!Number.isFinite(c)) nonFinite++;
			const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
			rootTravel += d;
			rootSpeed = Math.max(rootSpeed, d * (fps || 0));
		}
	}

	const { left, right } = footTrajectories(clip);
	const contactBand = REFERENCE_HIP_HEIGHT * 0.06;
	const footSlide = Math.max(
		worstPlantedDrift(left, contactBand),
		worstPlantedDrift(right, contactBand),
	);
	let lowestFootY = Infinity;
	for (const p of left) lowestFootY = Math.min(lowestFootY, p[1]);
	for (const p of right) lowestFootY = Math.min(lowestFootY, p[1]);

	return {
		frames: clip.frames,
		duration: clip.duration,
		fps,
		rotationTracks: clip.rotationTrackCount,
		hasRootTrack: !!clip.rootPositions,
		nonFinite,
		timeRegressions,
		worstQuatNormError,
		meanAngularSpeedDeg,
		maxFrameStepDeg,
		loopSeamDeg: seamDeg,
		rootTravelMetres: rootTravel,
		maxRootSpeedMetresPerSecond: rootSpeed,
		footSlideMetres: footSlide,
		footSlideRatio: footSlide / REFERENCE_HIP_HEIGHT,
		groundPenetrationMetres: Math.max(0, REST_FLOOR_Y - lowestFootY),
		missingBones: REQUIRED_BONES.filter((b) => !clip.rotations[b]),
	};
}

// ── Verdict ──────────────────────────────────────────────────────────────────

/**
 * Turn measurements into an accept/reject decision. Pure and synchronous: the
 * cron, the batch runner and the tests all reach the same verdict for a clip.
 *
 * @param {ReturnType<typeof measureClip>} m
 * @param {{ loop?: boolean, requestedDuration?: number|null, bounds?: typeof MOTION_BOUNDS }} [opts]
 * @returns {{ pass: boolean, reasons: string[] }}
 */
export function decideMotionVerdict(m, opts = {}) {
	const b = opts.bounds || MOTION_BOUNDS;
	const reasons = [];

	if (m.nonFinite > 0) reasons.push('non_finite_keyframes');
	if (m.timeRegressions > 0) reasons.push('times_not_increasing');
	if (m.frames < b.minFrames) reasons.push('too_few_frames');
	if (m.frames > b.maxFrames) reasons.push('too_many_frames');
	if (!(m.duration >= b.minDurationSeconds)) reasons.push('duration_too_short');
	if (m.duration > b.maxDurationSeconds) reasons.push('duration_too_long');
	if (m.rotationTracks < b.minRotationTracks) reasons.push('too_few_rotation_tracks');
	if (m.worstQuatNormError > b.quatNormTolerance) reasons.push('quaternions_not_normalized');
	if (m.missingBones.length) reasons.push('missing_required_bones');
	if (m.meanAngularSpeedDeg < b.minMeanAngularSpeedDeg) reasons.push('motion_too_still');
	if (m.worldStepRatio > b.maxWorldStepRatio) reasons.push('frame_discontinuity');
	if (m.maxRootSpeedMetresPerSecond > b.maxRootSpeedMetresPerSecond) reasons.push('root_velocity_implausible');
	if (m.slidePerStride > b.maxSlidePerStride) reasons.push('foot_slide');
	if (m.groundPenetrationMetres > b.maxGroundPenetration) reasons.push('ground_penetration');
	if (opts.loop && m.loopSeamDeg > b.maxLoopSeamDeg) reasons.push('loop_seam_open');

	const requested = Number(opts.requestedDuration);
	if (Number.isFinite(requested) && requested > 0) {
		const drift = Math.abs(m.duration - requested) / requested;
		if (drift > b.durationTolerance) reasons.push('duration_off_request');
	}

	return { pass: reasons.length === 0, reasons };
}

/**
 * The whole gate: parse, measure, decide. A clip whose shape cannot be read is
 * a reject with the structural reason attached rather than a thrown error, so a
 * batch never dies on one malformed response.
 *
 * @param {unknown} raw  the clip JSON as served by the worker
 * @param {{ loop?: boolean, requestedDuration?: number|null, bounds?: typeof MOTION_BOUNDS }} [opts]
 */
export function gateMotionClip(raw, opts = {}) {
	let clip;
	try {
		clip = readClip(raw);
	} catch (err) {
		return {
			pass: false,
			reasons: ['unreadable_clip'],
			detail: err instanceof Error ? err.message : String(err),
			metrics: null,
			gateVersion: MOTION_GATE_VERSION,
		};
	}
	const metrics = measureClip(clip);
	// World-space smoothness, liveliness and foot contact, measured on the raw
	// clip by the shared forward-kinematics implementation in motion-seed.js.
	// These are what a viewer actually sees, so they carry the two rules that a
	// local-rotation measure gets wrong.
	const world = worldMotionMetrics(raw);
	const foot = footContactMetrics(raw);
	metrics.worldStepRatio = world.continuity;
	metrics.worldTravelMetres = world.travel;
	metrics.worstWitnessJoint = world.continuityJoint;
	metrics.slidePerStride = foot.slidePerStride;
	metrics.plantedFrames = foot.plantedFrames;
	const { pass, reasons } = decideMotionVerdict(metrics, opts);
	return { pass, reasons, detail: '', metrics, gateVersion: MOTION_GATE_VERSION };
}

/** One human sentence per reason, for the reject sidecar and the batch report. */
export const MOTION_GATE_RULES = Object.freeze({
	unreadable_clip: 'the response was not a readable three.js AnimationClip',
	non_finite_keyframes: 'a keyframe carried NaN or Infinity',
	times_not_increasing: 'keyframe times did not advance monotonically',
	too_few_frames: 'too few keyframes to read as motion',
	too_many_frames: 'more keyframes than any library clip should carry',
	duration_too_short: 'shorter than the shortest useful library clip',
	duration_too_long: 'longer than the library ceiling',
	too_few_rotation_tracks: 'drives too few bones to animate a humanoid',
	quaternions_not_normalized: 'rotation keys are not unit quaternions',
	missing_required_bones: 'a required humanoid bone has no track',
	motion_too_still: 'the character barely moves; effectively a bind pose',
	frame_discontinuity: 'a single frame jumps further than a body can rotate',
	root_velocity_implausible: 'the root translates faster than a body can travel',
	foot_slide: 'a planted foot skates across the floor',
	ground_penetration: 'a foot sinks through the ground plane',
	loop_seam_open: 'the loop pops because the last frame does not meet the first',
	duration_off_request: 'the delivered length does not match what was requested',
});

/** @param {string[]} reasons */
export function explainMotionGate(reasons) {
	return reasons.map((r) => MOTION_GATE_RULES[r] || r);
}
