// Minimap — a rotating GTA-style radar drawn on a canvas. The map turns under a
// fixed player arrow (player faces "up"), with a compass N marker, the world
// boundary ring, and live blips for peers / POIs / waypoints pushed by the host.
//
// All data is real: the viewer pose comes from the local avatar each frame and
// the blips from actual peer positions + world features. Nothing is invented.

const TAU = Math.PI * 2;

export class Minimap {
	constructor({ size } = {}) {
		this.size = size || 184;    // CSS px; canvas backing scales by DPR
		this.range = 70;           // world metres from centre to edge
		this.viewer = { x: 0, z: 0, yaw: 0 };
		this.blips = [];
		this.boundary = 58;        // world radius ring (0 = none)
		this._drawn = null;        // last-rendered frame state (dirty check in tick)
		this._blipsDirty = false;
		this._build();
	}

	_build() {
		this.root = document.createElement('div');
		this.root.className = 'wh-minimap';
		this.root.setAttribute('role', 'img');
		this.root.setAttribute('aria-label', 'Minimap');
		this.canvas = document.createElement('canvas');
		this.canvas.className = 'wh-minimap-canvas';
		this.ctx = this.canvas.getContext('2d');
		// Compass cardinal, painted as DOM so it stays crisp text.
		this.north = document.createElement('span');
		this.north.className = 'wh-minimap-n';
		this.north.textContent = 'N';
		this.root.append(this.canvas, this.north);
		this._resize();
	}

	_resize() {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		this.canvas.width = this.size * dpr;
		this.canvas.height = this.size * dpr;
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	setRange(m) { this.range = Math.max(10, m); }
	setBoundary(r) { this.boundary = Number(r) || 0; }
	setViewer(v) { if (v) this.viewer = { x: v.x || 0, z: v.z || 0, yaw: v.yaw || 0 }; }
	// Blips: [{ x, z, kind:'peer'|'poi'|'waypoint'|'party'|'prop', label?, color? }]
	setBlips(list) { this.blips = Array.isArray(list) ? list : []; this._blipsDirty = true; }

	// Inverse of _project: a point on the (rotating) map back to world space.
	// sx/sy are CSS px relative to the map's top-left, which is what a click handler
	// gets from a bounding rect. Lets hosts implement tap-to-set-waypoint.
	worldFromScreen(sx, sy) {
		const c = this.size / 2;
		const ppm = c / this.range;
		const rx = (sx - c) / ppm, ry = (sy - c) / ppm;
		const y = this.viewer.yaw;
		const cos = Math.cos(y), sin = Math.sin(y);
		// Forward map: mx = dx·cos − dz·sin, my = −(dx·sin + dz·cos). Invert:
		return {
			x: this.viewer.x + rx * cos - ry * sin,
			z: this.viewer.z - rx * sin - ry * cos,
		};
	}

	// Project a world point to map space with the player facing screen-up. Returns
	// {sx, sy, inside} where inside is false past the map edge (drawn as a rim arrow).
	_project(x, z) {
		const dx = x - this.viewer.x, dz = z - this.viewer.z;
		const y = this.viewer.yaw;
		const cos = Math.cos(y), sin = Math.sin(y);
		// forward (sin y, cos y) → up; right of forward → screen-right.
		const mx = dx * cos - dz * sin;
		const my = -(dx * sin + dz * cos);
		const ppm = (this.size / 2) / this.range;
		return { sx: mx * ppm, sy: my * ppm };
	}

	tick() {
		// Cheap dirty check: a full canvas repaint every frame is wasted work when
		// the player is idle and no blip moved. Redraw only when the viewer pose
		// moved perceptibly, a setter changed the data, or nothing was drawn yet.
		const v = this.viewer, d = this._drawn;
		if (
			d && !this._blipsDirty &&
			d.range === this.range && d.boundary === this.boundary &&
			Math.abs(v.x - d.x) < 0.02 && Math.abs(v.z - d.z) < 0.02 &&
			Math.abs(v.yaw - d.yaw) < 0.002
		) return;
		this._drawn = { x: v.x, z: v.z, yaw: v.yaw, range: this.range, boundary: this.boundary };
		this._blipsDirty = false;

		const ctx = this.ctx;
		const S = this.size, c = S / 2;
		const R = c - 3;                 // inner radius (clip mask handles the rim)
		ctx.clearRect(0, 0, S, S);

		// Ground + faint grid rings.
		ctx.save();
		ctx.beginPath(); ctx.arc(c, c, R, 0, TAU); ctx.clip();
		ctx.fillStyle = 'rgba(10,10,12,0.82)';
		ctx.fillRect(0, 0, S, S);
		ctx.strokeStyle = 'rgba(255,255,255,0.06)';
		ctx.lineWidth = 1;
		for (let r = R / 3; r < R; r += R / 3) { ctx.beginPath(); ctx.arc(c, c, r, 0, TAU); ctx.stroke(); }
		// Cross-hair grid aligned to the rotating map.
		ctx.strokeStyle = 'rgba(255,255,255,0.05)';
		ctx.beginPath(); ctx.moveTo(c - R, c); ctx.lineTo(c + R, c); ctx.moveTo(c, c - R); ctx.lineTo(c, c + R); ctx.stroke();

		// World boundary ring (where the plaza ends).
		if (this.boundary > 0) {
			const ppm = (S / 2) / this.range;
			const br = this.boundary * ppm;
			if (br < R + 30) {
				const p = this._project(0, 0); // world origin's screen offset
				ctx.strokeStyle = 'rgba(255,255,255,0.22)';
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				ctx.arc(c + p.sx, c + p.sy, br, 0, TAU);
				ctx.stroke();
			}
		}

		// Blips.
		for (const b of this.blips) {
			const p = this._project(b.x, b.z);
			let bx = p.sx, by = p.sy;
			const dist = Math.hypot(bx, by);
			const edge = R - 6;
			const clamped = dist > edge;
			if (clamped) { const k = edge / dist; bx *= k; by *= k; }
			const color = b.color || (b.kind === 'party' ? '#7fd1ff' : b.kind === 'poi' ? '#ffd166' : b.kind === 'waypoint' ? '#fff' : b.kind === 'prop' ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.85)');
			if (b.kind === 'prop') {
				// Scenery dot: a faint map texture, never clamped to the rim.
				if (clamped) continue;
				ctx.beginPath();
				ctx.arc(c + bx, c + by, 1.8, 0, TAU);
				ctx.fillStyle = color;
				ctx.fill();
			} else if (b.kind === 'waypoint') {
				// A diamond waypoint marker.
				ctx.save();
				ctx.translate(c + bx, c + by); ctx.rotate(Math.PI / 4);
				ctx.fillStyle = color; ctx.fillRect(-3.5, -3.5, 7, 7);
				ctx.restore();
			} else {
				ctx.beginPath();
				ctx.arc(c + bx, c + by, clamped ? 2.5 : (b.kind === 'poi' ? 3.4 : 3), 0, TAU);
				ctx.fillStyle = color;
				ctx.fill();
				if (!clamped && b.kind !== 'peer') { ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.stroke(); }
			}
		}
		ctx.restore();

		// Player arrow at centre (always points up — the map rotates beneath it).
		ctx.save();
		ctx.translate(c, c);
		ctx.beginPath();
		ctx.moveTo(0, -7); ctx.lineTo(5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5, 6); ctx.closePath();
		ctx.fillStyle = '#fff';
		ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 3;
		ctx.fill();
		ctx.restore();

		// Compass N marker: world-north (−Z) rotated into map space, parked on the rim.
		const ny = this.viewer.yaw;
		const ndirX = Math.sin(ny), ndirY = Math.cos(ny); // screen dir of world (0,-1)
		const rim = R - 11;
		this.north.style.transform = `translate(${(ndirX * rim).toFixed(1)}px, ${(ndirY * rim).toFixed(1)}px) translate(-50%, -50%)`;
	}

	dispose() { this.root?.remove(); }
}
