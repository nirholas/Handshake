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

	test('the stand-in parks on its wheels while the model is still downloading', async ({ page }) => {
		// A player can walk up to a car in the frame it spawns, before the GLB has
		// landed. The stand-in shares the ride-height maths with the model, so it is
		// pinned by the same measurement: on the road, not floating or sunk.
		const car = await page.evaluate(async () => {
			const THREE = await window.__imp('/node_modules/three/build/three.module.js');
			const { buildVehicleMesh } = await window.__imp('/src/game/vehicle-mesh.js');
			const { vehicleSpec, vehicleRestHeight } = await window.__imp('/multiplayer/src/vehicles.js');

			const spec = vehicleSpec('trench');
			const rest = vehicleRestHeight(spec.id);
			// Measured WITHOUT awaiting mesh.ready: this is the stand-in, on screen in
			// the same frame the vehicle state arrived.
			const mesh = buildVehicleMesh(spec, spec.color);
			mesh.group.position.y = rest;
			const scene = new THREE.Scene();
			scene.add(mesh.group);
			scene.updateMatrixWorld(true);
			const box = new THREE.Box3().setFromObject(mesh.group);
			const out = {
				restHeight: rest,
				lowestPoint: box.min.y,
				wheels: mesh.wheels.length,
				wheelWorldY: mesh.wheels.map((w) => w.pivot.position.y + rest),
				driverFeetY: rest + spec.seat.y,
			};
			mesh.dispose();
			return out;
		});

		expect(car.wheels).toBe(4);
		// One wheel radius above the road (trench wheel.radius = 0.3), the same
		// contact patch the model-backed car above is held to.
		for (const y of car.wheelWorldY) expect(y).toBeCloseTo(0.3, 2);
		expect(car.lowestPoint).toBeGreaterThan(-0.05);
		expect(car.driverFeetY).toBeGreaterThan(0);
	});

	test('ambient traffic drives the same car the fleet does', async ({ page }) => {
		// The NPC lane is the other half of "the one car in the world": whatever a
		// player can take the wheel of is what they watch drive past, in every town
		// (frontier included, which used to run horse wagons here). AmbientLife
		// builds its own stand-in first, so this asserts the upgrade actually lands,
		// that the cars sit on the road (not sunk into it), and that each one spins
		// its own four wheels.
		const traffic = await page.evaluate(async () => {
			const THREE = await window.__imp('/node_modules/three/build/three.module.js');
			const { NavGraph } = await window.__imp('/src/game/npc/nav-graph.js');
			const { AmbientLife } = await window.__imp('/src/game/npc/ambient-life.js');
			const { hasVehicleModel, TRENCH_CAR_URL } = await window.__imp('/src/game/vehicle-model.js');

			const scene = new THREE.Scene();
			const life = new AmbientLife({ scene, nav: new NavGraph({ seed: 7 }) });
			// Give the shared model time to land, then run a few frames so the cars
			// take their places on the ring road.
			const deadline = Date.now() + 30000;
			while (!hasVehicleModel(TRENCH_CAR_URL) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
			await new Promise((r) => setTimeout(r, 2500));
			for (let i = 0; i < 8; i++) life.update(1 / 60, { player: { x: 999, y: 0, z: 999 } });
			// Park the wheels at zero roll before measuring: a rolling wheel's world
			// AABB grows to its own diagonal, which reads as the car sinking into the
			// road when it is only the measurement box that got bigger.
			for (const v of life.vehicles) for (const w of v.wheels) w.rotation.x = 0;
			scene.updateMatrixWorld(true);

			const cars = life.vehicles.map((v) => {
				const box = new THREE.Box3().setFromObject(v.group);
				let lamps = 0;
				v.group.traverse((n) => {
					if (!n.isMesh) return;
					for (const mat of Array.isArray(n.material) ? n.material : [n.material]) {
						if (mat && /^stoplamp$/i.test(mat.name || '')) lamps++;
					}
				});
				return { wheels: v.wheels.length, lowest: box.min.y, height: box.max.y - box.min.y, lamps, upgraded: !!v._model };
			});
			const out = { count: life.vehicles.length, cars };
			life.dispose();
			return out;
		});

		expect(traffic.count).toBeGreaterThan(0);
		for (const car of traffic.cars) {
			expect(car.upgraded, 'traffic car kept its stand-in').toBe(true);
			expect(car.wheels).toBe(4);
			expect(car.lamps).toBeGreaterThan(0);
			// On the road surface, not floating over it or buried in it.
			expect(car.lowest).toBeGreaterThan(-0.05);
			expect(car.lowest).toBeLessThan(0.05);
			expect(car.height).toBeCloseTo(1.31, 1);
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
