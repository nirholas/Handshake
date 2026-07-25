/**
 * Garment forge — fit, proximity skin transfer, and assembly, verified against
 * the REAL canonical body (public/avatars/parametric-base.glb) and closed
 * end-to-end through the REAL runtime binder (src/avatar-garment.js).
 *
 * The last test is the one that matters commercially: a synthetic "shirt"
 * tube, never rigged by a human, goes through the worker's assembly path and
 * must come out attachable at >= MIN_BIND_COVERAGE by attachGarment(). That is
 * the exact contract a generated garment must satisfy to enter the catalog
 * (specs/GARMENT_MANIFEST.md §Validation, rule 5).
 */

import { readFile } from 'node:fs/promises';
import { describe, it, expect, beforeAll } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import {
	SLOT_REGIONS,
	findBodyMesh,
	regionBounds,
	fitGarmentToBody,
	transferSkinWeights,
	deriveOccludes,
} from '../workers/garment-forge/lib/skin-transfer.mjs';
import { assembleGarment } from '../workers/garment-forge/lib/assemble.mjs';
import { MIN_BIND_COVERAGE } from '../src/garment-taxonomy.js';

const BASE_GLB = new URL('../public/avatars/parametric-base.glb', import.meta.url);

let io;
let baseBytes;

beforeAll(async () => {
	io = new NodeIO();
	baseBytes = new Uint8Array(await readFile(BASE_GLB));
});

/** A closed tube (12-sided prism) around the origin — a crude "shirt". */
function buildTubeDoc({ radius = 7, height = 9, segments = 12 } = {}) {
	const doc = new Document();
	const buffer = doc.createBuffer();
	const scene = doc.createScene('scene');
	doc.getRoot().setDefaultScene(scene);

	const positions = [];
	const indices = [];
	for (let s = 0; s <= segments; s++) {
		const a = (s / segments) * Math.PI * 2;
		positions.push(Math.cos(a) * radius, -height / 2, Math.sin(a) * radius);
		positions.push(Math.cos(a) * radius, height / 2, Math.sin(a) * radius);
	}
	for (let s = 0; s < segments; s++) {
		const i = s * 2;
		indices.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
	}

	const prim = doc
		.createPrimitive()
		.setAttribute('POSITION', doc.createAccessor().setType('VEC3')
			.setArray(new Float32Array(positions)).setBuffer(buffer))
		.setIndices(doc.createAccessor().setType('SCALAR')
			.setArray(new Uint16Array(indices)).setBuffer(buffer));
	const mesh = doc.createMesh('tube').addPrimitive(prim);
	const node = doc.createNode('tubeNode').setMesh(mesh);
	scene.addChild(node);
	return { doc, mesh };
}

describe('canonical body analysis', () => {
	it('finds the skinned body mesh in parametric-base.glb', async () => {
		const doc = await io.readBinary(baseBytes);
		const node = findBodyMesh(doc);
		expect(node).toBeTruthy();
		expect(node.getSkin().listJoints().length).toBeGreaterThanOrEqual(50);
	});

	it('resolves region bounds for every slot region', async () => {
		const doc = await io.readBinary(baseBytes);
		const bounds = regionBounds(doc);
		for (const regions of Object.values(SLOT_REGIONS)) {
			for (const r of regions) {
				expect(bounds.has(r), `region ${r} missing from body bounds`).toBe(true);
			}
		}
		// Sanity: the torso sits above the hips on a standing human.
		const torso = bounds.get('torso');
		const hips = bounds.get('hips');
		expect((torso.min[1] + torso.max[1]) / 2).toBeGreaterThan((hips.min[1] + hips.max[1]) / 2);
	});
});

describe('fit + transfer on the real body', () => {
	it('fits an arbitrary-scale tube over the torso and transfers full weights', async () => {
		const bodyDoc = await io.readBinary(baseBytes);
		const { doc, mesh } = buildTubeDoc();

		const { scale } = fitGarmentToBody(mesh, bodyDoc, 'top');
		expect(scale).toBeGreaterThan(0);

		// After fitting, the tube's bounds must overlap the torso's.
		const bounds = regionBounds(bodyDoc);
		const torso = bounds.get('torso');
		const pos = mesh.listPrimitives()[0].getAttribute('POSITION').getArray();
		let minY = Infinity;
		let maxY = -Infinity;
		for (let i = 1; i < pos.length; i += 3) {
			if (pos[i] < minY) minY = pos[i];
			if (pos[i] > maxY) maxY = pos[i];
		}
		expect(maxY).toBeGreaterThan(torso.min[1]);
		expect(minY).toBeLessThan(torso.max[1]);

		const { transferred } = transferSkinWeights(mesh, bodyDoc, doc);
		const vertCount = pos.length / 3;
		expect(transferred).toBe(vertCount);

		// Every vertex ends up with normalised-ish weight mass.
		const w = mesh.listPrimitives()[0].getAttribute('WEIGHTS_0').getArray();
		for (let v = 0; v < vertCount; v++) {
			const sum = w[v * 4] + w[v * 4 + 1] + w[v * 4 + 2] + w[v * 4 + 3];
			expect(sum).toBeGreaterThan(0.5);
		}
	});

	it('interpolates weights across the body surface instead of snapping to one vertex', async () => {
		// A synthetic body: one triangle whose corners are fully weighted to
		// three DIFFERENT joints. A garment vertex hovering over the triangle's
		// centre must receive a ~equal blend of all three — a nearest-vertex
		// snap would give it exactly one.
		const { Document } = await import('@gltf-transform/core');
		const bodyDoc = new Document();
		const buffer = bodyDoc.createBuffer();
		const scene = bodyDoc.createScene('s');
		bodyDoc.getRoot().setDefaultScene(scene);
		const j0 = bodyDoc.createNode('Hips');
		const j1 = bodyDoc.createNode('Spine');
		const j2 = bodyDoc.createNode('Head');
		j0.addChild(j1); j1.addChild(j2); scene.addChild(j0);
		const ibm = new Float32Array(3 * 16);
		for (let i = 0; i < 3; i++) ibm.set([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], i * 16);
		const skin = bodyDoc.createSkin('skin')
			.setInverseBindMatrices(bodyDoc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer));
		skin.addJoint(j0); skin.addJoint(j1); skin.addJoint(j2);
		const prim = bodyDoc.createPrimitive()
			.setAttribute('POSITION', bodyDoc.createAccessor().setType('VEC3')
				.setArray(new Float32Array([0,0,0, 1,0,0, 0,1,0])).setBuffer(buffer))
			.setAttribute('JOINTS_0', bodyDoc.createAccessor().setType('VEC4')
				.setArray(new Uint16Array([0,0,0,0, 1,0,0,0, 2,0,0,0])).setBuffer(buffer))
			.setAttribute('WEIGHTS_0', bodyDoc.createAccessor().setType('VEC4')
				.setArray(new Float32Array([1,0,0,0, 1,0,0,0, 1,0,0,0])).setBuffer(buffer))
			.setIndices(bodyDoc.createAccessor().setType('SCALAR')
				.setArray(new Uint16Array([0, 1, 2])).setBuffer(buffer));
		scene.addChild(bodyDoc.createNode('body').setMesh(bodyDoc.createMesh('m').addPrimitive(prim)).setSkin(skin));

		// Garment: a single unindexed vertex above the triangle's centroid.
		const gDoc = new Document();
		const gBuf = gDoc.createBuffer();
		const gPrim = gDoc.createPrimitive()
			.setAttribute('POSITION', gDoc.createAccessor().setType('VEC3')
				.setArray(new Float32Array([1 / 3, 1 / 3, 0.05])).setBuffer(gBuf));
		const gMesh = gDoc.createMesh('g').addPrimitive(gPrim);

		transferSkinWeights(gMesh, bodyDoc, gDoc);
		const w = gMesh.listPrimitives()[0].getAttribute('WEIGHTS_0').getArray();
		const j = gMesh.listPrimitives()[0].getAttribute('JOINTS_0').getArray();
		const byJoint = new Map();
		for (let c = 0; c < 4; c++) byJoint.set(j[c], (byJoint.get(j[c]) || 0) + w[c]);
		// All three joints present, each near 1/3 — the barycentric signature.
		expect(byJoint.get(0)).toBeGreaterThan(0.2);
		expect(byJoint.get(1)).toBeGreaterThan(0.2);
		expect(byJoint.get(2)).toBeGreaterThan(0.2);
	});

	it('derives occludes that include the slot floor', async () => {
		const bodyDoc = await io.readBinary(baseBytes);
		const { doc, mesh } = buildTubeDoc();
		fitGarmentToBody(mesh, bodyDoc, 'top');
		transferSkinWeights(mesh, bodyDoc, doc);
		const occludes = deriveOccludes(mesh, findBodyMesh(bodyDoc).getSkin(), 'top');
		expect(occludes).toContain('torso');
		expect(occludes).toContain('upperArms');
	});
});

describe('assembleGarment → attachGarment (the commercial contract)', () => {
	it('a generated tube becomes a garment GLB the runtime binds at >= MIN_BIND_COVERAGE', async () => {
		const { doc } = buildTubeDoc();
		const garmentBytes = await io.writeBinary(doc);

		const { bytes, occludes, stats } = await assembleGarment(io, baseBytes, garmentBytes, 'top');
		expect(stats.transferred).toBeGreaterThan(0);
		expect(occludes).toContain('torso');

		// The emitted GLB must not ship the body mesh (skeleton only + cloth).
		const outDoc = await io.readBinary(bytes);
		const meshes = outDoc.getRoot().listMeshes();
		expect(meshes.length).toBe(1);

		// ── Close the loop through the real three.js runtime binder. ──
		const [{ GLTFLoader }, { attachGarment }, { Group }] = await Promise.all([
			import('three/examples/jsm/loaders/GLTFLoader.js'),
			import('../src/avatar-garment.js'),
			import('three'),
		]);

		const loader = new GLTFLoader();
		const parse = (buf) => new Promise((resolve, reject) => {
			loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', resolve, reject);
		});

		// The "avatar" the user brings: the canonical body itself, loaded as a
		// plain GLB. In production this is any humanoid; the runtime suite
		// already proves foreign rigs and divergent rests bind.
		const avatarGltf = await parse(new Uint8Array(baseBytes));
		const avatarRoot = new Group();
		avatarRoot.add(avatarGltf.scene);
		avatarRoot.updateMatrixWorld(true);

		const garmentGltf = await parse(bytes);
		const result = attachGarment(avatarRoot, garmentGltf.scene, { slot: 'top' });

		expect(result.ok).toBe(true);
		expect(result.coverage).toBeGreaterThanOrEqual(MIN_BIND_COVERAGE);
	}, 30000);
});
