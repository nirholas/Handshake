import { describe, it, expect } from 'vitest';
import {
	LOOT_TABLES,
	rollLoot,
	isMount,
	mountStepMs,
	itemLabel,
	itemDef,
	isStackable,
} from '../multiplayer/src/items.js';

// ---------------------------------------------------------------------------
// Loot tables
// ---------------------------------------------------------------------------

describe('LOOT_TABLES', () => {
	it('dummy drops nothing', () => {
		expect(LOOT_TABLES.dummy).toEqual([]);
	});

	it('goblin table contains bones, hide, coal, dire_wolf', () => {
		const ids = LOOT_TABLES.goblin.map((e) => e.item);
		expect(ids).toContain('bones');
		expect(ids).toContain('hide');
		expect(ids).toContain('coal');
		expect(ids).toContain('dire_wolf');
	});

	it('ogre table contains bones, hide, stone, dire_wolf, war_boar', () => {
		const ids = LOOT_TABLES.ogre.map((e) => e.item);
		expect(ids).toContain('bones');
		expect(ids).toContain('hide');
		expect(ids).toContain('stone');
		expect(ids).toContain('dire_wolf');
		expect(ids).toContain('war_boar');
	});

	it('all chances are in (0, 1]', () => {
		for (const [kind, table] of Object.entries(LOOT_TABLES)) {
			for (const entry of table) {
				expect(entry.chance, `${kind}.${entry.item} chance`).toBeGreaterThan(0);
				expect(entry.chance, `${kind}.${entry.item} chance`).toBeLessThanOrEqual(1);
			}
		}
	});

	it('mount entries have no min/max (qty always 1)', () => {
		for (const table of Object.values(LOOT_TABLES)) {
			for (const entry of table) {
				if (isMount(entry.item)) {
					expect(entry.min).toBeUndefined();
					expect(entry.max).toBeUndefined();
				}
			}
		}
	});
});

// ---------------------------------------------------------------------------
// rollLoot
// ---------------------------------------------------------------------------

describe('rollLoot', () => {
	it('returns [] for dummy', () => {
		// Always-drop rng still gets nothing from dummy.
		expect(rollLoot('dummy', () => 0)).toEqual([]);
	});

	it('returns [] for unknown kind', () => {
		expect(rollLoot('dragon', () => 0)).toEqual([]);
	});

	it('drops all goblin items when rng always passes (returns 0)', () => {
		const drops = rollLoot('goblin', () => 0);
		const ids = drops.map((d) => d.item);
		expect(ids).toContain('bones');
		expect(ids).toContain('hide');
		expect(ids).toContain('coal');
		expect(ids).toContain('dire_wolf');
	});

	it('drops nothing when rng always fails (returns 1)', () => {
		// rng() >= chance for every entry → nothing rolls.
		expect(rollLoot('goblin', () => 1)).toEqual([]);
		expect(rollLoot('ogre', () => 1)).toEqual([]);
	});

	it('mount entries always have qty 1', () => {
		const drops = rollLoot('ogre', () => 0);
		for (const d of drops) {
			if (isMount(d.item)) expect(d.qty).toBe(1);
		}
	});

	it('stackable entries respect min/max', () => {
		// rng returns 0 → qty = min + 0*(max-min) = min
		const drops = rollLoot('ogre', () => 0);
		const bones = drops.find((d) => d.item === 'bones');
		expect(bones).toBeDefined();
		expect(bones.qty).toBe(1); // min of ogre bones entry

		// rng returns 0 for chance check, then 1 for qty roll → qty = max
		let callCount = 0;
		const rngMax = () => {
			callCount++;
			// First call is the chance roll (0 → passes); subsequent calls are qty rolls.
			return callCount === 1 ? 0 : 0.9999;
		};
		const drops2 = rollLoot('goblin', rngMax);
		const bones2 = drops2.find((d) => d.item === 'bones');
		expect(bones2).toBeDefined();
		expect(bones2.qty).toBe(2); // max of goblin bones entry
	});

	it('statistical: goblin mount drop rate ~5% over many rolls', () => {
		const N = 50_000;
		let mounts = 0;
		for (let i = 0; i < N; i++) {
			const drops = rollLoot('goblin');
			if (drops.some((d) => isMount(d.item))) mounts++;
		}
		const rate = mounts / N;
		// 5% chance; expect within ±2% with high confidence over 50k trials.
		expect(rate).toBeGreaterThan(0.03);
		expect(rate).toBeLessThan(0.09);
	});

	it('statistical: ogre mount drop rate ~17% (7% wolf + 10% boar, independent)', () => {
		const N = 50_000;
		let kills = 0;
		for (let i = 0; i < N; i++) {
			const drops = rollLoot('ogre');
			if (drops.some((d) => isMount(d.item))) kills++;
		}
		const rate = kills / N;
		// ~17% overall (can drop both on a lucky kill, so slightly less than sum).
		expect(rate).toBeGreaterThan(0.13);
		expect(rate).toBeLessThan(0.21);
	});
});

// ---------------------------------------------------------------------------
// Mount item registry
// ---------------------------------------------------------------------------

describe('isMount', () => {
	it('recognises dire_wolf and war_boar as mounts', () => {
		expect(isMount('dire_wolf')).toBe(true);
		expect(isMount('war_boar')).toBe(true);
	});

	it('returns false for tools and resources', () => {
		expect(isMount('sword')).toBe(false);
		expect(isMount('axe')).toBe(false);
		expect(isMount('bones')).toBe(false);
		expect(isMount('hide')).toBe(false);
		expect(isMount('healthPotion')).toBe(false);
	});

	it('returns false for unknown ids', () => {
		expect(isMount('')).toBe(false);
		expect(isMount('dragon')).toBe(false);
	});
});

describe('mountStepMs', () => {
	it('dire_wolf is faster than on-foot (140ms)', () => {
		expect(mountStepMs('dire_wolf')).toBeLessThan(140);
	});

	it('war_boar is faster than on-foot (140ms)', () => {
		expect(mountStepMs('war_boar')).toBeLessThan(140);
	});

	it('dire_wolf is faster than war_boar', () => {
		expect(mountStepMs('dire_wolf')).toBeLessThan(mountStepMs('war_boar'));
	});

	it('returns null for non-mount items', () => {
		expect(mountStepMs('sword')).toBeNull();
		expect(mountStepMs('bones')).toBeNull();
		expect(mountStepMs('')).toBeNull();
	});
});

describe('mount item definitions', () => {
	it('mounts are non-stackable', () => {
		expect(isStackable('dire_wolf')).toBe(false);
		expect(isStackable('war_boar')).toBe(false);
	});

	it('mounts have labels', () => {
		expect(itemLabel('dire_wolf')).toBeTruthy();
		expect(itemLabel('war_boar')).toBeTruthy();
	});

	it('mount def includes color, accent, scale', () => {
		const wolf = itemDef('dire_wolf');
		expect(wolf.mount.color).toBeDefined();
		expect(wolf.mount.accent).toBeDefined();
		expect(wolf.mount.scale).toBeDefined();

		const boar = itemDef('war_boar');
		expect(boar.mount.color).toBeDefined();
		expect(boar.mount.accent).toBeDefined();
		expect(boar.mount.scale).toBeDefined();
	});
});
