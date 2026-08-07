// PlayCombat — the client half of W07: renders what the server's combat.js /
// combat-handlers.js already decide, and sends nothing but intents.
//
// The server is the sole authority (see multiplayer/src/combat-handlers.js):
// this module never picks a target, rolls damage, or moves a mob — it renders
// the roaming PvE mobs and lootable tombstones the room replicates on
// state.mobs/state.tombstones, paints the danger-zone ground the same way
// play-systems.js paints ponds/trees/rocks (from the SAME world-features.js
// data the server gates on, so the rendered danger ring and the authoritative
// one can never drift apart), and turns the server's private profile/inv/
// combat/notice messages into the GTA-style vitals HUD (WorldHud) plus hit
// feedback (damage numbers, a screen flash, a death/respawn overlay).
//
// Mob BODIES are rendered by W08's `src/game/npc/mobs.js` `MobSystem` — it was
// already built and correctly self-gated behind a `window.twsCombat` contract
// ("when W07 ships, mobs light up with zero changes here"). Rather than stand
// up a second, competing mob-rendering system, this module IS that contract:
// it installs `window.twsCombat` before `WorldLife` constructs its `MobSystem`
// (see coincommunities.js instantiation order) and feeds it this module's own
// smoothed, per-frame interpolation of the server's authoritative positions —
// so MobSystem's body + (future navmesh) pathing render OUR real combat data,
// with zero duplicate geometry. This module keeps only what MobSystem doesn't
// have: HP bars, death/respawn transitions, and combat feedback.
//
// Owns its own DOM (mob HP bars, the loot prompt, damage popups, the death
// overlay, a touch Attack button) and its own scene objects (the tombstone
// markers + danger-zone ground), torn down cleanly on leave() like every
// other /play system.

import {
	Group, Mesh, MeshStandardMaterial, MeshBasicMaterial,
	RingGeometry, CircleGeometry, CylinderGeometry,
	Vector3, DoubleSide,
} from 'three';

import { DANGER_ZONES } from '../../multiplayer/src/world-features.js';
import { MOB_STATS, WEAPONS } from '../../multiplayer/src/items.js';
import { itemDisplay } from './items.js';
import { WorldHud } from './hud/world-hud.js';
import './combat-system.css';

const MOB_LERP = 0.18;
const DMG_POPUP_MS = 950;
const LOOT_REACH_HINT_M = 3.2; // mirrors combat-handlers.js LOOT_REACH_M

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

// A lightweight tracker for one live mob: no 3D object of its own (MobSystem
// owns the body via the twsCombat bridge below) — just the smoothed position
// used to place the HP bar, plus death/respawn edge detection so the bridge
// knows when to despawn/respawn MobSystem's body.
class MobView {
	constructor(mob, id) {
		this.id = id;
		this.kind = mob.kind;
		this.x = mob.x; this.y = mob.y; this.z = mob.z;
		this.targetX = mob.x; this.targetY = mob.y; this.targetZ = mob.z;
		this.hp = mob.hp; this.maxHp = mob.maxHp;
		this._dead = mob.state === 'dead';

		const stats = MOB_STATS[mob.kind] || {};
		this.label = el('div', { class: 'combat-mob-label', hidden: this._dead }, [
			el('span', { class: 'combat-mob-name', text: itemDisplay(mob.kind)?.name || mob.kind }),
			el('div', { class: 'combat-mob-hpbar' }, [el('i', { class: 'combat-mob-hpfill' })]),
		]);
		this.hpFill = this.label.querySelector('.combat-mob-hpfill');
		document.body.appendChild(this.label);
		this._height = 1.7 * (stats.scale || 1);
		this._syncHpFill();
	}
	_syncHpFill() {
		const pct = this.maxHp > 0 ? Math.max(0, Math.min(1, this.hp / this.maxHp)) : 0;
		if (this.hpFill) this.hpFill.style.width = (pct * 100).toFixed(0) + '%';
	}
	// Returns edge-transition flags so the caller can drive the twsCombat
	// despawn/spawn bridge exactly once per transition, not every tick.
	apply(mob) {
		this.targetX = mob.x; this.targetY = mob.y; this.targetZ = mob.z;
		this.hp = mob.hp; this.maxHp = mob.maxHp;
		this._syncHpFill();
		const wasDead = this._dead;
		this._dead = mob.state === 'dead';
		this.label.hidden = this._dead;
		const becameDead = !wasDead && this._dead;
		const respawned = wasDead && !this._dead;
		if (becameDead || respawned) {
			// A death or a respawn teleport should never glide — snap instantly.
			this.x = this.targetX; this.y = this.targetY; this.z = this.targetZ;
		}
		return { becameDead, respawned };
	}
	tick(dt) {
		if (this._dead) return;
		this.x += (this.targetX - this.x) * MOB_LERP;
		this.y += (this.targetY - this.y) * MOB_LERP;
		this.z += (this.targetZ - this.z) * MOB_LERP;
	}
	worldHeadPosition() {
		return new Vector3(this.x, this.y + this._height, this.z);
	}
	dispose() {
		this.label.remove();
	}
}

// A death-drop marker: a dim tombstone slab + a warm pulsing ring so it reads as
// lootable from across the danger zone, same visual grammar as play-systems.js's
// pond marker ring.
function buildTombstoneMesh() {
	const g = new Group();
	const slab = new Mesh(
		new CylinderGeometry(0.28, 0.34, 0.62, 6),
		new MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.85, metalness: 0.1 }),
	);
	slab.position.y = 0.31;
	slab.castShadow = true;
	g.add(slab);
	const ring = new Mesh(
		new RingGeometry(0.55, 0.68, 32),
		new MeshBasicMaterial({ color: 0xffcf5c, transparent: true, opacity: 0.55, side: DoubleSide, depthWrite: false }),
	);
	ring.rotation.x = -Math.PI / 2;
	ring.position.y = 0.03;
	g.add(ring);
	g.userData.ring = ring;
	return g;
}

class TombstoneView {
	constructor(scene, ts, id) {
		this.scene = scene;
		this.id = id;
		this.x = ts.x; this.z = ts.z; this.gold = ts.gold; this.count = ts.count; this.owner = ts.owner;
		this.group = buildTombstoneMesh();
		this.group.position.set(ts.x, 0, ts.z);
		scene.add(this.group);
		this._t = Math.random() * Math.PI * 2;
	}
	tick(dt) {
		this._t += dt * 2;
		const pulse = 0.45 + Math.sin(this._t) * 0.15;
		this.group.userData.ring.material.opacity = pulse;
	}
	dispose() {
		this.scene.remove(this.group);
		this.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
	}
}

const WEAPON_IDS = new Set(Object.keys(WEAPONS));

export class CombatSystem {
	/**
	 * @param {object} opts
	 * @param {import('three').Scene} opts.scene
	 * @param {import('three').Camera} opts.camera
	 * @param {import('three').WebGLRenderer} opts.renderer
	 * @param {() => ({x,y,z,yaw})} opts.getPlayer  local avatar pose
	 * @param {object} opts.net   CommunityNet instance
	 * @param {object} opts.ui    CommunityUI instance (toast)
	 */
	constructor({ scene, camera, renderer, getPlayer, net, ui }) {
		this.scene = scene;
		this.camera = camera;
		this.renderer = renderer;
		this.getPlayer = getPlayer;
		this.net = net;
		this.ui = ui;

		this.mobs = new Map();
		this.tombstones = new Map();
		this._nearestTombId = null;
		this._weapon = null;   // equipped weapon item id, or null
		this._dead = false;

		this.hud = new WorldHud();
		this.hud.show();
		this.hud.setContext('onfoot');

		// Must install before WorldLife constructs its MobSystem (see the module
		// doc comment) — coincommunities.js instantiates CombatSystem first.
		this._installTwsCombatBridge();

		this._unsub = [];

		this._buildZoneVisuals();
		this._buildPrompt();
		this._buildAttackButton();
		this._buildOverlays();
		this._bindNet();
	}

	// -------------------------------------------------------- twsCombat bridge
	// The W08 mob visual/nav system (src/game/npc/mobs.js MobSystem) already
	// implements a body + (future navmesh) walk from exactly this contract —
	// see that file's header. We are the real implementation it was waiting on:
	// every mob add/change/remove we hear from the server schema re-fires here
	// verbatim, so MobSystem renders live combat data with zero duplicate
	// geometry. `reportContact` is intentionally a no-op: our server already
	// decides every mob's attack unilaterally from its own authoritative
	// positions each tick (see combat-handlers.js tickMobs) — trusting a
	// client-reported "I'm in melee range" would be exactly the kind of
	// client-sent hit CLAUDE.md's anti-cheat baseline forbids.
	_installTwsCombatBridge() {
		const spawnCbs = new Set();
		const stateCbs = new Set();
		const despawnCbs = new Set();
		window.twsCombat = {
			onHostileSpawn: (cb) => { spawnCbs.add(cb); return () => spawnCbs.delete(cb); },
			onHostileState: (cb) => { stateCbs.add(cb); return () => stateCbs.delete(cb); },
			onHostileDespawn: (cb) => { despawnCbs.add(cb); return () => despawnCbs.delete(cb); },
			reportContact: () => {},
		};
		this._twsSpawn = (spec) => spawnCbs.forEach((cb) => { try { cb(spec); } catch { /* listener */ } });
		this._twsState = (s) => stateCbs.forEach((cb) => { try { cb(s); } catch { /* listener */ } });
		this._twsDespawn = (id) => despawnCbs.forEach((cb) => { try { cb({ id }); } catch { /* listener */ } });
	}

	// ------------------------------------------------------------- scene fx
	_buildZoneVisuals() {
		this._zoneGroup = new Group();
		this._zoneGroup.name = 'combat-danger-zones';
		for (const zone of DANGER_ZONES) {
			const ring = new Mesh(
				new RingGeometry(zone.r - 0.35, zone.r, 64),
				new MeshBasicMaterial({ color: 0xb5342c, transparent: true, opacity: 0.55, side: DoubleSide, depthWrite: false }),
			);
			ring.rotation.x = -Math.PI / 2;
			ring.position.set(zone.x, 0.03, zone.z);
			this._zoneGroup.add(ring);
			const fill = new Mesh(
				new CircleGeometry(zone.r, 48),
				new MeshBasicMaterial({ color: 0x7a1d18, transparent: true, opacity: 0.07, depthWrite: false }),
			);
			fill.rotation.x = -Math.PI / 2;
			fill.position.set(zone.x, 0.015, zone.z);
			this._zoneGroup.add(fill);
			const label = el('div', { class: 'combat-zone-label', text: `⚔ ${zone.name}` });
			document.body.appendChild(label);
			this._zoneGroup.userData[zone.id] = { label, zone };
		}
		this.scene.add(this._zoneGroup);
	}

	_buildPrompt() {
		this.prompt = el('div', { class: 'combat-prompt' });
		document.body.appendChild(this.prompt);
	}

	// Touch-friendly Attack action, shown only while a weapon is equipped — the
	// keyboard equivalent is the 'x' key wired by the host (coincommunities.js).
	_buildAttackButton() {
		this.attackBtn = el('button', { class: 'combat-attack-btn', hidden: true, onclick: () => this.attack() }, [
			el('span', { class: 'combat-attack-glyph', text: '⚔️' }),
			el('span', { class: 'combat-attack-label', text: 'Attack' }),
		]);
		document.body.appendChild(this.attackBtn);
	}

	_buildOverlays() {
		this.hitFlash = el('div', { class: 'combat-hitflash' });
		document.body.appendChild(this.hitFlash);

		this.deathTitle = el('div', { class: 'combat-death-title', text: 'You died' });
		this.deathSub = el('div', { class: 'combat-death-sub', text: '' });
		this.deathOverlay = el('div', { class: 'combat-death', hidden: true, role: 'status' }, [this.deathTitle, this.deathSub]);
		document.body.appendChild(this.deathOverlay);
	}

	// ------------------------------------------------------------------ net
	_bindNet() {
		const n = this.net;
		this._unsub.push(
			n.on('mobAdd', (mob, id) => {
				if (this.mobs.has(id)) return;
				this.mobs.set(id, new MobView(mob, id));
				if (mob.state !== 'dead') this._spawnHostile(id, mob);
			}),
			n.on('mobChange', (mob, id) => {
				const view = this.mobs.get(id);
				if (!view) return;
				const { becameDead, respawned } = view.apply(mob);
				if (becameDead) this._twsDespawn(id);
				else if (respawned) this._spawnHostile(id, mob);
			}),
			n.on('mobRemove', (id) => {
				this.mobs.get(id)?.dispose();
				this.mobs.delete(id);
				this._twsDespawn(id);
			}),
			n.on('tombstoneAdd', (ts, id) => {
				if (this.tombstones.has(id)) return;
				this.tombstones.set(id, new TombstoneView(this.scene, ts, id));
			}),
			n.on('tombstoneRemove', (id) => { this.tombstones.get(id)?.dispose(); this.tombstones.delete(id); }),
			n.on('profile', (snap) => this._applyVitals(snap)),
			n.on('inv', (delta) => this._applyVitals(delta)),
			n.on('combat', (msg) => this._onCombat(msg)),
			n.on('notice', (notice) => this._onNotice(notice)),
		);
	}

	_spawnHostile(id, mob) {
		const stats = MOB_STATS[mob.kind] || {};
		const pos = { x: mob.x, z: mob.z };
		// target === pos: MobSystem's own client-side nav-walk (a straight line
		// with no navmesh registered — see nav-graph.js findPath) then has zero
		// distance to cover, so the body sits exactly where our own per-frame
		// twsState updates place it. It's ready to do real pathing the moment
		// W01 registers a navmesh; nothing here has to change when that lands.
		this._twsSpawn({ id, kind: mob.kind, pos, target: pos, speed: stats.speed || 2.4 });
	}

	_applyVitals(v) {
		if (!v) return;
		if (Number.isFinite(v.hp) && Number.isFinite(v.maxHp)) this.hud.setHealth(v.hp, v.maxHp);
		if (Number.isFinite(v.armor) && Number.isFinite(v.maxArmor)) this.hud.setArmor(v.armor, v.maxArmor);
		if (Number.isFinite(v.heat)) this.hud.setWanted(v.heat);
		if (Number.isFinite(v.gold)) this.hud.setCash(v.gold);
		if (Number.isFinite(v.bank)) this.hud.setBanked(v.bank);
		if (Array.isArray(v.hotbar) && Number.isFinite(v.activeSlot)) {
			const active = v.hotbar[v.activeSlot];
			const next = active && WEAPON_IDS.has(active.item) ? active.item : null;
			if (next !== this._weapon) {
				this._weapon = next;
				this.attackBtn.hidden = !next;
				if (next) this.attackBtn.querySelector('.combat-attack-glyph').textContent = itemDisplay(next)?.glyph || '⚔️';
			}
		}
	}

	_onCombat(msg) {
		if (!msg) return;
		if (msg.target === 'mob' && msg.role === 'attacker' && msg.dealt) {
			const mob = [...this.mobs.values()].find((m) => m.kind === msg.kind && !m._dead) || null;
			this._spawnDamagePopup(mob ? mob.worldHeadPosition() : this._playerHeadWorldPos(), msg.dealt, false);
			if (msg.dead) this.ui?.toast?.(`${itemDisplay(msg.kind)?.name || 'The mob'} is down.`, 'info');
		} else if (msg.role === 'victim') {
			this._flashHit();
			this._spawnDamagePopup(this._playerHeadWorldPos(), msg.dealt, true);
		} else if (msg.target === 'player' && msg.role === 'attacker' && msg.dealt) {
			this._spawnDamagePopup(this._playerHeadWorldPos(), msg.dealt, false);
			if (msg.dead) this.ui?.toast?.('Target down.', 'info');
		}
	}

	_onNotice(n) {
		if (!n) return;
		if (n.kind === 'death') { this._showDeath(n.text); return; }
		if (n.kind === 'respawn') { this._hideDeath(); return; }
	}

	_showDeath(text) {
		this._dead = true;
		this.deathSub.textContent = text || 'Respawning shortly…';
		this.deathOverlay.hidden = false;
		void this.deathOverlay.offsetWidth;
		this.deathOverlay.classList.add('is-in');
	}
	_hideDeath() {
		this._dead = false;
		this.deathOverlay.classList.remove('is-in');
		this.deathOverlay.hidden = true;
	}

	_flashHit() {
		this.hitFlash.classList.remove('is-flash');
		void this.hitFlash.offsetWidth;
		this.hitFlash.classList.add('is-flash');
	}

	_playerHeadWorldPos() {
		const p = this.getPlayer();
		return new Vector3(p.x, (p.y || 0) + (p.height || 1.7), p.z);
	}

	_spawnDamagePopup(worldPos, amount, taken) {
		if (!worldPos || !amount) return;
		const node = el('div', {
			class: `combat-dmg ${taken ? 'is-taken' : 'is-dealt'}`,
			text: (taken ? '-' : '') + Math.round(amount),
		});
		document.body.appendChild(node);
		const start = performance.now();
		const origin = worldPos.clone();
		const step = () => {
			const t = (performance.now() - start) / DMG_POPUP_MS;
			if (t >= 1) { node.remove(); return; }
			const y = origin.y + 1.1 * t;
			this._placeAt(node, origin.x, y, origin.z);
			node.style.opacity = String(1 - t);
			requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	}

	// Project a world point to a fixed-position screen transform (same math
	// world-life.js's NPC prompt uses). Hides the node when behind the camera.
	_placeAt(node, x, y, z) {
		const w = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight;
		const v = new Vector3(x, y, z).project(this.camera);
		if (v.z > 1 || v.z < -1) { node.style.display = 'none'; return; }
		node.style.display = '';
		node.style.transform = `translate(-50%, -100%) translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px)`;
	}

	// ---------------------------------------------------------------- input
	attack() {
		if (!this._weapon) { this.ui?.toast?.('Equip a weapon to attack.', 'warn'); return; }
		this.net?.attack();
	}

	// Loot the nearest in-range tombstone, mirroring vehicles.interact()/
	// worldLife.interact()'s boolean "did I consume the E press" contract.
	interact() {
		if (!this._nearestTombId) return false;
		this.net?.lootTombstone(this._nearestTombId);
		return true;
	}

	// Touch-native equivalent of interact(): a tap that lands on a nearby
	// tombstone's mesh loots it, mirroring vehicles.tryActivateAt/
	// worldLife.tryActivateAt's raycast-and-consume contract.
	tryActivateAt(ray) {
		if (!ray) return false;
		for (const [id, t] of this.tombstones) {
			const hits = ray.intersectObject(t.group, true);
			if (hits.length) {
				const p = this.getPlayer();
				if (Math.hypot(p.x - t.x, p.z - t.z) <= LOOT_REACH_HINT_M + 1) {
					this.net?.lootTombstone(id);
					return true;
				}
			}
		}
		return false;
	}

	// ------------------------------------------------------------------ tick
	tick(dt) {
		const p = this.getPlayer();

		for (const [, view] of this.mobs) {
			view.tick(dt);
			if (!view._dead) this._twsState({ id: view.id, pos: { x: view.x, z: view.z } });
			if (view._dead) continue;
			const head = view.worldHeadPosition();
			this._placeAt(view.label, head.x, head.y, head.z);
		}
		for (const t of this.tombstones.values()) t.tick(dt);

		// Nearest tombstone in range drives the loot prompt, and zone labels only
		// show while genuinely close (uncluttered from across the map).
		let nearest = null, bestD = Infinity;
		for (const [id, t] of this.tombstones) {
			const d = Math.hypot(p.x - t.x, p.z - t.z);
			if (d < bestD) { bestD = d; nearest = { id, t }; }
		}
		if (nearest && bestD <= LOOT_REACH_HINT_M) {
			this._nearestTombId = nearest.id;
			const parts = [];
			if (nearest.t.gold > 0) parts.push(`$${nearest.t.gold}`);
			if (nearest.t.count > 0) parts.push(`${nearest.t.count} item${nearest.t.count === 1 ? '' : 's'}`);
			// The tombstone owner is a remote player's chosen display name — untrusted
			// text. Build the prompt with textContent, never innerHTML, so a name like
			// `<img onerror=…>` renders as literal text instead of executing for every
			// player who walks near the tombstone.
			const key = document.createElement('span');
			key.className = 'combat-key';
			key.textContent = 'E';
			this.prompt.replaceChildren(
				key,
				document.createTextNode(` Loot ${nearest.t.owner}${parts.length ? ' (' + parts.join(', ') + ')' : ''}`),
			);
			this.prompt.classList.add('combat-show');
			this._placeAt(this.prompt, nearest.t.x, 1.1, nearest.t.z);
		} else {
			this._nearestTombId = null;
			this.prompt.classList.remove('combat-show');
		}

		for (const zoneId in this._zoneGroup.userData) {
			const { label, zone } = this._zoneGroup.userData[zoneId];
			const d = Math.hypot(p.x - zone.x, p.z - zone.z);
			const show = d <= zone.r + 22;
			label.classList.toggle('combat-show', show);
			if (show) this._placeAt(label, zone.x, 2.4, zone.z);
		}

		this.hud.minimap.setViewer({ x: p.x, z: p.z, yaw: p.yaw || 0 });
		this.hud.tick(dt);
	}

	dispose() {
		for (const off of this._unsub) off?.();
		for (const m of this.mobs.values()) m.dispose();
		this.mobs.clear();
		for (const t of this.tombstones.values()) t.dispose();
		this.tombstones.clear();
		this.scene.remove(this._zoneGroup);
		this._zoneGroup.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
		for (const zoneId in this._zoneGroup.userData) this._zoneGroup.userData[zoneId].label.remove();
		this.prompt.remove();
		this.attackBtn.remove();
		this.hitFlash.remove();
		this.deathOverlay.remove();
		if (window.twsCombat) delete window.twsCombat;
		this.hud.dispose();
	}
}
