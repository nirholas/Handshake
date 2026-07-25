// Sign clip assembly — the shared authoring layer under fingerspelling and the
// lexical sign dictionary.
//
// It gives both lanes the same three things:
//   • a resting signer (arms down, hands relaxed, spine settled) to start and
//     end every utterance from, so signing enters and leaves naturally instead
//     of snapping out of a bind pose,
//   • `posePhase()`, which turns a readable sign description — "flat hand, palm
//     out, at the chin" — into a solved full-body pose via the rig's IK,
//   • `SignTimeline`, which strings those poses together with eased transitions
//     and emits the SAME AnimationClip JSON document the pre-baked clip library
//     serves, so a sign retargets onto any rigged avatar with zero new playback
//     machinery (src/animation-retarget.js).
//
// Signs never write joint angles. They name a handshape, a place in signing
// space, and which way the fingers and palm face; everything else is solved.

import { applyHandshape } from './sign-handshapes.js';
import {
	Pose,
	anchorPoint,
	boneAxis,
	fingerBones,
	handPartOffset,
	handPoint,
	orientQuat,
	palmAxis,
	qAxisAngle,
	qMul,
	qRotate,
	qSlerp,
	signPoint,
	solveArm,
	vAdd,
	vNorm,
	vScale,
	vSub,
} from './sign-rig.js';

/**
 * The bones a signing clip drives. Legs and hips are deliberately absent: an
 * utterance is upper-body, so the avatar keeps whatever stance the clip it
 * blended out of left it in, and the root never moves.
 */
export const SIGNING_BONES = Object.freeze([
	'Spine',
	'Spine1',
	'Spine2',
	'Neck',
	'Head',
	...['Left', 'Right'].flatMap((side) => [
		`${side}Shoulder`,
		`${side}Arm`,
		`${side}ForeArm`,
		`${side}Hand`,
		...fingerBones(side),
	]),
]);

// ── readable directions ────────────────────────────────────────────────────

const BASE_DIRECTIONS = {
	up: [0, 1, 0],
	down: [0, -1, 0],
	/** Toward the person being signed to. */
	forward: [0, 0, 1],
	/** Toward the signer's own body. */
	back: [0, 0, -1],
};

/**
 * Resolve a direction written the way a sign is described — `'up'`,
 * `['down', 'forward']`, `'in'` (toward the midline), `'out'` (away from it) —
 * into a unit vector in model space. Explicit `[x,y,z]` passes through.
 *
 * @param {string|string[]|number[]} spec
 * @param {'Left'|'Right'} side
 * @returns {number[]}
 */
export function direction(spec, side = 'Right') {
	if (!spec) return null;
	if (Array.isArray(spec) && typeof spec[0] === 'number') return vNorm(spec);
	const names = Array.isArray(spec) ? spec : String(spec).split(/[\s-]+/);
	const outward = side === 'Right' ? -1 : 1;
	let acc = [0, 0, 0];
	for (const name of names) {
		const base = BASE_DIRECTIONS[name];
		if (base) acc = vAdd(acc, base);
		else if (name === 'out') acc = vAdd(acc, [outward, 0, 0]);
		else if (name === 'in') acc = vAdd(acc, [-outward, 0, 0]);
		else throw new Error(`unknown direction "${name}"`);
	}
	return vNorm(acc);
}

/**
 * Resolve a place in signing space: an anchor name with body-relative offsets,
 * an explicit point, or an explicit `[x,y,z]`. Anchors are read from the POSE,
 * so a place on the chin follows the chin when the head turns.
 * @param {string|object|number[]} spec
 * @param {'Left'|'Right'} side
 * @param {Pose} [pose]
 * @returns {number[]}
 */
export function place(spec, side = 'Right', pose = null) {
	if (Array.isArray(spec) && typeof spec[0] === 'number') return spec;
	const { anchor = 'sternum', ...offsets } = typeof spec === 'string' ? { anchor: spec } : spec;
	return pose
		? anchorPoint(pose, anchor, { ...offsets, side })
		: signPoint(anchor, { ...offsets, side });
}

/**
 * Where a `touch:` spec says the acting hand must make contact, in world space.
 * The target is either the other (already posed) hand or a place on the body.
 *
 * @param {Pose} pose
 * @param {'Left'|'Right'} side   the acting hand
 * @param {object} touch
 * @returns {number[]}
 */
function contactPoint(pose, side, touch) {
	const other = side === 'Left' ? 'Right' : 'Left';
	const target = touch.to ?? 'other';
	const base =
		target === 'other' || target === 'left' || target === 'right'
			? handPoint(pose, target === 'other' ? other : target === 'left' ? 'Left' : 'Right', touch.on ?? 'palm')
			: place({ anchor: target, out: touch.out, up: touch.up, forward: touch.forward }, side, pose);
	if (target !== 'other' && target !== 'left' && target !== 'right') return base;
	// Offsets on a hand target are body-relative too, so a sign can sit a
	// fingertip slightly up the palm without naming a coordinate.
	const outward = side === 'Right' ? -1 : 1;
	return vAdd(base, [outward * (touch.out ?? 0), touch.up ?? 0, touch.forward ?? 0]);
}

// ── non-manual markers ─────────────────────────────────────────────────────
//
// In ASL the face is grammar, not decoration: raised brows mark a yes/no
// question, furrowed brows a wh-question, a headshake carries negation, and the
// same manual sign means different things under different markers. These presets
// name the markers a sign can carry; they compile to ARKit-standard blendshape
// weights, which is what most avatar pipelines (Ready Player Me, Avaturn, VRM
// with ARKit shapes) expose. An avatar without them loses the marker and keeps
// the sign — see the face lane in src/animation-retarget.js.
export const FACE_MARKERS = Object.freeze({
	/** Yes/no question: brows up, head slightly forward. */
	question: { browInnerUp: 0.75, browOuterUpLeft: 0.6, browOuterUpRight: 0.6 },
	/** Wh-question (WHAT, WHY, HOW): brows down and drawn together. */
	wh: { browDownLeft: 0.7, browDownRight: 0.7, eyeSquintLeft: 0.25, eyeSquintRight: 0.25 },
	/** Negation, alongside the headshake the sign itself carries. */
	negate: { browDownLeft: 0.4, browDownRight: 0.4, mouthPucker: 0.2 },
	/** Topic marker: brows up, held. */
	topic: { browInnerUp: 0.55, browOuterUpLeft: 0.45, browOuterUpRight: 0.45 },
	/** Pleasure, on signs that carry it lexically (HAPPY, GOOD, NICE). */
	pleasant: { mouthSmileLeft: 0.45, mouthSmileRight: 0.45, cheekSquintLeft: 0.3, cheekSquintRight: 0.3 },
	/** Concern or apology (SORRY, BAD). */
	concern: { browInnerUp: 0.45, mouthFrownLeft: 0.3, mouthFrownRight: 0.3 },
	/** Effort or intensity — the "cs"/"mm" mouth of a close, careful sign. */
	intense: { jawOpen: 0.12, eyeSquintLeft: 0.35, eyeSquintRight: 0.35, cheekPuff: 0.15 },
	/** Nothing: a neutral face, which is itself a grammatical choice. */
	neutral: {},
});

/**
 * Resolve a phase's `face:` into blendshape weights. Accepts a marker name, a
 * list of them, or explicit `{shapeName: weight}`.
 * @param {string|string[]|object} spec
 * @returns {Record<string, number>}
 */
export function faceWeights(spec) {
	if (!spec) return {};
	if (typeof spec === 'object' && !Array.isArray(spec)) {
		// Explicit weights, or a marker name with an intensity: { question: 0.5 }.
		const out = {};
		for (const [key, value] of Object.entries(spec)) {
			if (FACE_MARKERS[key]) {
				for (const [shape, w] of Object.entries(FACE_MARKERS[key])) out[shape] = w * value;
			} else {
				out[key] = value;
			}
		}
		return out;
	}
	const names = Array.isArray(spec) ? spec : [spec];
	const out = {};
	for (const name of names) {
		const marker = FACE_MARKERS[name];
		if (!marker) throw new Error(`unknown face marker "${name}"`);
		for (const [shape, w] of Object.entries(marker)) out[shape] = Math.max(out[shape] ?? 0, w);
	}
	return out;
}

// Every shape any marker can touch. A phase that does not use a shape must still
// drive it to zero, or a marker from an earlier phase would stick to the face for
// the rest of the utterance.
const FACE_SHAPES = Object.freeze([
	...new Set(Object.values(FACE_MARKERS).flatMap((m) => Object.keys(m))),
]);

// ── the resting signer ─────────────────────────────────────────────────────

/** Where a relaxed arm hangs: down the side, elbow soft, palm toward the thigh. */
const REST_ARM = {
	at: { anchor: 'shoulder', out: 0.055, up: -0.47, forward: 0.06 },
	fingers: ['down', 'forward'],
	palm: 'in',
	shape: 'RELAXED',
};

// Where the hands WAIT between two signs of the same utterance: low in front of
// the body, still inside signing space. A signer does not drop their arms to
// their sides between words, and an avatar that does reads as restarting the
// sentence on every word.
const NEUTRAL_ARM = {
	at: { anchor: 'belly', out: 0.15, up: 0.07, forward: 0.21 },
	fingers: ['up', 'forward', 'in'],
	palm: 'in',
	shape: 'RELAXED',
};

/**
 * The signer's hands between signs: still up, still in signing space, doing
 * nothing. Segments that continue an utterance open here instead of at
 * {@link restingPose}.
 * @param {Pose} [base]
 * @returns {Pose}
 */
export function neutralPose(base = restingPose()) {
	const pose = base.clone();
	for (const side of ['Left', 'Right']) poseHand(pose, side, NEUTRAL_ARM);
	return pose;
}

/**
 * A signer at rest: arms down, hands relaxed, chest open, head level. Every
 * utterance starts and ends here so signing has somewhere to come from and go
 * back to.
 * @returns {Pose}
 */
export function restingPose() {
	const pose = new Pose();
	// A little life in the spine: signers stand tall, not ramrod straight.
	pose.setLocal('Spine', qMul(pose.getLocal('Spine'), qAxisAngle([1, 0, 0], 1.5)));
	pose.setLocal('Spine2', qMul(pose.getLocal('Spine2'), qAxisAngle([1, 0, 0], -1)));
	pose.setLocal('Neck', qMul(pose.getLocal('Neck'), qAxisAngle([1, 0, 0], -2)));
	for (const side of ['Left', 'Right']) poseHand(pose, side, REST_ARM);
	return pose;
}

/**
 * Put one hand somewhere in signing space: handshape, location, and the
 * directions the fingers and palm face. The arm is solved by IK, so the elbow
 * and shoulder follow anatomically instead of being posed by hand.
 *
 * @param {Pose} pose  mutated in place
 * @param {'Left'|'Right'} side
 * @param {{
 *   shape?: string,
 *   at?: string|object|number[],
 *   fingers?: string|string[]|number[],
 *   palm?: string|string[]|number[],
 *   pole?: string|string[]|number[],
 * }} spec
 * @returns {Pose}
 */
export function poseHand(pose, side, spec) {
	if (spec.shape) applyHandshape(pose, spec.shape, side);
	const hand = `${side}Hand`;
	const fingers = direction(spec.fingers ?? 'up', side);
	const palm = direction(spec.palm ?? 'forward', side);

	let wrist;
	if (spec.touch) {
		// Solve the wrist BACKWARDS from the contact: the hand's orientation is
		// already known from `fingers`/`palm`, so the offset from the wrist to the
		// touching part is known too, and the wrist is wherever puts that part on
		// the target. This is what keeps a fingertip on the palm (and out of it)
		// when hand size or finger length changes.
		const contact = contactPoint(pose, side, spec.touch);
		const handQuat = orientQuat(boneAxis(hand), palmAxis(hand), fingers, palm);
		const offset = qRotate(handQuat, handPartOffset(pose, side, spec.touch.part ?? 'fingertips'));
		const clearance = spec.touch.gap ?? 0;
		wrist = vSub(vSub(contact, offset), vScale(vNorm(offset), clearance));
	} else {
		wrist = place(spec.at ?? REST_ARM.at, side, pose);
	}

	solveArm(pose, side, {
		wrist,
		fingers,
		palm,
		pole: spec.pole ? direction(spec.pole, side) : undefined,
	});
	return pose;
}

/**
 * Mirror a phase for a left-dominant signer: the hands swap roles, any contact
 * that named a hand follows them, and the head and torso turn the other way.
 * Places and directions need no mirroring at all, because they are written
 * body-relative (`out`, `in`) rather than as coordinates.
 *
 * About one signer in ten is left-dominant, and signing left-handed is not an
 * error to be corrected.
 *
 * @param {object} phase
 * @returns {object}
 */
export function mirrorPhase(phase) {
	const flipTouch = (hand) => {
		if (!hand || typeof hand !== 'object' || !hand.touch) return hand;
		const to = hand.touch.to;
		const flipped = to === 'left' ? 'right' : to === 'right' ? 'left' : to;
		return { ...hand, touch: { ...hand.touch, to: flipped } };
	};
	const out = { ...phase };
	delete out.left;
	delete out.right;
	if (phase.right !== undefined) out.left = flipTouch(phase.right);
	if (phase.left !== undefined) out.right = flipTouch(phase.left);
	if (phase.head) out.head = { ...phase.head, turn: -(phase.head.turn ?? 0), tilt: -(phase.head.tilt ?? 0) };
	if (phase.torso) out.torso = { ...phase.torso, turn: -(phase.torso.turn ?? 0) };
	return out;
}

/**
 * Build a whole-body pose for one phase of a sign.
 *
 * @param {{
 *   both?: object,
 *   right?: object|'rest',
 *   left?: object|'rest',
 *   head?: { nod?: number, tilt?: number, turn?: number },
 *   torso?: { lean?: number, turn?: number },
 * }} spec  degrees for head/torso; `right`/`left` are {@link poseHand} specs and
 *   `both` applies one spec to each hand — which works because directions and
 *   places are body-relative, so a symmetric two-handed sign is written once.
 * @param {Pose} [base]  pose to build on (defaults to the resting signer)
 * @returns {Pose}
 */
export function posePhase(spec, base = restingPose()) {
	const pose = base.clone();
	const { head, torso } = spec;

	// Body first, arms second. The spine and neck carry the shoulders, so solving
	// the arms afterwards puts the hands where the sign says regardless of how the
	// torso leans — and lets a hand touch the chin AFTER the head has turned.
	if (torso) {
		// Spread the lean across the spine so the torso curves instead of hinging.
		for (const [bone, share] of [['Spine', 0.4], ['Spine1', 0.35], ['Spine2', 0.25]]) {
			pose.setLocal(
				bone,
				qMul(
					pose.getLocal(bone),
					qMul(qAxisAngle([1, 0, 0], (torso.lean ?? 0) * share), qAxisAngle([0, 1, 0], (torso.turn ?? 0) * share)),
				),
			);
		}
	}
	if (head) {
		const q = qMul(
			qMul(qAxisAngle([1, 0, 0], head.nod ?? 0), qAxisAngle([0, 1, 0], head.turn ?? 0)),
			qAxisAngle([0, 0, 1], head.tilt ?? 0),
		);
		// Split between neck and head so the whole column moves, not just the skull.
		pose.setLocal('Neck', qMul(pose.getLocal('Neck'), qSlerp([0, 0, 0, 1], q, 0.45)));
		pose.setLocal('Head', qMul(pose.getLocal('Head'), qSlerp([0, 0, 0, 1], q, 0.55)));
	}

	if (spec.face) pose.setFace(faceWeights(spec.face));

	// The hand being touched has to exist before the hand touching it, so a hand
	// whose spec has no `touch` is posed first.
	const hands = ['Left', 'Right']
		.map((side) => {
			const own = spec[side.toLowerCase()];
			const hand = own === 'rest' ? REST_ARM : spec.both ? { ...spec.both, ...(own ?? {}) } : own;
			return hand ? { side, hand } : null;
		})
		.filter(Boolean)
		.sort((a, b) => (a.hand.touch ? 1 : 0) - (b.hand.touch ? 1 : 0));
	for (const { side, hand } of hands) poseHand(pose, side, hand);

	return pose;
}

// ── timeline → clip document ───────────────────────────────────────────────

const NORMAL_BLEND_MODE = 2500;

/** Smoothstep — the default ease for a transition between two sign phases. */
const EASES = {
	linear: (u) => u,
	smooth: (u) => u * u * (3 - 2 * u),
	/** Fast out of the hold, soft into the next one: how a hand actually moves. */
	out: (u) => 1 - (1 - u) * (1 - u),
	in: (u) => u * u,
};

// Interpolated keys inside each transition. Quaternion tracks are slerped
// linearly by the mixer, so easing has to be baked as extra samples.
const EASE_SAMPLES = 3;

// Longest gap between keys, so the idle breath below is sampled smoothly
// through a long hold rather than aliasing into a twitch.
const MAX_KEY_GAP = 0.28;

// A signer is never perfectly still. Amplitudes in degrees; the period is a
// slow breath cycle.
const BREATH = { period: 4.4, chest: 0.9, neck: 0.5, sway: 0.35 };

function stableUuid(seed) {
	// FNV-1a over the seed expanded to uuid shape — deterministic, so the same
	// word compiles to the same document every time.
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

/**
 * A sequence of poses on a clock, compiled to an AnimationClip document.
 *
 *   const tl = new SignTimeline();
 *   tl.to(posePhase({ right: { shape: 'B', at: 'chin', palm: 'forward' } }), 0.3);
 *   tl.hold(0.4);
 *   tl.settle(0.35);
 *   const clip = tl.build({ name: 'sign-hello' });
 */
export class SignTimeline {
	/**
	 * @param {{ base?: Pose, open?: Pose, breathe?: boolean }} [opts]
	 *   `base` is where `settle()` returns to. `open` is the pose at t=0, which
	 *   differs from `base` for a segment continuing mid-utterance: the hands are
	 *   already up in signing space, so the segment must not start from the arms
	 *   hanging at the hips.
	 */
	constructor({ base = restingPose(), open = null, breathe = true } = {}) {
		this.base = base;
		this.breathe = breathe;
		/** @type {{time:number, pose:Pose}[]} */
		this.keys = [{ time: 0, pose: open ?? base }];
		this.time = 0;
	}

	/** The pose the timeline currently ends on. */
	get current() {
		return this.keys[this.keys.length - 1].pose;
	}

	/** Hold the current pose for `seconds`. */
	hold(seconds) {
		if (seconds > 0) {
			this.time += seconds;
			this.keys.push({ time: this.time, pose: this.current });
		}
		return this;
	}

	/**
	 * Move to `pose` over `seconds`, easing so the hand accelerates out of the
	 * previous phase and settles into this one.
	 * @param {Pose} pose
	 * @param {number} seconds
	 * @param {{ ease?: keyof EASES }} [opts]
	 */
	to(pose, seconds, { ease = 'smooth' } = {}) {
		const from = this.current;
		const curve = EASES[ease] ?? EASES.smooth;
		const start = this.time;
		if (seconds > 0) {
			for (let i = 1; i <= EASE_SAMPLES; i++) {
				const u = i / (EASE_SAMPLES + 1);
				this.keys.push({ time: start + seconds * u, pose: blend(from, pose, curve(u)) });
			}
			this.time = start + seconds;
		}
		this.keys.push({ time: this.time, pose });
		return this;
	}

	/** Return to the resting signer over `seconds` — how every utterance ends. */
	settle(seconds) {
		return this.to(this.base, seconds, { ease: 'in' });
	}

	/**
	 * Compile to the clip JSON the animation library and retargeter consume.
	 * @param {{ name: string, uuid?: string, seed?: string }} opts
	 * @returns {object}
	 */
	build({ name, uuid, seed }) {
		const keys = densify(this.keys, MAX_KEY_GAP);
		const driven = new Set();
		for (const key of keys) for (const bone of key.pose.local.keys()) driven.add(bone);
		// Always emit the full signing set, so merging two segments never leaves a
		// bone stranded at whatever a previous sign left it holding.
		for (const bone of SIGNING_BONES) driven.add(bone);

		const times = keys.map((k) => k.time);
		const tracks = [];
		for (const bone of driven) {
			const values = [];
			for (const key of keys) {
				let q = key.pose.getLocal(bone);
				if (this.breathe) q = breathe(bone, q, key.time);
				values.push(q[0], q[1], q[2], q[3]);
			}
			tracks.push({ type: 'quaternion', name: `${bone}.quaternion`, times: [...times], values });
		}

		// Face lanes, only for the shapes this clip actually uses. Authored against
		// a placeholder node; src/animation-retarget.js re-points them at whichever
		// meshes on the target avatar own each shape, and drops them when it has no
		// face at all.
		for (const shape of FACE_SHAPES) {
			if (!keys.some((k) => k.pose.getFace(shape) > 0)) continue;
			tracks.push({
				type: 'number',
				name: `Face.morphTargetInfluences[${shape}]`,
				times: [...times],
				values: keys.map((k) => k.pose.getFace(shape)),
			});
		}

		return {
			name,
			duration: times[times.length - 1],
			tracks,
			uuid: uuid ?? stableUuid(seed ?? name),
			blendMode: NORMAL_BLEND_MODE,
		};
	}
}

/** Per-bone slerp plus per-shape lerp between two poses. */
function blend(a, b, t) {
	const out = new Pose(a);
	const bones = new Set([...a.local.keys(), ...b.local.keys()]);
	for (const bone of bones) out.setLocal(bone, qSlerp(a.getLocal(bone), b.getLocal(bone), t));
	const shapes = new Set([...a.face.keys(), ...b.face.keys()]);
	for (const shape of shapes) {
		out.face.set(shape, a.getFace(shape) + (b.getFace(shape) - a.getFace(shape)) * t);
	}
	return out;
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
			out.push({ time: prev.time + span * u, pose: blend(prev.pose, next.pose, u) });
		}
		out.push(next);
	}
	return out;
}

// Breathing + micro-sway, layered on top of the authored pose. Small enough to
// read as life rather than motion, but the difference between a signing avatar
// and a mannequin holding a shape.
function breathe(bone, q, time) {
	const phase = (time / BREATH.period) * Math.PI * 2;
	if (bone === 'Spine1') return qMul(q, qAxisAngle([1, 0, 0], Math.sin(phase) * BREATH.chest));
	if (bone === 'Spine2') return qMul(q, qAxisAngle([0, 1, 0], Math.sin(phase * 0.5) * BREATH.sway));
	if (bone === 'Neck') return qMul(q, qAxisAngle([1, 0, 0], -Math.sin(phase) * BREATH.neck));
	if (bone === 'Head') return qMul(q, qAxisAngle([0, 1, 0], Math.sin(phase * 0.37) * BREATH.sway));
	return q;
}

export { stableUuid };
