/**
 * Additive wardrobe — unit tests for src/avatar-garment.js.
 *
 * Builds synthetic avatars and garments in-memory (no GLB fixtures), so the
 * suite is fast and deterministic. The contract under test is that a garment
 * authored against its *own* skeleton, with its own naming convention and its
 * own rest pose, deforms identically to the avatar's body once rebound:
 *
 *   - garment bone indices rewritten into avatar bone order,
 *   - vendor-prefixed / foreign naming still resolves (mixamorig:, VRM, .L/.R),
 *   - helper joints the avatar lacks fall back to their nearest mapped ancestor,
 *   - unresolvable weights are zeroed and the vertex renormalised,
 *   - a divergent rest pose is reconciled, not baked in as an offset,
 *   - a garment that cannot bind is refused rather than attached mangled,
 *   - skin under a garment is culled and the cull is reversible.
 */

import { describe, it, expect } from 'vitest';
import {
	Bone,
	BufferGeometry,
	Float32BufferAttribute,
	Group,
	Matrix4,
	MeshStandardMaterial,
	Skeleton,
	SkinnedMesh,
	Uint16BufferAttribute,
	Vector3,
} from 'three';
import {
	MIN_BIND_COVERAGE,
	attachGarment,
	bindCoverage,
	buildBoneRemap,
	cullSkinByBones,
	detachSlot,
	findAvatarSkeleton,
	occupiedSlots,
	reindexBoneInverses,
	remapSkinAttributes,
	restoreSkin,
	supportsWardrobe,
} from '../src/avatar-garment.js';

/* ── helpers ─────────────────────────────────────────────────────────────── */

/**
 * A minimal humanoid chain: Hips → Spine → Head, plus LeftArm off the spine.
 * `names` lets a caller rename every joint to test foreign conventions, and
 * `spineY` moves the rest pose so divergent-bind-pose cases are expressible.
 */
function buildRig({ prefix = '', spineY = 2, extraBones = [] } = {}) {
	const mk = (n) => { const b = new Bone(); b.name = prefix + n; return b; };
	const hips = mk('Hips');
	const spine = mk('Spine');
	const head = mk('Head');
	const leftArm = mk('LeftArm');

	spine.position.set(0, spineY, 0);
	head.position.set(0, 1, 0);
	leftArm.position.set(0.5, 0.5, 0);

	hips.add(spine);
	spine.add(head);
	spine.add(leftArm);

	const bones = [hips, spine, head, leftArm];
	for (const { name, parent, position } of extraBones) {
		const b = mk(name);
		b.position.copy(position || new Vector3(0, 0.1, 0));
		(bones.find((x) => x.name === prefix + parent) || spine).add(b);
		bones.push(b);
	}

	hips.updateMatrixWorld(true);
	return { bones, hips, spine, head, leftArm, skeleton: new Skeleton(bones) };
}

/** One-vertex-per-entry skinned mesh, each vertex fully weighted to one bone. */
function buildSkinnedMesh(skeleton, verts) {
	const geometry = new BufferGeometry();
	const positions = [];
	const skinIndices = [];
	const skinWeights = [];
	for (const { pos, bone, weights } of verts) {
		positions.push(pos.x, pos.y, pos.z);
		if (weights) {
			skinIndices.push(...weights.map((w) => w[0]), ...Array(4 - weights.length).fill(0));
			skinWeights.push(...weights.map((w) => w[1]), ...Array(4 - weights.length).fill(0));
		} else {
			skinIndices.push(bone, 0, 0, 0);
			skinWeights.push(1, 0, 0, 0);
		}
	}
	geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
	geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndices, 4));
	geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeights, 4));

	const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial());
	mesh.add(skeleton.bones[0]);
	mesh.bind(skeleton);
	mesh.updateMatrixWorld(true);
	return mesh;
}

function buildAvatar({ spineY = 2, prefix = '' } = {}) {
	const rig = buildRig({ prefix, spineY });
	const mesh = buildSkinnedMesh(rig.skeleton, [
		{ pos: new Vector3(0, spineY + 0.5, 0), bone: 1 },   // torso vertex on Spine
		{ pos: new Vector3(0, spineY + 1.0, 0), bone: 2 },   // head vertex
	]);
	const root = new Group();
	root.add(mesh);
	root.updateMatrixWorld(true);
	return { root, mesh, ...rig };
}

/* ── bone remapping ──────────────────────────────────────────────────────── */

describe('buildBoneRemap', () => {
	it('maps identically-named skeletons one-to-one', () => {
		const avatar = buildRig();
		const garment = buildRig();
		const { remap, unresolved } = buildBoneRemap(garment.skeleton, avatar.skeleton);
		expect([...remap]).toEqual([0, 1, 2, 3]);
		expect(unresolved).toEqual([]);
	});

	it('resolves a mixamo-prefixed garment onto a plain avatar', () => {
		const avatar = buildRig();
		const garment = buildRig({ prefix: 'mixamorig:' });
		const { remap, unresolved } = buildBoneRemap(garment.skeleton, avatar.skeleton);
		expect([...remap]).toEqual([0, 1, 2, 3]);
		expect(unresolved).toEqual([]);
	});

	it('falls back to the nearest mapped ancestor for helper joints', () => {
		const avatar = buildRig();
		const garment = buildRig({
			extraBones: [{ name: 'SpineTwist_A', parent: 'Spine' }],
		});
		const { remap, unresolved } = buildBoneRemap(garment.skeleton, avatar.skeleton);
		// The twist joint is unknown to the avatar, so it rides Spine (index 1).
		expect(remap[4]).toBe(1);
		expect(unresolved).toEqual([]);
	});

	it('reports a bone with no mapped ancestor as unresolved', () => {
		const avatar = buildRig();
		const garment = buildRig();
		// An orphan bone parented outside the chain resolves to nothing.
		const orphan = new Bone();
		orphan.name = 'PropHandle';
		const skeleton = new Skeleton([...garment.bones, orphan]);
		const { remap, unresolved } = buildBoneRemap(skeleton, avatar.skeleton);
		expect(remap[4]).toBe(-1);
		expect(unresolved).toEqual(['PropHandle']);
	});
});

describe('bindCoverage', () => {
	it('weights coverage by influence, not by bone count', () => {
		const avatar = buildRig();
		const garment = buildRig();
		const skeleton = new Skeleton([...garment.bones, Object.assign(new Bone(), { name: 'X' })]);
		// One vertex: 90% on Spine (maps), 10% on the orphan (does not).
		const mesh = buildSkinnedMesh(skeleton, [
			{ pos: new Vector3(0, 2, 0), weights: [[1, 0.9], [4, 0.1]] },
		]);
		const { remap } = buildBoneRemap(skeleton, avatar.skeleton);
		expect(bindCoverage(mesh.geometry, remap)).toBeCloseTo(0.9, 5);
	});
});

describe('remapSkinAttributes', () => {
	it('renormalises a vertex after an unresolved weight is dropped', () => {
		const avatar = buildRig();
		const garment = buildRig();
		const skeleton = new Skeleton([...garment.bones, Object.assign(new Bone(), { name: 'X' })]);
		const mesh = buildSkinnedMesh(skeleton, [
			{ pos: new Vector3(0, 2, 0), weights: [[1, 0.5], [4, 0.5]] },
		]);
		const { remap } = buildBoneRemap(skeleton, avatar.skeleton);
		remapSkinAttributes(mesh.geometry, remap);

		const w = mesh.geometry.attributes.skinWeight;
		expect(w.getComponent(0, 0)).toBeCloseTo(1, 5);   // surviving weight scaled to 1
		expect(w.getComponent(0, 1)).toBe(0);
	});
});

describe('reindexBoneInverses', () => {
	it("keeps the garment's own inverse for bones it referenced", () => {
		const avatar = buildRig({ spineY: 3 });
		const garment = buildRig({ spineY: 2 });
		const { remap } = buildBoneRemap(garment.skeleton, avatar.skeleton);
		const out = reindexBoneInverses(garment.skeleton, avatar.skeleton, remap);
		// Avatar Spine sits at y=3, garment Spine at y=2; the reindexed inverse
		// must be the garment's (translate -2), not the avatar's (translate -3).
		expect(out[1].elements[13]).toBeCloseTo(-2, 5);
	});
});

/* ── attach ──────────────────────────────────────────────────────────────── */

describe('attachGarment', () => {
	it('binds a foreign-named garment so it deforms with the avatar', () => {
		const avatar = buildAvatar({ spineY: 2 });
		const garment = buildRig({ prefix: 'mixamorig:', spineY: 2 });
		const garmentMesh = buildSkinnedMesh(garment.skeleton, [
			{ pos: new Vector3(0, 2.5, 0), bone: 1 },   // shirt vertex over the spine
		]);
		const garmentRoot = new Group();
		garmentRoot.add(garmentMesh);
		garmentRoot.updateMatrixWorld(true);

		const res = attachGarment(avatar.root, garmentRoot, { slot: 'top' });
		expect(res.ok).toBe(true);
		expect(res.coverage).toBeCloseTo(1, 5);

		// Rotate the avatar's spine; body and garment must land together.
		avatar.spine.rotation.z = Math.PI / 4;
		avatar.root.updateMatrixWorld(true);
		res.meshes[0].skeleton.update();
		avatar.mesh.skeleton.update();

		const bodyPoint = avatar.mesh.applyBoneTransform(0, new Vector3().fromBufferAttribute(
			avatar.mesh.geometry.attributes.position, 0));
		const garmentPoint = res.meshes[0].applyBoneTransform(0, new Vector3().fromBufferAttribute(
			res.meshes[0].geometry.attributes.position, 0));

		expect(garmentPoint.x).toBeCloseTo(bodyPoint.x, 5);
		expect(garmentPoint.y).toBeCloseTo(bodyPoint.y, 5);
		expect(garmentPoint.z).toBeCloseTo(bodyPoint.z, 5);
	});

	it('reconciles a divergent rest pose instead of baking in an offset', () => {
		// Garment authored on a rig whose spine sits at y=2; avatar's is at y=3.
		// The vertex sat 0.5 above its own spine and must still sit 0.5 above the
		// avatar's, i.e. y=3.5 — not y=2.5 (offset ignored) and not y=4.5 (double).
		const avatar = buildAvatar({ spineY: 3 });
		const garment = buildRig({ spineY: 2 });
		const garmentMesh = buildSkinnedMesh(garment.skeleton, [
			{ pos: new Vector3(0, 2.5, 0), bone: 1 },
		]);
		const garmentRoot = new Group();
		garmentRoot.add(garmentMesh);
		garmentRoot.updateMatrixWorld(true);

		const res = attachGarment(avatar.root, garmentRoot, { slot: 'top' });
		expect(res.ok).toBe(true);

		avatar.root.updateMatrixWorld(true);
		res.meshes[0].skeleton.update();
		const p = res.meshes[0].applyBoneTransform(0, new Vector3().fromBufferAttribute(
			res.meshes[0].geometry.attributes.position, 0));
		expect(p.y).toBeCloseTo(3.5, 5);
	});

	it('refuses a garment whose skin cannot reach the avatar skeleton', () => {
		const avatar = buildAvatar();
		const alien = new Skeleton([
			Object.assign(new Bone(), { name: 'tentacle_root' }),
			Object.assign(new Bone(), { name: 'tentacle_tip' }),
		]);
		const garmentMesh = buildSkinnedMesh(alien, [
			{ pos: new Vector3(0, 1, 0), bone: 0 },
		]);
		const garmentRoot = new Group();
		garmentRoot.add(garmentMesh);

		const res = attachGarment(avatar.root, garmentRoot, { slot: 'top' });
		expect(res.ok).toBe(false);
		expect(res.coverage).toBeLessThan(MIN_BIND_COVERAGE);
		expect(res.reason).toMatch(/binds only/);
		// Nothing was left behind in the scene.
		expect(occupiedSlots(avatar.root)).toEqual([]);
	});

	it('tracks slot occupancy and detaches cleanly', () => {
		const avatar = buildAvatar();
		const garment = buildRig();
		const garmentRoot = new Group();
		garmentRoot.add(buildSkinnedMesh(garment.skeleton, [
			{ pos: new Vector3(0, 2.5, 0), bone: 1 },
		]));

		const res = attachGarment(avatar.root, garmentRoot, { slot: 'top' });
		expect(res.ok).toBe(true);
		expect(occupiedSlots(avatar.root)).toEqual(['top']);

		expect(detachSlot(avatar.root, 'top')).toBe(1);
		expect(occupiedSlots(avatar.root)).toEqual([]);
	});

	it('rejects an avatar with no skinned mesh', () => {
		const res = attachGarment(new Group(), new Group(), { slot: 'top' });
		expect(res.ok).toBe(false);
		expect(res.reason).toMatch(/no skinned mesh/);
	});
});

/* ── occlusion ───────────────────────────────────────────────────────────── */

describe('cullSkinByBones', () => {
	it('drops triangles fully covered by the garment and restores them', () => {
		const rig = buildRig();
		const mesh = buildSkinnedMesh(rig.skeleton, [
			{ pos: new Vector3(0, 2, 0), bone: 1 },   // spine
			{ pos: new Vector3(1, 2, 0), bone: 1 },   // spine
			{ pos: new Vector3(0, 3, 0), bone: 1 },   // spine  → triangle 0 covered
			{ pos: new Vector3(0, 3, 1), bone: 2 },   // head   → triangle 1 survives
		]);
		mesh.geometry.setIndex([0, 1, 2, 0, 1, 3]);

		const dropped = cullSkinByBones(mesh.geometry, new Set([1]), 0.5);
		expect(dropped).toBe(1);
		expect(mesh.geometry.getIndex().count).toBe(3);

		expect(restoreSkin(mesh.geometry)).toBe(true);
		expect(mesh.geometry.getIndex().count).toBe(6);
	});
});

/* ── gating ──────────────────────────────────────────────────────────────── */

describe('supportsWardrobe', () => {
	it('accepts a humanoid rig', () => {
		expect(supportsWardrobe(buildAvatar().root)).toBe(true);
	});

	it('accepts a foreign-named humanoid rig', () => {
		expect(supportsWardrobe(buildAvatar({ prefix: 'mixamorig:' }).root)).toBe(true);
	});

	it('rejects a non-humanoid prop', () => {
		const bone = Object.assign(new Bone(), { name: 'root' });
		const skeleton = new Skeleton([bone]);
		const mesh = buildSkinnedMesh(skeleton, [{ pos: new Vector3(0, 0, 0), bone: 0 }]);
		const root = new Group();
		root.add(mesh);
		expect(supportsWardrobe(root)).toBe(false);
	});
});

describe('findAvatarSkeleton', () => {
	it('picks the skeleton driving the most vertices, not the first found', () => {
		const root = new Group();
		const prop = buildRig({ prefix: 'prop_' });
		root.add(buildSkinnedMesh(prop.skeleton, [{ pos: new Vector3(0, 0, 0), bone: 0 }]));
		const body = buildRig();
		const bodyMesh = buildSkinnedMesh(body.skeleton, Array.from({ length: 10 }, () => (
			{ pos: new Vector3(0, 2, 0), bone: 1 }
		)));
		root.add(bodyMesh);

		expect(findAvatarSkeleton(root).mesh).toBe(bodyMesh);
	});
});
