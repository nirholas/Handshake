// @ts-check
// Avatar Composer: parts catalog.
//
// The four Ready-Player-Me / Wolf3D base bodies shipped in public/avatars
// (realistic-male, realistic-female, default, selfie-girl) are not just five
// fixed avatars: they are a MODULAR PARTS KIT. Every one is rigged to a
// byte-identical 67-joint skeleton with identical joint ordering (verified), and
// every body part (hair, top, bottom, footwear, glasses) is a SEPARATE skinned
// mesh identified by its material name. Because the skeletons match, a hair mesh
// from one base and a top from another deform correctly on a third base's body.
//
// That is exactly how Ready Player Me and Avaturn build variety: one shared
// skeleton, swappable skinned parts. This catalog declares which base provides
// which slot, so the composer (compose.js) can mix them into avatars that are
// genuinely different meshes, not the recolor-one-of-five-bodies the studio lane
// shipped before.
//
// Slots split into two groups:
//   identity : head, body, eyes, teeth, beard. These come as a set from ONE
//               base (the "identity base"); they carry the face + its 60+ ARKit
//               blendshapes, so the composed avatar is expression-ready.
//   swappable: hair, top, bottom, footwear, glasses. Each is sourced
//               independently from any base that provides it (or omitted).

/** Material name → composer slot. A mesh's slot is the material it uses. */
export const MATERIAL_SLOT = {
	Wolf3D_Hair: 'hair',
	Wolf3D_Outfit_Top: 'top',
	Wolf3D_Outfit_Bottom: 'bottom',
	Wolf3D_Outfit_Footwear: 'footwear',
	Wolf3D_Glasses: 'glasses',
	Wolf3D_Head: 'head',
	Wolf3D_Skin: 'head',
	Wolf3D_Body: 'body',
	Wolf3D_Eye: 'eyes',
	Wolf3D_Teeth: 'teeth',
	Wolf3D_Beard: 'beard',
};

/** Slots that always travel together from the identity base (face + skin). */
export const IDENTITY_SLOTS = ['head', 'body', 'eyes', 'teeth', 'beard'];

/** Slots the composer mixes independently across bases. */
export const SWAPPABLE_SLOTS = ['hair', 'top', 'bottom', 'footwear', 'glasses'];

/**
 * Slot → colorway channel. The composer multiplies each material's
 * baseColorFactor by the channel color, exactly like the legacy recolorGlb but
 * per composed part. Head skin and body skin share one channel so the avatar is
 * one consistent complexion head-to-toe.
 */
export const SLOT_CHANNEL = {
	head: 'skin',
	body: 'skin',
	hair: 'hair',
	top: 'top',
	bottom: 'bottom',
	footwear: 'footwear',
};

/**
 * @typedef {Object} BaseBody
 * @property {string} id        catalog id (also the public/avatars/<id>.glb filename)
 * @property {string} file      GLB filename under public/avatars
 * @property {'male'|'female'} gender  body/face gender of the identity slots
 * @property {string} label     human label
 * @property {string} restGroup  rest-pose compatibility group (see note below)
 * @property {string[]} provides  swappable slots this base can donate
 */

/**
 * The base bodies, with the swappable slots each can donate. Inventory verified
 * by reading each GLB's meshes (by material). `michelle` is intentionally
 * excluded: it is a single-mesh Mixamo body on a different 65-joint skeleton, so
 * its parts are not skeleton-compatible with the RPM family.
 *
 * restGroup: a part authored for one body sits at that body's proportions. When
 * grafted onto a body with a DIFFERENT rest pose (skeleton bind proportions) the
 * part keeps its own vertices, so it can float or misfit (measured: feet detach
 * across groups). Bodies are grouped by rest pose (Hips bind height + limb rest
 * translations) so the composer only ever mixes parts WITHIN a group, where the
 * fit is exact. Measured Hips bind heights: realistic-male 0.967, realistic-female
 * 1.009 (group "a"); default and selfie-girl 1.037 (group "b"). Cross-group mixing
 * needs true vertex rebinding: the planned v2.
 *
 * @type {BaseBody[]}
 */
export const BASES = [
	{ id: 'realistic-male', file: 'realistic-male.glb', gender: 'male', label: 'Realistic male', restGroup: 'a', provides: ['hair', 'top', 'bottom', 'footwear', 'glasses'] },
	{ id: 'realistic-female', file: 'realistic-female.glb', gender: 'female', label: 'Realistic female', restGroup: 'a', provides: ['hair', 'top', 'bottom', 'footwear'] },
	{ id: 'default', file: 'default.glb', gender: 'male', label: 'Default', restGroup: 'b', provides: ['hair', 'top', 'bottom', 'footwear', 'glasses'] },
	{ id: 'selfie-girl', file: 'selfie-girl.glb', gender: 'female', label: 'Selfie girl', restGroup: 'b', provides: ['hair', 'top', 'bottom', 'footwear', 'glasses'] },
];

export const BASE_BY_ID = Object.fromEntries(BASES.map((b) => [b.id, b]));

/** Bases that can serve as an identity (all of them). */
export function basesForGender(gender) {
	return BASES.filter((b) => b.gender === gender);
}

/**
 * Bases that can donate a given slot to `identity` with an exact fit: the
 * identity itself plus any base in the same rest-pose group. Restricting to the
 * group is what keeps grafted parts from floating (see restGroup note above).
 * @param {string} slot
 * @param {BaseBody} identity
 */
export function compatibleProviders(slot, identity) {
	return BASES.filter((b) => b.provides.includes(slot) && b.restGroup === identity.restGroup);
}
