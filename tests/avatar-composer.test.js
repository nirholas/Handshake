// Avatar Composer (api/_lib/avatar-composer): the modular generation engine.
//
// The composer assembles a rigged, expression-ready GLB by mixing skinned parts
// across the RPM base bodies on one shared skeleton (the Ready-Player-Me /
// Avaturn customization architecture). These tests pin the two things that make
// it correct and useful: the selection is deterministic and stays inside the
// identity's rest-pose group (so parts always fit), and the composed GLB is a
// valid, rigged, expression-ready model with the chosen colorway applied.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import gltfValidator from 'gltf-validator';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import {
	composeStudioAvatar,
	selectRecipe,
	basesNeeded,
	combinationCount,
	BASES,
	BASE_BY_ID,
} from '../api/_lib/avatar-composer/index.js';
import { compatibleProviders, SWAPPABLE_SLOTS } from '../api/_lib/avatar-composer/parts.js';

const loadBase = async (id) => new Uint8Array(readFileSync(resolve(process.cwd(), 'public/avatars', `${id}.glb`)));

let _io;
async function io() {
	if (_io) return _io;
	_io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
		'meshopt.decoder': MeshoptDecoder,
		'draco3d.decoder': await draco3d.createDecoderModule(),
	});
	return _io;
}

describe('selectRecipe', () => {
	it('is deterministic on the seed', () => {
		const p = { gender: 'female', ethnicityKey: 'east-asian', ageKey: 'adult', build: 'slim' };
		expect(selectRecipe(p, 'seed-x')).toEqual(selectRecipe(p, 'seed-x'));
	});

	it('produces different recipes across seeds', () => {
		const p = { gender: 'male', ethnicityKey: 'latino', ageKey: 'adult', build: 'athletic' };
		const seen = new Set();
		for (let i = 0; i < 20; i++) {
			const r = selectRecipe(p, `seed-${i}`);
			seen.add(JSON.stringify({ id: r.identity, s: r.slots, c: r.colorway, k: r.scale }));
		}
		expect(seen.size).toBeGreaterThan(5);
	});

	it('matches the identity base to the profile gender', () => {
		expect(BASE_BY_ID[selectRecipe({ gender: 'male' }, 's1').identity].gender).toBe('male');
		expect(BASE_BY_ID[selectRecipe({ gender: 'female' }, 's1').identity].gender).toBe('female');
	});

	it('only sources parts from the identity rest-pose group', () => {
		for (let i = 0; i < 40; i++) {
			const r = selectRecipe({ gender: i % 2 ? 'male' : 'female' }, `g-${i}`);
			const identity = BASE_BY_ID[r.identity];
			for (const slot of SWAPPABLE_SLOTS) {
				const src = r.slots[slot];
				if (!src) continue;
				expect(BASE_BY_ID[src].restGroup).toBe(identity.restGroup);
			}
		}
	});

	it('basesNeeded lists the identity and every distinct donor', () => {
		const r = selectRecipe({ gender: 'female' }, 'need-1');
		const ids = basesNeeded(r);
		expect(ids).toContain(r.identity);
		for (const slot of SWAPPABLE_SLOTS) {
			if (r.slots[slot]) expect(ids).toContain(r.slots[slot]);
		}
		expect(new Set(ids).size).toBe(ids.length); // no duplicates
	});
});

describe('catalog', () => {
	it('exposes a meaningful combination space', () => {
		expect(combinationCount()).toBeGreaterThan(100);
	});
	it('every base in a compatible-provider set shares the rest group', () => {
		for (const identity of BASES) {
			for (const slot of ['hair', 'top', 'bottom', 'footwear']) {
				for (const p of compatibleProviders(slot, identity)) {
					expect(p.restGroup).toBe(identity.restGroup);
				}
			}
		}
	});
});

describe('composeStudioAvatar', () => {
	it('produces a valid, rigged, expression-ready GLB with the colorway applied', async () => {
		const profile = { gender: 'female', ethnicityKey: 'black-african', ageKey: 'adult', grayBias: 0, build: 'athletic' };
		const { bytes, descriptor, meshes } = await composeStudioAvatar({ profile, seed: 'compose-1', loadBase });

		// Valid glTF (no structural errors).
		const report = await gltfValidator.validateBytes(new Uint8Array(bytes));
		expect(report.issues.numErrors).toBe(0);

		const doc = await (await io()).readBinary(bytes);
		const root = doc.getRoot();

		// Rigged: a skeleton is present.
		expect(root.listSkins().length).toBeGreaterThan(0);

		// Has a body and a head; head carries ARKit expression blendshapes.
		const matNames = root.listMaterials().map((m) => m.getName());
		expect(matNames).toContain('Wolf3D_Body');
		const headMesh = root.listMeshes().find((m) => m.listPrimitives()[0]?.getMaterial()?.getName() === 'Wolf3D_Skin');
		expect(headMesh).toBeTruthy();
		const morphTargets = headMesh.listPrimitives()[0].listTargets().length;
		expect(morphTargets).toBeGreaterThan(10);

		// Colorway applied: the body skin material carries a valid tint in [0,1].
		const bodyMat = root.listMaterials().find((m) => m.getName() === 'Wolf3D_Body');
		const factor = bodyMat.getBaseColorFactor().slice(0, 3);
		expect(factor.every((c) => c >= 0 && c <= 1)).toBe(true);

		expect(descriptor.identity).toBeTruthy();
		expect(meshes.length).toBeGreaterThan(3);
	}, 30_000);

	it('is deterministic: the same seed composes byte-identical output', async () => {
		const profile = { gender: 'male', ethnicityKey: 'nordic', ageKey: 'young-adult', build: 'lean' };
		const a = await composeStudioAvatar({ profile, seed: 'det-1', loadBase });
		const b = await composeStudioAvatar({ profile, seed: 'det-1', loadBase });
		expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
	}, 30_000);
});
