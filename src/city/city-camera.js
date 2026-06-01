import * as THREE from 'three';

const MIN_PHI  = 0.18; // ~10° — low angle
const MAX_PHI  = 1.30; // ~74° — near top-down
const MIN_DIST = 3;
const MAX_DIST = 28;
const LERP_K   = 0.12; // camera position lag

export class CityCamera {
	constructor(camera, canvas) {
		this._camera  = camera;
		this.theta    = 0;     // horizontal orbit angle (radians)
		this.phi      = 0.52;  // elevation angle from horizontal
		this.distance = 11;    // metres from look-target

		this._target  = new THREE.Vector3();
		this._desired = new THREE.Vector3();

		this._drag   = false;
		this._lastX  = 0;
		this._lastY  = 0;

		this._bindInput(canvas);
	}

	// Horizontal orbit angle — fed to CityPlayer so movement stays camera-relative
	get yaw() { return this.theta; }

	// Call once per frame before rendering.
	// playerPos: THREE.Vector3, playerHeight: number (metres)
	update(playerPos, playerHeight) {
		// Look at the player's upper body (chest/neck area)
		this._target.set(playerPos.x, playerPos.y + playerHeight * 0.58, playerPos.z);

		// Spherical offset from target
		const hDist = this.distance * Math.cos(this.phi);
		this._desired.set(
			this._target.x + hDist * Math.sin(this.theta),
			this._target.y + this.distance * Math.sin(this.phi),
			this._target.z + hDist * Math.cos(this.theta),
		);

		this._camera.position.lerp(this._desired, LERP_K);
		this._camera.lookAt(this._target);
	}

	// ── Input binding ─────────────────────────────────────────────────────────

	_bindInput(canvas) {
		this._onMouseDown = (e) => {
			if (e.button !== 0 && e.button !== 2) return;
			this._drag  = true;
			this._lastX = e.clientX;
			this._lastY = e.clientY;
		};
		this._onMouseMove = (e) => {
			if (!this._drag) return;
			const dx = e.clientX - this._lastX;
			const dy = e.clientY - this._lastY;
			this._lastX = e.clientX;
			this._lastY = e.clientY;
			this.theta -= dx * 0.0045;
			this.phi    = Math.max(MIN_PHI, Math.min(MAX_PHI, this.phi + dy * 0.0045));
		};
		this._onMouseUp  = () => { this._drag = false; };
		this._onWheel    = (e) => {
			this.distance = Math.max(MIN_DIST, Math.min(MAX_DIST, this.distance + e.deltaY * 0.018));
		};

		// Touch orbit (one finger drag)
		this._onTouchStart = (e) => {
			if (e.touches.length !== 1) return;
			this._drag  = true;
			this._lastX = e.touches[0].clientX;
			this._lastY = e.touches[0].clientY;
		};
		this._onTouchMove = (e) => {
			if (!this._drag || e.touches.length !== 1) return;
			const dx = e.touches[0].clientX - this._lastX;
			const dy = e.touches[0].clientY - this._lastY;
			this._lastX = e.touches[0].clientX;
			this._lastY = e.touches[0].clientY;
			this.theta -= dx * 0.005;
			this.phi    = Math.max(MIN_PHI, Math.min(MAX_PHI, this.phi + dy * 0.005));
		};
		this._onTouchEnd = () => { this._drag = false; };

		canvas.addEventListener('mousedown',  this._onMouseDown);
		canvas.addEventListener('wheel',      this._onWheel, { passive: true });
		canvas.addEventListener('touchstart', this._onTouchStart, { passive: true });
		canvas.addEventListener('touchmove',  this._onTouchMove,  { passive: true });
		canvas.addEventListener('touchend',   this._onTouchEnd);
		window.addEventListener('mousemove',  this._onMouseMove);
		window.addEventListener('mouseup',    this._onMouseUp);

		this._canvas = canvas;
	}

	destroy() {
		this._canvas.removeEventListener('mousedown',  this._onMouseDown);
		this._canvas.removeEventListener('wheel',      this._onWheel);
		this._canvas.removeEventListener('touchstart', this._onTouchStart);
		this._canvas.removeEventListener('touchmove',  this._onTouchMove);
		this._canvas.removeEventListener('touchend',   this._onTouchEnd);
		window.removeEventListener('mousemove', this._onMouseMove);
		window.removeEventListener('mouseup',   this._onMouseUp);
	}
}
