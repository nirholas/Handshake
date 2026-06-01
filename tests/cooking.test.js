// Task 06 — cooking & edible food. These cover the data-driven core the cooking
// feature rests on: the item registry's edibility/heal/stack facts (which the
// server's consume handler reads), the burn-chance curve (which the cook handler
// rolls against), level-scaled healing, and the daily quest pool entries.
import { describe, it, expect } from 'vitest';
import {
	ITEMS, STACKABLE_ITEMS, isEdible, isStackable, healValue, scaledHeal, cookBurnChance, clientItemRegistry,
} from '../multiplayer/src/items.js';
import { DAILY_POOL, BADGES } from '../multiplayer/src/quests.js';

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

describe('scaledHeal — cooking level makes food better', () => {
	it('level 1 cook heals the base 11 HP', () => {
		expect(scaledHeal('cookedFish', 1)).toBe(11);
	});

	it('heal improves with cooking level', () => {
		expect(scaledHeal('cookedFish', 10)).toBeGreaterThan(scaledHeal('cookedFish', 1));
		expect(scaledHeal('cookedFish', 50)).toBeGreaterThan(scaledHeal('cookedFish', 10));
		expect(scaledHeal('cookedFish', 99)).toBeGreaterThan(scaledHeal('cookedFish', 50));
	});

	it('potions return their flat base value regardless of cooking level', () => {
		const base = healValue('healthPotion');
		expect(scaledHeal('healthPotion', 1)).toBe(base);
		expect(scaledHeal('healthPotion', 99)).toBe(base);
	});

	it('non-edibles and unknown items always return 0', () => {
		expect(scaledHeal('fish', 99)).toBe(0);
		expect(scaledHeal('axe', 99)).toBe(0);
		expect(scaledHeal('nonexistent', 10)).toBe(0);
	});

	it('below-floor levels clamp to level 1 (no negative bonuses)', () => {
		expect(scaledHeal('cookedFish', 0)).toBe(scaledHeal('cookedFish', 1));
		expect(scaledHeal('cookedFish', -5)).toBe(scaledHeal('cookedFish', 1));
	});
});

describe('clientItemRegistry — heal exposed to client', () => {
	it('edible items carry their base heal in the client registry', () => {
		const reg = clientItemRegistry();
		expect(reg.cookedFish.heal).toBe(11);
		expect(reg.healthPotion.heal).toBe(28);
	});

	it('non-edible items have no heal key', () => {
		const reg = clientItemRegistry();
		expect(reg.fish.heal).toBeUndefined();
		expect(reg.axe.heal).toBeUndefined();
	});
});

describe('daily quest pool — fishing and cooking quests exist', () => {
	it('pool contains at least one fishing quest', () => {
		const fishQuests = DAILY_POOL.filter((q) => q.type === 'fish');
		expect(fishQuests.length).toBeGreaterThan(0);
		for (const q of fishQuests) {
			expect(q.id).toBeTruthy();
			expect(q.item).toBe('fish');
			expect(q.count).toBeGreaterThan(0);
			expect(q.reward).toBeDefined();
		}
	});

	it('pool contains at least one cooking quest', () => {
		const cookQuests = DAILY_POOL.filter((q) => q.type === 'cook');
		expect(cookQuests.length).toBeGreaterThan(0);
		for (const q of cookQuests) {
			expect(q.item).toBe('cookedFish');
			expect(q.count).toBeGreaterThan(0);
		}
	});

	it('fishing and cooking badges are defined', () => {
		expect(BADGES.fisher).toBeDefined();
		expect(BADGES.pitcook).toBeDefined();
	});
});
