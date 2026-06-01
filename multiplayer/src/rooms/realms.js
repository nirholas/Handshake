// Realm definitions — the authoritative maps the GameRoom validates against.
// The client renders the SAME data (sent on join), so the visual world and the
// walkable world never drift apart. Coordinates are tile indices.
//
// Every realm shares one shape:
//   { name, grid, spawn:{tx,ty}, safe:bool, pvp:bool, danger:bool,
//     blocked:[{x0,y0,x1,y1}], water:[{x0,y0,x1,y1}], bankZone:[{tx,ty}],
//     fountain:{tx,ty}|null, nodes:[{id,kind,tx,ty}],
//     mobs:[{id,kind,tx,ty,hp,roam,aggro}], fishing:[{tx,ty,quality}],
//     cooking:[{tx,ty}], safeCamp:{x0,y0,x1,y1}|null,
//     structures:['firepit'|'shack'], portals:[{x0,y0,x1,y1,to,toTx,toTy}] }
//
// `structures` lists which player-built structure kinds this realm permits. A
// firepit (temporary healing) is allowed wherever building makes sense; the
// shack (permanent landmark) is Whisperwood-only by design.
//
// `water` rects are a visual subset of `blocked` (non-walkable, rendered as
// water on the client). `fishing` tiles are walkable shore spots beside water,
// each carrying a `quality` multiplier that scales catch rate + yield.
//
// `danger` realms drop a tombstone on death. `pvp` realms allow player combat
// outside any safeCamp. Resource node ids must be unique WITHIN a realm.
//
// A few realms carry extra fields beyond the shared shape:
//   • `cave: true`        — render as an enclosed cavern (dark rock) not open sky.
//   • `ring: {x0,y0,x1,y1}`— a practice boxing ring: a walkable, purely-cosmetic
//                            platform (no death risk) drawn with ropes + posts.
//   • `seating: [{x0,y0,x1,y1}]` — spectator stands: walkable NO-PvP zones (like a
//                            mobile safeCamp) so onlookers aren't dragged into a fight.
//   • `rollers: [{x0,y0,x1,y1,dir}]` — moving-floor strips. On the sim tick the
//                            server pushes any player standing on one tile in `dir`
//                            ('n'|'s'|'e'|'w'), respecting walkability — learn-the-
//                            flow movement, never a teleport.
// A portal may carry `gate: { combat }` — entry is refused until the player's
// combat level meets the threshold (the server checks it before the handoff).

function nodesFrom(coords, kind, prefix) {
	return coords.map(([tx, ty], i) => ({ id: `${prefix}${i}`, kind, tx, ty }));
}
function tiles(coords) {
	return coords.map(([tx, ty]) => ({ tx, ty }));
}
// Fishing shore spots with a per-tile catch-quality multiplier (1 = average).
// Higher quality = better catch rate and a higher chance of a double haul.
function fishSpots(coords, quality = 1) {
	return coords.map(([tx, ty]) => ({ tx, ty, quality }));
}

// ---------------------------------------------------------------- Mainland
const MAINLAND = {
	name: 'mainland',
	grid: 48,
	spawn: { tx: 24, ty: 30 },
	safe: true, pvp: false, danger: false,
	blocked: [
		{ x0: 8, y0: 8, x1: 12, y1: 11 }, // bank building
		{ x0: 23, y0: 23, x1: 24, y1: 24 }, // fountain
		{ x0: 31, y0: 38, x1: 34, y1: 41 }, // the millpond (water — also in `water` below)
		{ x0: 27, y0: 13, x1: 30, y1: 15 }, // Fortune's Folly casino (landmark — see `landmarks`)
		{ x0: 28, y0: 17, x1: 28, y1: 17 }, // the Wheel of Fortune (interactable — players stand adjacent)
	],
	water: [
		{ x0: 31, y0: 38, x1: 34, y1: 41 }, // the millpond, fishable from its banks
	],
	fountain: { tx: 23, ty: 23 },
	bankZone: tiles([[8, 12], [9, 12], [10, 12], [11, 12], [12, 12]]),
	// Fixed, interactable characters. Aldric the Guide stands just off the spawn
	// and drives the tutorial + daily-quest turn-ins. NPCs occupy their tile
	// (players stand adjacent to talk), validated like resource nodes.
	npcs: [
		{ id: 'aldric', name: 'Aldric the Guide', kind: 'guide', tx: 26, ty: 29 },
	],
	// Fixed world landmarks (Task 19). A `casino` is a decorative building (its
	// footprint is in `blocked` above); a `wheel` is interactable — the client
	// renders it, a click walks the player adjacent, and standing beside it opens
	// the Wheel of Fortune. The wheel's own tile is blocked so players approach it
	// from an adjacent tile, exactly like the bank counter or an NPC.
	landmarks: [
		{ id: 'fortunes-folly', kind: 'casino', tx: 28, ty: 14, label: "Fortune's Folly" },
		{ id: 'wheel', kind: 'wheel', tx: 28, ty: 17, label: 'Wheel of Fortune' },
	],
	nodes: [
		...nodesFrom([[12, 28], [14, 30], [16, 29], [13, 33], [15, 35], [11, 31], [18, 34], [20, 30],
			[17, 37], [19, 38], [10, 36], [22, 36], [8, 30], [9, 33], [21, 40], [13, 40]], 'tree', 't'),
		...nodesFrom([[34, 14], [36, 16], [38, 13], [40, 15], [35, 18], [39, 18], [42, 12], [33, 16]], 'rock', 'r'),
		...nodesFrom([[37, 20], [41, 20], [34, 21], [39, 22]], 'coal', 'c'),
	],
	mobs: [
		{ id: 'd0', kind: 'dummy', tx: 36, ty: 34, hp: 50, roam: false, aggro: false },
		{ id: 'd1', kind: 'dummy', tx: 38, ty: 34, hp: 50, roam: false, aggro: false },
		{ id: 'd2', kind: 'dummy', tx: 37, ty: 36, hp: 50, roam: false, aggro: false },
		// Loot mobs (Task 09): a docile monster glade in the SE so mounts are
		// obtainable on the hub today. roam/aggro stay false — even once mob AI
		// (Task 03) lands, these stand their ground and never harass the safe town.
		{ id: 'gm0', kind: 'goblin', tx: 41, ty: 32, hp: 34, roam: false, aggro: false },
		{ id: 'gm1', kind: 'goblin', tx: 44, ty: 34, hp: 34, roam: false, aggro: false },
		{ id: 'gm2', kind: 'goblin', tx: 42, ty: 38, hp: 34, roam: false, aggro: false },
		{ id: 'om0', kind: 'ogre', tx: 44, ty: 39, hp: 80, roam: false, aggro: false },
	],
	// Millpond banks — a calm starter spot (average quality) so a fresh player can
	// learn the cast on the Mainland before the richer realms open up.
	fishing: fishSpots([
		[30, 38], [30, 39], [30, 40], [30, 41], // west bank
		[35, 38], [35, 39], [35, 40], [35, 41], // east bank
		[31, 37], [32, 37], [33, 37], [34, 37], // north bank
		[31, 42], [32, 42], [33, 42], [34, 42], // south bank
	], 1.0),
	cooking: [],
	safeCamp: null,
	// The Arena plaza: a practice boxing ring (cosmetic, walkable, zero death risk
	// since the Mainland is `safe`) beside the portal into the full Arena. A fresh
	// fighter can learn footwork in the ring before stepping through to real PvP.
	ring: { x0: 6, y0: 16, x1: 10, y1: 20 },
	structures: ['firepit'],
	portals: [
		{ x0: 23, y0: 0, x1: 25, y1: 0, to: 'wilderness', toTx: 20, toTy: 36 }, // north → wilderness safe camp
		{ x0: 23, y0: 47, x1: 25, y1: 47, to: 'whisperwood', toTx: 20, toTy: 2 }, // south → whisperwood
		{ x0: 47, y0: 23, x1: 47, y1: 25, to: 'pond', toTx: 2, toTy: 18 }, // east → pond
		// Mine entrance — a cave mouth cut into the rocky NE hills, just north of
		// the surface ore field. Steps down into the enclosed `mine` interior; the
		// mine's return portal lands the player back at (43,11), a tile clear of
		// this rect so they don't immediately bounce back in.
		{ x0: 43, y0: 9, x1: 44, y1: 9, to: 'mine', toTx: 16, toTy: 28 }, // NE → mine interior
		// Arena gate — a stone archway on the plaza just north-west of the ring. Steps
		// into the dedicated PvP Arena; its return strip lands the player at (12,21),
		// a tile clear of this rect (and beside the ring) so they don't bounce back in.
		{ x0: 12, y0: 14, x1: 13, y1: 14, to: 'arena', toTx: 14, toTy: 24 }, // plaza → arena
	],
};

// ---------------------------------------------------------------- Wilderness
const WILDERNESS = {
	name: 'wilderness',
	grid: 40,
	spawn: { tx: 20, ty: 36 },
	safe: false, pvp: true, danger: true,
	blocked: [],
	water: [],
	fountain: null,
	bankZone: [],
	nodes: [
		...nodesFrom([[10, 20], [14, 16], [26, 18], [30, 22], [8, 12], [32, 14], [18, 10], [22, 24]], 'tree', 't'),
		...nodesFrom([[12, 8], [28, 8], [34, 20], [6, 24], [16, 6]], 'rock', 'r'),
		...nodesFrom([[24, 6], [30, 10], [9, 17]], 'coal', 'c'),
	],
	mobs: [
		{ id: 'g0', kind: 'goblin', tx: 14, ty: 22, hp: 34, roam: true, aggro: true },
		{ id: 'g1', kind: 'goblin', tx: 24, ty: 20, hp: 34, roam: true, aggro: true },
		{ id: 'g2', kind: 'goblin', tx: 18, ty: 14, hp: 34, roam: true, aggro: true },
		{ id: 'g3', kind: 'goblin', tx: 30, ty: 16, hp: 34, roam: true, aggro: true },
		{ id: 'o0', kind: 'ogre', tx: 20, ty: 8, hp: 80, roam: true, aggro: true },
	],
	fishing: [],
	cooking: [],
	// southern fenced safe camp: no PvP, mobs won't enter.
	safeCamp: { x0: 14, y0: 32, x1: 26, y1: 39 },
	structures: ['firepit'],
	portals: [
		{ x0: 19, y0: 39, x1: 21, y1: 39, to: 'mainland', toTx: 24, toTy: 2 }, // south → mainland
		// North trail into the smaller, fully-PvP Wilderness North (no safe camp up
		// there). Lands at its southern return tile.
		{ x0: 19, y0: 0, x1: 21, y1: 0, to: 'wilderness_north', toTx: 16, toTy: 28 }, // north → wilderness north
		// East trail into the full-size Wilderness East. Lands just inside its west edge.
		{ x0: 39, y0: 18, x1: 39, y1: 20, to: 'wilderness_east', toTx: 2, toTy: 19 }, // east → wilderness east
	],
};

// ---------------------------------------------------------------- Whisperwood
const WHISPERWOOD = {
	name: 'whisperwood',
	grid: 40,
	spawn: { tx: 20, ty: 3 },
	safe: true, pvp: false, danger: false,
	blocked: [
		{ x0: 20, y0: 18, x1: 21, y1: 18 }, // forest pool (north)
		{ x0: 10, y0: 35, x1: 11, y1: 35 }, // brook (southwest)
		{ x0: 30, y0: 36, x1: 31, y1: 36 }, // brook (southeast)
	],
	water: [
		{ x0: 20, y0: 18, x1: 21, y1: 18 },
		{ x0: 10, y0: 35, x1: 11, y1: 35 },
		{ x0: 30, y0: 36, x1: 31, y1: 36 },
	],
	fountain: null,
	bankZone: [],
	nodes: [
		...nodesFrom([[8, 10], [10, 14], [12, 9], [14, 16], [16, 12], [9, 20], [13, 24], [17, 22],
			[24, 10], [28, 14], [26, 20], [30, 18], [22, 26], [32, 24], [11, 30], [27, 28], [19, 32], [23, 34]], 'tree', 't'),
		...nodesFrom([[34, 10], [6, 26], [35, 30], [7, 33]], 'rock', 'r'),
	],
	mobs: [],
	// Shaded woodland pools — modest quality vs. the open pond.
	fishing: fishSpots([[20, 17], [21, 17], [19, 19], [22, 19], [10, 34], [11, 34], [30, 35], [31, 35]], 0.9),
	cooking: [],
	safeCamp: null,
	structures: ['firepit', 'shack'],
	portals: [
		{ x0: 19, y0: 0, x1: 21, y1: 0, to: 'mainland', toTx: 24, toTy: 45 }, // north → mainland
	],
};

// ---------------------------------------------------------------- Pond
const POND = {
	name: 'pond',
	grid: 36,
	spawn: { tx: 3, ty: 18 },
	safe: true, pvp: false, danger: false,
	blocked: [
		{ x0: 14, y0: 12, x1: 22, y1: 22 }, // the large pond (water, non-walkable)
	],
	water: [
		{ x0: 14, y0: 12, x1: 22, y1: 22 }, // open water — the richest fishing in the world
	],
	fountain: null,
	bankZone: [],
	nodes: [
		...nodesFrom([[6, 6], [9, 9], [27, 8], [30, 12], [7, 26], [28, 26], [11, 29], [25, 30]], 'tree', 't'),
	],
	mobs: [],
	// fishable shoreline around the open pond — deep water, the best yields anywhere.
	fishing: fishSpots([
		[13, 14], [13, 16], [13, 18], [13, 20], [23, 14], [23, 16], [23, 18], [23, 20],
		[15, 11], [17, 11], [19, 11], [21, 11], [15, 23], [17, 23], [19, 23], [21, 23],
	], 1.3),
	cooking: tiles([[10, 18], [11, 18], [10, 19], [11, 19]]), // the Roast Pit
	safeCamp: null,
	structures: ['firepit'],
	portals: [
		{ x0: 0, y0: 17, x1: 0, y1: 19, to: 'mainland', toTx: 45, toTy: 24 }, // west → mainland
		// A narrow trail off the pond's quiet north shore crosses into the perils of
		// Wilderness East — leaving the safe pond for a full PvP+danger realm. Lands at
		// its southern edge.
		{ x0: 17, y0: 0, x1: 19, y1: 0, to: 'wilderness_east', toTx: 19, toTy: 37 }, // north → wilderness east
	],
};

// ---------------------------------------------------------------- Mine
// An enclosed cave interior reached through the Mainland mine entrance. It is a
// Mainland-side resource area, so it is `safe` (no PvP, no death-bags) — a place
// to mine in peace. There is no bank or fountain down here; you carry your haul
// back up to the Mainland bank. The edge is fully walled; thin interior ridges
// and pillars split it into an upper and a lower chamber joined by three gaps,
// giving the space a cave read without trapping any node. The mine is a markedly
// better mining spot than the surface by DENSITY: ~27 rock + ~12 coal nodes
// versus the Mainland's 8 + 4. Respawn timers stay the shared defaults
// (NODE_RULES in GameRoom), so the edge is "more to mine, less waiting" rather
// than faster individual nodes — better without trivializing progression.
const MINE = {
	name: 'mine',
	grid: 32,
	cave: true, // enclosed interior — rendered as a dark cavern, like the wilderness cave
	spawn: { tx: 16, ty: 28 }, // just inside the entrance, on the central corridor
	safe: true, pvp: false, danger: false,
	blocked: [
		// Cave shell — a one-tile rock wall around the whole interior, with a
		// three-tile gap at the bottom (x15..17) for the entrance/return opening.
		{ x0: 0, y0: 0, x1: 31, y1: 0 },   // north wall
		{ x0: 0, y0: 1, x1: 0, y1: 31 },   // west wall
		{ x0: 31, y0: 1, x1: 31, y1: 31 }, // east wall
		{ x0: 1, y0: 31, x1: 14, y1: 31 }, // south wall (west of the mouth)
		{ x0: 18, y0: 31, x1: 30, y1: 31 }, // south wall (east of the mouth)
		// Central ridge dividing the upper and lower chambers, broken by three
		// gaps (x1..3 left, x14..17 centre, x28..30 right) so both chambers and
		// the entrance corridor stay connected.
		{ x0: 4, y0: 11, x1: 13, y1: 12 },
		{ x0: 18, y0: 11, x1: 27, y1: 12 },
		// Pillars in the lower chamber — cover to mine around.
		{ x0: 8, y0: 19, x1: 9, y1: 21 },
		{ x0: 22, y0: 19, x1: 23, y1: 21 },
		// Short stubs in the upper chamber for a rougher cave outline.
		{ x0: 13, y0: 4, x1: 13, y1: 6 },
		{ x0: 19, y0: 4, x1: 19, y1: 6 },
	],
	water: [],
	fountain: null,
	bankZone: [],
	nodes: [
		// Upper chamber.
		...nodesFrom([[3, 3], [6, 2], [9, 4], [12, 3], [15, 3], [21, 3], [24, 2], [28, 4],
			[5, 7], [10, 8], [25, 7], [29, 8]], 'rock', 'r'),
		...nodesFrom([[7, 5], [18, 4], [27, 5], [14, 8]], 'coal', 'cu'),
		// Lower chamber.
		...nodesFrom([[3, 14], [6, 16], [11, 14], [14, 15], [19, 14], [24, 15], [28, 16],
			[4, 24], [12, 25], [20, 24], [26, 25], [8, 27], [24, 27], [3, 29], [29, 28]], 'rock', 'rl'),
		...nodesFrom([[5, 18], [12, 20], [18, 18], [21, 20], [27, 21], [9, 25], [17, 22], [25, 28]], 'coal', 'cl'),
	],
	mobs: [],
	fishing: [],
	cooking: [],
	safeCamp: null,
	structures: [], // a working mine, not a campsite — no player building down here
	portals: [
		// Return to the Mainland mine entrance. Lands at (43,11), a tile clear of
		// the Mainland entrance rect (y=9) so stepping out doesn't bounce back in.
		{ x0: 15, y0: 31, x1: 17, y1: 31, to: 'mainland', toTx: 43, toTy: 11 },
	],
};

// ---------------------------------------------------------------- Wilderness North
// A smaller, harsher spur reached from the top of the main Wilderness. The whole
// map is PvP — there is NO safe camp anywhere up here. Mob density is lower than
// the main Wilderness (fewer foes, but nowhere to catch your breath). At the far
// north a crag-flanked cave mouth holds a combat-LEVEL-GATED passage: only a
// hardened fighter (combat ≥ the portal's gate) may step through into the cave.
const WILDERNESS_NORTH = {
	name: 'wilderness_north',
	grid: 32,
	spawn: { tx: 16, ty: 28 }, // southern return tile, just inside the trail from the main Wilderness
	safe: false, pvp: true, danger: true,
	blocked: [
		// Crags flanking the northern cave mouth — they frame the gated passage at
		// x15..16 and read the far north as a rocky dead-end but for the cave.
		{ x0: 8, y0: 0, x1: 14, y1: 1 },
		{ x0: 17, y0: 0, x1: 23, y1: 1 },
	],
	water: [],
	fountain: null,
	bankZone: [],
	nodes: [
		...nodesFrom([[9, 12], [22, 10], [6, 20], [25, 18]], 'tree', 't'),
		...nodesFrom([[12, 6], [20, 6], [7, 8]], 'rock', 'r'),
		...nodesFrom([[15, 8]], 'coal', 'c'),
	],
	// Lower density than the main Wilderness (5 mobs): two goblins and a lone ogre.
	mobs: [
		{ id: 'g0', kind: 'goblin', tx: 12, ty: 16, hp: 34, roam: true, aggro: true },
		{ id: 'g1', kind: 'goblin', tx: 22, ty: 14, hp: 34, roam: true, aggro: true },
		{ id: 'o0', kind: 'ogre', tx: 16, ty: 10, hp: 80, roam: true, aggro: true },
	],
	fishing: [],
	cooking: [],
	safeCamp: null, // no refuge — PvP across the whole map
	structures: ['firepit'],
	portals: [
		{ x0: 15, y0: 31, x1: 17, y1: 31, to: 'wilderness', toTx: 20, toTy: 2 }, // south → main Wilderness top
		// The gated cave mouth. Entry needs combat ≥ 20; the server refuses an
		// under-level step with a notice and the player simply stays put.
		{ x0: 15, y0: 0, x1: 16, y1: 0, to: 'wilderness_cave', toTx: 14, toTy: 24, gate: { combat: 20 } }, // far north → cave (gated)
	],
};

// ---------------------------------------------------------------- Wilderness Cave
// The level-gated cavern beyond the northern gate — its own enclosed instance.
// Reaching it at all means you cleared the combat gate, so the danger is steep:
// trolls and ogres prowl a rich ore seam. PvP + danger like the open wilds, but
// underground (rendered as a dark cavern). A single passage south returns to
// Wilderness North.
const WILDERNESS_CAVE = {
	name: 'wilderness_cave',
	grid: 28,
	cave: true,
	spawn: { tx: 14, ty: 24 }, // arrival tile, just north of the return passage
	safe: false, pvp: true, danger: true,
	blocked: [
		// Cave shell — a one-tile rock wall around the whole interior.
		{ x0: 0, y0: 0, x1: 27, y1: 0 },
		{ x0: 0, y0: 1, x1: 0, y1: 27 },
		{ x0: 27, y0: 1, x1: 27, y1: 27 },
		{ x0: 1, y0: 27, x1: 26, y1: 27 },
		// Central ridge splitting upper/lower chambers, broken by a centre gap (x11..16).
		{ x0: 4, y0: 12, x1: 10, y1: 13 },
		{ x0: 17, y0: 12, x1: 23, y1: 13 },
		// Pillars — cover to fight and mine around.
		{ x0: 7, y0: 18, x1: 8, y1: 19 },
		{ x0: 19, y0: 18, x1: 20, y1: 19 },
	],
	water: [],
	fountain: null,
	bankZone: [],
	nodes: [
		...nodesFrom([[3, 3], [7, 2], [12, 3], [16, 3], [21, 2], [24, 4], [5, 8], [22, 8], [10, 9], [18, 9]], 'rock', 'r'),
		...nodesFrom([[9, 4], [14, 6], [19, 5], [4, 22], [23, 22], [13, 16]], 'coal', 'c'),
	],
	// Steep: two ogres, a troll, and a pair of goblins. All roam + aggro.
	mobs: [
		{ id: 'tr0', kind: 'troll', tx: 14, ty: 8, hp: 140, roam: true, aggro: true },
		{ id: 'o0', kind: 'ogre', tx: 6, ty: 6, hp: 80, roam: true, aggro: true },
		{ id: 'o1', kind: 'ogre', tx: 22, ty: 16, hp: 80, roam: true, aggro: true },
		{ id: 'g0', kind: 'goblin', tx: 9, ty: 20, hp: 34, roam: true, aggro: true },
		{ id: 'g1', kind: 'goblin', tx: 18, ty: 22, hp: 34, roam: true, aggro: true },
	],
	fishing: [],
	cooking: [],
	safeCamp: null,
	structures: [],
	portals: [
		{ x0: 13, y0: 26, x1: 15, y1: 26, to: 'wilderness_north', toTx: 15, toTy: 2 }, // south passage → Wilderness North
	],
};

// ---------------------------------------------------------------- Wilderness East
// A full-size wild expanse east of the main Wilderness, also reachable off the
// Pond's north shore. PvP + danger like the Wilderness, with the same kind of
// roaming foes and scattered resources, but no safe camp — the whole map is open.
const WILDERNESS_EAST = {
	name: 'wilderness_east',
	grid: 40,
	spawn: { tx: 4, ty: 20 },
	safe: false, pvp: true, danger: true,
	blocked: [],
	water: [],
	fountain: null,
	bankZone: [],
	nodes: [
		...nodesFrom([[10, 8], [16, 12], [24, 10], [30, 16], [8, 24], [34, 26], [20, 30], [28, 34], [14, 34]], 'tree', 't'),
		...nodesFrom([[12, 18], [26, 22], [33, 12], [9, 32], [22, 6]], 'rock', 'r'),
		...nodesFrom([[18, 24], [31, 30], [15, 6]], 'coal', 'c'),
	],
	mobs: [
		{ id: 'g0', kind: 'goblin', tx: 14, ty: 16, hp: 34, roam: true, aggro: true },
		{ id: 'g1', kind: 'goblin', tx: 26, ty: 14, hp: 34, roam: true, aggro: true },
		{ id: 'g2', kind: 'goblin', tx: 20, ty: 26, hp: 34, roam: true, aggro: true },
		{ id: 'g3', kind: 'goblin', tx: 32, ty: 22, hp: 34, roam: true, aggro: true },
		{ id: 'o0', kind: 'ogre', tx: 22, ty: 18, hp: 80, roam: true, aggro: true },
	],
	fishing: [],
	cooking: [],
	safeCamp: null,
	structures: ['firepit'],
	portals: [
		{ x0: 0, y0: 18, x1: 0, y1: 20, to: 'wilderness', toTx: 37, toTy: 19 }, // west → main Wilderness east edge
		{ x0: 17, y0: 39, x1: 19, y1: 39, to: 'pond', toTx: 18, toTy: 2 }, // south → Pond north shore
	],
};

// ---------------------------------------------------------------- Arena
// A dedicated PvP scene reached from the Mainland plaza. PvP is on, but it is NOT
// a `danger` realm — death here costs no items (a sporting bout, not the wilds);
// you simply respawn at the south gate. The floor carries moving ROLLERS that
// shove a standing fighter one tile per push in their direction — read the flow,
// use it, or get walked into your opponent's reach. SEATING along both flanks is a
// no-PvP spectator zone. A south strip returns to the Mainland plaza.
const ARENA = {
	name: 'arena',
	grid: 28,
	spawn: { tx: 14, ty: 24 }, // south gate, on the return strip's doorstep
	safe: false, pvp: true, danger: false,
	blocked: [
		// Arena bowl wall — a solid ring around the whole floor (the south return
		// strip is an interior portal tile, so no gap is needed in the wall).
		{ x0: 0, y0: 0, x1: 27, y1: 0 },
		{ x0: 0, y0: 1, x1: 0, y1: 27 },
		{ x0: 27, y0: 1, x1: 27, y1: 27 },
		{ x0: 0, y0: 27, x1: 27, y1: 27 },
	],
	water: [],
	fountain: null,
	bankZone: [],
	nodes: [],
	mobs: [],
	fishing: [],
	cooking: [],
	safeCamp: null,
	structures: [],
	// Spectator stands down the east and west flanks — walkable, but no PvP can be
	// dealt to or from anyone standing in them (enforced server-side alongside safeCamp).
	seating: [
		{ x0: 1, y0: 6, x1: 3, y1: 21 },
		{ x0: 24, y0: 6, x1: 26, y1: 21 },
	],
	// A closed clockwise loop of moving floor — 34 tiles, no gaps at the corners.
	// Each corner tile is owned by the strip that needs to push TOWARD the next
	// strip, so a fighter circling the belt stays on it indefinitely:
	//
	//   (8,10) east ──────────────► (18,10)
	//      ↑                               ↓ right col south y10→15
	//   (8,11→16)          (19,10→16)
	//   left col north         ↓ (19,16) bot belt west starts here
	//   (8,16) ◄───────────── (9,16)
	//
	// Transition points:
	//   (18,10) east → (19,10) right col south ✓
	//   (19,15) south → (19,16) bot belt west ✓
	//   (9,16)  west  → (8,16) left col north ✓
	//   (8,11)  north → (8,10) top belt east ✓
	rollers: [
		{ x0: 8,  y0: 10, x1: 18, y1: 10, dir: 'e' }, // top belt      x8→18
		{ x0: 19, y0: 10, x1: 19, y1: 15, dir: 's' }, // right col     y10→15 (owns top-right corner)
		{ x0: 9,  y0: 16, x1: 19, y1: 16, dir: 'w' }, // bottom belt   x9→19 (owns bot-right corner)
		{ x0: 8,  y0: 11, x1: 8,  y1: 16, dir: 'n' }, // left col      y11→16 (owns bot-left corner)
	],
	portals: [
		{ x0: 12, y0: 26, x1: 15, y1: 26, to: 'mainland', toTx: 12, toTy: 21 }, // south strip → Mainland plaza
	],
};

export const REALMS = {
	mainland: MAINLAND,
	wilderness: WILDERNESS,
	whisperwood: WHISPERWOOD,
	pond: POND,
	mine: MINE,
	wilderness_north: WILDERNESS_NORTH,
	wilderness_cave: WILDERNESS_CAVE,
	wilderness_east: WILDERNESS_EAST,
	arena: ARENA,
};

export const DEFAULT_REALM = 'mainland';

export function inBounds(realm, tx, ty) {
	return tx >= 0 && ty >= 0 && tx < realm.grid && ty < realm.grid;
}

export function isBlocked(realm, tx, ty) {
	for (const r of realm.blocked) {
		if (tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1) return true;
	}
	return false;
}

export function portalAt(realm, tx, ty) {
	for (const p of realm.portals) {
		if (tx >= p.x0 && tx <= p.x1 && ty >= p.y0 && ty <= p.y1) return p;
	}
	return null;
}

export function inRect(rect, tx, ty) {
	return rect && tx >= rect.x0 && tx <= rect.x1 && ty >= rect.y0 && ty <= rect.y1;
}

// The realm's spin-wheel landmark (Task 19), or null if this realm has none.
// The GameRoom uses its tile for the "stand adjacent to spin" check.
export function wheelLandmark(realm) {
	return (realm.landmarks || []).find((l) => l.kind === 'wheel') || null;
}

export function inAnyRect(rects, tx, ty) {
	if (!rects) return false;
	for (const r of rects) if (inRect(r, tx, ty)) return true;
	return false;
}

// Unit tile delta for a roller's push direction. Unknown directions don't move.
const ROLLER_DELTA = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
export function rollerDelta(dir) {
	return ROLLER_DELTA[dir] || [0, 0];
}

// The roller whose footprint covers (tx,ty), or null. The first match wins where
// strips overlap, so a corner belongs to whichever strip is listed first.
export function rollerAt(realm, tx, ty) {
	for (const r of realm.rollers || []) {
		if (inRect(r, tx, ty)) return r;
	}
	return null;
}

// True if (tx,ty) is a PvP-immune tile of this realm: inside the safe camp or any
// spectator-seating stand. Combat to/from such a tile is refused server-side.
export function inNoPvpZone(realm, tx, ty) {
	return inRect(realm.safeCamp, tx, ty) || inAnyRect(realm.seating, tx, ty);
}

// The best fishing spot within one tile (8-way, including the player's own tile)
// of (tx,ty), or null if there's no fishable water in reach. "Best" = highest
// quality, so standing where two spots overlap rewards the richer water.
export function fishingSpotNear(realm, tx, ty) {
	let best = null;
	for (const f of realm.fishing) {
		if (Math.abs(f.tx - tx) <= 1 && Math.abs(f.ty - ty) <= 1) {
			if (!best || (f.quality || 1) > (best.quality || 1)) best = f;
		}
	}
	return best;
}

// Serializable layout sent to the client on join (static geometry only;
// dynamic objects sync via schema state).
export function realmLayout(realm) {
	return {
		name: realm.name,
		grid: realm.grid,
		spawn: realm.spawn,
		fountain: realm.fountain,
		blocked: realm.blocked,
		water: realm.water || [],
		bankZone: realm.bankZone,
		fishing: realm.fishing,
		cooking: realm.cooking,
		safeCamp: realm.safeCamp,
		npcs: (realm.npcs || []).map((n) => ({ id: n.id, name: n.name, kind: n.kind, tx: n.tx, ty: n.ty })),
		landmarks: (realm.landmarks || []).map((l) => ({ id: l.id, kind: l.kind, tx: l.tx, ty: l.ty, label: l.label })),
		structures: realm.structures || [],
		// Portals carry their combat gate (if any) so the client can label a locked
		// gate and pre-warn before a wasted walk. toTx/toTy stay server-only.
		portals: realm.portals.map((p) => ({ x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, to: p.to, gate: p.gate || null })),
		// Distinguishing scenery for the new realms — all optional, absent on the
		// classic four: an enclosed cave look, the practice boxing ring, spectator
		// stands, and the moving-floor rollers (with direction) the Arena renders.
		cave: !!realm.cave,
		ring: realm.ring || null,
		seating: realm.seating || [],
		rollers: (realm.rollers || []).map((r) => ({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, dir: r.dir })),
		safe: realm.safe,
		pvp: realm.pvp,
		danger: realm.danger,
	};
}
