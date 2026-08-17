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
// m/s, angles in radians.
//
// The Trench Car is the world's ONLY car (owner directive 2026-08-17): every
// parked vehicle a player can take the wheel of and every car ambient traffic
// drives is this one model, so the fleet reads as one coherent world instead of
// a mix of boxy procedural silhouettes (a coupe/sedan/pickup/buggy table used to
// live here, and the amber buggy in particular looked nothing like the rest of
// the town). Handling variety, if it ever comes back, comes back as real models.
//
// `model` names a real GLB (src/game/vehicle-model.js) rather than a procedural
// silhouette. Its dims, wheel geometry and seat are measured off that mesh, so
// the physics chassis, the wheels the player watches turn, and the driver in the
// seat all agree.
export const VEHICLE_TYPES = {
	trench: {
		id: 'trench',
		label: 'Trench Car',
		// The community model staged at public/vehicles/trench-car.glb by
		// scripts/build-trench-car.mjs. The client resolves this to a URL; the
		// server only ever passes the string through.
		model: 'trench-car',
		mass: 1400,
		topSpeed: 26,        // ~94 km/h
		engineForce: 5000,
		brakeForce: 125,
		reverseForce: 2500,
		steerMax: 0.5,
		steerSpeed: 2.9,
		grip: 2.4,
		// Measured off the GLB (tests/vehicles-trench-car.test.js re-measures it):
		// 1.85 m wide, 4.31 m long, roof 1.31 m above the road, wheel centres at
		// z +1.21 / -1.29, x ±0.70, radius 0.30. Height is road-to-roof, so the
		// collider wraps the whole visible car.
		dims: { l: 4.31, w: 1.85, h: 1.31 },
		wheel: { radius: 0.3, halfWidth: 0.11, inset: 0.22, frontZ: 1.21, rearZ: -1.29 },
		// rest=0.58 satisfies the clearance rule the retired procedural types
		// learned the hard way: the chassis collider's underside sits
		// 1.3 * (h/2) below the body origin, so the resting chassis centre
		// (vehicleRestHeight = 1.011) has to clear it. Too little lift and the hull
		// rests on the road, where its own friction pins the car no matter how much
		// engine force is applied (verified against real Rapier in
		// scripts/verify-w02-physics-core.mjs). 0.58 leaves 0.16 m of air under the
		// collider, so the wheels carry the car instead of the hull grinding along.
		// tests/vehicles-trench-car.test.js holds that margin.
		suspension: { rest: 0.58, stiffness: 25, travel: 0.18, compression: 0.84, relax: 0.9 },
		// Driver's seat, as the offset from the chassis CENTRE to where the driver's
		// rig origin (their feet) belongs: the model's footwell floor, 0.30 m above
		// the road, which is below the chassis centre, hence the negative y. Both
		// the client (VehicleManager._seatAvatar) and the server (WalkRoom's rider
		// height) read this, so a driver sits in the same place for everyone.
		seat: { x: -0.42, y: -0.71, z: -0.15 },
		color: 0x1b1d22,
	},
};

export const VEHICLE_TYPE_IDS = Object.keys(VEHICLE_TYPES);

export function isVehicleType(t) {
	return typeof t === 'string' && Object.prototype.hasOwnProperty.call(VEHICLE_TYPES, t);
}

// The world's default car: what an unknown/blank type resolves to, what ambient
// traffic drives, and what a player finds parked at the spawn plaza.
export const DEFAULT_VEHICLE_TYPE = 'trench';

export function vehicleSpec(type) {
	return VEHICLE_TYPES[type] || VEHICLE_TYPES[DEFAULT_VEHICLE_TYPE];
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
// Every bay parks the Trench Car: the car a player walks up to anywhere in the
// world is the same one ambient traffic is driving past them.
export const VEHICLE_SPAWNS = [
	// Avenue bays — keep in sync with world-zones.js type:'vehicle' points.
	{ id: 'veh-north-ave', type: 'trench', x: 6, z: -90, yaw: 0 },
	{ id: 'veh-south-ave', type: 'trench', x: -6, z: 90, yaw: Math.PI },
	{ id: 'veh-east-ave', type: 'trench', x: 90, z: 6, yaw: -Math.PI / 2 },
	{ id: 'veh-west-ave', type: 'trench', x: -90, z: -6, yaw: Math.PI / 2 },
	// Plaza-edge starters for discoverability.
	{ id: 'veh-plaza-1', type: 'trench', x: -16, z: 14, yaw: Math.PI },
	{ id: 'veh-plaza-2', type: 'trench', x: 18, z: 14, yaw: Math.PI },
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
