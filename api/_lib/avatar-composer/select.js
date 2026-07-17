// @ts-check
// Avatar Composer: seeded recipe selection.
//
// Turns a diversity profile + seed into a concrete compose recipe: which base is
// the identity, which base donates each swappable part, whether to wear glasses,
// the colorway, and the height scale. Fully deterministic on the seed, so the
// same seed always yields the same avatar (reproducible gallery, safe re-render).
//
// The palette (skin/hair/outfit tints, height scale) is reused verbatim from the
// legacy studio lane (studio-avatar.js) so there is one source of truth for
// color; the NEW capability here is choosing DIFFERENT part meshes per slot,
// which the legacy lane could not do.

import { pickColorway, pickScale } from '../studio-avatar.js';
import { basesForGender, compatibleProviders, SWAPPABLE_SLOTS } from './parts.js';

function hashSeed(str) {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}
function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const pickFrom = (arr, rng) => arr[Math.floor(rng() * arr.length)];

// Probability an avatar wears glasses. Kept a minority so the gallery isn't all
// bespectacled, but common enough to be a real variety axis.
const GLASSES_CHANCE = 0.28;

/**
 * Build a compose recipe from a diversity profile + seed.
 *
 * Part meshes are drawn from any base in the identity's rest-pose group (the
 * identity plus its compatible partner), regardless of the donor's gender: a
 * jacket or hairstyle reads on either body, and the cross-sourcing plus per-part
 * recolor and scale is what produces the variety (vs. the five fixed bodies the
 * recolor lane had). The identity base (face + body + skin) matches the profile's
 * gender; grafted parts always fit because they share the identity's rest pose.
 *
 * @param {{ gender?: 'male'|'female', ethnicityKey?: string, ageKey?: string, grayBias?: number, build?: string }} profile
 * @param {string} seed
 * @returns {import('./compose.js').ComposeRecipe & { descriptor: object }}
 */
export function selectRecipe(profile, seed) {
	const gender = profile?.gender === 'male' ? 'male' : 'female';
	const identity = pickFrom(basesForGender(gender), mulberry32(hashSeed(seed + ':identity')));

	/** @type {Record<string,string|null>} */
	const slots = {};
	for (const slot of SWAPPABLE_SLOTS) {
		const providers = compatibleProviders(slot, identity);
		if (slot === 'glasses') {
			const rng = mulberry32(hashSeed(seed + ':glasses'));
			slots.glasses = rng() < GLASSES_CHANCE && providers.length ? pickFrom(providers, rng).id : null;
			continue;
		}
		if (!providers.length) { slots[slot] = null; continue; }
		slots[slot] = pickFrom(providers, mulberry32(hashSeed(seed + ':' + slot))).id;
	}

	const colorway = pickColorway(profile, seed);
	const scale = pickScale(profile, seed);

	return {
		identity: identity.id,
		slots,
		colorway,
		scale,
		descriptor: {
			identity: identity.id,
			gender,
			parts: { ...slots },
			glasses: !!slots.glasses,
			scale,
		},
	};
}

/**
 * The set of base ids a recipe needs bytes for (identity + every distinct donor).
 * @param {import('./compose.js').ComposeRecipe} recipe
 * @returns {string[]}
 */
export function basesNeeded(recipe) {
	const ids = new Set([recipe.identity]);
	for (const slot of SWAPPABLE_SLOTS) {
		const src = recipe.slots?.[slot];
		if (src) ids.add(src);
	}
	return [...ids];
}
