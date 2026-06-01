// GameRoom — authoritative state for a Kintara isometric realm (Mainland).
//
// Same philosophy as WalkRoom: the server owns the truth. Clients send intent
// ('step', 'gather', 'attack', 'invMove', 'equip', 'bankDeposit', ...) and the
// server validates every one (walkability, adjacency, tool/skill gates, rate
// limits) before mutating the shared state. A malicious client can desync its
// own view but can't move through walls, gather depleted nodes, or mint gold.
//
// Movement is tile-stepped: the client paths locally and asks to step one tile
// at a time. The server accepts a step only if the target is in-bounds, within
// one tile (8-way) of the player's current tile, and walkable. That makes
// teleport-cheating impossible without a separate max-step heuristic.

import { Room } from '@colyseus/core';

import { GameState, GamePlayer, ResourceNode, Mob, Slot, Tombstone } from '../schemas/game.js';
import { REALMS, DEFAULT_REALM, isBlocked, inBounds, realmLayout, fishingSpotNear } from './realms.js';
import { runCommand } from './commands.js';
import { STACKABLE_ITEMS, isEdible, healValue, isMount, mountStepMs, rollLoot, itemLabel, clientItemRegistry, cookBurnChance } from '../items.js';
import { cleanAvatarUrl } from '../avatar-url.js';
import { loadPlayer, savePlayer } from '../playerStore.js';
import {
	TUTORIAL_STEPS, TUTORIAL_REWARD, GUIDE_DONE, BADGES, DAILY_POOL,
	dailyDef, nextResetAt, freshQuestState, normalizeQuestState, currentStep,
} from '../quests.js';

// One GameRoom instance == one realm. The realm is selected by the room
// definition (`options.realm`, see index.js); every geometry / spawn / flag
// lookup reads `this.realm`, so the same class serves Mainland, Wilderness,
// Whisperwood, and Pond. A realm's `danger` flag is what gates death-bag drops
// (Task 02): dying in a danger realm spills part of your pack into a tombstone.

const MAX_CLIENTS_PER_ROOM = 50;
const PATCH_RATE_MS = 1000 / 15;
const SIM_TICK_MS = 250; // respawns, healing, death timers

const INV_SIZE = 24;
const HOTBAR_SIZE = 6;
const MAX_STACK = 999;
const BANK_SIZE = 48;

// Which items stack is owned by the item registry (items.js) so cooking, loot,
// banking, and the shop all agree. cookedFish + potions land here automatically.
const STACKABLE = STACKABLE_ITEMS;
const TOOLS = new Set(['axe', 'pickaxe', 'rod', 'hammer', 'sword']);

// The five trainable skills, broadcast as integer levels on GamePlayer. The
// order here is the canonical display order the client renders. LEVEL_CAP is the
// shared ceiling — surfaced to the client so the UI never hard-codes it.
const SKILLS = ['combat', 'woodcutting', 'mining', 'fishing', 'cooking'];
const LEVEL_CAP = 99;

// Per-action rate limits (messages/sec) — generous vs. legit play, tight vs.
// floods. Movement is the hot path so it gets the most headroom. Chat sits low:
// a few lines a second is plenty for conversation and turns a scripted flood into
// dropped messages (with feedback — see _handleChat).
const RATE_LIMITS = { step: 20, gather: 6, attack: 6, fish: 6, cook: 6, consume: 6, ui: 30, chat: 4 };

// World chat: hard cap on a single message. Longer messages are rejected (not
// silently truncated) so the sender knows their line didn't go through whole.
const MAX_CHAT_LEN = 200;

// Gathering: which tool + skill each node kind needs, and what it yields.
const NODE_RULES = {
	tree: { tool: 'axe', skill: 'woodcutting', item: 'wood', respawnMs: 15000 },
	rock: { tool: 'pickaxe', skill: 'mining', item: 'stone', respawnMs: 18000 },
	coal: { tool: 'pickaxe', skill: 'mining', item: 'coal', respawnMs: 22000 },
};

const GATHER_COOLDOWN_MS = 900; // time between successful harvests
const ATTACK_COOLDOWN_MS = 700;
const COOK_COOLDOWN_MS = 1200; // pace between cook actions
const COOK_BATCH_MAX = 5; // raw fish processed per cook action (one cooldown)
const COOK_XP = 12; // cooking XP per fish successfully cooked (burns yield none)
const CONSUME_COOLDOWN_MS = 1100; // pace between bites — no instant heal-spam
const FISH_COOLDOWN_MS = 1500; // per-cast reel time — sets casting cadence on the real clock
// Catch curve: chance rises with fishing level and the spot's quality, hard-capped
// so even the richest water is never a guaranteed haul.
const FISH_BASE_CHANCE = 0.40; // catch chance at level 1 on an average (quality 1) spot
const FISH_CHANCE_PER_LEVEL = 0.005; // +0.5% per fishing level
const FISH_CHANCE_CAP = 0.95;
const RESPAWN_PLAYER_MS = 4000;
const RESPAWN_MOB_MS = 8000;

// Movement speed is server-authoritative (Task 09). On foot, a player may take a
// step no more often than every ON_FOOT_STEP_MS; mounts lower this floor via the
// item registry (items.js `mount.stepMs`), so riding is visibly faster without
// ever trusting a client-claimed speed.
const ON_FOOT_STEP_MS = 140;

// Death-bags (danger realms only). A tombstone lives for TOMBSTONE_TTL_MS, then
// crumbles server-side (and the client view follows). For the first
// TTL - GRACE window only the owner may loot it; once inside the final
// TOMBSTONE_GRACE_MS before expiry, anyone standing adjacent may take what's
// left — a fair "claim it fast or share it" rule.
const TOMBSTONE_TTL_MS = 120000; // 2 minutes
const TOMBSTONE_GRACE_MS = 45000; // last 45s: open to anyone adjacent
const FOUNTAIN_HEAL_PER_TICK = 6; // hp restored per sim tick near the fountain
const REGEN_PER_TICK = 1; // passive hp regen out of combat

// XP curve: cumulative XP required for a level. Early levels fly by, later
// ones grind — matches the guide ("early levels come quickly").
function levelForXp(xp) {
	// level n requires 50 * n^1.8 cumulative XP. Cap at 99.
	let lvl = 1;
	while (lvl < LEVEL_CAP && xp >= Math.floor(50 * Math.pow(lvl, 1.8))) lvl++;
	return lvl;
}

// Inverse of levelForXp: the cumulative XP required to *be* at a given level.
// Level 1 starts at 0; reaching level L needs 50 * (L-1)^1.8 cumulative XP — the
// same threshold levelForXp compares against. Used to send the client the
// boundaries of its current level so it can draw an exact progress bar without
// re-deriving the curve (one source of truth for the formula).
function xpForLevel(level) {
	const lvl = Math.max(1, Math.min(LEVEL_CAP, level | 0));
	return lvl <= 1 ? 0 : Math.floor(50 * Math.pow(lvl - 1, 1.8));
}

function clean(str, maxLen) {
	if (typeof str !== 'string') return '';
	// Strip control chars (incl. NUL/escape), collapse whitespace, trim, cap.
	return str.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function pickPlayerColor(sessionId) {
	let h = 0;
	for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
	return hslToHex((h % 360) / 360, 0.65, 0.6);
}
function hslToHex(h, s, l) {
	const k = (n) => (n + h * 12) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n) => Math.round((l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * 255);
	return (f(0) << 16) | (f(8) << 8) | f(4);
}

export class GameRoom extends Room {
	constructor() {
		super();
		this.maxClients = MAX_CLIENTS_PER_ROOM;
		// Off-schema, server-only per-player data: XP totals, private bank, and
		// per-action cooldown/rate windows. None of this needs to sync to peers.
		this.priv = new Map(); // sessionId -> { xp, bank: Slot[], cooldowns, rate }
	}

	onCreate(options) {
		// The room definition pins which realm this instance hosts. An unknown or
		// missing name falls back to the default realm so the room never boots into
		// an undefined map.
		const name = REALMS[options?.realm] ? options.realm : DEFAULT_REALM;
		this.realm = REALMS[name];
		// Monotonic id source for tombstones spawned by this room.
		this._tombSeq = 0;

		this.setState(new GameState());
		this.state.realm = this.realm.name;
		this.setPatchRate(PATCH_RATE_MS);
		this.autoDispose = true;

		this._seedWorld();

		this.onMessage('step', (c, p) => this._handleStep(c, p));
		this.onMessage('gather', (c, p) => this._handleGather(c, p));
		this.onMessage('attack', (c, p) => this._handleAttack(c, p));
		this.onMessage('fish', (c, p) => this._handleFish(c, p));
		this.onMessage('cook', (c, p) => this._handleCook(c, p));
		this.onMessage('consume', (c, p) => this._handleConsume(c, p));
		this.onMessage('invMove', (c, p) => this._handleInvMove(c, p));
		this.onMessage('equip', (c, p) => this._handleEquip(c, p));
		this.onMessage('bankDeposit', (c, p) => this._handleBank(c, p, 'deposit'));
		this.onMessage('bankWithdraw', (c, p) => this._handleBank(c, p, 'withdraw'));
		this.onMessage('bankOpen', (c) => this._sendBank(c));
		this.onMessage('skills', (c) => this._sendSkills(c));
		this.onMessage('tombLoot', (c, p) => this._handleTombLoot(c, p));
		this.onMessage('setAvatar', (c, p) => this._handleAvatar(c, p));
		// Mounts (Task 09): use the active hotbar item (ride a mount), leave the saddle,
		// and a generic slash-command channel (Task 13's chat forwards /dismount here).
		this.onMessage('use', (c, p) => this._handleUse(c, p));
		this.onMessage('dismount', (c) => this._handleDismount(c));
		this.onMessage('command', (c, p) => this._handleCommand(c, p));
		// Quests (tutorial + dailies). The client only ever requests a snapshot,
		// talks to the guide, or asks to turn a finished quest in — all progress is
		// driven from the real action hooks below, never from a client claim.
		this.onMessage('questOpen', (c) => this._sendQuests(c));
		this.onMessage('npcTalk', (c, p) => this._handleNpcTalk(c, p));
		this.onMessage('questTurnIn', (c, p) => this._handleTurnIn(c, p));
		this.onMessage('chat', (c, p) => this._handleChat(c, p));

		this.setSimulationInterval(() => this._tick(), SIM_TICK_MS);
	}

	_seedWorld() {
		for (const n of this.realm.nodes) {
			const node = new ResourceNode();
			node.id = n.id;
			node.kind = n.kind;
			node.tx = n.tx;
			node.ty = n.ty;
			this.state.nodes.set(n.id, node);
		}
		for (const m of this.realm.mobs) {
			const mob = new Mob();
			mob.id = m.id;
			mob.kind = m.kind;
			mob.tx = m.tx;
			mob.ty = m.ty;
			mob.hp = mob.maxHp = m.hp;
			this.state.mobs.set(m.id, mob);
		}
	}

	onJoin(client, options) {
		const name = clean(options?.name, 24) || `guest-${client.sessionId.slice(0, 4)}`;
		// Stable account key: the wallet address / persistent guest id the client
		// sends (Task 16), falling back to the ephemeral session id when absent.
		// Tutorial completion, daily assignment, progress, and badges are keyed to
		// it so they survive a disconnect/reconnect.
		const playerId = clean(options?.pid, 80) || client.sessionId;
		const now = Date.now();
		const saved = loadPlayer(playerId);
		const quests = normalizeQuestState(saved?.quests, playerId, now) || freshQuestState(playerId, now);

		const p = new GamePlayer();
		p.id = client.sessionId;
		p.name = name;
		p.color = pickPlayerColor(client.sessionId);
		p.tx = this.realm.spawn.tx;
		p.ty = this.realm.spawn.ty;

		// Fixed-length inventory + hotbar so slot indices are stable drag targets.
		for (let i = 0; i < INV_SIZE; i++) p.inv.push(new Slot());
		for (let i = 0; i < HOTBAR_SIZE; i++) p.hotbar.push(new Slot());

		// Starter kit — the four gathering tools + a basic sword, mirroring the
		// guide's tutorial hand-out so a fresh player can exercise the full loop
		// immediately. Tools go straight onto the hotbar.
		const kit = ['axe', 'pickaxe', 'rod', 'sword'];
		for (let i = 0; i < kit.length; i++) {
			p.hotbar[i].item = kit[i];
			p.hotbar[i].qty = 1;
		}
		p.activeSlot = 0;
		// The avatar the player picked on /play (or a create→play handoff) rides in
		// as a join option, validated against the same host allow-list as /walk so
		// every peer renders them as their real avatar, not the default capsule.
		p.cosmetic = cleanAvatarUrl(options?.avatar);
		p.badges = (quests.badges || []).join(',');
		p.tsServer = now;
		this.state.players.set(client.sessionId, p);

		this.priv.set(client.sessionId, {
			playerId,
			// One XP bucket per trainable skill. Levels are broadcast on the schema;
			// raw XP stays server-side and is only ever sent to its owner.
			xp: Object.fromEntries(SKILLS.map((s) => [s, 0])),
			bank: Array.from({ length: BANK_SIZE }, () => ({ item: '', qty: 0 })),
			cooldowns: { gather: 0, attack: 0, fish: 0, cook: 0, consume: 0, step: 0 },
			rate: new Map(),
			quests,
		});

		// Hand the client the full static realm layout (geometry, fountain, bank
		// counter, fishing/cooking tiles, safe camp, portals, and the
		// safe/pvp/danger flags) so it renders exactly the tiles the server treats
		// as solid/interactive — and knows whether this realm drops death-bags.
		// Dynamic objects (nodes, mobs, players, tombstones) arrive via synced
		// schema state instead.
		client.send('realm', realmLayout(this.realm));
		// Item catalogue (icons, labels, mount tuning) so the hotbar can label items and
		// the scene can render the right steed. Static — sent once per join.
		client.send('items', clientItemRegistry());
		// Hand over the player's quest state (tutorial step, today's dailies +
		// progress, reset countdown, earned badges) so the quest panel and the
		// guide's "!"/"?" marker render immediately on entry.
		this._sendQuests(client);

		console.log(`[${this.realm.name} ${this.roomId}] +join ${name} (n=${this.state.players.size})`);
	}

	onLeave(client) {
		this._persistPlayer(client.sessionId);
		this.state.players.delete(client.sessionId);
		this.priv.delete(client.sessionId);
	}

	onDispose() {
		console.log(`[${this.realm.name} ${this.roomId}] disposed`);
	}

	// ----- movement --------------------------------------------------------

	_handleStep(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'step')) return;
		if (!payload || typeof payload !== 'object') return;

		const tx = payload.tx | 0;
		const ty = payload.ty | 0;
		if (!Number.isFinite(payload.tx) || !Number.isFinite(payload.ty)) return;

		// One tile, 8-way, no teleporting through anything.
		const dx = Math.abs(tx - p.tx);
		const dy = Math.abs(ty - p.ty);
		if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) return;
		if (!this._isWalkable(tx, ty)) return;
		// Don't allow cutting a diagonal between two blocked corners.
		if (dx === 1 && dy === 1 && (!this._isWalkable(tx, p.ty) && !this._isWalkable(p.tx, ty))) return;

		// Server-enforced step floor (Task 09): on foot you step no faster than
		// ON_FOOT_STEP_MS; a mount lowers the floor (items.js) for visibly faster but
		// still authoritative travel. Early steps are dropped and the client self-paces
		// to match, so a client claiming mount speed without a mount gains nothing.
		const sPriv = this.priv.get(client.sessionId);
		const sNow = Date.now();
		const stepFloor = p.mounted ? (mountStepMs(p.mount) || ON_FOOT_STEP_MS) : ON_FOOT_STEP_MS;
		if (sPriv && sNow < (sPriv.cooldowns.step || 0)) return;
		if (sPriv) sPriv.cooldowns.step = sNow + stepFloor;

		p.tx = tx;
		p.ty = ty;
		if (typeof payload.yaw === 'number' && Number.isFinite(payload.yaw)) p.yaw = payload.yaw;
		p.motion = 'walk';
		p.tsServer = Date.now();
		// Tutorial: the very first step is simply learning to walk.
		this._questProgress(client, { kind: 'move', n: 1 });
	}

	_isWalkable(tx, ty) {
		if (!inBounds(this.realm, tx, ty)) return false;
		if (isBlocked(this.realm, tx, ty)) return false;
		// Fixed NPCs occupy their tile; players stand adjacent to talk.
		for (const n of this.realm.npcs || []) {
			if (n.tx === tx && n.ty === ty) return false;
		}
		// Non-depleted resource nodes occupy their tile.
		for (const [, n] of this.state.nodes) {
			if (!n.depleted && n.tx === tx && n.ty === ty) return false;
		}
		// Living mobs occupy their tile.
		for (const [, m] of this.state.mobs) {
			if (!m.dead && m.tx === tx && m.ty === ty) return false;
		}
		return true;
	}

	// ----- gathering -------------------------------------------------------

	_handleGather(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		// Mounted players ride; they can't swing a tool. Dismount to harvest. (Combat
		// stays allowed while mounted — cavalry can fight.)
		if (p.mounted) { client.send('notice', { kind: 'mount', text: 'Dismount before you gather.' }); return; }
		if (!this._rateOk(client.sessionId, 'gather')) return;
		const node = this.state.nodes.get(String(payload?.id ?? ''));
		if (!node || node.depleted) return;

		const priv = this.priv.get(client.sessionId);
		const now = Date.now();
		if (now < priv.cooldowns.gather) return;

		if (!this._adjacent(p, node)) return;

		const rule = NODE_RULES[node.kind];
		if (!rule) return;

		// Must have the right tool equipped on the active hotbar slot.
		const active = p.hotbar[p.activeSlot];
		if (!active || active.item !== rule.tool) {
			client.send('notice', { kind: 'tool', text: `Equip a ${rule.tool} to gather this.` });
			return;
		}

		// Award the resource. _addItem returns the quantity that DIDN'T fit, so a
		// nonzero leftover on a single item means the backpack is full.
		const leftover = this._addItem(p, rule.item, 1);
		if (leftover >= 1) {
			client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
			return;
		}
		let bonusCoal = false;
		if (node.kind === 'rock' && Math.random() < 0.15) { this._addItem(p, 'coal', 1); bonusCoal = true; }

		this._grantXp(client, p, rule.skill, 8 + Math.floor(Math.random() * 5));
		node.depleted = true;
		node.respawnAt = now + rule.respawnMs;
		priv.cooldowns.gather = now + GATHER_COOLDOWN_MS;
		p.tsServer = now;
		// Quest progress: the resource just harvested (plus any bonus coal from a
		// rock) counts toward gathering tutorial steps and dailies.
		this._questProgress(client, { kind: 'gather', item: rule.item, n: 1 });
		if (bonusCoal) this._questProgress(client, { kind: 'gather', item: 'coal', n: 1 });
	}

	// ----- fishing ---------------------------------------------------------

	// Cast a line. Validates (alive, rod equipped, beside fishable water, off
	// cooldown, room in the pack) then rolls a catch against fishing skill + spot
	// quality. Every cast — hit or miss — arms the per-cast cooldown so casting
	// has cadence on the real clock; the client renders the line/bobber while the
	// authoritative result rides back as a notice.
	_handleFish(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'fish')) return;

		const priv = this.priv.get(client.sessionId);
		const now = Date.now();
		if (now < priv.cooldowns.fish) return; // still reeling in the previous cast

		// Need the rod on the active hotbar slot.
		const active = p.hotbar[p.activeSlot];
		if (!active || active.item !== 'rod') {
			client.send('notice', { kind: 'tool', text: 'Equip a fishing rod to cast.' });
			return;
		}

		// Need fishable water within one tile (8-way, including the player's tile).
		const spot = fishingSpotNear(this.realm, p.tx, p.ty);
		if (!spot) {
			client.send('notice', { kind: 'fish', text: 'Move next to the water to cast.' });
			return;
		}

		// Don't let a catch evaporate: reject the cast up front when there's no room
		// for even one fish — same notice the gather path uses.
		if (!this._hasRoomFor(p, 'fish')) {
			client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
			return;
		}

		// Arm the cadence on the real cooldown clock (no fake timers).
		priv.cooldowns.fish = now + FISH_COOLDOWN_MS;

		const lvl = p.fishing;
		const quality = spot.quality || 1;
		const chance = Math.min(
			FISH_CHANCE_CAP,
			(FISH_BASE_CHANCE + FISH_CHANCE_PER_LEVEL * (lvl - 1)) * quality,
		);

		if (Math.random() < chance) {
			// Yield: usually one fish, with a skill/quality-scaled shot at a double haul.
			const doubleChance = Math.min(0.45, 0.02 * (lvl - 1) * quality);
			const want = 1 + (Math.random() < doubleChance ? 1 : 0);
			const leftover = this._addItem(p, 'fish', want);
			const caught = want - leftover;
			if (caught <= 0) {
				// Pack filled between the room check and now — be honest, no phantom catch.
				client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
				p.tsServer = now;
				return;
			}
			// XP scales gently with level + quality so richer water trains faster.
			const xp = Math.round((10 + Math.floor(Math.random() * 6) + lvl * 0.3) * quality) * caught;
			this._grantXp(client, p, 'fishing', xp);
			client.send('notice', { kind: 'fish', text: caught > 1 ? `Caught ${caught} fish!` : 'Caught a fish.' });
		} else {
			// A miss still teaches the cast — a small XP trickle keeps progression smooth.
			this._grantXp(client, p, 'fishing', 2);
			client.send('notice', { kind: 'fish', text: 'The fish got away.' });
		}
		p.tsServer = now;
	}

	// Is there room in the backpack for at least one of `item`? For stackables, an
	// empty slot OR a non-full existing stack counts; otherwise an empty slot.
	_hasRoomFor(p, item) {
		if (STACKABLE.has(item)) {
			for (const s of p.inv) {
				if (!s.item) return true;
				if (s.item === item && s.qty < MAX_STACK) return true;
			}
			return false;
		}
		return p.inv.some((s) => !s.item);
	}

	// ----- cooking & consumables -------------------------------------------

	// Cook raw fish into cooked fish at a Roast Pit. Validates the player is
	// alive, standing on/next to a cooking tile of THIS realm, and actually holds
	// raw fish; then converts up to a small batch in one action (one cooldown).
	// Low cooking levels burn some fish — the raw fish is consumed with no result
	// and the player is told honestly; burns grant no XP. Never loses or dupes an
	// item: the cooked result is reserved (pack space checked) before the raw fish
	// is spent.
	_handleCook(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'cook')) return;

		const priv = this.priv.get(client.sessionId);
		const now = Date.now();
		if (now < priv.cooldowns.cook) return;

		if (!this._atCookingSpot(p)) {
			client.send('notice', { kind: 'cook', text: 'Stand by the Roast Pit to cook.' });
			return;
		}

		const fish = this._findItemSlot(p, 'fish');
		if (!fish) {
			client.send('notice', { kind: 'cook', text: 'You have no raw fish to cook.' });
			return;
		}

		const want = Math.max(1, Math.min(COOK_BATCH_MAX, payload?.qty | 0 || 1));
		const level = p.cooking;
		let cooked = 0;
		let burned = 0;
		for (let i = 0; i < want; i++) {
			const slot = fish.slot;
			if (slot.item !== 'fish' || slot.qty <= 0) break; // stack exhausted
			if (Math.random() < cookBurnChance(level)) {
				// Burned: the raw fish is gone, nothing to store, no XP.
				slot.qty -= 1;
				if (slot.qty === 0) slot.item = '';
				burned++;
				continue;
			}
			// Success: reserve pack space for the cooked fish BEFORE spending the raw
			// one. If the pack is full, stop the batch with no item lost.
			const leftover = this._addItem(p, 'cookedFish', 1);
			if (leftover >= 1) {
				if (cooked === 0 && burned === 0) {
					client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
					return;
				}
				break;
			}
			slot.qty -= 1;
			if (slot.qty === 0) slot.item = '';
			this._grantXp(client, p, 'cooking', COOK_XP);
			cooked++;
		}

		if (cooked === 0 && burned === 0) return;
		priv.cooldowns.cook = now + COOK_COOLDOWN_MS;
		p.tsServer = now;

		// Honest result: report exactly what the fire produced.
		const parts = [];
		if (cooked) parts.push(`Cooked ${cooked} fish`);
		if (burned) parts.push(`burned ${burned}`);
		client.send('cooked', { cooked, burned, level: p.cooking });
		client.send('notice', { kind: cooked ? 'cook' : 'burn', text: `${parts.join(', ')}.` });
	}

	// Eat an edible item (cooked fish, potions) from a referenced inv/hotbar slot
	// to restore HP. Server-authoritative: validates the slot really holds an
	// edible item, refuses at full health (so food is never silently wasted),
	// heals up to maxHp (never over), consumes one from the stack, and applies a
	// short cooldown. Works from both the backpack and the hotbar.
	_handleConsume(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'consume')) return;

		const priv = this.priv.get(client.sessionId);
		const now = Date.now();
		if (now < priv.cooldowns.consume) return;

		const ref = this._resolveSlot(p, payload?.slot);
		if (!ref) return;
		const slot = ref.slot;
		if (!slot.item || !isEdible(slot.item)) {
			client.send('notice', { kind: 'eat', text: 'That can’t be eaten.' });
			return;
		}
		if (p.hp >= p.maxHp) {
			client.send('notice', { kind: 'eat', text: 'You’re already at full health.' });
			return;
		}

		const before = p.hp;
		p.hp = Math.min(p.maxHp, p.hp + healValue(slot.item));
		slot.qty -= 1;
		if (slot.qty === 0) slot.item = '';
		priv.cooldowns.consume = now + CONSUME_COOLDOWN_MS;
		p.tsServer = now;
		client.send('notice', { kind: 'eat', text: `+${p.hp - before} HP.` });
	}

	// True if the player is on or directly adjacent to any cooking tile (the Roast
	// Pit) of the current realm — you stand by the fire, not necessarily on it.
	_atCookingSpot(p) {
		const tiles = this.realm.cooking || [];
		for (const t of tiles) {
			if (Math.abs(p.tx - t.tx) <= 1 && Math.abs(p.ty - t.ty) <= 1) return true;
		}
		return false;
	}

	// Find a live slot holding `item`: the active hotbar slot first (what you're
	// "holding"), then the rest of the hotbar, then the backpack. Null if none.
	_findItemSlot(p, item) {
		const active = p.hotbar[p.activeSlot];
		if (active && active.item === item && active.qty > 0) return { slot: active };
		for (const s of p.hotbar) if (s.item === item && s.qty > 0) return { slot: s };
		for (const s of p.inv) if (s.item === item && s.qty > 0) return { slot: s };
		return null;
	}

	// ----- combat ----------------------------------------------------------

	_handleAttack(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'attack')) return;
		const mob = this.state.mobs.get(String(payload?.id ?? ''));
		if (!mob || mob.dead) return;

		const priv = this.priv.get(client.sessionId);
		const now = Date.now();
		if (now < priv.cooldowns.attack) return;
		if (!this._adjacent(p, mob)) return;

		// Damage scales with combat level; a sword on the active slot adds a flat
		// bonus. Small variance keeps fights from feeling mechanical.
		const hasSword = p.hotbar[p.activeSlot]?.item === 'sword';
		const base = 4 + Math.floor(p.combat * 0.8) + (hasSword ? 6 : 0);
		const dmg = base + Math.floor(Math.random() * 4);
		mob.hp = Math.max(0, mob.hp - dmg);
		mob.hitTs = now;
		priv.cooldowns.attack = now + ATTACK_COOLDOWN_MS;

		if (mob.hp === 0) {
			mob.dead = true;
			mob.respawnAt = now + RESPAWN_MOB_MS;
			const reward = 5 + Math.floor(Math.random() * 6);
			p.gold = Math.min(0xffffffff, p.gold + reward);
			this._grantXp(client, p, 'combat', 14 + Math.floor(Math.random() * 8));
			client.send('notice', { kind: 'kill', text: `Defeated ${mob.kind} (+${reward}g).` });
			// Task 09: roll the mob's loot table — materials and, rarely, a ridable mount.
			this._awardLoot(client, p, mob);
			// Quest progress: a defeated foe counts toward combat tutorial + dailies.
			this._questProgress(client, { kind: 'combat', n: 1 });
		}
		p.tsServer = now;
	}

	// ----- mounts & loot ---------------------------------------------------

	// Roll a slain mob's loot table and hand the killer their winnings. Mounts are
	// rare; everything else is gathered material. Items go to the pack (mounts prefer
	// a free HOTBAR slot so they're immediately rideable); anything that doesn't fit
	// spills into a ground bag on the mob's tile instead of vanishing — loot is never
	// silently lost on a full pack.
	_awardLoot(client, p, mob) {
		const drops = rollLoot(mob.kind);
		if (!drops.length) return;
		const spoils = []; // non-mount lines for the loot toast
		const overflow = []; // Slots that didn't fit anywhere → ground bag
		let mount = null; // { label, bagged } when a mount drops
		for (const d of drops) {
			const left = this._giveLoot(p, d.item, d.qty);
			const got = d.qty - left;
			if (isMount(d.item)) {
				if (got > 0 || left > 0) mount = { label: itemLabel(d.item), bagged: left > 0 };
			} else if (got > 0) {
				spoils.push(got > 1 ? `${got}× ${itemLabel(d.item)}` : itemLabel(d.item));
			}
			if (left > 0) overflow.push(new Slot(d.item, left));
		}
		if (overflow.length) this._spawnLootBag(p, mob.tx, mob.ty, overflow);

		if (mount) {
			const where = mount.bagged ? 'It dropped into the bag at your feet.' : 'It’s on your hotbar — ride out!';
			client.send('notice', { kind: 'mount', text: `The ${mob.kind} dropped a ${mount.label}! ${where}` });
		}
		if (spoils.length) client.send('notice', { kind: 'loot', text: `Looted ${spoils.join(', ')}.` });
		if (overflow.length && !(mount && mount.bagged)) {
			client.send('notice', { kind: 'full', text: 'Pack full — extra loot waits in a bag at your feet.' });
		}
	}

	// Give looted items to a player. Mounts are seated on a free HOTBAR slot first
	// (there is no inv→hotbar mover yet, and a mount you can't reach is useless),
	// then the backpack; everything else goes straight to the backpack. Returns the
	// quantity that didn't fit anywhere.
	_giveLoot(p, item, qty) {
		if (isMount(item)) {
			let placed = 0;
			for (const s of p.hotbar) {
				if (placed >= qty) break;
				if (!s.item) { s.item = item; s.qty = 1; placed++; }
			}
			if (placed >= qty) return 0;
			return this._addItem(p, item, qty - placed);
		}
		return this._addItem(p, item, qty);
	}

	// Spill overflow loot into a ground bag on (tx,ty) owned by the killer — the same
	// Tombstone vessel + tombLoot recovery path used by death-bags, so loot never
	// vanishes on a full pack and the client renders/recovers it identically.
	_spawnLootBag(p, tx, ty, slots) {
		const now = Date.now();
		const bag = new Tombstone();
		bag.id = `loot_${this.realm.name}_${p.id}_${++this._tombSeq}`;
		bag.owner = p.id;
		bag.ownerName = p.name;
		bag.tx = tx;
		bag.ty = ty;
		bag.expiresAt = now + TOMBSTONE_TTL_MS;
		for (const s of slots) bag.items.push(s);
		this.state.tombstones.set(bag.id, bag);
		return bag.items.length;
	}

	// Use the active hotbar item (or an explicit slot). Today that rides a mount; the
	// registry decides what "use" means per item, so future usable items slot in here
	// without a new intent. A stray click on a non-usable item is a harmless no-op.
	_handleUse(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		let i = p.activeSlot;
		if (payload && Number.isInteger(payload.slot)) i = payload.slot | 0;
		if (i < 0 || i >= HOTBAR_SIZE) return;
		const slot = p.hotbar[i];
		if (!slot || !slot.item) return;
		if (isMount(slot.item)) {
			p.activeSlot = i; // hold the reins
			this._mount(client, p, slot.item);
		}
	}

	// Mount up: flip to the faster server-enforced cadence and record the steed so
	// peers render it. Re-mounting the same steed is a no-op; swapping steeds just
	// changes which creature you ride.
	_mount(client, p, item) {
		if (p.mounted && p.mount === item) return;
		p.mounted = true;
		p.mount = item;
		p.tsServer = Date.now();
		client.send('notice', { kind: 'mount', text: `Mounted your ${itemLabel(item)}.` });
	}

	// Leave the saddle, back to on-foot speed. Idempotent and friendly when already
	// on foot. Routed to by the 'dismount' intent and the /dismount command.
	_handleDismount(client) {
		const p = this.state.players.get(client.sessionId);
		if (!p) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		if (!p.mounted) { client.send('notice', { kind: 'mount', text: 'You’re not mounted.' }); return; }
		const was = p.mount;
		p.mounted = false;
		p.mount = '';
		p.tsServer = Date.now();
		client.send('notice', { kind: 'mount', text: `Dismounted your ${itemLabel(was)}.` });
	}

	// ----- world chat ------------------------------------------------------

	// Realm-wide chat. This room IS one realm, so a broadcast reaches exactly the
	// players who can see each other — chat never leaks across realms/instances.
	// Leading-'/' messages are handed to the command router instead of broadcast
	// (Task 13); everything else is sanitized, length-capped, rate-limited, and
	// echoed to everyone (the sender included, so their own line is driven by the
	// same authoritative event their peers receive).
	_handleChat(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p) return;
		const now = Date.now();
		// Sanitize up front (strip control chars, collapse whitespace, trim). Cap
		// generously here so we can still measure "too long" against MAX_CHAT_LEN
		// rather than silently truncating to it.
		const text = clean(payload?.text, 2000);
		if (!text) return;

		// Slash-commands bypass chat entirely — the command router has its own
		// validation and rate limit, so route before charging a chat token.
		if (text[0] === '/') { this._handleCommand(client, { text }); return; }

		// Flood control. Tell the sender (throttled, so a flood can't be amplified
		// into a flood of error replies) instead of dropping silently.
		if (!this._rateOk(client.sessionId, 'chat')) {
			const priv = this.priv.get(client.sessionId);
			if (priv && now - (priv.chatNoticeAt || 0) > 1500) {
				priv.chatNoticeAt = now;
				client.send('chat', { system: true, kind: 'error', text: 'You’re sending messages too fast.', ts: now });
			}
			return;
		}

		// Length cap — reject rather than truncate so nothing is sent half-said.
		if (text.length > MAX_CHAT_LEN) {
			client.send('chat', { system: true, kind: 'error', text: `Message too long. Keep it under ${MAX_CHAT_LEN} characters.`, ts: now });
			return;
		}

		this.broadcast('chat', { id: client.sessionId, name: p.name, text, ts: now });
	}

	// Slash-command channel. Task 13's chat forwards any leading-'/' message here; the
	// game HUD also calls it directly. Handles /dismount and /mount today; unknown
	// commands get an honest reply rather than silence.
	_handleCommand(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const text = clean(payload?.text, 64);
		const cmd = text.replace(/^\//, '').split(/\s+/)[0].toLowerCase();

		// /mount needs the hotbar + item registry, so it stays inline; every other
		// command is dispatched through the Task 13 registry — the single source of
		// truth for /help, /who, /pickup, /lock, /unlock, /dismount.
		if (cmd === 'mount') {
			const slot = p.hotbar[p.activeSlot];
			if (slot && isMount(slot.item)) this._mount(client, p, slot.item);
			else client.send('notice', { kind: 'mount', text: 'Select a mount on your hotbar first.' });
			return;
		}

		const reply = runCommand({ room: this, client, player: p }, text);
		// Command replies render as system chat lines — distinct from player chat —
		// so multi-line output (/help, /who) stays readable instead of flashing past
		// as a toast. A null reply means the handler already answered (e.g. /dismount).
		if (reply && reply.text) {
			client.send('chat', { system: true, kind: reply.kind || 'system', text: reply.text, ts: Date.now() });
		}
	}

	// ----- structure actions (Task 07 firepit/shack; invoked by /pickup /lock /unlock) ----
	// These operate on real synced state.structures and never throw on the empty
	// case: until Task 07's building action places a structure the map is empty, so
	// they honestly report "nothing placed" — and the moment structures exist they
	// work unchanged. Only the owner can act, and only on a structure beside them.

	pickupStructure(p) {
		const owned = [];
		for (const [, s] of this.state.structures) if (s.owner === p.id) owned.push(s);
		if (!owned.length) return { text: 'You have not placed a firepit or shack to pick up.', kind: 'error' };
		const near = owned.filter((s) => this._adjacent(p, s)).sort((a, b) => this._d2(p, a) - this._d2(p, b));
		if (!near.length) {
			const where = owned.map((s) => `  • ${s.kind} at (${s.tx}, ${s.ty})`).join('\n');
			return { text: `Stand next to one of your structures to pick it up:\n${where}`, kind: 'info' };
		}
		const s = near[0];
		if (s.locked) return { text: `Your ${s.kind} is locked — /unlock it first.`, kind: 'error' };
		this.state.structures.delete(s.id);
		return { text: `Picked up your ${s.kind}.`, kind: 'info' };
	}

	setStructureLock(p, locked) {
		let target = null;
		for (const [, s] of this.state.structures) {
			if (s.owner === p.id && this._adjacent(p, s) && (!target || this._d2(p, s) < this._d2(p, target))) target = s;
		}
		if (!target) return { text: `Stand next to your own firepit or shack to ${locked ? 'lock' : 'unlock'} it.`, kind: 'error' };
		if (target.locked === locked) return { text: `Your ${target.kind} is already ${locked ? 'locked' : 'unlocked'}.`, kind: 'info' };
		target.locked = locked;
		const k = target.kind.charAt(0).toUpperCase() + target.kind.slice(1);
		return { text: `${k} ${locked ? 'locked' : 'unlocked'}.`, kind: 'info' };
	}

	// Squared tile distance — cheap "nearest" ordering, no sqrt.
	_d2(a, b) { const dx = a.tx - b.tx, dy = a.ty - b.ty; return dx * dx + dy * dy; }

	// ----- death & tombstones ----------------------------------------------

	// Single funnel for all damage to a player (mob contact in Task 03, PvP in
	// Task 04, environment, …). Clamps HP at 0 and, when it lands the killing
	// blow, routes through _killPlayer so death/tombstone/respawn happen in
	// exactly one place. Returns true if the hit was fatal. `opts.byName` (and
	// `opts.by`) label the cause for the death notice.
	_damagePlayer(p, amount, opts = {}) {
		if (!p || p.dead) return false;
		const dmg = Math.max(0, Math.floor(amount));
		if (dmg <= 0) return false;
		p.hp = Math.max(0, p.hp - dmg);
		p.tsServer = Date.now();
		if (p.hp === 0) {
			this._killPlayer(p, opts);
			return true;
		}
		return false;
	}

	// Kill a player: freeze them, schedule a respawn, and — only in a danger
	// realm — spill the droppable part of their pack into a tombstone on the tile
	// they fell. Idempotent: a second call on an already-dead player is a no-op.
	_killPlayer(p, opts = {}) {
		if (!p || p.dead) return;
		const now = Date.now();
		p.dead = true;
		// Task 09: auto-dismount on death — no keeping the saddle through a respawn.
		if (p.mounted) { p.mounted = false; p.mount = ''; }
		p.motion = 'idle';
		p.hp = 0;
		p.respawnAt = now + RESPAWN_PLAYER_MS;

		let droppedCount = 0;
		if (this.realm.danger) droppedCount = this._dropTombstone(p, now);

		const client = this._clientFor(p.id);
		client?.send('died', {
			realm: this.realm.name,
			danger: !!this.realm.danger,
			respawnAt: p.respawnAt,
			dropped: droppedCount,
			byName: opts.byName || '',
		});
		p.tsServer = now;
	}

	// Drop rule (deterministic & fair): you KEEP your tools (axe/pickaxe/rod/
	// hammer/sword) wherever they sit — losing the means to recover would be
	// punishing and grief-prone — and you DROP everything else (gathered
	// resources, food, and any other non-tool item) from BOTH the backpack and
	// the hotbar into the bag. Gold is a currency, not an inventory item, so it
	// is never dropped. Returns the number of slots that landed in the tombstone.
	_dropTombstone(p, now) {
		const tomb = new Tombstone();
		tomb.id = `tomb_${this.realm.name}_${p.id}_${++this._tombSeq}`;
		tomb.owner = p.id;
		tomb.ownerName = p.name;
		tomb.tx = p.tx;
		tomb.ty = p.ty;
		tomb.expiresAt = now + TOMBSTONE_TTL_MS;

		for (const slot of [...p.inv, ...p.hotbar]) {
			if (!slot.item || TOOLS.has(slot.item)) continue;
			tomb.items.push(new Slot(slot.item, slot.qty));
			slot.item = '';
			slot.qty = 0;
		}

		if (tomb.items.length === 0) return 0; // nothing droppable — no empty bag
		this.state.tombstones.set(tomb.id, tomb);
		return tomb.items.length;
	}

	// Recover a tombstone's contents. Must be adjacent. Ownership holds for the
	// first part of the bag's life; once inside the final grace window before
	// expiry, anyone adjacent may loot. Items flow back through _addItem so a full
	// pack leaves the remainder in the bag (no duplication, no loss). An emptied
	// bag is removed immediately.
	_handleTombLoot(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const tomb = this.state.tombstones.get(String(payload?.id ?? ''));
		if (!tomb) return;

		if (!this._adjacent(p, tomb)) {
			client.send('notice', { kind: 'tomb', text: 'Walk up to the bag to loot it.' });
			return;
		}

		const now = Date.now();
		const isOwner = tomb.owner === p.id;
		const isPublic = now > tomb.expiresAt - TOMBSTONE_GRACE_MS;
		if (!isOwner && !isPublic) {
			client.send('notice', { kind: 'tomb', text: `This bag belongs to ${tomb.ownerName || 'someone'}.` });
			return;
		}

		// Pull each slot back into the pack; whatever doesn't fit stays in the bag.
		let taken = 0;
		for (const s of tomb.items) {
			if (!s.item || s.qty <= 0) continue;
			const before = s.qty;
			const leftover = this._addItem(p, s.item, s.qty);
			taken += before - leftover;
			s.qty = leftover;
			if (leftover === 0) s.item = '';
		}

		// Compact emptied slots; remove the bag entirely once nothing remains.
		for (let i = tomb.items.length - 1; i >= 0; i--) {
			if (!tomb.items[i].item) tomb.items.splice(i, 1);
		}
		if (tomb.items.length === 0) {
			this.state.tombstones.delete(tomb.id);
			client.send('notice', { kind: 'tomb', text: isOwner ? 'Recovered your belongings.' : 'Looted the bag.' });
		} else if (taken > 0) {
			client.send('notice', { kind: 'full', text: 'Pack full — some items remain in the bag.' });
		} else {
			client.send('notice', { kind: 'full', text: 'Your pack is full.' });
		}
		p.tsServer = now;
	}

	_clientFor(sessionId) {
		return this.clients?.find?.((c) => c.sessionId === sessionId) || null;
	}

	// ----- quests: tutorial + dailies --------------------------------------

	// Talk to a fixed NPC. Validates the player stands adjacent to it, advances a
	// tutorial 'talk' step if that's what's next, and replies with a fresh quest
	// snapshot (the guide's current line travels in it) flagged so the client
	// opens the dialog.
	_handleNpcTalk(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const npc = (this.realm.npcs || []).find((n) => n.id === String(payload?.id ?? ''));
		if (!npc) return;
		if (!this._adjacent(p, npc)) {
			client.send('notice', { kind: 'npc', text: `Walk up to ${npc.name} to talk.` });
			return;
		}
		// A talk only advances the tutorial when the next step IS a talk step;
		// otherwise it just opens the dialog (the snapshot already carries the line).
		this._questProgress(client, { kind: 'talk', n: 1 });
		this._sendQuests(client, { npc: npc.id });
	}

	// Drive all quest progress from a real, server-validated action. `ev` is
	// { kind, item?, n }. Advances the current tutorial step when it matches, and
	// every matching un-claimed daily. Persists + re-sends the snapshot on change.
	// Progress NEVER originates from a client claim — only from these hooks.
	_questProgress(client, ev) {
		const priv = this.priv.get(client.sessionId);
		const p = this.state.players.get(client.sessionId);
		if (!priv || !p || !priv.quests) return;
		const now = Date.now();
		const qs = normalizeQuestState(priv.quests, priv.playerId, now);
		const n = Math.max(1, ev.n | 0 || 1);
		let changed = false;

		// --- tutorial: only the current step, only if its kind (and item) match ---
		const step = currentStep(qs);
		if (step && step.kind === ev.kind && (step.item ? step.item === ev.item : true)) {
			qs.tutorial.progress = Math.min(step.count, qs.tutorial.progress + n);
			changed = true;
			if (qs.tutorial.progress >= step.count) {
				qs.tutorial.step += 1;
				qs.tutorial.progress = 0;
				if (qs.tutorial.step >= TUTORIAL_STEPS.length) {
					qs.tutorial.done = true;
					this._grantQuestReward(client, p, qs, TUTORIAL_REWARD, 'Training complete');
				} else {
					const next = TUTORIAL_STEPS[qs.tutorial.step];
					client.send('notice', { kind: 'quest', text: `Next: ${next.title}.` });
				}
			}
		}

		// --- dailies: every matching un-claimed quest advances together ---
		if (ev.kind === 'gather' || ev.kind === 'combat') {
			for (const q of qs.daily.quests) {
				if (q.claimed) continue;
				const def = dailyDef(q.id);
				if (!def || def.type !== ev.kind) continue;
				if (def.type === 'gather' && def.item !== ev.item) continue;
				const before = q.progress;
				q.progress = Math.min(def.count, q.progress + n);
				if (q.progress !== before) {
					changed = true;
					if (before < def.count && q.progress >= def.count) {
						client.send('notice', { kind: 'quest', text: `Daily ready: ${def.title} — turn it in for your reward.` });
					}
				}
			}
		}

		if (changed) {
			p.badges = (qs.badges || []).join(',');
			this._persistPlayer(client.sessionId);
			this._sendQuests(client);
		}
	}

	// Claim a finished daily. Server-authoritative: refuses unless the TRACKED
	// progress meets the target and it isn't already claimed — a forged turn-in
	// for an unfinished quest does nothing. Awards 'devoted' once the whole board
	// is cleared for the day.
	_handleTurnIn(client, payload) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv || !priv.quests) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const qs = normalizeQuestState(priv.quests, priv.playerId, Date.now());
		const q = qs.daily.quests.find((x) => x.id === String(payload?.id ?? ''));
		const def = q && dailyDef(q.id);
		if (!q || !def) return;
		if (q.claimed) { this._sendQuests(client); return; }
		if (q.progress < def.count) {
			client.send('notice', { kind: 'quest', text: `${def.title} isn't finished yet.` });
			return;
		}
		q.claimed = true;
		this._grantQuestReward(client, p, qs, def.reward, def.title);
		if (qs.daily.quests.every((x) => x.claimed)) this._awardBadge(client, p, qs, 'devoted');
		p.badges = (qs.badges || []).join(',');
		this._persistPlayer(client.sessionId);
		this._sendQuests(client);
	}

	// Apply a reward bundle (gold / XP / item / badge) and announce it. An item
	// reward that doesn't fit the pack spills into the bank so a reward is never
	// silently lost.
	_grantQuestReward(client, p, qs, reward, label) {
		if (!reward) return;
		const bits = [];
		if (reward.gold) { p.gold = Math.min(0xffffffff, p.gold + reward.gold); bits.push(`+${reward.gold}g`); }
		if (reward.xp) {
			for (const [skill, amt] of Object.entries(reward.xp)) {
				this._grantXp(client, p, skill, amt);
				bits.push(`+${amt} ${skill} xp`);
			}
		}
		if (reward.item) {
			const left = this._addItem(p, reward.item.id, reward.item.qty);
			if (left > 0) this._bankAdd(this.priv.get(client.sessionId).bank, reward.item.id, left);
			bits.push(`+${reward.item.qty} ${reward.item.id}`);
		}
		if (reward.badge) this._awardBadge(client, p, qs, reward.badge);
		if (bits.length) client.send('notice', { kind: 'reward', text: `${label}: ${bits.join(', ')}.` });
	}

	_awardBadge(client, p, qs, id) {
		if (!BADGES[id] || qs.badges.includes(id)) return;
		qs.badges.push(id);
		p.badges = qs.badges.join(',');
		client.send('notice', { kind: 'badge', text: `Badge earned: ${BADGES[id].icon} ${BADGES[id].label}.` });
	}

	// Send the requesting player their full quest snapshot: tutorial step (or
	// done), today's dailies with live progress + reward previews, the next-reset
	// timestamp for a real countdown, earned badges, and the guide's current line.
	// `opts.npc` set => the client opens the NPC dialog on this snapshot.
	_sendQuests(client, opts = {}) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv || !priv.quests) return;
		const now = Date.now();
		const qs = normalizeQuestState(priv.quests, priv.playerId, now);
		const badgeStr = (qs.badges || []).join(',');
		if (p.badges !== badgeStr) p.badges = badgeStr; // keep the synced field honest

		const step = currentStep(qs);
		const tutorial = qs.tutorial.done
			? { done: true, total: TUTORIAL_STEPS.length }
			: {
				done: false,
				stepIndex: qs.tutorial.step,
				total: TUTORIAL_STEPS.length,
				progress: qs.tutorial.progress,
				step: step && {
					id: step.id, kind: step.kind, count: step.count, item: step.item || '',
					slot: typeof step.slot === 'number' ? step.slot : -1, title: step.title, desc: step.desc,
				},
			};

		const daily = {
			date: qs.daily.date,
			resetAt: nextResetAt(now),
			quests: qs.daily.quests.map((q) => {
				const def = dailyDef(q.id) || {};
				return {
					id: q.id, type: def.type, item: def.item || '', count: def.count || 0,
					title: def.title || q.id, desc: def.desc || '',
					progress: Math.min(q.progress, def.count || q.progress), claimed: !!q.claimed,
					reward: this._rewardPreview(def.reward),
				};
			}),
		};

		const badges = (qs.badges || []).map((id) => BADGES[id]).filter(Boolean);
		const guide = qs.tutorial.done ? GUIDE_DONE : (step?.guide || '');

		client.send('quests', { tutorial, daily, badges, guide, npc: opts.npc || '' });
	}

	// Compact, client-renderable reward summary (no server-only detail).
	_rewardPreview(reward) {
		if (!reward) return {};
		const out = {};
		if (reward.gold) out.gold = reward.gold;
		if (reward.xp) out.xp = reward.xp;
		if (reward.item) out.item = { id: reward.item.id, qty: reward.item.qty };
		if (reward.badge && BADGES[reward.badge]) {
			out.badge = { id: reward.badge, icon: BADGES[reward.badge].icon, label: BADGES[reward.badge].label };
		}
		return out;
	}

	// Persist the player's quest state through the Task 16 save interface, keyed
	// by the stable account id. Read-merge-write so we only ever own the quest
	// slice and never clobber other persisted fields.
	_persistPlayer(sessionId) {
		const priv = this.priv.get(sessionId);
		if (!priv || !priv.playerId || !priv.quests) return;
		const prev = loadPlayer(priv.playerId) || {};
		savePlayer(priv.playerId, { ...prev, quests: priv.quests });
	}

	// ----- inventory / hotbar ----------------------------------------------

	_handleInvMove(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const from = this._resolveSlot(p, payload?.from);
		const to = this._resolveSlot(p, payload?.to);
		if (!from || !to) return;
		// Swap (or merge stacks of the same stackable item).
		const a = from.slot;
		const b = to.slot;
		if (a === b) return;
		if (a.item && a.item === b.item && STACKABLE.has(a.item)) {
			const room = MAX_STACK - b.qty;
			const moved = Math.min(room, a.qty);
			b.qty += moved;
			a.qty -= moved;
			if (a.qty === 0) a.item = '';
		} else {
			const ti = b.item, tq = b.qty;
			b.item = a.item; b.qty = a.qty;
			a.item = ti; a.qty = tq;
		}
		p.tsServer = Date.now();
	}

	_handleEquip(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const i = payload?.slot | 0;
		if (i < -1 || i >= HOTBAR_SIZE) return;
		p.activeSlot = i;
		p.tsServer = Date.now();
	}

	// `ref` is { zone: 'inv'|'hotbar', i } — resolves to the live Slot object.
	_resolveSlot(p, ref) {
		if (!ref || typeof ref !== 'object') return null;
		const i = ref.i | 0;
		if (ref.zone === 'inv' && i >= 0 && i < INV_SIZE) return { slot: p.inv[i] };
		if (ref.zone === 'hotbar' && i >= 0 && i < HOTBAR_SIZE) return { slot: p.hotbar[i] };
		return null;
	}

	// ----- banking ---------------------------------------------------------

	_handleBank(client, payload, dir) {
		const p = this.state.players.get(client.sessionId);
		if (!p) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		// Must be standing on a bank-counter tile.
		if (!this.realm.bankZone.some((t) => t.tx === p.tx && t.ty === p.ty)) {
			client.send('notice', { kind: 'bank', text: 'Stand at the bank counter to use storage.' });
			return;
		}
		const priv = this.priv.get(client.sessionId);
		const i = payload?.i | 0;
		const qty = Math.max(1, payload?.qty | 0 || 1);

		if (dir === 'deposit') {
			if (i < 0 || i >= INV_SIZE) return;
			const slot = p.inv[i];
			if (!slot.item) return;
			const move = Math.min(qty, slot.qty);
			const left = this._bankAdd(priv.bank, slot.item, move);
			const deposited = move - left;
			slot.qty -= deposited;
			if (slot.qty === 0) slot.item = '';
			// Tutorial: stashing an item teaches the bank. Only count a real deposit.
			if (deposited > 0) this._questProgress(client, { kind: 'bank', n: 1 });
		} else {
			if (i < 0 || i >= BANK_SIZE) return;
			const bslot = priv.bank[i];
			if (!bslot.item) return;
			const move = Math.min(qty, bslot.qty);
			const left = this._addItem(p, bslot.item, move);
			const withdrawn = move - left;
			bslot.qty -= withdrawn;
			if (bslot.qty === 0) bslot.item = '';
		}
		p.tsServer = Date.now();
		this._sendBank(client);
	}

	_sendBank(client) {
		const priv = this.priv.get(client.sessionId);
		if (!priv) return;
		client.send('bank', { slots: priv.bank });
	}

	// Swap avatar mid-session (e.g. a guest avatar finishing its background upload
	// on /play, or a player changing look without rejoining). Rate-limited as a UI
	// action and host-validated like the join-time avatar.
	_handleAvatar(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const url = cleanAvatarUrl(payload?.avatar);
		if (url) p.cosmetic = url;
	}

	_bankAdd(bank, item, qty) {
		let left = qty;
		if (STACKABLE.has(item)) {
			for (const s of bank) {
				if (left <= 0) break;
				if (s.item === item && s.qty < MAX_STACK) {
					const room = MAX_STACK - s.qty;
					const m = Math.min(room, left);
					s.qty += m; left -= m;
				}
			}
		}
		while (left > 0) {
			const empty = bank.find((s) => !s.item);
			if (!empty) break;
			const m = STACKABLE.has(item) ? Math.min(MAX_STACK, left) : 1;
			empty.item = item; empty.qty = m; left -= m;
		}
		return left;
	}

	// ----- shared helpers --------------------------------------------------

	// Add an item to the player's backpack. Returns the leftover quantity that
	// didn't fit (0 means everything was stored).
	_addItem(p, item, qty) {
		let left = qty;
		if (STACKABLE.has(item)) {
			for (const s of p.inv) {
				if (left <= 0) break;
				if (s.item === item && s.qty < MAX_STACK) {
					const room = MAX_STACK - s.qty;
					const m = Math.min(room, left);
					s.qty += m; left -= m;
				}
			}
			while (left > 0) {
				const empty = p.inv.find((s) => !s.item);
				if (!empty) break;
				const m = Math.min(MAX_STACK, left);
				empty.item = item; empty.qty = m; left -= m;
			}
		} else {
			while (left > 0) {
				const empty = p.inv.find((s) => !s.item);
				if (!empty) break;
				empty.item = item; empty.qty = 1; left -= 1;
			}
		}
		return left;
	}

	_grantXp(client, p, skill, amount) {
		const priv = this.priv.get(client.sessionId);
		if (!priv) return;
		priv.xp[skill] = (priv.xp[skill] || 0) + amount;
		const lvl = levelForXp(priv.xp[skill]);
		// XP only accumulates, so a changed level is always a level-up. Broadcast
		// only the integer level on the schema; tell the earner privately so its
		// UI can both refresh the XP bar (via a 'skills' fetch) and celebrate.
		if (lvl > p[skill]) {
			p[skill] = lvl;
			client.send('levelup', { skill, level: lvl });
		}
	}

	// Reply to a 'skills' request with the requesting player's own XP detail: per
	// skill, the level plus the cumulative XP boundaries of the current level so
	// the client can draw an exact progress bar. Raw XP is never broadcast to
	// peers — it only ever travels back to its owner here.
	_sendSkills(client) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv) return;
		const skills = {};
		for (const skill of SKILLS) {
			const level = p[skill];
			const xp = priv.xp[skill] || 0;
			const floorXp = xpForLevel(level);
			const maxed = level >= LEVEL_CAP;
			skills[skill] = {
				level,
				xp,
				levelXp: floorXp, // cumulative XP at the start of the current level
				nextXp: maxed ? null : xpForLevel(level + 1), // cumulative XP for next level
			};
		}
		client.send('skills', {
			cap: LEVEL_CAP,
			skills,
			total: this._totalLevel(p),
			average: this._averageLevel(p),
		});
	}

	// Authoritative average skill level — the mean of all five skill levels.
	// Returned precisely (a float) so callers choose their own rounding: a gate
	// can floor it (e.g. `Math.floor(avg) >= 20`) while the UI shows one decimal.
	// Reused by Task 19's spin gate and any future average-level content gate.
	_averageLevel(p) {
		return this._totalLevel(p) / SKILLS.length;
	}

	_totalLevel(p) {
		let sum = 0;
		for (const s of SKILLS) sum += p[s];
		return sum;
	}

	_adjacent(p, obj) {
		return Math.abs(p.tx - obj.tx) <= 1 && Math.abs(p.ty - obj.ty) <= 1;
	}

	_rateOk(sessionId, action) {
		const priv = this.priv.get(sessionId);
		if (!priv) return false;
		const limit = RATE_LIMITS[action] || 10;
		const now = Date.now();
		let bucket = priv.rate.get(action);
		if (!bucket || now - bucket.windowStart > 1000) {
			bucket = { windowStart: now, count: 0 };
			priv.rate.set(action, bucket);
		}
		bucket.count++;
		return bucket.count <= limit;
	}

	// ----- simulation tick -------------------------------------------------

	_tick() {
		const now = Date.now();

		// Resource + mob respawns.
		for (const [, n] of this.state.nodes) {
			if (n.depleted && now >= n.respawnAt) {
				n.depleted = false;
				n.respawnAt = 0;
			}
		}
		for (const [, m] of this.state.mobs) {
			if (m.dead && now >= m.respawnAt) {
				m.dead = false;
				m.hp = m.maxHp;
				m.respawnAt = 0;
			}
		}

		// Expire crumbled death-bags.
		for (const [id, t] of this.state.tombstones) {
			if (now >= t.expiresAt) this.state.tombstones.delete(id);
		}

		// Player healing + respawn — both keyed to THIS realm's spawn/fountain.
		const fountain = this.realm.fountain;
		for (const [, p] of this.state.players) {
			if (p.dead) {
				if (now >= p.respawnAt) {
					p.dead = false;
					p.hp = p.maxHp;
					p.motion = 'idle';
					p.tx = this.realm.spawn.tx;
					p.ty = this.realm.spawn.ty;
					p.tsServer = now;
				}
				continue;
			}
			if (p.hp < p.maxHp) {
				const nearFountain =
					!!fountain && Math.abs(p.tx - fountain.tx) <= 3 && Math.abs(p.ty - fountain.ty) <= 3;
				p.hp = Math.min(p.maxHp, p.hp + (nearFountain ? FOUNTAIN_HEAL_PER_TICK : REGEN_PER_TICK));
			}
		}
	}
}
