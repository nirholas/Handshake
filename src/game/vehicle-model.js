// Shared GLB car models for the world's traffic and its drivable fleet.
//
// The Trench Car (a community model published to the three.ws avatar gallery,
// staged into public/vehicles/ by scripts/build-trench-car.mjs) is the default
// car everywhere in /play: ambient traffic drives it and it is what a player
// takes the wheel of. Both surfaces want the same thing from a car GLB, so the
// splitting work lives here once:
//
//   • one download + parse per URL, shared by every car on screen (a clone
//     shares geometry and textures with its template, exactly like the avatar
//     template cache in avatar-rig.js);
//   • the four wheel nodes lifted out into pivot/spinner pairs so a caller can
//     steer and roll them, matching the contract the procedural meshes in
//     vehicle-mesh.js already expose to VehicleManager;
//   • the brake-light material cloned per instance, so one car braking does not
//     light up every other car sharing the template.
//
// Positions are returned in MODEL space: the body group's origin is the car's
// contact patch with the road (y=0), and each wheel pivot sits at that wheel's
// centre. Callers that work in chassis-centre space (the drivable fleet) offset
// the body themselves; callers that sit cars on the ground (ambient traffic)
// use it as-is.

import { Box3, Group, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { dracoLoader, meshoptReady } from './avatar-rig.js';
import { log } from '../shared/log.js';

// The staged, optimized copy. The 16 MB gallery master is unusable on a page
// every visitor loads; see scripts/build-trench-car.mjs for how this is built.
export const TRENCH_CAR_URL = '/vehicles/trench-car.glb';

// Blender exports the wheels as siblings named wheel1..wheel4 (with a space in
// two of them). Matching on the name prefix keeps this working through the
// gltf-transform pass, which preserves node names but re-parents the body mesh.
const WHEEL_NODE = /^wheel/i;
// Material names from the source model. `stoplamp` is the rear brake bar.
const BRAKE_MATERIAL = /^stoplamp$/i;

const _loader = new GLTFLoader();
_loader.setDRACOLoader(dracoLoader);
let _decoderWired = false;

const _templates = new Map(); // url → { promise, refs }
const _box = new Box3();
const _centre = new Vector3();

function loadTemplate(url) {
	let entry = _templates.get(url);
	if (entry) return entry;
	entry = { refs: 0, promise: null };
	entry.promise = (async () => {
		// Staged car GLBs keep EXT_meshopt_compression, so the decoder has to be
		// on the loader before the first parse or GLTFLoader throws on bufferView 0.
		const decoder = await meshoptReady;
		if (decoder && !_decoderWired) { _loader.setMeshoptDecoder(decoder); _decoderWired = true; }
		const gltf = await _loader.loadAsync(url);
		gltf.scene.updateMatrixWorld(true);
		return gltf.scene;
	})();
	// A failed load must not poison the URL for the rest of the session.
	entry.promise.catch(() => { if (_templates.get(url) === entry) _templates.delete(url); });
	_templates.set(url, entry);
	return entry;
}

/** True once a model is downloaded (or downloading), so another car is free. */
export function hasVehicleModel(url) {
	return _templates.has(url);
}

// Lift one wheel node onto a pivot/spinner pair centred on the wheel itself.
// `attach` preserves the node's world transform through the re-parent, so this
// survives whatever transforms the export (and gltf-transform's quantization)
// left on the node chain.
function liftWheel(node) {
	_box.setFromObject(node);
	_box.getCenter(_centre);
	const pivot = new Group();
	pivot.position.copy(_centre);
	const spinner = new Group();
	pivot.add(spinner);
	pivot.updateMatrixWorld(true);
	spinner.attach(node);
	return { pivot, spinner };
}

/**
 * Clone a car model into a fresh, drivable set of parts.
 *
 * @returns {Promise<{ body: Group, wheels: Array<{pivot: Group, spinner: Group}>,
 *   wheelRadius: number, setBrake: (on: boolean) => void, dispose: () => void }>}
 *   `body` holds the chassis with the wheels removed; `wheels` are ordered
 *   front-left, front-right, rear-left, rear-right to match the wheel order
 *   PhysicsWorld.createVehicle uses.
 */
export async function instantiateVehicleModel(url) {
	const entry = loadTemplate(url);
	const template = await entry.promise;
	entry.refs++;

	const body = template.clone(true);
	body.updateMatrixWorld(true);

	const wheelNodes = [];
	body.traverse((n) => { if (WHEEL_NODE.test(n.name || '')) wheelNodes.push(n); });
	const wheels = wheelNodes.map(liftWheel);
	// Front wheels first (+z is forward), then left before right on each axle, so
	// index 0..3 lines up with the steered-front-pair order the vehicle
	// controller and VehicleManager._updateDrivenWheels both assume.
	wheels.sort((a, b) => (b.pivot.position.z - a.pivot.position.z) || (b.pivot.position.x - a.pivot.position.x));

	// Wheel radius from the model itself, so a caller can sanity-check the
	// handling spec against the mesh it is actually driving.
	let wheelRadius = 0;
	for (const w of wheels) wheelRadius = Math.max(wheelRadius, w.pivot.position.y);

	// Per-instance brake material: cloned so this car's brake lights are its own.
	const ownMaterials = [];
	const brakeMaterials = [];
	body.traverse((n) => {
		if (!n.isMesh) return;
		n.castShadow = true;
		n.receiveShadow = true;
		const mats = Array.isArray(n.material) ? n.material : [n.material];
		mats.forEach((mat, i) => {
			if (!mat || !BRAKE_MATERIAL.test(mat.name || '')) return;
			const own = mat.clone();
			ownMaterials.push(own);
			brakeMaterials.push(own);
			if (Array.isArray(n.material)) n.material[i] = own; else n.material = own;
		});
	});
	for (const w of wheels) w.spinner.traverse((n) => { if (n.isMesh) n.castShadow = true; });

	const restColor = brakeMaterials.map((m) => m.color.getHex());
	let braking = false;

	return {
		body,
		wheels,
		wheelRadius,
		// Brake lights: brighten the lamp and add emissive so it reads at night
		// and in the shade, then restore the model's own paint when released.
		setBrake(on) {
			const next = !!on;
			if (next === braking) return;
			braking = next;
			brakeMaterials.forEach((mat, i) => {
				mat.color.setHex(next ? 0xff3b30 : restColor[i]);
				mat.emissive?.setHex(next ? 0x5a0f0c : 0x000000);
			});
		},
		// Per-instance materials only: geometry and textures belong to the shared
		// template, which outlives this car.
		dispose() {
			for (const mat of ownMaterials) mat.dispose();
			entry.refs = Math.max(0, entry.refs - 1);
		},
	};
}

/**
 * Warm the shared template so the first car on screen is already textured.
 * Fire-and-forget: a failure is logged and every caller falls back on its own.
 */
export function preloadVehicleModel(url = TRENCH_CAR_URL) {
	loadTemplate(url).promise.catch((e) => log.warn('[vehicle-model] preload failed:', e?.message));
}
