// api/_lib/display-name-safety.js
//
// Hate-slur gate for THIRD-PARTY text we index and render as our own UI.
//
// The ERC-8004 crawler indexes every agent registered on-chain across several
// chains — 126k rows and climbing — and hydrates each one's display name,
// description and image straight from attacker-controlled metadata. Until this
// gate existed, whether a row appeared on three.ws was decided by a single line:
//
//     const active = meta.active !== false;   // the agent's own metadata says so
//
// Nothing checked what the name said. A Base-registered agent whose name was a
// racial slur was `active`, `has_3d`, and rendered on /marketplace.
//
// ── PRECISION IS THE WHOLE PROBLEM ───────────────────────────────────────────
// A false negative shows a slur once. A false positive silently delists a
// legitimate on-chain agent forever, with no appeal and no signal to its owner.
// The second failure is the one that scales, so this gate is deliberately narrow:
//
//   • Unambiguous racial / ethnic / anti-LGBT slurs only. NOT a profanity filter.
//     Agent and token names are crude by nature; "shit", "damn", "hell" pass.
//   • WHOLE-WORD matching. Substring matching is what makes naive filters useless:
//     it flags "kikel-jina69" (an Olas-generated agent name) and "Scunthorpe".
//   • Hex-aware. Names routinely embed addresses — "Surf AI for 0xdb6b887289c380…".
//     Leetspeak folding (0→o, 3→e, 8→b …) turns any address into letter soup, and
//     a long enough one contains almost any short stem. Addresses are excluded
//     from the letters-only evasion pass, and short stems are never matched inside
//     a long alphanumeric run.
//
// Applied at hydration (a slur never becomes `active`) and to already-indexed rows
// via scripts/deactivate-slur-agents.mjs. Every public feed already filters
// `active = true`, so one flag covers explore, marketplace, agents, and search.
//
// Dependency-free and synchronous — the crawler hydrates thousands of rows per tick
// and must not pay a network hop per name.

// Stems in canonical (folded, lowercase) form. Matched as WHOLE WORDS, with an
// optional plural/possessive tail, never as bare substrings.
//
// Notably absent, and why:
//   • "coon"  — "Coon" is a common surname, and "raccoon"/"tycoon"/"Coon Rapids"
//               are ordinary. Even whole-word, the false-positive cost is too high.
//   • "spic"  — kept, because whole-word cannot reach inside "spice"/"spicy".
const SLUR_STEMS = [
	'nigger',
	'nigga',
	'faggot',
	'kike',
	'wetback',
	'tranny',
	'trannie',
	'chink',
	'gook',
	'beaner',
	'spic',
];

// Optional tails a slur is commonly written with. Anything longer is a different
// word (e.g. "kikel", "spice") and must not match.
const TAIL = '(?:s|es|z|ies)?';

// Leetspeak / homoglyph folding, applied per token.
const LEET = new Map(
	Object.entries({
		'0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a',
		'@': 'a', '5': 's', $: 's', '7': 't', '+': 't', '8': 'b', '9': 'g',
	}),
);

// An address, tx hash, or long id. Folding digits inside one of these produces
// arbitrary letters, so it is never eligible for the letters-only evasion pass.
const LONG_ALNUM_RUN = /(?:0x)?[0-9a-f]{10,}/i;

function foldLeet(text) {
	return String(text || '')
		.toLowerCase()
		.split('')
		.map((ch) => LEET.get(ch) ?? ch)
		.join('');
}

// "niiiiigger" → "niigger". Two is enough to leave "aa"/"ll" words intact.
function collapseRuns(text) {
	return text.replace(/([a-z])\1{2,}/g, '$1$1');
}

/**
 * Canonical form used for matching: lowercase, leet folded, long runs collapsed.
 * Exported for tests and for the audit script's logging.
 * @param {string} text
 * @returns {string}
 */
export function normalizeForSlurMatch(text) {
	return collapseRuns(foldLeet(text));
}

const STEM_RE = new RegExp(`^(?:${SLUR_STEMS.join('|')})${TAIL}$`);

/**
 * Which slur stem the text contains, or null. Whole-word only.
 *
 * Two passes:
 *   1. Token pass — split on non-letters, fold each token, require a whole-word hit.
 *      Catches "Real Hood Nigger Shit" and "N1GG3R", and cannot reach inside
 *      "kikel-jina69" or a hex address.
 *   2. Squeezed pass — join the letters and look for a whole stem, to catch the
 *      deliberately spaced "n.i.g.g.e.r" / "n i g g e r". Skipped entirely when the
 *      text carries a long alphanumeric run (an address), because squeezing one of
 *      those manufactures matches out of nothing.
 *
 * @param {string} text — a display name, a description, or both concatenated.
 * @returns {string|null} the matched stem, for logging. Never surfaced to users.
 */
export function matchedSlurStem(text) {
	const raw = String(text || '');
	if (!raw.trim()) return null;

	// Pass 1 — whole-word over folded tokens.
	for (const token of foldLeet(raw).split(/[^a-z]+/)) {
		if (!token) continue;
		const t = collapseRuns(token);
		const hit = SLUR_STEMS.find((stem) => STEM_RE.test(t) && t.startsWith(stem));
		if (hit) return hit;
	}

	// Pass 2 — the spaced-out evasion ("n.i.g.g.e.r", "n i g g e r").
	//
	// Squeezing text destroys word boundaries, so this pass can only ever be a
	// substring match — which on ordinary text flags "Spicy Trades" for "spic".
	// Run it only when the text bears the evasion's signature: a run of isolated
	// single letters. Real names do not spell themselves out one character at a time.
	if (LONG_ALNUM_RUN.test(raw)) return null;
	const tokens = foldLeet(raw).split(/[^a-z]+/).filter(Boolean);
	const singles = tokens.filter((t) => t.length === 1).length;
	if (singles < 4) return null;

	const squeezed = collapseRuns(tokens.join(''));
	if (squeezed.length > 40) return null; // a long description squeezed is a match generator
	return SLUR_STEMS.find((stem) => squeezed.includes(stem)) ?? null;
}

/**
 * True when the text contains an unambiguous hate slur.
 * @param {string} text
 * @returns {boolean}
 */
export function containsHateSlur(text) {
	return matchedSlurStem(text) !== null;
}
