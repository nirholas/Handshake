// Poses on a clock, compiled to an AnimationClip document.
//
// The output is exactly what `THREE.AnimationClip.toJSON()` produces, because
// that is what the rest of the platform already speaks: the clip library, the
// retargeter, the animation studio, and the GLB exporter all take this shape,
// so a synthesized motion is indistinguishable from a captured one from the
// moment it leaves here.
//
// Three things happen on the way out that a naive keyframe dump would miss.
//
// Easing is baked as extra samples, because a mixer slerps between quaternion
// keys linearly: an ease named in the score has to exist as geometry in the
// track or it is not there at all.
//
// A long hold is subdivided, so the idle layer below is sampled smoothly
// through it instead of aliasing into a twitch at each end.
//
// The idle layer itself is breathing and micro-sway, scaled down as the motion
// gets more sudden. It is small enough to read as life rather than as motion,
// and it is the difference between a performance and a mannequin changing shape.

import { blendPose, restPose } from './rig/pose.js';
import { qAxisAngle, qMul } from './rig/math.js';
import { CANONICAL_BONES, restPos } from './rig/skeleton.js';
import { EASES, EXPRESSION_SHAPES } from './vocabulary.js';

/** three.js NormalAnimationBlendMode, stated so nothing has to import three. */
const NORMAL_BLEND_MODE = 2500;

/** Interpolated keys inside each transition, so an ease survives linear slerp. */
const EASE_SAMPLES = 3;

/** Longest gap between keys, so the idle layer is sampled rather than aliased. */
const MAX_KEY_GAP = 0.28;

/** Breathing, in degrees, over a slow cycle. */
const BREATH = Object.freeze({ period: 4.4, chest: 0.9, neck: 0.5, sway: 0.35 });

/**
 * The bones a motion clip always drives, whatever the score touched. Emitting
 * the full set means merging or crossfading two clips can never strand a bone
 * at whatever the previous one left it holding.
 */
export const MOTION_BONES = Object.freeze(CANONICAL_BONES.filter((b) => !/Hand(Index|Middle|Ring|Pinky|Thumb)/.test(b)));

/**
 * Compile solved keys into a clip document.
 *
 * @param {{ time: number, pose: import('./rig/pose.js').Pose, beat: object }[]} keys
 * @param {{
 *   name: string,
 *   seed?: string,
 *   loop?: boolean,
 *   idle?: boolean,
 *   rootMotion?: boolean,
 *   fingers?: boolean,
 * }} opts
 * @returns {object} an AnimationClip.toJSON() document
 */
export function buildClip(keys, opts) {
	const {
		name,
		seed,
		loop = false,
		idle = true,
		rootMotion = true,
		fingers = true,
	} = opts;
	if (!keys.length) throw new Error('buildClip: no keys');

	const timed = expand(keys, loop);
	const dense = densify(timed, MAX_KEY_GAP);
	const times = dense.map((k) => k.time);

	const driven = new Set(MOTION_BONES);
	for (const key of dense) for (const bone of key.pose.local.keys()) driven.add(bone);
	if (!fingers) {
		for (const bone of [...driven]) {
			if (/Hand(Index|Middle|Ring|Pinky|Thumb)/.test(bone)) driven.delete(bone);
		}
	}

	const tracks = [];
	for (const bone of [...driven].sort()) {
		const values = [];
		for (const key of dense) {
			let q = key.pose.getLocal(bone);
			if (idle) q = breathe(bone, q, key.time, key.idle);
			values.push(q[0], q[1], q[2], q[3]);
		}
		tracks.push({ type: 'quaternion', name: `${bone}.quaternion`, times: [...times], values });
	}

	if (rootMotion && dense.some((k) => k.pose.rootOffset.some((n) => Math.abs(n) > 1e-6))) {
		const base = restPos('Hips');
		const values = [];
		for (const key of dense) {
			values.push(
				base[0] + key.pose.rootOffset[0],
				base[1] + key.pose.rootOffset[1],
				base[2] + key.pose.rootOffset[2],
			);
		}
		tracks.push({ type: 'vector', name: 'Hips.position', times: [...times], values });
	}

	// Face lanes, only for shapes this clip actually uses, and always driven to
	// zero where they are not: an expression from an early beat must not stick to
	// the face for the rest of the motion.
	const usedShapes = new Set();
	for (const key of dense) for (const shape of key.pose.face.keys()) usedShapes.add(shape);
	for (const shape of EXPRESSION_SHAPES) {
		if (!usedShapes.has(shape)) continue;
		tracks.push({
			type: 'number',
			name: `Face.morphTargetInfluences[${shape}]`,
			times: [...times],
			values: dense.map((k) => k.pose.getFace(shape)),
		});
	}

	return {
		name,
		duration: times[times.length - 1],
		tracks,
		uuid: stableUuid(seed ?? name),
		blendMode: NORMAL_BLEND_MODE,
	};
}

// Turn beat keys into a full key list: a travel with baked easing into each
// beat, a hold after it, and a closing travel back to the first beat when the
// score loops.
function expand(keys, loop) {
	const out = [];
	let previous = null;
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		const beat = key.beat ?? {};
		const idle = idleScale(beat);
		const travel = beat.in ?? 0;
		const start = Math.max(0, key.time - travel);
		if (previous && travel > 0) {
			const curve = EASES[beat.ease] ?? EASES.smooth;
			for (let s = 1; s <= EASE_SAMPLES; s++) {
				const u = s / (EASE_SAMPLES + 1);
				out.push({
					time: start + travel * u,
					pose: blendPose(previous.pose, key.pose, curve(u)),
					idle,
				});
			}
		}
		out.push({ time: key.time, pose: key.pose, idle });
		if (beat.hold > 0) out.push({ time: key.time + beat.hold, pose: key.pose, idle });
		previous = { pose: key.pose };
	}

	if (loop && keys.length > 1) {
		const first = keys[0];
		const last = out[out.length - 1];
		const back = first.beat?.in ?? 0.4;
		const curve = EASES[first.beat?.ease] ?? EASES.smooth;
		const idle = idleScale(first.beat ?? {});
		for (let s = 1; s <= EASE_SAMPLES; s++) {
			const u = s / (EASE_SAMPLES + 1);
			out.push({
				time: last.time + back * u,
				pose: blendPose(last.pose, first.pose, curve(u)),
				idle,
			});
		}
		out.push({ time: last.time + back, pose: first.pose, idle });
	}

	// Times must be strictly increasing for a mixer to interpolate them.
	let last = -1;
	for (const key of out) {
		if (key.time <= last) key.time = last + 1e-4;
		last = key.time;
	}
	if (out[0].time > 0) out.unshift({ time: 0, pose: out[0].pose, idle: out[0].idle });
	return out;
}

// A sudden, bound motion has no room for breathing; a sustained one is mostly
// breathing. The idle layer scales with how unhurried the beat is.
function idleScale(beat) {
	const effort = beat.effort;
	if (!effort) return 1;
	return Math.max(0.15, 1 - effort.time * 0.85);
}

/** Insert interpolated keys so no gap exceeds `maxGap` seconds. */
function densify(keys, maxGap) {
	const out = [keys[0]];
	for (let i = 1; i < keys.length; i++) {
		const prev = keys[i - 1];
		const next = keys[i];
		const span = next.time - prev.time;
		const steps = Math.ceil(span / maxGap);
		for (let s = 1; s < steps; s++) {
			const u = s / steps;
			out.push({
				time: prev.time + span * u,
				pose: blendPose(prev.pose, next.pose, u),
				idle: prev.idle + (next.idle - prev.idle) * u,
			});
		}
		out.push(next);
	}
	return out;
}

// Breathing and micro-sway, layered on top of the authored pose.
function breathe(bone, q, time, scale = 1) {
	if (scale <= 0) return q;
	const phase = (time / BREATH.period) * Math.PI * 2;
	if (bone === 'Spine1') return qMul(q, qAxisAngle([1, 0, 0], Math.sin(phase) * BREATH.chest * scale));
	if (bone === 'Spine2') return qMul(q, qAxisAngle([0, 1, 0], Math.sin(phase * 0.5) * BREATH.sway * scale));
	if (bone === 'Neck') return qMul(q, qAxisAngle([1, 0, 0], -Math.sin(phase) * BREATH.neck * scale));
	if (bone === 'Head') return qMul(q, qAxisAngle([0, 1, 0], Math.sin(phase * 0.37) * BREATH.sway * scale));
	return q;
}

/**
 * A uuid derived from a seed, so the same score always compiles to the same
 * document, byte for byte. Deterministic output is what makes a motion cacheable
 * and a regression diffable.
 * @param {string} seed
 * @returns {string}
 */
export function stableUuid(seed) {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < seed.length; i++) {
		h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
		h2 = Math.imul((h2 + seed.charCodeAt(i)) ^ (h1 >>> 5), 0x85ebca6b) >>> 0;
	}
	const hex = (n) => n.toString(16).padStart(8, '0');
	const full = hex(h1) + hex(h2) + hex((h1 ^ 0x9e3779b9) >>> 0) + hex((h2 ^ 0x7f4a7c15) >>> 0);
	return `${full.slice(0, 8)}-${full.slice(8, 12)}-${full.slice(12, 16)}-${full.slice(16, 20)}-${full.slice(20, 32)}`.toUpperCase();
}

/** An empty clip at the rest pose: what a caller gets for a score with nothing in it. */
export function restClip(name) {
	return buildClip([{ time: 0, pose: restPose(), beat: {} }], { name, idle: false, rootMotion: false });
}
