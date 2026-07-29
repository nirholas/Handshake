// Garment taxonomy — the shared vocabulary of the additive wardrobe.
//
// Pure constants, no three.js, no DOM: imported by the client runtime
// (src/avatar-garment.js, src/garment-catalog.js), the server-side baker
// (api/_lib/bake-garments.js), and mirrored by the zod schema in
// api/_lib/validate.js. Change a slot or region HERE and in the spec
// (specs/GARMENT_MANIFEST.md) — nowhere else.

/** Slots a garment may occupy. One garment per slot; attaching to an occupied
 *  slot detaches the incumbent. */
export const GARMENT_SLOTS = Object.freeze([
	'top', 'bottom', 'footwear', 'outerwear', 'hair', 'headwear', 'glasses', 'accessory',
]);

/** Body regions a garment can claim in its manifest's `occludes`. The body's
 *  skin is masked in every claimed region so it cannot poke through cloth. */
export const BODY_REGIONS = Object.freeze([
	'torso', 'upperArms', 'lowerArms', 'hands',
	'hips', 'upperLegs', 'lowerLegs', 'feet', 'neck', 'scalp',
]);

/** Canonical bones that own each body region, for mask-free occlusion culling. */
export const REGION_BONES = Object.freeze({
	torso: ['Spine', 'Spine1', 'Spine2'],
	upperArms: ['LeftArm', 'RightArm'],
	lowerArms: ['LeftForeArm', 'RightForeArm'],
	hands: ['LeftHand', 'RightHand'],
	hips: ['Hips'],
	upperLegs: ['LeftUpLeg', 'RightUpLeg'],
	lowerLegs: ['LeftLeg', 'RightLeg'],
	feet: ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'],
	neck: ['Neck'],
	scalp: ['Head'],
});

/** Regions each slot is allowed to occlude, enforced wherever a manifest's
 *  `occludes` is APPLIED (closet, baker), not just where it is generated.
 *  Two constraints meet here: plausibility (a shirt's waistband graze must not
 *  hide the legs) and granularity (`scalp` resolves to the Head bone, and
 *  Head-bone occlusion cannot separate scalp from face: culling it deletes
 *  the avatar's face, so no slot may claim it; caps and hair simply cover). */
export const SLOT_OCCLUDABLE = Object.freeze({
	top: ['torso', 'upperArms', 'lowerArms', 'neck', 'hips', 'upperLegs'],
	outerwear: ['torso', 'upperArms', 'lowerArms', 'neck', 'hips', 'upperLegs'],
	bottom: ['hips', 'upperLegs', 'lowerLegs'],
	footwear: ['feet', 'lowerLegs'],
	hair: [],
	headwear: [],
	glasses: [],
	accessory: [],
});

/** A manifest's `occludes` filtered to what its slot may actually hide. */
export function clampOccludes(slot, occludes) {
	const allowed = SLOT_OCCLUDABLE[slot] || [];
	return (Array.isArray(occludes) ? occludes : []).filter((r) => allowed.includes(r));
}

/** Largest plausible size for a worn garment, as a multiple of the avatar's
 *  own height. The wearer-side twin of the forge's per-slot `max_extent`
 *  publish gate (workers/garment-forge/garment_glb.py): that one stops a
 *  malformed mesh being published, this one stops an already-published or
 *  third-party malformed mesh being WORN.
 *
 *  A generator asked for "long straight hair" returned a mesh 1.43 m deep on a
 *  1.667 m body (0.86x its height) whose width profile was still perfect, so
 *  every skinning gate passed it. Nothing a person wears spans most of their
 *  own height on all axes: a full-length coat is ~0.55x tall and far less
 *  deep, so 0.75x on any one axis sits above every real garment and well
 *  below a runaway mesh. */
export const MAX_GARMENT_EXTENT_RATIO = 0.75;

/** Below this share of *weighted* garment bones resolving to avatar bones, the
 *  garment cannot deform sanely and is refused rather than shipped mangled. */
export const MIN_BIND_COVERAGE = 0.6;

/** Pixel codes for the baked body-region occlusion mask
 *  (scripts/build-body-region-mask.mjs → parametric-base.regions.png).
 *  Spread values (not 1..10) so a resampled/filtered read still snaps to the
 *  right region: codes are 24 apart, so up to ±11 of interpolation error is
 *  recoverable by nearest-code matching. 0 = unassigned. */
export const REGION_MASK_VALUES = Object.freeze(
	Object.fromEntries(BODY_REGIONS.map((region, i) => [region, (i + 1) * 24])),
);
