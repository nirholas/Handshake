// Build (voxel) feature — grid math, VoxelWorld instanced-batch integrity, and
// client↔server constant parity. These are the load-bearing invariants behind
// /play's collaborative building: the swap-pop index repair must never desync a
// rendered instance from its grid key, and the client's bounds/budget caps must
// mirror the server's exactly (drift = blocks the client lets you place that the
// server silently rejects).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// three's instanced meshes touch a couple of browser globals on import in some
// builds; mirror the polyfill the other three-using tests use.
globalThis.self = globalThis;

import {
	VoxelWorld, keyOf, parseKey, cellToWorld, cellInBounds,
	BLOCK, MAX_GRID_XZ, MAX_GRID_Y, MAX_BLOCKS, BLOCK_TYPE_COUNT, BLOCK_TYPES,
} from '../src/game/build-voxels.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// A minimal stand-in for a three.Scene — VoxelWorld only ever add()/remove()s.
function fakeScene() {
	const children = new Set();
	return { add: (o) => children.add(o), remove: (o) => children.delete(o), children };
}

// The core invariant: for every key the world knows about, the batch slot it
// points at must actually hold that key, and the InstancedMesh's live instance
// count must equal the number of keys in that batch. If swap-pop ever fails to
// repair an index, this catches it.
function assertConsistent(world) {
	for (const [key, entry] of world.index) {
		const batch = world.batches[entry.type];
		expect(batch.keys[entry.i], `index for ${key} points at the right slot`).toBe(key);
	}
	for (const batch of world.batches) {
		const live = batch.mesh ? batch.mesh.count : 0;
		expect(live, `batch ${batch.type} instance count tracks key count`).toBe(batch.keys.length);
	}
	// Every key appears exactly once across all batches.
	const all = world.batches.flatMap((b) => b.keys);
	expect(new Set(all).size).toBe(all.length);
	expect(all.length).toBe(world.index.size);
}

describe('grid math', () => {
	it('keyOf / parseKey round-trip including negatives', () => {
		for (const c of [[0, 0, 0], [1, 2, 3], [-5, 7, -12], [MAX_GRID_XZ, MAX_GRID_Y - 1, -MAX_GRID_XZ]]) {
			expect(parseKey(keyOf(...c))).toEqual(c);
		}
	});

	it('cellToWorld lands gy=0 flush on the ground plane', () => {
		const v = cellToWorld(2, 0, -3);
		expect(v.x).toBeCloseTo(2 * BLOCK);
		expect(v.z).toBeCloseTo(-3 * BLOCK);
		// Base sits at y=0: centre is half a block up.
		expect(v.y).toBeCloseTo(BLOCK / 2);
		expect(cellToWorld(0, 1, 0).y).toBeCloseTo(BLOCK + BLOCK / 2);
	});

	it('cellInBounds enforces integers, the height ceiling, and the circular area', () => {
		expect(cellInBounds(0, 0, 0)).toBe(true);
		expect(cellInBounds(1.5, 0, 0)).toBe(false);          // non-integer
		expect(cellInBounds(0, -1, 0)).toBe(false);           // below the floor
		expect(cellInBounds(0, MAX_GRID_Y, 0)).toBe(false);   // at/over the ceiling
		expect(cellInBounds(0, MAX_GRID_Y - 1, 0)).toBe(true);
		expect(cellInBounds(MAX_GRID_XZ, 0, 0)).toBe(true);   // on the radius
		expect(cellInBounds(MAX_GRID_XZ, 0, MAX_GRID_XZ)).toBe(false); // corner is outside the circle
		expect(cellInBounds(MAX_GRID_XZ + 1, 0, 0)).toBe(false);
	});
});

describe('VoxelWorld', () => {
	it('places, repaints, and reports count/typeAt', () => {
		const w = new VoxelWorld(fakeScene());
		expect(w.count).toBe(0);
		w.setBlock(0, 0, 0, 1);
		w.setBlock(1, 0, 0, 4);
		expect(w.count).toBe(2);
		expect(w.typeAt(0, 0, 0)).toBe(1);
		expect(w.typeAt(9, 9, 9)).toBe(-1);
		assertConsistent(w);

		// Repaint moves the block between type batches without growing the world.
		w.setBlock(0, 0, 0, 7);
		expect(w.count).toBe(2);
		expect(w.typeAt(0, 0, 0)).toBe(7);
		expect(w.batches[1].keys).not.toContain('0,0,0');
		expect(w.batches[7].keys).toContain('0,0,0');
		assertConsistent(w);

		// Idempotent: setting the same type again is a no-op.
		w.setBlock(0, 0, 0, 7);
		expect(w.count).toBe(2);
		assertConsistent(w);
		w.dispose();
	});

	it('repairs the swap-pop index when removing from the middle of a batch', () => {
		const w = new VoxelWorld(fakeScene());
		// Three blocks of the same type → same batch, slots 0,1,2.
		w.setBlock(0, 0, 0, 2);
		w.setBlock(1, 0, 0, 2);
		w.setBlock(2, 0, 0, 2);
		// Remove the middle one: the last (2,0,0) must swap into slot 1.
		w.removeBlock(1, 0, 0);
		expect(w.count).toBe(2);
		expect(w.hasBlock('1,0,0')).toBe(false);
		expect(w.index.get('2,0,0').i).toBe(1); // swapped into the freed slot
		assertConsistent(w);
		// Removing the (now) moved block still leaves a consistent world.
		w.removeBlock(2, 0, 0);
		w.removeBlock(0, 0, 0);
		expect(w.count).toBe(0);
		assertConsistent(w);
		w.dispose();
	});

	it('survives a randomized place/remove/repaint churn with the invariant intact', () => {
		const w = new VoxelWorld(fakeScene());
		// Deterministic LCG so the test is reproducible without Math.random.
		let seed = 1234567;
		const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
		const live = new Map();
		for (let step = 0; step < 800; step++) {
			const gx = Math.floor(rnd() * 7) - 3;
			const gz = Math.floor(rnd() * 7) - 3;
			const gy = Math.floor(rnd() * 4);
			const key = keyOf(gx, gy, gz);
			if (rnd() < 0.5) {
				const t = Math.floor(rnd() * BLOCK_TYPE_COUNT);
				w.setBlock(gx, gy, gz, t);
				live.set(key, t);
			} else {
				w.removeBlock(gx, gy, gz);
				live.delete(key);
			}
		}
		expect(w.count).toBe(live.size);
		for (const [key, t] of live) expect(w.typeAt(...parseKey(key))).toBe(t);
		assertConsistent(w);
		w.dispose();
	});

	it('clear() empties every batch', () => {
		const w = new VoxelWorld(fakeScene());
		for (let i = 0; i < 20; i++) w.setBlock(i % 5, 0, Math.floor(i / 5), i % BLOCK_TYPE_COUNT);
		expect(w.count).toBe(20);
		w.clear();
		expect(w.count).toBe(0);
		assertConsistent(w);
		w.dispose();
	});

	it('ignores out-of-palette types defensively', () => {
		const w = new VoxelWorld(fakeScene());
		w.setBlock(0, 0, 0, -1);
		w.setBlock(0, 0, 0, BLOCK_TYPE_COUNT);
		expect(w.count).toBe(0);
		w.dispose();
	});
});

describe('client ↔ server constant parity', () => {
	// The server validates every edit against its own copies of these caps. If the
	// client's diverge, players get a build experience that lies (placeable cells
	// the server rejects, or a budget bar that disagrees with the real limit).
	const server = readFileSync(resolve(ROOT, 'multiplayer/src/rooms/WalkRoom.js'), 'utf8');
	const num = (name) => {
		const m = server.match(new RegExp(`const ${name}\\s*=\\s*(\\d+)`));
		expect(m, `${name} present in WalkRoom.js`).toBeTruthy();
		return Number(m[1]);
	};

	it('grid bounds, block budget, and palette size match WalkRoom', () => {
		expect(MAX_GRID_XZ).toBe(num('MAX_GRID_XZ'));
		expect(MAX_GRID_Y).toBe(num('MAX_GRID_Y'));
		expect(MAX_BLOCKS).toBe(num('MAX_BLOCKS'));
		expect(BLOCK_TYPE_COUNT).toBe(num('BLOCK_TYPE_COUNT'));
		expect(BLOCK_TYPES.length).toBe(BLOCK_TYPE_COUNT);
	});
});
