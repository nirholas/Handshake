// Play systems — the gameplay layer grafted onto the /play coin worlds.
//
// /play is a free-roam social world (coincommunities.js). This module adds the
// game economy and activities ported from /game WITHOUT its low-poly tile world:
// a private inventory + hotbar + purse + skills HUD, and the spatial activities
// re-anchored to fixed features in continuous world space (the first being fishing
// at the ponds defined in multiplayer/src/world-features.js).
//
// Authority lives on the server (WalkRoom): this client renders the pond, plays
// the cast animation, and gates the Cast button, but every catch, XP gain and
// level-up is rolled server-side and streamed back over CommunityNet's
// profile/inv/xpgain/levelup/notice events. Nothing here is simulated locally.
//
// It owns its own DOM (a HUD appended to <body>, styled to the /play monochrome
// design tokens) and its own scene objects (the ponds + the live cast), and tears
// both down cleanly on leave() so switching coins never leaks meshes or panels.

import {
	Group, Mesh, Color, Vector3,
	CircleGeometry, RingGeometry, CylinderGeometry, SphereGeometry, ConeGeometry, BoxGeometry, IcosahedronGeometry,
	MeshStandardMaterial, MeshBasicMaterial, ShaderMaterial,
	BufferGeometry, Line, LineBasicMaterial, Float32BufferAttribute, DoubleSide,
} from 'three';
import { WATER_VERTEX_SHADER, WATER_FRAGMENT_SHADER } from './water-shader.js';

import {
	FISHING_SPOTS, nearestFishingSpot,
	TREES, nearestTree, ROCKS, nearestRock,
	FIREPITS, nearestFirepit, MOB_SPAWNS, nearestMobSpawn,
} from '../../multiplayer/src/world-features.js';
import { itemDisplay } from './items.js';
import {
	COSMETICS, SLOTS, SLOT_LABELS, getCosmetic, DEFAULT_LOADOUT,
} from '../../multiplayer/src/cosmetics-catalog.js';
import { buyBoutiqueItem } from './boutique-purchase.js';
import './play-systems.css';

// Rarity → display label + accent, shared by the inventory cards. Keeps the
// wardrobe legible at a glance (a legendary aura should read differently from a
// common dye) without inventing per-item art.
const RARITY_META = {
	common: { label: 'Common', cls: 'is-common' },
	rare: { label: 'Rare', cls: 'is-rare' },
	epic: { label: 'Epic', cls: 'is-epic' },
	legendary: { label: 'Legendary', cls: 'is-legendary' },
};

// Contextual activities the world offers, beyond fishing. Each entry knows the
// tool the player must hold (null = none), the nearest-node finder (shared with the
// server so the range rule never drifts), and the verb shown on the action button.
// Ordered by how close the player must be — when several are reachable, tick() picks
// the nearest. Fishing keeps its bespoke cast path; these four share one dispatch.
const ACTIVITIES = [
	{ type: 'chop', tool: 'axe', near: nearestTree, label: 'Chop', glyph: '🪓', noTool: 'Need an axe' },
	{ type: 'mine', tool: 'pickaxe', near: nearestRock, label: 'Mine', glyph: '⛏️', noTool: 'Need a pickaxe' },
	{ type: 'attack', tool: 'sword', near: nearestMobSpawn, label: 'Attack', glyph: '⚔️', noTool: 'Need a sword' },
	{ type: 'cook', tool: null, near: nearestFirepit, label: 'Cook fish', glyph: '🍳', noTool: '' },
];

const SKILL_META = {
	fishing: { label: 'Fishing', glyph: '🎣' },
	cooking: { label: 'Cooking', glyph: '🍳' },
	woodcutting: { label: 'Woodcutting', glyph: '🪓' },
	mining: { label: 'Mining', glyph: '⛏️' },
	combat: { label: 'Combat', glyph: '⚔️' },
};
const SKILL_ORDER = ['fishing', 'cooking', 'woodcutting', 'mining', 'combat'];

// Small DOM factory mirroring the one coincommunities-ui.js uses, so the HUD reads
// the same way and stays dependency-free.
function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k === 'hidden') n.hidden = !!v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (v != null) n.setAttribute(k, v);
	}
	for (const c of [].concat(kids)) if (c) n.appendChild(c);
	return n;
}

export class PlaySystems {
	/**
	 * @param {object} opts
	 * @param {import('three').Scene} opts.scene
	 * @param {() => ({x,y,z,yaw,height})} opts.getPlayer  local avatar pose + height
	 * @param {object} opts.net   CommunityNet instance (fish/equip/consume intents)
	 * @param {object} opts.ui    CommunityUI instance (toast)
	 * @param {object} [opts.env] world-env instance (createWorldEnvironment) — its
	 *   live sun direction/colour keep the pond's sparkle in sync with the day/night
	 *   cycle. Optional: ponds render fine with a fixed sun when a world has none.
	 */
	constructor({ scene, getPlayer, net, ui, env }) {
		this.scene = scene;
		this.getPlayer = getPlayer;
		this.net = net;
		this.ui = ui;
		this.env = env || null;
		this._waterMats = [];

		this.profile = null;           // last full snapshot from the server
		this.skills = {};              // skill -> { level, xp, levelXp, nextXp }
		this.cap = 99;
		this._nearSpot = null;         // nearest fishing spot when in range, else null
		this._cast = null;             // active cast visual state
		this._t = 0;                   // animation clock
		this._invOpen = false;
		this._skillsOpen = false;

		this._pondGroup = null;
		this._buildScene();
		this._buildHud();
	}

	// ---------------------------------------------------------------- scene
	_buildScene() {
		const group = new Group();
		group.name = 'play-ponds';
		FISHING_SPOTS.forEach((spot, i) => group.add(this._buildPond(spot, i)));
		this.scene.add(group);
		this._pondGroup = group;
	}

	// A pond: an animated shader water disc (real ripples + sun sparkle, no flat
	// fake tint), a bright rim, a soft pulsing marker ring (so it reads as an
	// interactable from across the plaza), and a few bank reeds.
	_buildPond(spot, index = 0) {
		const g = new Group();
		g.position.set(spot.x, 0, spot.z);

		const sunDir = this.env?.lights?.sun || new Vector3(0.6, 0.7, 0.3);
		const sunColor = this.env?.lights?.sunLight?.color || new Color(0xfff3d6);
		const skyColor = this.env?.biome?.sky?.[1] ? new Color(this.env.biome.sky[1]) : new Color(0xbfeaff);
		const waterMat = new ShaderMaterial({
			vertexShader: WATER_VERTEX_SHADER,
			fragmentShader: WATER_FRAGMENT_SHADER,
			transparent: true,
			uniforms: {
				uTime: { value: 0 },
				uPhase: { value: index * 11.3 }, // desyncs multiple ponds' ripples
				uDeep: { value: new Color(0x0c232c) },
				uShallow: { value: new Color(0x2f6a78) },
				uSunDir: { value: sunDir.clone().normalize() },
				uSunColor: { value: sunColor.clone() },
				uSkyColor: { value: skyColor },
				uOpacity: { value: 0.92 },
			},
		});
		this._waterMats.push(waterMat);

		const water = new Mesh(new CircleGeometry(spot.r, 48), waterMat);
		water.rotation.x = -Math.PI / 2;
		water.position.y = 0.04;
		water.receiveShadow = true;
		g.add(water);

		const rim = new Mesh(
			new RingGeometry(spot.r, spot.r + 0.45, 48),
			new MeshBasicMaterial({ color: 0xbfeaff, transparent: true, opacity: 0.45, side: DoubleSide }),
		);
		rim.rotation.x = -Math.PI / 2;
		rim.position.y = 0.05;
		g.add(rim);

		// Pulsing interactable marker just inside the rim.
		const marker = new Mesh(
			new RingGeometry(spot.r * 0.62, spot.r * 0.66, 48),
			new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, side: DoubleSide }),
		);
		marker.rotation.x = -Math.PI / 2;
		marker.position.y = 0.06;
		g.add(marker);
		g.userData.marker = marker;
		g.userData.spotId = spot.id;

		// Reeds around one arc of the bank.
		const reedMat = new MeshStandardMaterial({ color: 0x2f5d3a, roughness: 0.9 });
		for (let i = 0; i < 7; i++) {
			const a = (i / 7) * Math.PI * 0.9 - Math.PI * 0.2;
			const rr = spot.r + 0.35;
			const h = 0.7 + (i % 3) * 0.25;
			const reed = new Mesh(new CylinderGeometry(0.04, 0.06, h, 5), reedMat);
			reed.position.set(Math.cos(a) * rr, h / 2, Math.sin(a) * rr);
			reed.castShadow = true;
			g.add(reed);
		}
		return g;
	}

	// ---------------------------------------------------------------- HUD DOM
	_buildHud() {
		// Gold purse (top-left, under the coin banner).
		this.goldEl = el('span', { class: 'ps-gold-amt', text: '0' });
		this.gold = el('div', { class: 'ps-gold', title: 'Gold' }, [
			el('span', { class: 'ps-gold-coin', text: '🪙' }), this.goldEl,
		]);

		// Right tool rail: inventory + skills toggles.
		this.invBtn = el('button', { class: 'ps-rail-btn', title: 'Inventory (backpack)', 'aria-label': 'Inventory', onclick: () => this.toggleInventory() }, [el('span', { text: '🎒' })]);
		this.skillsBtn = el('button', { class: 'ps-rail-btn', title: 'Skills', 'aria-label': 'Skills', onclick: () => this.toggleSkills() }, [el('span', { text: '📊' })]);
		// My Cosmetics (R23): the owned wardrobe + equip. Equipping persists to the
		// account and re-applies in every world; peers see the fit live.
		this.cosBtn = el('button', { class: 'ps-rail-btn', title: 'My Cosmetics', 'aria-label': 'My Cosmetics', onclick: () => this.toggleCosmetics() }, [el('span', { text: '👕' })]);
		this.rail = el('div', { class: 'ps-rail' }, [this.invBtn, this.skillsBtn, this.cosBtn]);

		// Hotbar (bottom-center, above the emote tray).
		this.hotbarEl = el('div', { class: 'ps-hotbar', role: 'toolbar', 'aria-label': 'Hotbar' });

		// Contextual action button (Cast / Equip rod), above the hotbar.
		this.actionBtn = el('button', { class: 'ps-action', hidden: true, onclick: () => this._onAction() });

		// Inventory panel.
		this.invGrid = el('div', { class: 'ps-inv-grid' });
		this.invPanel = el('div', { class: 'ps-panel ps-inv', hidden: true, role: 'dialog', 'aria-label': 'Inventory' }, [
			el('div', { class: 'ps-panel-head' }, [
				el('span', { class: 'ps-panel-title', text: 'Backpack' }),
				el('button', { class: 'ps-x', 'aria-label': 'Close', text: '✕', onclick: () => this.toggleInventory(false) }),
			]),
			this.invGrid,
			el('div', { class: 'ps-inv-hint', text: 'Click a tool to equip it. Click food to eat.' }),
		]);

		// Skills panel.
		this.skillsList = el('div', { class: 'ps-skills-list' });
		this.skillsPanel = el('div', { class: 'ps-panel ps-skills', hidden: true, role: 'dialog', 'aria-label': 'Skills' }, [
			el('div', { class: 'ps-panel-head' }, [
				el('span', { class: 'ps-panel-title', text: 'Skills' }),
				el('button', { class: 'ps-x', 'aria-label': 'Close', text: '✕', onclick: () => this.toggleSkills(false) }),
			]),
			this.skillsList,
		]);

		// My Cosmetics panel (R23): the owned wardrobe. Body is rebuilt per open from
		// the latest profile snapshot so it always reflects the authoritative owned +
		// equipped set; states (loading/empty/error) render inside ps-cos-body.
		this.cosBody = el('div', { class: 'ps-cos-body' });
		this.cosPanel = el('div', { class: 'ps-panel ps-cos', hidden: true, role: 'dialog', 'aria-label': 'My Cosmetics' }, [
			el('div', { class: 'ps-panel-head' }, [
				el('span', { class: 'ps-panel-title', text: 'My Cosmetics' }),
				el('button', { class: 'ps-x', 'aria-label': 'Close', text: '✕', onclick: () => this.toggleCosmetics(false) }),
			]),
			this.cosBody,
		]);

		this.root = el('div', { id: 'ps-hud' }, [
			this.gold, this.rail, this.actionBtn, this.hotbarEl, this.invPanel, this.skillsPanel, this.cosPanel,
		]);
		document.body.appendChild(this.root);

		this._renderHotbar();
		this._renderSkills();
	}

	// ---------------------------------------------------------------- data in
	setProfile(snap) {
		if (!snap || typeof snap !== 'object') return;
		this.profile = {
			gold: snap.gold | 0,
			hp: snap.hp | 0,
			maxHp: snap.maxHp | 0,
			inv: Array.isArray(snap.inv) ? snap.inv : [],
			hotbar: Array.isArray(snap.hotbar) ? snap.hotbar : [],
			activeSlot: Number.isFinite(snap.activeSlot) ? snap.activeSlot : -1,
		};
		this.cap = snap.cap || 99;
		this.skills = snap.skills || {};
		// Cosmetics ownership + equipped loadout (R23). The server is the source of
		// truth — owned premium ids the account has unlocked, plus the per-slot
		// equipped map (free `none` defaults for empty slots). Marked "loaded" so the
		// panel can tell a still-connecting world (loading) from a genuinely bare one.
		const cos = snap.cosmetics && typeof snap.cosmetics === 'object' ? snap.cosmetics : null;
		this.cosmetics = {
			loaded: true,
			owned: Array.isArray(cos?.owned) ? cos.owned : [],
			equipped: cos?.equipped && typeof cos.equipped === 'object' ? cos.equipped : { ...DEFAULT_LOADOUT },
		};
		this._renderAll();
	}

	// Merge an economy delta (after a catch / eat / equip) onto the cached profile.
	applyInv(delta) {
		if (!this.profile || !delta) return;
		if (Array.isArray(delta.inv)) this.profile.inv = delta.inv;
		if (Array.isArray(delta.hotbar)) this.profile.hotbar = delta.hotbar;
		if (Number.isFinite(delta.activeSlot)) this.profile.activeSlot = delta.activeSlot;
		if (Number.isFinite(delta.gold)) this.profile.gold = delta.gold;
		if (Number.isFinite(delta.hp)) this.profile.hp = delta.hp;
		if (Number.isFinite(delta.maxHp)) this.profile.maxHp = delta.maxHp;
		this._renderHotbar();
		this._renderGold();
		if (this._invOpen) this._renderInventory();
	}

	// ---------------------------------------------------------------- accessors
	// The unified WorldHud owns the canonical cash/health readout, so the legacy
	// gold purse is hidden when that HUD is active — one money readout, not two.
	setGoldVisible(v) { if (this.gold) this.gold.hidden = !v; }

	getGold() { return this.profile?.gold ?? 0; }
	getHp() { return this.profile?.hp ?? 0; }
	getMaxHp() { return this.profile?.maxHp ?? 0; }

	// Hotbar projected for the weapon/action wheel: glyph + name + qty per slot.
	getHotbarItems() {
		const hb = this.profile?.hotbar || [];
		const active = this.profile?.activeSlot ?? -1;
		const out = [];
		for (let i = 0; i < Math.max(6, hb.length); i++) {
			const slot = hb[i] || { item: '', qty: 0 };
			const disp = slot.item ? itemDisplay(slot.item) : null;
			out.push({
				slot: i, empty: !slot.item, active: i === active,
				glyph: disp ? disp.glyph : '', name: disp ? disp.name : '', qty: slot.qty || 0,
			});
		}
		return out;
	}

	onXpGain(g) {
		if (!g || !g.skill) return;
		this.skills[g.skill] = { level: g.level, xp: g.xp, levelXp: g.levelXp, nextXp: g.nextXp };
		this._floatXp(g.skill, g.amount);
		if (this._skillsOpen) this._renderSkills();
		this._pulse(this.skillsBtn);
	}

	onLevelup(l) {
		if (!l || !l.skill) return;
		const meta = SKILL_META[l.skill] || { label: l.skill, glyph: '✨' };
		this._celebrate(`${meta.glyph} ${meta.label} level ${l.level}`);
		this.ui?.toast?.(`${meta.label} is now level ${l.level}!`, 'info');
	}

	// Activity result. Fishing notices resolve the live cast (bite vs miss); the rest
	// surface as toasts. `kind` mirrors the server's notice vocabulary.
	onNotice(n) {
		if (!n) return;
		if (n.kind === 'fish' && this._cast && !this._cast.result) {
			this._cast.result = n.caught > 0 ? 'catch' : 'miss';
		}
		const tone = (n.kind === 'full' || n.kind === 'tool') ? 'warn' : 'info';
		if (n.text) this.ui?.toast?.(n.text, tone);
	}

	// ---------------------------------------------------------------- render
	_renderAll() {
		this._renderGold();
		this._renderHotbar();
		this._renderSkills();
		if (this._invOpen) this._renderInventory();
		if (this._cosOpen) this._renderCosmetics();
	}

	_renderGold() {
		this.goldEl.textContent = (this.profile?.gold ?? 0).toLocaleString();
	}

	_renderHotbar() {
		this.hotbarEl.replaceChildren();
		const hb = this.profile?.hotbar || [];
		const active = this.profile?.activeSlot ?? -1;
		for (let i = 0; i < (hb.length || 6); i++) {
			const slot = hb[i] || { item: '', qty: 0 };
			const disp = slot.item ? itemDisplay(slot.item) : null;
			const cell = el('button', {
				class: 'ps-slot' + (i === active ? ' is-active' : '') + (slot.item ? '' : ' is-empty'),
				title: disp ? disp.name : 'Empty slot',
				'aria-label': disp ? `${disp.name}${i === active ? ', equipped' : ''}` : 'Empty slot',
				onclick: () => this.equipSlot(i === active ? -1 : i),
			}, [
				el('span', { class: 'ps-slot-glyph', text: disp ? disp.glyph : '' }),
				slot.qty > 1 ? el('span', { class: 'ps-slot-qty', text: String(slot.qty) }) : null,
				el('span', { class: 'ps-slot-key', text: String(i + 1) }),
			]);
			this.hotbarEl.appendChild(cell);
		}
	}

	_renderInventory() {
		this.invGrid.replaceChildren();
		const inv = this.profile?.inv || [];
		const filled = inv.filter((s) => s.item).length;
		if (!filled) {
			this.invGrid.appendChild(el('div', { class: 'ps-inv-empty', text: 'Your backpack is empty. Cast a line at a pond to catch your first fish.' }));
			return;
		}
		inv.forEach((slot, i) => {
			if (!slot.item) { this.invGrid.appendChild(el('div', { class: 'ps-cell is-empty' })); return; }
			const disp = itemDisplay(slot.item);
			const cell = el('button', {
				class: 'ps-cell',
				title: disp.name,
				'aria-label': `${slot.qty} ${disp.name}`,
				onclick: () => this._onInvClick(i, slot.item),
			}, [
				el('span', { class: 'ps-cell-glyph', text: disp.glyph }),
				slot.qty > 1 ? el('span', { class: 'ps-cell-qty', text: String(slot.qty) }) : null,
			]);
			this.invGrid.appendChild(cell);
		});
	}

	_renderSkills() {
		this.skillsList.replaceChildren();
		for (const skill of SKILL_ORDER) {
			const meta = SKILL_META[skill];
			const s = this.skills[skill] || { level: 1, xp: 0, levelXp: 0, nextXp: null };
			const span = s.nextXp != null ? Math.max(1, s.nextXp - s.levelXp) : 1;
			const into = s.nextXp != null ? Math.max(0, Math.min(span, s.xp - s.levelXp)) : span;
			const pct = Math.round((into / span) * 100);
			const row = el('div', { class: 'ps-skill' }, [
				el('span', { class: 'ps-skill-glyph', text: meta.glyph }),
				el('div', { class: 'ps-skill-body' }, [
					el('div', { class: 'ps-skill-top' }, [
						el('span', { class: 'ps-skill-name', text: meta.label }),
						el('span', { class: 'ps-skill-lvl', text: s.nextXp == null ? `Lv ${s.level} · max` : `Lv ${s.level}` }),
					]),
					el('div', { class: 'ps-skill-bar' }, [el('span', { class: 'ps-skill-fill', style: `width:${pct}%` })]),
				]),
			]);
			this.skillsList.appendChild(row);
		}
	}

	// ---------------------------------------------------------------- actions
	equipSlot(i) {
		this.net?.equip(i);
		// Optimistic so the hotbar feels instant; the server echoes `inv` to confirm.
		if (this.profile) { this.profile.activeSlot = i; this._renderHotbar(); }
	}

	_onInvClick(i, item) {
		// Edible → eat it; otherwise no-op (tools live on the hotbar already).
		const disp = itemDisplay(item);
		if (item === 'cookedFish' || item === 'healthPotion') {
			this.net?.consume({ zone: 'inv', i });
		} else {
			this.ui?.toast?.(`${disp.name} — ${item === 'fish' ? 'cook it at a campfire to make it edible.' : 'nothing to do with this yet.'}`, 'info');
		}
	}

	_onAction() {
		if (!this._nearSpot) return;
		this.castFish();
	}

	// Cast a line. Mirrors the server's preconditions for instant, honest feedback
	// (equip the rod if you're holding something else but own one), then spawns the
	// bobber/line visual and sends the intent. The catch/miss rides back as a notice.
	castFish() {
		if (this._cast) return; // one line in the water at a time
		const near = this._nearSpot;
		if (!near) { this.ui?.toast?.('Move next to a pond to cast.', 'warn'); return; }

		const holding = this._activeItem();
		if (holding !== 'rod') {
			const rodSlot = (this.profile?.hotbar || []).findIndex((s) => s.item === 'rod');
			if (rodSlot >= 0) { this.equipSlot(rodSlot); this.ui?.toast?.('Fishing rod equipped — cast again.', 'info'); return; }
			this.ui?.toast?.('You need a fishing rod to cast.', 'warn');
			return;
		}
		this._spawnCast(near);
		this.net?.fish();
	}

	_activeItem() {
		const hb = this.profile?.hotbar || [];
		const i = this.profile?.activeSlot ?? -1;
		return i >= 0 && hb[i] ? hb[i].item : '';
	}

	toggleInventory(force) {
		this._invOpen = force == null ? !this._invOpen : !!force;
		this.invPanel.hidden = !this._invOpen;
		this.invBtn.classList.toggle('is-on', this._invOpen);
		if (this._invOpen) this._renderInventory();
	}

	toggleSkills(force) {
		this._skillsOpen = force == null ? !this._skillsOpen : !!force;
		this.skillsPanel.hidden = !this._skillsOpen;
		this.skillsBtn.classList.toggle('is-on', this._skillsOpen);
		if (this._skillsOpen) this._renderSkills();
	}

	// ---------------------------------------------------------------- cosmetics
	toggleCosmetics(force) {
		this._cosOpen = force == null ? !this._cosOpen : !!force;
		this.cosPanel.hidden = !this._cosOpen;
		this.cosBtn.classList.toggle('is-on', this._cosOpen);
		if (this._cosOpen) this._renderCosmetics();
	}

	// Render "My Cosmetics": the owned wardrobe grouped by slot, each item card
	// showing its rarity and preview, with the equipped one marked and a per-slot
	// "Remove" to unequip. Owned = every free cosmetic plus the premium ids the
	// account has unlocked; locked premium items show a hint to the shop so the
	// panel is never a dead end. Loading/empty states are designed, not blank.
	_renderCosmetics() {
		const body = this.cosBody;
		body.replaceChildren();

		// Loading: no profile snapshot has arrived yet (still joining the world).
		if (!this.cosmetics?.loaded) {
			body.appendChild(el('div', { class: 'ps-cos-state' }, [
				el('div', { class: 'ps-cos-spinner', 'aria-hidden': 'true' }),
				el('p', { class: 'ps-cos-state-text', text: 'Loading your wardrobe…' }),
			]));
			return;
		}

		const ownedSet = new Set(this.cosmetics.owned || []);
		const equipped = this.cosmetics.equipped || DEFAULT_LOADOUT;
		const ownsAnyPremium = (this.cosmetics.owned || []).length > 0;

		for (const slot of SLOTS) {
			const items = COSMETICS.filter((c) => c.slot === slot);
			if (!items.length) continue;
			const equippedId = equipped[slot];
			// The slot's bare default (its `none` entry) — "Remove" equips it. Only
			// offer it when something non-default is actually worn in this slot.
			const noneId = DEFAULT_LOADOUT[slot];
			const wornNonDefault = equippedId && equippedId !== noneId && getCosmetic(equippedId)?.visual;

			const head = el('div', { class: 'ps-cos-slot-head' }, [
				el('span', { class: 'ps-cos-slot-name', text: SLOT_LABELS[slot] || slot }),
			]);
			if (wornNonDefault) {
				head.appendChild(el('button', {
					class: 'ps-cos-remove', text: 'Remove', title: `Unequip ${SLOT_LABELS[slot] || slot}`,
					'aria-label': `Unequip ${SLOT_LABELS[slot] || slot}`,
					onclick: () => this._equipCosmetic(noneId),
				}));
			}
			body.appendChild(head);

			const grid = el('div', { class: 'ps-cos-grid' });
			for (const item of items) {
				// Skip the invisible `none` placeholders — "Remove" already covers
				// clearing a slot; a card for "None" would just be noise.
				if (!item.visual) continue;
				const owned = item.tier === 'free' || ownedSet.has(item.id);
				const isEquipped = equippedId === item.id;
				grid.appendChild(this._cosmeticCard(item, { owned, isEquipped }));
			}
			body.appendChild(grid);
		}

		// Footer: an honest pointer. Everyone owns the free pack; premium pieces are
		// earned in the shop. Surface that path so the wardrobe links onward.
		if (!ownsAnyPremium) {
			body.appendChild(el('p', { class: 'ps-cos-hint', text: 'Unlock premium dyes, hats and auras in the shop — they appear here once you own them.' }));
		}
	}

	// One wardrobe card: preview (GLB thumb or colour swatch), name, rarity, and a
	// state-appropriate action — Equipped (current), Equip (owned), or a real Buy
	// action priced in $THREE (locked + purchasable — the W04 boutique). A locked
	// item with no price (shouldn't happen for a premium tier, but guarded) stays
	// inert rather than offering a dead click.
	_cosmeticCard(item, { owned, isEquipped }) {
		const rarity = RARITY_META[item.rarity] || RARITY_META.common;
		const preview = item.thumb
			? el('img', { class: 'ps-cos-thumb', src: item.thumb, alt: '', loading: 'lazy', draggable: 'false' })
			: el('span', { class: 'ps-cos-swatch', style: `background:${item.swatch || '#888'}`, 'aria-hidden': 'true' });

		const buyable = !owned && Number(item.price) > 0;
		const statusText = isEquipped ? 'Equipped'
			: owned ? 'Owned'
			: buyable ? `${Number(item.price).toLocaleString()} $THREE`
			: 'Locked';

		const card = el('div', {
			class: `ps-cos-card ${rarity.cls}${isEquipped ? ' is-equipped' : ''}${owned ? '' : ' is-locked'}`,
		}, [
			el('div', { class: 'ps-cos-preview' }, [
				preview,
				el('span', { class: `ps-cos-rarity ${rarity.cls}`, text: rarity.label }),
				isEquipped ? el('span', { class: 'ps-cos-check', text: '✓', 'aria-hidden': 'true' }) : null,
			]),
			el('span', { class: 'ps-cos-name', text: item.name }),
			el('span', { class: `ps-cos-status${buyable ? ' ps-cos-price' : ''}`, text: statusText }),
		]);

		if (!owned) {
			if (!buyable) {
				card.setAttribute('title', 'Not yet purchasable');
				card.setAttribute('aria-disabled', 'true');
				return card;
			}
			card.setAttribute('role', 'button');
			card.setAttribute('tabindex', '0');
			card.setAttribute('title', `Buy ${item.name} for ${item.price} $THREE`);
			card.setAttribute('aria-label', `Buy ${item.name} for ${item.price} $THREE`);
			const buy = () => this._buyPremium(item, card);
			card.addEventListener('click', buy);
			card.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); buy(); }
			});
			return card;
		}
		// Owned + not equipped → clickable to equip. Equipped → inert (use Remove).
		if (!isEquipped) {
			card.setAttribute('role', 'button');
			card.setAttribute('tabindex', '0');
			card.setAttribute('aria-label', `Equip ${item.name}`);
			const equip = () => this._equipCosmetic(item.id);
			card.addEventListener('click', equip);
			card.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); equip(); }
			});
		} else {
			card.setAttribute('aria-label', `${item.name}, equipped`);
		}
		return card;
	}

	// Buy a locked premium cosmetic with $THREE (W04 boutique): connect wallet →
	// server-priced quote → sign → broadcast → the server re-verifies the
	// confirmed transaction on-chain before granting anything. A fresh 'profile'
	// snapshot (sent by the server on a successful grant) re-renders this panel
	// with the item now owned — no optimistic local mutation.
	async _buyPremium(item, card) {
		if (!this.net || card?.classList.contains('ps-cos-busy')) return;
		card?.classList.add('ps-cos-busy');
		const stageText = {
			connecting: 'Connecting your wallet…',
			pricing: 'Pricing the purchase…',
			signing: 'Approve the purchase in your wallet…',
			broadcasting: 'Submitting on-chain…',
			settling: 'Confirming your unlock…',
		};
		try {
			const res = await buyBoutiqueItem({
				net: this.net,
				item,
				onStage: (stage) => { if (stageText[stage]) this.ui?.toast?.(stageText[stage], 'info'); },
			});
			this.ui?.toast?.(res.text || `Unlocked ${item.name}.`, 'success');
		} catch (err) {
			this.ui?.toast?.(err?.message || `Could not buy ${item.name}.`, 'warn');
		} finally {
			card?.classList.remove('ps-cos-busy');
		}
	}

	// Send the equip intent. The server validates ownership, persists the loadout to
	// the account, re-broadcasts it to peers and echoes a fresh profile — which flows
	// back through setProfile and re-renders this panel, so we don't mutate optimistically
	// (an unowned id would be rejected with a 'cosmetic' notice). Unequip is the same
	// path with the slot's `none` id.
	_equipCosmetic(id) {
		if (!id) return;
		if (this.net?.status && this.net.status !== 'online') {
			this.ui?.toast?.('Reconnecting to the world — your fit will sync in a moment.', 'warn');
			return;
		}
		this.net?.equipCosmetic(id);
	}

	// ---------------------------------------------------------------- cast visual
	_spawnCast(near) {
		const p = this.getPlayer();
		const spot = near.spot;
		// Land the bobber on the near side of the water, between the angler and centre.
		const dx = p.x - spot.x, dz = p.z - spot.z;
		const dl = Math.hypot(dx, dz) || 1;
		const target = new Vector3(spot.x + (dx / dl) * spot.r * 0.55, 0.06, spot.z + (dz / dl) * spot.r * 0.55);
		const hand = new Vector3(p.x, (p.height || 1.6) * 0.62, p.z);

		const g = new Group();
		const bob = new Mesh(
			new SphereGeometry(0.12, 12, 10),
			new MeshStandardMaterial({ color: 0xffffff, emissive: 0x88bbff, emissiveIntensity: 0.5, roughness: 0.4 }),
		);
		g.add(bob);
		const ring = new Mesh(
			new RingGeometry(0.18, 0.28, 24),
			new MeshBasicMaterial({ color: 0xbfeaff, transparent: true, opacity: 0.0, side: DoubleSide }),
		);
		ring.rotation.x = -Math.PI / 2;
		ring.position.copy(target); ring.position.y = 0.06;
		g.add(ring);
		const lineGeo = new BufferGeometry();
		lineGeo.setAttribute('position', new Float32BufferAttribute([hand.x, hand.y, hand.z, target.x, target.y, target.z], 3));
		const line = new Line(lineGeo, new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
		g.add(line);
		this.scene.add(g);

		this._cast = { group: g, bob, ring, line, lineGeo, hand, target, start: this._t, result: null, resolvedAt: 0 };
	}

	_tickCast(dt) {
		const c = this._cast;
		if (!c) return;
		const age = this._t - c.start;
		const p = this.getPlayer();
		const hand = c.hand.set(p.x, (p.height || 1.6) * 0.62, p.z);

		// Fly out (0–0.28s): arc the bobber from hand to target.
		if (age < 0.28) {
			const k = age / 0.28;
			const x = hand.x + (c.target.x - hand.x) * k;
			const z = hand.z + (c.target.z - hand.z) * k;
			const y = hand.y + (c.target.y - hand.y) * k + Math.sin(k * Math.PI) * 1.2;
			c.bob.position.set(x, y, z);
		} else if (!c.result) {
			// Waiting for the bite: gentle bob + a slow ripple.
			c.bob.position.set(c.target.x, c.target.y + Math.sin(age * 4) * 0.05, c.target.z);
			c.ring.material.opacity = 0.25 + Math.sin(age * 4) * 0.12;
			const s = 1 + (age % 1.2);
			c.ring.scale.setScalar(s);
		} else {
			// Resolved.
			if (!c.resolvedAt) {
				c.resolvedAt = this._t;
				if (c.result === 'catch') { c.ring.material.color = new Color(0x9effa6); }
			}
			const ra = this._t - c.resolvedAt;
			if (c.result === 'catch') {
				// Sharp dip then a splash ring out.
				c.bob.position.set(c.target.x, Math.max(-0.1, c.target.y - ra * 1.4), c.target.z);
				c.ring.scale.setScalar(1 + ra * 5);
				c.ring.material.opacity = Math.max(0, 0.5 - ra);
			} else {
				c.bob.position.set(c.target.x, c.target.y + Math.sin(ra * 8) * 0.04, c.target.z);
				c.ring.material.opacity = Math.max(0, 0.25 - ra * 0.6);
			}
			if (ra > 0.6) { this._clearCast(); return; }
		}
		// Keep the line taut between hand and bobber.
		const pos = c.lineGeo.attributes.position;
		pos.setXYZ(0, hand.x, hand.y, hand.z);
		pos.setXYZ(1, c.bob.position.x, c.bob.position.y, c.bob.position.z);
		pos.needsUpdate = true;
	}

	_clearCast() {
		if (!this._cast) return;
		this.scene.remove(this._cast.group);
		this._cast.group.traverse((n) => {
			if (n.isMesh || n.isLine) { n.geometry?.dispose?.(); n.material?.dispose?.(); }
		});
		this._cast = null;
	}

	// ---------------------------------------------------------------- per-frame
	tick(dt) {
		this._t += dt;
		const p = this.getPlayer();

		// Nearest pond + range gate (mirrors the server's fishingSpotInRange).
		const near = nearestFishingSpot(p.x, p.z);
		this._nearSpot = near && near.gap <= 0 ? near : null;
		this._updateAction();

		// Advance the water ripple clock and keep the sparkle's light source in
		// sync with the world's live sun (it moves across the day/night cycle).
		if (this._waterMats.length) {
			const sunDir = this.env?.lights?.sun;
			const sunColor = this.env?.lights?.sunLight?.color;
			for (const mat of this._waterMats) {
				mat.uniforms.uTime.value = this._t;
				if (sunDir) mat.uniforms.uSunDir.value.copy(sunDir).normalize();
				if (sunColor) mat.uniforms.uSunColor.value.copy(sunColor);
			}
		}

		// Pulse the marker ring of whichever pond is nearest so it reads as live.
		if (this._pondGroup) {
			const glow = 0.18 + Math.sin(this._t * 2) * 0.12;
			const nearId = this._nearSpot?.spot.id;
			this._pondGroup.children.forEach((g) => {
				const m = g.userData.marker;
				if (!m) return;
				m.material.opacity = g.userData.spotId === nearId ? glow + 0.25 : glow;
			});
		}

		this._tickCast(dt);
	}

	_updateAction() {
		const near = this._nearSpot;
		if (!near || this._cast) {
			if (!this.actionBtn.hidden) this.actionBtn.hidden = true;
			return;
		}
		const holding = this._activeItem();
		const hasRod = (this.profile?.hotbar || []).some((s) => s.item === 'rod');
		let label;
		if (holding === 'rod') label = '🎣 Cast line';
		else if (hasRod) label = '🎣 Equip rod';
		else label = '🎣 Need a fishing rod';
		this.actionBtn.textContent = label;
		this.actionBtn.classList.toggle('is-disabled', !hasRod);
		this.actionBtn.hidden = false;
	}

	// ---------------------------------------------------------------- fx
	_floatXp(skill, amount) {
		const meta = SKILL_META[skill] || { glyph: '✨' };
		const chip = el('div', { class: 'ps-xp-float', text: `${meta.glyph} +${amount} XP` });
		const r = this.skillsBtn.getBoundingClientRect();
		chip.style.left = `${r.left + r.width / 2}px`;
		chip.style.top = `${r.top}px`;
		document.body.appendChild(chip);
		requestAnimationFrame(() => chip.classList.add('is-up'));
		setTimeout(() => chip.remove(), 1100);
	}

	_celebrate(text) {
		const card = el('div', { class: 'ps-levelup' }, [
			el('div', { class: 'ps-levelup-mark', text: 'LEVEL UP' }),
			el('div', { class: 'ps-levelup-skill', text }),
		]);
		document.body.appendChild(card);
		requestAnimationFrame(() => card.classList.add('is-show'));
		setTimeout(() => { card.classList.remove('is-show'); setTimeout(() => card.remove(), 400); }, 2200);
	}

	_pulse(node) {
		if (!node) return;
		node.classList.remove('ps-pulse');
		void node.offsetWidth; // restart the animation
		node.classList.add('ps-pulse');
	}

	// ---------------------------------------------------------------- teardown
	dispose() {
		this._clearCast();
		if (this._pondGroup) {
			this.scene.remove(this._pondGroup);
			this._pondGroup.traverse((n) => {
				if (n.isMesh || n.isLine) { n.geometry?.dispose?.(); const ms = Array.isArray(n.material) ? n.material : [n.material]; ms.forEach((m) => m?.dispose?.()); }
			});
			this._pondGroup = null;
		}
		this._waterMats = [];
		this.root?.remove();
		document.querySelectorAll('.ps-xp-float, .ps-levelup').forEach((n) => n.remove());
	}
}
