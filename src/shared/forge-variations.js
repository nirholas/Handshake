// Forge: "More like this" variation grammar (pure, shared, testable).
//
// Given the prompt that produced a result, derive a few one-tap variations that
// keep the SAME subject but restyle its material or finish. This preserves the
// single-subject shape the free draft lane (TRELLIS) models best, while letting
// a creator explore the design space of their idea without retyping anything.
//
// Deliberately dependency-free and deterministic when a seeded rng is supplied,
// so the behaviour is unit-testable and the client stays trivial.

// Each facet: a stable key, a short chip label, the natural-language phrase
// appended to the base prompt, a swatch colour for the chip dot, and `match`
// keywords that suppress the facet when the prompt already names that material.
export const VARIATION_FACETS = [
	{ key: 'brass', label: 'Brass', phrase: 'in brushed brass', swatch: '#b08d57', match: ['brass'] },
	{ key: 'chrome', label: 'Chrome', phrase: 'in polished chrome', swatch: '#c8ccd0', match: ['chrome', 'stainless'] },
	{ key: 'glass', label: 'Glass', phrase: 'as translucent glass', swatch: '#9fd3e0', match: ['glass'] },
	{ key: 'oak', label: 'Oak', phrase: 'carved from oak', swatch: '#8a5a2b', match: ['oak', 'wooden', 'wood'] },
	{ key: 'walnut', label: 'Walnut', phrase: 'carved from dark walnut', swatch: '#5b3a29', match: ['walnut'] },
	{ key: 'ceramic', label: 'Ceramic', phrase: 'in glazed ceramic', swatch: '#e8e2d5', match: ['ceramic', 'porcelain'] },
	{ key: 'bronze', label: 'Bronze', phrase: 'in weathered bronze', swatch: '#7d5a3c', match: ['bronze'] },
	{ key: 'copper', label: 'Copper', phrase: 'in hammered copper', swatch: '#b87333', match: ['copper'] },
	{ key: 'marble', label: 'Marble', phrase: 'carved from white marble', swatch: '#e6e6e6', match: ['marble'] },
	{ key: 'obsidian', label: 'Obsidian', phrase: 'in polished black obsidian', swatch: '#2b2b30', match: ['obsidian'] },
	{ key: 'clay', label: 'Clay', phrase: 'in matte terracotta clay', swatch: '#b5651d', match: ['clay', 'terracotta'] },
	{ key: 'crystal', label: 'Crystal', phrase: 'as a faceted crystal', swatch: '#bfe6ff', match: ['crystal'] },
	{ key: 'gold', label: 'Gold', phrase: 'in gleaming gold', swatch: '#ffd479', match: ['gold', 'golden'] },
	{ key: 'jade', label: 'Jade', phrase: 'carved from green jade', swatch: '#5cab7d', match: ['jade'] },
	{ key: 'iron', label: 'Iron', phrase: 'in blackened cast iron', swatch: '#3a3a3f', match: ['iron'] },
	{ key: 'neon', label: 'Neon', phrase: 'in glowing cyberpunk neon', swatch: '#ff3df0', match: ['neon'] },
	{ key: 'lowpoly', label: 'Low-poly', phrase: 'as a low-poly sculpt', swatch: '#9aa0ff', match: ['low-poly', 'lowpoly', 'low poly'] },
	{ key: 'holo', label: 'Holographic', phrase: 'in iridescent holographic acrylic', swatch: '#c0a0ff', match: ['holographic', 'iridescent'] },
	{ key: 'rattan', label: 'Rattan', phrase: 'woven from rattan', swatch: '#c9a56a', match: ['rattan', 'wicker'] },
	{ key: 'granite', label: 'Granite', phrase: 'carved from speckled granite', swatch: '#8f9095', match: ['granite', 'stone'] },
];

// Strip a trailing separator so the appended phrase reads cleanly.
function cleanBase(prompt) {
	return String(prompt || '').trim().replace(/[.,;\s]+$/u, '');
}

// Compose one variation prompt: same subject, restyled by the facet.
export function composeVariation(prompt, facet) {
	const base = cleanBase(prompt);
	if (!base) return '';
	return `${base}, ${facet.phrase}`;
}

// Fisher-Yates using an injectable rng (defaults to Math.random) so callers can
// seed it for deterministic tests.
function shuffled(list, rng) {
	const a = list.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

// The forge prompt box caps at 1000 characters; a variation that appends a
// material phrase must still fit, or the generation would be rejected.
export const MAX_PROMPT_CHARS = 1000;

// Derive up to `count` distinct variations for a prompt. Facets whose material
// the prompt already names are excluded so the suggestions always feel fresh,
// and any whose composed prompt would exceed the forge limit are dropped.
// Returns [{ key, label, swatch, prompt }]. Empty prompt yields [].
export function deriveVariations(prompt, { count = 3, rng = Math.random } = {}) {
	const base = cleanBase(prompt);
	if (!base) return [];
	const lower = base.toLowerCase();
	const fits = (f) => composeVariation(base, f).length <= MAX_PROMPT_CHARS;
	const eligible = VARIATION_FACETS.filter((f) => fits(f) && !f.match.some((m) => lower.includes(m)));
	// Fall back to any material that still fits when the prompt already names them
	// all; if even that is empty (a near-limit prompt), there are no variations.
	const pool = eligible.length ? eligible : VARIATION_FACETS.filter(fits);
	return shuffled(pool, rng)
		.slice(0, Math.max(0, count))
		.map((f) => ({ key: f.key, label: f.label, swatch: f.swatch, prompt: composeVariation(base, f) }));
}
