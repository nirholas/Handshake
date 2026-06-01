// Item registry — the single source of truth for what items exist in the
// Kintara realms and how they behave. Rooms read THIS instead of branching on
// item ids inline, so stacking, edibility, heal values, and mount tuning are
// data-driven and an item means the same thing everywhere it appears.
//
// Reused by the GameRoom (gather/cook/consume/banking/loot/mounts) and, going
// forward, by the marketplace and the shop — they all describe items in the
// same vocabulary so a "cookedFish" is identical whether it was cooked, looted,
// or bought.
//
// Each entry:
//   stackable — stacks up to MAX_STACK in one slot (resources, food, potions).
//   tool      — equippable gather/combat tool; occupies the active slot, never
//               stacks (qty stays 1).
//   edible    — can be eaten via the `consume` intent to restore HP.
//   heal      — base HP restored when eaten (edible items only).
//   mount     — rideable steed tuning { stepMs, color, accent, scale }. stepMs
//               is the SERVER-enforced floor (ms between steps) while riding it;
//               lower is faster. The client derives its send cadence from this
//               so it can never out-pace what the server will accept.
//   icon      — emoji shown in the hotbar / tooltips (client convenience).
//   label     — human-facing name for toasts and tooltips.

export const ITEMS = {
	// Tools — non-stackable, one per slot.
	axe: { tool: true, stackable: false, icon: '🪓', label: 'Axe' },
	pickaxe: { tool: true, stackable: false, icon: '⛏️', label: 'Pickaxe' },
	rod: { tool: true, stackable: false, icon: '🎣', label: 'Fishing rod' },
	hammer: { tool: true, stackable: false, icon: '🔨', label: 'Hammer' },
	sword: { tool: true, stackable: false, icon: '⚔️', label: 'Sword' },

	// Gathered resources — stackable.
	wood: { stackable: true, icon: '🪵', label: 'Wood' },
	stone: { stackable: true, icon: '🪨', label: 'Stone' },
	coal: { stackable: true, icon: '⚫', label: 'Coal' },
	fish: { stackable: true, icon: '🐟', label: 'Raw fish' },

	// Monster drops — stackable trophy/material items from kills.
	bones: { stackable: true, icon: '🦴', label: 'Bones' },
	hide: { stackable: true, icon: '🟫', label: 'Beast hide' },

	// Cooked food — stackable and edible. Cooking raw fish at a Roast Pit yields
	// this; eating it restores HP.
	cookedFish: { stackable: true, edible: true, heal: 11, icon: '🍖', label: 'Cooked fish' },

	// Potions — stackable, edible, stronger heals. Introduced by the shop/loot;
	// defined here so the `consume` handler treats them correctly the moment they
	// enter a player's pack.
	healthPotion: { stackable: true, edible: true, heal: 28, icon: '🧪', label: 'Health potion' },

	// Mounts — rare drops you can ride for faster travel. Non-stackable; one per
	// slot. stepMs is the server-enforced step floor while riding (lower = faster
	// than the on-foot floor). The dire wolf is quick and light; the war boar is
	// a touch slower but a bigger, sturdier-looking steed.
	dire_wolf: {
		mount: { stepMs: 92, color: 0x6b7280, accent: 0xb9c2d0, scale: 1.0 },
		stackable: false, icon: '🐺', label: 'Dire Wolf',
	},
	war_boar: {
		mount: { stepMs: 104, color: 0x7a5230, accent: 0xd8b48a, scale: 1.15 },
		stackable: false, icon: '🐗', label: 'War Boar',
	},
};

// The set of item ids that stack — derived once from the registry so callers
// never hand-maintain a parallel list.
export const STACKABLE_ITEMS = new Set(
	Object.entries(ITEMS).filter(([, def]) => def.stackable).map(([id]) => id),
);

export function itemDef(item) {
	return ITEMS[item] || null;
}

export function isStackable(item) {
	return !!ITEMS[item]?.stackable;
}

export function isEdible(item) {
	return !!ITEMS[item]?.edible;
}

// Base HP restored when an edible item is eaten (0 for anything inedible).
export function healValue(item) {
	return ITEMS[item]?.heal || 0;
}

export function itemLabel(item) {
	return ITEMS[item]?.label || item;
}

// ---------------------------------------------------------------------------
// Mounts
// ---------------------------------------------------------------------------

export function isMount(item) {
	return !!ITEMS[item]?.mount;
}

// The server-enforced minimum ms between steps while riding `item` (null if the
// item isn't a mount). Lower than the on-foot floor → visibly faster travel.
export function mountStepMs(item) {
	return ITEMS[item]?.mount?.stepMs ?? null;
}

// ---------------------------------------------------------------------------
// Loot tables
// ---------------------------------------------------------------------------

// Drop tables keyed by mob `kind`. Each entry is one INDEPENDENT roll:
//   { item, chance, min?, max? }  (min/max default to 1; stackables roll a qty)
// Training dummies intentionally drop nothing. Rolls are independent, so a kill
// can yield several lines or none — and a lucky kill can drop a rare mount.
export const LOOT_TABLES = {
	dummy: [],
	goblin: [
		{ item: 'bones', chance: 0.55, min: 1, max: 2 },
		{ item: 'hide', chance: 0.30 },
		{ item: 'coal', chance: 0.18 },
		{ item: 'dire_wolf', chance: 0.05 },
	],
	ogre: [
		{ item: 'bones', chance: 0.75, min: 1, max: 3 },
		{ item: 'hide', chance: 0.55, min: 1, max: 2 },
		{ item: 'stone', chance: 0.40, min: 1, max: 3 },
		{ item: 'dire_wolf', chance: 0.07 },
		{ item: 'war_boar', chance: 0.10 },
	],
};

// Roll a mob's loot table into a flat list of { item, qty }. Pure given `rng`
// (defaults to Math.random) so it stays unit-testable and deterministic under a
// seeded rng.
export function rollLoot(kind, rng = Math.random) {
	const table = LOOT_TABLES[kind];
	if (!table) return [];
	const out = [];
	for (const entry of table) {
		if (rng() >= entry.chance) continue;
		const min = entry.min ?? 1;
		const max = entry.max ?? min;
		const qty = min + Math.floor(rng() * (max - min + 1));
		out.push({ item: entry.item, qty });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Client view
// ---------------------------------------------------------------------------

// The slim, serializable slice the client needs to label/render items (hotbar
// icons, loot toasts, mount meshes). Keeps the wire payload small — no loot
// tables or heal logic, since the client never rolls or resolves those.
// ---------------------------------------------------------------------------
// Cooking
// ---------------------------------------------------------------------------

// Burn chance when cooking raw fish: 40% at level 1, falling linearly to 0% by
// the high 30s, so a low-level cook loses some fish while a trained one never
// does. Clamped both ways. Pure and deterministic (the per-fish RNG roll lives
// in the cook handler) so the odds stay honest and unit-testable.
export function cookBurnChance(level) {
	const c = 0.4 - (Math.max(1, level) - 1) * 0.011;
	return Math.max(0, Math.min(0.4, c));
}

export function clientItemRegistry() {
	const out = {};
	for (const [id, it] of Object.entries(ITEMS)) {
		out[id] = {
			label: it.label || id,
			icon: it.icon || '📦',
			kind: it.mount ? 'mount' : it.tool ? 'tool' : it.edible ? 'food' : 'resource',
			stackable: !!it.stackable,
		};
		if (it.mount) out[id].mount = { ...it.mount };
	}
	return out;
}
