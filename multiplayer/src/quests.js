// Quest engine — jobs, missions & heists for the /play coin worlds (W05).
//
// A mission is DATA, not code: a spec of ordered objectives + a reward. The same
// engine drives one-tap daily jobs, repeatable courier runs, and multi-stage
// co-op heists — authoring new content is adding an entry to MISSIONS, never
// writing a new handler. This mirrors how items.js is the one source of truth for
// items and economy.js for the pack/purse: rooms read THIS instead of branching on
// mission ids inline.
//
// Authority is server-side. The WalkRoom owns a player's quest state OFF the synced
// WalkState schema (it's private, like the pack/purse), feeds real gameplay events
// (a fish caught, a zone entered, a terminal activated) into applyEvent(), and grants
// rewards only when the engine — not the client — says an objective is done. A client
// claiming "I finished" advances nothing; only the event it actually produced does.
//
// Objective vocabulary (every mission is expressible in these, all backed by a REAL
// server handler that emits the matching event — no objective is un-completable):
//   collect      — gather N of an item        (emitted by the fishing handler)
//   goto         — enter a named world zone    (emitted by movement zone-entry)
//   interact     — act at a quest object/zone  (emitted by the questInteract handler)
// Heists compose these as a SHARED instance (see WalkRoom): the same objective shape,
// advanced by any crew member, finishing only when the party is assembled at the finale.

import { SKILLS } from './economy.js';

// ---------------------------------------------------------------------------
// Mission registry — the single source of truth for what missions exist.
// ---------------------------------------------------------------------------
//
// Fields:
//   id        stable key (persisted; never reuse for a different mission).
//   title     human name shown on the board + tracker.
//   giver     in-world quest-giver label (W08 NPCs hook this; today it's flavour).
//   summary   one-line pitch on the jobs board.
//   kind      'job' (solo) | 'heist' (co-op, server-managed shared instance).
//   repeat    'daily' (once per UTC day, rotated) | 'repeatable' (any time) |
//             'once' (a one-shot the account completes a single time, ever).
//   party     minimum crew size to FINISH (1 for solo; ≥2 for a heist finale).
//   objectives ordered list — complete one to advance to the next.
//   reward    { gold, xp?: { skill, amount } } granted server-side on completion.
//             Heist gold is the TOTAL pot, split evenly among the crew at payout.
//   prereq    mission ids that must be completed before this one is offered.
//
// In-world spendable currency is "gold" (a game resource, per the program rules) —
// never an on-chain token. The only coin that ever exists is $THREE, and missions
// never mint or reference it.
export const MISSIONS = {
	// — Daily collect job (the Kintara retention mechanic): cheap, once/day, fishing. —
	'daily-anglers-haul': {
		id: 'daily-anglers-haul',
		title: "Angler's Daily Haul",
		giver: 'Dockmaster Reyes',
		summary: 'Land 5 fish from the community ponds before the day is out.',
		kind: 'job',
		repeat: 'daily',
		party: 1,
		objectives: [
			{ type: 'collect', item: 'fish', count: 5, label: 'Catch 5 fish at the ponds' },
		],
		reward: { gold: 140, xp: { skill: 'fishing', amount: 120 } },
	},

	// — Daily survey job: a movement loop that teaches the map. One tap to accept,
	//   finished by simply touring the landmarks. —
	'daily-grounds-survey': {
		id: 'daily-grounds-survey',
		title: 'Grounds Survey',
		giver: 'Warden Okoro',
		summary: 'Patrol the three lookouts and report the grounds secure.',
		kind: 'job',
		repeat: 'daily',
		party: 1,
		objectives: [
			{ type: 'goto', zone: 'pond-east', label: 'Reach the East Pond' },
			{ type: 'goto', zone: 'lookout-north', label: 'Reach the North Lookout' },
			{ type: 'goto', zone: 'pond-west', label: 'Reach the West Pond' },
		],
		reward: { gold: 90 },
	},

	// — Repeatable collect: a bigger fishing contract for grinders. —
	'stock-the-kitchen': {
		id: 'stock-the-kitchen',
		title: 'Stock the Kitchen',
		giver: 'Cook Mara',
		summary: 'The roast pit is running low — bring in 12 fresh fish.',
		kind: 'job',
		repeat: 'repeatable',
		party: 1,
		objectives: [
			{ type: 'collect', item: 'fish', count: 12, label: 'Catch 12 fish' },
		],
		reward: { gold: 260, xp: { skill: 'fishing', amount: 220 } },
	},

	// — Repeatable courier run: pick up at the dock, deliver to the market. A
	//   two-stage go-there / act, then go-there / act loop — the spine of every
	//   GTA-style delivery mission. (Vehicles, W02, will make the legs faster; on
	//   foot it already plays.) —
	'harbor-courier': {
		id: 'harbor-courier',
		title: 'Harbor Courier',
		giver: 'Foreman Dell',
		summary: 'Grab the sealed crate at the East Dock and run it to the Market.',
		kind: 'job',
		repeat: 'repeatable',
		party: 1,
		objectives: [
			{ type: 'interact', zone: 'dock-east', action: 'pickup', label: 'Collect the crate at the East Dock' },
			{ type: 'interact', zone: 'market-stall', action: 'dropoff', label: 'Deliver the crate to the Market' },
		],
		reward: { gold: 180 },
	},

	// — One-shot intro mission: first taste of the loop, unlocks nothing but pays a
	//   welcome purse and points the player at the board. —
	'welcome-to-work': {
		id: 'welcome-to-work',
		title: 'First Day on the Job',
		giver: 'Foreman Dell',
		summary: 'Catch your first fish and find your footing in the world.',
		kind: 'job',
		repeat: 'once',
		party: 1,
		objectives: [
			{ type: 'collect', item: 'fish', count: 1, label: 'Catch your first fish' },
		],
		reward: { gold: 60, xp: { skill: 'fishing', amount: 40 } },
	},

	// — Vehicle deliveries: the actual "drive around, go on missions" loop. Both
	//   legs are `goto` objectives flagged `vehicle: true`, so entering the depot
	//   zone on foot doesn't count — you have to actually be behind the wheel
	//   (validated server-side off the authoritative vehicle-driver map, never the
	//   client). Depots sit at the four avenue vehicle spawns (vehicles.js
	//   VEHICLE_SPAWNS), so a real car is always parked right where the job starts. —
	'cross-town-delivery': {
		id: 'cross-town-delivery',
		title: 'Cross-Town Delivery',
		giver: 'Dispatcher Vance',
		summary: 'Take a car from the North Depot and run the rush order down to the South Depot.',
		kind: 'job',
		repeat: 'repeatable',
		party: 1,
		objectives: [
			{ type: 'goto', zone: 'depot-north', vehicle: true, label: '🚗 Load the order — drive to the North Depot' },
			{ type: 'goto', zone: 'depot-south', vehicle: true, label: '🚗 Drop it off — drive to the South Depot' },
		],
		reward: { gold: 220 },
	},
	'east-west-express': {
		id: 'east-west-express',
		title: 'East-West Express',
		giver: 'Dispatcher Vance',
		summary: 'Same job, other axis: East Depot to West Depot, full speed.',
		kind: 'job',
		repeat: 'repeatable',
		party: 1,
		objectives: [
			{ type: 'goto', zone: 'depot-east', vehicle: true, label: '🚗 Load the order — drive to the East Depot' },
			{ type: 'goto', zone: 'depot-west', vehicle: true, label: '🚗 Drop it off — drive to the West Depot' },
		],
		reward: { gold: 220 },
	},

	// — Co-op heist: the flagship multi-stage crew job. Stage 1 disables both alarm
	//   terminals (either crew member can tap either terminal — SHARED progress);
	//   the finale cracks the vault and only completes with the full crew assembled
	//   at the door. The pot is split evenly at payout. Repeatable so a crew can run
	//   it again. —
	'vault-job': {
		id: 'vault-job',
		title: 'The Vault Job',
		giver: 'The Fixer',
		summary: 'Two-crew heist: kill the alarms, then crack the vault together for a big split.',
		kind: 'heist',
		repeat: 'repeatable',
		party: 2,
		objectives: [
			{
				type: 'interact', action: 'terminal', count: 2, shared: true,
				zones: ['vault-terminal-a', 'vault-terminal-b'],
				label: 'Disable both alarm terminals',
			},
			{
				type: 'interact', action: 'crack', zone: 'vault-door', shared: true, finale: true,
				label: 'Crack the vault — full crew at the door',
			},
		],
		// 900 gold total, split among the crew (e.g. 450 each for a duo).
		reward: { gold: 900, xp: { skill: 'combat', amount: 200 } },
	},
};

// The pool of mission ids eligible for the rotating daily board. A deterministic
// subset is offered each UTC day so the board feels fresh without authoring a
// calendar. Only 'daily' missions belong here.
export const DAILY_POOL = Object.values(MISSIONS)
	.filter((m) => m.repeat === 'daily')
	.map((m) => m.id);

// How many daily jobs to surface per day. Capped to the pool size.
export const DAILY_COUNT = 2;

export function missionDef(id) {
	return MISSIONS[id] || null;
}

export function isHeist(id) {
	return MISSIONS[id]?.kind === 'heist';
}

// The default count for an objective (most are a single action).
function objCount(obj) {
	return Math.max(1, obj?.count | 0 || 1);
}

// ---------------------------------------------------------------------------
// Daily rotation — deterministic per UTC day, so every player and every room
// instance offers the same daily set, and it changes exactly at the UTC midnight
// boundary with no scheduler.
// ---------------------------------------------------------------------------

export function utcDayKey(ts = Date.now()) {
	const d = new Date(ts);
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

function hashStr(s) {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

// The daily job ids for a given UTC day — a stable shuffle of DAILY_POOL seeded by
// the day, then the first DAILY_COUNT. Pure: same day in → same ids out, anywhere.
export function dailyJobIds(dayKey, count = DAILY_COUNT) {
	const pool = [...DAILY_POOL];
	if (pool.length <= count) return pool;
	let seed = hashStr(String(dayKey)) || 1;
	const rng = () => {
		// LCG (Numerical Recipes constants) — deterministic, no Math.random.
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 0x100000000;
	};
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	return pool.slice(0, Math.min(count, pool.length));
}

// ---------------------------------------------------------------------------
// Per-player quest state — lives on the player's profile (off-schema), persisted
// through the account-keyed player store alongside the pack/purse.
//   active:    { [missionId]: run }            in-progress missions
//   completed: { [missionId]: { count, ts } }  lifetime completions (for one-shots
//                                              + board state + UI badges)
//   daily:     { day, done: [missionId] }       which dailies were finished today
// A `run` is { id, stage, counts: { [stageIndex]: n }, startedAt, day }.
// ---------------------------------------------------------------------------

export function newQuestState(dayKey = utcDayKey()) {
	return {
		active: {},
		completed: {},
		daily: { day: dayKey, done: [] },
	};
}

// Rebuild from a persisted blob, tolerant of partial/legacy/missing data — a
// corrupt save can never crash a join; it degrades to a fresh quest log. Stale
// daily state is rolled over to the current day on load (yesterday's completions
// don't block today's offers).
export function restoreQuestState(saved, dayKey = utcDayKey()) {
	const base = newQuestState(dayKey);
	if (!saved || typeof saved !== 'object') return base;

	if (saved.active && typeof saved.active === 'object') {
		for (const [id, run] of Object.entries(saved.active)) {
			const mission = MISSIONS[id];
			if (!mission || !run || typeof run !== 'object') continue;
			// Heists are ephemeral, room-scoped shared instances — never restored as a
			// solo active run (you re-join the crew live), so drop any persisted heist.
			if (mission.kind === 'heist') continue;
			const stage = Math.max(0, Math.min(mission.objectives.length - 1, run.stage | 0));
			const counts = {};
			if (run.counts && typeof run.counts === 'object') {
				for (const [k, v] of Object.entries(run.counts)) {
					const idx = k | 0;
					if (idx >= 0 && idx < mission.objectives.length && Number.isFinite(v)) {
						counts[idx] = Math.max(0, v | 0);
					}
				}
			}
			base.active[id] = { id, stage, counts, startedAt: Number(run.startedAt) || 0, day: typeof run.day === 'string' ? run.day : dayKey };
		}
	}

	if (saved.completed && typeof saved.completed === 'object') {
		for (const [id, rec] of Object.entries(saved.completed)) {
			if (!MISSIONS[id]) continue;
			const count = Number.isFinite(rec?.count) ? Math.max(0, rec.count | 0) : 1;
			base.completed[id] = { count, ts: Number(rec?.ts) || 0 };
		}
	}

	// Daily completions only count for the current UTC day; a new day clears them.
	if (saved.daily && saved.daily.day === dayKey && Array.isArray(saved.daily.done)) {
		base.daily = { day: dayKey, done: saved.daily.done.filter((id) => !!MISSIONS[id]) };
	}

	return base;
}

export function serializeQuestState(state) {
	if (!state) return newQuestState();
	const active = {};
	for (const [id, run] of Object.entries(state.active || {})) {
		// Don't persist heist runs (ephemeral shared instances).
		if (MISSIONS[id]?.kind === 'heist') continue;
		active[id] = { id: run.id, stage: run.stage, counts: { ...run.counts }, startedAt: run.startedAt, day: run.day };
	}
	return {
		active,
		completed: { ...(state.completed || {}) },
		daily: { day: state.daily?.day || utcDayKey(), done: [...(state.daily?.done || [])] },
	};
}

// Roll the daily log over to `dayKey` if it's stale. Call on each board read so a
// player who stayed online across UTC midnight sees the new day's offers and may
// re-run today's dailies. Returns true if it rolled (the caller may re-offer).
export function rolloverDaily(state, dayKey = utcDayKey()) {
	if (!state.daily || state.daily.day !== dayKey) {
		state.daily = { day: dayKey, done: [] };
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Offers — which missions the board may show this player right now.
// ---------------------------------------------------------------------------

function prereqMet(state, mission) {
	if (!Array.isArray(mission.prereq) || !mission.prereq.length) return true;
	return mission.prereq.every((pid) => (state.completed[pid]?.count | 0) > 0);
}

// Is `mission` acceptable by this player right now? (Not already active, prereqs
// met, and the repeat rule satisfied: a one-shot not yet done, a daily not yet
// done today, a repeatable always.)
export function canAccept(state, mission, dayKey = utcDayKey()) {
	if (!mission) return false;
	if (state.active[mission.id]) return false;
	if (!prereqMet(state, mission)) return false;
	if (mission.repeat === 'once') return !(state.completed[mission.id]?.count > 0);
	if (mission.repeat === 'daily') return !state.daily.done.includes(mission.id);
	return true; // repeatable
}

// The board: the missions this player can accept now, plus any in-progress runs,
// shaped for the client. Daily offers are the day's rotated subset; the rest are
// the always-available repeatable/one-shot jobs. Heists are surfaced too (the
// client shows a "needs a crew" hint).
export function boardOffers(state, dayKey = utcDayKey()) {
	rolloverDaily(state, dayKey);
	const dailyIds = new Set(dailyJobIds(dayKey));
	const offers = [];
	for (const mission of Object.values(MISSIONS)) {
		if (mission.repeat === 'daily' && !dailyIds.has(mission.id)) continue; // not in today's rotation
		if (state.active[mission.id]) continue; // already accepted
		if (!canAccept(state, mission, dayKey)) continue;
		offers.push(offerView(mission, state));
	}
	return offers;
}

function offerView(mission, state) {
	return {
		id: mission.id,
		title: mission.title,
		giver: mission.giver,
		summary: mission.summary,
		kind: mission.kind,
		repeat: mission.repeat,
		party: mission.party || 1,
		reward: { ...mission.reward },
		objectives: mission.objectives.map((o) => ({ type: o.type, label: o.label, count: objCount(o) })),
		completedCount: state.completed[mission.id]?.count | 0,
	};
}

// ---------------------------------------------------------------------------
// Accept / abandon
// ---------------------------------------------------------------------------

export function acceptMission(state, id, dayKey = utcDayKey()) {
	const mission = MISSIONS[id];
	if (!mission) return { ok: false, reason: 'unknown' };
	rolloverDaily(state, dayKey);
	if (state.active[id]) return { ok: false, reason: 'active' };
	if (!canAccept(state, mission, dayKey)) {
		const reason = mission.repeat === 'daily' ? 'daily-done'
			: mission.repeat === 'once' ? 'done'
			: 'locked';
		return { ok: false, reason };
	}
	const run = { id, stage: 0, counts: {}, startedAt: Date.now(), day: dayKey };
	state.active[id] = run;
	return { ok: true, run, mission };
}

export function abandonMission(state, id) {
	if (!state.active[id]) return { ok: false };
	delete state.active[id];
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Progress — feed a real gameplay event into a run.
// ---------------------------------------------------------------------------

// Does objective `obj` match gameplay `event`?
//   collect:  { type:'collect', item, qty }
//   goto:     { type:'enter-zone', zone }
//   interact: { type:'interact', zone, action }
// `event.qty` (collect) defaults to 1.
export function objectiveMatches(obj, event) {
	if (!obj || !event) return false;
	if (obj.type === 'collect') {
		return event.type === 'collect' && event.item === obj.item;
	}
	if (obj.type === 'goto') {
		if (event.type !== 'enter-zone' || event.zone !== obj.zone) return false;
		// A `vehicle: true` goto is a driving leg — walking through the zone doesn't
		// count, only crossing it in the driver's seat (event.inVehicle, set by the
		// room from the authoritative vehicle-driver map).
		if (obj.vehicle && !event.inVehicle) return false;
		return true;
	}
	if (obj.type === 'interact') {
		if (event.type !== 'interact') return false;
		if (obj.action && event.action !== obj.action) return false;
		if (obj.vehicle && !event.inVehicle) return false;
		// A multi-zone objective (e.g. two terminals) matches any of its zones.
		if (Array.isArray(obj.zones)) return obj.zones.includes(event.zone);
		return !obj.zone || event.zone === obj.zone;
	}
	return false;
}

// Apply an event to a run (or a shared heist instance — same shape). Mutates the
// run's stage/counts. Returns:
//   { matched, objComplete, missionComplete, stage }
// `progressed` runs carry an optional `seen` Set on shared multi-zone objectives so
// the same terminal can't be tapped twice for two ticks.
export function applyEvent(run, mission, event) {
	const result = { matched: false, objComplete: false, missionComplete: false, stage: run.stage };
	if (!mission) return result;
	const obj = mission.objectives[run.stage];
	if (!obj) return result;
	if (!objectiveMatches(obj, event)) return result;

	// Multi-zone objectives count distinct zones, not repeat taps of one zone.
	if (Array.isArray(obj.zones)) {
		if (!run.seen) run.seen = {};
		const seenKey = String(run.stage);
		const seen = (run.seen[seenKey] = run.seen[seenKey] || []);
		if (seen.includes(event.zone)) return result; // already counted this terminal
		seen.push(event.zone);
	}

	result.matched = true;
	const need = objCount(obj);
	const inc = obj.type === 'collect' ? Math.max(1, event.qty | 0 || 1) : 1;
	run.counts[run.stage] = Math.min(need, (run.counts[run.stage] | 0) + inc);

	if (run.counts[run.stage] >= need) {
		result.objComplete = true;
		run.stage += 1;
		if (run.stage >= mission.objectives.length) {
			result.missionComplete = true;
		}
	}
	result.stage = run.stage;
	return result;
}

// Mark a mission completed in the player's lifetime + daily log. Returns the new
// completion count.
export function recordCompletion(state, mission, dayKey = utcDayKey()) {
	const prev = state.completed[mission.id]?.count | 0;
	state.completed[mission.id] = { count: prev + 1, ts: Date.now() };
	delete state.active[mission.id];
	if (mission.repeat === 'daily') {
		rolloverDaily(state, dayKey);
		if (!state.daily.done.includes(mission.id)) state.daily.done.push(mission.id);
	}
	return prev + 1;
}

// ---------------------------------------------------------------------------
// Reward shaping + validation (used by the room when granting).
// ---------------------------------------------------------------------------

// The reward a solo mission grants. Heists split the pot, computed by the room.
export function missionReward(mission) {
	const r = mission?.reward || {};
	const out = { gold: Math.max(0, r.gold | 0) };
	if (r.xp && SKILLS.includes(r.xp.skill) && r.xp.amount > 0) {
		out.xp = { skill: r.xp.skill, amount: r.xp.amount | 0 };
	}
	return out;
}

// Split a heist pot across `n` crew members — even split, remainder to the first
// member so no gold is lost to rounding. Returns an array of per-member gold.
export function splitPot(totalGold, n) {
	const count = Math.max(1, n | 0);
	const base = Math.floor(totalGold / count);
	const rem = totalGold - base * count;
	return Array.from({ length: count }, (_, i) => base + (i < rem ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Client snapshots
// ---------------------------------------------------------------------------

// One active run shaped for the client tracker: the mission's objective list with
// per-objective progress and which one is current.
export function runView(run, mission) {
	const objectives = mission.objectives.map((o, i) => ({
		type: o.type,
		label: o.label,
		count: objCount(o),
		progress: Math.min(objCount(o), run.counts[i] | 0),
		done: i < run.stage,
		current: i === run.stage,
		zone: o.zone || (Array.isArray(o.zones) ? o.zones[0] : null),
		zones: Array.isArray(o.zones) ? [...o.zones] : null,
		action: o.action || null,
	}));
	return {
		id: mission.id,
		title: mission.title,
		giver: mission.giver,
		kind: mission.kind,
		party: mission.party || 1,
		reward: { ...mission.reward },
		stage: run.stage,
		objectives,
	};
}

// The full quest payload sent to a client (board offers + active runs). Heist runs
// are layered on by the room (shared-instance progress), so this covers solo runs;
// the room merges any live heist run before sending.
export function questSnapshot(state, dayKey = utcDayKey()) {
	const active = [];
	for (const [id, run] of Object.entries(state.active)) {
		const mission = MISSIONS[id];
		if (mission) active.push(runView(run, mission));
	}
	return {
		offers: boardOffers(state, dayKey),
		active,
		day: dayKey,
	};
}
