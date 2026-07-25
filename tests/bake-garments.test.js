/**
 * Server-side garment baker — api/_lib/bake-garments.js.
 *
 * Builds real GLB documents in memory with @gltf-transform (no fixtures, no
 * network — catalog and bytes are injected through the test seams) and runs
 * the actual merge+rebind used by bakeAppearance. The contract mirrors the
 * runtime suite (tests/avatar-garment.test.js):
 *
 *   - garment JOINTS_0 rewritten into avatar joint order via canonical names,
 *   - the rebound skin keeps the GARMENT's inverseBindMatrices where claimed,
 *   - a garment below MIN_BIND_COVERAGE is skipped, not baked in mangled,
 *   - occluded body regions have their triangles culled,
 *   - the baked document round-trips through the binary writer.
 */

import { describe, it, expect } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { mergeDocuments, unpartition } from '@gltf-transform/functions';
import {
	applyGarments,
	buildJointRemap,
	cullBodyRegions,
	findPrimarySkin,
} from '../api/_lib/bake-garments.js';
import { GARMENT_SPEC_URI } from '../src/garment-catalog.js';

/* ── builders ────────────────────────────────────────────────────────────── */

/**
 * A minimal skinned humanoid document: Hips → Spine → Head (+LeftArm), one
 * body mesh fully weighted to Spine and Head. `prefix` exercises foreign
 * naming; `spineY` moves the rest pose for divergent-bind tests.
 */
function buildHumanoidDoc({ prefix = '', spineY = 2, vertsOnSpine = 2 } = {}) {
	const doc = new Document();
	const buffer = doc.createBuffer();
	const scene = doc.createScene('scene');
	doc.getRoot().setDefaultScene(scene);

	const hips = doc.createNode(`${prefix}Hips`).setTranslation([0, 1, 0]);
	const spine = doc.createNode(`${prefix}Spine`).setTranslation([0, spineY - 1, 0]);
	const head = doc.createNode(`${prefix}Head`).setTranslation([0, 1, 0]);
	const leftArm = doc.createNode(`${prefix}LeftArm`).setTranslation([0.5, 0.5, 0]);
	hips.addChild(spine);
	spine.addChild(head);
	spine.addChild(leftArm);
	scene.addChild(hips);

	const joints = [hips, spine, head, leftArm];
	// IBMs: inverse of each joint's world translation (identity rotation).
	const worldY = [1, spineY, spineY + 1, spineY + 0.5];
	const worldX = [0, 0, 0, 0.5];
	const ibm = new Float32Array(joints.length * 16);
	joints.forEach((_, i) => {
		ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -worldX[i], -worldY[i], 0, 1], i * 16);
	});
	const ibmAccessor = doc.createAccessor('ibm').setType('MAT4').setArray(ibm).setBuffer(buffer);
	const skin = doc.createSkin('skin').setInverseBindMatrices(ibmAccessor);
	for (const j of joints) skin.addJoint(j);
	skin.setSkeleton(hips);

	// Body: vertsOnSpine vertices on Spine (joint 1), then 2 on Head (joint 2),
	// indexed as triangles [0,1,2] (spine-ish) and [1,2,3] (mixed).
	const vertCount = vertsOnSpine + 2;
	const positions = new Float32Array(vertCount * 3);
	const jointsArr = new Uint16Array(vertCount * 4);
	const weightsArr = new Float32Array(vertCount * 4);
	for (let v = 0; v < vertCount; v++) {
		positions.set([v * 0.1, spineY + 0.5, 0], v * 3);
		jointsArr[v * 4] = v < vertsOnSpine ? 1 : 2;
		weightsArr[v * 4] = 1;
	}
	const prim = doc
		.createPrimitive()
		.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
		.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(jointsArr).setBuffer(buffer))
		.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(weightsArr).setBuffer(buffer))
		.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 1, 2, 1, 2, 3])).setBuffer(buffer));
	const mesh = doc.createMesh('body').addPrimitive(prim);
	const meshNode = doc.createNode('bodyNode').setMesh(mesh).setSkin(skin);
	scene.addChild(meshNode);

	return { doc, skin, joints, mesh };
}

async function docToBytes(io, doc) {
	return (await io.writeBinary(doc)).buffer.slice(0);
}

function manifestFor(id, slot, overrides = {}) {
	return {
		spec: GARMENT_SPEC_URI,
		id,
		name: id,
		slot,
		version: 1,
		model: { uri: `https://t.test/${id}.glb`, format: 'gltf-binary', sha256: 'a'.repeat(64) },
		rig: { skeleton: 'three.ws-canonical-v1' },
		occludes: ['torso'],
		license: 'CC0-1.0',
		...overrides,
	};
}

/* ── unit pieces ─────────────────────────────────────────────────────────── */

describe('findPrimarySkin', () => {
	it('picks the skin deforming the most vertices', () => {
		const { doc, skin } = buildHumanoidDoc({ vertsOnSpine: 10 });
		expect(findPrimarySkin(doc).skin).toBe(skin);
	});
});

describe('buildJointRemap (document level)', () => {
	it('maps a foreign-named garment skeleton onto the avatar', () => {
		const avatar = buildHumanoidDoc();
		const garment = buildHumanoidDoc({ prefix: 'mixamorig:' });
		// Parent map over the GARMENT document's nodes.
		const parents = new Map();
		for (const n of garment.doc.getRoot().listNodes()) {
			for (const c of n.listChildren()) parents.set(c, n);
		}
		const remap = buildJointRemap(garment.skin, avatar.skin, parents);
		expect([...remap]).toEqual([0, 1, 2, 3]);
	});
});

describe('cullBodyRegions', () => {
	it('drops triangles fully weighted to occluded regions', () => {
		const { doc } = buildHumanoidDoc({ vertsOnSpine: 3 });
		const primary = findPrimarySkin(doc);
		// verts 0,1,2 are on Spine (torso); triangle [0,1,2] dies, [1,2,3] survives
		// because vert 3 rides Head (scalp, not occluded).
		const dropped = cullBodyRegions(primary.mesh, primary.skin, ['torso']);
		expect(dropped).toBe(1);
		const idx = primary.mesh.listPrimitives()[0].getIndices().getArray();
		expect([...idx]).toEqual([1, 2, 3]);
	});
});

/* ── full pipeline ───────────────────────────────────────────────────────── */

describe('applyGarments', () => {
	it('bakes a divergent-rest garment: joints remapped, garment IBMs kept, occlusion applied', async () => {
		const io = new NodeIO();
		// vertsOnSpine: 3 puts the body's first triangle fully on the torso so
		// the occlusion pass has something to cull.
		const avatar = buildHumanoidDoc({ spineY: 3, vertsOnSpine: 3 });
		const garment = buildHumanoidDoc({ prefix: 'mixamorig:', spineY: 2 });
		const garmentBytes = await docToBytes(io, garment.doc);

		const manifest = manifestFor('oxford-shirt-white', 'top');
		const { attached, skipped } = await applyGarments(
			io,
			avatar.doc,
			[{ slot: 'top', id: 'oxford-shirt-white' }],
			mergeDocuments,
			{ catalog: [manifest], fetchBytes: async () => garmentBytes },
		);

		expect(skipped).toEqual([]);
		expect(attached).toEqual(['oxford-shirt-white']);

		// The merged garment mesh is in the default scene with a rebound skin.
		const garmentNode = avatar.doc
			.getRoot()
			.listNodes()
			.find((n) => n.getMesh()?.getName() === 'body' && n.getSkin()?.getName()?.startsWith('garment:'));
		expect(garmentNode).toBeTruthy();

		const reboundSkin = garmentNode.getSkin();
		// Joints are the AVATAR's four.
		expect(reboundSkin.listJoints().map((j) => j.getName())).toEqual([
			'Hips', 'Spine', 'Head', 'LeftArm',
		]);
		// IBM for Spine keeps the GARMENT's value (rest y=2 → translation -2),
		// not the avatar's (-3): that is the divergent-rest reconciliation.
		const ibm = reboundSkin.getInverseBindMatrices().getArray();
		expect(ibm[1 * 16 + 13]).toBeCloseTo(-2, 5);

		// Occlusion: avatar body had triangles [0,1,2] (torso) and [1,2,3];
		// the manifest occludes torso, so only the mixed triangle survives.
		const bodyIdx = findPrimarySkin(avatar.doc); // still the body (4 verts > garment 4? both 4 —
		// primary is recomputed; guard by name instead:
		const bodyNode = avatar.doc
			.getRoot()
			.listNodes()
			.find((n) => n.getName() === 'bodyNode');
		const idx = bodyNode.getMesh().listPrimitives()[0].getIndices().getArray();
		expect([...idx]).toEqual([1, 2, 3]);
		expect(bodyIdx).toBeTruthy();

		// And the whole document still serializes to a valid GLB. mergeDocuments
		// leaves one buffer per source document; unpartition() collapses them —
		// exactly what bake.js's compression pass does before writing.
		await avatar.doc.transform(unpartition());
		const out = await io.writeBinary(avatar.doc);
		expect(out.byteLength).toBeGreaterThan(500);
	});

	it('skips a garment that cannot reach the avatar skeleton', async () => {
		const io = new NodeIO();
		const avatar = buildHumanoidDoc();
		const alien = buildHumanoidDoc({ prefix: 'tentacle_xx_' });
		// Rename joints to names that canonicalize to nothing.
		alien.joints.forEach((j, i) => j.setName(`blob_${i}`));
		const bytes = await docToBytes(io, alien.doc);

		const manifest = manifestFor('blob-suit', 'top');
		const { attached, skipped } = await applyGarments(
			io,
			avatar.doc,
			[{ slot: 'top', id: 'blob-suit' }],
			mergeDocuments,
			{ catalog: [manifest], fetchBytes: async () => bytes },
		);

		expect(attached).toEqual([]);
		expect(skipped).toHaveLength(1);
		expect(skipped[0].reason).toMatch(/binds 0%/);

		// Body untouched: no occlusion applied for a skipped garment.
		const bodyNode = avatar.doc.getRoot().listNodes().find((n) => n.getName() === 'bodyNode');
		expect([...bodyNode.getMesh().listPrimitives()[0].getIndices().getArray()])
			.toEqual([0, 1, 2, 1, 2, 3]);
	});

	it('reports garments missing from the catalog', async () => {
		const io = new NodeIO();
		const avatar = buildHumanoidDoc();
		const { attached, skipped } = await applyGarments(
			io,
			avatar.doc,
			[{ slot: 'top', id: 'ghost' }],
			mergeDocuments,
			{ catalog: [], fetchBytes: async () => { throw new Error('unreachable'); } },
		);
		expect(attached).toEqual([]);
		expect(skipped).toEqual([{ id: 'ghost', reason: 'not in catalog' }]);
	});
});
