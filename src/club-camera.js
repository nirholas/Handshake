// Camera state machine for /club.
//
// Four modes:
//   - free  : user-driven orbit around the dance floor (default).
//   - vip   : framed close-up of a single pole's dancer (front-and-low,
//             slight upward tilt). Triggered by pole card click or 1-4 keys.
//   - house : top-down overhead with gentle automated yaw rotation.
//   - auto  : slowly orbits the performing dancer's pole. Triggered when
//             auto-follow is on and a performance starts.
//
// Transitions use quaternion slerp for rotation and position lerp over 0.8s
// for buttery smooth interpolation. No teleports, ever.
//
// Input: drag / zoom go through applyDrag / applyZoom. Drag is ignored in
// non-free modes; zoom works in free and VIP.

import { Quaternion, Vector3 } from 'three';

export const CLUB_CAMERA_MODES = ['free', 'vip', 'house', 'auto'];

const FREE_OFFSET_BASE = new Vector3(0, 2.2, 7.2);
const FREE_TARGET = new Vector3(0, 1.2, -1.8);

// VIP: front-and-low, slight upward tilt. The offset places the camera
// below the dancer's waist height and slightly in front.
const VIP_HEIGHT = 0.85;
const VIP_DISTANCE = 2.4;

// House: top-down with gentle automated yaw rotation.
const HOUSE_HEIGHT = 13;
const HOUSE_YAW_SPEED = 0.08; // radians/sec

// Auto-cam orbit speed during performance.
const AUTO_ORBIT_SPEED = 0.35; // radians/sec
const AUTO_ORBIT_RADIUS = 3.2;
const AUTO_ORBIT_HEIGHT = 1.6;

// Transition duration — 0.8s means lerp factor ~3.2 at 60fps.
const TRANSITION_LERP = 3.2;

// Per-mode zoom bounds so we don't end up inside the geometry or 30m away.
const ZOOM_BOUNDS = {
	free: { min: 3.5, max: 14.0 },
	vip:  { min: 1.4, max: 5.5 },
	auto: { min: 2.0, max: 6.0 },
};

export class ClubCamera {
	constructor(camera, opts = {}) {
		this.camera = camera;
		this.mode = 'free';
		this.target = FREE_TARGET.clone();
		this.offset = FREE_OFFSET_BASE.clone();
		this.yaw = 0;
		this.pitch = 0.05;
		this._pending = null; // {target, offset, lerp}
		this._onModeChange = opts.onModeChange || null;
		this._houseYaw = 0;
		this._autoYaw = 0;
		this._autoOrbitRadius = AUTO_ORBIT_RADIUS;
		this._autoLayout = null; // pole layout for auto-orbit
		this._activeVipId = null;
		// Slerp state for smooth rotation interpolation.
		this._prevQuat = new Quaternion();
		this._targetQuat = new Quaternion();
		this._slerpAlpha = 1; // 1 = fully settled
	}

	getMode() { return this.mode; }
	getActiveVipId() { return this._activeVipId; }

	_emitMode() {
		if (this._onModeChange) {
			try { this._onModeChange(this.mode); } catch {}
		}
	}

	setFree() {
		const was = this.mode;
		this.mode = 'free';
		this._activeVipId = null;
		this._autoLayout = null;
		this._pending = {
			target: FREE_TARGET.clone(),
			offset: new Vector3(0, 2.2 + this.pitch * 2.5, this.offset.length() > 0 ? this.offset.length() : 7.2),
			lerp: TRANSITION_LERP,
		};
		this._startSlerp();
		if (was !== 'free') this._emitMode();
	}

	setVip(poleLayout) {
		if (!poleLayout) return;
		const was = this.mode;
		this.mode = 'vip';
		// Front-and-low: camera in front of the pole, below waist, looking up.
		const target = new Vector3(poleLayout.x, 1.4, poleLayout.z);
		const offset = new Vector3(
			Math.sin(poleLayout.yaw + Math.PI) * VIP_DISTANCE,
			VIP_HEIGHT,
			Math.cos(poleLayout.yaw + Math.PI) * VIP_DISTANCE,
		);
		this._pending = { target, offset, lerp: TRANSITION_LERP };
		this._activeVipId = poleLayout.id || null;
		this._autoLayout = null;
		this._startSlerp();
		if (was !== 'vip') this._emitMode();
	}

	setHouse() {
		const was = this.mode;
		this.mode = 'house';
		this._activeVipId = null;
		this._autoLayout = null;
		this._houseYaw = 0;
		this._pending = {
			target: new Vector3(0, 0.5, -1.5),
			offset: new Vector3(0, HOUSE_HEIGHT, 0.001), // epsilon to avoid singular up
			lerp: TRANSITION_LERP,
		};
		this._startSlerp();
		if (was !== 'house') this._emitMode();
	}

	/**
	 * Auto-cam: slowly orbit around a performing dancer's pole.
	 * Used by the auto-follow feature during performances.
	 */
	setAuto(poleLayout) {
		if (!poleLayout) return;
		const was = this.mode;
		this.mode = 'auto';
		this._autoLayout = poleLayout;
		this._activeVipId = poleLayout.id || null;
		this._autoYaw = poleLayout.yaw + Math.PI; // start facing the dancer
		const target = new Vector3(poleLayout.x, 1.3, poleLayout.z);
		const offset = new Vector3(
			Math.sin(this._autoYaw) * AUTO_ORBIT_RADIUS,
			AUTO_ORBIT_HEIGHT,
			Math.cos(this._autoYaw) * AUTO_ORBIT_RADIUS,
		);
		this._pending = { target, offset, lerp: TRANSITION_LERP };
		this._startSlerp();
		if (was !== 'auto') this._emitMode();
	}

	_startSlerp() {
		// Capture the current camera quaternion for smooth rotation interpolation.
		this._prevQuat.copy(this.camera.quaternion);
		this._slerpAlpha = 0;
	}

	// Pointer drag -- only effective in free orbit.
	applyDrag(dx, dy) {
		if (this.mode !== 'free') return;
		this.yaw -= dx * 0.004;
		this.pitch = Math.max(-0.3, Math.min(0.5, this.pitch - dy * 0.003));
	}

	// Zoom (wheel deltaY or pinch delta). Honored in free + vip + auto.
	// Positive deltaY = wheel-down = zoom out, matching browser convention.
	applyZoom(deltaY) {
		if (this.mode === 'house') return;
		const bounds = ZOOM_BOUNDS[this.mode] || ZOOM_BOUNDS.free;
		const factor = 1 + deltaY * 0.0015;

		if (this.mode === 'auto') {
			// In auto mode, adjust the orbit radius directly and update the
			// offset vector so pending transitions stay in sync.
			const nextRadius = Math.max(bounds.min, Math.min(bounds.max, this._autoOrbitRadius * factor));
			this._autoOrbitRadius = nextRadius;
			const current = this._pending ? this._pending.offset : this.offset;
			const len = current.length();
			if (len > 1e-4) current.multiplyScalar(nextRadius / (len > 1e-4 ? Math.hypot(current.x, current.z) || len : len));
			return;
		}

		const current = this._pending ? this._pending.offset : this.offset;
		const len = current.length();
		if (len < 1e-4) return;
		const nextLen = Math.max(bounds.min, Math.min(bounds.max, len * factor));
		const scale = nextLen / len;
		current.multiplyScalar(scale);
	}

	tick(dt) {
		// Advance transition lerp.
		if (this._pending) {
			const k = Math.min(1, dt * this._pending.lerp);
			this.target.lerp(this._pending.target, k);
			this.offset.lerp(this._pending.offset, k);
			if (
				this.target.distanceTo(this._pending.target) < 0.005 &&
				this.offset.distanceTo(this._pending.offset) < 0.005
			) {
				this.target.copy(this._pending.target);
				this.offset.copy(this._pending.offset);
				this._pending = null;
			}
		}

		if (this.mode === 'free') {
			// In free mode the stored offset is the "base" rest position; rotate
			// it around Y by user yaw to orbit. Pitch is baked into the offset Y.
			const rest = this.offset.clone();
			rest.y = 2.2 + this.pitch * 2.5;
			const rotated = rest.applyAxisAngle(new Vector3(0, 1, 0), this.yaw);
			this.camera.position.copy(this.target.clone().add(rotated));
		} else if (this.mode === 'house') {
			// Gentle automated yaw rotation for overhead shot.
			this._houseYaw += HOUSE_YAW_SPEED * dt;
			const radius = 0.5; // subtle orbit radius
			const houseOffset = new Vector3(
				Math.sin(this._houseYaw) * radius,
				this.offset.y,
				Math.cos(this._houseYaw) * radius,
			);
			this.camera.position.copy(this.target.clone().add(houseOffset));
		} else if (this.mode === 'auto' && this._autoLayout) {
			// Slowly orbit the performing dancer's pole.
			this._autoYaw += AUTO_ORBIT_SPEED * dt;
			const orbitOffset = new Vector3(
				Math.sin(this._autoYaw) * this._autoOrbitRadius,
				AUTO_ORBIT_HEIGHT,
				Math.cos(this._autoYaw) * this._autoOrbitRadius,
			);
			const autoTarget = new Vector3(
				this._autoLayout.x,
				1.3,
				this._autoLayout.z,
			);
			// Lerp position for smooth orbiting even during transition.
			const idealPos = autoTarget.clone().add(orbitOffset);
			this.camera.position.lerp(idealPos, Math.min(1, dt * 3));
			this.target.lerp(autoTarget, Math.min(1, dt * 3));
		} else {
			// VIP or settling.
			this.camera.position.copy(this.target.clone().add(this.offset));
		}

		this.camera.lookAt(this.target);

		// Smooth rotation interpolation (slerp).
		if (this._slerpAlpha < 1) {
			this._slerpAlpha = Math.min(1, this._slerpAlpha + dt * TRANSITION_LERP);
			const finalQuat = this.camera.quaternion.clone();
			this.camera.quaternion.copy(this._prevQuat).slerp(finalQuat, this._slerpAlpha);
			if (this._slerpAlpha >= 0.99) {
				this._slerpAlpha = 1;
				this.camera.quaternion.copy(finalQuat);
			}
			// Update the prev quat so next frame interpolates from here.
			this._prevQuat.copy(this.camera.quaternion);
		}
	}
}
