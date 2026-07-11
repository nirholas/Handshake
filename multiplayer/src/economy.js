// Economy & progression for the /play coin worlds.
//
// /play is a free-roam, per-coin social world where a player's pack and purse are
// PRIVATE — no peer needs to see them — so we keep all of it OFF the shared
// WalkState schema and stream each owner only their own state via targeted
// messages.
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
	STACKABLE_ITEMS, isEdible, scaledHeal, armorValue,
} from './items.js';
import {
	DEFAULT_LOADOUT, SLOTS, getCosmetic, canWear, sanitizeLoadout, freeCosmeticIds,
} from './cosmetics-catalog.js';

export const INV_SIZE = 24;
export const HOTBAR_SIZE = 6;
export const MAX_STACK = 999;
export const LEVEL_CAP = 99;
export const SKILLS = ['combat', 'woodcutting', 'mining', 'fishing', 'cooking'];
// The armor layer's ceiling — a vest tops you up to here, and incoming damage eats
// armor before HP (see combat.js applyDamage). One capped bar, so it reads cleanly.
export const MAX_ARMOR = 100;

// Starter kit handed to a brand-new player so the loop is exercisable the moment
// they land: a fishing rod (cast at any pond), the gathering tools, and BOTH a
// melee (sword) and ranged (pistol) weapon so the W07 combat loop — swing, shoot,
// heal, re-armor — is playable on arrival. Tools occupy the hotbar.
const STARTER_HOTBAR = ['rod', 'axe', 'pickaxe', 'sword', 'pistol'];
// Backpack seed so a new player can fire and survive their first fight without a
// shop run: a clip of pistol ammo and one body-armor vest.
const STARTER_INV = [{ item: 'ammo', qty: 24 }, { item: 'vest', qty: 1 }];

// XP curve — the canonical progression for the platform: level n needs
// 50 * n^1.8 cumulative XP, capped at LEVEL_CAP.
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
	const inv = emptySlots(INV_SIZE);
	STARTER_INV.forEach((seed, i) => { inv[i] = { item: seed.item, qty: seed.qty }; });
	return {
		playerId,
		gold: 0,
		bank: 0,        // banked cash — protected on death (carried `gold` drops). W04 extends.
		hp: 100,
		maxHp: 100,
		armor: 0,       // armor layer that absorbs damage before HP; refilled by a vest.
		maxArmor: MAX_ARMOR,
		heat: 0,        // wanted/heat meter (0..MAX_HEAT) — raised by crimes, decays over time.
		inv,
		hotbar,
		activeSlot: 0, // the rod, ready to cast
		xp: Object.fromEntries(SKILLS.map((s) => [s, 0])),
		levels: Object.fromEntries(SKILLS.map((s) => [s, 1])),
		// Wheel of Fortune (W09/Task 19): epoch ms the next free spin unlocks. Unlike
		// the ephemeral per-action `cd` map (WalkRoom.js, reset every reconnect —
		// fine for a sub-second gather cooldown), this MUST survive a disconnect: a
		// 12h cooldown that resets on reconnect would be free to farm. Persisted
		// through serializeProfile/restoreProfile below.
		nextFreeSpinAt: 0,
		// Cosmetic identity (W03), purely visual. `owned` lists the premium ids this
		// account has unlocked (free cosmetics are implicitly owned by everyone, so
		// they're never stored here); `equipped` is the per-slot loadout peers render.
		cosmetics: { owned: [], equipped: { ...DEFAULT_LOADOUT } },
	};
}

// Premium ids this profile may wear: its unlocked set plus every free cosmetic.
// Returned as a Set for O(1) canWear checks on the equip hot path.
export function ownedCosmeticSet(profile) {
	const owned = new Set(freeCosmeticIds());
	const list = profile?.cosmetics?.owned;
	if (Array.isArray(list)) for (const id of list) if (getCosmetic(id)) owned.add(id);
	return owned;
}

// Grant a premium cosmetic into an account's owned list (the W04 unlock hook:
// the shop calls this after a $THREE payment settles). Idempotent; ignores free
// or unknown ids. Returns true when it newly unlocked something.
export function grantCosmetic(profile, id) {
	const c = getCosmetic(id);
	if (!c || c.tier !== 'premium') return false;
	if (!profile.cosmetics) profile.cosmetics = { owned: [], equipped: { ...DEFAULT_LOADOUT } };
	if (!Array.isArray(profile.cosmetics.owned)) profile.cosmetics.owned = [];
	if (profile.cosmetics.owned.includes(id)) return false;
	profile.cosmetics.owned.push(id);
	return true;
}

// Bridge the R22 ownership ledger (real x402 purchases, keyed by account in
// Redis) into a profile's unlocked set. `ledgerIds` is the raw SMEMBERS of
// `cosmetics:owned:<account>`; only ids that are premium cosmetics in THIS
// catalog are granted (the ledger may also hold ids from a sibling catalog the
// rig can't render — those are ignored, never errored). Idempotent via
// grantCosmetic. Returns the count newly unlocked, so a caller can skip a persist
// when nothing changed.
export function mergeOwnedFromLedger(profile, ledgerIds) {
	if (!Array.isArray(ledgerIds) || !ledgerIds.length) return 0;
	let granted = 0;
	for (const id of ledgerIds) if (grantCosmetic(profile, id)) granted++;
	return granted;
}

// Equip `id` into its slot if the profile is allowed to wear it. Returns the new
// equipped map on success, or null when the id is unknown or unowned (the server
// then rejects the equip). Mutates profile.cosmetics.equipped.
export function equipCosmetic(profile, id) {
	const c = getCosmetic(id);
	if (!c) return null;
	if (!canWear(id, ownedCosmeticSet(profile))) return null;
	if (!profile.cosmetics) profile.cosmetics = { owned: [], equipped: { ...DEFAULT_LOADOUT } };
	profile.cosmetics.equipped = { ...profile.cosmetics.equipped, [c.slot]: id };
	return profile.cosmetics.equipped;
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
	if (Number.isFinite(saved.bank)) base.bank = Math.max(0, Math.min(0xffffffff, saved.bank | 0));
	if (Number.isFinite(saved.maxHp) && saved.maxHp > 0) base.maxHp = saved.maxHp | 0;
	if (Number.isFinite(saved.hp)) base.hp = Math.max(0, Math.min(base.maxHp, saved.hp | 0));
	if (Number.isFinite(saved.maxArmor) && saved.maxArmor > 0) base.maxArmor = saved.maxArmor | 0;
	if (Number.isFinite(saved.armor)) base.armor = Math.max(0, Math.min(base.maxArmor, saved.armor | 0));
	if (Number.isFinite(saved.heat)) base.heat = Math.max(0, Math.min(99, saved.heat));
	if (Number.isFinite(saved.nextFreeSpinAt)) base.nextFreeSpinAt = Math.max(0, saved.nextFreeSpinAt);
	if (saved.xp && typeof saved.xp === 'object') {
		for (const skill of SKILLS) {
			const v = Number.isFinite(saved.xp[skill]) ? Math.max(0, saved.xp[skill]) : 0;
			base.xp[skill] = v;
			base.levels[skill] = levelForXp(v);
		}
	}
	// Cosmetics: keep only premium ids that still exist in the catalog as owned,
	// then sanitize the equipped loadout against what this account may actually
	// wear (drops anything unowned/renamed to the slot default).
	if (saved.cosmetics && typeof saved.cosmetics === 'object') {
		const owned = Array.isArray(saved.cosmetics.owned)
			? saved.cosmetics.owned.filter((id) => { const c = getCosmetic(id); return c && c.tier === 'premium'; })
			: [];
		base.cosmetics.owned = [...new Set(owned)];
		base.cosmetics.equipped = sanitizeLoadout(saved.cosmetics.equipped, ownedCosmeticSet(base));
	}
	return base;
}

// The persisted slice written through to the account-keyed player store.
export function serializeProfile(profile) {
	const slots = (arr) => arr.map((s) => ({ item: s.item, qty: s.qty }));
	return {
		inv: slots(profile.inv),
		hotbar: slots(profile.hotbar),
		activeSlot: profile.activeSlot,
		gold: profile.gold,
		bank: profile.bank,
		hp: profile.hp,
		maxHp: profile.maxHp,
		armor: profile.armor,
		maxArmor: profile.maxArmor,
		heat: profile.heat,
		nextFreeSpinAt: profile.nextFreeSpinAt,
		xp: { ...profile.xp },
		cosmetics: {
			owned: [...(profile.cosmetics?.owned || [])],
			equipped: { ...(profile.cosmetics?.equipped || DEFAULT_LOADOUT) },
		},
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
// quantity that did NOT fit (0 = everything landed).
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

// Total quantity of `item` held across the backpack (hotbar tools aren't counted —
// resources and food live in the pack). Used to gate cooking ("any raw fish?").
export function countItem(profile, item) {
	let n = 0;
	for (const s of profile.inv) if (s.item === item) n += s.qty;
	return n;
}

// Remove up to `qty` of `item` from the backpack, draining stacks until satisfied or
// the item runs out. Returns the quantity actually removed (≤ qty). Used by cooking
// (consume raw fish) and any future recipe/sink. Mutates the profile.
export function removeItem(profile, item, qty) {
	let need = qty;
	for (const s of profile.inv) {
		if (need <= 0) break;
		if (s.item !== item) continue;
		const take = Math.min(s.qty, need);
		s.qty -= take;
		need -= take;
		if (s.qty <= 0) { s.item = ''; s.qty = 0; }
	}
	return qty - need;
}

// Resolve a client slot reference { zone:'inv'|'hotbar', i } to the live slot
// object, or null when out of range. Validated server-side so a
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
		bank: profile.bank,
		hp: profile.hp,
		maxHp: profile.maxHp,
		armor: profile.armor,
		maxArmor: profile.maxArmor,
		heat: profile.heat,
		inv: profile.inv.map((s) => ({ item: s.item, qty: s.qty })),
		hotbar: profile.hotbar.map((s) => ({ item: s.item, qty: s.qty })),
		activeSlot: profile.activeSlot,
		skills,
		cap: LEVEL_CAP,
		// Cosmetic loadout + unlocked set, so the owner's wardrobe shows what they
		// own and have equipped without a second round-trip.
		cosmetics: {
			owned: [...(profile.cosmetics?.owned || [])],
			equipped: { ...(profile.cosmetics?.equipped || DEFAULT_LOADOUT) },
		},
	};
}

// Use the item in `slot`: eat an edible to restore HP (scaled by cooking level), or
// don a vest to refill the armor layer. Returns what happened so the room can toast
// it. Mutates the profile; consumes one of the item on success.
export function consumeSlot(profile, slot) {
	if (!slot || !slot.item) return { ok: false, reason: 'inedible' };

	// Body armor — refill the armor bar instead of HP.
	const armorPts = armorValue(slot.item);
	if (armorPts > 0) {
		const cap = profile.maxArmor || MAX_ARMOR;
		if (profile.armor >= cap) return { ok: false, reason: 'armorFull' };
		const before = profile.armor;
		profile.armor = Math.min(cap, profile.armor + armorPts);
		const gained = profile.armor - before;
		slot.qty -= 1;
		if (slot.qty <= 0) { slot.item = ''; slot.qty = 0; }
		return { ok: true, kind: 'armor', gained };
	}

	if (!isEdible(slot.item)) return { ok: false, reason: 'inedible' };
	if (profile.hp >= profile.maxHp) return { ok: false, reason: 'full' };
	const before = profile.hp;
	profile.hp = Math.min(profile.maxHp, profile.hp + scaledHeal(slot.item, profile.levels.cooking || 1));
	const gained = profile.hp - before;
	slot.qty -= 1;
	if (slot.qty <= 0) { slot.item = ''; slot.qty = 0; }
	return { ok: true, kind: 'heal', gained };
}

// --- Death, banking & vitals (W07) ----------------------------------------

// Strip the carried valuables a tombstone inherits when this player dies: all
// carried cash (`gold`) plus everything in the BACKPACK. Equipped hotbar tools and
// weapons are kept so a respawn isn't toothless, and BANKED cash is untouched —
// that's the whole risk/reward point of banking. Mutates the profile (zeroing the
// dropped slice) and returns { gold, items:[{item,qty}] } for the tombstone.
export function dropCarried(profile) {
	const gold = profile.gold | 0;
	profile.gold = 0;
	const items = [];
	for (const s of profile.inv) {
		if (s.item && s.qty > 0) items.push({ item: s.item, qty: s.qty });
		s.item = ''; s.qty = 0;
	}
	return { gold, items };
}

// Restore a player to fighting shape after respawn: full HP and a cleared armor bar
// (you lose your vest on death — re-armor from the pack or a vendor).
export function reviveProfile(profile) {
	profile.hp = profile.maxHp;
	profile.armor = 0;
}

// Move cash between the carried purse and the protected bank. `amount > 0` deposits
// (purse → bank); `amount < 0` withdraws. Clamps to what's actually available so it
// can never mint or strand cash. Returns the signed amount actually moved.
export function bankTransfer(profile, amount) {
	const amt = amount | 0;
	if (amt > 0) {
		const moved = Math.min(amt, profile.gold | 0);
		profile.gold -= moved; profile.bank += moved;
		return moved;
	}
	if (amt < 0) {
		const moved = Math.min(-amt, profile.bank | 0);
		profile.bank -= moved; profile.gold += moved;
		return -moved;
	}
	return 0;
}
