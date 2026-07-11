// Fortune's Folly — the Wheel of Fortune landmark for /play (W09/Task 19).
//
// A single fixed prop in the plaza (multiplayer/src/world-features.js WHEEL — the
// same coordinates the server validates proximity against, so the marker and the
// authoritative range check can never drift). Renders a simple, readable casino
// wheel silhouette, shows a contextual "E — Spin the Wheel" prompt as the player
// walks up, and lazy-imports the actual spin UI (src/game/spin-wheel-ui.js —
// pulls in @solana/web3.js for the paid path) only on the first interaction, so
// that weight never touches the initial /play bundle.

import {
	Group, Mesh, CylinderGeometry, ConeGeometry, RingGeometry, TorusGeometry,
	MeshStandardMaterial, MeshBasicMaterial, DoubleSide,
} from 'three';
import { WHEEL, wheelInRange } from '../../multiplayer/src/world-features.js';

function el(tag, props = {}) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'hidden') n.hidden = !!v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (v != null) n.setAttribute(k, v);
	}
	return n;
}

export class WheelStation {
	/**
	 * @param {object} opts
	 * @param {import('three').Scene} opts.scene
	 * @param {() => ({x,y,z})} opts.getPlayer  local avatar pose
	 * @param {object} opts.net   CommunityNet — handed straight to the spin UI
	 */
	constructor({ scene, getPlayer, net }) {
		this.scene = scene;
		this.getPlayer = getPlayer;
		this.net = net;
		this._t = 0;
		this._near = false;
		this._wheel = null; // the open SpinWheel controller, or null

		this._buildScene();
		this._buildPrompt();
	}

	_buildScene() {
		const spot = WHEEL[0];
		const g = new Group();
		g.position.set(spot.x, 0, spot.z);

		// A short plinth the wheel stands on.
		const base = new Mesh(
			new CylinderGeometry(spot.r * 0.85, spot.r, 0.5, 16),
			new MeshStandardMaterial({ color: 0x3a2a10, roughness: 0.85 }),
		);
		base.position.y = 0.25;
		base.castShadow = true;
		g.add(base);

		// The wheel face itself — a flat gold disc with alternating dark wedge
		// spokes, canted slightly toward the plaza so it reads from a distance.
		const face = new Mesh(
			new CylinderGeometry(spot.r * 0.8, spot.r * 0.8, 0.12, 20),
			new MeshStandardMaterial({ color: 0xf5c542, roughness: 0.4, metalness: 0.3 }),
		);
		face.rotation.x = Math.PI / 2;
		face.position.y = 1.7;
		face.castShadow = true;
		g.add(face);
		for (let i = 0; i < 20; i += 2) {
			const a = (i / 20) * Math.PI * 2;
			const wedge = new Mesh(
				new CylinderGeometry(spot.r * 0.8, spot.r * 0.8, 0.13, 20, 1, false, a, (Math.PI * 2) / 20),
				new MeshStandardMaterial({ color: 0x2b2f38, roughness: 0.5 }),
			);
			wedge.rotation.x = Math.PI / 2;
			wedge.position.y = 1.7;
			g.add(wedge);
		}
		const rim = new Mesh(
			new TorusGeometry(spot.r * 0.8, 0.06, 8, 24),
			new MeshStandardMaterial({ color: 0xffd76a, roughness: 0.3, metalness: 0.6 }),
		);
		rim.rotation.x = Math.PI / 2;
		rim.position.y = 1.7;
		g.add(rim);

		// A pointer flag on top so "which way is up" reads even while idle.
		const pointer = new Mesh(
			new ConeGeometry(0.14, 0.4, 4),
			new MeshBasicMaterial({ color: 0xff4d4d }),
		);
		pointer.position.set(0, 2.2, spot.r * 0.8);
		pointer.rotation.x = Math.PI;
		g.add(pointer);

		this._marker = new Mesh(
			new RingGeometry(spot.r + 0.4, spot.r + 0.6, 32),
			new MeshBasicMaterial({ color: 0xffc857, transparent: true, opacity: 0.18, side: DoubleSide }),
		);
		this._marker.rotation.x = -Math.PI / 2;
		this._marker.position.y = 0.04;
		g.add(this._marker);

		this.scene.add(g);
		this._group = g;
		this._face = face;
	}

	_buildPrompt() {
		this.btn = el('button', { class: 'ps-action wh-action', hidden: true, text: '🎡 Spin the Wheel', onclick: () => this.interact() });
		document.body.appendChild(this.btn);
	}

	tick(dt) {
		this._t += dt;
		this._face.rotation.z = this._t * 0.15; // a slow idle spin, purely decorative
		const p = this.getPlayer?.();
		const near = !!(p && wheelInRange(p.x, p.z));
		if (near !== this._near) {
			this._near = near;
			this.btn.hidden = !near || !!this._wheel;
		}
		const glow = 0.14 + Math.sin(this._t * 1.6) * 0.06;
		this._marker.material.opacity = near ? glow + 0.22 : glow;
	}

	// Public: act if in range. SYNCHRONOUS — the E-key chain in coincommunities.js
	// calls every system's interact() as `!a.interact() && !b.interact() && …`
	// to find whichever one consumed the press; a Promise is always truthy, so
	// an async return here would silently short-circuit that chain regardless of
	// whether the player was actually in range. The real lazy-import + open work
	// happens in the fire-and-forget helper below; this returns the in-range
	// verdict immediately, exactly like vehicles.interact() already does.
	interact() {
		if (!this._near) return false;
		if (!this._wheel) this._open();
		return true;
	}

	async _open() {
		this.btn.hidden = true;
		const { openSpinWheel } = await import('./spin-wheel-ui.js');
		this._wheel = openSpinWheel({ net: this.net, onClose: () => { this._wheel = null; this.btn.hidden = !this._near; } });
	}

	dispose() {
		this._wheel?.close?.();
		this._wheel = null;
		if (this._group) {
			this.scene.remove(this._group);
			this._group.traverse((n) => {
				if (n.isMesh) { n.geometry?.dispose?.(); const ms = Array.isArray(n.material) ? n.material : [n.material]; ms.forEach((m) => m?.dispose?.()); }
			});
			this._group = null;
		}
		this.btn?.remove();
	}
}
