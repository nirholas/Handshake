/**
 * Garment catalog — validation and loading, per specs/GARMENT_MANIFEST.md.
 *
 * The catalog is the trust boundary between generated/authored assets and a
 * user's avatar: everything that renders as a wardrobe tile passed through
 * validateManifest. These tests pin the rejection rules — especially the ones
 * that protect users (licence gate, hash shape, unknown regions) — and the
 * cache semantics of loadCatalog.
 */

import { describe, it, expect } from 'vitest';
import {
	GARMENT_SPEC_URI,
	bySlot,
	loadCatalog,
	sanitizeCatalog,
	validateManifest,
	verifyModelBytes,
} from '../src/garment-catalog.js';

function validManifest(overrides = {}) {
	return {
		spec: GARMENT_SPEC_URI,
		id: 'oxford-shirt-white',
		name: 'Oxford Shirt',
		slot: 'top',
		version: 1,
		model: {
			uri: 'https://storage.googleapis.com/three-ws-garments/garments/top/oxford-shirt-white/v1/garment.glb',
			format: 'gltf-binary',
			sha256: 'a'.repeat(64),
		},
		rig: { skeleton: 'three.ws-canonical-v1' },
		occludes: ['torso', 'upperArms'],
		license: 'CC0-1.0',
		...overrides,
	};
}

describe('validateManifest', () => {
	it('accepts a spec-complete manifest', () => {
		expect(validateManifest(validManifest())).toEqual({ ok: true, errors: [] });
	});

	it('accepts empty occludes (glasses, earrings)', () => {
		expect(validateManifest(validManifest({ occludes: [] })).ok).toBe(true);
	});

	it.each([
		['unknown spec', { spec: 'https://three.ws/specs/garment-manifest-v2' }, /unknown spec/],
		['non-kebab id', { id: 'Oxford_Shirt' }, /kebab-case/],
		['unknown slot', { slot: 'cape' }, /unknown slot/],
		['http model uri', { model: { uri: 'http://x.test/g.glb', format: 'gltf-binary', sha256: 'a'.repeat(64) } }, /protocol/],
		['bad hash', { model: { uri: 'https://x.test/g.glb', format: 'gltf-binary', sha256: 'zz' } }, /sha256/],
		['foreign skeleton', { rig: { skeleton: 'mixamo-v1' } }, /rig\.skeleton/],
		['unknown region', { occludes: ['tail'] }, /unknown body region/],
		['no licence', { license: undefined }, /licence/],
		['non-commercial licence', { license: 'CC-BY-NC-4.0' }, /licence/],
	])('rejects %s', (_label, overrides, msg) => {
		const { ok, errors } = validateManifest(validManifest(overrides));
		expect(ok).toBe(false);
		expect(errors.join(' | ')).toMatch(msg);
	});
});

describe('sanitizeCatalog', () => {
	it('keeps valid entries, drops and reports broken ones', () => {
		const { garments, rejected } = sanitizeCatalog([
			validManifest(),
			validManifest({ id: 'denim-jacket', slot: 'outerwear' }),
			validManifest({ id: 'bad-hash', model: { uri: 'https://x.test/g.glb', format: 'gltf-binary', sha256: 'nope' } }),
		]);
		expect(garments.map((g) => g.id)).toEqual(['oxford-shirt-white', 'denim-jacket']);
		expect(rejected).toHaveLength(1);
		expect(rejected[0].id).toBe('bad-hash');
	});

	it('rejects a duplicate id within a slot', () => {
		const { garments, rejected } = sanitizeCatalog([validManifest(), validManifest()]);
		expect(garments).toHaveLength(1);
		expect(rejected[0].errors.join()).toMatch(/duplicate/);
	});

	it('tolerates a non-array payload', () => {
		expect(sanitizeCatalog({ oops: true })).toEqual({ garments: [], rejected: [] });
	});
});

describe('bySlot', () => {
	it('groups by slot preserving order', () => {
		const grouped = bySlot([
			validManifest(),
			validManifest({ id: 'tee-black' }),
			validManifest({ id: 'denim-jacket', slot: 'outerwear' }),
		]);
		expect(grouped.get('top').map((g) => g.id)).toEqual(['oxford-shirt-white', 'tee-black']);
		expect(grouped.get('outerwear')).toHaveLength(1);
	});
});

describe('loadCatalog', () => {
	const okFetch = (payload) => async () => ({ ok: true, json: async () => payload });

	it('fetches, validates, and caches per session', async () => {
		let calls = 0;
		const fetchImpl = async () => { calls++; return { ok: true, json: async () => [validManifest()] }; };
		const a = await loadCatalog({ force: true, url: 'https://t.test/c.json', fetchImpl });
		const b = await loadCatalog({ url: 'https://t.test/c.json', fetchImpl });
		expect(a.garments).toHaveLength(1);
		expect(b).toBe(a);
		expect(calls).toBe(1);
	});

	it('force refetches', async () => {
		let calls = 0;
		const fetchImpl = async () => { calls++; return { ok: true, json: async () => [] }; };
		await loadCatalog({ force: true, url: 'https://t.test/c.json', fetchImpl });
		await loadCatalog({ force: true, url: 'https://t.test/c.json', fetchImpl });
		expect(calls).toBe(2);
	});

	it('does not cache a failed fetch', async () => {
		// A dropped connection is retried before giving up, so the count is the
		// attempt budget rather than one. What must hold is that the FAILURE is
		// not cached: the next call fetches again and succeeds.
		let calls = 0;
		const failing = async () => { calls++; throw new Error('offline'); };
		await expect(loadCatalog({ force: true, url: 'https://t.test/c.json', fetchImpl: failing }))
			.rejects.toThrow('offline');
		expect(calls).toBeGreaterThan(0);
		const attemptsSpent = calls;
		const ok = await loadCatalog({ url: 'https://t.test/c.json', fetchImpl: okFetch([validManifest()]) });
		expect(ok.garments).toHaveLength(1);
		expect(calls).toBe(attemptsSpent);
	});
});

describe('verifyModelBytes', () => {
	it('accepts matching bytes and rejects tampered ones', async () => {
		const bytes = new TextEncoder().encode('glTF-bytes').buffer;
		const digest = await crypto.subtle.digest('SHA-256', bytes);
		const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

		const manifest = validManifest({ model: { uri: 'https://x.test/g.glb', format: 'gltf-binary', sha256: hex } });
		expect(await verifyModelBytes(bytes, manifest)).toBe(true);

		const tampered = new TextEncoder().encode('glTF-bytes!').buffer;
		expect(await verifyModelBytes(tampered, manifest)).toBe(false);
	});
});
