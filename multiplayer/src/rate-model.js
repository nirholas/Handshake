// Rate model for the /play coin worlds: the exact expected value of every action
// the world offers, in closed form.
//
// WHY THIS EXISTS
// Every yield rule in this game is already a pure function of skill level and node
// tuning (`gatherChance`, `gatherDoubleChance`, `coalBonusChance`, `cookBurnChance`,
// `fishCatchChance`, `fishDoubleChance` in items.js), and every cadence is a
// constant (`ACTIVITY_COOLDOWN_MS` in activities.js). That combination means the
// expected units, cash and XP per hour for any activity at any level are not a
// thing you have to measure by grinding. They are computable exactly, in one pass,
// with no simulation and no sampling error.
//
// This module does that computation. It imports the same tables the authoritative
// server rolls against and never restates a number, so the model cannot drift away
// from the game: change a price in shop.js or a curve in items.js and every rate
// below moves with it on the next request.
//
// EXACTNESS
// Where the game's XP award wraps a uniform integer roll in Math.round, the naive
// expectation (substituting the mean of the roll) is wrong, because rounding is not
// linear. Every expectation here sums over the roll's actual support instead, so the
// XP numbers are exact rather than approximately right. `tests/rate-model.test.js`
// pins that claim by replaying the real handler arithmetic under a seeded RNG and
// checking the closed form falls inside the sampling interval.
//
// SCOPE
// Pure functions over static tables. No room, no profile, no network, no clock. The
// only modelling assumptions are stated in ASSUMPTIONS below and surfaced verbatim
// through /api/play/solver, because a rate quoted without its assumptions is a lie.

import { ACTIVITY_COOLDOWN_MS } from './activities.js';
import {
	gatherChance, gatherDoubleChance, coalBonusChance, cookBurnChance,
	fishCatchChance, fishDoubleChance, itemLabel,
	MOB_STATS, LOOT_TABLES, ITEMS,
} from './items.js';
import { SELL_PRICES, BUY_CATALOG, sellPrice } from './shop.js';
import { TREES, ROCKS, FISHING_SPOTS } from './world-features.js';
import { WHEEL_SEGMENTS, FREE_SPIN_COOLDOWN_MS } from './spin-wheel.js';
import { LEVEL_CAP, xpForLevel, INV_SIZE, MAX_STACK } from './economy.js';

const MS_PER_HOUR = 3_600_000;

// The modelling assumptions, in the order they bite. Published with every result so
// a reader can see exactly where the numbers stop being a guarantee.
export const ASSUMPTIONS = [
	'Uninterrupted action: the model prices a full hour of swings at the cadence the server enforces, with no walking, no travel between nodes and no downtime.',
	'Pack space is available. The real handlers refuse a gather into a full inventory, so a run that never banks or sells will fall short of these rates.',
	'Items are valued at the general store sell price. Nothing here is priced against a player market, because the world has no player market.',
	'Skill level is held fixed for the hour. In practice XP earned during the hour raises the rate, so a sustained session slightly beats the number shown for its starting level.',
	'Mount drops are reported as odds only. They have no sell price, so they never inflate a cash figure.',
];

// --- exact expectations over the game's own integer rolls ---------------------

// The gather handler awards `Math.round((base + Math.floor(rng() * span) + lvl * 0.3) * mult)`.
// Math.round is not linear, so E[round(X)] is not round(E[X]): the expectation has
// to sum over the roll's real support. `span` values are small (5 and 6), so the
// exact sum is as cheap as the wrong shortcut would have been.
function expectedRoundedXp(base, span, level, mult) {
	let total = 0;
	for (let k = 0; k < span; k += 1) total += Math.round((base + k + level * 0.3) * mult);
	return total / span;
}

function round2(n) {
	return Math.round(n * 100) / 100;
}

function clampLevel(level) {
	const lvl = Math.max(1, Math.min(LEVEL_CAP, Math.floor(Number(level) || 1)));
	return lvl;
}

// How long an empty pack lasts at a given production rate. The "uninterrupted hour"
// assumption is the weakest one in the model, so rather than hand-wave it, every row
// carries the exact hour at which it stops being true. `distinctItems` matters
// because each item type needs its own stack of slots (mining fills two, wood one).
function packHours(unitsPerHour, distinctItems) {
	if (unitsPerHour <= 0) return null;
	const capacity = (INV_SIZE * MAX_STACK) / Math.max(1, distinctItems);
	return Math.round((capacity / unitsPerHour) * 100) / 100;
}

// --- gathering: chop and mine -------------------------------------------------

// Static description of the two gather families, mirroring activities.js's GATHER
// table. Kept as a lookup rather than duplicated per function so adding a third
// gather activity upstream is a one-line change here.
const GATHER_FAMILIES = {
	chop: {
		skill: 'woodcutting', tool: 'axe', item: 'wood', nodes: TREES,
		xpBase: 9, xpSpan: 5, coal: false, verb: 'Chop',
	},
	mine: {
		skill: 'mining', tool: 'pickaxe', item: 'stone', nodes: ROCKS,
		xpBase: 9, xpSpan: 5, coal: true, verb: 'Mine',
	},
};

export function gatherFamilies() {
	return Object.keys(GATHER_FAMILIES);
}

// Expected per-hour yield of chopping one tree or mining one rock at `level`.
//
// Per attempt the server rolls: a success check at `gatherChance`, then a double
// check at `gatherDoubleChance`, then (mining only) an independent coal check at
// `coalBonusChance`. A failed swing still pays 2 XP, which is why the XP rate is
// never zero even on a brutally difficult node.
export function gatherRate(family, level, node) {
	const cfg = GATHER_FAMILIES[family];
	if (!cfg) throw new Error(`unknown gather family: ${family}`);
	const lvl = clampLevel(level);
	const difficulty = node.difficulty || 1;
	const cooldownMs = ACTIVITY_COOLDOWN_MS[family];
	const attemptsPerHour = MS_PER_HOUR / cooldownMs;

	const success = gatherChance(lvl, difficulty);
	const double = gatherDoubleChance(lvl, difficulty);
	const unitsPerSuccess = 1 + double;
	const unitsPerHour = attemptsPerHour * success * unitsPerSuccess;

	// Coal rides on a successful strike only, so its rate carries the success factor.
	const coalChance = cfg.coal ? coalBonusChance(lvl, node.coal || 1) : 0;
	const coalPerHour = attemptsPerHour * success * coalChance;

	// XP: 2 on a miss, the rounded roll times the units on a hit, plus a flat 6 for
	// a coal bonus that actually landed.
	const xpPerSuccessUnit = expectedRoundedXp(cfg.xpBase, cfg.xpSpan, lvl, difficulty);
	const xpPerHour = attemptsPerHour * (
		(1 - success) * 2
		+ success * (xpPerSuccessUnit * unitsPerSuccess + coalChance * 6)
	);

	const cashPerHour = unitsPerHour * sellPrice(cfg.item) + coalPerHour * sellPrice('coal');

	return {
		key: `${family}:${node.id}`,
		family,
		skill: cfg.skill,
		tool: cfg.tool,
		item: cfg.item,
		label: `${cfg.verb} ${node.id}`,
		node: { id: node.id, difficulty, coalWeight: cfg.coal ? (node.coal || 1) : null },
		level: lvl,
		cadenceMs: cooldownMs,
		attemptsPerHour: round2(attemptsPerHour),
		successPct: round2(success * 100),
		doublePct: round2(double * 100),
		coalPct: cfg.coal ? round2(coalChance * 100) : null,
		unitsPerHour: round2(unitsPerHour),
		coalPerHour: cfg.coal ? round2(coalPerHour) : null,
		cashPerHour: round2(cashPerHour),
		xpPerHour: round2(xpPerHour),
		// A gather node produces from the world, so its rate stands on its own.
		sustainable: true,
		requires: null,
		packHours: packHours(unitsPerHour + coalPerHour, cfg.coal ? 2 : 1),
	};
}

// --- fishing ------------------------------------------------------------------

// Expected per-hour yield of casting at one pond. Same shape as gatherRate, but the
// catch curve is scaled by the spot's `quality` multiplier rather than divided by a
// difficulty, so richer water is strictly better on both axes.
export function fishRate(level, spot) {
	const lvl = clampLevel(level);
	const quality = spot.quality || 1;
	const cooldownMs = ACTIVITY_COOLDOWN_MS.fish;
	const attemptsPerHour = MS_PER_HOUR / cooldownMs;

	const success = fishCatchChance(lvl, quality);
	const double = fishDoubleChance(lvl, quality);
	const perSuccess = 1 + double;
	const unitsPerHour = attemptsPerHour * success * perSuccess;

	const xpPerSuccessUnit = expectedRoundedXp(10, 6, lvl, quality);
	const xpPerHour = attemptsPerHour * ((1 - success) * 2 + success * xpPerSuccessUnit * perSuccess);

	return {
		key: `fish:${spot.id}`,
		family: 'fish',
		skill: 'fishing',
		tool: 'rod',
		item: 'fish',
		label: `Fish ${spot.id}`,
		node: { id: spot.id, quality },
		level: lvl,
		cadenceMs: cooldownMs,
		attemptsPerHour: round2(attemptsPerHour),
		successPct: round2(success * 100),
		doublePct: round2(double * 100),
		coalPct: null,
		unitsPerHour: round2(unitsPerHour),
		coalPerHour: null,
		cashPerHour: round2(unitsPerHour * sellPrice('fish')),
		xpPerHour: round2(xpPerHour),
		sustainable: true,
		requires: null,
		packHours: packHours(unitsPerHour, 1),
	};
}

// --- cooking ------------------------------------------------------------------

// Cooking is a converter, not a producer: every attempt burns one raw fish whether
// or not it succeeds, and pays out a cooked fish on the non-burn branch. So its
// standalone "cash per hour" is a VALUE-ADD rate (what the conversion earns over
// simply selling the raw fish), and it is only reachable if something upstream is
// supplying fish at that pace. `fishCookLoop` below solves for that honestly.
export function cookRate(level) {
	const lvl = clampLevel(level);
	const cooldownMs = ACTIVITY_COOLDOWN_MS.cook;
	const attemptsPerHour = MS_PER_HOUR / cooldownMs;
	const burn = cookBurnChance(lvl);
	const cookedPerHour = attemptsPerHour * (1 - burn);

	// 14 + floor(rng()*5) has an exact mean of 16; the level term is floored once,
	// outside the roll, so it is not part of the expectation.
	const xpPerCook = 16 + Math.floor(lvl * 0.3);
	const xpPerHour = attemptsPerHour * (burn * 3 + (1 - burn) * xpPerCook);

	const valueAddPerAttempt = (1 - burn) * sellPrice('cookedFish') - sellPrice('fish');

	return {
		key: 'cook:firepit',
		family: 'cook',
		skill: 'cooking',
		tool: null,
		item: 'cookedFish',
		label: 'Cook at a roast pit',
		node: { id: 'firepit', difficulty: 1 },
		level: lvl,
		cadenceMs: cooldownMs,
		attemptsPerHour: round2(attemptsPerHour),
		successPct: round2((1 - burn) * 100),
		burnPct: round2(burn * 100),
		doublePct: 0,
		coalPct: null,
		unitsPerHour: round2(cookedPerHour),
		coalPerHour: null,
		fishConsumedPerHour: round2(attemptsPerHour),
		cashPerHour: round2(attemptsPerHour * valueAddPerAttempt),
		xpPerHour: round2(xpPerHour),
		// Cooking consumes a raw fish per attempt, so this rate is a CEILING that
		// assumes a supply nobody can actually deliver while also standing at the
		// fire. It is excluded from every ranking and from payback for exactly that
		// reason; `fishCookLoop` is the honest, self-supplied version of this row.
		sustainable: false,
		requires: `${round2(attemptsPerHour)} raw fish per hour, which no single player can catch and cook at the same time`,
		packHours: packHours(cookedPerHour, 1),
	};
}

// --- the fish-and-cook loop ---------------------------------------------------

// The single most valuable thing this model computes, because it is the one number
// a player cannot eyeball: cooking pays three times what raw fish pays, but you
// cannot cook and fish at the same time, so the real question is how to SPLIT an
// hour between the two.
//
// Let R be fish caught per hour of pure fishing and C attempts per hour of pure
// cooking. Spending fraction t of the hour fishing produces t*R fish and consumes
// (1 - t)*C. Supply meets demand at t = C / (R + C), and at that split nothing
// queues and nothing idles. Everything else follows.
export function fishCookLoop(fishingLevel, cookingLevel, spot) {
	const fish = fishRate(fishingLevel, spot);
	const cook = cookRate(cookingLevel);

	const R = fish.unitsPerHour;
	const C = cook.attemptsPerHour;
	const fishShare = C / (R + C);
	const cookShare = 1 - fishShare;

	const fishPerHour = fishShare * R;
	const cookedPerHour = fishPerHour * (1 - cookBurnChance(clampLevel(cookingLevel)));
	const cashPerHour = cookedPerHour * sellPrice('cookedFish');

	// The honest comparison: the same hour spent fishing only and selling raw.
	const rawOnlyCashPerHour = fish.cashPerHour;
	const xpPerHour = fishShare * fish.xpPerHour + cookShare * cook.xpPerHour;

	return {
		key: 'loop:fish-cook',
		family: 'loop',
		label: `Fish ${spot.id} and cook`,
		spot: { id: spot.id, quality: spot.quality || 1 },
		fishingLevel: clampLevel(fishingLevel),
		cookingLevel: clampLevel(cookingLevel),
		fishSharePct: round2(fishShare * 100),
		cookSharePct: round2(cookShare * 100),
		fishPerHour: round2(fishPerHour),
		cookedPerHour: round2(cookedPerHour),
		cashPerHour: round2(cashPerHour),
		rawOnlyCashPerHour: round2(rawOnlyCashPerHour),
		upliftPct: rawOnlyCashPerHour > 0
			? round2(((cashPerHour - rawOnlyCashPerHour) / rawOnlyCashPerHour) * 100)
			: 0,
		xpPerHour: round2(xpPerHour),
		// Self-supplied by construction: the split is chosen so nothing queues.
		sustainable: true,
		requires: null,
		packHours: packHours(cookedPerHour, 1),
	};
}

// --- combat -------------------------------------------------------------------

// Expected cash from one kill: the mob's flat gold plus every loot line valued at
// its sell price. Each loot entry is an INDEPENDENT roll (see rollLoot), so the
// expectations add without any inclusion-exclusion correction. Quantities are
// uniform over [min, max], so their mean is the midpoint.
export function combatValue(kind) {
	const stats = MOB_STATS[kind];
	const table = LOOT_TABLES[kind];
	if (!stats || !table) throw new Error(`unknown mob: ${kind}`);

	let lootCash = 0;
	const drops = [];
	let mountPct = 0;
	for (const entry of table) {
		const min = entry.min ?? 1;
		const max = entry.max ?? min;
		const meanQty = (min + max) / 2;
		const unit = sellPrice(entry.item);
		const cash = entry.chance * meanQty * unit;
		lootCash += cash;
		if (ITEMS[entry.item]?.mount) mountPct += entry.chance * 100;
		drops.push({
			item: entry.item,
			label: itemLabel(entry.item),
			chancePct: round2(entry.chance * 100),
			meanQty: round2(meanQty),
			unitPrice: unit,
			expectedCash: round2(cash),
			mount: !!ITEMS[entry.item]?.mount,
		});
	}

	const totalCash = stats.gold + lootCash;
	return {
		kind,
		label: kind.charAt(0).toUpperCase() + kind.slice(1),
		hp: stats.hp,
		damage: stats.dmg,
		hostile: stats.hostile !== false,
		xp: stats.xp,
		gold: stats.gold,
		lootCash: round2(lootCash),
		totalCash: round2(totalCash),
		cashPerHp: stats.hp > 0 ? round2(totalCash / stats.hp) : 0,
		xpPerHp: stats.hp > 0 ? round2(stats.xp / stats.hp) : 0,
		mountPct: round2(mountPct),
		drops: drops.sort((a, b) => b.expectedCash - a.expectedCash || b.chancePct - a.chancePct),
	};
}

export function combatLadder() {
	return Object.keys(MOB_STATS).map(combatValue).sort((a, b) => b.totalCash - a.totalCash);
}

// --- the wheel ----------------------------------------------------------------

// Fortune's Folly in store-price terms. The wedges are uniform by design (see the
// header note in spin-wheel.js), but this sums each wedge's own declared oddsPct
// rather than assuming 1/n, so a future re-weighting stays correct here for free.
export function wheelValue() {
	const total = WHEEL_SEGMENTS.reduce((sum, s) => sum + s.oddsPct, 0);
	const valued = WHEEL_SEGMENTS.map((seg) => ({
		seg,
		p: seg.oddsPct / total,
		value: seg.kind === 'gold' ? seg.gold : seg.qty * sellPrice(seg.item),
	}));

	const ev = valued.reduce((sum, v) => sum + v.p * v.value, 0);
	const variance = valued.reduce((sum, v) => sum + v.p * (v.value - ev) ** 2, 0);
	const values = valued.map((v) => v.value);

	// A free spin every 12 hours is 2 per day, so the free lane's daily worth is
	// exact rather than a rule of thumb.
	const freeSpinsPerDay = 24 / (FREE_SPIN_COOLDOWN_MS / MS_PER_HOUR);

	return {
		wedges: WHEEL_SEGMENTS.length,
		evCash: round2(ev),
		stdevCash: round2(Math.sqrt(variance)),
		bestCash: Math.max(...values),
		worstCash: Math.min(...values),
		freeSpinsPerDay: round2(freeSpinsPerDay),
		evPerDayCash: round2(ev * freeSpinsPerDay),
		// Odds of landing at or above the mean, which is what "did I do well" means
		// on a table this skewed by one jackpot wedge.
		aboveEvPct: round2(valued.filter((v) => v.value >= ev).reduce((s, v) => s + v.p, 0) * 100),
	};
}

// --- ladders, payback and break-even -----------------------------------------

// Every gatherable node in the world, priced at one level and ranked by cash. This
// is what answers "which rock should I actually stand at", a question the world
// gives no in-game way to settle: rock-4 is the hardest to crack but has the
// richest coal seam, and only the arithmetic says which effect wins.
export function activityLadder(level) {
	const lvl = clampLevel(level);
	const rows = [
		...TREES.map((t) => gatherRate('chop', lvl, t)),
		...ROCKS.map((r) => gatherRate('mine', lvl, r)),
		...FISHING_SPOTS.map((s) => fishRate(lvl, s)),
		cookRate(lvl),
	];
	// Unsustainable rows (cooking, which needs a fish supply) always sort last, no
	// matter how large their ceiling is. Ranking a rate nobody can hold above one
	// anybody can would make the whole table advice you cannot follow.
	return rows.sort((a, b) => {
		if (a.sustainable !== b.sustainable) return a.sustainable ? -1 : 1;
		return b.cashPerHour - a.cashPerHour;
	});
}

// The best node per family at a level, keyed by family.
export function bestPerFamily(level) {
	const out = {};
	for (const row of activityLadder(level)) {
		if (!out[row.family] || row.cashPerHour > out[row.family].cashPerHour) out[row.family] = row;
	}
	return out;
}

// The highest cash rate a player can actually hold at this level, and the highest XP
// rate, considered separately because they are rarely the same activity.
export function sustainableBest(level) {
	const lvl = clampLevel(level);
	const rows = activityLadder(lvl).filter((r) => r.sustainable);
	rows.push(fishCookLoop(lvl, lvl, bestFishingSpot()));
	const cash = rows.reduce((a, b) => (b.cashPerHour > a.cashPerHour ? b : a));
	const xp = rows.reduce((a, b) => (b.xpPerHour > a.xpPerHour ? b : a));
	return { cash, xp };
}

// How long the store's catalog takes to afford at a given cash rate, in the units a
// player actually thinks in: minutes, and swings.
export function catalogPayback(cashPerHour, attemptsPerHour) {
	return BUY_CATALOG.map((entry) => {
		const hours = cashPerHour > 0 ? entry.price / cashPerHour : Infinity;
		return {
			item: entry.item,
			label: itemLabel(entry.item),
			qty: entry.qty,
			price: entry.price,
			unitPrice: round2(entry.price / entry.qty),
			hours: Number.isFinite(hours) ? Math.round(hours * 1000) / 1000 : null,
			minutes: round2(hours * 60),
			attempts: Number.isFinite(hours) ? Math.ceil(hours * attemptsPerHour) : null,
		};
	}).sort((a, b) => a.minutes - b.minutes);
}

// The level at which one activity's cash rate overtakes another's, or null if it
// never does inside the level cap. Scanning every level is exact and costs nothing,
// so there is no reason to approximate it with a solved inequality that would go
// stale the moment a curve upstream changes shape.
export function breakEvenLevel(rateA, rateB) {
	let previous = null;
	for (let lvl = 1; lvl <= LEVEL_CAP; lvl += 1) {
		const ahead = rateA(lvl).cashPerHour > rateB(lvl).cashPerHour;
		if (previous !== null && ahead !== previous) return lvl;
		previous = ahead;
	}
	return null;
}

// Hours of a given XP rate to climb from one level to the next.
export function timeToLevel(fromLevel, toLevel, xpPerHour) {
	const from = clampLevel(fromLevel);
	const to = clampLevel(toLevel);
	if (to <= from || xpPerHour <= 0) return null;
	const xp = xpForLevel(to) - xpForLevel(from);
	// Early levels take well under a minute at the top rates, so two decimal places on
	// `hours` would round most of the curve to zero. Minutes stay at two, which is the
	// precision a reader can actually use.
	const hours = xp / xpPerHour;
	return { xp, hours: Math.round(hours * 10000) / 10000, minutes: round2(hours * 60) };
}

// A cash-per-hour and xp-per-hour curve across every level, for one activity. Emitted
// as parallel arrays so the whole 99-level sweep for every node in the world stays
// small enough to ship in one response and drive an instant client-side slider.
export function levelCurve(builder) {
	const cash = [];
	const xp = [];
	for (let lvl = 1; lvl <= LEVEL_CAP; lvl += 1) {
		const r = builder(lvl);
		cash.push(Math.round(r.cashPerHour * 10) / 10);
		xp.push(Math.round(r.xpPerHour * 10) / 10);
	}
	return { cash, xp };
}

// Every curve the world has, keyed the same way activityLadder keys its rows, so a
// client can join the two without a lookup table of its own.
export function allCurves() {
	const series = [];
	for (const tree of TREES) {
		series.push({ key: `chop:${tree.id}`, family: 'chop', label: `Chop ${tree.id}`, ...levelCurve((l) => gatherRate('chop', l, tree)) });
	}
	for (const rock of ROCKS) {
		series.push({ key: `mine:${rock.id}`, family: 'mine', label: `Mine ${rock.id}`, ...levelCurve((l) => gatherRate('mine', l, rock)) });
	}
	for (const spot of FISHING_SPOTS) {
		series.push({ key: `fish:${spot.id}`, family: 'fish', label: `Fish ${spot.id}`, ...levelCurve((l) => fishRate(l, spot)) });
	}
	series.push({ key: 'cook:firepit', family: 'cook', label: 'Cook at a roast pit', ...levelCurve(cookRate) });
	series.push({
		key: 'loop:fish-cook',
		family: 'loop',
		label: 'Fish and cook loop',
		...levelCurve((l) => fishCookLoop(l, l, bestFishingSpot())),
	});
	return series;
}

// The pond with the highest quality multiplier. Quality raises both catch rate and
// double-haul odds, so it dominates at every level and there is no crossover to hunt.
export function bestFishingSpot() {
	return FISHING_SPOTS.reduce((best, s) => ((s.quality || 1) > (best.quality || 1) ? s : best), FISHING_SPOTS[0]);
}

// --- derived findings ---------------------------------------------------------

// Conclusions the arithmetic reaches on its own. Every string below is assembled
// from numbers computed above, never asserted: if the tuning upstream changes so a
// finding stops being true, the finding stops being emitted rather than going
// quietly stale. This is the part a wiki cannot keep honest.
export function findings(level) {
	const lvl = clampLevel(level);
	const ladder = activityLadder(lvl);
	const out = [];

	// 1. Within a family, does the tougher node actually pay? Nodes advertise their
	// difficulty through slower yields and (for rock) a richer coal seam, and only
	// the arithmetic settles whether the trade is worth taking.
	for (const family of ['chop', 'mine']) {
		const rows = ladder.filter((r) => r.family === family);
		if (rows.length < 2) continue;
		const easiest = rows.reduce((a, b) => (b.node.difficulty < a.node.difficulty ? b : a));
		const hardest = rows.reduce((a, b) => (b.node.difficulty > a.node.difficulty ? b : a));
		if (hardest.node.difficulty === easiest.node.difficulty) continue;
		const better = hardest.cashPerHour > easiest.cashPerHour;
		const gapPct = round2(Math.abs(hardest.cashPerHour - easiest.cashPerHour) / easiest.cashPerHour * 100);
		out.push({
			id: `node-tradeoff:${family}`,
			kind: better ? 'reward' : 'trap',
			title: better
				? `The hardest ${family === 'chop' ? 'tree' : 'rock'} is worth the extra swings`
				: `The hardest ${family === 'chop' ? 'tree' : 'rock'} is not worth standing at`,
			detail: better
				? `${hardest.node.id} (difficulty ${hardest.node.difficulty}) pays ${hardest.cashPerHour} cash per hour against ${easiest.node.id}'s ${easiest.cashPerHour}, so the tougher node clears its own penalty by ${gapPct}%.`
				: `${hardest.node.id} (difficulty ${hardest.node.difficulty}) pays ${hardest.cashPerHour} cash per hour, ${gapPct}% BELOW ${easiest.node.id} at ${easiest.cashPerHour}. Its richer yield does not cover the slower success rate, so the easy node wins outright.`,
			nodes: [easiest.node.id, hardest.node.id],
		});
	}

	// 2. Cooking's uplift over selling raw, at the split that keeps both sides busy.
	const loop = fishCookLoop(lvl, lvl, bestFishingSpot());
	out.push({
		id: 'cook-uplift',
		kind: loop.upliftPct > 0 ? 'reward' : 'trap',
		title: loop.upliftPct > 0
			? `Cooking beats selling raw by ${loop.upliftPct}%`
			: 'Cooking does not pay at this level',
		detail: `Splitting the hour ${loop.fishSharePct}% fishing and ${loop.cookSharePct}% cooking keeps both sides fed and earns ${loop.cashPerHour} cash per hour, against ${loop.rawOnlyCashPerHour} for an hour of pure fishing sold raw. At cooking level ${lvl} the burn rate is ${round2(cookBurnChance(lvl) * 100)}%, which is already priced into that figure.`,
	});

	// 3. What the store's whole catalog costs in playtime. When this collapses to a
	// couple of minutes it is a balance signal, not a compliment, so say which it is.
	const { cash: bestRow } = sustainableBest(lvl);
	const catalogCost = BUY_CATALOG.reduce((sum, e) => sum + e.price, 0);
	const catalogMinutes = bestRow.cashPerHour > 0 ? round2((catalogCost / bestRow.cashPerHour) * 60) : null;
	if (catalogMinutes !== null) {
		out.push({
			id: 'catalog-cost',
			kind: catalogMinutes < 15 ? 'trap' : 'reward',
			title: catalogMinutes < 15
				? `The entire store is ${catalogMinutes} minutes of play`
				: `Clearing the store takes ${catalogMinutes} minutes`,
			detail: `Every one of the ${BUY_CATALOG.length} catalog entries bought once costs ${catalogCost} cash. At the best sustainable rate for level ${lvl} (${bestRow.label}, ${bestRow.cashPerHour} per hour) that is ${catalogMinutes} minutes.${catalogMinutes < 15 ? ' Cash stops being a constraint almost immediately, so the store is a convenience rather than a goal.' : ''}`,
		});
	}

	// 4. The free spin, priced in the only unit that means anything: playtime.
	const wheel = wheelValue();
	const spinMinutes = bestRow.cashPerHour > 0 ? round2((wheel.evCash / bestRow.cashPerHour) * 60) : null;
	out.push({
		id: 'wheel-worth',
		kind: 'context',
		title: `A free spin is worth ${wheel.evCash} cash on average`,
		detail: `Valuing every wedge at its store price, the wheel returns ${wheel.evCash} cash per spin with a standard deviation of ${wheel.stdevCash}, driven almost entirely by the single ${wheel.bestCash}-cash jackpot wedge. Only ${wheel.aboveEvPct}% of outcomes land at or above the average. Two free spins a day come to ${wheel.evPerDayCash} cash, or about ${spinMinutes} minutes of ${bestRow.label.toLowerCase()}.`,
	});

	// 5. Combat measured against gathering, per hour is impossible to state honestly
	// (kill speed depends on weapon, aim and respawn), so state it per kill and let
	// the reader supply their own kill rate.
	const troll = combatValue('troll');
	const killsPerHourToMatch = troll.totalCash > 0
		? round2(bestRow.cashPerHour / troll.totalCash)
		: null;
	out.push({
		id: 'combat-vs-gathering',
		kind: 'context',
		title: `Combat needs ${killsPerHourToMatch} troll kills an hour to match gathering`,
		detail: `A troll is the richest kill in the world at ${troll.totalCash} expected cash (${troll.gold} flat plus ${troll.lootCash} of loot at store prices) and ${troll.xp} combat XP, with a ${troll.mountPct}% chance of a mount. To earn what ${bestRow.label.toLowerCase()} earns you would need ${killsPerHourToMatch} of them per hour, one every ${round2(3600 / killsPerHourToMatch)} seconds, through ${troll.hp} HP each.`,
	});

	return out;
}

// The full model at one level. This is the shape /api/play/solver serves.
export function solveAt(level) {
	const lvl = clampLevel(level);
	const ladder = activityLadder(lvl);
	const best = bestPerFamily(lvl);
	const spot = bestFishingSpot();
	const loop = fishCookLoop(lvl, lvl, spot);

	// Payback is quoted against the best cash rate a player can actually HOLD, which
	// deliberately excludes cooking's supply-fed ceiling. Quoting payback against a
	// rate nobody can sustain would make every price in the store look free.
	const { cash: topCashRow, xp: topXpRow } = sustainableBest(lvl);
	const topCash = topCashRow.cashPerHour;
	const topAttempts = topCashRow.family === 'loop'
		? best.fish.attemptsPerHour
		: topCashRow.attemptsPerHour;

	const wheel = wheelValue();

	return {
		level: lvl,
		levelCap: LEVEL_CAP,
		assumptions: ASSUMPTIONS,
		cadenceMs: { ...ACTIVITY_COOLDOWN_MS },
		sellPrices: { ...SELL_PRICES },
		activities: ladder,
		best,
		loop,
		bestRate: {
			label: topCashRow.label,
			key: topCashRow.key,
			cashPerHour: round2(topCash),
			attemptsPerHour: topAttempts,
		},
		bestXpRate: { label: topXpRow.label, key: topXpRow.key, xpPerHour: topXpRow.xpPerHour },
		findings: findings(lvl),
		payback: catalogPayback(topCash, topAttempts),
		wheel: {
			...wheel,
			// A free spin's worth expressed in the only currency a player has intuition
			// for: how long they would have had to swing for the same cash.
			minutesOfBestRate: topCash > 0 ? round2((wheel.evCash / topCash) * 60) : null,
		},
		combat: combatLadder(),
		nextLevel: lvl < LEVEL_CAP
			? {
				level: lvl + 1,
				...timeToLevel(lvl, lvl + 1, topXpRow.xpPerHour),
				via: topXpRow.label,
			}
			: null,
	};
}
