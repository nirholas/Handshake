// Quest zones (W05) — the named world locations missions reference for goto /
// interact objectives, waypoints, and the heist district.
//
// This is the ONE source of truth for those positions, imported by BOTH the server
// (WalkRoom — validates "are you actually at the dock / vault?") and the client
// (quest-systems — renders the markers and gates the interact prompt), so the
// playable world and the authoritative world can never drift. It sits alongside
// world-features.js (fishing/gather positions) rather than inside it so the quest
// layer stays self-contained and conflict-free. Coordinates are world metres in the
// XZ plane; the ground sits at y = 0.
//
// `kind` tags how a zone is used:
//   'goto'     — a survey/patrol point you reach (drives an enter-zone objective)
//   'interact' — a quest object you act at (pickup/dropoff/terminal/crack)
// `r` is the trigger radius. Two survey points reuse the pond centres (see
// world-features.FISHING_SPOTS) so a survey also reveals where the fishing is. The
// vault district sits out east, clear of the spawn ring, the totem (0,0,-12) and the
// trade screen (0,0,-30), all within the world disc (radius ≈ 60).

export const QUEST_ZONES = [
	// Survey lookouts (Grounds Survey daily).
	{ id: 'pond-east', kind: 'goto', x: 30, z: 8, r: 5, label: 'East Pond' },
	{ id: 'pond-west', kind: 'goto', x: -28, z: 16, r: 5, label: 'West Pond' },
	{ id: 'lookout-north', kind: 'goto', x: 0, z: 44, r: 4.5, label: 'North Lookout' },

	// Courier run: pick up at the dock, deliver to the market.
	{ id: 'dock-east', kind: 'interact', action: 'pickup', x: 34, z: 0, r: 3.0, label: 'East Dock', glyph: '📦' },
	{ id: 'market-stall', kind: 'interact', action: 'dropoff', x: -16, z: -22, r: 3.0, label: 'Market Stall', glyph: '🏷️' },

	// Vehicle depots: cross-town delivery jobs. Sit right on the avenue vehicle
	// spawns (vehicles.js VEHICLE_SPAWNS) so a car is always parked at the start of
	// the run; wide radius since you're arriving by car, not walking up to a mark.
	{ id: 'depot-north', kind: 'goto', x: 6, z: -90, r: 8, label: 'North Depot', glyph: '🚚' },
	{ id: 'depot-south', kind: 'goto', x: -6, z: 90, r: 8, label: 'South Depot', glyph: '🚚' },
	{ id: 'depot-east', kind: 'goto', x: 90, z: 6, r: 8, label: 'East Depot', glyph: '🚚' },
	{ id: 'depot-west', kind: 'goto', x: -90, z: -6, r: 8, label: 'West Depot', glyph: '🚚' },

	// Vault heist district: two alarm terminals flanking the vault door.
	{ id: 'vault-terminal-a', kind: 'interact', action: 'terminal', x: 50, z: 16, r: 2.8, label: 'Alarm Terminal A', glyph: '🖥️' },
	{ id: 'vault-terminal-b', kind: 'interact', action: 'terminal', x: 50, z: -16, r: 2.8, label: 'Alarm Terminal B', glyph: '🖥️' },
	{ id: 'vault-door', kind: 'interact', action: 'crack', x: 54, z: 0, r: 3.4, label: 'The Vault', glyph: '🏦' },
];

const QUEST_ZONE_BY_ID = new Map(QUEST_ZONES.map((z) => [z.id, z]));

// Reach beyond a zone's radius that still counts as "at" it — a little margin so the
// prompt feels reliable as you walk up (mirrors FISH_REACH for activities).
export const ZONE_REACH = 1.6;

export function questZone(id) {
	return QUEST_ZONE_BY_ID.get(id) || null;
}

// Which quest zone (if any) the point (x,z) is inside, including the reach margin.
// Nearest centre wins on overlap. The single check the server trusts for both
// zone-entry (goto) and the interact gate, mirrored by the client for waypoints and
// the interact prompt — same function, no drift.
export function zoneAt(x, z) {
	let best = null;
	let bestD = Infinity;
	for (const zone of QUEST_ZONES) {
		const d = Math.hypot(x - zone.x, z - zone.z);
		if (d <= zone.r + ZONE_REACH && d < bestD) { best = zone; bestD = d; }
	}
	return best;
}

// Server-side gate for an interact at the player's position: the 'interact' zone
// they're standing in, or null (a goto lookout isn't something you "act" at).
export function interactZoneInRange(x, z) {
	const zone = zoneAt(x, z);
	return zone && zone.kind === 'interact' ? zone : null;
}
