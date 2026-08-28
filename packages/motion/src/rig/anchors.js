// Anatomical anchors: the places on a body a motion can be written against.
//
// A score says "the right hand goes to the chest, a hand's width out and a
// little forward", never an XYZ. Two reasons that matters. It is the only form
// a language model can author reliably, and it survives the body moving: an
// anchor is measured once on the rest skeleton, then carried by whichever bone
// owns it, so "at the chin" is still at the chin after the torso has turned
// forty degrees and the hips have dropped into a crouch.

import { qConj, qRotate, vAdd, vScale, vSub } from './math.js';
import {
	BODY_FORWARD,
	BODY_LEFT,
	BODY_UP,
	GROUND_Y,
	SHOULDER_SPAN,
	hasBone,
	restPos,
	restWorld,
} from './skeleton.js';

const head = restPos('Head');
const neck = restPos('Neck');
const chest = restPos('Spine2');
const waist = restPos('Spine');
const hips = restPos('Hips');
const shoulderL = restPos('LeftArm');
const shoulderR = restPos('RightArm');
const chinY = neck[1] + (head[1] - neck[1]) * 0.55;
// Half the shoulder span: the lateral unit every side-aware anchor is placed in.
const halfSpan = SHOULDER_SPAN / 2;

const lateral = (metres) => vScale(BODY_LEFT, metres);
const ahead = (metres) => vScale(BODY_FORWARD, metres);
const above = (metres) => vScale(BODY_UP, metres);

/**
 * Every anchor, in model space on the reference rig. Side-aware anchors are an
 * object keyed by side; `anchorPoint` picks the one matching the acting limb.
 */
export const ANCHORS = Object.freeze({
	head,
	forehead: vAdd(head, above(0.07)),
	crown: vAdd(head, above(0.14)),
	temple: { Left: vAdd(head, vAdd(lateral(0.09), above(0.03))), Right: vAdd(head, vAdd(lateral(-0.09), above(0.03))) },
	nose: vAdd(head, vAdd(above(0.02), ahead(0.05))),
	mouth: vAdd([0, chinY + 0.04, head[2]], ahead(0.04)),
	chin: vAdd([0, chinY, head[2]], ahead(0.03)),
	neck,
	// Upper chest, where most gesturing lives. Measured up from the chest bone
	// toward the neck: the bone itself sits at mid-torso, and anchoring there
	// hangs every gesture at belly height.
	sternum: vAdd([0, chest[1] + (neck[1] - chest[1]) * 0.6, chest[2]], ahead(0.02)),
	chest: [0, chest[1], chest[2]],
	heart: vAdd([0, chest[1] + (neck[1] - chest[1]) * 0.4, chest[2]], lateral(0.06)),
	belly: [0, (chest[1] + hips[1]) / 2, waist[2]],
	waist: [0, waist[1], waist[2]],
	hips,
	shoulder: { Left: shoulderL, Right: shoulderR },
	hip: {
		Left: vAdd(hips, lateral(halfSpan * 0.55)),
		Right: vAdd(hips, lateral(-halfSpan * 0.55)),
	},
	/** Arms hanging: where a relaxed wrist sits beside the thigh. */
	side: {
		Left: vAdd(hips, vAdd(lateral(halfSpan * 0.92), vAdd(above(-0.12), ahead(0.02)))),
		Right: vAdd(hips, vAdd(lateral(-halfSpan * 0.92), vAdd(above(-0.12), ahead(0.02)))),
	},
	/** Straight out in front at chest height: the offering, pointing, handshake zone. */
	front: vAdd([0, chest[1] + 0.06, chest[2]], ahead(0.34)),
	/** Out to the side at shoulder height: the presenting, shrugging zone. */
	wide: {
		Left: vAdd(shoulderL, vAdd(lateral(0.3), ahead(0.08))),
		Right: vAdd(shoulderR, vAdd(lateral(-0.3), ahead(0.08))),
	},
	/** Arm raised: hailing, waving, celebrating. */
	overhead: {
		Left: vAdd(shoulderL, vAdd(above(0.42), lateral(0.06))),
		Right: vAdd(shoulderR, vAdd(above(0.42), lateral(-0.06))),
	},
	/** Behind the hip: reaching back, hands clasped behind. */
	behind: {
		Left: vAdd(hips, vAdd(lateral(halfSpan * 0.7), vAdd(above(-0.04), ahead(-0.22)))),
		Right: vAdd(hips, vAdd(lateral(-halfSpan * 0.7), vAdd(above(-0.04), ahead(-0.22)))),
	},
	/** Knee height in front: reaching down without the hips moving. */
	knee: {
		Left: vAdd(restPos('LeftLeg'), ahead(0.12)),
		Right: vAdd(restPos('RightLeg'), ahead(0.12)),
	},
	/** On the floor in front of the feet. */
	floor: vAdd([0, GROUND_Y + 0.05, 0], ahead(0.28)),
});

// Which bone carries each anchor, so the anchor follows the body. Anything not
// listed rides the chest, which is the right default for gesture space.
const ANCHOR_BONE = Object.freeze({
	head: 'Head',
	forehead: 'Head',
	crown: 'Head',
	temple: 'Head',
	nose: 'Head',
	mouth: 'Head',
	chin: 'Head',
	neck: 'Neck',
	sternum: 'Spine2',
	chest: 'Spine2',
	heart: 'Spine2',
	front: 'Spine2',
	wide: 'Spine2',
	overhead: 'Spine2',
	belly: 'Spine',
	waist: 'Spine',
	hips: 'Hips',
	hip: 'Hips',
	side: 'Hips',
	behind: 'Hips',
	knee: 'Hips',
	shoulder: 'Spine2',
	// The floor does not follow the body: that is what makes it the floor.
	floor: null,
});

/** Every anchor name a score may use. */
export const ANCHOR_NAMES = Object.freeze(Object.keys(ANCHORS).sort());

/**
 * Resolve an anchor plus a body-relative offset to a point on the REST
 * skeleton. Offsets are in metres: `out` moves away from the body's midline on
 * the acting side, `up` and `forward` do what they say.
 *
 * @param {string|number[]} anchor an ANCHORS key, or an explicit model-space point
 * @param {{ out?: number, up?: number, forward?: number, side?: 'Left'|'Right' }} [offset]
 * @returns {number[]} model-space point on the rest skeleton
 */
export function restAnchor(anchor, offset = {}) {
	const side = offset.side ?? 'Right';
	let base = Array.isArray(anchor) ? anchor : ANCHORS[anchor];
	if (base && !Array.isArray(base)) base = base[side];
	if (!base) throw new Error(`unknown motion anchor "${anchor}"`);
	const out = side === 'Left' ? (offset.out ?? 0) : -(offset.out ?? 0);
	return vAdd(
		base,
		vAdd(lateral(out), vAdd(above(offset.up ?? 0), ahead(offset.forward ?? 0))),
	);
}

/**
 * The same anchor, but placed on a POSED body: the rest point is expressed in
 * its carrier bone's frame and re-read through that bone's current rotation and
 * position. This is what keeps a hand target at the chin when the head turns.
 *
 * @param {import('./pose.js').Pose} pose
 * @param {string|number[]} anchor
 * @param {{ out?: number, up?: number, forward?: number, side?: 'Left'|'Right' }} [offset]
 * @returns {number[]} model-space point on the posed skeleton
 */
export function anchorPoint(pose, anchor, offset = {}) {
	const rest = restAnchor(anchor, offset);
	const bone = Array.isArray(anchor) ? null : ANCHOR_BONE[anchor];
	if (!bone || !hasBone(bone)) {
		// An unattached anchor still rides the root, so a body that walks forward
		// carries its gesture space with it, but a floor anchor stays on the floor.
		if (anchor === 'floor') return vAdd(rest, [pose.rootOffset[0], 0, pose.rootOffset[2]]);
		return vAdd(rest, pose.rootOffset);
	}
	const local = qRotate(qConj(restWorld(bone)), vSub(rest, restPos(bone)));
	return vAdd(pose.worldPos(bone), qRotate(pose.worldQuat(bone), local));
}

/**
 * A body-relative direction resolved against the POSED chest, so "palm forward"
 * means forward for the body rather than forward for the world.
 *
 * @param {import('./pose.js').Pose} pose
 * @param {string} name one of the DIRECTION keys
 * @param {'Left'|'Right'} [side]
 * @returns {number[]} unit world direction
 */
export function bodyDirection(pose, name, side = 'Right') {
	const local = DIRECTIONS[name];
	if (!local) throw new Error(`unknown motion direction "${name}"`);
	const bone = hasBone('Spine2') ? 'Spine2' : 'Hips';
	const mirrored = side === 'Right' && MIRRORED_DIRECTIONS.has(name)
		? vScale(local, -1)
		: local;
	return qRotate(pose.worldQuat(bone), qRotate(qConj(restWorld(bone)), mirrored));
}

/** Named directions in the body's own frame, for palms, gaze, and pointing. */
export const DIRECTIONS = Object.freeze({
	forward: BODY_FORWARD,
	back: vScale(BODY_FORWARD, -1),
	up: BODY_UP,
	down: vScale(BODY_UP, -1),
	/** Across the body toward the other side. Mirrored per acting hand. */
	in: BODY_LEFT,
	/** Away from the body on the acting side. Mirrored per acting hand. */
	out: vScale(BODY_LEFT, -1),
	left: BODY_LEFT,
	right: vScale(BODY_LEFT, -1),
});

// `in` and `out` are relative to the acting hand; the rest are absolute for the
// body, so a score can say "palm left" and mean the body's left on either hand.
const MIRRORED_DIRECTIONS = new Set(['in', 'out']);

/** A hand's width on the reference rig: the unit small offsets are written in. */
export const HAND_WIDTH = SHOULDER_SPAN * 0.22;
