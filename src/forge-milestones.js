// Forge milestone notes: the gentle retention beat for the homepage mini-forge.
//
// The forge already celebrates a single completion (the materialize reveal + the
// "what's next?" discovery card). What it never did was acknowledge that you're
// building a collection, or give a reason to come back and make another. This is
// that nudge: on the Nth model forged on this device, an understated, honest note
// (never hype, never confetti, matching the platform's restrained voice) fires at
// a few meaningful milestones only. Most forges get nothing here, so the note
// stays special when it does land.
//
// Pure and side-effect-free by design so it's unit-testable; the caller owns the
// on-device count and the toast surface.

// Milestone thresholds, ascending. Deliberately sparse: reward the 3rd (you're
// past first-try curiosity), then round numbers that feel like real collections.
const MILESTONES = [
	{ at: 3, note: "That's 3 models forged. You're getting the hang of it." },
	{ at: 10, note: '10 models forged. You could embed a whole gallery of these.' },
	{ at: 25, note: '25 forged. That is a real collection now.' },
	{ at: 50, note: '50 models. Serious craftsmanship.' },
	{ at: 100, note: '100 forged. You have made a lot of 3D.' },
];

/**
 * The milestone note for the Nth forge, or null when N isn't a milestone.
 * @param {number} n - cumulative models forged on this device (1-based)
 * @returns {string|null}
 */
export function milestoneNote(n) {
	if (!Number.isInteger(n) || n < 1) return null;
	const hit = MILESTONES.find((m) => m.at === n);
	return hit ? hit.note : null;
}

export { MILESTONES };
