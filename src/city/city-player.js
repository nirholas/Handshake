import * as THREE from 'three';
import {
	buildAvatar, resolveAvatarUrl, loadManifest, newAnim,
	CLIP_IDLE, CLIP_WALK,
} from '../game/avatar-rig.js';
import { CITY_HALF } from './city-map.js';

const WALK_SPEED  = 5;   // m/s
const SPRINT_SPEED = 11;  // m/s
const JUMP_VEL    = 9;   // m/s initial upward
const GRAVITY     = -22; // m/s²
const PLAYER_R    = 0.42; // collision capsule radius (metres)
const BOUNDS      = CITY_HALF - 6;

export class CityPlayer {
	constructor(scene) {
		this._scene = scene;

		// Visual rig — avatar model is a child of this
		this.rig = new THREE.Group();
		scene.add(this.rig);

		this.velocity = new THREE.Vector3();
		this.onGround = false;
		this.motion = 'idle';

		this._anim   = null;
		this.height  = 1.7;   // head-anchor height, updated after avatar loads

		// Raw key state
		this._keys = new Set();
		// Current horizontal facing angle (radians, Three.js Y-rotation convention)
		this._yaw = 0;

		this._bindInput();
	}

	get position() { return this.rig.position; }

	// ── Avatar loading ────────────────────────────────────────────────────────

	async load(avatarInput) {
		await loadManifest();
		const url = await resolveAvatarUrl(avatarInput || '');
		this._anim = newAnim();
		const { height } = await buildAvatar(this.rig, url, this._anim);
		this.height = height;
		return this;
	}

	// ── Per-frame update ──────────────────────────────────────────────────────
	// cameraYaw: horizontal angle of the orbiting camera (radians)

	update(dt, buildingBoxes, cameraYaw) {
		const sprint  = this._keys.has('shift');
		const speed   = sprint ? SPRINT_SPEED : WALK_SPEED;

		// Build movement vector in camera space
		let dx = 0, dz = 0;
		if (this._keys.has('w') || this._keys.has('arrowup'))    { dx -= Math.sin(cameraYaw); dz -= Math.cos(cameraYaw); }
		if (this._keys.has('s') || this._keys.has('arrowdown'))  { dx += Math.sin(cameraYaw); dz += Math.cos(cameraYaw); }
		if (this._keys.has('a') || this._keys.has('arrowleft'))  { dx -= Math.cos(cameraYaw); dz += Math.sin(cameraYaw); }
		if (this._keys.has('d') || this._keys.has('arrowright')) { dx += Math.cos(cameraYaw); dz -= Math.sin(cameraYaw); }

		const moving = dx !== 0 || dz !== 0;
		if (moving) {
			const len = Math.sqrt(dx * dx + dz * dz);
			dx /= len; dz /= len;
			this.velocity.x = dx * speed;
			this.velocity.z = dz * speed;
			// Face movement direction (atan2 gives angle from +Z axis in XZ plane)
			this._yaw = Math.atan2(dx, dz);
		} else {
			this.velocity.x *= Math.pow(0.05, dt); // quick stop
			this.velocity.z *= Math.pow(0.05, dt);
		}

		// Jump
		if (this._keys.has(' ') && this.onGround) {
			this.velocity.y = JUMP_VEL;
			this.onGround = false;
		}

		// Gravity
		if (!this.onGround) {
			this.velocity.y += GRAVITY * dt;
		}

		// Tentative next position
		const p = this.rig.position;
		let nx = p.x + this.velocity.x * dt;
		let ny = p.y + this.velocity.y * dt;
		let nz = p.z + this.velocity.z * dt;

		// Building collision (push-out in XZ plane)
		const resolved = this._resolveBuildings(nx, ny, nz, buildingBoxes);
		nx = resolved.x; nz = resolved.z;

		// Ground — flat terrain at y = 0
		if (ny <= 0) { ny = 0; this.velocity.y = 0; this.onGround = true; }
		else          { this.onGround = false; }

		// World bounds
		nx = Math.max(-BOUNDS, Math.min(BOUNDS, nx));
		nz = Math.max(-BOUNDS, Math.min(BOUNDS, nz));

		p.set(nx, ny, nz);

		// Smooth rotation toward movement direction
		if (moving) {
			let diff = this._yaw - this.rig.rotation.y;
			while (diff >  Math.PI) diff -= Math.PI * 2;
			while (diff < -Math.PI) diff += Math.PI * 2;
			this.rig.rotation.y += diff * Math.min(1, dt * 14);
		}

		// Animation
		this._updateMotion(sprint, moving);
		this._anim?.update(dt);
	}

	// ── Private ───────────────────────────────────────────────────────────────

	_updateMotion(sprint, moving) {
		if (!this._anim) return;
		const hSpeed = Math.sqrt(this.velocity.x ** 2 + this.velocity.z ** 2);
		const next = hSpeed < 0.4 ? 'idle' : (sprint ? 'sprint' : 'walk');
		if (next === this.motion) return;
		this.motion = next;
		const clip = next === 'idle' ? CLIP_IDLE : CLIP_WALK;
		this._anim.crossfadeTo(clip, 0.2).catch(() => {});
	}

	_resolveBuildings(nx, ny, nz, boxes) {
		// Simple capsule vs AABB: treat player as a vertical cylinder of radius PLAYER_R
		for (const b of boxes) {
			if (ny > b.h) continue; // stepped over or jumped above
			// Closest point on box to player centre
			const cx = Math.max(b.minX, Math.min(b.maxX, nx));
			const cz = Math.max(b.minZ, Math.min(b.maxZ, nz));
			const ox = nx - cx;
			const oz = nz - cz;
			const dist2 = ox * ox + oz * oz;
			if (dist2 >= PLAYER_R * PLAYER_R) continue;

			const dist = Math.sqrt(dist2);
			if (dist < 0.001) {
				// Dead centre inside box — eject toward nearest face
				const toLeft  = nx - b.minX;
				const toRight = b.maxX - nx;
				const toFront = nz - b.minZ;
				const toBack  = b.maxZ - nz;
				const min = Math.min(toLeft, toRight, toFront, toBack);
				if (min === toLeft)  nx = b.minX - PLAYER_R;
				else if (min === toRight) nx = b.maxX + PLAYER_R;
				else if (min === toFront) nz = b.minZ - PLAYER_R;
				else                      nz = b.maxZ + PLAYER_R;
			} else {
				const push = (PLAYER_R - dist) / dist;
				nx += ox * push;
				nz += oz * push;
			}
		}
		return { x: nx, z: nz };
	}

	_bindInput() {
		const TRACKED = new Set([
			'w','a','s','d',
			'arrowup','arrowdown','arrowleft','arrowright',
			' ','shift',
		]);
		this._onKeyDown = (e) => {
			const k = e.key.toLowerCase();
			if (!TRACKED.has(k)) return;
			if (k === ' ' || k.startsWith('arrow')) e.preventDefault();
			this._keys.add(k);
		};
		this._onKeyUp = (e) => {
			this._keys.delete(e.key.toLowerCase());
		};
		window.addEventListener('keydown', this._onKeyDown);
		window.addEventListener('keyup',   this._onKeyUp);
	}

	destroy() {
		window.removeEventListener('keydown', this._onKeyDown);
		window.removeEventListener('keyup',   this._onKeyUp);
		this._scene.remove(this.rig);
	}
}
