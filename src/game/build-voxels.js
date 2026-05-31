// Collaborative voxel building for Coin Communities — the Minecraft layer.
//
// Every /play world is a shared, persistent place; this module lets the people
// in it BUILD that place. Players place and break 1.5m blocks on a grid; the
// server (WalkRoom) is authoritative and persists the result per coin, so a
// community's creation is there when they come back and there for everyone who
// drops in. Two coins never share a build — it rides on the same per-mint room
// isolation the avatars and chat already use.
//
// This file owns three things, kept deliberately separate from the scene:
//   1. The block palette (BLOCK_TYPES) + grid maths, shared with the server's
//      validation (the caps here MUST mirror WalkRoom's).
//   2. VoxelWorld — instanced rendering of the whole build (one InstancedMesh
//      per block type so a few thousand blocks stay a handful of draw calls),
//      plus raycasting (what cell is the player aiming at?) and a ghost cursor.
//   3. createBuildHud — the self-contained build HUD (hotbar, mode toggle), so
//      the build UI never has to thread through the rest of the chrome.

import {
	Object3D, Vector3, Color, BoxGeometry, EdgesGeometry,
	InstancedMesh, LineSegments, LineBasicMaterial, Mesh,
	MeshStandardMaterial, MeshBasicMaterial, DynamicDrawUsage, Group,
} from 'three';

// Metres per grid cell. Sized so a stack of three reads as "wall height" next to
// a ~1.7m avatar — substantial to build with, without thousands of tiny cubes.
export const BLOCK = 1.5;
// Build bounds — a circular area on the plaza and a height ceiling, in cells.
// These mirror WalkRoom's MAX_GRID_XZ / MAX_GRID_Y exactly; the server rejects
// anything outside them, so keeping them in sync keeps the client honest.
export const MAX_GRID_XZ = 30;
export const MAX_GRID_Y = 24;
export const MAX_BLOCKS = 6000;

// The palette. Index === the wire type the server validates against, so order is
// load-bearing — never reorder, only append (and bump BLOCK_TYPE_COUNT server
// side). `swatch` is the hotbar colour; `emissive`/`opacity`/`metalness` tune the
// in-world material so gold glints, neon glows, and glass reads as glass.
export const BLOCK_TYPES = [
	{ name: 'Stone', color: 0x9aa0a8, swatch: '#9aa0a8', roughness: 0.95 },
	{ name: 'Grass', color: 0x5cb24f, swatch: '#5cb24f', roughness: 1 },
	{ name: 'Dirt', color: 0x8a5a36, swatch: '#8a5a36', roughness: 1 },
	{ name: 'Wood', color: 0xb07f43, swatch: '#b07f43', roughness: 0.85 },
	{ name: 'Brick', color: 0xb5483a, swatch: '#b5483a', roughness: 0.9 },
	{ name: 'Snow', color: 0xeef3f8, swatch: '#eef3f8', roughness: 0.8 },
	{ name: 'Glass', color: 0xbfe6ff, swatch: '#bfe6ff', roughness: 0.1, opacity: 0.4, metalness: 0.1 },
	{ name: 'Obsidian', color: 0x15171d, swatch: '#15171d', roughness: 0.4, metalness: 0.3 },
	{ name: 'Gold', color: 0xffce5c, swatch: '#ffce5c', roughness: 0.3, metalness: 0.7, emissive: 0x3a2e00, emissiveIntensity: 0.35 },
	{ name: 'Neon', color: 0x2af0e0, swatch: '#2af0e0', roughness: 0.3, emissive: 0x2af0e0, emissiveIntensity: 0.85 },
];
export const BLOCK_TYPE_COUNT = BLOCK_TYPES.length;

const _dummy = new Object3D();

export function keyOf(gx, gy, gz) { return `${gx},${gy},${gz}`; }
export function parseKey(key) { const p = key.split(','); return [+p[0], +p[1], +p[2]]; }

// Centre of a grid cell in world space. y is offset by half a block so gy=0 sits
// flush on the ground plane (its base at y=0, top at y=BLOCK).
export function cellToWorld(gx, gy, gz, target = new Vector3()) {
	return target.set(gx * BLOCK, gy * BLOCK + BLOCK / 2, gz * BLOCK);
}

// Is a cell inside the legal build volume? Mirrors the server's _cellKey checks.
export function cellInBounds(gx, gy, gz) {
	if (!Number.isInteger(gx) || !Number.isInteger(gy) || !Number.isInteger(gz)) return false;
	if (gy < 0 || gy >= MAX_GRID_Y) return false;
	return Math.hypot(gx, gz) <= MAX_GRID_XZ;
}

function makeMaterial(def) {
	const opts = {
		color: def.color,
		roughness: def.roughness ?? 0.9,
		metalness: def.metalness ?? 0,
	};
	if (def.emissive !== undefined) { opts.emissive = def.emissive; opts.emissiveIntensity = def.emissiveIntensity ?? 0.4; }
	if (def.opacity !== undefined) { opts.transparent = true; opts.opacity = def.opacity; }
	return new MeshStandardMaterial(opts);
}

// One InstancedMesh per block type, grown in powers of two as the build expands.
// Instance index ↔ key is kept in `keys[]`; removal swap-pops the last instance
// into the freed slot and reports the moved key so the owner can fix its index.
class TypeBatch {
	constructor(scene, geometry, material, type) {
		this.scene = scene;
		this.geometry = geometry;
		this.material = material;
		this.type = type;
		this.keys = [];
		this.capacity = 0;
		this.mesh = null;
	}

	_alloc(cap) {
		const m = new InstancedMesh(this.geometry, this.material, cap);
		m.castShadow = true;
		m.receiveShadow = true;
		m.frustumCulled = false; // a build can sprawl past the avatar-fit bounds
		m.instanceMatrix.setUsage(DynamicDrawUsage);
		m.userData.voxelType = this.type; // raycast hit → which palette batch
		m.count = this.keys.length;
		return m;
	}

	_ensure(n) {
		if (this.mesh && n <= this.capacity) return;
		const cap = Math.max(64, 1 << Math.ceil(Math.log2(Math.max(1, n))));
		const next = this._alloc(cap);
		this.capacity = cap;
		if (this.mesh) { this.scene.remove(this.mesh); this.mesh.dispose(); }
		this.mesh = next;
		this.scene.add(this.mesh);
		this._writeAll();
	}

	_writeOne(i) {
		const [gx, gy, gz] = parseKey(this.keys[i]);
		cellToWorld(gx, gy, gz, _dummy.position);
		_dummy.rotation.set(0, 0, 0);
		_dummy.scale.setScalar(1);
		_dummy.updateMatrix();
		this.mesh.setMatrixAt(i, _dummy.matrix);
	}

	_writeAll() {
		for (let i = 0; i < this.keys.length; i++) this._writeOne(i);
		this.mesh.count = this.keys.length;
		this.mesh.instanceMatrix.needsUpdate = true;
	}

	add(key) {
		const i = this.keys.length;
		this.keys.push(key);
		this._ensure(this.keys.length); // may rewrite all; cheap at human pace
		this._writeOne(i);
		this.mesh.count = this.keys.length;
		this.mesh.instanceMatrix.needsUpdate = true;
		return i;
	}

	// Remove instance i. Returns the key swapped into slot i (or null if i was
	// last), so the VoxelWorld index can be repaired in O(1).
	removeAt(i) {
		const last = this.keys.length - 1;
		let moved = null;
		if (i !== last) {
			this.keys[i] = this.keys[last];
			this._writeOne(i);
			moved = this.keys[i];
		}
		this.keys.pop();
		this.mesh.count = this.keys.length;
		this.mesh.instanceMatrix.needsUpdate = true;
		return moved;
	}

	dispose() {
		if (this.mesh) { this.scene.remove(this.mesh); this.mesh.dispose(); this.mesh = null; }
		this.material.dispose();
	}
}

export class VoxelWorld {
	constructor(scene) {
		this.scene = scene;
		this.geometry = new BoxGeometry(BLOCK, BLOCK, BLOCK);
		this.batches = BLOCK_TYPES.map((def, i) => new TypeBatch(scene, this.geometry, makeMaterial(def), i));
		this.index = new Map(); // key → { type, i }
		this._meshes = []; // refreshed lazily for raycasting
		this._buildGhost();
	}

	get count() { return this.index.size; }

	hasBlock(key) { return this.index.has(key); }

	// Palette type at a cell, or -1 if empty. Lets a break record what it removed
	// so undo can restore the exact block.
	typeAt(gx, gy, gz) { const e = this.index.get(keyOf(gx, gy, gz)); return e ? e.type : -1; }

	// Add or repaint a block. Idempotent for an unchanged (key,type).
	setBlock(gx, gy, gz, type) {
		if (type < 0 || type >= this.batches.length) return;
		const key = keyOf(gx, gy, gz);
		const cur = this.index.get(key);
		if (cur) {
			if (cur.type === type) return;
			this._removeKey(key); // repaint = remove from old batch, add to new
		}
		const i = this.batches[type].add(key);
		this.index.set(key, { type, i });
	}

	removeBlock(gx, gy, gz) { this._removeKey(keyOf(gx, gy, gz)); }

	_removeKey(key) {
		const entry = this.index.get(key);
		if (!entry) return;
		const moved = this.batches[entry.type].removeAt(entry.i);
		this.index.delete(key);
		// The swap-popped block now lives at the freed slot — fix its stored index.
		if (moved) {
			const m = this.index.get(moved);
			if (m) m.i = entry.i;
		}
	}

	clear() {
		for (const b of this.batches) { while (b.keys.length) b.removeAt(b.keys.length - 1); }
		this.index.clear();
	}

	// What cell is the camera ray aiming at? Returns the hit block's cell (for
	// breaking), the adjacent empty cell along the hit face (for placing), and
	// whether that placement cell is in bounds. Falls back to the ground plane so
	// the very first block has somewhere to land.
	raycast(raycaster) {
		this._meshes.length = 0;
		for (const b of this.batches) if (b.mesh && b.mesh.count > 0) this._meshes.push(b.mesh);
		const hits = raycaster.intersectObjects(this._meshes, false);
		const blockHit = hits.find((h) => h.instanceId != null);

		// Ground-plane (y=0) intersection, computed analytically so we don't need a
		// raycastable floor object competing with the real plaza mesh.
		const ground = this._groundCell(raycaster);

		if (blockHit && (!ground || blockHit.distance <= ground.distance)) {
			const batch = this.batches[blockHit.object.userData.voxelType];
			const key = batch?.keys[blockHit.instanceId];
			if (key) {
				const [gx, gy, gz] = parseKey(key);
				const n = blockHit.face?.normal || { x: 0, y: 1, z: 0 };
				const place = [gx + Math.round(n.x), gy + Math.round(n.y), gz + Math.round(n.z)];
				return {
					hit: 'block',
					cell: [gx, gy, gz],
					placeCell: place,
					placeValid: cellInBounds(place[0], place[1], place[2]) && !this.index.has(keyOf(...place)),
				};
			}
		}
		if (ground) {
			return {
				hit: 'ground',
				cell: null,
				placeCell: ground.cell,
				placeValid: cellInBounds(...ground.cell) && !this.index.has(keyOf(...ground.cell)),
			};
		}
		return null;
	}

	_groundCell(raycaster) {
		const { origin, direction } = raycaster.ray;
		if (direction.y >= -1e-4) return null; // looking up / parallel — no floor hit
		const t = -origin.y / direction.y;
		if (t <= 0) return null;
		const px = origin.x + direction.x * t;
		const pz = origin.z + direction.z * t;
		const gx = Math.round(px / BLOCK);
		const gz = Math.round(pz / BLOCK);
		return { cell: [gx, 0, gz], distance: t * direction.length() };
	}

	// --- Ghost cursor ------------------------------------------------------
	_buildGhost() {
		const g = new Group();
		g.visible = false;
		// Slightly inflated so the wireframe rides just outside whatever it marks.
		const box = new BoxGeometry(BLOCK * 1.02, BLOCK * 1.02, BLOCK * 1.02);
		this._ghostFill = new Mesh(box, new MeshBasicMaterial({ transparent: true, opacity: 0.16, depthWrite: false }));
		this._ghostEdges = new LineSegments(new EdgesGeometry(box), new LineBasicMaterial({ transparent: true, opacity: 0.9 }));
		g.add(this._ghostFill, this._ghostEdges);
		this.scene.add(g);
		this._ghost = g;
		this._ghostColor = new Color();
	}

	// Show the cursor at a cell, tinted by intent: green = will place, red = will
	// break, amber = blocked (out of bounds / occupied).
	showGhost(cell, kind) {
		if (!cell) { this.hideGhost(); return; }
		cellToWorld(cell[0], cell[1], cell[2], this._ghost.position);
		const hex = kind === 'remove' ? 0xff5a5a : kind === 'blocked' ? 0xffb648 : 0x66ff8c;
		this._ghostColor.setHex(hex);
		this._ghostFill.material.color.copy(this._ghostColor);
		this._ghostEdges.material.color.copy(this._ghostColor);
		this._ghost.visible = true;
	}

	hideGhost() { if (this._ghost) this._ghost.visible = false; }

	dispose() {
		this.hideGhost();
		this.scene.remove(this._ghost);
		this._ghostFill.geometry.dispose(); this._ghostFill.material.dispose();
		this._ghostEdges.geometry.dispose(); this._ghostEdges.material.dispose();
		for (const b of this.batches) b.dispose();
		this.geometry.dispose();
		this.index.clear();
	}
}

// --- Build HUD -------------------------------------------------------------
// A self-contained DOM control: a hotbar of the palette (1–0 / click to pick), a
// place/break mode toggle, and an enable toggle. Returned controller lets the
// scene drive selection from keys and reflect connection state. Kept here so the
// build feature owns its own chrome end-to-end.
export function createBuildHud({ onToggle, onPick, onModeChange }) {
	const el = (tag, props = {}, kids = []) => {
		const n = document.createElement(tag);
		for (const [k, v] of Object.entries(props)) {
			if (k === 'class') n.className = v;
			else if (k === 'text') n.textContent = v;
			else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
			else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
		}
		for (const kid of [].concat(kids)) if (kid != null) n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
		return n;
	};

	let active = false;
	let mode = 'place';

	const toggleBtn = el('button', {
		class: 'cc-build-toggle', type: 'button', title: 'Build mode (B)', 'aria-pressed': 'false',
		onclick: () => setActive(!active),
	}, [el('span', { class: 'cc-build-toggle-ico', text: '⛏' }), el('span', { class: 'cc-build-toggle-text', text: 'Build' })]);

	const slots = BLOCK_TYPES.map((def, i) => {
		const slot = el('button', {
			class: 'cc-build-slot' + (i === 0 ? ' cc-on' : ''), type: 'button',
			title: `${def.name} (${(i + 1) % 10})`, 'aria-label': def.name,
			onclick: () => pick(i),
		}, [
			el('span', { class: 'cc-build-swatch', style: `background:${def.swatch}` }),
			el('span', { class: 'cc-build-key', text: String((i + 1) % 10) }),
		]);
		return slot;
	});
	const hotbar = el('div', { class: 'cc-build-hotbar', role: 'toolbar', 'aria-label': 'Block palette' }, slots);

	const modeBtn = el('button', {
		class: 'cc-build-mode', type: 'button', title: 'Toggle place / break (right-click also breaks)',
		onclick: () => setMode(mode === 'place' ? 'remove' : 'place'),
	}, [el('span', { class: 'cc-build-mode-ico', text: '▦' }), el('span', { class: 'cc-build-mode-text', text: 'Place' })]);

	// Touch has no right-click; long-press breaks, and the mode toggle is the
	// explicit path. Tailor the hint so phone players aren't told to "right-click".
	const touch = typeof matchMedia === 'function' && matchMedia('(hover: none), (pointer: coarse)').matches;
	const hint = el('div', {
		class: 'cc-build-hint',
		text: touch
			? 'Tap to place · long-press to break · pick a block above'
			: 'Click to place · right-click to break · 1–0 pick block',
	});

	// Live block-budget meter. The build is hard-capped per world (MAX_BLOCKS);
	// without this the cap is a silent wall — a builder hits 6000 and blocks just
	// stop appearing. The fill bar warms to amber, then red, as the world fills.
	const budgetFill = el('span', { class: 'cc-build-budget-fill' });
	const budgetText = el('span', { class: 'cc-build-budget-text', text: `0 / ${MAX_BLOCKS}` });
	const budget = el('div', {
		class: 'cc-build-budget', role: 'status', 'aria-label': 'Blocks used',
		title: `Blocks placed in this world (max ${MAX_BLOCKS})`,
	}, [el('span', { class: 'cc-build-budget-bar' }, [budgetFill]), budgetText]);

	// Durability badge: tells builders, honestly, whether this world's creation is
	// saved for keeps (Redis) or only for the life of the server process.
	const durBadge = el('div', { class: 'cc-build-durability', role: 'status', hidden: true });

	const panel = el('div', { class: 'cc-build-panel', hidden: true }, [modeBtn, hotbar, budget, durBadge, hint]);
	const root = el('div', { id: 'cc-build', class: 'cc-build' }, [toggleBtn, panel]);
	document.body.appendChild(root);

	function pick(i) {
		for (let k = 0; k < slots.length; k++) slots[k].classList.toggle('cc-on', k === i);
		onPick?.(i);
	}
	function setMode(m) {
		mode = m;
		modeBtn.classList.toggle('cc-removing', m === 'remove');
		modeBtn.querySelector('.cc-build-mode-text').textContent = m === 'remove' ? 'Break' : 'Place';
		modeBtn.querySelector('.cc-build-mode-ico').textContent = m === 'remove' ? '✖' : '▦';
		onModeChange?.(m);
	}
	function setActive(v) {
		active = v;
		root.classList.toggle('cc-build-on', v);
		toggleBtn.classList.toggle('cc-on', v);
		toggleBtn.setAttribute('aria-pressed', String(v));
		panel.hidden = !v;
		onToggle?.(v);
	}

	return {
		root,
		get active() { return active; },
		get mode() { return mode; },
		setActive,
		setMode,
		select: pick,
		// Disable the whole control when there's no live connection to build into.
		setEnabled(enabled, reason) {
			toggleBtn.disabled = !enabled;
			toggleBtn.title = enabled ? 'Build mode (B)' : (reason || 'Building needs a live connection');
			if (!enabled && active) setActive(false);
		},
		// Reflect how full the world's block budget is. Warms the bar (amber ≥80%,
		// red when full) and flags the panel so place actions can read "full".
		setBudget(used, max = MAX_BLOCKS) {
			const u = Math.max(0, Math.min(used | 0, max));
			const pct = max > 0 ? u / max : 0;
			budgetFill.style.transform = `scaleX(${pct})`;
			budgetText.textContent = `${u.toLocaleString()} / ${max.toLocaleString()}`;
			const full = u >= max;
			budget.classList.toggle('cc-warn', pct >= 0.8 && !full);
			budget.classList.toggle('cc-full', full);
			root.classList.toggle('cc-build-full', full);
		},
		// Show whether this world's build survives a server restart. Online only —
		// solo single-player builds aren't persisted at all (passing null hides it).
		setPersistent(durable) {
			if (durable == null) { durBadge.hidden = true; return; }
			durBadge.hidden = false;
			durBadge.classList.toggle('cc-durable', !!durable);
			durBadge.textContent = durable ? '✓ Saved for everyone' : '⚠ This session only';
			durBadge.title = durable
				? 'This world is saved to durable storage — your build is here when you return.'
				: 'Durable storage is unavailable — this build lives only until the server restarts.';
		},
		dispose() { root.remove(); },
	};
}
