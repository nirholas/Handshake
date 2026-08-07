// Fireworks: a cheap, pretty particle fireworks system for the /play plaza.
//
// Each burst is ONE THREE.Points object (shell ascent + explosion sharing a
// buffer), additive-blended so overlapping shows glow instead of muddying, and
// fully disposed when spent. Simulation is analytic per-frame (position from
// velocity + gravity), so a hundred sparks cost one attribute upload per burst
// per frame and zero allocations after launch.
//
// Callers own the schedule (see meetup-schedule.js fireworkPlan for the
// deterministic show every client agrees on) and call launch(); this module
// owns only the visuals.

import {
	AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group,
	Points, PointsMaterial, PointLight,
} from 'three';

// Warm celebratory palettes; index picked by the deterministic plan.
const PALETTES = [
	[0xffd76a, 0xffb347], // gold
	[0x8de6a8, 0x2fd483], // mint green
	[0x9ecbff, 0x4d8dff], // ice blue
	[0xff9de2, 0xff4da6], // pink
	[0xc7a6ff, 0x8a5cff], // violet
	[0xfff2b3, 0xffffff], // white-gold
];

const GRAVITY = -9.5;
const SPARKS = 90;

export class Fireworks {
	/** @param {{scene: import('three').Scene}} opts */
	constructor({ scene }) {
		this.scene = scene;
		this.group = new Group();
		this.group.name = 'fireworks';
		this.scene.add(this.group);
		this._bursts = [];
		this._lights = [];
	}

	// Launch a shell from (x, 0, z) that detonates at `apex` meters.
	launch(x, z, { apex = 20, palette = 0 } = {}) {
		const colors = PALETTES[((palette % PALETTES.length) + PALETTES.length) % PALETTES.length];
		const geo = new BufferGeometry();
		const pos = new Float32Array(SPARKS * 3);
		const vel = new Float32Array(SPARKS * 3);
		const col = new Float32Array(SPARKS * 3);
		const c1 = new Color(colors[0]);
		const c2 = new Color(colors[1]);
		for (let i = 0; i < SPARKS; i++) {
			pos[i * 3] = x; pos[i * 3 + 1] = 0.5; pos[i * 3 + 2] = z;
			// Explosion velocities: roughly spherical with slight upward bias.
			const theta = Math.random() * Math.PI * 2;
			const phi = Math.acos(2 * Math.random() - 1);
			const speed = 4.5 + Math.random() * 5.5;
			vel[i * 3] = Math.sin(phi) * Math.cos(theta) * speed;
			vel[i * 3 + 1] = Math.abs(Math.cos(phi)) * speed * 0.9 + 1.5;
			vel[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;
			const c = Math.random() < 0.65 ? c1 : c2;
			col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
		}
		geo.setAttribute('position', new BufferAttribute(pos, 3));
		geo.setAttribute('color', new BufferAttribute(col, 3));
		const mat = new PointsMaterial({
			size: 0.55, vertexColors: true, transparent: true, opacity: 1,
			blending: AdditiveBlending, depthWrite: false, sizeAttenuation: true,
		});
		const points = new Points(geo, mat);
		points.frustumCulled = false;
		this.group.add(points);
		this._bursts.push({
			points, geo, mat, vel,
			x, z, apex,
			age: 0,
			riseTime: 0.9 + Math.random() * 0.3, // shell ascent duration
			burstTtl: 1.9,                        // spark life after detonation
			exploded: false,
		});
		return true;
	}

	// A brief colored flash on the ground under a detonation sells the light
	// without a real point light per spark. One pooled light, reused.
	_flash(x, z, colorHex) {
		let light = this._lights.find((l) => l.ttl <= 0);
		if (!light) {
			if (this._lights.length >= 3) return; // cap: never more than 3 live lights
			light = { obj: new PointLight(0xffffff, 0, 60, 1.8), ttl: 0 };
			this.group.add(light.obj);
			this._lights.push(light);
		}
		light.obj.color.set(colorHex);
		light.obj.position.set(x, 14, z);
		light.obj.intensity = 90;
		light.ttl = 0.45;
	}

	tick(dt) {
		for (const l of this._lights) {
			if (l.ttl > 0) {
				l.ttl -= dt;
				l.obj.intensity = Math.max(0, l.obj.intensity - dt * 220);
			}
		}
		if (!this._bursts.length) return;
		for (let i = this._bursts.length - 1; i >= 0; i--) {
			const b = this._bursts[i];
			b.age += dt;
			const posAttr = b.geo.getAttribute('position');
			const pos = posAttr.array;
			if (!b.exploded) {
				// Shell ascent: all sparks ride together as one bright dot.
				const t = Math.min(1, b.age / b.riseTime);
				const y = 0.5 + (b.apex - 0.5) * (1 - (1 - t) * (1 - t)); // ease-out climb
				for (let p = 0; p < SPARKS; p++) pos[p * 3 + 1] = y;
				if (t >= 1) {
					b.exploded = true;
					b.age = 0;
					// Re-anchor sparks at the apex; velocities take over from here.
					for (let p = 0; p < SPARKS; p++) { pos[p * 3] = b.x; pos[p * 3 + 2] = b.z; }
					const col = b.geo.getAttribute('color').array;
					this._flash(b.x, b.z, new Color(col[0], col[1], col[2]).getHex());
				}
			} else {
				const drag = Math.max(0, 1 - dt * 0.9);
				for (let p = 0; p < SPARKS; p++) {
					b.vel[p * 3] *= drag;
					b.vel[p * 3 + 1] = b.vel[p * 3 + 1] * drag + GRAVITY * dt;
					b.vel[p * 3 + 2] *= drag;
					pos[p * 3] += b.vel[p * 3] * dt;
					pos[p * 3 + 1] += b.vel[p * 3 + 1] * dt;
					pos[p * 3 + 2] += b.vel[p * 3 + 2] * dt;
				}
				b.mat.opacity = Math.max(0, 1 - b.age / b.burstTtl);
				b.mat.size = 0.55 * (1 - 0.4 * (b.age / b.burstTtl));
				if (b.age >= b.burstTtl) {
					this.group.remove(b.points);
					b.geo.dispose();
					b.mat.dispose();
					this._bursts.splice(i, 1);
					continue;
				}
			}
			posAttr.needsUpdate = true;
		}
	}

	get liveCount() { return this._bursts.length; }

	dispose() {
		for (const b of this._bursts) {
			this.group.remove(b.points);
			b.geo.dispose();
			b.mat.dispose();
		}
		this._bursts = [];
		for (const l of this._lights) this.group.remove(l.obj);
		this._lights = [];
		this.scene.remove(this.group);
	}
}
