// Cosmetics shop — the catalog of visual-only looks players buy with gold, and
// the deterministic rotation that decides which ones are on sale right now.
//
// Cosmetics are STRICTLY visual. Nothing here touches combat, stats, movement,
// or any other gameplay value — a cosmetic only changes how an avatar renders
// (a body tint, a worn prop, a ground aura). The server owns purchase + rotation
// authority; the client is sent this catalog so it can render any peer's
// equipped look, and a live shop snapshot (offers + countdowns) when the shop
// opens. Pure + dependency-free so the rotation is unit-tested without a room
// (mirrors quests.js).
//
// Visual spec (`visual`), interpreted only by the client cosmetics renderer:
//   { tint: '#rrggbb' }          recolour the avatar's body materials
//   { prop: '/path.glb', anchor: 'head' }  attach a prop (auto-fitted to the head)
//   { aura: '#rrggbb' }          a glowing ring at the avatar's feet
// A cosmetic may combine fields (e.g. a tint + an aura).

// Rarity tiers, lowest → highest. The colour drives the catalog card accent on
// the client so rarity reads at a glance; kept here so server + client agree.
export const RARITIES = {
	common: { label: 'Common', color: '#9aa7b4' },
	uncommon: { label: 'Uncommon', color: '#4fb477' },
	rare: { label: 'Rare', color: '#4a90e2' },
	epic: { label: 'Epic', color: '#b06ff0' },
	legendary: { label: 'Legendary', color: '#f0a23a' },
};

// The full catalog. `rotation` is one of:
//   'always' — always on sale (a permanent staple)
//   'daily'  — part of the daily-rotating pool (a subset is offered each UTC day)
//   'weekly' — part of the weekly-rotating pool (a subset offered each UTC week)
// Prices are in gold. Ids are stable — never renumber a live cosmetic, since
// ownership and the equipped selection persist by id (Task 16).
export const COSMETICS = [
	// ---- Always available (the staples) ----------------------------------
	{ id: 'tint-ash', name: 'Ashen Cloak', rarity: 'common', price: 60, rotation: 'always', visual: { tint: '#6b6f76' } },
	{ id: 'tint-crimson', name: 'Crimson Dye', rarity: 'common', price: 80, rotation: 'always', visual: { tint: '#c0392b' } },
	{ id: 'tint-azure', name: 'Azure Dye', rarity: 'common', price: 80, rotation: 'always', visual: { tint: '#2e86de' } },
	{ id: 'hat-beanie', name: 'Wool Beanie', rarity: 'common', price: 120, rotation: 'always', visual: { prop: '/accessories/hat-beanie.glb', anchor: 'head' } },

	// ---- Daily rotation pool (DAILY_OFFER_COUNT offered each day) ----------
	{ id: 'tint-emerald', name: 'Emerald Dye', rarity: 'uncommon', price: 140, rotation: 'daily', visual: { tint: '#1abc9c' } },
	{ id: 'tint-violet', name: 'Violet Dye', rarity: 'uncommon', price: 140, rotation: 'daily', visual: { tint: '#8e44ad' } },
	{ id: 'hat-baseball', name: 'Field Cap', rarity: 'uncommon', price: 200, rotation: 'daily', visual: { prop: '/accessories/hat-baseball.glb', anchor: 'head' } },
	{ id: 'glasses-round', name: 'Round Specs', rarity: 'uncommon', price: 180, rotation: 'daily', visual: { prop: '/accessories/glasses-round.glb', anchor: 'face' } },
	{ id: 'tint-gold', name: 'Gilded Sheen', rarity: 'rare', price: 360, rotation: 'daily', visual: { tint: '#f1c40f' } },
	{ id: 'aura-ember', name: 'Ember Aura', rarity: 'rare', price: 420, rotation: 'daily', visual: { aura: '#ff6b35' } },

	// ---- Weekly rotation pool (WEEKLY_OFFER_COUNT offered each week) -------
	{ id: 'hat-cowboy', name: "Ranger's Hat", rarity: 'rare', price: 480, rotation: 'weekly', visual: { prop: '/accessories/hat-cowboy.glb', anchor: 'head' } },
	{ id: 'glasses-shades', name: 'Shades', rarity: 'rare', price: 520, rotation: 'weekly', visual: { prop: '/accessories/glasses-shades.glb', anchor: 'face' } },
	{ id: 'aura-frost', name: 'Frost Aura', rarity: 'epic', price: 700, rotation: 'weekly', visual: { aura: '#6bd3ff' } },
	{ id: 'aura-radiant', name: 'Radiant Aura', rarity: 'epic', price: 760, rotation: 'weekly', visual: { aura: '#ffe27a', tint: '#fff4cf' } },
	{ id: 'aura-void', name: 'Void Aura', rarity: 'legendary', price: 1400, rotation: 'weekly', visual: { aura: '#9b59b6', tint: '#2c2c54' } },
];

// How many of each rotating pool are on sale at once. Kept below each pool's
// size so the set genuinely changes from one period to the next.
export const DAILY_OFFER_COUNT = 3;
export const WEEKLY_OFFER_COUNT = 2;

const BY_ID = new Map(COSMETICS.map((c) => [c.id, c]));
const DAILY_POOL = COSMETICS.filter((c) => c.rotation === 'daily').map((c) => c.id);
const WEEKLY_POOL = COSMETICS.filter((c) => c.rotation === 'weekly').map((c) => c.id);
const ALWAYS = COSMETICS.filter((c) => c.rotation === 'always').map((c) => c.id);

const DAY_MS = 24 * 60 * 60 * 1000;

export function cosmeticById(id) {
	return BY_ID.get(id) || null;
}

// A stable 32-bit hash of a string (FNV-1a) — same constant the quest roller
// uses, so rotations are deterministic across processes and restarts.
function hashString(s) {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

// Epoch ms of the most recent UTC midnight at or before `now`.
function startOfUtcDay(now) {
	const d = new Date(now);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// 'YYYY-MM-DD' (UTC) for `now` — the key the daily rotation is seeded with.
export function dailyKey(now) {
	return new Date(startOfUtcDay(now)).toISOString().slice(0, 10);
}

// Epoch ms of the next UTC midnight — when the daily set rotates. The client
// renders a live countdown to this and re-requests the shop when it passes.
export function nextDailyReset(now) {
	return startOfUtcDay(now) + DAY_MS;
}

// Epoch ms of UTC Monday 00:00 at or before `now` (ISO week start).
function startOfUtcWeek(now) {
	const dow = (new Date(now).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
	return startOfUtcDay(now) - dow * DAY_MS;
}

// Week key — the Monday date string the weekly rotation is seeded with.
export function weekKey(now) {
	return new Date(startOfUtcWeek(now)).toISOString().slice(0, 10);
}

// Epoch ms of the next UTC Monday — when the weekly set rotates.
export function nextWeeklyReset(now) {
	return startOfUtcWeek(now) + 7 * DAY_MS;
}

// Deterministically pick `count` distinct ids from `pool` for a rotation key.
// Seeded Fisher–Yates (xorshift32 PRNG) — identical to the daily-quest roller,
// so a period's offers are fixed and reproducible on every server/restart.
function rollOffers(pool, key, count) {
	if (count >= pool.length) return [...pool];
	const seed = hashString(key);
	const idx = pool.map((_, i) => i);
	let state = seed || 1;
	const rand = () => {
		state ^= state << 13; state >>>= 0;
		state ^= state >> 17;
		state ^= state << 5; state >>>= 0;
		return state / 0xffffffff;
	};
	for (let i = idx.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[idx[i], idx[j]] = [idx[j], idx[i]];
	}
	return idx.slice(0, count).map((i) => pool[i]);
}

// The current offer board: which cosmetic ids are buyable right now, split by
// bucket, plus the epoch-ms moments each rotation next turns over (for the
// client countdowns). Server-authoritative — derived purely from `now`.
export function currentOffers(now) {
	return {
		always: [...ALWAYS],
		daily: rollOffers(DAILY_POOL, dailyKey(now), DAILY_OFFER_COUNT),
		weekly: rollOffers(WEEKLY_POOL, weekKey(now), WEEKLY_OFFER_COUNT),
		dailyResetAt: nextDailyReset(now),
		weeklyResetAt: nextWeeklyReset(now),
	};
}

// Whether a given cosmetic is on sale at `now`. Always-cosmetics are always
// offered; rotating ones only during their current window. The buy handler
// gates on this so a client can't purchase something not currently for sale.
export function isOffered(id, now) {
	const c = BY_ID.get(id);
	if (!c) return false;
	if (c.rotation === 'always') return true;
	const offers = currentOffers(now);
	return c.rotation === 'daily' ? offers.daily.includes(id) : offers.weekly.includes(id);
}

// Pure purchase rule — the single source of truth for whether a buy is allowed,
// shared by the server buy handler and its tests. Returns the resolved cosmetic
// plus an outcome code so the caller can phrase the notice (and compute the gold
// shortfall) without re-deriving the rules:
//   'unknown'     — no such cosmetic id
//   'owned'       — the player already owns it
//   'not-offered' — exists but isn't in the current rotation
//   'poor'        — offered + unowned, but the player can't afford it
//   'ok'          — buyable now
// `owned` may be a Set or an array of ids; `gold` is the player's purse.
export function evaluatePurchase(gold, owned, id, now) {
	const cosmetic = cosmeticById(id);
	if (!cosmetic) return { ok: false, reason: 'unknown', cosmetic: null };
	const has = owned instanceof Set ? owned.has(id) : Array.isArray(owned) && owned.includes(id);
	if (has) return { ok: false, reason: 'owned', cosmetic };
	if (!isOffered(id, now)) return { ok: false, reason: 'not-offered', cosmetic };
	if ((gold | 0) < cosmetic.price) return { ok: false, reason: 'poor', cosmetic };
	return { ok: true, reason: 'ok', cosmetic };
}

// The catalog as sent to the client: every cosmetic's id, name, rarity, price,
// rotation, and visual spec, plus the rarity palette. The client renders peers'
// equipped looks and the shop/wardrobe entirely from this — no prices or visuals
// are hard-coded client-side.
export function clientCatalog() {
	return {
		rarities: RARITIES,
		cosmetics: COSMETICS.map((c) => ({
			id: c.id, name: c.name, rarity: c.rarity, price: c.price,
			rotation: c.rotation, visual: c.visual,
		})),
	};
}
