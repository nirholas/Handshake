import { describe, it, expect } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Color } from 'three';
import { applyAvatarMaterialRealism, looksLikeAvatarMesh } from '../src/shared/avatar-material-realism.js';

// Real three.js objects (no WebGL context needed for Material/Object3D
// construction) — exercises the actual classification + upgrade path the
// viewer runs after loading a GLB, not a mocked stand-in.

function meshNamed(name) {
	const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0xe8b892 }));
	m.name = name;
	return m;
}

function buildAvatarRoot() {
	const root = new Group();
	root.add(meshNamed('Wolf3D_Skin'));
	root.add(meshNamed('Wolf3D_Head'));
	root.add(meshNamed('EyeLeft'));
	root.add(meshNamed('EyeRight'));
	root.add(meshNamed('Wolf3D_Hair'));
	root.add(meshNamed('Wolf3D_Teeth'));
	root.add(meshNamed('sword_prop')); // untouched — not a body-part name
	return root;
}

describe('looksLikeAvatarMesh', () => {
	it('detects a rig with skin/eye meshes', () => {
		expect(looksLikeAvatarMesh(buildAvatarRoot())).toBe(true);
	});

	it('returns false for a prop-only root', () => {
		const root = new Group();
		root.add(meshNamed('sword_prop'));
		root.add(meshNamed('shield'));
		expect(looksLikeAvatarMesh(root)).toBe(false);
	});

	it('is false for a non-Object3D input', () => {
		expect(looksLikeAvatarMesh(null)).toBe(false);
		expect(looksLikeAvatarMesh({})).toBe(false);
	});
});

describe('applyAvatarMaterialRealism', () => {
	it('upgrades skin/eye/hair/teeth materials and leaves props untouched', () => {
		const root = buildAvatarRoot();
		const counts = applyAvatarMaterialRealism(root);
		expect(counts).toEqual({ skin: 2, eye: 2, hair: 1, teeth: 1 });

		const skin = root.getObjectByName('Wolf3D_Skin').material;
		expect(skin.isMeshPhysicalMaterial).toBe(true);
		expect(skin.metalness).toBe(0);
		expect(skin.roughness).toBeGreaterThanOrEqual(0.45);
		expect(skin.roughness).toBeLessThanOrEqual(0.6);
		expect(skin.sheen).toBeGreaterThan(0);

		const eye = root.getObjectByName('EyeLeft').material;
		expect(eye.isMeshPhysicalMaterial).toBe(true);
		expect(eye.clearcoat).toBe(1);
		expect(eye.ior).toBeCloseTo(1.376);

		const hair = root.getObjectByName('Wolf3D_Hair').material;
		expect(hair.isMeshPhysicalMaterial).toBe(true);
		expect(hair.side).toBe(2); // THREE.DoubleSide

		const prop = root.getObjectByName('sword_prop').material;
		expect(prop.isMeshPhysicalMaterial).toBeUndefined();
	});

	it('is idempotent — running twice keeps the same tuned values', () => {
		const root = buildAvatarRoot();
		applyAvatarMaterialRealism(root);
		const skinBefore = root.getObjectByName('Wolf3D_Skin').material.roughness;
		applyAvatarMaterialRealism(root);
		const skinAfter = root.getObjectByName('Wolf3D_Skin').material.roughness;
		expect(skinAfter).toBe(skinBefore);
	});

	it('preserves the original albedo color while adding the sheen layer', () => {
		const root = new Group();
		const mesh = meshNamed('Wolf3D_Body');
		mesh.material.color = new Color(0.7, 0.3, 0.2);
		root.add(mesh);
		applyAvatarMaterialRealism(root);
		const mat = mesh.material;
		expect(mat.color.r).toBeCloseTo(0.7);
		expect(mat.color.g).toBeCloseTo(0.3);
		expect(mat.color.b).toBeCloseTo(0.2);
	});

	it('returns all-zero counts for a non-Object3D root', () => {
		expect(applyAvatarMaterialRealism(null)).toEqual({ skin: 0, eye: 0, hair: 0, teeth: 0 });
	});
});
