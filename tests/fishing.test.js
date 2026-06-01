// Task 05 — fishing. These cover the data-driven core the cast handler rests on:
// the catch + double-haul curves (which the server rolls a single cast against)
// and the realm fishing-spot data + adjacency helper (which gate a cast to shore
// tiles beside water). All live in dependency-free modules so they can be
// asserted without standing up a Colyseus room — mirroring cooking.test.js.
import { describe, it, expect } from 'vitest';
import { fishCatchChance, fishDoubleChance, STACKABLE_ITEMS } from '../multiplayer/src/items.js';
import { REALMS, fishingSpotNear } from '../multiplayer/src/rooms/realms.js';

describe('fishCatchChance — rises with skill + spot quality, capped', () => {
	it('starts at 40% for a level-1 angler on average water', () => {
		expect(fishCatchChance(1, 1)).toBeCloseTo(0.4, 10);
	});

	it('improves as fishing level rises (the core progression promise)', () => {
		expect(fishCatchChance(20, 1)).toBeGreaterThan(fishCatchChance(1, 1));
		expect(fishCatchChance(99, 1)).toBeGreaterThan(fishCatchChance(20, 1));
	});

	it('richer water catches more often than poor water at the same level', () => {
		// Pond (1.3) beats Whisperwood pools (0.9) for a given angler.
		expect(fishCatchChance(10, 1.3)).toBeGreaterThan(fishCatchChance(10, 0.9));
	});

	it('is monotonically non-decreasing in level and bounded in [0, 0.95]', () => {
		let prev = -Infinity;
		for (let lvl = 1; lvl <= 99; lvl++) {
			const c = fishCatchChance(lvl, 1);
			expect(c).toBeGreaterThanOrEqual(0);
			expect(c).toBeLessThanOrEqual(0.95);
			expect(c).toBeGreaterThanOrEqual(prev - 1e-12);
			prev = c;
		}
	});

	it('never guarantees a catch even on the best water at the cap', () => {
		expect(fishCatchChance(99, 1.3)).toBeLessThanOrEqual(0.95);
		expect(fishCatchChance(99, 5)).toBe(0.95); // absurd quality still clamps
	});

	it('treats below-floor levels and bad quality as level 1 / quality 1', () => {
		expect(fishCatchChance(0, 1)).toBeCloseTo(0.4, 10);
		expect(fishCatchChance(-5, 1)).toBeCloseTo(0.4, 10);
		expect(fishCatchChance(1, 0)).toBeCloseTo(0.4, 10);
		expect(fishCatchChance(1, -2)).toBeCloseTo(0.4, 10);
	});
});

describe('fishDoubleChance — a treat that scales, never the norm', () => {
	it('is zero at level 1 (no doubles for a raw beginner)', () => {
		expect(fishDoubleChance(1, 1)).toBe(0);
	});

	it('grows with level and quality but stays clamped at 45%', () => {
		expect(fishDoubleChance(10, 1)).toBeGreaterThan(0);
		expect(fishDoubleChance(50, 1.3)).toBeGreaterThan(fishDoubleChance(10, 1));
		for (let lvl = 1; lvl <= 99; lvl++) {
			expect(fishDoubleChance(lvl, 1.3)).toBeLessThanOrEqual(0.45);
		}
	});
});

describe('catch yield is a stackable item', () => {
	it('raw fish stacks so repeated casts fill one slot', () => {
		expect(STACKABLE_ITEMS.has('fish')).toBe(true);
	});
});

describe('realm fishing data — fishable shores beside water', () => {
	it('Pond is the richest water, Whisperwood the poorest of the fishable realms', () => {
		const pondQ = REALMS.pond.fishing[0].quality;
		const woodQ = REALMS.whisperwood.fishing[0].quality;
		const landQ = REALMS.mainland.fishing[0].quality;
		expect(pondQ).toBeGreaterThan(landQ);
		expect(landQ).toBeGreaterThan(woodQ);
	});

	it('every fishing spot carries a positive quality multiplier', () => {
		for (const realm of Object.values(REALMS)) {
			for (const spot of realm.fishing) {
				expect(spot.quality).toBeGreaterThan(0);
				expect(Number.isFinite(spot.tx)).toBe(true);
				expect(Number.isFinite(spot.ty)).toBe(true);
			}
		}
	});

	it('mine and wilderness have no fishing (dry/dangerous realms)', () => {
		expect(REALMS.mine.fishing).toHaveLength(0);
		expect(REALMS.wilderness.fishing).toHaveLength(0);
	});
});

describe('fishingSpotNear — 8-way adjacency gate, picks the richest reachable water', () => {
	const pond = REALMS.pond;
	const spot = pond.fishing[0]; // { tx: 13, ty: 14, quality: 1.3 }

	it('finds the spot when standing on it', () => {
		expect(fishingSpotNear(pond, spot.tx, spot.ty)).toBeTruthy();
	});

	it('finds the spot from a diagonally adjacent tile', () => {
		expect(fishingSpotNear(pond, spot.tx - 1, spot.ty - 1)).toBeTruthy();
		expect(fishingSpotNear(pond, spot.tx + 1, spot.ty + 1)).toBeTruthy();
	});

	it('returns null when two or more tiles away from any water', () => {
		expect(fishingSpotNear(pond, spot.tx + 3, spot.ty + 3)).toBeNull();
		expect(fishingSpotNear(pond, 0, 0)).toBeNull();
	});

	it('returns null in a realm with no fishing water', () => {
		expect(fishingSpotNear(REALMS.mine, 16, 28)).toBeNull();
	});

	it('prefers the higher-quality spot when two are in reach', () => {
		// Hand-built realm stub: a poor spot and a rich spot both within one tile.
		const realm = { fishing: [
			{ tx: 5, ty: 5, quality: 0.5 },
			{ tx: 6, ty: 5, quality: 1.5 },
		] };
		expect(fishingSpotNear(realm, 5, 5).quality).toBe(1.5);
	});
});
