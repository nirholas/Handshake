// Fixed slot vocabulary for agent animation gestures.
//
// Two layers live here:
//
//   1. SLOTS + DEFAULT_ANIMATION_MAP: the slot names an agent may override
//      (meta.edits.animations) and the clip each one resolves to by default.
//      Every value is a real baked clip in public/animations/manifest.json;
//      tests/animation-slots.test.js fails the build if one drifts.
//   2. HINT_ALIASES + resolveHint: the skill-side vocabulary. Skills declare
//      `animationHint: '<name>'` (src/agent-skills*.js) and the avatar plays
//      the matching slot. Hints that are not slot names (the `gesture-*`
//      family) alias onto one, so a hint can never resolve to nothing.

export const SLOTS = [
	'idle',
	'wave',
	'nod',
	'shake',
	'think',
	'celebrate',
	'concern',
	'bow',
	'point',
	'shrug',
	'fidget',
	'dance',
	'inspect',
	'present',
	'sign',
	'curiosity',
	'patience',
	'manipulate',
	'conjure',
];

export const DEFAULT_ANIMATION_MAP = {
	idle: 'idle',
	// wave/nod/point/think/shrug each have a dedicated Mixamo clip in the
	// manifest. They used to borrow `reaction`/`pray`/`defeated` because the
	// dedicated clips had not been baked yet; the borrowed mappings outlived
	// their reason and left five real clips unreachable (registry.json
	// resolved_issues: wave-slot-mismatch).
	wave: 'wave',
	nod: 'nod',
	// A "no" is a head shake, not a 19-second angry gesture. xbot-head-shake is
	// the only baked head-shake clip and retargets like any other (the walk
	// state machine already plays it for `disagree`).
	shake: 'xbot-head-shake',
	think: 'think',
	celebrate: 'celebrate',
	concern: 'defeated',
	// No bow clip is baked yet, so this stays an approximation: `sitclap` reads
	// as gratitude/applause. Tracked in registry.json known_issues (bow-slot-
	// approximation) with the Mixamo source to add.
	bow: 'sitclap',
	point: 'point',
	shrug: 'shrug',
	// Was 'Fidget' — no such clip exists (case mismatch against the lowercase
	// manifest names too), so the slot silently no-op'd on every agent that hit
	// it. av-waiting is a real baked idle-fidget loop (see registry.json
	// known_issues: broken-fidget-slot).
	fidget: 'av-waiting',
	dance: 'rumba',
	// Skill-driven slots. Each one exists because a skill emits the matching
	// hint; before they were slots those hints hit no clip and no-op'd silently.
	inspect: 'lookdown',
	present: 'av-brag-claps',
	sign: 'xbot-agree',
	curiosity: 'av-spy',
	patience: 'av-waiting',
	manipulate: 'av-push-block',
	conjure: 'av-conductor',
};

const SLOT_SET = new Set(SLOTS);

/**
 * Skill hint → slot, for hints that are not slot names themselves.
 * The `gesture-*` family is namespaced by intent in src/agent-skills-scene.js.
 */
export const HINT_ALIASES = {
	gesture: 'point',
	'gesture-magic': 'conjure',
	'gesture-manipulate': 'manipulate',
};

/**
 * Resolve a slot name to a concrete animation clip name.
 * Checks the agent's override map first, falls back to DEFAULT_ANIMATION_MAP,
 * then returns the slot name itself as a last resort.
 * @param {string} slot
 * @param {Object|null} overrideMap — agent's meta.edits.animations
 * @returns {string}
 */
export function resolveSlot(slot, overrideMap) {
	if (overrideMap && overrideMap[slot]) return overrideMap[slot];
	return DEFAULT_ANIMATION_MAP[slot] ?? slot;
}

/**
 * Resolve a skill's `animationHint` to a slot name.
 *
 * Exact slot names pass through, known aliases map onto a slot, and an unknown
 * namespaced hint falls back to its family (`gesture-foo` → the `gesture`
 * alias) so a new hint in that family animates instead of no-oping. Returns
 * null when nothing matches, which callers treat as "play nothing" rather than
 * guessing a wrong clip.
 *
 * @param {string} hint
 * @returns {string|null} slot name, or null if the hint maps to no slot
 */
export function resolveHint(hint) {
	const key = String(hint || '').trim().toLowerCase();
	if (!key) return null;
	if (SLOT_SET.has(key)) return key;
	if (HINT_ALIASES[key]) return HINT_ALIASES[key];
	const family = key.split('-')[0];
	if (SLOT_SET.has(family)) return family;
	if (HINT_ALIASES[family]) return HINT_ALIASES[family];
	return null;
}
