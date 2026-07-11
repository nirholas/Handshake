// Shared world features for the /play coin worlds.
//
// /play is a free-roam disc (radius ~60m), not the tile grid /game uses, so the
// spatial activities that /game anchors to map tiles (fishing spots, cooking pits,
// gather nodes) are re-anchored here to fixed positions in continuous world space.
//
// This module is the ONE source of truth for those positions, imported by BOTH the
// server (WalkRoom — validates "are you actually beside the water?") and the client
// (coincommunities/play-systems — renders the pond and gates the Cast button), so
// the playable world and the authoritative world can never drift apart. Coordinates
// are world metres in the XZ plane; the ground sits at y = 0.
//
// Every coin world shares this layout, so a player who learns where the ponds are
// in one community knows where they are in all of them. Spots avoid the spawn ring,
// the totem (0,0,-12) and the trading screen (0,0,-30) so they never overlap the
// landmarks already in the scene.

// Fishing ponds. `r` is the water radius; `quality` scales catch rate + double-haul
// odds (richer water fishes better), matching /game's per-spot quality multiplier.
export const FISHING_SPOTS = [
	{ id: 'pond-east', x: 30, z: 8, r: 5.5, quality: 1 },
	{ id: 'pond-west', x: -28, z: 16, r: 4.6, quality: 1.4 },
];

// How far BEYOND a pond's water edge a player may stand and still cast — you fish
// from the bank, not from the middle of the water. Generous enough that the Cast
// button feels reliable as you walk up, tight enough that it's clearly "at" the pond.
export const FISH_REACH = 3.4;

// Distance from (x,z) to the nearest castable shore of a pond. Returns the spot and
// the gap (0 when already in range) so callers can both gate the action and show a
// "walk a little closer" hint. Null when no pond is within reach.
export function nearestFishingSpot(x, z) {
	let best = null;
	for (const spot of FISHING_SPOTS) {
		const d = Math.hypot(x - spot.x, z - spot.z);
		const gap = d - (spot.r + FISH_REACH);
		if (!best || gap < best.gap) best = { spot, gap, dist: d };
	}
	return best;
}

// Server-side gate: is the player standing close enough to a pond to cast? Returns
// the spot (with its quality) or null. The single check both the server trusts and
// the client mirrors for the button — same function, no drift.
export function fishingSpotInRange(x, z) {
	const near = nearestFishingSpot(x, z);
	return near && near.gap <= 0 ? near.spot : null;
}

// ---------------------------------------------------------------------------
// Gather & craft stations — woodcutting, mining, cooking (W06)
// ---------------------------------------------------------------------------
//
// The gather→craft loop's fixed world stations, the chop/mine/cook counterpart to
// the fishing ponds above. All sited in the SAFE town (clear of the W07 danger
// zones), so the gather economy stays peaceful — you fight foes in the wilds, you
// gather and cook at home. Generalised over `nearestNode` so the range rule the
// server trusts and the client renders the button from is byte-identical to fishing.

// Generic proximity: distance from (x,z) to the nearest usable edge of a node list,
// where each node is { x, z, r } and `reach` is how far beyond the body radius a
// player may stand and still act. Returns { node, gap, dist } for the nearest (gap ≤
// 0 = in range) or null when the list is empty.
export function nearestNode(x, z, nodes, reach) {
	let best = null;
	for (const node of nodes) {
		const dist = Math.hypot(x - node.x, z - node.z);
		const gap = dist - (node.r + reach);
		if (!best || gap < best.gap) best = { node, gap, dist };
	}
	return best;
}

function nodeInRange(x, z, nodes, reach) {
	const near = nearestNode(x, z, nodes, reach);
	return near && near.gap <= 0 ? near.node : null;
}

// Trees, chopped with an axe. `difficulty` scales the chop curve (a hardwood is
// slower). A grove west of the totem, clear of the ponds and the danger zones.
export const TREES = [
	{ id: 'tree-1', x: -36, z: -6, r: 0.9, difficulty: 1 },
	{ id: 'tree-2', x: -39, z: -11, r: 0.9, difficulty: 1.2 },
	{ id: 'tree-3', x: -33, z: -14, r: 0.9, difficulty: 1 },
	{ id: 'tree-4', x: -41, z: -4, r: 0.9, difficulty: 1.4 },
	{ id: 'tree-5', x: -35, z: -20, r: 0.9, difficulty: 1.2 },
];
export const CHOP_REACH = 2.6;
export function nearestTree(x, z) { return nearestNode(x, z, TREES, CHOP_REACH); }
export function treeInRange(x, z) { return nodeInRange(x, z, TREES, CHOP_REACH); }

// Ore rocks, mined with a pickaxe. `difficulty` slows the strike; `coal` is the
// bonus-coal weight (denser seams give up coal more readily). A quarry east of the
// totem, away from the grove, the ponds and the danger zones.
export const ROCKS = [
	{ id: 'rock-1', x: 36, z: -16, r: 1.1, difficulty: 1, coal: 1 },
	{ id: 'rock-2', x: 40, z: -21, r: 1.1, difficulty: 1.3, coal: 1.4 },
	{ id: 'rock-3', x: 33, z: -24, r: 1.1, difficulty: 1.2, coal: 1.2 },
	{ id: 'rock-4', x: 42, z: -13, r: 1.1, difficulty: 1.5, coal: 1.6 },
];
export const MINE_REACH = 2.8;
export function nearestRock(x, z) { return nearestNode(x, z, ROCKS, MINE_REACH); }
export function rockInRange(x, z) { return nodeInRange(x, z, ROCKS, MINE_REACH); }

// Roast pits — cook raw fish into edible cooked fish. Sited beside the ponds so the
// catch→cook→eat loop is a short walk, not a trek.
export const FIREPITS = [
	{ id: 'fire-east', x: 23, z: 13, r: 1.0 },
	{ id: 'fire-west', x: -22, z: 20, r: 1.0 },
];
export const COOK_REACH = 2.6;
export function nearestFirepit(x, z) { return nearestNode(x, z, FIREPITS, COOK_REACH); }
export function firepitInRange(x, z) { return nodeInRange(x, z, FIREPITS, COOK_REACH); }

// The Wheel of Fortune — "Fortune's Folly" (W09/Task 19). One per world, in the
// open plaza north of the totem: clear of both ponds (~29–33m away), both
// firepits (~22–25m), and the plaza rod pickup (~16m) — a landmark on its own,
// not crowded against another station.
export const WHEEL = [
	{ id: 'wheel-plaza', x: 0, z: 22, r: 2.0 },
];
export const WHEEL_REACH = 3.0;
export function nearestWheel(x, z) { return nearestNode(x, z, WHEEL, WHEEL_REACH); }
export function wheelInRange(x, z) { return nodeInRange(x, z, WHEEL, WHEEL_REACH); }

// Fishing-rod pickups — a spare rod waiting on the bank for anyone without one
// (or anyone who wants a backup to store). Every player already starts with a
// rod in the hotbar and it's never lost on death, so these exist for
// discoverability and flavour, not survival: sited just past each pond's cast
// ring (clear of FISH_REACH, so the Cast and Pick-up prompts never overlap)
// plus one in the plaza for a brand-new player who wanders before their first
// cast. `r` matches the small prop footprint the client renders.
export const ROD_PICKUPS = [
	{ id: 'rod-dock-east', x: 40, z: 11, r: 0.6 },
	{ id: 'rod-dock-west', x: -37, z: 21, r: 0.6 },
	{ id: 'rod-plaza', x: 12, z: 12, r: 0.6 },
];
export const PICKUP_REACH = 2.4;
export function nearestRodPickup(x, z) { return nearestNode(x, z, ROD_PICKUPS, PICKUP_REACH); }
export function rodPickupInRange(x, z) { return nodeInRange(x, z, ROD_PICKUPS, PICKUP_REACH); }

// Mob spawn points — used by W07 combat and the ACTIVITIES dispatch in play-systems.
export const MOB_SPAWNS = [
	{ id: 'mob-danger-n', x: 0, z: -60, r: 1.5 },
	{ id: 'mob-danger-e', x: 60, z: 0, r: 1.5 },
	{ id: 'mob-danger-s', x: 0, z: 60, r: 1.5 },
	{ id: 'mob-danger-w', x: -60, z: 0, r: 1.5 },
];
export const MOB_REACH = 4.0;
export function nearestMobSpawn(x, z) { return nearestNode(x, z, MOB_SPAWNS, MOB_REACH); }

// ---------------------------------------------------------------------------
// Safe vs danger zones — opt-in PvP by location (W07)
// ---------------------------------------------------------------------------
//
// GTA / Kintara-style risk geography: the whole built-up town (spawn, totem,
// trading screen, and the gather/fish stations) is SAFE — no player may damage
// another there and no roaming mob enters it. Combat tension is confined to a
// handful of named WILDERNESS pockets sited in the open ground away from those
// landmarks: inside one, PvP is on and PvE mobs roam and drop the better loot.
// Naming the danger zones (rather than carving the map by radius) keeps the dense
// town peaceful, gives each red zone a sign to put over the crossing, and leaves
// the gather economy undisturbed.
//
// This is the ONE source of truth for the boundary, imported by BOTH the server
// (WalkRoom — gates every attack, confines + seeds mobs, picks death-drop rules)
// and the client (PlayCombat — paints the danger ground ring, signposts the
// crossing, gates the attack button). A circle test is exact, cheap and trivially
// unit-testable; W01 can later refine these into full districts.
// Sited within the area players actually roam today (the ~58 m central plaza the
// client renders) and clear of the gather/fish stations, so each is reachable and
// reads as its own wilderness. As W01's full district streaming lands these can
// move out into the deep map; the gating math doesn't change.
export const DANGER_ZONES = [
	{ id: 'southern-wilds', name: 'Southern Wilds', x: 0, z: -42, r: 10 },
	{ id: 'northern-wilds', name: 'Northern Wilds', x: 0, z: 42, r: 10 },
	{ id: 'eastern-marches', name: 'Eastern Marches', x: 40, z: 24, r: 9 },
];

export const WORLD_RADIUS = 60;            // matches WalkRoom's authoritative clamp
export const SPAWN_POINT = { x: 0, z: 0 }; // where the dead respawn — always safe

// The danger zone a world point sits inside, or null when it's in safe town.
export function dangerZoneAt(x, z) {
	for (const zone of DANGER_ZONES) {
		if (Math.hypot(x - zone.x, z - zone.z) <= zone.r) return zone;
	}
	return null;
}

// The zone kind a world point falls in. Pure and shared so client signposting and
// server gating agree to the metre.
export function zoneAt(x, z) {
	return dangerZoneAt(x, z) ? 'danger' : 'safe';
}

export function isSafeZone(x, z) {
	return !dangerZoneAt(x, z);
}

export function isDangerZone(x, z) {
	return !!dangerZoneAt(x, z);
}

// A random point inside a given danger zone (kept a little in from its edge so a
// spawn never lands straddling the boundary). `rng` is injectable so spawn
// placement is deterministic under test, mirroring the loot/fish roll helpers.
export function randomPointInZone(zone, rng = Math.random) {
	const rr = Math.max(0, zone.r - 1.5) * Math.sqrt(rng()); // uniform over the disc
	const a = rng() * Math.PI * 2;
	return { x: zone.x + Math.cos(a) * rr, z: zone.z + Math.sin(a) * rr };
}
