// Vehicle spec — the single source of truth for drivable vehicles, shared by the
// authoritative server (WalkRoom) and the client (VehicleManager + physics).
//
// Why it lives in multiplayer/: the client already imports the schemas from here,
// so co-locating the handling table and spawn registry keeps one canonical
// definition. The server reads it to seed the fleet and to validate driver
// updates (speed/teleport clamps per type); the client reads the same numbers to
// tune its Rapier raycast vehicle, so a car drives identically to how the server
// polices it — no drift between "feels fast" and "rejected as cheating".
//
// Driving model (Notblox-style, matching how /play already nets movement): the
// driver simulates the vehicle with Rapier locally and streams the authoritative
// transform; the server validates bounds + per-type speed and relays it. The
// server stays the gate — it never trusts a transform that implies impossible
// speed, and it owns who is allowed to drive which vehicle.

// Handling profiles. Lengths in metres, mass in kg, forces in Newtons, speeds in
// m/s, angles in radians. Each type has a distinct feel:
//   coupe  — low, fast, light, twitchy steering, less grip (slides)
//   sedan  — the balanced everyday car
//   pickup — heavy, slower, planted, wide turning, lots of grip
//   buggy  — light off-roader, high grip + stiff suspension, nimble
export const VEHICLE_TYPES = {
	coupe: {
		id: 'coupe',
		label: 'Coupe',
		mass: 1100,
		topSpeed: 28,        // ~100 km/h
		engineForce: 5200,   // forward drive force per powered axle
		brakeForce: 110,
		reverseForce: 2600,
		steerMax: 0.52,      // max front-wheel steer angle
		steerSpeed: 3.2,     // how fast steering approaches the target (per second)
		grip: 1.9,           // wheel friction slip — lower = looser tail
		dims: { l: 4.1, w: 1.85, h: 1.05 },
		wheel: { radius: 0.34, halfWidth: 0.18, inset: 0.16, frontZ: 1.35, rearZ: -1.3 },
		// rest=0.4, not the more "sporty-low" 0.32 it started at: verified against
		// the real Rapier raycast vehicle controller (createVehicle in
		// src/physics/physics-world.js) that at 0.32 the chassis collider (offset
		// -0.3*hy below the body origin) settles low enough to rest on/against the
		// ground itself, so its own friction pins the car almost dead still no
		// matter how much engine force is applied (0.61 m/s after 3s of full
		// throttle in a scripted repro — scripts/verify-w02-physics-core.mjs).
		// 0.4 gives the chassis clearance over the wheel contact line so the wheels
		// (not the hull) carry the car's weight and traction (10.8 m/s after the
		// same 3s in the same repro).
		suspension: { rest: 0.4, stiffness: 26, travel: 0.16, compression: 0.82, relax: 0.88 },
		seat: { x: -0.42, y: 0.62, z: -0.2 }, // driver seat offset in chassis space
		color: 0xc8402f,
	},
	sedan: {
		id: 'sedan',
		label: 'Sedan',
		mass: 1350,
		topSpeed: 24,
		engineForce: 4600,
		brakeForce: 120,
		reverseForce: 2400,
		steerMax: 0.5,
		steerSpeed: 2.6,
		grip: 2.3,
		dims: { l: 4.4, w: 1.9, h: 1.25 },
		wheel: { radius: 0.36, halfWidth: 0.19, inset: 0.16, frontZ: 1.45, rearZ: -1.4 },
		// rest=0.5 (was 0.36 — same chassis-clearance bug as coupe's, see its
		// comment above; a taller sedan needed more lift than the coupe did).
		// Verified: stock 0.36 never moves (0.00 m/s after 3s full throttle) in
		// the real-Rapier repro; 0.5 reaches 7.9 m/s in the same window.
		suspension: { rest: 0.5, stiffness: 24, travel: 0.18, compression: 0.85, relax: 0.9 },
		seat: { x: -0.44, y: 0.72, z: -0.1 },
		color: 0x2f6fc8,
	},
	pickup: {
		id: 'pickup',
		label: 'Pickup',
		mass: 1950,
		topSpeed: 21,
		engineForce: 6200,
		brakeForce: 150,
		reverseForce: 3000,
		steerMax: 0.46,
		steerSpeed: 2.1,
		grip: 2.7,
		dims: { l: 5.0, w: 2.05, h: 1.5 },
		wheel: { radius: 0.42, halfWidth: 0.22, inset: 0.14, frontZ: 1.6, rearZ: -1.55 },
		// rest=0.6 (was 0.42 — the same chassis-clearance bug, worst here because
		// the pickup is the tallest chassis: h=1.5). At 0.42 it was FULLY pinned —
		// speed stayed ~0.00 m/s even at 10x its stock engine force in the
		// real-Rapier repro. 0.6 clears the chassis off the ground and reaches
		// 4.1 m/s in 3s, matching a heavy/planted truck's slower character.
		suspension: { rest: 0.6, stiffness: 22, travel: 0.22, compression: 0.85, relax: 0.9 },
		seat: { x: -0.5, y: 0.92, z: 0.35 },
		color: 0x2b2f36,
	},
	buggy: {
		id: 'buggy',
		label: 'Buggy',
		mass: 850,
		topSpeed: 25,
		engineForce: 4200,
		brakeForce: 100,
		reverseForce: 2200,
		steerMax: 0.6,
		steerSpeed: 3.6,
		grip: 3.0,
		dims: { l: 3.4, w: 1.8, h: 1.0 },
		wheel: { radius: 0.4, halfWidth: 0.24, inset: 0.06, frontZ: 1.2, rearZ: -1.15 },
		suspension: { rest: 0.46, stiffness: 28, travel: 0.26, compression: 0.8, relax: 0.86 },
		seat: { x: -0.4, y: 0.66, z: -0.1 },
		color: 0xe0a52e,
	},
};

export const VEHICLE_TYPE_IDS = Object.keys(VEHICLE_TYPES);

export function isVehicleType(t) {
	return typeof t === 'string' && Object.prototype.hasOwnProperty.call(VEHICLE_TYPES, t);
}

export function vehicleSpec(type) {
	return VEHICLE_TYPES[type] || VEHICLE_TYPES.sedan;
}

// The chassis-centre height a parked/resting vehicle sits at, derived from the
// same geometry `PhysicsWorld.createVehicle` uses for its wheel connection
// points (src/physics/physics-world.js): the connection sits `hy*0.2` below the
// chassis centre, the suspension extends `rest` further, and the wheel radius
// carries the rest of the way to the ground. Used to seed parked vehicles
// (so they don't spawn sunk into the asphalt) and to place the chassis when a
// driver takes the wheel.
export function vehicleRestHeight(type) {
	const spec = vehicleSpec(type);
	const hy = spec.dims.h / 2;
	return hy * 0.2 + spec.suspension.rest + spec.wheel.radius;
}

// The fleet every world spawns with. The avenue bays mirror W01's vehicle
// spawn-points (src/game/world-zones.js SPAWN_POINTS, type:'vehicle') so cars
// park on the open cross-avenues the district keeps clear of buildings; two
// plaza-edge cars sit near the Downtown spawn so a freshly-dropped player finds a
// ride within a few seconds' walk (clear of the totem (0,0,-12), the jumbotron
// (0,0,-30) and the Agent Exchange (8,0,-6)). yaw is the resting heading (0 = +z).
export const VEHICLE_SPAWNS = [
	// Avenue bays — keep in sync with world-zones.js type:'vehicle' points.
	{ id: 'veh-north-ave', type: 'coupe', x: 6, z: -90, yaw: 0 },
	{ id: 'veh-south-ave', type: 'sedan', x: -6, z: 90, yaw: Math.PI },
	{ id: 'veh-east-ave', type: 'pickup', x: 90, z: 6, yaw: -Math.PI / 2 },
	{ id: 'veh-west-ave', type: 'buggy', x: -90, z: -6, yaw: Math.PI / 2 },
	// Plaza-edge starters for discoverability.
	{ id: 'veh-plaza-1', type: 'sedan', x: -16, z: 14, yaw: Math.PI },
	{ id: 'veh-plaza-2', type: 'buggy', x: 18, z: 14, yaw: Math.PI },
];

// --- Anti-cheat limits (server-enforced) ----------------------------------

// World bounds must match WalkRoom's own square player clamp (WORLD_BOUND_M =
// world-zones.js WORLD_BOUND = DISTRICT.half - 2 = 198) so a car can't be
// driven past the visible arena — and, just as importantly, so the avenue
// vehicle spawns at x/z=±90 (VEHICLE_SPAWNS below) aren't clamped away by a
// stale, smaller radius the first time they sync.
export const VEHICLE_WORLD_BOUND_M = 198;

// How close a player must stand to a parked vehicle to take the wheel.
export const VEHICLE_ENTER_RANGE_M = 3.4;

// A driver streams the transform at the same 15Hz the move netcode uses, but
// packets jitter, so validate the per-update displacement against the type's top
// speed over a generous window (handles a dropped packet or two) before rejecting
// it as a teleport. Above 1.6× top speed is always rejected outright.
const VSYNC_WINDOW_S = 0.22;        // ~3 dropped 15Hz frames of headroom
const SPEED_CHEAT_FACTOR = 1.6;     // hard ceiling on reported/derived speed

export function vehicleMaxStepM(type) {
	return vehicleSpec(type).topSpeed * SPEED_CHEAT_FACTOR * VSYNC_WINDOW_S;
}

export function vehicleMaxSpeedMps(type) {
	return vehicleSpec(type).topSpeed * SPEED_CHEAT_FACTOR;
}
