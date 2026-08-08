// Cosmetics catalog, the single source of truth for every wearable in the
// world, shared verbatim by the authoritative server (WalkRoom validates equips
// and ownership against it) and the client (the creator wardrobe renders it, and
// every player's rig applies it). Keep it dependency-free so both the Node server
// and the Vite client import the exact same table, a cosmetic that exists on one
// side but not the other would let a player wear something peers can't render.
//
// A cosmetic is purely visual (see cosmetics-visual.js): it never touches a
// gameplay value. Each entry carries a `visual` spec the renderer turns into
// Three.js objects:
//   tint, recolour the body (a dye), { tint:'#rrggbb' }
//   prop, a GLB worn on the head/face, { prop:'/url.glb', anchor:'head'|'face' }
//   aura, a glowing ground ring, { aura:'#rrggbb' }
//
// Slots are exclusive: a player wears at most one cosmetic per slot. The `none`
// entry in each slot is the bare default everyone owns, equipping it clears the
// slot. Props reference the real GLBs already shipped in public/accessories/, so
// nothing here points at an asset that 404s.

// Ordered so the wardrobe renders slots top-to-bottom in a sensible grooming flow.
export const SLOTS = ['dye', 'headwear', 'eyewear', 'earrings', 'aura'];

export const SLOT_LABELS = {
	dye: 'Body color',
	headwear: 'Headwear',
	eyewear: 'Eyewear',
	earrings: 'Earrings',
	aura: 'Aura',
};

// tier: 'free' is owned by everyone implicitly; 'premium' must be unlocked
// (W04's shop grants it into the account's owned list). `price` is the $THREE
// cost the shop will charge, surfaced here so the wardrobe can show it, but W03
// never sells (it only exposes the unlock hook).
//
// A third tier, 'event', is a souvenir: it is GRANTED, never sold. The server
// hands it to everyone present in the event world during the live window (see
// multiplayer/src/event-drop.js and the join-time grant in WalkRoom), and after
// the window closes it is simply never granted again. It carries price 0 and so
// never appears in the boutique (shop.js filters on tier 'premium' AND price>0),
// which is what keeps "you had to be there" honest: there is no purchase path,
// before, during, or after. Like premium, it must be owned to be worn.
export const COSMETICS = [
	// ── Body color (dye) ──────────────────────────────────────────────────────
	{ id: 'dye-none', name: 'Natural', slot: 'dye', rarity: 'common', tier: 'free', price: 0, visual: null, swatch: '#d8d8e0' },
	{ id: 'dye-crimson', name: 'Crimson', slot: 'dye', rarity: 'common', tier: 'free', price: 0, visual: { tint: '#c0392b' }, swatch: '#c0392b' },
	{ id: 'dye-azure', name: 'Azure', slot: 'dye', rarity: 'common', tier: 'free', price: 0, visual: { tint: '#2980b9' }, swatch: '#2980b9' },
	{ id: 'dye-emerald', name: 'Emerald', slot: 'dye', rarity: 'common', tier: 'free', price: 0, visual: { tint: '#1e9e5a' }, swatch: '#1e9e5a' },
	{ id: 'dye-gold', name: 'Midas', slot: 'dye', rarity: 'rare', tier: 'premium', price: 250, visual: { tint: '#e6b422' }, swatch: '#e6b422' },
	{ id: 'dye-violet', name: 'Amethyst', slot: 'dye', rarity: 'rare', tier: 'premium', price: 250, visual: { tint: '#8e44ad' }, swatch: '#8e44ad' },

	// ── Headwear (prop, anchored to the head bone) ────────────────────────────
	{ id: 'head-none', name: 'None', slot: 'headwear', rarity: 'common', tier: 'free', price: 0, visual: null },
	{ id: 'hat-beanie', name: 'Beanie', slot: 'headwear', rarity: 'common', tier: 'free', price: 0, visual: { prop: '/accessories/hat-beanie.glb', anchor: 'head' }, thumb: '/accessories/thumbs/hat-beanie.png' },
	{ id: 'hat-baseball', name: 'Ball cap', slot: 'headwear', rarity: 'common', tier: 'free', price: 0, visual: { prop: '/accessories/hat-baseball.glb', anchor: 'head' }, thumb: '/accessories/thumbs/hat-baseball.png' },
	{ id: 'hat-cowboy', name: 'Stetson', slot: 'headwear', rarity: 'rare', tier: 'premium', price: 400, visual: { prop: '/accessories/hat-cowboy.glb', anchor: 'head' }, thumb: '/accessories/thumbs/hat-cowboy.png' },
	{ id: 'laurel-meetup', name: 'Meetup Laurel', slot: 'headwear', rarity: 'legendary', tier: 'event', price: 0, visual: { prop: '/accessories/laurel-meetup.glb', anchor: 'head' }, thumb: '/accessories/thumbs/laurel-meetup.png' },

	// ── Eyewear (prop, anchored at the eye line) ──────────────────────────────
	{ id: 'eye-none', name: 'None', slot: 'eyewear', rarity: 'common', tier: 'free', price: 0, visual: null },
	{ id: 'glasses-round', name: 'Round frames', slot: 'eyewear', rarity: 'common', tier: 'free', price: 0, visual: { prop: '/accessories/glasses-round.glb', anchor: 'face' }, thumb: '/accessories/thumbs/glasses-round.png' },
	{ id: 'glasses-shades', name: 'Shades', slot: 'eyewear', rarity: 'rare', tier: 'premium', price: 350, visual: { prop: '/accessories/glasses-shades.glb', anchor: 'face' }, thumb: '/accessories/thumbs/glasses-shades.png' },

	// ── Earrings (prop, anchored at ear level) ────────────────────────────────
	{ id: 'earring-none', name: 'None', slot: 'earrings', rarity: 'common', tier: 'free', price: 0, visual: null },
	{ id: 'earrings-hoops', name: 'Hoop Earrings', slot: 'earrings', rarity: 'common', tier: 'free', price: 0, visual: { prop: '/accessories/earrings-hoops.glb', anchor: 'ear' }, thumb: '/accessories/thumbs/earrings-hoops.png' },
	{ id: 'earrings-studs', name: 'Stud Earrings', slot: 'earrings', rarity: 'common', tier: 'free', price: 0, visual: { prop: '/accessories/earrings-studs.glb', anchor: 'ear' }, thumb: '/accessories/thumbs/earrings-studs.png' },

	// ── Aura (glowing ground ring) ────────────────────────────────────────────
	{ id: 'aura-none', name: 'None', slot: 'aura', rarity: 'common', tier: 'free', price: 0, visual: null },
	{ id: 'aura-gold', name: 'Golden halo', slot: 'aura', rarity: 'epic', tier: 'premium', price: 600, visual: { aura: '#e6b422' }, swatch: '#e6b422' },
	{ id: 'aura-cyan', name: 'Cyan pulse', slot: 'aura', rarity: 'epic', tier: 'premium', price: 600, visual: { aura: '#00e5ff' }, swatch: '#00e5ff' },
	{ id: 'aura-magenta', name: 'Magenta pulse', slot: 'aura', rarity: 'epic', tier: 'premium', price: 600, visual: { aura: '#ff2d95' }, swatch: '#ff2d95' },
];

export const COSMETICS_BY_ID = new Map(COSMETICS.map((c) => [c.id, c]));

export function getCosmetic(id) {
	return COSMETICS_BY_ID.get(id) || null;
}

// The bare default loadout: each slot's `none`/first-free entry. Everyone starts
// here, owning nothing premium.
export const DEFAULT_LOADOUT = Object.freeze({
	dye: 'dye-none',
	headwear: 'head-none',
	eyewear: 'eye-none',
	earrings: 'earring-none',
	aura: 'aura-none',
});

// Is this id a free cosmetic anyone may wear without owning it? (The `none`
// defaults are free, as are the starter colours/hats.)
export function isFreeCosmetic(id) {
	const c = getCosmetic(id);
	return !!c && c.tier === 'free';
}

// Is this id an event souvenir, granted for being somewhere at some time, never
// purchasable? The grant path (event-drop.js → WalkRoom) checks this so a
// misconfigured event can never hand out a boutique item for nothing, and the
// wardrobe checks it so a locked souvenir offers no "buy it" shortcut.
export function isEventCosmetic(id) {
	const c = getCosmetic(id);
	return !!c && c.tier === 'event';
}

// Is this id one an account has to explicitly own to wear (premium or event)?
// The inverse of isFreeCosmetic for known ids, used by the persistence layer,
// which must keep every unlocked id regardless of how it was unlocked.
export function isUnlockableCosmetic(id) {
	const c = getCosmetic(id);
	return !!c && c.tier !== 'free';
}

// Can `account` (an owned-id set, or array) wear `id`? Free cosmetics are always
// allowed; premium ones only when explicitly owned. Unknown ids are rejected.
export function canWear(id, owned) {
	const c = getCosmetic(id);
	if (!c) return false;
	if (c.tier === 'free') return true;
	if (!owned) return false;
	return owned instanceof Set ? owned.has(id) : Array.isArray(owned) && owned.includes(id);
}

// Coerce an arbitrary equipped map (from a client or a persisted blob) into a
// valid, slot-correct loadout the wearer is actually allowed to use. Anything
// invalid, in the wrong slot, or unowned falls back to that slot's default, so a
// tampered payload can never put an unowned cosmetic on a player.
export function sanitizeLoadout(equipped, owned) {
	const out = { ...DEFAULT_LOADOUT };
	if (equipped && typeof equipped === 'object') {
		for (const slot of SLOTS) {
			const id = equipped[slot];
			const c = getCosmetic(id);
			if (c && c.slot === slot && canWear(id, owned)) out[slot] = id;
		}
	}
	return out;
}

// Compact wire form for the Player schema field peers read: the equipped ids in
// slot order, comma-joined, dropping the `none` defaults (they render nothing).
// Bounded length so the schema diff stays tiny.
export function serializeLoadout(equipped) {
	const ids = [];
	for (const slot of SLOTS) {
		const id = equipped?.[slot];
		const c = getCosmetic(id);
		if (c && c.visual) ids.push(id);
	}
	return ids.join(',');
}

// Parse the wire string back into the list of catalog entries to render. Tolerant
// of unknown/empty ids (a peer on a newer catalog), they're simply skipped.
export function parseLoadout(str) {
	if (!str || typeof str !== 'string') return [];
	return str.split(',').map((id) => getCosmetic(id.trim())).filter((c) => c && c.visual);
}

// The ids a brand-new account implicitly owns (every free cosmetic). Used so the
// wardrobe can show owned vs. locked without a round-trip.
export function freeCosmeticIds() {
	return COSMETICS.filter((c) => c.tier === 'free').map((c) => c.id);
}
