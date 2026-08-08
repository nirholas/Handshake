/**
 * Static geometry batcher: unit tests.
 *
 * The batcher is what keeps the /play world dressing (hundreds of trees, boxes
 * and posts cut from a handful of shared buffers) down to a handful of draw
 * calls. The properties that matter are: every source mesh survives as an
 * instance, the world transform each one had is the transform it renders with,
 * meshes that differ in material or shadow flags never share a batch, and the
 * emitted bounds cover the whole spread so frustum culling does not pop the
 * scenery out of existence.
 */

import { describe, it, expect } from 'vitest';
import {
	Group, Mesh, BoxGeometry, SphereGeometry, MeshStandardMaterial, Matrix4, Vector3,
} from 'three';
import { createStaticBatcher, disposeInstanced } from '../src/game/static-batch.js';

const geoA = new BoxGeometry(1, 1, 1);
const geoB = new SphereGeometry(1, 6, 6);
const matA = new MeshStandardMaterial({ color: 0x112233 });
const matB = new MeshStandardMaterial({ color: 0x445566 });

/** A plant-like Group: one trunk plus `leaves` leaf meshes, positioned as a whole. */
function makePlant(x, z, leaves = 2) {
	const g = new Group();
	g.position.set(x, 0, z);
	const trunk = new Mesh(geoA, matA);
	trunk.castShadow = true;
	g.add(trunk);
	for (let i = 0; i < leaves; i++) {
		const leaf = new Mesh(geoB, matB);
		leaf.position.y = 2 + i;
		leaf.castShadow = true;
		g.add(leaf);
	}
	return g;
}

describe('createStaticBatcher', () => {
	it('collapses shared geometry+material into one InstancedMesh per pair', () => {
		const batch = createStaticBatcher();
		for (let i = 0; i < 10; i++) batch.add(makePlant(i * 3, 0, 2));
		const root = new Group();
		const stats = batch.flush(root);

		// 10 plants x (1 trunk + 2 leaves) = 30 meshes, two distinct pairs.
		expect(stats.meshes).toBe(30);
		expect(stats.batches).toBe(2);
		expect(stats.saved).toBe(28);
		expect(root.children).toHaveLength(2);
		for (const child of root.children) expect(child.isInstancedMesh).toBe(true);

		const counts = root.children.map((c) => c.count).sort((a, b) => a - b);
		expect(counts).toEqual([10, 20]);
	});

	it('renders each instance at the world transform its source mesh had', () => {
		const batch = createStaticBatcher();
		const plant = makePlant(5, -7, 1);
		plant.scale.setScalar(2);
		batch.add(plant);
		const root = new Group();
		batch.flush(root);

		const trunkBatch = root.children.find((c) => c.geometry === geoA);
		const m = new Matrix4();
		trunkBatch.getMatrixAt(0, m);
		const pos = new Vector3().setFromMatrixPosition(m);
		expect(pos.x).toBeCloseTo(5);
		expect(pos.z).toBeCloseTo(-7);

		const leafBatch = root.children.find((c) => c.geometry === geoB);
		leafBatch.getMatrixAt(0, m);
		const leafPos = new Vector3().setFromMatrixPosition(m);
		// Leaf sits at local y=2 under a group scaled 2x.
		expect(leafPos.y).toBeCloseTo(4);
	});

	it('keeps shadow flags out of the same batch', () => {
		const batch = createStaticBatcher();
		const lit = new Mesh(geoA, matA); lit.castShadow = true;
		const unlit = new Mesh(geoA, matA); unlit.castShadow = false; unlit.position.x = 4;
		batch.add(lit);
		batch.add(unlit);
		const root = new Group();
		const stats = batch.flush(root);

		expect(stats.batches).toBe(2);
		expect(root.children.map((c) => c.castShadow).sort()).toEqual([false, true]);
	});

	it('bounds the batch around every instance, not just the source geometry', () => {
		const batch = createStaticBatcher();
		for (let i = 0; i < 6; i++) {
			const m = new Mesh(geoA, matA);
			m.position.set(i * 40, 0, 0);
			batch.add(m);
		}
		const root = new Group();
		batch.flush(root);

		// Six unit boxes spread over 200 units: a bound inherited from the source
		// geometry would be ~1 unit and would cull the whole row off-screen.
		expect(root.children[0].boundingSphere.radius).toBeGreaterThan(50);
	});

	it('passes a multi-material mesh through untouched', () => {
		const batch = createStaticBatcher();
		const multi = new Mesh(geoA, [matA, matB]);
		multi.position.set(1, 2, 3);
		batch.add(multi);
		const root = new Group();
		const stats = batch.flush(root);

		expect(stats.batches).toBe(1);
		expect(root.children[0]).toBe(multi);
		expect(root.children[0].position.toArray()).toEqual([1, 2, 3]);
	});

	it('resets after a flush so the batcher can be reused', () => {
		const batch = createStaticBatcher();
		batch.add(new Mesh(geoA, matA));
		const first = new Group();
		expect(batch.flush(first).meshes).toBe(1);

		const second = new Group();
		expect(batch.flush(second).meshes).toBe(0);
		expect(second.children).toHaveLength(0);
	});

	it('disposeInstanced frees the per-instance buffers it created', () => {
		const batch = createStaticBatcher();
		for (let i = 0; i < 4; i++) {
			const m = new Mesh(geoA, matA); m.position.x = i;
			batch.add(m);
		}
		const root = new Group();
		batch.flush(root);

		let disposed = 0;
		root.children[0].addEventListener('dispose', () => { disposed++; });
		disposeInstanced(root);
		expect(disposed).toBe(1);
	});
});
