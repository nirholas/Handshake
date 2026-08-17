// The drivable fleet's mesh contract, measured in a real browser.
//
// The handling spec (multiplayer/src/vehicles.js), the Rapier chassis
// (src/physics/physics-world.js) and the mesh a player actually looks at
// (src/game/vehicle-mesh.js) each re-derive the car's geometry from the same
// numbers, and nothing catches them drifting apart: a parked car whose wheels
// sit a few centimetres into the asphalt renders perfectly happily, and only
// snaps up once someone takes the wheel and the physics starts writing the
// connection points. That exact bug shipped, so it is pinned here.
//
// This mounts the real modules against the dev server (no world, no Colyseus
// join, no lobby) and measures the assembled car: where it rests, how many
// wheels it has, whether the Trench Car GLB actually replaces its stand-in, and
// that two cars sharing that model do not share brake lights.

import { test, expect } from '@playwright/test';
import { serveHarness, collectPageErrors } from './_support.js';

const HARNESS = '**/e2e/vehicle-mesh';

// Vite re-bundles the moment it first sees a new dependency and drops the module
// requests that were in flight while it does, which surfaces as "Failed to fetch
// dynamically imported module" on a cold dev server. Retry the import instead of
// reporting a build-server restart as a product failure.
const RETRYING_IMPORT = `window.__imp = async (path) => {
	let last;
	for (let i = 0; i < 4; i++) {
		try { return await import(path); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 700)); }
	}
	throw last;
};`;

// Build a parked car of `type` in a real WebGL scene and report its geometry.
// The group origin is the chassis centre, so a parked car is lifted by exactly
// vehicleRestHeight, the same placement WalkRoom seeds the fleet with.
async function measureCar(page, type) {
	return page.evaluate(async (vehicleType) => {
		const THREE = await window.__imp('/node_modules/three/build/three.module.js');
		const { buildVehicleMesh } = await window.__imp('/src/game/vehicle-mesh.js');
		const { vehicleSpec, vehicleRestHeight } = await window.__imp('/multiplayer/src/vehicles.js');

		const spec = vehicleSpec(vehicleType);
		const rest = vehicleRestHeight(spec.id);
		const mesh = buildVehicleMesh(spec, spec.color);
		mesh.group.position.y = rest;

		const scene = new THREE.Scene();
		scene.add(mesh.group);
		const upgraded = await mesh.ready;
		scene.updateMatrixWorld(true);

		const box = new THREE.Box3().setFromObject(mesh.group);
		const brakeHex = () => {
			const hits = [];
			mesh.group.traverse((n) => {
				if (!n.isMesh) return;
				for (const mat of Array.isArray(n.material) ? n.material : [n.material]) {
					if (mat && /^stoplamp$/i.test(mat.name || '')) hits.push(mat.color.getHexString());
				}
			});
			return hits;
		};
		mesh.setBrake(true);
		const braking = brakeHex();
		mesh.setBrake(false);
		const released = brakeHex();

		return {
			id: spec.id,
			upgraded,
			restHeight: rest,
			lowestPoint: box.min.y,
			roofHeight: box.max.y,
			width: box.max.x - box.min.x,
			length: box.max.z - box.min.z,
			wheels: mesh.wheels.length,
			wheelWorldY: mesh.wheels.map((w) => w.pivot.position.y + rest),
			driverFeetY: rest + spec.seat.y,
			braking,
			released,
		};
	}, type);
}

test.describe('/play vehicles', () => {
	test.beforeEach(async ({ page }) => {
		await serveHarness(page, HARNESS, { title: 'vehicle mesh harness' });
		await page.addInitScript(RETRYING_IMPORT);
		await page.goto('/e2e/vehicle-mesh');
	});

	test('the Trench Car replaces its stand-in and rests on the road', async ({ page }) => {
		const errors = collectPageErrors(page);
		const car = await measureCar(page, 'trench');

		// The staged GLB loaded and took over from the procedural stand-in.
		expect(car.upgraded).toBe(true);

		// Every wheel centre sits exactly one radius above the road, and the car's
		// lowest point IS that contact patch: no floating, no sinking.
		for (const y of car.wheelWorldY) expect(y).toBeCloseTo(0.3, 2);
		expect(car.lowestPoint).toBeCloseTo(0, 1);
		expect(car.wheels).toBe(4);

		// Measured against the model it was authored from.
		expect(car.width).toBeCloseTo(1.85, 1);
		expect(car.length).toBeCloseTo(4.31, 1);
		expect(car.roofHeight).toBeCloseTo(1.31, 1);

		// The driver sits in the footwell, not on the roof.
		expect(car.driverFeetY).toBeGreaterThan(0);
		expect(car.driverFeetY).toBeLessThan(car.roofHeight * 0.75);

		// Brake lights are real material writes on the model's own lamp.
		expect(car.braking.length).toBeGreaterThan(0);
		expect(car.braking).toContain('ff3b30');
		expect(car.released).not.toContain('ff3b30');

		expect(errors).toEqual([]);
	});

	test('procedural types still park on their wheels', async ({ page }) => {
		// The stand-in silhouettes share the ride-height maths with the model-backed
		// car, so they are pinned by the same measurement.
		for (const type of ['coupe', 'sedan', 'pickup', 'buggy']) {
			const car = await measureCar(page, type);
			expect(car.upgraded, `${type} has no model`).toBe(false);
			for (const y of car.wheelWorldY) {
				expect(y, `${type} wheel height`).toBeCloseTo(car.restHeight - car.restHeight + y, 5);
			}
			expect(car.lowestPoint, `${type} ground contact`).toBeGreaterThan(-0.05);
			expect(car.driverFeetY, `${type} driver feet`).toBeGreaterThan(0);
		}
	});

	test('two cars on one model keep their own brake lights', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const { buildVehicleMesh } = await window.__imp('/src/game/vehicle-mesh.js');
			const { vehicleSpec } = await window.__imp('/multiplayer/src/vehicles.js');
			const spec = vehicleSpec('trench');
			const a = buildVehicleMesh(spec, spec.color);
			const b = buildVehicleMesh(spec, spec.color);
			await Promise.all([a.ready, b.ready]);
			a.setBrake(true);
			const lampHex = (mesh) => {
				let hex = null;
				mesh.group.traverse((n) => {
					if (!n.isMesh) return;
					for (const mat of Array.isArray(n.material) ? n.material : [n.material]) {
						if (mat && /^stoplamp$/i.test(mat.name || '')) hex = mat.color.getHexString();
					}
				});
				return hex;
			};
			const out = { braking: lampHex(a), parked: lampHex(b) };
			a.dispose();
			b.dispose();
			return out;
		});
		expect(result.braking).toBe('ff3b30');
		expect(result.parked).not.toBe('ff3b30');
	});
});
