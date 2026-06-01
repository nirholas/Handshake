// Task 21 — cosmetics shop. These cover the data-driven core the buy/equip
// handlers rest on: the catalogue's integrity (every cosmetic is purely visual,
// priced, and rotation-tagged), the deterministic daily/weekly rotation (same
// date ⇒ same offers, across processes), the next-rotation timestamps the client
// counts down to, and the `isOffered` gate the purchase handler trusts. All live
// in a dependency-free module so they assert without standing up a Colyseus room
// — mirroring fishing.test.js / cooking.test.js.
import { describe, it, expect } from 'vitest';
import {
	COSMETICS, RARITIES, DAILY_OFFER_COUNT, WEEKLY_OFFER_COUNT,
	cosmeticById, currentOffers, isOffered, clientCatalog,
	dailyKey, weekKey, nextDailyReset, nextWeeklyReset,
} from '../multiplayer/src/cosmetics.js';

// A fixed instant for deterministic assertions: Mon 2026-06-01 12:00 UTC.
const T = Date.UTC(2026, 5, 1, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

describe('catalogue integrity — every cosmetic is visual-only, priced, rotation-tagged', () => {
	it('has a non-empty catalogue with unique ids', () => {
		expect(COSMETICS.length).toBeGreaterThan(0);
		const ids = COSMETICS.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('every entry has a positive price, known rarity, and a valid rotation', () => {
		for (const c of COSMETICS) {
			expect(typeof c.id).toBe('string');
			expect(c.name).toBeTruthy();
			expect(Number.isInteger(c.price)).toBe(true);
			expect(c.price).toBeGreaterThan(0);
			expect(RARITIES[c.rarity]).toBeTruthy();
			expect(['always', 'daily', 'weekly']).toContain(c.rotation);
		}
	});

	it('every visual spec is strictly cosmetic — only tint / prop / aura keys', () => {
		const allowed = new Set(['tint', 'prop', 'anchor', 'aura']);
		for (const c of COSMETICS) {
			expect(c.visual && typeof c.visual === 'object').toBe(true);
			for (const key of Object.keys(c.visual)) expect(allowed.has(key)).toBe(true);
			// At least one renderable primitive — never an empty (no-op) cosmetic.
			expect(c.visual.tint || c.visual.prop || c.visual.aura).toBeTruthy();
		}
	});

	it('has enough rotating stock that a set genuinely changes each period', () => {
		const daily = COSMETICS.filter((c) => c.rotation === 'daily').length;
		const weekly = COSMETICS.filter((c) => c.rotation === 'weekly').length;
		expect(daily).toBeGreaterThan(DAILY_OFFER_COUNT);
		expect(weekly).toBeGreaterThan(WEEKLY_OFFER_COUNT);
	});

	it('cosmeticById resolves a real entry and rejects unknowns', () => {
		expect(cosmeticById(COSMETICS[0].id)).toBe(COSMETICS[0]);
		expect(cosmeticById('does-not-exist')).toBeNull();
		expect(cosmeticById('')).toBeNull();
	});
});

describe('currentOffers — deterministic rotation, correct bucket sizes', () => {
	it('offers exactly the configured count from each rotating pool', () => {
		const o = currentOffers(T);
		expect(o.daily).toHaveLength(DAILY_OFFER_COUNT);
		expect(o.weekly).toHaveLength(WEEKLY_OFFER_COUNT);
		expect(o.always.length).toBe(COSMETICS.filter((c) => c.rotation === 'always').length);
	});

	it('offered ids are distinct and drawn from the right pool', () => {
		const o = currentOffers(T);
		expect(new Set(o.daily).size).toBe(o.daily.length);
		for (const id of o.daily) expect(cosmeticById(id).rotation).toBe('daily');
		for (const id of o.weekly) expect(cosmeticById(id).rotation).toBe('weekly');
		for (const id of o.always) expect(cosmeticById(id).rotation).toBe('always');
	});

	it('is deterministic for a given instant (same date ⇒ same offers)', () => {
		const a = currentOffers(T);
		const b = currentOffers(T + 60 * 1000); // a minute later, same UTC day/week
		expect(b.daily).toEqual(a.daily);
		expect(b.weekly).toEqual(a.weekly);
	});

	it('the daily set rolls over across a UTC-day boundary', () => {
		// Compare two days far enough apart that the seeded shuffle differs. Some
		// neighbouring days can coincide, so assert change over a span of days.
		const today = currentOffers(T).daily.join(',');
		const later = currentOffers(T + 3 * DAY).daily.join(',');
		// Either the set or its order may shift; over 3 days at least one differs.
		const anyDiff = [1, 2, 3, 4, 5].some((d) => currentOffers(T + d * DAY).daily.join(',') !== today);
		expect(anyDiff || later !== today).toBe(true);
	});
});

describe('rotation keys + next-reset timestamps drive the client countdown', () => {
	it('dailyKey is the UTC date and nextDailyReset is the next UTC midnight', () => {
		expect(dailyKey(T)).toBe('2026-06-01');
		expect(nextDailyReset(T)).toBe(Date.UTC(2026, 5, 2));
		// Idempotent within the same day; advances to the next at the boundary.
		expect(nextDailyReset(T) - T).toBeLessThanOrEqual(DAY);
		expect(nextDailyReset(T)).toBeGreaterThan(T);
	});

	it('weekKey is the ISO-week Monday and nextWeeklyReset is the next Monday', () => {
		// 2026-06-01 is itself a Monday, so the week starts that day.
		expect(weekKey(T)).toBe('2026-06-01');
		const next = nextWeeklyReset(T);
		expect(next).toBe(Date.UTC(2026, 5, 8));
		expect(new Date(next).getUTCDay()).toBe(1); // Monday
	});

	it('mid-week still resolves to the same Monday + the same next reset', () => {
		const wed = T + 2 * DAY; // Wed 2026-06-03
		expect(weekKey(wed)).toBe('2026-06-01');
		expect(nextWeeklyReset(wed)).toBe(Date.UTC(2026, 5, 8));
	});
});

describe('isOffered — the purchase gate', () => {
	it('always-cosmetics are always buyable', () => {
		const always = COSMETICS.find((c) => c.rotation === 'always');
		expect(isOffered(always.id, T)).toBe(true);
	});

	it('matches the current rotating board exactly', () => {
		const o = currentOffers(T);
		for (const id of o.daily) expect(isOffered(id, T)).toBe(true);
		for (const id of o.weekly) expect(isOffered(id, T)).toBe(true);
		// A rotating cosmetic NOT in today's set is not offered.
		const offered = new Set([...o.daily, ...o.weekly]);
		const benched = COSMETICS.find((c) => c.rotation !== 'always' && !offered.has(c.id));
		if (benched) expect(isOffered(benched.id, T)).toBe(false);
	});

	it('rejects unknown ids', () => {
		expect(isOffered('nope', T)).toBe(false);
	});
});

describe('clientCatalog — what the client renders from', () => {
	it('exposes every cosmetic with the fields the shop/wardrobe need, plus rarities', () => {
		const cat = clientCatalog();
		expect(cat.rarities).toBe(RARITIES);
		expect(cat.cosmetics).toHaveLength(COSMETICS.length);
		for (const c of cat.cosmetics) {
			expect(c).toHaveProperty('id');
			expect(c).toHaveProperty('name');
			expect(c).toHaveProperty('rarity');
			expect(c).toHaveProperty('price');
			expect(c).toHaveProperty('rotation');
			expect(c).toHaveProperty('visual');
		}
	});
});
