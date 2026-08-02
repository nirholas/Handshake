/**
 * /irl avatar material realism: wiring regression.
 *
 * The realism module (src/shared/avatar-material-realism.js) is what makes an
 * avatar read as a person standing on your floor instead of a plastic figurine.
 * It shipped wired into the /avatar viewer only, so for a while /irl, the one
 * surface where the avatar stands in the user's actual room, rendered the flat
 * glTF materials the forge lane exported. A headless readback of the page caught
 * it (every material MeshStandardMaterial, sheen/clearcoat/ior null).
 *
 * Wiring like that is invisible once it works and silent when it breaks, so
 * these assert the contract in source: both AR surfaces import the SHARED module
 * (never a second copy of the tuning), gate on `looksLikeAvatarMesh` so props are
 * left alone, and, on the pin crowd, where a plaza can hold eight rigs at once, 
 * respect the device tier.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { BUDGETS, TIER_ORDER } from '../src/irl/perf-budget.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

describe('perf budgets carry a realism decision per tier', () => {
	it('declares realism explicitly for every tier', () => {
		for (const tier of TIER_ORDER) {
			expect(typeof BUDGETS[tier].realism, `${tier}.realism`).toBe('boolean');
		}
	});

	it('keeps physical shading off the low tier and on everywhere else', () => {
		// The low tier budgets two concurrent avatars, no shadows, DPR 1. A phone
		// that lands there cannot also afford sheen + clearcoat shader compiles.
		expect(BUDGETS.low.realism).toBe(false);
		expect(BUDGETS.mid.realism).toBe(true);
		expect(BUDGETS.high.realism).toBe(true);
	});
});

describe('src/irl.js applies the shared realism pass to avatars', () => {
	const src = read('src/irl.js');

	it('imports the shared module rather than re-tuning materials locally', () => {
		expect(src).toMatch(
			/import \{[^}]*applyAvatarMaterialRealism[^}]*\} from '\.\/shared\/avatar-material-realism\.js'/,
		);
		// A second local definition of the tuning would drift from the viewer's.
		expect(src).not.toMatch(/function applyAvatarMaterialRealism\b/);
	});

	it('gates the pass on the device tier and on the rig being an avatar', () => {
		const fn = src.match(/function dressAvatarMaterials\(root\) \{[\s\S]*?\n\}/)?.[0];
		expect(fn, 'dressAvatarMaterials should exist').toBeTruthy();
		expect(fn).toContain('budget.realism');
		expect(fn).toContain('looksLikeAvatarMesh(root)');
		expect(fn).toContain('applyAvatarMaterialRealism(root)');
	});

	it('runs it on the player avatar and on every pin avatar', () => {
		// Both mount sites, or half the scene stays plastic.
		expect(src.match(/dressAvatarMaterials\(/g)?.length).toBeGreaterThanOrEqual(3);
	});

	it('dresses materials before the texture sharpening that reads them', () => {
		// The pass REPLACES material objects; sharpening first would key off
		// materials that are about to be thrown away.
		const fn = src.match(/function dressAvatarMaterials\(root\) \{[\s\S]*?\n\}/)[0];
		expect(fn.indexOf('applyAvatarMaterialRealism')).toBeLessThan(fn.indexOf('sharpenModelTextures'));
	});
});

describe('the world-line AR ceremony dresses its quest agent too', () => {
	const src = read('src/irl/world-line-ar.js');

	it('imports the shared module', () => {
		expect(src).toMatch(
			/import \{[^}]*applyAvatarMaterialRealism[^}]*\} from '\.\.\/shared\/avatar-material-realism\.js'/,
		);
	});

	it('dresses both the preview panel and the immersive-AR avatar', () => {
		// The non-AR panel is a first-class surface here, not a fallback, so both
		// paths get the same treatment.
		expect(src.match(/dressAvatar\(/g)?.length).toBeGreaterThanOrEqual(3);
	});

	it('still leaves non-avatar models alone', () => {
		const fn = src.match(/function dressAvatar\(root\) \{[\s\S]*?\n\}/)?.[0];
		expect(fn).toContain('looksLikeAvatarMesh(root)');
	});
});
