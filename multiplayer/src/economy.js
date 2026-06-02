// Economy & progression for the /play coin worlds.
//
// The /game isometric MMO (GameRoom) keeps inventory, hotbar, gold and skills on
// the synced Colyseus schema because peers render each other's equipped tools and
// mounts on a tile grid. /play is a free-roam, per-coin social world where a
// player's pack and purse are PRIVATE — no peer needs to see them — so we keep all
// of it OFF the shared WalkState schema and stream each owner only their own state
// via targeted messages (the same pattern GameRoom already uses for skills/xpgain).
//
// That keeps the /walk experience (which shares the same schema) untouched, costs
// peers zero extra wire bytes, and lets the economy grow (cooking, gathering,
// commerce) without ever repricing the movement-critical position deltas.
//
// A "profile" here is a plain JS object — not a Schema — so these helpers operate
// on ordinary arrays. The shapes mirror items.js/playerStore.js so a fish caught on
// /play means the same thing it does in /game, and a profile persists through the
// same account-keyed playerStore.

import {
	STACKABLE_ITEMS, isEdible, scaledHeal,
} from './items.js';

export const INV_SIZE = 24;
export const HOTBAR_SIZE = 6;
export const MAX_STACK = 999;
export const LEVEL_CAP = 99;
export const SKILLS = ['combat', 'woodcutting', 'mining', 'fishing', 'cooking'];

// Starter kit handed to a brand-new player so the loop is exercisable the moment
// they land: a fishing rod (cast at any pond) plus the gathering tools and a sword
// the later phases (woodcutting/mining/combat) will use. Tools occupy the hotbar.
const STARTER_HOTBAR = ['rod', 'axe', 'pickaxe', 'sword'];

// XP curve — identical to GameRoom's so progression is consistent across the
// platform: level n needs 50 * n^1.8 cumulative XP, capped at LEVEL_CAP.
export function levelForXp(xp) {
	let lvl = 1;
	while (lvl < LEVEL_CAP && xp >= Math.floor(50 * Math.pow(lvl, 1.8))) lvl++;
	return lvl;
}

// Inverse of levelForXp: cumulative XP required to BE at a given level. Lets the
// client draw an exact progress bar without re-deriving the curve.
export function xpForLevel(level) {
	const lvl = Math.max(1, Math.min(LEVEL_CAP, level | 0));
	return lvl <= 1 ? 0 : Math.floor(50 * Math.pow(lvl - 1, 1.8));
}

function emptySlots(n) {
	return Array.from({ length: n }, () => ({ item: '', qty: 0 }));
}

// A fresh profile with the starter kit. `playerId` is the stable persistence key
// (wallet account or guest id) carried on the profile so save paths never need it
// threaded separately.
export function newProfile(playerId = '') {
	const hotbar = emptySlots(HOTBAR_SIZE);
	STARTER_HOTBAR.forEach((item, i) => { hotbar[i] = { item, qty: 1 }; });
	return {
		playerId,
		gold: 0,
		hp: 100,
		maxHp: 100,
		inv: emptySlots(INV_SIZE),
		hotbar,
		activeSlot: 0, // the rod, ready to cast
		xp: Object.fromEntries(SKILLS.map((s) => [s, 0])),
		levels: Object.fromEntries(SKILLS.map((s) => [s, 1])),
	};
}

// Rebuild a profile from a persisted blob (playerStore `profile` field). Tolerant
// of partial/legacy/missing data — every field is clamped and defaulted so a
// corrupt save can never crash a join; missing → a fresh starter profile.
export function restoreProfile(saved, playerId = '') {
	if (!saved || typeof saved !== 'object') return newProfile(playerId);
	const base = newProfile(playerId);
	const fill = (target, src) => {
		for (let i = 0; i < target.length; i++) {
			const s = src && src[i];
			const item = s && typeof s.item === 'string' ? s.item : '';
			target[i] = { item, qty: item && Number.isFinite(s.qty) ? Math.max(0, Math.min(MAX_STACK, s.qty | 0)) : 0 };
		}
	};
	if (Array.isArray(saved.inv)) fill(base.inv, saved.inv);
	if (Array.isArray(saved.hotbar)) fill(base.hotbar, saved.hotbar);
	if (Number.isFinite(saved.activeSlot)) base.activeSlot = Math.max(-1, Math.min(HOTBAR_SIZE - 1, saved.activeSlot | 0));
	if (Number.isFinite(saved.gold)) base.gold = Math.max(0, Math.min(0xffffffff, saved.gold | 0));
	if (Number.isFinite(saved.maxHp) && saved.maxHp > 0) base.maxHp = saved.maxHp | 0;
	if (Number.isFinite(saved.hp)) base.hp = Math.max(0, Math.min(base.maxHp, saved.hp | 0));
	if (saved.xp && typeof saved.xp === 'object') {
		for (const skill of SKILLS) {
			const v = Number.isFinite(saved.xp[skill]) ? Math.max(0, saved.xp[skill]) : 0;
			base.xp[skill] = v;
			base.levels[skill] = levelForXp(v);
		}
	}
	return base;
}

// The persisted slice (mirrors GameRoom._serializeProfile so the two stores stay
// interchangeable for an account that plays both surfaces).
export function serializeProfile(profile) {
	const slots = (arr) => arr.map((s) => ({ item: s.item, qty: s.qty }));
	return {
		inv: slots(profile.inv),
		hotbar: slots(profile.hotbar),
		activeSlot: profile.activeSlot,
		gold: profile.gold,
		hp: profile.hp,
		maxHp: profile.maxHp,
		xp: { ...profile.xp },
	};
}

// Is there room in the backpack for at least one of `item`? Stackables fit in any
// empty slot OR a non-full existing stack; non-stackables need an empty slot.
export function hasRoomFor(profile, item) {
	if (STACKABLE_ITEMS.has(item)) {
		for (const s of profile.inv) {
			if (!s.item) return true;
			if (s.item === item && s.qty < MAX_STACK) return true;
		}
		return false;
	}
	return profile.inv.some((s) => !s.item);
}

// Add `qty` of `item` to the backpack, filling existing stacks first. Returns the
// quantity that did NOT fit (0 = everything landed). Mirrors GameRoom._addItem.
export function addItem(profile, item, qty) {
	let left = qty;
	const inv = profile.inv;
	if (STACKABLE_ITEMS.has(item)) {
		for (const s of inv) {
			if (left <= 0) break;
			if (s.item === item && s.qty < MAX_STACK) {
				const room = MAX_STACK - s.qty;
				const m = Math.min(room, left);
				s.qty += m; left -= m;
			}
		}
		while (left > 0) {
			const empty = inv.find((s) => !s.item);
			if (!empty) break;
			const m = Math.min(MAX_STACK, left);
			empty.item = item; empty.qty = m; left -= m;
		}
	} else {
		while (left > 0) {
			const empty = inv.find((s) => !s.item);
			if (!empty) break;
			empty.item = item; empty.qty = 1; left -= 1;
		}
	}
	return left;
}

// Resolve a client slot reference { zone:'inv'|'hotbar', i } to the live slot
// object, or null when out of range. Validated like GameRoom._resolveSlot so a
// crafted index can never read outside the arrays.
export function resolveSlot(profile, ref) {
	if (!ref || typeof ref !== 'object') return null;
	const i = ref.i | 0;
	if (ref.zone === 'inv' && i >= 0 && i < INV_SIZE) return profile.inv[i];
	if (ref.zone === 'hotbar' && i >= 0 && i < HOTBAR_SIZE) return profile.hotbar[i];
	return null;
}

// Grant XP in a skill. Mutates the profile and returns the detail the owner's
// client needs to animate the gain and (when crossed) the level-up — including the
// current level's XP boundaries so the bar is exact without a round-trip.
export function grantXp(profile, skill, amount) {
	if (!SKILLS.includes(skill)) return null;
	profile.xp[skill] = (profile.xp[skill] || 0) + amount;
	const xp = profile.xp[skill];
	const level = levelForXp(xp);
	const leveledUp = level > (profile.levels[skill] || 1);
	profile.levels[skill] = level;
	const maxed = level >= LEVEL_CAP;
	return {
		skill, amount, xp, level, leveledUp,
		levelXp: xpForLevel(level),
		nextXp: maxed ? null : xpForLevel(level + 1),
	};
}

// The full snapshot the owner's client renders on join (and after any change it
// can't infer): purse, vitals, pack, hotbar, and per-skill level + bar boundaries.
export function profileSnapshot(profile) {
	const skills = {};
	for (const skill of SKILLS) {
		const level = profile.levels[skill] || 1;
		const maxed = level >= LEVEL_CAP;
		skills[skill] = {
			level,
			xp: profile.xp[skill] || 0,
			levelXp: xpForLevel(level),
			nextXp: maxed ? null : xpForLevel(level + 1),
		};
	}
	return {
		gold: profile.gold,
		hp: profile.hp,
		maxHp: profile.maxHp,
		inv: profile.inv.map((s) => ({ item: s.item, qty: s.qty })),
		hotbar: profile.hotbar.map((s) => ({ item: s.item, qty: s.qty })),
		activeSlot: profile.activeSlot,
		skills,
		cap: LEVEL_CAP,
	};
}

// Eat the edible in `slot`, healing scaled by cooking level. Returns the HP gained
// (0 when nothing happened: not edible, already full, or empty). Mutates profile.
export function consumeSlot(profile, slot) {
	if (!slot || !slot.item || !isEdible(slot.item)) return { ok: false, reason: 'inedible' };
	if (profile.hp >= profile.maxHp) return { ok: false, reason: 'full' };
	const before = profile.hp;
	profile.hp = Math.min(profile.maxHp, profile.hp + scaledHeal(slot.item, profile.levels.cooking || 1));
	const gained = profile.hp - before;
	slot.qty -= 1;
	if (slot.qty <= 0) { slot.item = ''; slot.qty = 0; }
	return { ok: true, gained };
}
