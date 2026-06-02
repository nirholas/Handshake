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
