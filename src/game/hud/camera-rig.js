// CameraRig — the third-person camera for /play, upgraded into a proper GTA-style
// rig: smooth collision-aware follow, a vehicle chase cam, an over-the-shoulder
// aim cam, an optional first-person toggle, FOV kick on speed/sprint, and a
// trauma-based shake for impacts. Modes blend automatically because every mode
// just retargets the same eased params (distance / height / shoulder / fov), so
// switching cameras is a smooth interpolation, never a cut.
//
// The host owns the *input* yaw/pitch/dist (drag + wheel, also used for movement
// basis); the rig eases its own *render* yaw/pitch/dist toward those and writes
// the final transform onto the three camera each frame.

import { Vector3, Raycaster } from 'three';
import { onReducedMotionChange } from '../a11y.js';

// Camera shake and the speed FOV kick are exactly the vestibular triggers
// `prefers-reduced-motion` exists to switch off. The rig keeps following and
// colliding as normal; only the involuntary movement is suppressed.
let reducedMotion = false;
onReducedMotionChange((on) => { reducedMotion = on; });

const MODES = {
	follow:  { distMul: 1.0,  height: 1.45, shoulder: 0.0,  fov: 0,   posLerp: 0.16, lookHeight: 1.4 },
	vehicle: { distMul: 1.55, height: 2.0,  shoulder: 0.0,  fov: 6,   posLerp: 0.10, lookHeight: 1.2 },
	aim:     { distMul: 0.55, height: 1.55, shoulder: 0.65, fov: -8,  posLerp: 0.28, lookHeight: 1.5 },
	first:   { distMul: 0.0,  height: 0.0,  shoulder: 0.0,  fov: 4,   posLerp: 0.5,  lookHeight: 0.0 },
};

const lerp = (a, b, t) => a + (b - a) * t;

export class CameraRig {
	constructor(camera, { baseFov = 50 } = {}) {
		this.camera = camera;
		this.baseFov = baseFov;
		this.mode = 'follow';
		this._prevMode = 'follow';      // mode to fall back to when leaving first-person
		// Eased render state.
		this.yaw = 0.6; this.pitch = 0.5; this.dist = 9;
		this.fov = baseFov;
		this._pos = new Vector3();
		this._look = new Vector3();
		this._inited = false;
		// FOV kick + shake.
		this._fovKick = 0;
		this._trauma = 0;             // 0..1, decays each frame; shake ∝ trauma²
		this._shakeT = 0;
		this._ray = new Raycaster();
		this._dir = new Vector3();
		this._desired = new Vector3();
	}

	setMode(mode) {
		if (!MODES[mode] || mode === this.mode) return;
		if (this.mode !== 'first') this._prevMode = this.mode;
		this.mode = mode;
	}

	// First-person toggle (V): drop into the eyes, or back to the prior chase cam.
	toggleFirstPerson() { this.setMode(this.mode === 'first' ? this._prevMode : 'first'); }
	isFirstPerson() { return this.mode === 'first'; }

	// Add camera trauma (0..1). Stacks; decays in update(). Use for damage, hard
	// landings, explosions — the game-feel layer calls this.
	shake(amount = 0.4) {
		if (reducedMotion) return;
		this._trauma = Math.min(1, this._trauma + amount);
	}

	/**
	 * @param {number} dt
	 * @param {object} ctx
	 * @param {{x,y,z}} ctx.target     avatar ground position
	 * @param {number} ctx.yaw         input yaw (camera orbit)
	 * @param {number} ctx.pitch       input pitch
	 * @param {number} ctx.dist        input distance
	 * @param {number} [ctx.speed]     current move speed (m/s) for FOV kick
	 * @param {boolean} [ctx.sprinting]
	 * @param {number} [ctx.headHeight] avatar head height (m)
	 * @param {Object3D[]} [ctx.colliders] meshes the camera shouldn't clip through
	 * @param {number} [ctx.autoYaw]   when set (vehicles), bias yaw to trail heading
	 */
	update(dt, ctx) {
		const m = MODES[this.mode];
		const head = ctx.headHeight || 1.7;
		// Snap on first frame so we don't sling in from the origin.
		const k = this._inited ? 1 - Math.pow(1 - m.posLerp, Math.max(1, dt * 60)) : 1;

		// Vehicles gently trail behind the heading unless the player is steering the
		// camera; the host supplies autoYaw as the vehicle's facing.
		let targetYaw = ctx.yaw;
		if (ctx.autoYaw != null && this.mode === 'vehicle') {
			let d = ctx.autoYaw - this.yaw;
			while (d > Math.PI) d -= Math.PI * 2;
			while (d < -Math.PI) d += Math.PI * 2;
			targetYaw = this.yaw + d * 0.04;
		}
		this.yaw = this._inited ? this.yaw + shortestArc(this.yaw, targetYaw) * k : targetYaw;
		this.pitch = this._inited ? lerp(this.pitch, ctx.pitch, k) : ctx.pitch;
		const wantDist = (ctx.dist || 9) * m.distMul;
		this.dist = this._inited ? lerp(this.dist, wantDist, k) : wantDist;

		// Eased look target at the avatar's chest/head.
		const tx = ctx.target.x, ty = ctx.target.y, tz = ctx.target.z;
		const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
		const fwdX = Math.sin(this.yaw), fwdZ = Math.cos(this.yaw);
		const rightX = Math.cos(this.yaw), rightZ = -Math.sin(this.yaw);

		// Desired eye position behind + above the target, offset to the shoulder.
		const ox = fwdX * cp * this.dist - rightX * m.shoulder;
		const oz = fwdZ * cp * this.dist - rightZ * m.shoulder;
		const oy = sp * this.dist + m.height;
		this._desired.set(tx - ox, ty + oy, tz - oz);

		// Collision: pull the camera in if a wall/building sits between it and the
		// head, so the chase cam never clips into geometry. One ray, cheap.
		const originX = tx, originY = ty + head * 0.9, originZ = tz;
		if (this.mode !== 'first' && ctx.colliders && ctx.colliders.length) {
			this._dir.set(this._desired.x - originX, this._desired.y - originY, this._desired.z - originZ);
			const want = this._dir.length();
			if (want > 0.01) {
				this._dir.multiplyScalar(1 / want);
				this._ray.set({ x: originX, y: originY, z: originZ }, this._dir);
				this._ray.far = want;
				const hits = this._ray.intersectObjects(ctx.colliders, true);
				if (hits.length) {
					const safe = Math.max(0.6, hits[0].distance - 0.35);
					this._desired.set(originX + this._dir.x * safe, originY + this._dir.y * safe, originZ + this._dir.z * safe);
				}
			}
		}

		if (!this._inited) { this._pos.copy(this._desired); this._inited = true; }
		else this._pos.lerp(this._desired, k);

		// Look point: ahead of the eyes in first-person, at the avatar otherwise.
		if (this.mode === 'first') {
			const ex = tx, ey = ty + head * 0.94, ez = tz;
			this._pos.set(ex + fwdX * 0.12, ey, ez + fwdZ * 0.12);
			this._look.set(ex + fwdX * cp, ey - sp, ez + fwdZ * cp);
		} else {
			const lookTarget = this._tmpLook || (this._tmpLook = new Vector3());
			lookTarget.set(tx + rightX * m.shoulder, ty + m.lookHeight, tz + rightZ * m.shoulder);
			if (this._inited) this._look.lerp(lookTarget, k);
			else this._look.copy(lookTarget);
		}

		// FOV: base + per-mode bias + a speed/sprint kick, all eased.
		const speed = ctx.speed || 0;
		const kickTarget = m.fov + (reducedMotion ? 0 : (ctx.sprinting ? 4 : 0) + Math.min(10, speed * 0.7));
		this._fovKick = lerp(this._fovKick, kickTarget, 1 - Math.pow(0.001, dt));
		this.fov = this.baseFov + this._fovKick;

		// Trauma shake: decays fast; offsets position + a roll, scaled by trauma².
		let shakeX = 0, shakeY = 0, roll = 0;
		if (this._trauma > 0.0001) {
			this._trauma = Math.max(0, this._trauma - dt * 1.6);
			this._shakeT += dt * 40;
			const s = this._trauma * this._trauma;
			shakeX = Math.sin(this._shakeT * 1.7) * s * 0.5;
			shakeY = Math.sin(this._shakeT * 2.3 + 1.3) * s * 0.5;
			roll = Math.sin(this._shakeT * 1.1) * s * 0.05;
		}

		this.camera.position.set(this._pos.x + rightX * shakeX, this._pos.y + shakeY, this._pos.z + rightZ * shakeX);
		this.camera.lookAt(this._look.x, this._look.y, this._look.z);
		if (roll) this.camera.rotateZ(roll);
		if (Math.abs(this.camera.fov - this.fov) > 0.01) { this.camera.fov = this.fov; this.camera.updateProjectionMatrix(); }
	}

	reset() { this._inited = false; this._trauma = 0; this._fovKick = 0; }
}

// Smallest signed angular step a→b, wrapped to (−π, π].
function shortestArc(a, b) {
	let d = b - a;
	while (d > Math.PI) d -= Math.PI * 2;
	while (d < -Math.PI) d += Math.PI * 2;
	return d;
}
