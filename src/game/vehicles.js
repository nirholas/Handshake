// VehicleManager, drivable, networked vehicles for /play.
//
// Networking follows the same authoritative-relay pattern the movement netcode
// already uses (and the model Notblox uses for its Rapier cars): the DRIVER
// simulates the vehicle locally with Rapier's built-in raycast vehicle controller
// and streams the resulting transform; the server validates per-type speed/bounds
// and relays it, staying the gate on who may drive what. Everyone else is a pure
// spectator of the replicated transform, interpolated smoothly.
//
// Only the vehicle the local player is driving is ever simulated here, it shares
// the SAME Rapier world CoinCommunities already boots for the character
// controller (W01's `this._physics`: ground + district building colliders), so a
// driven car collides with the town exactly like a walking avatar does, and
// (as kinematic ghosts) the other players' cars so the local car can bump them.
// The world is stepped exactly once per frame, centrally, in CoinCommunities'
// _loop, this module never calls physics.step() itself; tick() feeds driver
// input BEFORE that step, postStep() reads the resulting transform AFTER it.
// Parked and remote-driven vehicles are interpolated meshes, cheap and
// ghost-light.
//
// This subsystem is intentionally tightly coupled to the scene (camera handoff,
// avatar seating, shared input, the shared physics world), so it takes the
// CoinCommunities `host` and reads its live fields (localPos, localYaw, localRig,
// keys, camera, _physics), exactly the coupling PlaySystems and AgentCommerce
// already have.

import { Vector3, Quaternion, Raycaster, Vector2 } from 'three';
import { buildVehicleMesh } from './vehicle-mesh.js';
import { CLIP_IDLE } from './avatar-rig.js';
import {
	vehicleSpec, vehicleRestHeight,
	VEHICLE_ENTER_RANGE_M, VEHICLE_WORLD_BOUND_M,
} from '../../multiplayer/src/vehicles.js';
import { log } from '../shared/log.js';

const REMOTE_LERP = 0.2;        // per-frame position/rotation interpolation
const ENTER_TIMEOUT_MS = 2600;  // give up waiting for an enter grant
const KNOCK_SPEED = 4.5;        // m/s a car must exceed to shove a pedestrian
const FLIP_RESET_MS = 2200;     // auto-right a car left upside-down this long

const _q = new Quaternion();
const _v = new Vector3();
const _v2 = new Vector3();

function yawFromQuat(qx, qy, qz, qw) {
	return Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qx * qx));
}
function shortestAngle(a, b) {
	let d = b - a;
	while (d > Math.PI) d -= Math.PI * 2;
	while (d < -Math.PI) d += Math.PI * 2;
	return d;
}

export class VehicleManager {
	constructor({ host }) {
		this.host = host;
		this.scene = host.scene;
		this.camera = host.camera;
		this.renderer = host.renderer;
		this.net = host.net;
		this.ui = host.ui;

		this.vehicles = new Map(); // id → { id, state, spec, mesh, collider, wheelRoll }
		this._drivingId = null;
		this._pendingEnter = null;
		this._pendingTimer = null;
		this.vehicle = null;        // the Rapier vehicle façade while driving
		this._touch = { throttle: 0, brake: 0, steer: 0, handbrake: false };
		this._kbHandbrake = false;
		this._flipSince = 0;
		this._prevCamDist = host.camDist;

		// Reuse CoinCommunities' own Rapier world (ground + district colliders +
		// character controller) instead of standing up a second one, the driven
		// car then collides with the same town the avatar does. host.enter() only
		// constructs VehicleManager after its physics boot has already resolved, so
		// this is synchronous; a WASM failure (no WebGL/WASM) leaves `phys` null,
		// which disables driving gracefully (toast on interact) without breaking
		// the rest of the scene.
		this.phys = host._physicsOk ? host._physics : null;
		if (!this.phys) log.warn('[vehicles] no shared physics world, driving disabled this session.');

		this._injectStyles();
		this._buildPrompt();
		this._buildControls();

		this._raycaster = new Raycaster();
		this._ndc = new Vector2();
	}

	// ---------------------------------------------------------------- net state

	addVehicle(state, id) {
		if (this.vehicles.has(id)) { this.changeVehicle(state, id); return; }
		const spec = vehicleSpec(state.type);
		const mesh = buildVehicleMesh(spec, state.color >>> 0);
		mesh.group.position.set(state.x, state.y, state.z);
		mesh.group.quaternion.set(state.qx, state.qy, state.qz, state.qw);
		this.scene.add(mesh.group);
		this.vehicles.set(id, { id, state, spec, mesh, collider: null, wheelRoll: 0 });
	}

	changeVehicle(state, id) {
		const entry = this.vehicles.get(id);
		if (!entry) { this.addVehicle(state, id); return; }
		entry.state = state; // live schema proxy, read latest each frame
		// The server kicked us out of the seat (disconnect sweep, eviction): bail out
		// of the driving state cleanly so we don't keep streaming a car we don't own.
		if (entry.id === this._drivingId && state.driver !== this.net?.sessionId) {
			this._endDriving(this.vehicle ? this.vehicle.transform() : null, /* serverForced */ true);
		}
	}

	removeVehicle(id) {
		const entry = this.vehicles.get(id);
		if (!entry) return;
		if (entry.id === this._drivingId) this._endDriving(null, true);
		entry.collider?.remove();
		this.scene.remove(entry.mesh.group);
		entry.mesh.dispose();
		this.vehicles.delete(id);
	}

	// Server's targeted reply to our enter/exit request.
	onAck(msg) {
		if (!msg || typeof msg !== 'object') return;
		if (msg.event === 'enter') {
			if (this._pendingEnter && msg.id === this._pendingEnter) this._beginDriving(msg.id);
		} else if (msg.event === 'deny') {
			this._clearPending();
			const why = msg.reason === 'occupied' ? 'Someone’s already driving that.'
				: msg.reason === 'range' ? 'Get closer to the vehicle.'
					: 'That vehicle’s gone.';
			this.ui?.toast?.(why, 'warn');
		} else if (msg.event === 'exit') {
			// We already exited optimistically; reconcile the avatar to the server's
			// authored drop point so on-foot movement resumes from the agreed spot.
			if (typeof msg.x === 'number' && typeof msg.z === 'number') {
				this.host.localPos.x = msg.x;
				this.host.localPos.z = msg.z;
			}
		}
	}

	// ---------------------------------------------------------------- frame tick

	isDriving() { return !!this._drivingId; }

	// Called BEFORE CoinCommunities steps the shared physics world this frame:
	// interpolates every vehicle we're not actively simulating (and re-queues
	// their kinematic ghost transforms, which, like the character controller's
	// queued move, must be set before world.step() consumes them), and, while
	// driving, feeds this frame's input into the Rapier vehicle controller so its
	// forces are ready for that same step. Reading the result back happens in
	// postStep(), after the world has actually advanced.
	tick(dt) {
		for (const [, entry] of this.vehicles) {
			if (entry.id === this._drivingId) continue;
			this._interpolate(entry, dt);
		}

		if (this._drivingId) {
			this._driveInput(dt);
		} else {
			this._updatePrompt();
			this._pedestrianKnock(dt);
		}
	}

	// Called AFTER CoinCommunities steps the shared physics world this frame.
	// No-op unless actively driving.
	postStep(dt) {
		if (this._drivingId) this._driveApply(dt);
	}

	_interpolate(entry, dt) {
		const s = entry.state;
		const g = entry.mesh.group;
		_v.set(s.x, s.y, s.z);
		g.position.lerp(_v, REMOTE_LERP);
		_q.set(s.qx, s.qy, s.qz, s.qw);
		g.quaternion.slerp(_q, REMOTE_LERP);

		// Spin the wheels from the replicated speed so a moving car doesn't glide on
		// frozen tyres; steer is left centred (we don't replicate wheel angle).
		entry.wheelRoll += (s.speed / entry.spec.wheel.radius) * dt;
		for (const w of entry.mesh.wheels) w.spinner.rotation.x = entry.wheelRoll;

		// Maintain a kinematic ghost so the locally-driven car can bump this one.
		if (this.phys) {
			if (!entry.collider) {
				const { l, w, h } = entry.spec.dims;
				entry.collider = this.phys.addKinematicBox({
					halfExtents: { x: w / 2, y: h / 2, z: l / 2 },
					position: { x: g.position.x, y: g.position.y, z: g.position.z },
				});
			}
			entry.collider.setTransform(g.position, { qx: s.qx, qy: s.qy, qz: s.qz, qw: s.qw });
		}
	}

	// Push the on-foot local player out of the path of any fast-moving car so a
	// vehicle can't drive straight through them. Server-safe: the nudge is small
	// per frame, well under the move-step clamp, so ordinary sendMove relays it.
	_pedestrianKnock(dt) {
		const p = this.host.localPos;
		for (const [, entry] of this.vehicles) {
			const s = entry.state;
			if (!s.driver || Math.abs(s.speed) < KNOCK_SPEED) continue;
			const reach = entry.spec.dims.l / 2 + 0.7;
			const dx = p.x - s.x, dz = p.z - s.z;
			const d = Math.hypot(dx, dz);
			if (d > reach || d < 1e-3) continue;
			const push = (1 - d / reach) * Math.min(Math.abs(s.speed), 14) * dt;
			p.x += (dx / d) * push;
			p.z += (dz / d) * push;
		}
	}

	// ---------------------------------------------------------------- driving sim

	// Pre-step: feed this frame's driver intent to the Rapier vehicle controller.
	// Nothing here reads back a transform, the shared world hasn't advanced yet.
	_driveInput(dt) {
		if (!this.vehicle || !this.phys) return;
		const keys = this.host.keys;
		let throttle = (keys.has('w') || keys.has('arrowup')) ? 1 : 0;
		let brake = (keys.has('s') || keys.has('arrowdown')) ? 1 : 0;
		let steer = 0;
		if (keys.has('a') || keys.has('arrowleft')) steer -= 1;
		if (keys.has('d') || keys.has('arrowright')) steer += 1;
		throttle = Math.max(throttle, this._touch.throttle);
		brake = Math.max(brake, this._touch.brake);
		steer = Math.max(-1, Math.min(1, steer + this._touch.steer));
		const handbrake = this._kbHandbrake || this._touch.handbrake;
		this.vehicle.setInput({ throttle, brake, steer, handbrake });
		this._lastBraking = brake > 0 || handbrake; // read back in _driveApply
	}

	// Post-step: the shared world just advanced (CoinCommunities._loop calls this
	// right after physics.step()), read the now-authoritative transform and apply
	// everything downstream of it: mesh, camera, seat, HUD, netcode.
	_driveApply(dt) {
		const entry = this.vehicles.get(this._drivingId);
		if (!entry || !this.vehicle || !this.phys) return;
		const braking = this._lastBraking;
		let t = this.vehicle.transform();

		// World bounds, clamp the car inside the square district (the server clamps
		// per-axis too). Only correct when actually past an edge, to avoid jitter.
		if (Math.abs(t.x) > VEHICLE_WORLD_BOUND_M || Math.abs(t.z) > VEHICLE_WORLD_BOUND_M) {
			const cx = Math.max(-VEHICLE_WORLD_BOUND_M, Math.min(VEHICLE_WORLD_BOUND_M, t.x));
			const cz = Math.max(-VEHICLE_WORLD_BOUND_M, Math.min(VEHICLE_WORLD_BOUND_M, t.z));
			this.vehicle.teleport({ x: cx, y: t.y, z: cz }, t);
			t = this.vehicle.transform();
		}

		// Auto-right a car that's been flipped on its roof for a while.
		if (this.vehicle.flipped()) {
			if (!this._flipSince) this._flipSince = performance.now();
			else if (performance.now() - this._flipSince > FLIP_RESET_MS) this._rightVehicle(t);
		} else {
			this._flipSince = 0;
		}

		// Drive the mesh + wheels from the simulation.
		const g = entry.mesh.group;
		g.position.set(t.x, t.y, t.z);
		g.quaternion.set(t.qx, t.qy, t.qz, t.qw);
		this._updateDrivenWheels(entry);
		// Brake-light glow when slowing or reversing.
		for (const bl of entry.mesh.brakeLights) bl.material.color.setHex(braking ? 0xff3b30 : 0x6e1411);

		// Seat the avatar, hand the camera to a chase view, and carry the player's
		// networked position with the car (so peers see them at the wheel and exiting
		// is continuous). localPos drives the existing follow camera + nameplates.
		const yaw = yawFromQuat(t.qx, t.qy, t.qz, t.qw);
		this.host.localPos.set(t.x, t.y, t.z);
		this.host.localYaw = yaw;
		this.host.motion = 'idle';
		this._seatAvatar(entry, t, yaw);
		this.host.camYaw += shortestAngle(this.host.camYaw, yaw) * Math.min(1, dt * 6);

		this._updateSpeedo(t.speed);

		// Stream the authoritative transform (throttled to the send rate in the net).
		this.net?.sendVSync({
			id: this._drivingId,
			x: t.x, y: t.y, z: t.z,
			qx: t.qx, qy: t.qy, qz: t.qz, qw: t.qw,
			speed: t.speed,
		});
	}

	_seatAvatar(entry, t, yaw) {
		const rig = this.host.localRig;
		if (!rig) return;
		const seat = entry.spec.seat;
		_v2.set(seat.x, seat.y, seat.z).applyQuaternion(_q.set(t.qx, t.qy, t.qz, t.qw));
		rig.position.set(t.x + _v2.x, t.y + _v2.y - entry.spec.dims.h * 0.2, t.z + _v2.z);
		rig.rotation.set(0, yaw, 0);
		if (this.host.localAnim?.currentName !== CLIP_IDLE) this.host.localAnim?.crossfadeTo(CLIP_IDLE, 0.2);
	}

	_updateDrivenWheels(entry) {
		const ctrl = this.vehicle.controller;
		const rest = entry.spec.suspension.rest;
		for (let i = 0; i < entry.mesh.wheels.length; i++) {
			const w = entry.mesh.wheels[i];
			const conn = ctrl.wheelChassisConnectionPointCs(i);
			const susp = ctrl.wheelSuspensionLength(i);
			const steerAng = ctrl.wheelSteering(i) || 0;
			const roll = ctrl.wheelRotation(i) || 0;
			if (conn) w.pivot.position.set(conn.x, conn.y - (typeof susp === 'number' ? susp : rest), conn.z);
			w.pivot.rotation.y = steerAng;
			w.spinner.rotation.x = roll;
		}
	}

	_rightVehicle(t) {
		const yaw = yawFromQuat(t.qx, t.qy, t.qz, t.qw);
		const half = yaw / 2;
		this.vehicle.teleport(
			{ x: t.x, y: t.y + 1.0, z: t.z },
			{ qx: 0, qy: Math.sin(half), qz: 0, qw: Math.cos(half) },
		);
		this._flipSince = 0;
		this.ui?.toast?.('Vehicle flipped, set you back upright.', 'info');
	}

	// ---------------------------------------------------------------- enter/exit

	// Contextual interact: leave the car if driving, otherwise take the nearest one.
	interact() {
		if (this._drivingId) { this.requestExit(); return true; }
		return this._enterNearest();
	}

	// Touch: tapping a parked vehicle takes the wheel (the touch-native equivalent
	// of the F prompt). Returns true if a vehicle was tapped + entered.
	tryActivateAt(raycaster) {
		if (this._drivingId || this._pendingEnter) return false;
		const near = this._nearestParked();
		if (!near) return false;
		const hit = raycaster.intersectObject(near.entry.mesh.group, true);
		if (hit.length) { this._requestEnter(near.entry.id); return true; }
		return false;
	}

	_enterNearest() {
		if (this._drivingId || this._pendingEnter) return false;
		const near = this._nearestParked();
		if (!near) return false;
		this._requestEnter(near.entry.id);
		return true;
	}

	_nearestParked() {
		const p = this.host.localPos;
		let best = null;
		for (const [, entry] of this.vehicles) {
			if (entry.state.driver) continue; // occupied
			const g = entry.mesh.group;
			const d = Math.hypot(p.x - g.position.x, p.z - g.position.z);
			if (d <= VEHICLE_ENTER_RANGE_M && (!best || d < best.d)) best = { entry, d };
		}
		return best;
	}

	_requestEnter(id) {
		this._pendingEnter = id;
		this.net?.sendVEnter(id);
		clearTimeout(this._pendingTimer);
		// If the grant never arrives, tell the player instead of failing silently;
		// clearing the pending flag lets _updatePrompt re-show the F prompt next tick.
		this._pendingTimer = setTimeout(() => {
			this._clearPending();
			this.ui?.toast?.('Could not reach that vehicle. Try again.', 'warn');
		}, ENTER_TIMEOUT_MS);
		this.prompt.classList.remove('veh-show');
	}

	_clearPending() {
		this._pendingEnter = null;
		clearTimeout(this._pendingTimer);
	}

	// The server granted us a seat we cannot actually take (physics missing, the
	// vehicle vanished locally, a newer state seated someone else). Hand the seat
	// straight back so the car isn't left occupied for the whole room; the server
	// no-ops the exit if we never actually held the seat.
	_releaseSeat(id, s) {
		this.net?.sendVExit(s
			? { id, x: s.x, y: s.y, z: s.z, qx: s.qx, qy: s.qy, qz: s.qz, qw: s.qw, speed: 0 }
			: { id, speed: 0 });
	}

	_beginDriving(id) {
		this._clearPending();
		const entry = this.vehicles.get(id);
		if (!entry) { this._releaseSeat(id, null); return; }
		if (!this.phys) {
			this._releaseSeat(id, entry.state);
			this.ui?.toast?.('Vehicles need real-time physics, which failed to load this session.', 'warn');
			return;
		}
		// Another change may have arrived; re-confirm the server seated us.
		if (entry.state.driver && entry.state.driver !== this.net?.sessionId) {
			this._releaseSeat(id, entry.state);
			return;
		}

		const s = entry.state;
		const yaw = yawFromQuat(s.qx, s.qy, s.qz, s.qw);
		this.vehicle = this.phys.createVehicle({
			position: { x: s.x, y: vehicleRestHeight(s.type) + 0.1, z: s.z },
			yaw,
			spec: entry.spec,
		});
		this.vehicle.teleport({ x: s.x, y: s.y + 0.1, z: s.z }, { qx: s.qx, qy: s.qy, qz: s.qz, qw: s.qw });
		// The driven car is the dynamic body now, drop its kinematic ghost so the two
		// don't fight.
		entry.collider?.remove();
		entry.collider = null;
		this._drivingId = id;
		this._flipSince = 0;

		this._prevCamDist = this.host.camDist;
		this.host.camDist = Math.max(this.host.camDist, 11);
		this._showControls(true);
		this.ui?.toast?.(`Driving the ${entry.spec.label}, ${this._isTouch() ? 'use the on-screen pedals' : 'WASD to drive, Space to handbrake'}, ${this._isTouch() ? 'tap Exit' : 'F'} to get out.`, 'info');
	}

	requestExit() {
		if (!this._drivingId || !this.vehicle) return;
		const t = this.vehicle.transform();
		this.net?.sendVExit({
			id: this._drivingId,
			x: t.x, y: t.y, z: t.z,
			qx: t.qx, qy: t.qy, qz: t.qz, qw: t.qw,
			speed: 0,
		});
		this._endDriving(t, false);
	}

	_endDriving(t, serverForced) {
		const id = this._drivingId;
		this._drivingId = null;
		this._flipSince = 0;
		if (this.vehicle) { this.phys?.removeVehicle(this.vehicle); this.vehicle = null; }
		this._showControls(false);
		this.host.camDist = this._prevCamDist;

		// Drop the avatar beside the driver's door (mirrors the server's drop math) so
		// our optimistic position matches the authoritative one within the move clamp.
		if (t) {
			const yaw = yawFromQuat(t.qx, t.qy, t.qz, t.qw);
			const entry = id ? this.vehicles.get(id) : null;
			const off = (entry ? entry.spec.dims.w / 2 : 1) + 0.6;
			const dx = Math.max(-VEHICLE_WORLD_BOUND_M, Math.min(VEHICLE_WORLD_BOUND_M, t.x + Math.cos(yaw) * off));
			const dz = Math.max(-VEHICLE_WORLD_BOUND_M, Math.min(VEHICLE_WORLD_BOUND_M, t.z - Math.sin(yaw) * off));
			this.host.localPos.set(dx, 0, dz);
			this.host.localYaw = yaw;
		} else {
			this.host.localPos.y = 0;
		}
		this.host.motion = 'idle';
		if (this.host.localRig) {
			this.host.localRig.position.copy(this.host.localPos);
			this.host.localRig.rotation.set(0, this.host.localYaw, 0);
		}
		// The shared character controller's kinematic body was left wherever the
		// player stood before entering, resync it to the drop point (the same
		// flag CoinCommunities sets on a fresh coin spawn) so the next _stepLocal
		// re-seeds it there instead of resolving a stale move from the old spot.
		this.host._physicsActivePrev = false;
		if (serverForced) this.ui?.toast?.('You were removed from the vehicle.', 'warn');
	}

	// ---------------------------------------------------------------- input glue

	// The scene routes Space here while driving (it otherwise jumps).
	setHandbrake(on) { this._kbHandbrake = !!on; }

	// ---------------------------------------------------------------- prompt + HUD

	_updatePrompt() {
		const near = this._nearestParked();
		if (!near || this._pendingEnter) { this.prompt.classList.remove('veh-show'); return; }
		const g = near.entry.mesh.group;
		const w = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight;
		_v.set(g.position.x, g.position.y + 1.6, g.position.z).project(this.camera);
		if (_v.z > 1 || _v.z < -1) { this.prompt.classList.remove('veh-show'); return; }
		this.prompt.querySelector('.veh-label').textContent = `Drive the ${near.entry.spec.label}`;
		this.prompt.style.transform = `translate(-50%, -100%) translate(${(_v.x * 0.5 + 0.5) * w}px, ${(-_v.y * 0.5 + 0.5) * h}px)`;
		this.prompt.classList.add('veh-show');
	}

	_updateSpeedo(speed) {
		if (!this._speedoVal) return;
		this._speedoVal.textContent = String(Math.round(Math.abs(speed) * 3.6));
	}

	_isTouch() {
		return typeof matchMedia === 'function' && matchMedia('(hover: none), (pointer: coarse)').matches;
	}

	_buildPrompt() {
		this.prompt = document.createElement('div');
		this.prompt.className = 'veh-prompt';
		this.prompt.innerHTML = '<span class="veh-key">F</span><span class="veh-label">Drive</span>';
		document.body.appendChild(this.prompt);
	}

	// Driving HUD: a speedometer plus an exit button always, and an on-screen pedal
	// + steering cluster on touch devices. Pointer events (not click) so holding a
	// pedal accelerates and releasing lets off, works for touch and mouse alike.
	_buildControls() {
		const wrap = document.createElement('div');
		wrap.className = 'veh-hud';
		wrap.innerHTML = `
			<div class="veh-speedo"><b class="veh-speed-val">0</b><span>km/h</span></div>
			<button class="veh-exit" type="button" aria-label="Exit vehicle">Exit <span class="veh-key">F</span></button>
			<div class="veh-pads">
				<div class="veh-steer">
					<button class="veh-btn veh-left" type="button" aria-label="Steer left">◀</button>
					<button class="veh-btn veh-right" type="button" aria-label="Steer right">▶</button>
				</div>
				<div class="veh-pedals">
					<button class="veh-btn veh-brake" type="button" aria-label="Brake / reverse">⊘</button>
					<button class="veh-btn veh-hand" type="button" aria-label="Handbrake">P</button>
					<button class="veh-btn veh-gas" type="button" aria-label="Accelerate">▲</button>
				</div>
			</div>`;
		document.body.appendChild(wrap);
		this._hud = wrap;
		this._speedoVal = wrap.querySelector('.veh-speed-val');

		wrap.querySelector('.veh-exit').addEventListener('click', () => this.requestExit());

		const hold = (sel, on, off) => {
			const el = wrap.querySelector(sel);
			const down = (e) => { e.preventDefault(); on(); };
			const up = (e) => { e.preventDefault(); off(); };
			el.addEventListener('pointerdown', down);
			el.addEventListener('pointerup', up);
			el.addEventListener('pointercancel', up);
			el.addEventListener('pointerleave', up);
		};
		hold('.veh-gas', () => { this._touch.throttle = 1; }, () => { this._touch.throttle = 0; });
		hold('.veh-brake', () => { this._touch.brake = 1; }, () => { this._touch.brake = 0; });
		hold('.veh-left', () => { this._touch.steer = -1; }, () => { this._touch.steer = 0; });
		hold('.veh-right', () => { this._touch.steer = 1; }, () => { this._touch.steer = 0; });
		hold('.veh-hand', () => { this._touch.handbrake = true; }, () => { this._touch.handbrake = false; });
	}

	_showControls(on) {
		this._hud?.classList.toggle('veh-driving', on);
		this._hud?.classList.toggle('veh-touch', on && this._isTouch());
		if (!on) this._touch = { throttle: 0, brake: 0, steer: 0, handbrake: false };
		// The on-foot movement joystick (#cc-joystick) sits in the same bottom-left
		// corner as the steering pad and renders above it (z-index 30 vs our 22),
		// hide it while driving so it doesn't block the wheel.
		document.getElementById('cc-joystick')?.classList.toggle('veh-hide-joy', on);
	}

	_injectStyles() {
		if (document.getElementById('veh-styles')) return;
		const s = document.createElement('style');
		s.id = 'veh-styles';
		s.textContent = `
		.veh-hide-joy { display: none !important; }
		.veh-prompt {
			position: fixed; left: 0; top: 0; z-index: 16; pointer-events: none;
			transform: translate(-50%, -100%); white-space: nowrap; display: none;
			background: var(--cc-panel-solid, #0c0c0e); border: 1px solid var(--cc-edge, rgba(255,255,255,0.14));
			color: var(--cc-text, #f5f5f6); font: 700 12px Inter, system-ui, sans-serif; letter-spacing: 0.04em;
			padding: 6px 11px; border-radius: var(--cc-radius, 4px); box-shadow: var(--cc-glow, 0 0 14px rgba(255,255,255,0.25));
			text-transform: uppercase;
		}
		.veh-prompt.veh-show { display: block; }
		.veh-key {
			display: inline-block; min-width: 16px; text-align: center; margin: 0 0 0 6px;
			background: #fff; color: #060607; border-radius: 3px; padding: 0 4px; font-weight: 800;
		}
		.veh-prompt .veh-key { margin: 0 6px 0 0; }
		.veh-hud { position: fixed; inset: 0; z-index: 22; pointer-events: none; display: none; }
		.veh-hud.veh-driving { display: block; }
		.veh-speedo {
			position: fixed; right: 18px; bottom: 22px; text-align: center; pointer-events: none;
			background: var(--cc-panel, rgba(12,12,14,0.82)); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
			border: 1px solid var(--cc-edge, rgba(255,255,255,0.12)); border-radius: 12px; padding: 8px 14px;
			color: var(--cc-text, #f5f5f6); font-family: Inter, system-ui, sans-serif;
		}
		.veh-speedo b { display: block; font-size: 30px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
		.veh-speedo span { font-size: 10px; letter-spacing: 0.18em; color: var(--cc-dim, #8c8c92); text-transform: uppercase; }
		.veh-exit {
			position: fixed; top: 76px; right: 18px; pointer-events: auto; cursor: pointer;
			background: var(--cc-panel-solid, #0c0c0e); color: var(--cc-text, #f5f5f6);
			border: 1px solid var(--cc-edge, rgba(255,255,255,0.16)); border-radius: 8px; padding: 8px 12px;
			font: 700 12px Inter, system-ui, sans-serif; text-transform: uppercase; letter-spacing: 0.05em;
			transition: background 0.15s ease, border-color 0.15s ease;
		}
		.veh-exit:hover { background: #17171b; border-color: rgba(255,255,255,0.32); }
		.veh-exit:active { transform: translateY(1px); }
		.veh-pads { display: none; }
		.veh-hud.veh-touch .veh-pads { display: block; }
		.veh-steer { position: fixed; left: 18px; bottom: 24px; display: flex; gap: 14px; }
		.veh-pedals { position: fixed; right: 18px; bottom: 92px; display: flex; flex-direction: column; gap: 12px; align-items: center; }
		.veh-btn {
			pointer-events: auto; cursor: pointer; width: 64px; height: 64px; border-radius: 50%;
			background: var(--cc-panel, rgba(12,12,14,0.8)); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
			border: 1px solid var(--cc-edge, rgba(255,255,255,0.16)); color: var(--cc-text, #f5f5f6);
			font-size: 22px; font-weight: 800; display: flex; align-items: center; justify-content: center;
			touch-action: none; user-select: none; -webkit-user-select: none; transition: background 0.1s ease, transform 0.1s ease;
		}
		.veh-btn:active { background: rgba(255,255,255,0.22); transform: scale(0.94); }
		.veh-gas { width: 78px; height: 78px; }
		@media (max-width: 560px) { .veh-exit { top: 64px; } }
		`;
		document.head.appendChild(s);
	}

	dispose() {
		// Not serverForced: this is our own teardown, not an eviction, no toast.
		if (this._drivingId) this._endDriving(this.vehicle ? this.vehicle.transform() : null, false);
		clearTimeout(this._pendingTimer);
		for (const [, entry] of this.vehicles) {
			entry.collider?.remove();
			this.scene.remove(entry.mesh.group);
			entry.mesh.dispose();
		}
		this.vehicles.clear();
		this.prompt?.remove();
		this._hud?.remove();
		document.getElementById('veh-styles')?.remove();
		// `phys` is CoinCommunities' own shared world, owned and disposed by the
		// host, not us. Just drop our reference.
		this.phys = null;
	}
}
