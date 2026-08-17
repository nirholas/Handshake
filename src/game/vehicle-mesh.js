// Vehicle meshes for the drivable fleet.
//
// Two kinds of car live here. Procedural silhouettes (coupe / sedan / pickup /
// buggy) are built from primitives so they load instantly and theme to each
// vehicle's colour. Model-backed types (the Trench Car, VEHICLE_TYPES.trench)
// carry a `model` key and drive a real GLB from src/game/vehicle-model.js: the
// procedural silhouette is built first as an instant stand-in, and the GLB body
// and wheels are swapped into the SAME group and wheel pivots the moment the
// download lands. Nothing downstream re-binds, so a car that upgrades mid-drive
// keeps its physics, its camera and its driver.
//
// The returned group's origin is the chassis CENTRE, aligned with the Rapier
// rigid body's origin, with +z forward and +y up — so the physics transform maps
// straight onto group.position / group.quaternion. Wheels are returned separately:
// each is a steer pivot (set rotation.y to steer, position to follow suspension)
// holding a spinner mesh (set rotation.x to roll). The manager drives both from
// the vehicle controller each frame.

import {
	Group, Mesh, BoxGeometry, CylinderGeometry, SphereGeometry,
	MeshStandardMaterial, MeshBasicMaterial, Color,
} from 'three';
import { vehicleRestHeight } from '../../multiplayer/src/vehicles.js';
import { instantiateVehicleModel, TRENCH_CAR_URL } from './vehicle-model.js';
import { log } from '../shared/log.js';

// `spec.model` is a key, not a path: the handling table is shared with the
// server, which has no business knowing where the client serves assets from.
const MODEL_URLS = { 'trench-car': TRENCH_CAR_URL };

function lighten(hex, amt) {
	const c = new Color(hex);
	c.lerp(new Color(0xffffff), amt);
	return c.getHex();
}
function darken(hex, amt) {
	const c = new Color(hex);
	c.lerp(new Color(0x000000), amt);
	return c.getHex();
}

// A reusable wheel: a black tyre cylinder (axle along x) plus a metallic hub, so
// the spin reads. Built once per wheel; the geometry is pre-oriented so the
// spinner only ever rotates about x to roll.
function buildWheel(radius, halfWidth) {
	const pivot = new Group();      // steering + suspension follow
	const spinner = new Group();    // rolling
	pivot.add(spinner);

	const tyreGeo = new CylinderGeometry(radius, radius, halfWidth * 2, 22);
	tyreGeo.rotateZ(Math.PI / 2); // axis Y → axis X (the axle)
	const tyre = new Mesh(tyreGeo, new MeshStandardMaterial({ color: 0x141417, roughness: 0.85, metalness: 0.1 }));
	tyre.castShadow = true;
	spinner.add(tyre);

	const hubGeo = new CylinderGeometry(radius * 0.42, radius * 0.42, halfWidth * 2.05, 12);
	hubGeo.rotateZ(Math.PI / 2);
	const hub = new Mesh(hubGeo, new MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.35, metalness: 0.8 }));
	spinner.add(hub);
	// A spoke bar so the roll is legible at speed.
	const spokeGeo = new BoxGeometry(halfWidth * 2.1, radius * 1.5, radius * 0.16);
	const spoke = new Mesh(spokeGeo, new MeshStandardMaterial({ color: 0x33363d, roughness: 0.5, metalness: 0.6 }));
	spinner.add(spoke);

	return { pivot, spinner };
}

function bodyMat(color) {
	return new MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.55 });
}
function glassMat() {
	return new MeshStandardMaterial({ color: 0x0a0d14, roughness: 0.15, metalness: 0.4, emissive: 0x05070b, emissiveIntensity: 0.4 });
}

// Two red tail-light strips at the rear; the manager brightens them on braking.
function buildTailLights(width, z, y) {
	const lights = [];
	const geo = new BoxGeometry(0.32, 0.16, 0.06);
	for (const sx of [-1, 1]) {
		const mat = new MeshBasicMaterial({ color: 0x6e1411 });
		const m = new Mesh(geo, mat);
		m.position.set(sx * (width / 2 - 0.3), y, z);
		lights.push(m);
	}
	return lights;
}
// Headlights — static emissive pucks so the car reads as facing forward.
function buildHeadLights(width, z, y) {
	const geo = new SphereGeometry(0.13, 12, 10);
	const mat = new MeshBasicMaterial({ color: 0xf4f1d8 });
	const out = [];
	for (const sx of [-1, 1]) {
		const m = new Mesh(geo, mat);
		m.position.set(sx * (width / 2 - 0.32), y, z);
		out.push(m);
	}
	return out;
}

function buildCoupe(spec, color) {
	const body = new Group();
	const { l, w } = spec.dims;
	const main = bodyMat(color);
	const lower = new Mesh(new BoxGeometry(w, 0.55, l), main);
	lower.position.y = 0.05; lower.castShadow = true; lower.receiveShadow = true;
	body.add(lower);
	// Sleek raked cabin, set back.
	const cabin = new Mesh(new BoxGeometry(w * 0.82, 0.46, l * 0.42), bodyMat(lighten(color, 0.05)));
	cabin.position.set(0, 0.5, -0.15); cabin.castShadow = true;
	body.add(cabin);
	const glass = new Mesh(new BoxGeometry(w * 0.78, 0.34, l * 0.4), glassMat());
	glass.position.set(0, 0.52, -0.12);
	body.add(glass);
	// A low front splitter for a sporty nose.
	const splitter = new Mesh(new BoxGeometry(w * 0.96, 0.12, 0.5), bodyMat(darken(color, 0.5)));
	splitter.position.set(0, -0.18, l / 2 - 0.2);
	body.add(splitter);
	return body;
}

function buildSedan(spec, color) {
	const body = new Group();
	const { l, w } = spec.dims;
	const lower = new Mesh(new BoxGeometry(w, 0.62, l), bodyMat(color));
	lower.position.y = 0.08; lower.castShadow = true; lower.receiveShadow = true;
	body.add(lower);
	const cabin = new Mesh(new BoxGeometry(w * 0.9, 0.6, l * 0.5), bodyMat(lighten(color, 0.04)));
	cabin.position.set(0, 0.62, -0.05); cabin.castShadow = true;
	body.add(cabin);
	const glass = new Mesh(new BoxGeometry(w * 0.86, 0.46, l * 0.48), glassMat());
	glass.position.set(0, 0.64, -0.03);
	body.add(glass);
	return body;
}

function buildPickup(spec, color) {
	const body = new Group();
	const { l, w } = spec.dims;
	const chassis = new Mesh(new BoxGeometry(w, 0.66, l), bodyMat(color));
	chassis.position.y = 0.1; chassis.castShadow = true; chassis.receiveShadow = true;
	body.add(chassis);
	// Forward cab.
	const cab = new Mesh(new BoxGeometry(w * 0.94, 0.82, l * 0.4), bodyMat(lighten(color, 0.03)));
	cab.position.set(0, 0.78, l * 0.18); cab.castShadow = true;
	body.add(cab);
	const glass = new Mesh(new BoxGeometry(w * 0.9, 0.5, l * 0.36), glassMat());
	glass.position.set(0, 0.86, l * 0.19);
	body.add(glass);
	// Open rear bed: floor + three low walls.
	const bedMat = bodyMat(darken(color, 0.18));
	const bedW = w * 0.96, bedL = l * 0.4, wall = 0.32;
	const floor = new Mesh(new BoxGeometry(bedW, 0.16, bedL), bedMat);
	floor.position.set(0, 0.5, -l * 0.22); body.add(floor);
	const back = new Mesh(new BoxGeometry(bedW, wall, 0.12), bedMat);
	back.position.set(0, 0.64, -l * 0.42); body.add(back);
	for (const sx of [-1, 1]) {
		const side = new Mesh(new BoxGeometry(0.12, wall, bedL), bedMat);
		side.position.set(sx * (bedW / 2 - 0.06), 0.64, -l * 0.22); body.add(side);
	}
	return body;
}

function buildBuggy(spec, color) {
	const body = new Group();
	const { l, w } = spec.dims;
	const tub = new Mesh(new BoxGeometry(w * 0.78, 0.5, l * 0.8), bodyMat(color));
	tub.position.y = 0.08; tub.castShadow = true; tub.receiveShadow = true;
	body.add(tub);
	// Exposed roll cage from thin bars.
	const cageMat = new MeshStandardMaterial({ color: darken(color, 0.45), roughness: 0.4, metalness: 0.7 });
	const bar = (sx, z) => {
		const m = new Mesh(new BoxGeometry(0.1, 0.78, 0.1), cageMat);
		m.position.set(sx * w * 0.32, 0.5, z); body.add(m);
	};
	bar(-1, 0.2); bar(1, 0.2); bar(-1, -0.5); bar(1, -0.5);
	const roof = new Mesh(new BoxGeometry(w * 0.7, 0.1, 0.84), cageMat);
	roof.position.set(0, 0.88, -0.15); body.add(roof);
	const seatback = new Mesh(new BoxGeometry(w * 0.6, 0.42, 0.12), glassMat());
	seatback.position.set(0, 0.42, -0.42); body.add(seatback);
	return body;
}

const BUILDERS = { coupe: buildCoupe, sedan: buildSedan, pickup: buildPickup, buggy: buildBuggy };

// Free every geometry/material an object owns. Only ever called on the
// procedural parts this module built, GLB parts share their buffers with the
// model template and are released through the instance's own dispose().
function disposeOwned(root) {
	root.traverse((o) => {
		if (o.geometry) o.geometry.dispose?.();
		if (o.material) {
			if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
			else o.material.dispose?.();
		}
	});
}

/**
 * Build a complete vehicle mesh for a spec + colour.
 *
 * Returns synchronously, a model-backed type hands back its procedural
 * stand-in and upgrades itself in place once the GLB arrives.
 *
 * @returns {{ group: Group, wheels: Array<{pivot: Group, spinner: Group}>,
 *   setBrake: (on: boolean) => void, ready: Promise<boolean>, dispose: Function }}
 */
export function buildVehicleMesh(spec, color) {
	const group = new Group();
	const tint = Number.isFinite(color) ? color : spec.color;

	// The body and its lights live under one node so a GLB swap replaces the
	// whole procedural shell in one move, without touching the wheel pivots the
	// vehicle controller drives.
	const bodyRoot = new Group();
	group.add(bodyRoot);

	const builder = BUILDERS[spec.id] || buildSedan;
	bodyRoot.add(builder(spec, tint));

	// Lights, placed off the body's front/rear faces.
	const { l, w } = spec.dims;
	const tail = buildTailLights(w, -l / 2 + 0.05, 0.18);
	const head = buildHeadLights(w, l / 2 - 0.05, 0.12);
	for (const m of tail) bodyRoot.add(m);
	for (const m of head) bodyRoot.add(m);

	// Four wheels at the chassis corners (matching the physics connection points).
	const wb = w / 2 - spec.wheel.inset;
	// Resting suspension connection height in chassis space. This MUST match
	// PhysicsWorld.createVehicle's `cy = -(h / 2) * 0.2` and the same term in
	// vehicleRestHeight: it was -h * 0.2 here, twice the offset the simulation
	// uses, which parked every car with its wheels sunk (h/2)*0.2 into the road
	// and then snapped them up the instant a driver took the wheel and
	// _updateDrivenWheels started writing real connection points.
	const cy = -(spec.dims.h / 2) * 0.2;
	const positions = [
		{ x: wb, z: spec.wheel.frontZ },
		{ x: -wb, z: spec.wheel.frontZ },
		{ x: wb, z: spec.wheel.rearZ },
		{ x: -wb, z: spec.wheel.rearZ },
	];
	const wheels = positions.map((p) => {
		const wheel = buildWheel(spec.wheel.radius, spec.wheel.halfWidth);
		wheel.pivot.position.set(p.x, cy - spec.suspension.rest, p.z);
		group.add(wheel.pivot);
		return wheel;
	});

	let model = null;      // the GLB instance, once it lands
	let disposed = false;
	let braking = false;

	const mesh = {
		group,
		wheels,
		// Brake-light state, whichever body is currently mounted.
		setBrake(on) {
			braking = !!on;
			if (model) { model.setBrake(braking); return; }
			for (const bl of tail) bl.material.color.setHex(braking ? 0xff3b30 : 0x6e1411);
		},
		ready: Promise.resolve(false),
		dispose() {
			disposed = true;
			// Detach the GLB parts BEFORE freeing what this module owns: their
			// geometry and textures belong to the shared template and are still in
			// use by every other car wearing the same model.
			if (model) {
				bodyRoot.clear();
				for (const w of wheels) w.spinner.clear();
				model.dispose();
				model = null;
			}
			disposeOwned(group);
		},
	};

	const url = MODEL_URLS[spec.model];
	if (url) {
		mesh.ready = instantiateVehicleModel(url)
			.then((instance) => {
				// Disposed while the model was in flight: hand the reference straight
				// back so the shared template's refcount stays honest.
				if (disposed) { instance.dispose(); return false; }
				// The GLB is authored with its origin on the road; this group's origin
				// is the chassis centre, so drop it by the resting ride height.
				instance.body.position.y = -vehicleRestHeight(spec.id);
				disposeOwned(bodyRoot);
				bodyRoot.clear();
				bodyRoot.add(instance.body);
				// Re-skin the wheels in place: the pivots stay the same objects, so
				// the suspension/steer/roll writes from VehicleManager keep landing.
				for (let i = 0; i < wheels.length && i < instance.wheels.length; i++) {
					const spinner = wheels[i].spinner;
					disposeOwned(spinner);
					spinner.clear();
					for (const child of [...instance.wheels[i].spinner.children]) spinner.add(child);
				}
				model = instance;
				model.setBrake(braking);
				return true;
			})
			.catch((e) => {
				// The procedural stand-in is already on screen and fully drivable, so
				// a missing model costs looks, never the feature.
				log.warn(`[vehicle-mesh] ${spec.id} model unavailable, keeping the stand-in:`, e?.message);
				return false;
			});
	}

	return mesh;
}
