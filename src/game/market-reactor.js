// Market Reactor — turns a coin's live on-chain tape into world behaviour.
//
// The /play world already streams real pump.fun trades onto the chart screen
// (chart-screen.js). On its own that data dead-ends on a panel. The reactor
// pipes the same feed into the *environment* so the arena physically responds
// to the market: every buy ripples green across the plaza and kicks the
// boundary ring, every sell ripples red, sustained volume spins the coin totem
// faster, the rolling % change drives the weather between storm and euphoria,
// and a whale-sized trade detonates a beam of light over the totem with a
// shower of coins. The coin's price becomes the room's pulse.
//
// All effects are pooled/capped and self-dispose, so a busy room stays cheap.
// The reactor owns one FX group it adds to the scene and tears down on dispose;
// the slow "weather" lives on the environment (env.setMood / env.flashRing).

import {
	Group, Mesh, MeshBasicMaterial,
	RingGeometry, CylinderGeometry,
	AdditiveBlending, DoubleSide,
} from 'three';

// Trade colours mirror the chart screen so the world and the panel speak the
// same visual language (up = green, down = red, the coin itself = gold).
const COL_BUY = 0x5fd08a;
const COL_SELL = 0xe06c75;
const COL_GOLD = 0xffce5c;

// A trade at/above this USD size is a "whale" — it earns the full spectacle
// (beam + shockwave + confetti) rather than just a ripple. Memecoin-scaled.
const WHALE_USD = 750;

// Caps so a frantic room can never accumulate unbounded meshes.
const MAX_RIPPLES = 16;
const MAX_CONFETTI = 80;

export class MarketReactor {
	/**
	 * @param {object}   o
	 * @param {THREE.Scene} o.scene     scene to mount the FX group into
	 * @param {object}   o.env          world environment (flashRing, setMood)
	 * @param {THREE.Object3D} [o.totem] the spinning coin group — gets a heat boost
	 * @param {[number,number,number]} [o.totemPos] world origin of the totem for FX
	 * @param {(trade:object)=>void} [o.onWhale] called when a whale trade lands
	 */
	constructor({ scene, env, totem = null, totemPos = [0, 0, -12], onWhale = null }) {
		this.scene = scene;
		this.env = env;
		this.totem = totem;
		this.origin = totemPos;
		this.onWhale = onWhale;

		this.fx = new Group();
		scene.add(this.fx);

		// Shared geometry — every ripple/shockwave reuses these; only per-effect
		// materials are cloned (so each can fade independently) and disposed.
		this._ringGeo = new RingGeometry(0.92, 1, 56);
		this._coinGeo = new CylinderGeometry(0.17, 0.17, 0.04, 14);
		this._beamGeo = new CylinderGeometry(2.4, 2.4, 1, 28, 1, true);

		this._ripples = [];   // { mesh, mat, age, life, maxScale, fade }
		this._confetti = [];  // { mesh, mat, vx, vy, vz, spin, age, life }
		this._beams = [];     // { mesh, mat, age, life, peak }

		this._heat = 0;       // 0..1 trade-velocity energy; decays each frame
	}

	// Feed a batch of freshly-landed trades + the chart's derived metrics. Drives
	// the immediate reactions (flash/ripple/whale) and the slow mood.
	ingestTrades(trades, metrics) {
		// Weather first: rolling % change → storm (−) … euphoria (+). ±35% maps to
		// the extremes, so an ordinary chart sits near neutral.
		const pct = metrics && typeof metrics.pct === 'number' ? metrics.pct : 0;
		this.env?.setMood?.(pct / 35);

		if (!Array.isArray(trades)) return;
		for (const tr of trades) {
			const usd = Number(tr.usd) || 0;
			const buy = tr.isBuy === true;
			const color = buy ? COL_BUY : COL_SELL;

			// Bigger trades hit harder — both the ring flash and the spent heat.
			const weight = usd > 0 ? Math.min(1, usd / 600) : 0.12;
			this.env?.flashRing?.(color, 0.18 + weight * 0.7);
			this._heat = Math.min(1, this._heat + 0.05 + weight * 0.4);

			if (usd >= WHALE_USD) {
				this._spawnWhale(buy);
				try { this.onWhale?.(tr); } catch { /* toast is non-critical */ }
			} else {
				this._spawnRipple(color, 0.45 + weight * 0.2, 22 + weight * 8);
			}
		}
	}

	// A flat ring that expands outward across the plaza from the totem and fades.
	_spawnRipple(color, fade, maxScale) {
		if (this._ripples.length >= MAX_RIPPLES) this._retire(this._ripples.shift());
		const mat = new MeshBasicMaterial({
			color, transparent: true, opacity: fade,
			side: DoubleSide, depthWrite: false,
		});
		const mesh = new Mesh(this._ringGeo, mat);
		mesh.rotation.x = -Math.PI / 2;
		mesh.position.set(this.origin[0], 0.05, this.origin[2]);
		mesh.scale.setScalar(1);
		this.fx.add(mesh);
		this._ripples.push({ mesh, mat, age: 0, life: 1.5, maxScale, fade });
	}

	// The whale spectacle: a column of light over the totem, a bright shockwave
	// at its base, and (on a buy) a burst of coins raining off the top.
	_spawnWhale(buy) {
		const color = buy ? COL_GOLD : COL_SELL;

		const beamMat = new MeshBasicMaterial({
			color, transparent: true, opacity: 0,
			side: DoubleSide, depthWrite: false, blending: AdditiveBlending,
		});
		const beam = new Mesh(this._beamGeo, beamMat);
		beam.scale.set(1, 46, 1);
		beam.position.set(this.origin[0], 23, this.origin[2]);
		this.fx.add(beam);
		this._beams.push({ mesh: beam, mat: beamMat, age: 0, life: 2.4, peak: 0.42 });

		this._spawnRipple(color, 0.7, 44); // hard, wide shockwave at the base

		if (buy) {
			const n = 22;
			for (let i = 0; i < n; i++) {
				if (this._confetti.length >= MAX_CONFETTI) break;
				const mat = new MeshBasicMaterial({ color: COL_GOLD, transparent: true, opacity: 1 });
				const mesh = new Mesh(this._coinGeo, mat);
				mesh.position.set(this.origin[0], 9.5, this.origin[2]);
				// A cone of upward velocity so coins fountain off the totem crown.
				const ang = (i / n) * Math.PI * 2;
				const spread = 2.2 + (i % 3) * 0.6;
				mesh.rotation.set(ang, ang * 1.3, 0);
				this.fx.add(mesh);
				this._confetti.push({
					mesh, mat,
					vx: Math.cos(ang) * spread,
					vy: 6.5 + (i % 5) * 0.7,
					vz: Math.sin(ang) * spread,
					spin: 6 + (i % 4) * 2,
					age: 0, life: 2.4,
				});
			}
		}
	}

	update(dt) {
		// Heat bleeds off; while it lasts it spins the totem above its idle drift.
		this._heat = Math.max(0, this._heat - dt * 0.4);
		if (this.totem && this._heat > 0) this.totem.rotation.y += dt * this._heat * 3.2;

		// Ripples: ease outward (fast then settling) and fade to nothing.
		for (let i = this._ripples.length - 1; i >= 0; i--) {
			const r = this._ripples[i];
			r.age += dt;
			const k = Math.min(1, r.age / r.life);
			const ease = 1 - (1 - k) * (1 - k); // ease-out
			r.mesh.scale.setScalar(1 + ease * r.maxScale);
			r.mat.opacity = r.fade * (1 - k);
			if (k >= 1) { this._retire(r); this._ripples.splice(i, 1); }
		}

		// Beams: fade in, hold, fade out over their life.
		for (let i = this._beams.length - 1; i >= 0; i--) {
			const b = this._beams[i];
			b.age += dt;
			const k = Math.min(1, b.age / b.life);
			const env = k < 0.12 ? k / 0.12 : (1 - (k - 0.12) / 0.88);
			b.mat.opacity = Math.max(0, env) * b.peak;
			if (k >= 1) { this._retire(b); this._beams.splice(i, 1); }
		}

		// Confetti: ballistic arc under gravity, spin, fade on the way down.
		for (let i = this._confetti.length - 1; i >= 0; i--) {
			const c = this._confetti[i];
			c.age += dt;
			c.vy -= 14 * dt;
			c.mesh.position.x += c.vx * dt;
			c.mesh.position.y += c.vy * dt;
			c.mesh.position.z += c.vz * dt;
			c.mesh.rotation.x += c.spin * dt;
			c.mesh.rotation.z += c.spin * 0.6 * dt;
			const k = Math.min(1, c.age / c.life);
			c.mat.opacity = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
			if (k >= 1 || c.mesh.position.y < 0.05) { this._retire(c); this._confetti.splice(i, 1); }
		}
	}

	// Pull one effect off the scene and free its cloned material.
	_retire(e) {
		if (!e) return;
		this.fx.remove(e.mesh);
		e.mat?.dispose?.();
	}

	dispose() {
		this.scene.remove(this.fx);
		for (const r of this._ripples) r.mat?.dispose?.();
		for (const c of this._confetti) c.mat?.dispose?.();
		for (const b of this._beams) b.mat?.dispose?.();
		this._ripples = []; this._confetti = []; this._beams = [];
		this._ringGeo.dispose();
		this._coinGeo.dispose();
		this._beamGeo.dispose();
		// Reset the weather so a reused environment doesn't inherit our mood.
		this.env?.setMood?.(0);
	}
}
