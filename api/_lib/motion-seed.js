// @ts-check
// Motion seeding: turn a text prompt from data/motion-prompts.json into a clip
// the animation library can serve, and refuse the ones that would embarrass us.
//
// The text2motion worker (workers/model-text2motion) already returns a three.js
// AnimationClip JSON on the canonical Wolf3D skeleton, so no format conversion
// is needed: a generated clip's track names are a strict subset of the Mixamo
// library's (the 23 body bones, no finger bones). What IS needed is a gate.
// A motion-diffusion sampler fails in ways that look fine in JSON and terrible
// on a rig: a frozen clip with no motion, a limb that snaps a full turn between
// two frames, a "walk" whose planted foot slides across the floor, quaternions
// that drifted off the unit sphere, a NaN that turns the whole avatar inside
// out. Every one of those is measurable here, before anything is published.
//
// The foot-slide check is real forward kinematics, not a heuristic on the hips:
// CANONICAL_REST_POSITION + CANONICAL_PARENT + CANONICAL_REST_WORLD
// (src/animation-canonical-rest.js, generated from the reference rig) are enough
// to replay a clip's world-space joint positions frame by frame. We find the
// planted foot per frame (the lower toe), measure how far it travels across the
// floor while planted, and compare that against the stride the clip actually
// covers. A clip whose planted foot outruns its own stride is skating.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
	CANONICAL_REST,
	CANONICAL_REST_WORLD,
	CANONICAL_REST_POSITION,
	CANONICAL_PARENT,
} from '../../src/animation-canonical-rest.js';

const PROMPTS_PATH = fileURLToPath(new URL('../../data/motion-prompts.json', import.meta.url));

/** The prompt library is data, never a hardcoded list (work order B6). */
function loadPromptLibrary() {
	const parsed = JSON.parse(readFileSync(PROMPTS_PATH, 'utf8'));
	const prompts = Array.isArray(parsed?.prompts) ? parsed.prompts : [];
	return Object.freeze({
		version: parsed?.version ?? null,
		defaults: Object.freeze(parsed?.defaults ?? {}),
		categories: Object.freeze(parsed?.categories ?? {}),
		prompts: Object.freeze(prompts.map((p) => Object.freeze({ ...p }))),
	});
}

let cachedLibrary = null;
export function motionPromptLibrary() {
	if (!cachedLibrary) cachedLibrary = loadPromptLibrary();
	return cachedLibrary;
}
export function motionPrompts() {
	return motionPromptLibrary().prompts;
}
export function motionPromptById(id) {
	return motionPrompts().find((p) => p.id === id) ?? null;
}

// Generated clips carry their own prefix so the library, the gallery and every
// report can tell a sampled clip from the `mx-` Mixamo import at a glance.
export const GENERATED_PREFIX = 'gen-';
export const GENERATED_CLIP_DIR = 'animations/library/clips/';
export const LIBRARY_MANIFEST_KEY = 'animations/library/manifest.json';

/** Stable, collision-free clip name: gen-<prompt id>-<12 hex of the task id>. */
export function libraryClipName(promptId, taskId) {
	const slug = String(promptId)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 48);
	const hash = createHash('sha256').update(String(taskId)).digest('hex').slice(0, 12);
	return `${GENERATED_PREFIX}${slug}-${hash}`;
}

export function isGeneratedClipName(name) {
	return typeof name === 'string' && name.startsWith(GENERATED_PREFIX);
}

// ── Minimal quaternion / vector math ────────────────────────────────────────
// Four operations on 4 floats each. three.js is a browser dependency and far
// too heavy to pull into a cron for this, and a dependency for four functions
// is the kind of thing CLAUDE.md tells us to just write.

function quatMul(a, b) {
	const [ax, ay, az, aw] = a;
	const [bx, by, bz, bw] = b;
	return [
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz,
	];
}

function quatConjugate(q) {
	return [-q[0], -q[1], -q[2], q[3]];
}

function quatApply(q, v) {
	const [qx, qy, qz, qw] = q;
	const [vx, vy, vz] = v;
	// t = 2 * cross(q.xyz, v); v' = v + qw * t + cross(q.xyz, t)
	const tx = 2 * (qy * vz - qz * vy);
	const ty = 2 * (qz * vx - qx * vz);
	const tz = 2 * (qx * vy - qy * vx);
	return [
		vx + qw * tx + (qy * tz - qz * ty),
		vy + qw * ty + (qz * tx - qx * tz),
		vz + qw * tz + (qx * ty - qy * tx),
	];
}

function quatLength(q) {
	return Math.hypot(q[0], q[1], q[2], q[3]);
}

/** Angle in radians between two unit quaternions, sign-insensitive (q and -q are the same rotation). */
function quatAngleBetween(a, b) {
	const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
	return 2 * Math.acos(Math.min(1, dot));
}

// ── Clip access ─────────────────────────────────────────────────────────────

function tracksByName(clip) {
	const map = new Map();
	for (const track of clip?.tracks ?? []) {
		if (track && typeof track.name === 'string') map.set(track.name, track);
	}
	return map;
}

function boneOf(trackName) {
	const dot = trackName.lastIndexOf('.');
	return dot === -1 ? trackName : trackName.slice(0, dot);
}

/**
 * Sample a quaternion track at frame index i, falling back to the bone's rest
 * rotation when the clip does not animate it (an unanimated bone holds bind
 * pose, exactly as three.js plays it).
 */
function quatAt(track, i, restQuat) {
	if (!track) return restQuat;
	const n = Math.floor(track.values.length / 4);
	if (n === 0) return restQuat;
	const k = Math.min(Math.max(i, 0), n - 1) * 4;
	return [track.values[k], track.values[k + 1], track.values[k + 2], track.values[k + 3]];
}

function vec3At(track, i, fallback) {
	if (!track) return fallback;
	const n = Math.floor(track.values.length / 3);
	if (n === 0) return fallback;
	const k = Math.min(Math.max(i, 0), n - 1) * 3;
	return [track.values[k], track.values[k + 1], track.values[k + 2]];
}

// Bone-local rest offset, expressed in the parent's world rest frame. The
// generated table stores WORLD rest positions, so the local offset is the world
// delta rotated back into the parent's bind orientation.
const LOCAL_REST_OFFSET = (() => {
	const out = {};
	for (const bone of Object.keys(CANONICAL_REST_POSITION)) {
		const parent = CANONICAL_PARENT[bone];
		const here = CANONICAL_REST_POSITION[bone];
		if (!parent) {
			out[bone] = [...here];
			continue;
		}
		const there = CANONICAL_REST_POSITION[parent];
		const delta = [here[0] - there[0], here[1] - there[1], here[2] - there[2]];
		const parentWorld = CANONICAL_REST_WORLD[parent] ?? [0, 0, 0, 1];
		out[bone] = quatApply(quatConjugate(parentWorld), delta);
	}
	return Object.freeze(out);
})();

/** Bones ordered parents-before-children so one pass of FK is enough. */
const FK_ORDER = (() => {
	const order = [];
	const seen = new Set();
	const visit = (bone) => {
		if (seen.has(bone)) return;
		const parent = CANONICAL_PARENT[bone];
		if (parent) visit(parent);
		seen.add(bone);
		order.push(bone);
	};
	for (const bone of Object.keys(CANONICAL_PARENT)) visit(bone);
	return Object.freeze(order);
})();

/**
 * World-space joint positions for one frame of a clip.
 * @returns {Record<string, [number, number, number]>}
 */
export function forwardKinematicsFrame(clip, frameIndex) {
	const tracks = tracksByName(clip);
	const worldQuat = {};
	const worldPos = {};
	for (const bone of FK_ORDER) {
		const local = quatAt(tracks.get(`${bone}.quaternion`), frameIndex, CANONICAL_REST[bone] ?? [0, 0, 0, 1]);
		const parent = CANONICAL_PARENT[bone];
		if (!parent) {
			worldQuat[bone] = local;
			worldPos[bone] = vec3At(tracks.get(`${bone}.position`), frameIndex, CANONICAL_REST_POSITION[bone] ?? [0, 0, 0]);
			continue;
		}
		const pq = worldQuat[parent] ?? [0, 0, 0, 1];
		const pp = worldPos[parent] ?? [0, 0, 0];
		const offset = quatApply(pq, LOCAL_REST_OFFSET[bone] ?? [0, 0, 0]);
		worldQuat[bone] = quatMul(pq, local);
		worldPos[bone] = [pp[0] + offset[0], pp[1] + offset[1], pp[2] + offset[2]];
	}
	return worldPos;
}

function frameCount(clip) {
	let frames = 0;
	for (const track of clip?.tracks ?? []) {
		const times = track?.times;
		if (Array.isArray(times) || ArrayBuffer.isView(times)) frames = Math.max(frames, times.length);
	}
	return frames;
}

/**
 * Foot-contact metrics over the whole clip.
 *
 * For each frame the lower toe is treated as the planted foot. While a foot
 * stays planted across consecutive frames, the horizontal distance it covers is
 * slide. `slidePerStride` compares that slide against the horizontal distance
 * the hips actually travelled: a clip that moves the body forward earns its foot
 * travel, a clip that pins the body and skates the feet does not.
 */
export function footContactMetrics(clip) {
	const frames = frameCount(clip);
	if (frames < 2) {
		return { frames, slide: 0, stride: 0, slidePerStride: 0, plantedFrames: 0, floorY: 0 };
	}

	// One FK pass, kept, so the floor level can be derived from the whole clip
	// before any frame is judged against it.
	const lower = new Array(frames);
	const hipsY = new Array(frames);
	const hips = new Array(frames);
	for (let i = 0; i < frames; i += 1) {
		const world = forwardKinematicsFrame(clip, i);
		const left = world.LeftToeBase ?? world.LeftFoot;
		const right = world.RightToeBase ?? world.RightFoot;
		hips[i] = world.Hips ?? null;
		hipsY[i] = world.Hips ? world.Hips[1] : Number.NaN;
		if (!left || !right) {
			lower[i] = null;
			continue;
		}
		lower[i] = left[1] <= right[1] ? { side: 'Left', pos: left } : { side: 'Right', pos: right };
	}

	// The floor is where this clip's feet actually get to, not y=0: a clip can be
	// authored with any root offset, and the reference rig's toes sit above zero.
	let floorY = Infinity;
	for (const entry of lower) {
		if (entry && Number.isFinite(entry.pos[1])) floorY = Math.min(floorY, entry.pos[1]);
	}
	if (!Number.isFinite(floorY)) floorY = 0;

	let slide = 0;
	let plantedFrames = 0;
	let prevPlanted = null;
	let prevPos = null;
	let hipsPath = 0;
	let hipsFirst = null;
	let hipsLast = null;
	let prevHips = null;

	for (let i = 0; i < frames; i += 1) {
		const h = hips[i];
		if (h) {
			if (!hipsFirst) hipsFirst = h;
			hipsLast = h;
			if (prevHips) hipsPath += Math.hypot(h[0] - prevHips[0], h[2] - prevHips[2]);
			prevHips = h;
		}

		const entry = lower[i];
		// A foot only counts as planted when it is actually down on the floor AND
		// the body is upright over it. Without that test a breakdance flair, a
		// fall, a crawl or any aerial reads as a foot skating across the ground,
		// because the "lower" foot is simply the one that happens to be less high.
		const grounded =
			entry != null &&
			entry.pos[1] - floorY <= MOTION_GATE.PLANT_BAND &&
			Number.isFinite(hipsY[i]) &&
			hipsY[i] - floorY >= MOTION_GATE.UPRIGHT_HIP_HEIGHT;
		if (!grounded) {
			prevPlanted = null;
			prevPos = null;
			continue;
		}

		if (entry.side === prevPlanted && prevPos) {
			slide += Math.hypot(entry.pos[0] - prevPos[0], entry.pos[2] - prevPos[2]);
			plantedFrames += 1;
		}
		prevPlanted = entry.side;
		prevPos = entry.pos;
	}

	// Stride credit is the greater of net displacement and the path the hips
	// walked: a clip that turns in place still travels, and a clip that moves out
	// and back should not be scored as if it never moved.
	const net =
		hipsFirst && hipsLast ? Math.hypot(hipsLast[0] - hipsFirst[0], hipsLast[2] - hipsFirst[2]) : 0;
	const stride = Math.max(net, hipsPath);
	// A stationary clip (an idle, a wave) has no stride to earn slide against, so
	// it is scored on absolute slide instead of a ratio against roughly zero.
	const slidePerStride = stride > 0.05 ? slide / stride : slide;
	return { frames, slide, stride, slidePerStride, plantedFrames, floorY };
}

// ── The gate ────────────────────────────────────────────────────────────────

// Every threshold is a measured property of a clip that plays correctly on the
// reference rig, not a taste call.
export const MOTION_GATE = Object.freeze({
	// The body chain a retarget needs to produce a readable pose. Fingers are
	// deliberately absent: the sampler does not animate them and a bind-pose hand
	// is correct, not a defect.
	REQUIRED_BONES: Object.freeze([
		'Hips',
		'Spine',
		'Spine1',
		'Spine2',
		'Neck',
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
	]),
	MIN_FRAMES: 16,
	MIN_DURATION: 0.5,
	MAX_DURATION: 12,
	// The sampler is asked for a duration; more than a second off means the clip
	// is not the clip we ordered.
	DURATION_TOLERANCE: 1.0,
	// Unit-quaternion drift. Past this the rotation is no longer a rotation and
	// three.js renders a sheared limb.
	QUAT_NORM_EPSILON: 0.02,
	// A limb that rotates more than this between two adjacent frames is a pop,
	// not motion. Set above the worst step measured across a 60-clip sample of
	// the authored library (2.124 rad, in a violent fall), and well below the
	// 180 degree snap a collapsed sampler produces, which is the actual defect.
	MAX_FRAME_JUMP_RAD: 2.62,
	// Total rotational travel below this is a frozen clip: the sampler collapsed.
	MIN_TOTAL_MOTION_RAD: 1.5,
	// How close to the clip's own floor a foot must be to count as planted.
	PLANT_BAND: 0.06,
	// How high the hips must sit above that floor for the body to be standing on
	// the planted foot at all. Below this the clip is floor work (a fall, a
	// crawl, a breakdance flair) where no foot bears weight and foot travel is
	// choreography rather than skating.
	UPRIGHT_HIP_HEIGHT: 0.55,
	// Planted-foot slide, as a multiple of the stride the clip actually covers.
	MAX_SLIDE_PER_STRIDE: 0.85,
	// Absolute slide ceiling in metres for a clip that does not travel.
	MAX_STATIONARY_SLIDE: 0.55,
});

function isFiniteSeq(seq) {
	for (let i = 0; i < seq.length; i += 1) {
		if (!Number.isFinite(seq[i])) return false;
	}
	return true;
}

/**
 * Decide whether a generated clip is fit to publish.
 *
 * @param {any} clip raw AnimationClip JSON from the text2motion worker
 * @param {{ expectedDuration?: number, loop?: boolean }} [opts]
 * @returns {{ ok: boolean, reasons: string[], metrics: Record<string, number> }}
 */
export function gateMotionClip(clip, opts = {}) {
	const reasons = [];
	const metrics = {};

	const tracks = Array.isArray(clip?.tracks) ? clip.tracks : null;
	if (!tracks || tracks.length === 0) {
		return { ok: false, reasons: ['no_tracks'], metrics };
	}

	const duration = Number(clip?.duration);
	metrics.duration = Number.isFinite(duration) ? duration : 0;
	if (!Number.isFinite(duration) || duration < MOTION_GATE.MIN_DURATION || duration > MOTION_GATE.MAX_DURATION) {
		reasons.push('duration_out_of_range');
	}
	const expected = Number(opts.expectedDuration);
	if (Number.isFinite(expected) && Number.isFinite(duration)) {
		metrics.durationDelta = Math.abs(duration - expected);
		if (metrics.durationDelta > MOTION_GATE.DURATION_TOLERANCE) reasons.push('duration_mismatch');
	}

	const names = new Set(tracks.map((t) => t?.name).filter((n) => typeof n === 'string'));
	const bones = new Set([...names].map(boneOf));
	const missing = MOTION_GATE.REQUIRED_BONES.filter((b) => !bones.has(b));
	metrics.trackCount = tracks.length;
	metrics.missingBones = missing.length;
	if (missing.length) reasons.push(`missing_bones:${missing.slice(0, 4).join(',')}`);

	// A track naming a bone the canonical skeleton does not have would land on
	// nothing after retarget, so it is a format failure rather than a quality one.
	const foreign = [...bones].filter((b) => !(b in CANONICAL_PARENT));
	metrics.foreignBones = foreign.length;
	if (foreign.length) reasons.push(`foreign_bones:${foreign.slice(0, 3).join(',')}`);

	let frames = 0;
	let worstNormDrift = 0;
	let worstJump = 0;
	let totalMotion = 0;
	let nonFinite = false;
	let nonMonotonic = false;

	for (const track of tracks) {
		const times = track?.times ?? [];
		const values = track?.values ?? [];
		if (!isFiniteSeq(times) || !isFiniteSeq(values)) {
			nonFinite = true;
			continue;
		}
		frames = Math.max(frames, times.length);
		for (let i = 1; i < times.length; i += 1) {
			if (times[i] < times[i - 1]) {
				nonMonotonic = true;
				break;
			}
		}
		if (track.type !== 'quaternion') continue;

		let prev = null;
		const n = Math.floor(values.length / 4);
		for (let i = 0; i < n; i += 1) {
			const q = [values[i * 4], values[i * 4 + 1], values[i * 4 + 2], values[i * 4 + 3]];
			worstNormDrift = Math.max(worstNormDrift, Math.abs(quatLength(q) - 1));
			if (prev) {
				const step = quatAngleBetween(prev, q);
				worstJump = Math.max(worstJump, step);
				totalMotion += step;
			}
			prev = q;
		}
	}

	metrics.frames = frames;
	metrics.quatNormDrift = worstNormDrift;
	metrics.maxFrameJumpRad = worstJump;
	metrics.totalMotionRad = totalMotion;

	if (nonFinite) reasons.push('non_finite_keyframes');
	if (nonMonotonic) reasons.push('non_monotonic_times');
	if (frames < MOTION_GATE.MIN_FRAMES) reasons.push('too_few_frames');
	if (worstNormDrift > MOTION_GATE.QUAT_NORM_EPSILON) reasons.push('quaternions_not_normalized');
	if (worstJump > MOTION_GATE.MAX_FRAME_JUMP_RAD) reasons.push('frame_pop');
	if (totalMotion < MOTION_GATE.MIN_TOTAL_MOTION_RAD) reasons.push('frozen_clip');

	// Foot contact only means something once the skeleton itself is sane, and
	// running FK over NaN values would only produce NaN metrics.
	if (!nonFinite && !missing.length && !foreign.length) {
		const foot = footContactMetrics(clip);
		metrics.footSlide = foot.slide;
		metrics.stride = foot.stride;
		metrics.slidePerStride = foot.slidePerStride;
		const travels = foot.stride > 0.05;
		if (travels && foot.slidePerStride > MOTION_GATE.MAX_SLIDE_PER_STRIDE) reasons.push('foot_sliding');
		if (!travels && foot.slide > MOTION_GATE.MAX_STATIONARY_SLIDE) reasons.push('foot_sliding_in_place');
	}

	return { ok: reasons.length === 0, reasons, metrics };
}

// ── Publishing shape ────────────────────────────────────────────────────────

/**
 * Rewrite a raw generated clip into the exact object the library already serves:
 * same top-level keys, same track shape, library-style name, and a userData
 * record of where the clip came from (the Mixamo import carries an empty
 * userData object, so the key is expected and the extra provenance is additive).
 */
export function toLibraryClip(raw, { name, promptId, prompt, category, loop, taskId }) {
	return {
		name,
		duration: raw.duration,
		tracks: raw.tracks,
		uuid: raw.uuid,
		blendMode: raw.blendMode ?? 0,
		userData: {
			source: 'text2motion',
			prompt_id: promptId,
			prompt,
			category,
			loop: Boolean(loop),
			task_id: taskId,
			generated_at: new Date().toISOString(),
		},
	};
}

/** A manifest row in the shape api/animations/library.js already returns. */
export function manifestEntryFor(clip, { label, icon, loop, bytes, url, thumb }) {
	return {
		name: clip.name,
		label,
		icon: icon || '🎬',
		loop: Boolean(loop),
		duration: clip.duration,
		bytes,
		url,
		thumb: thumb ?? null,
	};
}

/**
 * Merge generated rows into the existing manifest without disturbing the Mixamo
 * import: entries are matched by name, so re-running a batch replaces a row
 * rather than duplicating it, and the array stays stably ordered (the library
 * endpoint pages it by index, so a reorder would shuffle every caller's page).
 */
export function mergeManifest(existing, additions) {
	const out = Array.isArray(existing) ? [...existing] : [];
	const index = new Map(out.map((entry, i) => [entry?.name, i]));
	for (const entry of additions) {
		const at = index.get(entry.name);
		if (at === undefined) {
			index.set(entry.name, out.length);
			out.push(entry);
		} else {
			out[at] = entry;
		}
	}
	return out;
}

// ── Rotating free subset (work order B8) ────────────────────────────────────
//
// Policy: the generated collection is paid by default, and a fixed-size subset
// is free for one epoch at a time. The subset is chosen by hashing the clip name
// together with the epoch number, so it is deterministic (every server instance
// and the client agree without coordination or a DB write), stable for the whole
// epoch (a visitor does not watch a clip's price flicker on reload), and evenly
// spread over time (each clip's hash ordering differs per epoch, so the free
// slot rotates rather than favouring the same names).

export const FREE_ROTATION = Object.freeze({
	EPOCH_MS: 7 * 24 * 60 * 60 * 1000,
	SIZE: 12,
});

export function rotationEpoch(now = Date.now()) {
	return Math.floor(now / FREE_ROTATION.EPOCH_MS);
}

function rotationRank(name, epoch) {
	const digest = createHash('sha256').update(`${epoch}:${name}`).digest();
	return digest.readUInt32BE(0);
}

/**
 * The names free this epoch, given every generated clip name in the collection.
 * @param {string[]} names
 */
export function freeClipNames(names, { now = Date.now(), size = FREE_ROTATION.SIZE } = {}) {
	const epoch = rotationEpoch(now);
	return [...new Set(names)]
		.map((name) => ({ name, rank: rotationRank(name, epoch) }))
		.sort((a, b) => a.rank - b.rank || (a.name < b.name ? -1 : 1))
		.slice(0, Math.max(0, size))
		.map((entry) => entry.name);
}

export function isFreeThisEpoch(name, allNames, opts = {}) {
	return freeClipNames(allNames, opts).includes(name);
}
