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

/** Below this share of *weighted* garment bones resolving to avatar bones, the
 *  garment cannot deform sanely and is refused rather than shipped mangled. */
export const MIN_BIND_COVERAGE = 0.6;
