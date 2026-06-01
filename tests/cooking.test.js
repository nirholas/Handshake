// Task 06 — cooking & edible food. These cover the data-driven core the cooking
// feature rests on: the item registry's edibility/heal/stack facts (which the
// server's consume handler reads) and the burn-chance curve (which the cook
// handler rolls against). Both live in the dependency-free items module so they
// can be asserted without standing up a Colyseus room.
import { describe, it, expect } from 'vitest';
import {
	ITEMS, STACKABLE_ITEMS, isEdible, isStackable, healValue, cookBurnChance,
} from '../multiplayer/src/items.js';

describe('item registry — consumables', () => {
	it('cooked fish is a stackable, edible heal of 11', () => {
		expect(ITEMS.cookedFish).toMatchObject({ stackable: true, edible: true, heal: 11 });
		expect(isEdible('cookedFish')).toBe(true);
		expect(isStackable('cookedFish')).toBe(true);
		expect(healValue('cookedFish')).toBe(11);
	});

	it('health potion is edible with its own heal value', () => {
		expect(isEdible('healthPotion')).toBe(true);
		expect(healValue('healthPotion')).toBe(28);
	});

	it('raw fish and tools are not edible and heal nothing', () => {
		expect(isEdible('fish')).toBe(false);
		expect(isEdible('axe')).toBe(false);
		expect(healValue('fish')).toBe(0);
		expect(healValue('axe')).toBe(0);
		expect(healValue('nonexistent')).toBe(0);
	});

	it('STACKABLE_ITEMS includes cooked fish + raw fish but not tools', () => {
		expect(STACKABLE_ITEMS.has('cookedFish')).toBe(true);
		expect(STACKABLE_ITEMS.has('fish')).toBe(true);
		expect(STACKABLE_ITEMS.has('axe')).toBe(false);
		expect(STACKABLE_ITEMS.has('sword')).toBe(false);
	});
});

describe('cookBurnChance — fair, falling burn curve', () => {
	it('starts at 40% for a level-1 cook', () => {
		expect(cookBurnChance(1)).toBeCloseTo(0.4, 10);
	});

	it('never burns once trained, and stays clamped at high levels', () => {
		expect(cookBurnChance(40)).toBe(0);
		expect(cookBurnChance(99)).toBe(0);
		// Below-floor inputs are treated as level 1 (max burn), never negative.
		expect(cookBurnChance(0)).toBeLessThanOrEqual(0.4);
		expect(cookBurnChance(-5)).toBeLessThanOrEqual(0.4);
	});

	it('is monotonically non-increasing and bounded in [0, 0.4]', () => {
		let prev = Infinity;
		for (let lvl = 1; lvl <= 99; lvl++) {
			const c = cookBurnChance(lvl);
			expect(c).toBeGreaterThanOrEqual(0);
			expect(c).toBeLessThanOrEqual(0.4);
			expect(c).toBeLessThanOrEqual(prev + 1e-12);
			prev = c;
		}
	});

	it('reaches zero burn somewhere in the high 30s', () => {
		expect(cookBurnChance(30)).toBeGreaterThan(0);
		expect(cookBurnChance(38)).toBe(0);
	});
});
