/**
 * GarmentCloset#withGarmentsOff: the guard that keeps Avatar Studio's
 * create-mode save from dressing an avatar twice.
 *
 * Two different things carry a garment: the live scene (skinned meshes bound to
 * the avatar's skeleton, plus the skin occlusion they impose) and the appearance
 * record's `garments` array. Studio's create-mode save uploads a GLTFExporter
 * dump of the live scene as the new avatar's BASE model and PATCHes the
 * appearance beside it, and the server bake replays `appearance.garments` onto
 * that base (api/_lib/bake-garments.js). Export the dressed scene and every
 * garment lands on the avatar twice, on top of a base the owner can never get
 * back. That is the same class of bug the edit-mode save already had to fix.
 *
 * So the export runs with the garments off the rig and the record untouched.
 * The invariants: the scene is stripped, `working.garments` is NOT, and the
 * outfit is back on the body afterwards, whatever the callback did.
 */

import { describe, it, expect, vi } from 'vitest';

// The closet's real attach path parses GLB bytes through GLTFLoader and the
// meshopt decoder. That is covered by tests/avatar-garment.test.js against real
// geometry; here the subject is the detach/restore bookkeeping around it, so the
// scene-graph collaborators are stubbed to keep the contract legible.
const detached = [];
const attached = [];
vi.mock('../src/avatar-garment.js', () => ({
	attachGarment: (root, scene, opts) => {
		attached.push(opts.slot);
		return { ok: true, slot: opts.slot, meshes: [], coverage: 1 };
	},
	detachSlot: (root, slot) => { detached.push(slot); },
	supportsWardrobe: () => true,
	applySkinOcclusion: () => {},
	restoreSkin: () => {},
	findAvatarSkeleton: () => null,
	GARMENT_SLOTS: ['top', 'bottom', 'footwear', 'outerwear', 'hair', 'headwear', 'glasses', 'accessory'],
}));

const { GarmentCloset } = await import('../src/garment-closet.js');

function makeCloset(working) {
	const closet = new GarmentCloset({
		getRoot: () => ({ name: 'Armature' }),
		getWorking: () => working,
	});
	// Stand in for the download + parse: everything after it is what is on test.
	closet._fetchModel = async () => new ArrayBuffer(8);
	closet._getLoader = async () => ({ parseAsync: async () => ({ scene: {} }) });
	return closet;
}

const SHIRT = { id: 'oxford-shirt', slot: 'top', name: 'Oxford shirt', model: { uri: 'shirt.glb' } };
const BOOTS = { id: 'boots', slot: 'footwear', name: 'Boots', model: { uri: 'boots.glb' } };

// verifyModelBytes hashes the download against the manifest; there is no real
// download here, so the integrity gate is satisfied directly.
vi.mock('../src/garment-catalog.js', async (importOriginal) => ({
	...(await importOriginal()),
	verifyModelBytes: async () => true,
}));

describe('withGarmentsOff', () => {
	it('takes every garment off the rig for the callback and puts it back after', async () => {
		const working = { garments: [] };
		const closet = makeCloset(working);
		await closet.attach(SHIRT);
		await closet.attach(BOOTS);
		expect([...closet.attached().keys()].sort()).toEqual(['footwear', 'top']);

		detached.length = 0;
		attached.length = 0;
		let sawDuringCallback = null;
		await closet.withGarmentsOff(async () => {
			sawDuringCallback = [...closet.attached().keys()];
		});

		// Stripped for the export...
		expect(sawDuringCallback).toEqual([]);
		// attach() also evicts its own slot before binding, so count distinct slots.
		expect([...new Set(detached)].sort()).toEqual(['footwear', 'top']);
		// ...and dressed again afterwards.
		expect([...closet.attached().keys()].sort()).toEqual(['footwear', 'top']);
		expect(attached.sort()).toEqual(['footwear', 'top']);
	});

	it('leaves the appearance record alone, because the bake replays it', async () => {
		const working = { garments: [] };
		const closet = makeCloset(working);
		await closet.attach(SHIRT);
		const recorded = JSON.stringify(working.garments);
		expect(recorded).toBe(JSON.stringify([{ slot: 'top', id: 'oxford-shirt' }]));

		await closet.withGarmentsOff(async () => {
			// The export reads the record too; it must still describe the outfit.
			expect(JSON.stringify(working.garments)).toBe(recorded);
		});
		expect(JSON.stringify(working.garments)).toBe(recorded);
	});

	it('returns what the callback returned', async () => {
		const closet = makeCloset({ garments: [] });
		await closet.attach(SHIRT);
		await expect(closet.withGarmentsOff(async () => 'glb-blob')).resolves.toBe('glb-blob');
	});

	it('re-dresses the avatar even when the export throws', async () => {
		const closet = makeCloset({ garments: [] });
		await closet.attach(SHIRT);
		await expect(
			closet.withGarmentsOff(async () => { throw new Error('export failed'); }),
		).rejects.toThrow('export failed');
		expect([...closet.attached().keys()]).toEqual(['top']);
	});

	it('is a straight pass-through when nothing is worn', async () => {
		const closet = makeCloset({ garments: [] });
		detached.length = 0;
		await expect(closet.withGarmentsOff(async () => 'ok')).resolves.toBe('ok');
		expect(detached).toEqual([]);
	});
});
