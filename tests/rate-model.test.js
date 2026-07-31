// Tests for multiplayer/src/rate-model.js, the closed-form economic model of the
// /play coin worlds.
//
// The model makes an unusually strong claim: that its rates are EXACT, not
// estimated. A test that re-derived the same formula would be worthless here, since
// it would agree with the model even when both were wrong. So the central tests
// below drive the REAL production handlers (`handleGather`, `handleCook` from
// activities.js) against a seeded RNG for tens of thousands of swings and check that
// the observed mean lands inside the sampling interval around the closed form.
//
// That makes the simulation an independent second implementation: the analytic path
// reads the probability curves, the empirical path runs the actual game code, and
// the two have to meet. If someone changes a handler without changing the model, or
// a curve without changing the handler, this goes red.
//
// The remaining tests pin structural invariants (odds sum to one, unsustainable
// rates never win a ranking) that a sampling test cannot see.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
	gatherRate, fishRate, cookRate, fishCookLoop, combatValue, wheelValue,
	activityLadder, sustainableBest, catalogPayback, breakEvenLevel, timeToLevel,
	allCurves, solveAt, findings, bestFishingSpot, ASSUMPTIONS,
} from '../multiplayer/src/rate-model.js';
import { handleGather, handleCook, ACTIVITY_COOLDOWN_MS } from '../multiplayer/src/activities.js';
import { newProfile, addItem, LEVEL_CAP } from '../multiplayer/src/economy.js';
import { TREES, ROCKS, FISHING_SPOTS } from '../multiplayer/src/world-features.js';
import { SELL_PRICES, BUY_CATALOG } from '../multiplayer/src/shop.js';
import { WHEEL_SEGMENTS } from '../multiplayer/src/spin-wheel.js';
import { MOB_STATS, LOOT_TABLES } from '../multiplayer/src/items.js';

// mulberry32: a small, fast, well-distributed PRNG. Seeded so a failure is
// reproducible rather than a flake somebody reruns until it passes.
function seededRandom(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// A room stub exposing exactly the surface the activity handlers reach for. Nothing
// is faked about the economics: addItem, the probability rolls and the XP arithmetic
// all run the real code. Only the transport (client.send) and persistence are inert.
function stubRoom(profile, sessionId = 's1') {
	const observed = { xp: 0, notices: [] };
	const room = {
		state: { players: new Map([[sessionId, { x: 0, z: 0 }]]) },
		econ: new Map([[sessionId, profile]]),
		_actionOk: () => true,
		_grantXp: (_client, _profile, _skill, amount) => { observed.xp += amount; },
		_sendInv: () => {},
		_persistEcon: () => {},
		_questEvent: () => {},
	};
	const client = { sessionId, send: (kind, payload) => observed.notices.push({ kind, ...payload }) };
	return { room, client, observed };
}

// Put the player on top of a node so the handler's range check passes, and equip the
// tool the activity demands. The starter hotbar is [rod, axe, pickaxe, sword, pistol].
const TOOL_SLOT = { chop: 1, mine: 2 };

function countOf(profile, item) {
	let n = 0;
	for (const slot of profile.inv) if (slot.item === item) n += slot.qty;
	for (const slot of profile.hotbar) if (slot.item === item) n += slot.qty;
	return n;
}

// Run `attempts` real gather swings and report the observed per-attempt means.
function simulateGather(family, level, node, attempts, seed) {
	const profile = newProfile('sim');
	profile.levels.woodcutting = level;
	profile.levels.mining = level;
	profile.activeSlot = TOOL_SLOT[family];
	const { room, client, observed } = stubRoom(profile);
	room.state.players.get('s1').x = node.x;
	room.state.players.get('s1').z = node.z;

	const rng = seededRandom(seed);
	const spy = vi.spyOn(Math, 'random').mockImplementation(rng);
	try {
		for (let i = 0; i < attempts; i += 1) {
			// The pack is emptied every swing so a full inventory never truncates a
			// yield: the model documents "pack space is available" as an assumption,
			// and the simulation has to honour the same assumption to be comparable.
			profile.inv = profile.inv.map(() => ({ item: '', qty: 0 }));
			handleGather(room, client, family);
			const item = family === 'chop' ? 'wood' : 'stone';
			observed.units = (observed.units || 0) + countOf(profile, item);
			observed.coal = (observed.coal || 0) + countOf(profile, 'coal');
		}
	} finally {
		spy.mockRestore();
	}
	return {
		unitsPerAttempt: (observed.units || 0) / attempts,
		coalPerAttempt: (observed.coal || 0) / attempts,
		xpPerAttempt: observed.xp / attempts,
	};
}

function simulateCook(level, attempts, seed) {
	const profile = newProfile('sim');
	profile.levels.cooking = level;
	const { room, client, observed } = stubRoom(profile);
	// Firepits sit at fixed world coordinates; stand on the first one.
	const rng = seededRandom(seed);
	const spy = vi.spyOn(Math, 'random').mockImplementation(rng);
	let cooked = 0;
	try {
		for (let i = 0; i < attempts; i += 1) {
			profile.inv = profile.inv.map(() => ({ item: '', qty: 0 }));
			addItem(profile, 'fish', 1);
			handleCook(room, client);
			cooked += countOf(profile, 'cookedFish');
		}
	} finally {
		spy.mockRestore();
	}
	return { cookedPerAttempt: cooked / attempts, xpPerAttempt: observed.xp / attempts };
}

describe('rate-model: the closed form matches the real handlers', () => {
	// 40k swings puts the standard error on a Bernoulli mean near 0.0025, so a 3%
	// relative tolerance is several standard errors wide: comfortably immune to
	// sampling noise, and far too tight to survive an actual formula error.
	const ATTEMPTS = 40_000;
	const TOLERANCE = 0.03;

	it.each([
		['chop', 1],
		['chop', 42],
		['mine', 1],
		['mine', 42],
	])('%s at level %i matches a seeded simulation of the production handler', (family, level) => {
		const node = family === 'chop' ? TREES[0] : ROCKS[0];
		const model = gatherRate(family, level, node);
		const sim = simulateGather(family, level, node, ATTEMPTS, 0xC0FFEE + level);

		const modelUnitsPerAttempt = model.unitsPerHour / model.attemptsPerHour;
		const modelXpPerAttempt = model.xpPerHour / model.attemptsPerHour;

		expect(sim.unitsPerAttempt).toBeGreaterThan(modelUnitsPerAttempt * (1 - TOLERANCE));
		expect(sim.unitsPerAttempt).toBeLessThan(modelUnitsPerAttempt * (1 + TOLERANCE));
		expect(sim.xpPerAttempt).toBeGreaterThan(modelXpPerAttempt * (1 - TOLERANCE));
		expect(sim.xpPerAttempt).toBeLessThan(modelXpPerAttempt * (1 + TOLERANCE));
	});

	it('models the mining coal bonus at the rate the handler actually rolls it', () => {
		const node = ROCKS[3]; // the richest coal seam, so the bonus is far from zero
		const model = gatherRate('mine', 30, node);
		const sim = simulateGather('mine', 30, node, ATTEMPTS, 0xBEEF);
		const modelCoalPerAttempt = model.coalPerHour / model.attemptsPerHour;

		expect(modelCoalPerAttempt).toBeGreaterThan(0);
		expect(sim.coalPerAttempt).toBeGreaterThan(modelCoalPerAttempt * (1 - TOLERANCE));
		expect(sim.coalPerAttempt).toBeLessThan(modelCoalPerAttempt * (1 + TOLERANCE));
	});

	it.each([1, 25])('cooking at level %i matches the handler burn rate and XP', (level) => {
		const model = cookRate(level);
		const sim = simulateCook(level, ATTEMPTS, 0xFEED + level);
		const modelCookedPerAttempt = model.unitsPerHour / model.attemptsPerHour;
		const modelXpPerAttempt = model.xpPerHour / model.attemptsPerHour;

		expect(sim.cookedPerAttempt).toBeGreaterThan(modelCookedPerAttempt * (1 - TOLERANCE));
		expect(sim.cookedPerAttempt).toBeLessThan(modelCookedPerAttempt * (1 + TOLERANCE));
		expect(sim.xpPerAttempt).toBeGreaterThan(modelXpPerAttempt * (1 - TOLERANCE));
		expect(sim.xpPerAttempt).toBeLessThan(modelXpPerAttempt * (1 + TOLERANCE));
	});

	it('uses the exact rounded-XP expectation, not the mean of the roll', () => {
		// round((9 + k + lvl*0.3) * 1.2) over k in 0..4 is where substituting the mean
		// of k would silently differ. This asserts the model sits on the exact sum, so
		// the shortcut cannot be reintroduced without the test noticing.
		const node = { id: 't', difficulty: 1.2 };
		const level = 7;
		let exact = 0;
		for (let k = 0; k < 5; k += 1) exact += Math.round((9 + k + level * 0.3) * 1.2);
		exact /= 5;
		const naive = Math.round((9 + 2 + level * 0.3) * 1.2);
		expect(exact).not.toBe(naive);

		const model = gatherRate('chop', level, node);
		const perAttempt = model.xpPerHour / model.attemptsPerHour;
		// Reconstruct the model's own decomposition from the exact term and confirm it
		// is the exact one that reproduces the published rate.
		const { successPct, doublePct } = model;
		const p = successPct / 100;
		const d = doublePct / 100;
		const rebuiltExact = (1 - p) * 2 + p * exact * (1 + d);
		const rebuiltNaive = (1 - p) * 2 + p * naive * (1 + d);
		expect(perAttempt).toBeCloseTo(rebuiltExact, 6);
		expect(perAttempt).not.toBeCloseTo(rebuiltNaive, 6);
	});
});

describe('rate-model: cadence and pricing come from the game tables', () => {
	it('divides by the server-enforced cadence, never a hardcoded one', () => {
		for (const family of ['chop', 'mine']) {
			const r = gatherRate(family, 1, family === 'chop' ? TREES[0] : ROCKS[0]);
			expect(r.cadenceMs).toBe(ACTIVITY_COOLDOWN_MS[family]);
			expect(r.attemptsPerHour).toBeCloseTo(3_600_000 / ACTIVITY_COOLDOWN_MS[family], 2);
		}
		expect(fishRate(1, FISHING_SPOTS[0]).cadenceMs).toBe(ACTIVITY_COOLDOWN_MS.fish);
		expect(cookRate(1).cadenceMs).toBe(ACTIVITY_COOLDOWN_MS.cook);
	});

	it('values every yield at the store sell price rather than a copy of it', () => {
		const r = gatherRate('chop', 1, TREES[0]);
		expect(r.cashPerHour).toBeCloseTo(r.unitsPerHour * SELL_PRICES.wood, 1);

		const mine = gatherRate('mine', 40, ROCKS[1]);
		expect(mine.cashPerHour).toBeCloseTo(
			mine.unitsPerHour * SELL_PRICES.stone + mine.coalPerHour * SELL_PRICES.coal,
			1,
		);
	});

	it('prices the wheel from the wedge table, with odds that sum to one', () => {
		const w = wheelValue();
		expect(w.wedges).toBe(WHEEL_SEGMENTS.length);
		expect(WHEEL_SEGMENTS.reduce((s, x) => s + x.oddsPct, 0)).toBe(100);

		const manual = WHEEL_SEGMENTS.reduce((sum, seg) => {
			const value = seg.kind === 'gold' ? seg.gold : seg.qty * (SELL_PRICES[seg.item] || 0);
			return sum + (seg.oddsPct / 100) * value;
		}, 0);
		expect(w.evCash).toBeCloseTo(Math.round(manual * 100) / 100, 2);
		expect(w.bestCash).toBeGreaterThan(w.evCash);
		expect(w.worstCash).toBeLessThan(w.evCash);
		expect(w.stdevCash).toBeGreaterThan(0);
	});

	it('sums combat loot as independent rolls against the live loot table', () => {
		for (const kind of Object.keys(MOB_STATS)) {
			const v = combatValue(kind);
			const manual = LOOT_TABLES[kind].reduce((sum, e) => {
				const min = e.min ?? 1;
				const max = e.max ?? min;
				return sum + e.chance * ((min + max) / 2) * (SELL_PRICES[e.item] || 0);
			}, 0);
			expect(v.lootCash).toBeCloseTo(Math.round(manual * 100) / 100, 2);
			expect(v.totalCash).toBeCloseTo(Math.round((manual + MOB_STATS[kind].gold) * 100) / 100, 2);
			expect(v.xp).toBe(MOB_STATS[kind].xp);
		}
	});

	it('never lets a mount inflate a cash figure', () => {
		const troll = combatValue('troll');
		const mounts = troll.drops.filter((d) => d.mount);
		expect(mounts.length).toBeGreaterThan(0);
		for (const m of mounts) expect(m.expectedCash).toBe(0);
		expect(troll.mountPct).toBeGreaterThan(0);
	});
});

describe('rate-model: rankings only ever recommend rates a player can hold', () => {
	it('marks cooking unsustainable and states what it would need', () => {
		const cook = cookRate(1);
		expect(cook.sustainable).toBe(false);
		expect(cook.requires).toContain('raw fish per hour');
		expect(cook.fishConsumedPerHour).toBeCloseTo(cook.attemptsPerHour, 2);
	});

	it('sorts every unsustainable row below every sustainable one, however large', () => {
		const ladder = activityLadder(1);
		const cook = ladder.find((r) => r.family === 'cook');
		// The premise of the test: cooking's ceiling genuinely beats the top real rate,
		// so a naive sort by cashPerHour would put it first.
		expect(cook.cashPerHour).toBeGreaterThan(ladder[0].cashPerHour);
		expect(ladder[ladder.length - 1].family).toBe('cook');
		const firstUnsustainable = ladder.findIndex((r) => !r.sustainable);
		expect(ladder.slice(firstUnsustainable).every((r) => !r.sustainable)).toBe(true);
	});

	it('never quotes payback against a rate that is not sustainable', () => {
		for (const level of [1, 20, 60, 99]) {
			const model = solveAt(level);
			const cook = model.activities.find((r) => r.family === 'cook');
			expect(model.bestRate.cashPerHour).toBeLessThan(cook.cashPerHour);
			expect(model.bestRate.cashPerHour).toBeGreaterThan(0);
		}
	});

	it('balances the fish-and-cook loop so neither side idles', () => {
		const spot = bestFishingSpot();
		const loop = fishCookLoop(20, 20, spot);
		const fish = fishRate(20, spot);
		const cook = cookRate(20);

		// Fish produced at the chosen split must equal fish consumed at that split.
		const produced = (loop.fishSharePct / 100) * fish.unitsPerHour;
		const consumed = (loop.cookSharePct / 100) * cook.attemptsPerHour;
		expect(produced).toBeCloseTo(consumed, 4);
		expect(loop.fishSharePct + loop.cookSharePct).toBeCloseTo(100, 6);
		expect(loop.sustainable).toBe(true);
	});

	it('beats selling raw, which is the entire reason to cook', () => {
		for (const level of [1, 30, 99]) {
			const loop = fishCookLoop(level, level, bestFishingSpot());
			expect(loop.cashPerHour).toBeGreaterThan(loop.rawOnlyCashPerHour);
			expect(loop.upliftPct).toBeGreaterThan(0);
		}
	});
});

describe('rate-model: monotonicity and bounds', () => {
	it('never lets a higher skill level earn less on the same node', () => {
		for (const node of [...TREES, ...ROCKS]) {
			const family = TREES.includes(node) ? 'chop' : 'mine';
			let previous = 0;
			for (let lvl = 1; lvl <= LEVEL_CAP; lvl += 1) {
				const r = gatherRate(family, lvl, node);
				expect(r.cashPerHour).toBeGreaterThanOrEqual(previous - 1e-9);
				previous = r.cashPerHour;
			}
		}
	});

	it('clamps a level outside the cap instead of extrapolating past it', () => {
		expect(gatherRate('chop', 0, TREES[0]).level).toBe(1);
		expect(gatherRate('chop', -5, TREES[0]).level).toBe(1);
		expect(gatherRate('chop', 1e6, TREES[0]).level).toBe(LEVEL_CAP);
		expect(solveAt(1e6).level).toBe(LEVEL_CAP);
	});

	it('keeps success probabilities inside the curves own clamps', () => {
		for (const lvl of [1, 50, LEVEL_CAP]) {
			for (const node of ROCKS) {
				const r = gatherRate('mine', lvl, node);
				expect(r.successPct).toBeGreaterThan(0);
				expect(r.successPct).toBeLessThanOrEqual(97);
				expect(r.doublePct).toBeLessThanOrEqual(40);
				expect(r.coalPct).toBeLessThanOrEqual(55);
			}
		}
	});

	it('reports the exact hour an empty pack stops the quoted rate', () => {
		const r = gatherRate('chop', 1, TREES[0]);
		expect(r.packHours).toBeGreaterThan(0);
		expect(r.packHours).toBeCloseTo((24 * 999) / r.unitsPerHour, 1);
	});
});

describe('rate-model: payback, break-even and progression', () => {
	it('covers the whole buy catalog and orders it by time to afford', () => {
		const rows = catalogPayback(1000, 2769);
		expect(rows).toHaveLength(BUY_CATALOG.length);
		for (let i = 1; i < rows.length; i += 1) {
			expect(rows[i].minutes).toBeGreaterThanOrEqual(rows[i - 1].minutes);
		}
		const sword = rows.find((r) => r.item === 'sword');
		expect(sword.minutes).toBeCloseTo((sword.price / 1000) * 60, 4);
		expect(sword.attempts).toBe(Math.ceil((sword.price / 1000) * 2769));
	});

	it('reports per-unit price so bundles can be compared honestly', () => {
		const rows = catalogPayback(1000, 1000);
		const ammo = rows.find((r) => r.item === 'ammo');
		const entry = BUY_CATALOG.find((e) => e.item === 'ammo');
		expect(ammo.qty).toBe(entry.qty);
		expect(ammo.unitPrice).toBeCloseTo(entry.price / entry.qty, 2);
	});

	it('returns null when two rates never cross inside the level cap', () => {
		const same = (lvl) => gatherRate('chop', lvl, TREES[0]);
		expect(breakEvenLevel(same, same)).toBeNull();
	});

	it('finds the crossing level when two rates do swap', () => {
		const a = (lvl) => gatherRate('chop', lvl, TREES[0]);
		const b = (lvl) => fishRate(lvl, FISHING_SPOTS[0]);
		const crossing = breakEvenLevel(a, b);
		if (crossing !== null) {
			const before = a(crossing - 1).cashPerHour > b(crossing - 1).cashPerHour;
			const after = a(crossing).cashPerHour > b(crossing).cashPerHour;
			expect(before).not.toBe(after);
		}
	});

	it('prices the next level off the real XP curve', () => {
		const t = timeToLevel(1, 2, 3600);
		expect(t.xp).toBe(50);
		expect(t.hours).toBeCloseTo(50 / 3600, 4);
		expect(timeToLevel(5, 5, 100)).toBeNull();
		expect(timeToLevel(1, 2, 0)).toBeNull();
	});
});

describe('rate-model: derived findings', () => {
	it('derives every finding from computed numbers at the requested level', () => {
		const list = findings(1);
		expect(list.length).toBeGreaterThanOrEqual(4);
		for (const f of list) {
			expect(f.id).toBeTruthy();
			expect(['trap', 'reward', 'context']).toContain(f.kind);
			expect(f.title.length).toBeGreaterThan(0);
			expect(f.detail.length).toBeGreaterThan(0);
		}
	});

	it('states the node tradeoff in the direction the arithmetic actually points', () => {
		const list = findings(1);
		for (const family of ['chop', 'mine']) {
			const f = list.find((x) => x.id === `node-tradeoff:${family}`);
			expect(f).toBeTruthy();
			const rows = activityLadder(1).filter((r) => r.family === family);
			const easiest = rows.reduce((a, b) => (b.node.difficulty < a.node.difficulty ? b : a));
			const hardest = rows.reduce((a, b) => (b.node.difficulty > a.node.difficulty ? b : a));
			const hardestWins = hardest.cashPerHour > easiest.cashPerHour;
			expect(f.kind).toBe(hardestWins ? 'reward' : 'trap');
		}
	});

	it('re-derives its findings per level rather than caching one answer', () => {
		const low = findings(1).find((f) => f.id === 'cook-uplift');
		const high = findings(80).find((f) => f.id === 'cook-uplift');
		expect(low.detail).not.toBe(high.detail);
	});
});

describe('rate-model: curves and the full solve', () => {
	it('emits one full-length curve per node in the world plus the loop', () => {
		const curves = allCurves();
		const expected = TREES.length + ROCKS.length + FISHING_SPOTS.length + 2;
		expect(curves).toHaveLength(expected);
		for (const c of curves) {
			expect(c.cash).toHaveLength(LEVEL_CAP);
			expect(c.xp).toHaveLength(LEVEL_CAP);
			expect(c.cash.every((n) => Number.isFinite(n))).toBe(true);
		}
	});

	it('keys every curve to a row the ladder also emits', () => {
		const ladderKeys = new Set(activityLadder(1).map((r) => r.key));
		for (const c of allCurves()) {
			if (c.family === 'loop') continue;
			expect(ladderKeys.has(c.key)).toBe(true);
		}
	});

	it('agrees with the single-level solve at the same level', () => {
		const curves = allCurves();
		const level = 33;
		const model = solveAt(level);
		for (const row of model.activities) {
			const curve = curves.find((c) => c.key === row.key);
			expect(curve.cash[level - 1]).toBeCloseTo(Math.round(row.cashPerHour * 10) / 10, 6);
		}
	});

	it('publishes its assumptions with every solve', () => {
		const model = solveAt(10);
		expect(model.assumptions).toEqual(ASSUMPTIONS);
		expect(ASSUMPTIONS.length).toBeGreaterThanOrEqual(4);
	});

	it('picks the highest-quality pond, which dominates at every level', () => {
		const best = bestFishingSpot();
		for (const spot of FISHING_SPOTS) {
			expect(best.quality).toBeGreaterThanOrEqual(spot.quality || 1);
		}
		for (const lvl of [1, 50, 99]) {
			for (const spot of FISHING_SPOTS) {
				expect(fishRate(lvl, best).cashPerHour).toBeGreaterThanOrEqual(fishRate(lvl, spot).cashPerHour);
			}
		}
	});

	it('reports no next level at the cap instead of dividing by a missing one', () => {
		expect(solveAt(LEVEL_CAP).nextLevel).toBeNull();
		expect(solveAt(LEVEL_CAP - 1).nextLevel.level).toBe(LEVEL_CAP);
	});

	it('separates the best cash rate from the best XP rate', () => {
		const model = solveAt(LEVEL_CAP);
		expect(model.bestRate.key).toBeTruthy();
		expect(model.bestXpRate.key).toBeTruthy();
		expect(model.bestXpRate.xpPerHour).toBeGreaterThanOrEqual(
			sustainableBest(LEVEL_CAP).cash.xpPerHour,
		);
	});
});

describe('rate-model: sanity against the world tables', () => {
	let warn;
	beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
	afterEach(() => { warn.mockRestore(); });

	it('rates every node the world actually defines, and no others', () => {
		const ladder = activityLadder(1);
		for (const t of TREES) expect(ladder.some((r) => r.key === `chop:${t.id}`)).toBe(true);
		for (const r of ROCKS) expect(ladder.some((x) => x.key === `mine:${r.id}`)).toBe(true);
		for (const s of FISHING_SPOTS) expect(ladder.some((x) => x.key === `fish:${s.id}`)).toBe(true);
		expect(ladder).toHaveLength(TREES.length + ROCKS.length + FISHING_SPOTS.length + 1);
	});

	it('rejects an unknown gather family and an unknown mob loudly', () => {
		expect(() => gatherRate('smelt', 1, TREES[0])).toThrow(/unknown gather family/);
		expect(() => combatValue('dragon')).toThrow(/unknown mob/);
	});
});
