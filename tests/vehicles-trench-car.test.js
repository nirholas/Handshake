// The Trench Car is the world's default vehicle: ambient traffic drives it and
// it is what a player takes the wheel of at the spawn plaza. Its handling spec
// is hand-measured off the staged GLB, which means the two can drift silently,
// a re-export of the model with a different wheelbase would leave the physics
// chassis, the wheels the player watches turn, and the mesh disagreeing, with
// nothing failing until someone looked at it.
//
// These tests read the real staged asset and hold the shared spec to it, plus
// the two geometry invariants every vehicle type has to satisfy: the chassis
// clears the road, and the driver sits inside the car rather than on its roof.

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import {
	VEHICLE_TYPES, VEHICLE_SPAWNS, DEFAULT_VEHICLE_TYPE,
	vehicleSpec, isVehicleType, vehicleRestHeight,
} from '../multiplayer/src/vehicles.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const MODEL = path.join(ROOT, 'public', 'vehicles', 'trench-car.glb');

// Node bounds in model space, walking the scene so quantization transforms on
// the node chain are applied rather than ignored.
function nodeBounds(node, parent = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]) {
	// Only translation + scale appear on these nodes (Blender export + quantize),
	// so a diagonal-plus-offset accumulation is exact here.
	const t = node.getTranslation();
	const s = node.getScale();
	const acc = {
		sx: parent.sx * s[0], sy: parent.sy * s[1], sz: parent.sz * s[2],
		tx: parent.tx + parent.sx * t[0], ty: parent.ty + parent.sy * t[1], tz: parent.tz + parent.sz * t[2],
	};
	let min = [Infinity, Infinity, Infinity];
	let max = [-Infinity, -Infinity, -Infinity];
	const mesh = node.getMesh();
	for (const prim of mesh ? mesh.listPrimitives() : []) {
		const pos = prim.getAttribute('POSITION');
		const pMin = pos.getMinNormalized([0, 0, 0]);
		const pMax = pos.getMaxNormalized([0, 0, 0]);
		const lo = [acc.tx + acc.sx * pMin[0], acc.ty + acc.sy * pMin[1], acc.tz + acc.sz * pMin[2]];
		const hi = [acc.tx + acc.sx * pMax[0], acc.ty + acc.sy * pMax[1], acc.tz + acc.sz * pMax[2]];
		for (let i = 0; i < 3; i++) {
			min[i] = Math.min(min[i], lo[i], hi[i]);
			max[i] = Math.max(max[i], lo[i], hi[i]);
		}
	}
	for (const child of node.listChildren()) {
		const c = nodeBounds(child, acc);
		if (!c) continue;
		for (let i = 0; i < 3; i++) {
			min[i] = Math.min(min[i], c.min[i]);
			max[i] = Math.max(max[i], c.max[i]);
		}
	}
	if (!Number.isFinite(min[0])) return null;
	return { min, max, centre: min.map((v, i) => (v + max[i]) / 2), size: max.map((v, i) => v - min[i]) };
}

const IDENTITY = { sx: 1, sy: 1, sz: 1, tx: 0, ty: 0, tz: 0 };

describe('Trench Car model + handling spec', () => {
	let wheels; let bodyOnly;

	beforeAll(async () => {
		await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
		const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
			'meshopt.decoder': MeshoptDecoder,
			'meshopt.encoder': MeshoptEncoder,
		});
		const doc = await io.read(MODEL);
		const nodes = doc.getRoot().listNodes();
		// Same rule src/game/vehicle-model.js applies at runtime.
		const wheelNodes = nodes.filter((n) => /^wheel/i.test(n.getName() || ''));
		wheels = wheelNodes.map((n) => nodeBounds(n, IDENTITY)).sort((a, b) => b.centre[2] - a.centre[2]);
		const bodyNode = nodes.find((n) => /^car body$/i.test(n.getName() || ''));
		const bodyMeshNode = bodyNode.listChildren().find((c) => c.getMesh() && !/^wheel/i.test(c.getName() || ''));
		bodyOnly = nodeBounds(bodyMeshNode, IDENTITY);
	});

	it('stages an optimized asset, not the 16 MB gallery master', async () => {
		const { size } = await import('node:fs').then((fs) => fs.statSync(MODEL));
		expect(size).toBeGreaterThan(0);
		expect(size).toBeLessThan(4 * 1024 * 1024);
	});

	it('exports exactly four wheels the runtime can steer and roll', () => {
		expect(wheels).toHaveLength(4);
	});

	it('matches the handling spec it was measured from', () => {
		const spec = VEHICLE_TYPES.trench;
		// Body box: the collider the world is driven against. Height is measured
		// road-to-roof (the underbody floats above the asphalt on its wheels), so
		// the collider wraps the whole visible car rather than its AABB alone.
		expect(bodyOnly.size[0]).toBeCloseTo(spec.dims.w, 1);
		expect(bodyOnly.max[1]).toBeCloseTo(spec.dims.h, 1);
		expect(bodyOnly.min[1]).toBeGreaterThan(0);
		expect(bodyOnly.size[2]).toBeCloseTo(spec.dims.l, 1);

		// Wheel radius and track, read off the tyres themselves.
		const radius = wheels[0].size[1] / 2;
		expect(radius).toBeCloseTo(spec.wheel.radius, 1);
		const halfTrack = spec.dims.w / 2 - spec.wheel.inset;
		expect(Math.abs(wheels[0].centre[0])).toBeCloseTo(halfTrack, 1);

		// Wheelbase: +z is forward, so the first two are the steered pair.
		expect(wheels[0].centre[2]).toBeCloseTo(spec.wheel.frontZ, 1);
		expect(wheels[3].centre[2]).toBeCloseTo(spec.wheel.rearZ, 1);
	});

	it('rests its wheels on the road, so the model sits at the physics ride height', () => {
		// The GLB is authored with its contact patch at y=0, and the mesh is dropped
		// by vehicleRestHeight into chassis space. The wheel centres must then land
		// exactly one radius above the road, or the car floats or sinks.
		const restHeight = vehicleRestHeight('trench');
		for (const wheel of wheels) {
			expect(wheel.centre[1] - restHeight).toBeCloseTo(-restHeight + VEHICLE_TYPES.trench.wheel.radius, 1);
			expect(wheel.min[1]).toBeCloseTo(0, 1);
		}
	});
});

describe('vehicle fleet invariants', () => {
	it('resolves the Trench Car as the default type', () => {
		expect(DEFAULT_VEHICLE_TYPE).toBe('trench');
		expect(isVehicleType('trench')).toBe(true);
		expect(vehicleSpec('trench').label).toBe('Trench Car');
		// An unknown or blank type must not fall back to some other car.
		expect(vehicleSpec('').id).toBe('trench');
		expect(vehicleSpec(undefined).id).toBe('trench');
	});

	it('is the only car in the world', () => {
		// Owner directive 2026-08-17: the Trench Car is the whole fleet. A second
		// type creeping back in is exactly how the boxy procedural silhouettes
		// (an amber roll-caged buggy among them) ended up driving around /play, so
		// the table itself is pinned, not just the spawn list.
		expect(Object.keys(VEHICLE_TYPES)).toEqual(['trench']);
		for (const spawn of VEHICLE_SPAWNS) expect(spawn.type).toBe('trench');
	});

	it('parks the default car where a new player lands', () => {
		const plaza = VEHICLE_SPAWNS.filter((s) => s.id.startsWith('veh-plaza-'));
		expect(plaza.length).toBeGreaterThan(0);
		for (const spawn of plaza) expect(spawn.type).toBe('trench');
		// Every spawn still names a real type, or the server silently drops it.
		for (const spawn of VEHICLE_SPAWNS) expect(isVehicleType(spawn.type)).toBe(true);
	});

	it('keeps every chassis collider clear of the road', () => {
		// PhysicsWorld.createVehicle offsets the chassis cuboid by -0.3 * (h/2), so
		// its underside sits 1.3 * (h/2) below the body origin. If that reaches the
		// ground the hull's own friction pins the car and no engine force moves it,
		// the bug the trench suspension comment documents.
		for (const [id, spec] of Object.entries(VEHICLE_TYPES)) {
			const clearance = vehicleRestHeight(id) - 1.3 * (spec.dims.h / 2);
			expect(clearance, `${id} chassis clearance`).toBeGreaterThan(0.1);
		}
	});

	it('seats every driver inside the car', () => {
		// seat.y is the offset from the chassis centre to the driver's feet. Land it
		// between the road and the roofline: above is the standing-on-the-roof bug,
		// below buries the driver under the asphalt.
		for (const [id, spec] of Object.entries(VEHICLE_TYPES)) {
			const feet = vehicleRestHeight(id) + spec.seat.y;
			expect(feet, `${id} seat height`).toBeGreaterThan(0);
			expect(feet, `${id} seat height`).toBeLessThan(spec.dims.h * 0.75);
			// Driver's side, not the middle of the bench.
			expect(Math.abs(spec.seat.x), `${id} seat offset`).toBeGreaterThan(0.2);
		}
	});
});
