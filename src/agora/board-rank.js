// Board ranking + budgets: which open jobs earn a 3D marker.
//
// /api/agora/board unions two lanes: scarce on-chain AgenC bounties and the x402
// bazaar catalog, which is large and grows on its own (hundreds of live services
// on a normal day). Rendering a glowing marker per item is what "legible at a
// glance" must NOT mean: past a couple of dozen the board stops reading as a
// board, the markers stack into a tower well above the kiosk, and the GPU pays
// for geometry nobody can parse anyway.
//
// So the board has a budget, and this module decides who spends it:
//   • AgenC bounties outrank x402 services. They're the scarce lane, they carry
//     escrow and a claimant, and they're what the Commons is actually about.
//   • Inside a lane, the biggest reward wins the slot, the same value signal the
//     marker size already encodes, so the cap keeps the headline work visible.
//   • Ties keep the server's order, so a steady board doesn't reshuffle between
//     polls and markers stay put.
//
// The overflow count is returned, never swallowed: the roster states "+N more
// open jobs" so a capped board reads as capped, not as the whole economy.
//
// Deliberately free of Three.js and DOM imports so the selection rule is
// unit-testable on its own (tests/agora-board-rank.test.js).

// A marker is a lit sphere + additive glow sprite + beam. Two dozen reads as a
// busy board and lays out as four rows of six above the kiosk; more is noise.
export const MARKER_BUDGET = 24;

// The accessible roster is cheap HTML, so it carries more than the 3D board:
// enough to scroll through real work without building a thousand buttons.
export const ROSTER_BUDGET = 40;

function isOnchainTask(item) {
	// AgenC postings carry a task PDA; x402 services are tagged at the source.
	if (item?.source === 'x402') return false;
	return Boolean(item?.taskPda || item?.taskId);
}

// Rank the merged board and split it into the marker set, the roster set, and an
// honest overflow count.
//
// `magnitudeOf` maps a reward object to a comparable number (job-board.js passes
// professions.js's rewardMagnitude); it is injected so this module stays free of
// the Three.js-importing helpers.
export function rankBoardItems(items, opts = {}) {
	const list = Array.isArray(items) ? items.filter(Boolean) : [];
	const markerBudget = opts.markerBudget ?? MARKER_BUDGET;
	const rosterBudget = opts.rosterBudget ?? ROSTER_BUDGET;
	const magnitudeOf = opts.magnitudeOf || (() => 0);

	const ranked = list
		.map((item, index) => ({
			item,
			index,
			lane: isOnchainTask(item) ? 0 : 1,
			magnitude: Number(magnitudeOf(item.reward)) || 0,
		}))
		.sort((a, b) => (
			a.lane - b.lane
			|| b.magnitude - a.magnitude
			|| a.index - b.index
		))
		.map((entry) => entry.item);

	const markers = ranked.slice(0, Math.max(0, markerBudget));
	const roster = ranked.slice(0, Math.max(0, rosterBudget));
	return {
		markers,
		roster,
		total: ranked.length,
		hiddenFromRoster: Math.max(0, ranked.length - roster.length),
		hiddenFromBoard: Math.max(0, ranked.length - markers.length),
	};
}
