// @ts-check
// Avatar Composer — public entry point.
//
// One call turns a diversity profile + seed into a rigged, expression-ready GLB
// assembled from modular parts (see README.md). The caller supplies a `loadBase`
// function so this module stays I/O-free and runs the same in a test (read from
// disk), the seed cron (fetch from the site origin), or a worker.

import { composeAvatar } from './compose.js';
import { selectRecipe, basesNeeded } from './select.js';
import { BASES } from './parts.js';

export { composeAvatar } from './compose.js';
export { selectRecipe, basesNeeded } from './select.js';
export { BASES, BASE_BY_ID } from './parts.js';

/**
 * Compose one studio avatar end-to-end.
 *
 * @param {Object} opts
 * @param {{ gender?: 'male'|'female', ethnicityKey?: string, ageKey?: string, grayBias?: number, build?: string }} opts.profile
 * @param {string} opts.seed
 * @param {(baseId: string) => Promise<Uint8Array>} opts.loadBase  loads a base GLB's bytes by id
 * @returns {Promise<{ bytes: Uint8Array, recipe: object, descriptor: object, meshes: string[], recolored: string[] }>}
 */
export async function composeStudioAvatar({ profile, seed, loadBase }) {
	const recipe = selectRecipe(profile, seed);
	const ids = basesNeeded(recipe);
	/** @type {Record<string, Uint8Array>} */
	const bytesByBase = {};
	await Promise.all(
		ids.map(async (id) => {
			bytesByBase[id] = await loadBase(id);
		}),
	);
	const { bytes, meshes, recolored } = await composeAvatar(recipe, bytesByBase);
	const { descriptor, ...recipeCore } = recipe;
	return { bytes, recipe: recipeCore, descriptor, meshes, recolored };
}

/**
 * Rough count of distinct part-mesh combinations the catalog can produce, before
 * colorway/scale. Each identity draws swappable parts only from its own rest-pose
 * group, so the count sums over identities. Illustrative (docs/tests), not a hard
 * guarantee — the colorway (per-part tints across ~10 skin tones, 10 hair tints,
 * 10 outfit tints each) multiplies this into the tens of thousands.
 * @returns {number}
 */
export function combinationCount() {
	let total = 0;
	for (const id of BASES) {
		let n = 1;
		for (const slot of ['hair', 'top', 'bottom', 'footwear']) {
			const providers = BASES.filter((b) => b.provides.includes(slot) && b.restGroup === id.restGroup);
			n *= Math.max(1, providers.length);
		}
		const glasses = BASES.filter((b) => b.provides.includes('glasses') && b.restGroup === id.restGroup);
		n *= glasses.length + 1; // +none
		total += n;
	}
	return total;
}
