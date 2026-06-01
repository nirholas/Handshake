// Quest engine — the authoritative definitions and helpers behind the Mainland
// tutorial and the daily-quest rotation. Pure data + pure functions: no Colyseus
// or network concerns live here, so the GameRoom can drive everything from real
// action hooks (gather/combat/movement/banking) and this module stays trivially
// testable and deterministic.
//
// Two systems share this file:
//   • Tutorial  — a fixed, ordered onboarding (TUTORIAL_STEPS). A fresh account
//     walks it once; completion is persisted so it never replays.
//   • Daily quests — three objectives rolled per account per UTC day from
//     DAILY_POOL. The roll is DETERMINISTIC (hash of playerId + date) so the
//     same player always sees the same set for a given day, a reconnect mid-day
//     never reshuffles their quests, and there is no Math.random to make state
//     unreproducible across a restart.
//
// Progress only ever moves from server-validated actions — never from a client
// claim — so a player cannot spoof a turn-in.

// ---------------------------------------------------------------------------
// Badges — cosmetic account achievements granted by quests. Surfaced on the
// player's nameplate and in the quest panel (the in-world "profile").
// ---------------------------------------------------------------------------
export const BADGES = {
	newcomer: { id: 'newcomer', label: 'Newcomer', icon: '🎓', desc: 'Finished the Mainland tutorial.' },
	warrior: { id: 'warrior', label: 'Warrior', icon: '⚔️', desc: 'Cleared a combat daily quest.' },
	forager: { id: 'forager', label: 'Forager', icon: '🧺', desc: 'Cleared a gathering daily quest.' },
	fisher: { id: 'fisher', label: 'Fisher', icon: '🎣', desc: 'Cleared a fishing daily quest.' },
	pitcook: { id: 'pitcook', label: 'Pit Cook', icon: '🔥', desc: 'Cleared a cooking daily quest.' },
	builder: { id: 'builder', label: 'Builder', icon: '🔨', desc: 'Placed a firepit in the wild.' },
	devoted: { id: 'devoted', label: 'Devoted', icon: '🌟', desc: 'Cleared every daily quest in one day.' },
};

// ---------------------------------------------------------------------------
// Tutorial — ordered steps. Each step advances only when the player performs
// the real action `kind` `count` times (validated server-side):
//   move    → successful tile steps
//   talk    → talking to the guide NPC
//   gather  → gathering a specific resource item
//   combat  → defeating a mob
//   bank    → depositing an item at the bank counter
// `slot` (when present) is the hotbar index the step is teaching the player to
// equip — the client highlights it.
// ---------------------------------------------------------------------------
export const TUTORIAL_STEPS = [
	{
		id: 'move', kind: 'move', count: 8,
		title: 'Find your footing',
		desc: 'Use WASD (or the joystick on touch) to walk. Take a few steps to get your bearings.',
		guide: "Welcome to the Mainland, traveler. First — get a feel for your feet. Walk around a little.",
	},
	{
		id: 'meet', kind: 'talk', count: 1,
		title: 'Meet Aldric',
		desc: 'Walk up to Aldric the Guide by the fountain and talk to him.',
		guide: "Good. I'm Aldric — I keep new arrivals from wandering into an ogre on day one. Let me show you the ropes.",
	},
	{
		id: 'chop', kind: 'gather', item: 'wood', count: 1, slot: 0,
		title: 'Chop a tree',
		desc: 'Equip your axe (hotbar slot 1), then click a tree to walk over and chop it for wood.',
		guide: 'See those trees to the west? Equip your axe — slot 1 — and click one. Bring back some wood.',
	},
	{
		id: 'mine', kind: 'gather', item: 'stone', count: 1, slot: 1,
		title: 'Mine some stone',
		desc: 'Switch to your pickaxe (hotbar slot 2) and click a rock to mine stone.',
		guide: 'Different tools for different jobs. Switch to your pickaxe — slot 2 — and chip at the rocks to the northeast.',
	},
	{
		id: 'fish', kind: 'fish', item: 'fish', count: 1, slot: 2,
		title: 'Cast a line',
		desc: 'Equip your fishing rod (hotbar slot 3) and stand beside the millpond to cast.',
		guide: "Next skill: fishing. Your rod's in slot 3. Walk to the millpond in the southeast and cast — click the water.",
	},
	{
		id: 'fight', kind: 'combat', count: 1, slot: 3,
		title: 'Train your blade',
		desc: 'Equip your sword (hotbar slot 4) and click a training dummy to defeat it.',
		guide: 'Steel next. Equip your sword — slot 4 — and put a training dummy out of its misery. Mind, real beasts hit back.',
	},
	{
		id: 'bank', kind: 'bank', count: 1,
		title: 'Stash your loot',
		desc: 'Stand on the glowing bank counter, open the bank, and deposit an item to keep it safe.',
		guide: 'Carry too much and a death will scatter it. Step onto the bank counter — the gold tiles — and stash something.',
	},
	{
		id: 'report', kind: 'talk', count: 1,
		title: 'Report back',
		desc: 'Return to Aldric to complete your training and claim your reward.',
		guide: "You've got the loop: gather, fight, bank. Come see me to wrap up — there's a reward in it for you.",
	},
];

// The line Aldric speaks once the tutorial is finished (replay-safe; he keeps
// pointing the player at the daily board afterward).
export const GUIDE_DONE = "Training complete. Check the daily board — fresh bounties every day, and they pay. Safe travels.";

export const TUTORIAL_REWARD = { gold: 150, xp: { combat: 60, woodcutting: 60, mining: 60, fishing: 60 }, badge: 'newcomer' };

// ---------------------------------------------------------------------------
// Daily quests — the pool three are drawn from each day. Every entry is
// completable on the Mainland realm alone (wood/stone/coal nodes + training
// dummies), so a rolled set is never impossible to clear here.
// ---------------------------------------------------------------------------
export const DAILY_POOL = [
	{ id: 'd_wood', type: 'gather', item: 'wood', count: 15, title: 'Lumberjack', desc: 'Chop 15 wood.', reward: { gold: 120, xp: { woodcutting: 160 }, badge: 'forager' } },
	{ id: 'd_haul', type: 'gather', item: 'wood', count: 30, title: 'Big Haul', desc: 'Chop 30 wood.', reward: { gold: 260, xp: { woodcutting: 320 } } },
	{ id: 'd_stone', type: 'gather', item: 'stone', count: 12, title: 'Stonemason', desc: 'Mine 12 stone.', reward: { gold: 140, xp: { mining: 170 }, badge: 'forager' } },
	{ id: 'd_coal', type: 'gather', item: 'coal', count: 6, title: 'Coal Run', desc: 'Mine 6 coal.', reward: { gold: 180, xp: { mining: 200 }, item: { id: 'coal', qty: 3 } } },
	{ id: 'd_combat', type: 'combat', count: 8, title: 'Monster Hunter', desc: 'Defeat 8 foes.', reward: { gold: 200, xp: { combat: 240 }, badge: 'warrior' } },
	{ id: 'd_train', type: 'combat', count: 3, title: 'Sparring', desc: 'Defeat 3 training dummies.', reward: { gold: 80, xp: { combat: 90 } } },
	{ id: 'd_fish', type: 'fish', item: 'fish', count: 5, title: 'Catch of the Day', desc: 'Catch 5 fish at the Pond.', reward: { gold: 130, xp: { fishing: 150 }, badge: 'fisher' } },
	{ id: 'd_haul_fish', type: 'fish', item: 'fish', count: 10, title: 'Haul It In', desc: 'Catch 10 fish.', reward: { gold: 220, xp: { fishing: 260 } } },
	{ id: 'd_cook', type: 'cook', item: 'cookedFish', count: 5, title: 'Camp Cook', desc: 'Cook 5 fish at the Roast Pit.', reward: { gold: 140, xp: { cooking: 180 }, badge: 'pitcook' } },
	{ id: 'd_build', type: 'build', count: 1, title: 'Light a Fire', desc: 'Build a firepit anywhere it is allowed.', reward: { gold: 160, xp: { woodcutting: 80, mining: 80 }, badge: 'builder' } },
];

export const DAILY_COUNT = 3;

// A stable 32-bit hash of a string (FNV-1a). Deterministic across processes.
function hashString(s) {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

// 'YYYY-MM-DD' in UTC for `now` (epoch ms). The daily boundary is UTC midnight.
export function dailyKey(now) {
	return new Date(now).toISOString().slice(0, 10);
}

// Epoch ms of the next UTC midnight after `now` — the moment the current
// dailies expire and a fresh set rolls. The client renders a live countdown to
// this and re-requests its quests when it passes.
export function nextResetAt(now) {
	const d = new Date(now);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

// Deterministically pick DAILY_COUNT distinct quests for (playerId, dateKey).
// Seeded Fisher–Yates over the pool indices using a hash of playerId+date, so a
// player's set is fixed for the day and identical on every reconnect/restart.
export function rollDailies(playerId, dateKey) {
	const seed = hashString(`${playerId}|${dateKey}`);
	const idx = DAILY_POOL.map((_, i) => i);
	// xorshift32 PRNG seeded from the hash — pure, no global RNG.
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
	return idx.slice(0, DAILY_COUNT).map((i) => ({ id: DAILY_POOL[i].id, progress: 0, claimed: false }));
}

export function dailyDef(id) {
	return DAILY_POOL.find((q) => q.id === id) || null;
}

// Fresh, never-started quest state for a brand-new account.
export function freshQuestState(playerId, now) {
	const date = dailyKey(now);
	return {
		tutorial: { step: 0, progress: 0, done: false },
		daily: { date, quests: rollDailies(playerId, date) },
		badges: [],
	};
}

// Bring a (possibly persisted) quest-state blob up to date: re-roll the dailies
// if the UTC day has turned over since it was saved, and backfill any missing
// shape so older/partial saves load cleanly. Mutates and returns `qs`.
export function normalizeQuestState(qs, playerId, now) {
	if (!qs || typeof qs !== 'object') return freshQuestState(playerId, now);
	if (!qs.tutorial || typeof qs.tutorial !== 'object') qs.tutorial = { step: 0, progress: 0, done: false };
	if (!Array.isArray(qs.badges)) qs.badges = [];
	const date = dailyKey(now);
	if (!qs.daily || qs.daily.date !== date || !Array.isArray(qs.daily.quests)) {
		qs.daily = { date, quests: rollDailies(playerId, date) };
	} else {
		// Drop any quest whose definition no longer exists (pool changed between
		// deploys) so the client never renders an orphan.
		qs.daily.quests = qs.daily.quests.filter((q) => dailyDef(q.id));
		if (!qs.daily.quests.length) qs.daily.quests = rollDailies(playerId, date);
	}
	return qs;
}

export function currentStep(qs) {
	if (qs.tutorial.done) return null;
	return TUTORIAL_STEPS[qs.tutorial.step] || null;
}
