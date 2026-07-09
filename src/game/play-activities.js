// Play activities — the gather→craft layer for the /play coin worlds (W06).
//
// The chop/mine/cook counterpart to PlaySystems' fishing: it renders the world's
// gather/craft/pickup stations (a grove of trees, a quarry of rocks, two roast pits,
// and a few spare fishing rods leaning on the bank for anyone to grab), gates a
// single contextual action prompt as the player walks up to one, plays the local
// 3D feedback (chips, shards, embers, a flaring fire, a rod wobble), and sends the
// intent. Every
// yield, XP gain and level-up is rolled SERVER-side (WalkRoom → activities.js) and
// streamed back over the same profile/inv/xpgain/levelup/notice events PlaySystems
// already renders into the HUD — so this module never simulates a result locally.
//
// It is deliberately self-contained and instantiated as a SIBLING of PlaySystems
// from coincommunities.js (not nested inside it): it owns only its own scene group,
// one prompt button, and a lightweight mirror of the parts of the profile it needs
// (hotbar/activeSlot/inv) which it keeps current straight from the net events. That
// keeps it decoupled — fishing and gathering never fight over one file or one button
// (their stations sit in different corners of the map, so at most one is ever in
// range), and either can evolve without touching the other.

import {
	Group, Mesh, Vector3,
	RingGeometry, CylinderGeometry, ConeGeometry, BoxGeometry, IcosahedronGeometry, SphereGeometry,
	MeshStandardMaterial, MeshBasicMaterial, DoubleSide,
} from 'three';

import {
	TREES, nearestTree, ROCKS, nearestRock, FIREPITS, nearestFirepit,
	ROD_PICKUPS, nearestRodPickup,
} from '../../multiplayer/src/world-features.js';
import { itemDisplay } from './items.js';

// The four gather/craft/pickup activities. Each knows the tool the player must hold
// (null for cooking and the rod pickup — no tool gates either), the nearest-node
// finder (shared with the server so the range rule never drifts), and how the
// prompt + 3D feedback read.
const ACTIVITIES = [
	{ type: 'chop', tool: 'axe', skill: 'woodcutting', near: nearestTree, label: 'Chop', glyph: '🪓', noTool: 'Equip an axe', fx: 0x8a5a32 },
	{ type: 'mine', tool: 'pickaxe', skill: 'mining', near: nearestRock, label: 'Mine', glyph: '⛏️', noTool: 'Equip a pickaxe', fx: 0xb8c0cc },
	{ type: 'cook', tool: null, skill: 'cooking', near: nearestFirepit, label: 'Cook fish', glyph: '🍳', noTool: '', fx: 0xffa53a },
	{ type: 'pickupRod', tool: null, skill: null, near: nearestRodPickup, label: 'Pick up rod', glyph: '🎣', noTool: '', fx: 0xbfeaff },
];

function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'hidden') n.hidden = !!v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (v != null) n.setAttribute(k, v);
	}
	for (const c of [].concat(kids)) if (c) n.appendChild(c);
	return n;
}

export class PlayActivities {
	/**
	 * @param {object} opts
	 * @param {import('three').Scene} opts.scene
	 * @param {() => ({x,y,z,yaw,height})} opts.getPlayer  local avatar pose
	 * @param {object} opts.net   CommunityNet (chop/mine/cook/equip + profile/inv/notice events)
	 * @param {object} opts.ui    CommunityUI (toast)
	 */
	constructor({ scene, getPlayer, net, ui }) {
		this.scene = scene;
		this.getPlayer = getPlayer;
		this.net = net;
		this.ui = ui;

		// Lightweight mirror of the parts of the server profile this module needs,
		// kept current from the same net events PlaySystems renders into the HUD.
		this._hotbar = [];
		this._activeSlot = -1;
		this._inv = [];

		this._t = 0;
		this._near = null;       // nearest in-range activity { def, node, gap } or null
		this._fx = [];           // live one-shot particle bursts
		this._stations = [];     // { type, id, group, marker, anchor, hitNode?, baseY?, flame? }

		this._buildScene();
		this._buildPrompt();

		// Subscribe to the economy stream. net.on returns an unsubscribe; collect them
		// so dispose() leaves no dangling handlers when the player switches coins.
		this._offs = [];
		if (net?.on) {
			this._offs.push(net.on('profile', (snap) => this._onProfile(snap)));
			this._offs.push(net.on('inv', (delta) => this._onInv(delta)));
			this._offs.push(net.on('notice', (n) => this._onNotice(n)));
		}
	}

	// ---------------------------------------------------------------- profile mirror
	_onProfile(snap) {
		if (!snap || typeof snap !== 'object') return;
		this._hotbar = Array.isArray(snap.hotbar) ? snap.hotbar : [];
		this._activeSlot = Number.isFinite(snap.activeSlot) ? snap.activeSlot : -1;
		this._inv = Array.isArray(snap.inv) ? snap.inv : [];
	}
	_onInv(delta) {
		if (!delta) return;
		if (Array.isArray(delta.hotbar)) this._hotbar = delta.hotbar;
		if (Number.isFinite(delta.activeSlot)) this._activeSlot = delta.activeSlot;
		if (Array.isArray(delta.inv)) this._inv = delta.inv;
	}
	// A gather/cook success rolls back as a notice carrying the activity kind — spawn
	// the authoritative yield burst (failures already showed a small swing burst).
	_onNotice(n) {
		if (!n) return;
		const def = ACTIVITIES.find((a) => a.type === n.kind);
		if (!def) return;
		const got = n.got != null ? n.got : n.cooked;
		if (!got) return; // miss/burn — the swing feedback already played
		const node = n.node ? this._nodeById(n.node) : null;
		const anchor = node || this._near?.node;
		if (anchor) this._spawnFx(anchor, def.fx, 7, 1.1);
		if (def.type === 'cook') { const st = this._stationById(n.node) || this._stations.find((s) => s.type === 'cook'); if (st) st._flare = 0.7; }
	}

	_activeItem() {
		const i = this._activeSlot;
		return i >= 0 && this._hotbar[i] ? this._hotbar[i].item : '';
	}

	// ---------------------------------------------------------------- scene
	_buildScene() {
		const group = new Group();
		group.name = 'play-activities';
		for (const t of TREES) group.add(this._buildTree(t));
		for (const r of ROCKS) group.add(this._buildRock(r));
		for (const f of FIREPITS) group.add(this._buildFirepit(f));
		for (const p of ROD_PICKUPS) group.add(this._buildRodPickup(p));
		this.scene.add(group);
		this._group = group;
	}

	_marker(radius, color) {
		const m = new Mesh(
			new RingGeometry(radius, radius + 0.18, 32),
			new MeshBasicMaterial({ color, transparent: true, opacity: 0.0, side: DoubleSide }),
		);
		m.rotation.x = -Math.PI / 2;
		m.position.y = 0.05;
		return m;
	}

	_buildTree(node) {
		const g = new Group();
		g.position.set(node.x, 0, node.z);
		const h = 2.6 + (node.difficulty - 1) * 0.8;
		const trunk = new Mesh(new CylinderGeometry(0.18, 0.28, h * 0.55, 7), new MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.95 }));
		trunk.position.y = h * 0.275; trunk.castShadow = true; g.add(trunk);
		const leafMat = new MeshStandardMaterial({ color: 0x2f6d3a, roughness: 0.9 });
		const lower = new Mesh(new ConeGeometry(1.15, h * 0.55, 8), leafMat); lower.position.y = h * 0.62; lower.castShadow = true; g.add(lower);
		const upper = new Mesh(new ConeGeometry(0.8, h * 0.42, 8), leafMat); upper.position.y = h * 0.92; upper.castShadow = true; g.add(upper);
		const marker = this._marker(node.r + 0.5, 0x9be8a6); g.add(marker);
		this._stations.push({ type: 'chop', id: node.id, marker, anchor: { x: node.x, z: node.z }, hitNode: trunk, baseY: trunk.position.y });
		return g;
	}

	_buildRock(node) {
		const g = new Group();
		g.position.set(node.x, 0, node.z);
		const stoneMat = new MeshStandardMaterial({ color: 0x7c8492, roughness: 1, flatShading: true });
		const coalMat = new MeshStandardMaterial({ color: 0x2b2f38, roughness: 1, flatShading: true });
		const main = new Mesh(new IcosahedronGeometry(node.r * 0.9, 0), stoneMat); main.position.y = node.r * 0.6; main.scale.y = 0.8; main.castShadow = true; g.add(main);
		const lump = new Mesh(new IcosahedronGeometry(node.r * 0.5, 0), stoneMat); lump.position.set(node.r * 0.7, node.r * 0.35, -node.r * 0.4); lump.castShadow = true; g.add(lump);
		const vein = new Mesh(new IcosahedronGeometry(node.r * 0.34, 0), coalMat); vein.position.set(-node.r * 0.4, node.r * 0.5, node.r * 0.45); g.add(vein);
		const marker = this._marker(node.r + 0.6, 0xc8d0dc); g.add(marker);
		this._stations.push({ type: 'mine', id: node.id, marker, anchor: { x: node.x, z: node.z }, hitNode: main, baseY: main.position.y });
		return g;
	}

	_buildFirepit(node) {
		const g = new Group();
		g.position.set(node.x, 0, node.z);
		const stoneMat = new MeshStandardMaterial({ color: 0x6a6f78, roughness: 1, flatShading: true });
		for (let i = 0; i < 8; i++) {
			const a = (i / 8) * Math.PI * 2;
			const s = new Mesh(new IcosahedronGeometry(0.16, 0), stoneMat);
			s.position.set(Math.cos(a) * node.r * 0.7, 0.12, Math.sin(a) * node.r * 0.7); g.add(s);
		}
		const logMat = new MeshStandardMaterial({ color: 0x5a3d22, roughness: 0.95 });
		for (let i = 0; i < 3; i++) {
			const log = new Mesh(new CylinderGeometry(0.08, 0.08, node.r * 1.1, 6), logMat);
			log.rotation.z = Math.PI / 2; log.rotation.y = (i / 3) * Math.PI; log.position.y = 0.12; g.add(log);
		}
		const flame = new Mesh(new ConeGeometry(0.28, 0.8, 8), new MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.85 }));
		flame.position.y = 0.55; g.add(flame);
		const marker = this._marker(node.r + 0.5, 0xffc890); g.add(marker);
		this._stations.push({ type: 'cook', id: node.id, marker, anchor: { x: node.x, z: node.z }, flame });
		return g;
	}

	// A spare rod leaning against a bank post — a stubby post, the rod resting at
	// an angle with a small reel at its base, and a line running down to a bobber
	// so the silhouette reads as "fishing rod" even from across the bank.
	_buildRodPickup(node) {
		const g = new Group();
		g.position.set(node.x, 0, node.z);

		const woodMat = new MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.9 });
		const post = new Mesh(new CylinderGeometry(0.07, 0.09, 0.85, 8), woodMat);
		post.position.y = 0.42; post.castShadow = true; g.add(post);

		// The rod sits in its own pivot at rotation.z = 0 so the shared hit-shake
		// path (which resets hitNode.rotation.z to 0 on decay) wobbles it without
		// ever losing its resting lean — that lean lives on the child mesh instead.
		const rodPivot = new Group();
		rodPivot.position.set(0.08, 0.75, 0);
		g.add(rodPivot);
		const rodMat = new MeshStandardMaterial({ color: 0x8a5a32, roughness: 0.7 });
		const rod = new Mesh(new CylinderGeometry(0.014, 0.032, 1.5, 6), rodMat);
		rod.rotation.z = Math.PI * 0.16;
		rod.castShadow = true;
		rodPivot.add(rod);

		const reel = new Mesh(new SphereGeometry(0.07, 10, 8), new MeshStandardMaterial({ color: 0x2b2f38, roughness: 0.5, metalness: 0.4 }));
		reel.position.set(-0.08, 0.36, 0);
		g.add(reel);

		const line = new Mesh(new CylinderGeometry(0.006, 0.006, 0.62, 4), new MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.4 }));
		line.position.set(0.5, 0.68, 0);
		line.rotation.z = Math.PI * 0.02;
		g.add(line);

		const bobber = new Mesh(new SphereGeometry(0.06, 10, 8), new MeshStandardMaterial({ color: 0xff4d4d, roughness: 0.5 }));
		bobber.position.set(0.52, 0.37, 0);
		g.add(bobber);

		const marker = this._marker(node.r + 0.5, 0xbfeaff); g.add(marker);
		// hitNode gives the pickup the same little wobble chop/mine play on a hit
		// (tick()'s shared shake path — any non-'mine' station rotates on its Z).
		this._stations.push({ type: 'pickupRod', id: node.id, marker, anchor: { x: node.x, z: node.z }, hitNode: rodPivot, baseY: rodPivot.position.y });
		return g;
	}

	_stationById(id) { return this._stations.find((s) => s.id === id) || null; }
	_nodeById(id) {
		return TREES.find((n) => n.id === id) || ROCKS.find((n) => n.id === id) || FIREPITS.find((n) => n.id === id)
			|| ROD_PICKUPS.find((n) => n.id === id) || null;
	}

	// ---------------------------------------------------------------- prompt DOM
	_buildPrompt() {
		// Reuse PlaySystems' .ps-action styling so the gather prompt is visually
		// identical to the Cast button (they're never on screen at the same time).
		this.btn = el('button', { class: 'ps-action pa-action', hidden: true, onclick: () => this.doAction() });
		document.body.appendChild(this.btn);
	}

	// ---------------------------------------------------------------- per-frame
	tick(dt) {
		this._t += dt;
		const p = this.getPlayer?.();
		if (!p) return;

		// Nearest in-range activity (mirrors each server *InRange check).
		let near = null;
		for (const def of ACTIVITIES) {
			const n = def.near(p.x, p.z);
			if (n && n.gap <= 0 && (!near || n.gap < near.gap)) near = { def, node: n.node, gap: n.gap };
		}
		this._near = near;
		this._updatePrompt();

		// Pulse markers (the in-range one brightest), flicker flames, decay hit shakes.
		const activeId = near?.node.id;
		const glow = 0.16 + Math.sin(this._t * 2) * 0.10;
		for (const st of this._stations) {
			if (st.marker) st.marker.material.opacity = st.id === activeId ? glow + 0.28 : glow;
			if (st.flame) {
				const flicker = 1 + Math.sin(this._t * 9 + st.anchor.x) * 0.12 + (st._flare || 0);
				st.flame.scale.set(1, flicker, 1);
				if (st._flare) st._flare = Math.max(0, st._flare - dt * 1.6);
			}
			if (st._shake && st.hitNode) {
				if (st.type === 'mine') st.hitNode.position.y = st.baseY - 0.12 * st._shake * Math.abs(Math.sin(this._t * 28));
				else st.hitNode.rotation.z = Math.sin(this._t * 40) * 0.08 * st._shake;
				st._shake = Math.max(0, st._shake - dt * 3.5);
				if (st._shake === 0) { st.hitNode.rotation.z = 0; if (st.type === 'mine') st.hitNode.position.y = st.baseY; }
			}
		}

		this._tickFx(dt);
	}

	_updatePrompt() {
		const near = this._near;
		if (!near) { if (!this.btn.hidden) this.btn.hidden = true; return; }
		const def = near.def;
		const holding = this._activeItem();
		let label, disabled = false;
		if (def.tool) {
			const hasTool = this._hotbar.some((s) => s.item === def.tool);
			label = holding === def.tool ? `${def.glyph} ${def.label}` : hasTool ? `${def.glyph} Equip ${itemDisplay(def.tool).name.toLowerCase()}` : `${def.glyph} ${def.noTool}`;
			disabled = !hasTool;
		} else if (def.type === 'cook') {
			const hasFish = this._inv.some((s) => s.item === 'fish');
			label = `${def.glyph} ${def.label}`;
			disabled = !hasFish;
		} else {
			// pickupRod: a free prop with no precondition beyond being in range.
			label = `${def.glyph} ${def.label}`;
			disabled = false;
		}
		this.btn.textContent = label;
		this.btn.classList.toggle('is-disabled', disabled);
		this.btn.hidden = false;
	}

	// Public: act on the nearest station. Returns true if a station was in range (so
	// the F-key handler knows whether to fall through to fishing). Mirrors the server's
	// preconditions for instant, honest feedback: auto-equip the tool the player owns
	// but isn't holding, surface a missing tool/fish, else play feedback + send.
	doAction() {
		const near = this._near;
		if (!near) return false;
		const def = near.def;
		if (def.tool) {
			const holding = this._activeItem();
			if (holding !== def.tool) {
				const slot = this._hotbar.findIndex((s) => s.item === def.tool);
				if (slot >= 0) {
					this.net?.equip(slot);
					this._activeSlot = slot; // optimistic; server echoes inv
					this.ui?.toast?.(`${itemDisplay(def.tool).name} equipped — ${def.label.toLowerCase()} again.`, 'info');
					return true;
				}
				this.ui?.toast?.(`${def.noTool} to ${def.label.toLowerCase()}.`, 'warn');
				return true;
			}
		} else if (def.type === 'cook') {
			if (!this._inv.some((s) => s.item === 'fish')) { this.ui?.toast?.('You have no raw fish to cook.', 'warn'); return true; }
		}
		this._hit(def, near.node);
		this.net?.[def.type]?.();
		return true;
	}

	// ---------------------------------------------------------------- 3D feedback
	_hit(def, node) {
		const st = this._stationById(node.id);
		if (st) { if (def.type === 'cook') st._flare = 0.6; else st._shake = 1; }
		this._spawnFx(node, def.fx, def.type === 'cook' ? 3 : 4, 0.7);
	}

	_spawnFx(node, color, count = 6, speed = 1) {
		const g = new Group();
		g.position.set(node.x, 0.9, node.z);
		const mat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
		const bits = [];
		for (let i = 0; i < count; i++) {
			const b = new Mesh(new BoxGeometry(0.09, 0.09, 0.09), mat);
			const a = Math.random() * Math.PI * 2;
			const sp = (0.9 + Math.random() * 1.1) * speed;
			b.userData.v = { x: Math.cos(a) * sp, y: 1.8 + Math.random() * 1.4, z: Math.sin(a) * sp };
			b.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
			g.add(b); bits.push(b);
		}
		this.scene.add(g);
		this._fx.push({ group: g, mat, bits, age: 0, ttl: 0.7 });
	}

	_tickFx(dt) {
		if (!this._fx.length) return;
		for (let i = this._fx.length - 1; i >= 0; i--) {
			const fx = this._fx[i];
			fx.age += dt;
			for (const b of fx.bits) {
				const v = b.userData.v;
				v.y -= 9.8 * dt;
				b.position.x += v.x * dt;
				b.position.y = Math.max(0, b.position.y + v.y * dt);
				b.position.z += v.z * dt;
				b.rotation.x += dt * 6; b.rotation.y += dt * 5;
			}
			fx.mat.opacity = Math.max(0, 0.95 * (1 - fx.age / fx.ttl));
			if (fx.age >= fx.ttl) {
				this.scene.remove(fx.group);
				fx.group.traverse((n) => { if (n.isMesh) n.geometry?.dispose?.(); });
				fx.mat.dispose();
				this._fx.splice(i, 1);
			}
		}
	}

	// ---------------------------------------------------------------- teardown
	dispose() {
		for (const off of this._offs || []) { try { off(); } catch {} }
		this._offs = [];
		for (const fx of this._fx) {
			this.scene.remove(fx.group);
			fx.group.traverse((n) => { if (n.isMesh) n.geometry?.dispose?.(); });
			fx.mat.dispose();
		}
		this._fx = [];
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
