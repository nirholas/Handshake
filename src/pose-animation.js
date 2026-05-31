// Keyframe animation core for the Animation Studio (/pose).
//
// This module is the pure, headless half of Task 2: it owns the editing
// document (keyframes over time), interpolates a pose at any playhead position
// (slerp rotations, lerp root translation), and bakes the result into a
// THREE.AnimationClip whose track names play everywhere on three.ws.
//
// It depends only on `three` (no DOM, no rig) so it is unit-testable in node —
// see tests/pose-animation.test.js. The studio (src/pose-studio.js) drives the
// live preview by calling sampleAtTime() each frame and rig.applyPose(); export
// calls bakeClip() / serializeClip().
//
// Pose shape (the Task 1 rig contract): { bones: { Canonical: [x,y,z,w], … },
// rootPosition: { x, y, z } }. Bones are keyed by CANONICAL names (Hips, Spine,
// LeftArm, …) so a clip baked here binds to standard three.ws avatars.

import {
	AnimationClip,
	Quaternion,
	QuaternionKeyframeTrack,
	VectorKeyframeTrack,
} from 'three';

// ── Easing ───────────────────────────────────────────────────────────────────
// Each easing maps a normalized segment fraction [0,1] → eased [0,1]. The easing
// of the OUTGOING keyframe governs the segment that follows it.
export const EASINGS = {
	linear: (t) => t,
	'ease-in': (t) => t * t,
	'ease-out': (t) => t * (2 - t),
	'ease-in-out': (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
};
export const DEFAULT_EASING = 'ease-in-out';

function easeFn(name) {
	return EASINGS[name] || EASINGS.linear;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── Editing document ───────────────────────────────────────────────────────
// The in-memory project Task 4 will serialize/save.
//   { name, duration /* s */, fps, loop, keyframes: [{ id, time, pose, easing }] }
let _kidSeq = 0;
function nextKeyframeId() {
	_kidSeq += 1;
	return `kf_${_kidSeq}`;
}

export function createDocument(overrides = {}) {
	return {
		name: 'animation',
		duration: 4,
		fps: 30,
		loop: true,
		keyframes: [],
		...overrides,
	};
}

function clonePose(pose) {
	if (!pose) return null;
	const bones = {};
	for (const [key, q] of Object.entries(pose.bones || {})) {
		bones[key] = [q[0], q[1], q[2], q[3]];
	}
	const rp = pose.rootPosition || { x: 0, y: 0, z: 0 };
	return { bones, rootPosition: { x: rp.x || 0, y: rp.y || 0, z: rp.z || 0 } };
}

function sortKeyframes(doc) {
	doc.keyframes.sort((a, b) => a.time - b.time);
	return doc;
}

// Two keyframes within this many seconds are treated as the same slot, so
// re-dropping at the current playhead updates rather than stacks.
const TIME_EPSILON = 1e-3;

/**
 * Capture `pose` at `time`. If a keyframe already sits at ~time, its pose (and
 * optionally easing) is updated; otherwise a new keyframe is inserted, sorted.
 * @returns the affected keyframe.
 */
export function upsertKeyframe(doc, time, pose, easing = DEFAULT_EASING) {
	const t = clamp(time, 0, doc.duration);
	const existing = doc.keyframes.find((k) => Math.abs(k.time - t) <= TIME_EPSILON);
	if (existing) {
		existing.pose = clonePose(pose);
		return existing;
	}
	const kf = { id: nextKeyframeId(), time: t, pose: clonePose(pose), easing };
	doc.keyframes.push(kf);
	sortKeyframes(doc);
	return kf;
}

export function removeKeyframe(doc, id) {
	const i = doc.keyframes.findIndex((k) => k.id === id);
	if (i === -1) return false;
	doc.keyframes.splice(i, 1);
	return true;
}

/** Retime a keyframe (drag-to-retime). Keeps the list sorted. */
export function moveKeyframe(doc, id, newTime) {
	const kf = doc.keyframes.find((k) => k.id === id);
	if (!kf) return null;
	kf.time = clamp(newTime, 0, doc.duration);
	sortKeyframes(doc);
	return kf;
}

export function setKeyframeEasing(doc, id, easing) {
	const kf = doc.keyframes.find((k) => k.id === id);
	if (kf && EASINGS[easing]) kf.easing = easing;
	return kf;
}

/** Clamp every keyframe to the (possibly shortened) duration. */
export function clampKeyframesToDuration(doc) {
	for (const kf of doc.keyframes) kf.time = clamp(kf.time, 0, doc.duration);
	sortKeyframes(doc);
	return doc;
}

// ── Interpolation ────────────────────────────────────────────────────────────
const _qa = new Quaternion();
const _qb = new Quaternion();
const _qOut = new Quaternion();

/**
 * Interpolated pose at `time` (seconds). Rotations slerp; root position lerps.
 * Returns null when there are no keyframes.
 */
export function sampleAtTime(doc, time) {
	const kfs = doc.keyframes;
	if (!kfs.length) return null;
	if (kfs.length === 1) return clonePose(kfs[0].pose);

	const t = clamp(time, 0, doc.duration);
	const first = kfs[0];
	const last = kfs[kfs.length - 1];
	if (t <= first.time) return clonePose(first.pose);
	if (t >= last.time) return clonePose(last.pose);

	let a = first;
	let b = last;
	for (let i = 0; i < kfs.length - 1; i++) {
		if (kfs[i].time <= t && t < kfs[i + 1].time) {
			a = kfs[i];
			b = kfs[i + 1];
			break;
		}
	}
	const span = b.time - a.time;
	let u = span > TIME_EPSILON ? (t - a.time) / span : 0;
	u = clamp(easeFn(a.easing)(u), 0, 1);

	const aBones = a.pose.bones || {};
	const bBones = b.pose.bones || {};
	const keys = new Set([...Object.keys(aBones), ...Object.keys(bBones)]);
	const bones = {};
	for (const key of keys) {
		const va = aBones[key] || bBones[key];
		const vb = bBones[key] || aBones[key];
		_qa.set(va[0], va[1], va[2], va[3]);
		_qb.set(vb[0], vb[1], vb[2], vb[3]);
		_qOut.copy(_qa).slerp(_qb, u);
		bones[key] = [_qOut.x, _qOut.y, _qOut.z, _qOut.w];
	}
	const ra = a.pose.rootPosition || { x: 0, y: 0, z: 0 };
	const rb = b.pose.rootPosition || { x: 0, y: 0, z: 0 };
	return {
		bones,
		rootPosition: {
			x: (ra.x || 0) + ((rb.x || 0) - (ra.x || 0)) * u,
			y: (ra.y || 0) + ((rb.y || 0) - (ra.y || 0)) * u,
			z: (ra.z || 0) + ((rb.z || 0) - (ra.z || 0)) * u,
		},
	};
}

// ── Baking to a THREE.AnimationClip ────────────────────────────────────────
// We RESAMPLE the document at `fps` and emit linear/slerp tracks. Resampling
// bakes per-keyframe easing into the samples, so the exported clip reproduces
// the exact eased timing under any standard player (AnimationMixer slerps the
// quaternion track), with no easing metadata to carry around.

function uniqueBoneKeys(doc) {
	const keys = new Set();
	for (const kf of doc.keyframes) {
		for (const k of Object.keys(kf.pose?.bones || {})) keys.add(k);
	}
	return keys;
}

function sampleTimes(duration, fps) {
	const safeFps = clamp(Math.round(fps) || 30, 1, 120);
	const dt = 1 / safeFps;
	const times = [];
	for (let t = 0; t < duration - 1e-6; t += dt) times.push(Number(t.toFixed(6)));
	times.push(Number(Math.max(duration, dt).toFixed(6)));
	return times;
}

/**
 * Bake the document into a THREE.AnimationClip.
 *
 * @param {object} doc                       the editing document
 * @param {object} [opts]
 * @param {(canonicalKey:string)=>string|null} [opts.resolveBoneName]
 *        Maps a canonical bone key to the emitted track bone name. Default:
 *        identity (canonical names — the cross-platform three.ws clip). Pass a
 *        function returning the live rig's actual node names to bake a clip that
 *        binds to a specific GLB/mannequin scene for GLB embedding.
 * @param {string} [opts.rootName='Hips']    bone name for the root position track
 * @returns {THREE.AnimationClip}
 */
export function bakeClip(doc, { resolveBoneName = (k) => k, rootName = 'Hips' } = {}) {
	if (!doc.keyframes.length) {
		throw new Error('Add at least one keyframe before baking an animation.');
	}
	const duration = Math.max(doc.duration, 1 / clamp(doc.fps || 30, 1, 120));
	const times = sampleTimes(duration, doc.fps);
	const samples = times.map((t) => sampleAtTime(doc, t));

	const tracks = [];
	for (const key of uniqueBoneKeys(doc)) {
		const trackBone = resolveBoneName(key);
		if (!trackBone) continue;
		const values = new Float32Array(samples.length * 4);
		for (let i = 0; i < samples.length; i++) {
			const q = samples[i].bones[key] || [0, 0, 0, 1];
			values[i * 4] = q[0];
			values[i * 4 + 1] = q[1];
			values[i * 4 + 2] = q[2];
			values[i * 4 + 3] = q[3];
		}
		tracks.push(new QuaternionKeyframeTrack(`${trackBone}.quaternion`, times, values));
	}

	if (rootName) {
		const posValues = new Float32Array(samples.length * 3);
		for (let i = 0; i < samples.length; i++) {
			const p = samples[i].rootPosition || { x: 0, y: 0, z: 0 };
			posValues[i * 3] = p.x || 0;
			posValues[i * 3 + 1] = p.y || 0;
			posValues[i * 3 + 2] = p.z || 0;
		}
		tracks.push(new VectorKeyframeTrack(`${rootName}.position`, times, posValues));
	}

	const clip = new AnimationClip(doc.name || 'animation', duration, tracks);
	clip.resetDuration();
	clip.optimize();
	return clip;
}

/** Bake + return the documented clip-JSON shape ({ name, duration, tracks }). */
export function serializeClip(doc, opts) {
	return AnimationClip.toJSON(bakeClip(doc, opts));
}
