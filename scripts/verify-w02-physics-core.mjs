// Fast, direct, real-Rapier verification for W02's vehicle controller — no
// browser, no game loop, no network, so it is immune to this box's frame-rate
// starvation under heavy concurrent-agent load. Exercises the exact production
// module (src/physics/physics-world.js createVehicle) and the exact spec table
// (multiplayer/src/vehicles.js) the client and server both use.

import { PhysicsWorld, initRapier } from '../src/physics/physics-world.js';
import { vehicleSpec, vehicleRestHeight } from '../multiplayer/src/vehicles.js';

function ok(msg) { console.log('OK:', msg); }
function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }

async function main() {
	const rapier = await initRapier();
	const spec = vehicleSpec('sedan');
	const y = vehicleRestHeight('sedan') + 0.1;

	// --- Sub-test 1: open ground, prove real acceleration under throttle -----
	const worldA = new PhysicsWorld(rapier);
	worldA.addGround(0, 200);
	const vehA = worldA.createVehicle({ position: { x: 0, y, z: 0 }, yaw: 0, spec });
	ok('createVehicle() returned a real Rapier DynamicRayCastVehicleController facade');

	const positions = [];
	for (let i = 0; i < 300; i++) { // 5 simulated seconds at 60Hz, nothing in the way
		vehA.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false });
		worldA.step(1 / 60);
		if (i % 30 === 0) positions.push(vehA.transform());
	}
	const t1 = vehA.transform();
	ok(`after 5s throttle on open ground: pos=(${t1.x.toFixed(2)}, ${t1.y.toFixed(2)}, ${t1.z.toFixed(2)}) speed=${t1.speed.toFixed(2)} m/s`);
	if (Math.abs(t1.z) < 2) fail('vehicle barely moved under 5s of full throttle — raycast vehicle controller looks broken');
	else ok(`vehicle moved ${Math.abs(t1.z).toFixed(2)}m from a standing start under real Rapier forces`);
	if (t1.speed <= 0.5) fail('vehicle speed did not build up under throttle');
	else ok(`vehicle built up real forward speed (${t1.speed.toFixed(2)} m/s), top speed spec=${spec.topSpeed} m/s`);
	console.log(consoleTrail(positions));

	// --- Sub-test 2: a wall close in front, prove real collision (not a --------
	// bounds-clamp teleport, not tunnelling) — a fresh vehicle so the wall can't
	// contaminate sub-test 1's open-ground acceleration reading.
	const worldB = new PhysicsWorld(rapier);
	worldB.addGround(0, 200);
	worldB.addStaticBox({ position: { x: 0, y: 1, z: 6 }, halfExtents: { x: 3, y: 2, z: 0.5 } });
	const vehB = worldB.createVehicle({ position: { x: 0, y, z: 0 }, yaw: 0, spec });
	for (let i = 0; i < 300; i++) { // 5s — plenty of time to reach a wall 6m away
		vehB.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false });
		worldB.step(1 / 60);
	}
	const t2 = vehB.transform();
	ok(`after 5s throttle toward a wall at z=6: pos.z=${t2.z.toFixed(2)}, speed=${t2.speed.toFixed(2)} m/s`);
	if (t2.z < 2) fail('vehicle never got close to the wall — something upstream of the collision check is broken');
	else if (t2.z > 6.2) fail(`vehicle tunnelled through the wall (z=${t2.z.toFixed(2)} > 6.2) — collision is not real`);
	else ok('vehicle accelerated toward the wall and was physically stopped by it — real Rapier collision, no tunnelling');

	// --- Sub-test 3: steering + handbrake sanity, on open ground again --------
	const worldC = new PhysicsWorld(rapier);
	worldC.addGround(0, 200);
	const vehC = worldC.createVehicle({ position: { x: 0, y, z: 0 }, yaw: 0, spec });
	for (let i = 0; i < 120; i++) { vehC.setInput({ throttle: 1, brake: 0, steer: 0.6, handbrake: false }); worldC.step(1 / 60); }
	const t3 = vehC.transform();
	if (Math.abs(t3.x) < 0.3) fail('steering input produced no lateral displacement');
	else ok(`steering produced real lateral displacement (x=${t3.x.toFixed(2)}) — front wheels actually turn the chassis`);

	for (let i = 0; i < 90; i++) { vehC.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: true }); worldC.step(1 / 60); }
	const t4 = vehC.transform();
	if (Math.abs(t4.speed) > 1.5) fail(`handbrake failed to arrest speed (still ${t4.speed.toFixed(2)} m/s)`);
	else ok(`handbrake brought the vehicle to a near-stop (${t4.speed.toFixed(2)} m/s)`);

	worldA.removeVehicle(vehA);
	worldB.removeVehicle(vehB);
	worldC.removeVehicle(vehC);
	ok('removeVehicle() cleaned up without throwing');
}

function consoleTrail(positions) {
	return '   trajectory samples (z every 0.5s): ' + positions.map((p) => p.z.toFixed(2)).join(', ');
}

main().catch((err) => { console.error('SCRIPT ERROR:', err); process.exitCode = 1; });
