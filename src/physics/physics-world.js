// PhysicsWorld — a thin, reusable wrapper over Rapier (3D, WASM-compat build).
//
// Why this exists: the 3D scenes historically faked collision with disc-radius
// clamps and AABB push-out. That stops you at a wall but can't roll a ball,
// push a crate, climb a step, or resolve a slide. This module gives every
// scene one real solver:
//
//   • a kinematic capsule character controller (slides along walls, steps up
//     small ledges, snaps to ground, and shoves dynamic bodies it walks into),
//   • static colliders for world geometry (ground, buildings, trees),
//   • dynamic rigid bodies for props (balls, crates) that fall, roll, and
//     get kicked, with their Three.js meshes synced from the simulation.
//
// Rapier ships its WASM inline in the `-compat` build, so there is no decoder
// file to host — we just await init() once and memoize it. The character
// body's translation is its FEET (the collider is offset upward by its own
// half-height), so callers can copy it straight onto an avatar rig whose
// origin sits on the floor.
//
// That inline WASM is why the import below is dynamic and NOT a static top-level
// one. The `-compat` build base64s a ~1.6 MB WASM binary into its JavaScript,
// which Rollup then folds into whatever chunk statically imports it: a static
// import here put 2.27 MB of parsed JS (774 KB over the wire) on the critical
// path of every page that draws a physics scene: /play and /walk both
// modulepreloaded it before the first frame, and the browser paid a multi-second
// parse for a module nothing needs until the world is already standing. Loading
// it from inside initRapier() gives it its own async chunk that downloads
// alongside world entry instead of ahead of it. Callers already tolerate the
// delay: PhysicsWorld.create() is awaited, and the scenes run their documented
// direct-mutation movement fallback until it resolves.

let _rapierReady = null;

/** Initialize the Rapier WASM runtime once and reuse it across worlds. */
export function initRapier() {
	if (!_rapierReady) {
		_rapierReady = import('@dimforge/rapier3d-compat').then(async (mod) => {
			const RAPIER = mod.default ?? mod;
			await RAPIER.init();
			return RAPIER;
		});
	}
	return _rapierReady;
}

const _v = { x: 0, y: 0, z: 0 };

export class PhysicsWorld {
	/**
	 * @param {object} rapier  initialized Rapier module (from initRapier)
	 * @param {{ gravity?: {x:number,y:number,z:number} }} [opts]
	 */
	constructor(rapier, { gravity = { x: 0, y: -14, z: 0 } } = {}) {
		this.RAPIER = rapier;
		this.world = new rapier.World(gravity);
		// Substep budget keeps the dynamic solver stable when a frame runs long
		// (tab refocus, GC pause) without letting bodies tunnel through walls.
		this._fixedDt = 1 / 60;
		this._accumulator = 0;
		this._ground = null; // { body } — persists across environment swaps
		this._obstacles = []; // [{ body }] — cleared/rebuilt per environment
		this._dynamics = []; // [{ body, mesh, spawn }] — props synced to meshes
		this._character = null;
		this._vehicles = []; // [vehicle façade] — raycast vehicles, pre-stepped each substep
	}

	/** Create a world with the WASM runtime guaranteed ready. */
	static async create(opts) {
		const rapier = await initRapier();
		return new PhysicsWorld(rapier, opts);
	}

	// ── Static world geometry ────────────────────────────────────────────────

	/**
	 * An effectively-infinite floor whose top face sits at `y`. Modeled as a
	 * thick cuboid (not a plane) so the character can never tunnel beneath it.
	 */
	addGround(y = 0, halfSize = 200) {
		const R = this.RAPIER;
		const thickness = 5;
		const body = this.world.createRigidBody(
			R.RigidBodyDesc.fixed().setTranslation(0, y - thickness, 0),
		);
		this.world.createCollider(
			R.ColliderDesc.cuboid(halfSize, thickness, halfSize).setFriction(1),
			body,
		);
		this._ground = { body };
		return body;
	}

	/**
	 * Static heightfield ground from a terrain.js instance. The terrain's height
	 * buffer is column-major — exactly Rapier's layout — so it maps on with no
	 * copy. The collider spans `terrain.size` square, centred on the origin,
	 * with its base at `y`. Replaces (and supersedes) any flat addGround floor so
	 * the character walks the real rolling surface instead of a flat plane.
	 */
	addHeightfield(terrain, { y = 0, friction = 1 } = {}) {
		const R = this.RAPIER;
		if (this._ground) {
			this.world.removeRigidBody(this._ground.body);
			this._ground = null;
		}
		// Rapier's nrows/ncols are SEGMENT counts; it requires
		// heights.length === (nrows+1)·(ncols+1). terrain.points = segments+1,
		// so pass points-1 and the points²-length column-major buffer fits exactly.
		const segs = terrain.points - 1;
		const scale = { x: terrain.size, y: 1, z: terrain.size };
		const body = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, y, 0));
		this.world.createCollider(
			R.ColliderDesc.heightfield(segs, segs, terrain.heights, scale).setFriction(friction),
			body,
		);
		this._ground = { body };
		return body;
	}

	/** Axis-aligned-ish box obstacle (optionally yaw-rotated). Center-anchored. */
	addStaticBox({ position, halfExtents, rotationY = 0 }) {
		const R = this.RAPIER;
		const desc = R.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z);
		if (rotationY) {
			const h = rotationY / 2;
			desc.setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) });
		}
		const body = this.world.createRigidBody(desc);
		this.world.createCollider(
			R.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z),
			body,
		);
		this._obstacles.push({ body });
		return body;
	}

	/** Upright cylinder obstacle — trees, posts, palm trunks. Center-anchored. */
	addStaticCylinder({ position, radius, halfHeight }) {
		const R = this.RAPIER;
		const body = this.world.createRigidBody(
			R.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z),
		);
		this.world.createCollider(R.ColliderDesc.cylinder(halfHeight, radius), body);
		this._obstacles.push({ body });
		return body;
	}

	/** Remove every per-environment obstacle (ground is preserved). */
	clearObstacles() {
		for (const o of this._obstacles) this.world.removeRigidBody(o.body);
		this._obstacles.length = 0;
	}

	// ── Dynamic props ────────────────────────────────────────────────────────

	/**
	 * A dynamic rigid body bound to a Three.js mesh. The mesh is driven by the
	 * simulation every frame in sync(); `spawn` is retained so a prop that
	 * tumbles off the world can be respawned.
	 */
	addDynamicBall({ mesh, radius, restitution = 0.6, density = 0.4, linearDamping = 0.4 }) {
		const R = this.RAPIER;
		const p = mesh.position;
		const body = this.world.createRigidBody(
			R.RigidBodyDesc.dynamic()
				.setTranslation(p.x, p.y, p.z)
				.setLinearDamping(linearDamping)
				.setAngularDamping(0.5),
		);
		this.world.createCollider(
			R.ColliderDesc.ball(radius)
				.setRestitution(restitution)
				.setDensity(density)
				.setFriction(0.6),
			body,
		);
		const entry = { body, mesh, spawn: { x: p.x, y: p.y, z: p.z } };
		this._dynamics.push(entry);
		return entry;
	}

	addDynamicBox({ mesh, halfExtents, restitution = 0.1, density = 0.6, linearDamping = 0.3 }) {
		const R = this.RAPIER;
		const p = mesh.position;
		const body = this.world.createRigidBody(
			R.RigidBodyDesc.dynamic()
				.setTranslation(p.x, p.y, p.z)
				.setLinearDamping(linearDamping)
				.setAngularDamping(0.6),
		);
		this.world.createCollider(
			R.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
				.setRestitution(restitution)
				.setDensity(density)
				.setFriction(0.8),
			body,
		);
		const entry = { body, mesh, spawn: { x: p.x, y: p.y, z: p.z } };
		this._dynamics.push(entry);
		return entry;
	}

	/** Remove every dynamic prop body (their meshes are owned by the caller). */
	clearDynamics() {
		for (const d of this._dynamics) this.world.removeRigidBody(d.body);
		this._dynamics.length = 0;
	}

	// ── Character controller ─────────────────────────────────────────────────

	/**
	 * A kinematic capsule whose body translation tracks the FEET position.
	 * Returns a controller façade with move()/setPosition().
	 */
	createCharacter({
		position = { x: 0, y: 0, z: 0 },
		radius = 0.3,
		halfHeight = 0.55,
		offset = 0.04,
	} = {}) {
		const R = this.RAPIER;
		const body = this.world.createRigidBody(
			R.RigidBodyDesc.kinematicPositionBased().setTranslation(
				position.x,
				position.y,
				position.z,
			),
		);
		// Lift the capsule so the body origin is the feet, not the capsule center.
		const collider = this.world.createCollider(
			R.ColliderDesc.capsule(halfHeight, radius).setTranslation(0, radius + halfHeight, 0),
			body,
		);

		const controller = this.world.createCharacterController(offset);
		controller.enableAutostep(0.4, 0.2, true); // step up curbs / ledges
		controller.enableSnapToGround(0.3); // hug terrain on the way down
		controller.setApplyImpulsesToDynamicBodies(true); // kick balls & crates
		controller.setSlideEnabled(true); // slide along walls instead of stopping dead
		controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
		controller.setMinSlopeSlideAngle((35 * Math.PI) / 180);

		this._character = {
			body,
			collider,
			controller,
			/**
			 * Resolve one frame of desired motion against the world.
			 * @param {{x:number,y:number,z:number}} desired  world-space displacement this frame
			 * @returns {{ position:{x:number,y:number,z:number}, grounded:boolean }}
			 */
			move: (desired) => {
				controller.computeColliderMovement(collider, desired);
				const m = controller.computedMovement();
				const t = body.translation();
				_v.x = t.x + m.x;
				_v.y = t.y + m.y;
				_v.z = t.z + m.z;
				body.setNextKinematicTranslation(_v);
				return {
					position: { x: _v.x, y: _v.y, z: _v.z },
					grounded: controller.computedGrounded(),
				};
			},
			/** Hard-teleport (respawn, boundary snap) — bypasses collision. */
			setPosition: (p) => {
				body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
				body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
			},
		};
		return this._character;
	}

	get character() {
		return this._character;
	}

	// ── Raycast vehicle ──────────────────────────────────────────────────────

	/**
	 * A Rapier raycast vehicle (Rapier's built-in DynamicRayCastVehicleController):
	 * a dynamic cuboid chassis with four ray-cast wheels providing suspension,
	 * steering, engine force and braking. We don't hand-roll suspension — the
	 * controller does it. The returned façade is fed driver intent via setInput()
	 * and is integrated automatically inside step() (call setInput before step).
	 *
	 * @param {{position:{x,y,z}, yaw?:number, spec:object}} opts  spec = a
	 *        VEHICLE_TYPES entry (mass, topSpeed, engineForce, dims, wheel, …).
	 */
	createVehicle({ position = { x: 0, y: 1, z: 0 }, yaw = 0, spec }) {
		const R = this.RAPIER;
		const { l, w, h } = spec.dims;
		const hx = w / 2, hy = h / 2, hz = l / 2;

		const half = yaw / 2;
		const rot = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
		const body = this.world.createRigidBody(
			R.RigidBodyDesc.dynamic()
				.setTranslation(position.x, position.y, position.z)
				.setRotation(rot)
				.setLinearDamping(0.12)
				.setAngularDamping(0.55)
				.setCanSleep(false),
		);
		// Mass via density so the cuboid weighs the type's target mass. A lowered
		// centre of mass keeps the car from flipping in hard turns.
		const density = spec.mass / Math.max(0.001, l * w * h);
		const collider = this.world.createCollider(
			R.ColliderDesc.cuboid(hx, hy, hz)
				.setDensity(density)
				.setFriction(0.7)
				.setRestitution(0.05)
				.setTranslation(0, -hy * 0.3, 0),
			body,
		);

		const controller = this.world.createVehicleController(body);
		controller.indexUpAxis = 1;        // +y is up
		controller.setIndexForwardAxis = 2; // +z is forward (matches the mesh)

		const dir = { x: 0, y: -1, z: 0 };  // suspension casts straight down
		const axle = { x: -1, y: 0, z: 0 }; // wheels spin about the x axle
		const wb = w / 2 - spec.wheel.inset; // half track width
		// Connection points sit in the lower body; rays start here and reach the
		// ground through the suspension rest length + wheel radius.
		const cy = -hy * 0.2;
		const conns = [
			{ x: wb, y: cy, z: spec.wheel.frontZ },  // 0 front-left  (steered)
			{ x: -wb, y: cy, z: spec.wheel.frontZ }, // 1 front-right (steered)
			{ x: wb, y: cy, z: spec.wheel.rearZ },   // 2 rear-left
			{ x: -wb, y: cy, z: spec.wheel.rearZ },  // 3 rear-right
		];
		for (const c of conns) {
			controller.addWheel(c, dir, axle, spec.suspension.rest, spec.wheel.radius);
		}
		for (let i = 0; i < 4; i++) {
			controller.setWheelSuspensionStiffness(i, spec.suspension.stiffness);
			controller.setWheelMaxSuspensionTravel(i, spec.suspension.travel);
			controller.setWheelSuspensionCompression(i, spec.suspension.compression);
			controller.setWheelSuspensionRelaxation(i, spec.suspension.relax);
			controller.setWheelFrictionSlip(i, spec.grip);
			controller.setWheelSideFrictionStiffness(i, 1.0);
		}

		// Exclude the chassis from its own wheel ray-casts so a wheel never reports
		// the car's own underside as the ground.
		const chassisHandle = collider.handle;
		const wheelFilter = (col) => col.handle !== chassisHandle;

		const vehicle = {
			body,
			controller,
			spec,
			steer: 0,
			_throttle: 0,
			_brake: 0,
			_steerTarget: 0,
			_handbrake: false,
			/** Feed one frame of driver intent. throttle/brake in [0,1], steer in [-1,1]. */
			setInput({ throttle = 0, brake = 0, steer = 0, handbrake = false } = {}) {
				this._throttle = Math.max(0, Math.min(1, throttle));
				this._brake = Math.max(0, Math.min(1, brake));
				this._steerTarget = Math.max(-1, Math.min(1, steer));
				this._handbrake = !!handbrake;
			},
			/** Integrate the controller one substep — called from PhysicsWorld.step. */
			_preStep(dt) {
				// Ease the steering angle toward the target so turns aren't instant.
				const target = this._steerTarget * spec.steerMax;
				const rate = spec.steerSpeed * dt;
				this.steer += Math.max(-rate, Math.min(rate, target - this.steer));
				controller.setWheelSteering(0, this.steer);
				controller.setWheelSteering(1, this.steer);

				const speed = controller.currentVehicleSpeed();
				let force = 0;
				let brakeImpulse = 0;
				if (this._throttle > 0) {
					// Cut the throttle at top speed so the car can't accelerate forever.
					force = speed < spec.topSpeed ? spec.engineForce * this._throttle : 0;
				}
				if (this._brake > 0) {
					if (speed > 0.6) {
						brakeImpulse = spec.brakeForce * this._brake; // slowing down
					} else {
						force = -spec.reverseForce * this._brake;      // reversing from a stop
					}
				}
				if (this._handbrake) brakeImpulse = Math.max(brakeImpulse, spec.brakeForce * 2.2);
				// Light engine braking when coasting so the car rolls to rest.
				if (this._throttle === 0 && this._brake === 0 && !this._handbrake) {
					brakeImpulse = spec.brakeForce * 0.12;
				}
				const perWheelForce = force / 4; // all-wheel drive for arcade stability
				for (let i = 0; i < 4; i++) {
					controller.setWheelEngineForce(i, perWheelForce);
					controller.setWheelBrake(i, brakeImpulse);
				}
				controller.updateVehicle(dt, undefined, undefined, wheelFilter);
			},
			/** Current world transform + forward speed, for rendering + netcode. */
			transform() {
				const t = body.translation();
				const r = body.rotation();
				return { x: t.x, y: t.y, z: t.z, qx: r.x, qy: r.y, qz: r.z, qw: r.w, speed: controller.currentVehicleSpeed() };
			},
			/** Hard-place the chassis (initial seat, flip recovery) and kill momentum. */
			teleport(p, q) {
				body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
				if (q) body.setRotation({ x: q.qx, y: q.qy, z: q.qz, w: q.qw }, true);
				body.setLinvel({ x: 0, y: 0, z: 0 }, true);
				body.setAngvel({ x: 0, y: 0, z: 0 }, true);
				this.steer = 0;
			},
			/** True when the car has rolled past ~110° — the driver can request a reset. */
			flipped() {
				const r = body.rotation();
				// World up (0,1,0) rotated by the body; its y component is the chassis'
				// up·worldUp. Below ~-0.35 means it's substantially upside-down.
				const uy = 1 - 2 * (r.x * r.x + r.z * r.z);
				return uy < -0.35;
			},
		};
		this._vehicles.push(vehicle);
		return vehicle;
	}

	/**
	 * A kinematic cuboid the caller repositions each frame — used to give the
	 * locally-simulated vehicle something solid to bump for OTHER players' cars,
	 * which are otherwise pure interpolated ghosts not in this physics world.
	 */
	addKinematicBox({ halfExtents, position = { x: 0, y: 0, z: 0 } }) {
		const R = this.RAPIER;
		const body = this.world.createRigidBody(
			R.RigidBodyDesc.kinematicPositionBased().setTranslation(position.x, position.y, position.z),
		);
		this.world.createCollider(R.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z), body);
		return {
			body,
			setTransform(p, q) {
				body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
				if (q) body.setNextKinematicRotation({ x: q.qx, y: q.qy, z: q.qz, w: q.qw });
			},
			remove: () => { try { this.world.removeRigidBody(body); } catch { /* gone */ } },
		};
	}

	/** Remove a vehicle created with createVehicle(). */
	removeVehicle(vehicle) {
		const i = this._vehicles.indexOf(vehicle);
		if (i >= 0) this._vehicles.splice(i, 1);
		try { this.world.removeVehicleController(vehicle.controller); } catch { /* already gone */ }
		try { this.world.removeRigidBody(vehicle.body); } catch { /* already gone */ }
	}

	// ── Per-frame integration ────────────────────────────────────────────────

	/**
	 * Advance the simulation. The character's setNextKinematicTranslation (from
	 * move()) is consumed here, so call move() BEFORE step(). Uses a fixed
	 * timestep accumulator so dynamic bodies stay stable across variable frames.
	 */
	step(dt) {
		this._accumulator += Math.min(dt, 0.1);
		let steps = 0;
		this.world.timestep = this._fixedDt;
		while (this._accumulator >= this._fixedDt && steps < 5) {
			// Vehicles must integrate their suspension/engine BEFORE the world solves,
			// each substep, or their chassis velocity lags the simulation.
			for (const v of this._vehicles) v._preStep(this._fixedDt);
			this.world.step();
			this._accumulator -= this._fixedDt;
			steps++;
		}
		this._syncDynamics();
	}

	_syncDynamics() {
		for (const d of this._dynamics) {
			const t = d.body.translation();
			const r = d.body.rotation();
			d.mesh.position.set(t.x, t.y, t.z);
			d.mesh.quaternion.set(r.x, r.y, r.z, r.w);
			// A prop that tumbles into the void gets relaunched from its spawn.
			if (t.y < -8) {
				d.body.setTranslation({ ...d.spawn }, true);
				d.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
				d.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
			}
		}
	}

	dispose() {
		this.world.free();
		this._ground = null;
		this._obstacles.length = 0;
		this._dynamics.length = 0;
		this._vehicles.length = 0;
		this._character = null;
	}
}
