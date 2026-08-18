/**
 * Pure data helpers for the Walk-Browse marketplace gallery.
 *
 * Kept dependency-free (no three.js, no DOM) so listing normalisation, price /
 * count / rating formatting, source interleaving, and the ?type deep-link alias
 * map are unit-testable in plain Node and reused verbatim by
 * src/marketplace-gallery.js. The gallery itself owns everything that touches
 * WebGL or the document.
 */

export const PAGE_SIZE = 18;

// TYPE_ACCENT / TYPE_LABEL live in marketplace-gallery.js: they are presentation
// (the monochrome brightness tiers of the platform design system), not data.

export const FILTERS = [
	{ key: 'all', label: 'All' },
	{ key: 'agent', label: 'Agents' },
	{ key: 'avatar', label: 'Avatars' },
	{ key: 'skill', label: 'Skills' },
];

// A shared link can carry either the singular or plural form (?type=skill or
// ?type=skills both land on Skills); 'agents'/'avatars' likewise. Anything else
// → null, so the caller falls back to the default 'all'.
const FILTER_ALIASES = {
	all: 'all',
	agent: 'agent',
	agents: 'agent',
	avatar: 'avatar',
	avatars: 'avatar',
	skill: 'skill',
	skills: 'skill',
};

export function normalizeFilterKey(raw) {
	if (!raw) return null;
	return FILTER_ALIASES[String(raw).trim().toLowerCase()] || null;
}

// asset_prices arrive as a base-unit integer + mint decimals. Anything missing,
// zero, or unparseable reads as "Free" rather than "$0" or "$NaN".
export function fmtTokenPrice(price) {
	if (!price || price.amount == null) return 'Free';
	const dec = Number(price.mint_decimals ?? 6);
	const v = Number(price.amount) / Math.pow(10, dec);
	if (!Number.isFinite(v) || v <= 0) return 'Free';
	return `$${v >= 1 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v.toFixed(2)}`;
}

export function isPaidToken(price) {
	return !!(price && price.amount != null && Number(price.amount) > 0);
}

// Compact human counts for tight UI: 340 → "340", 1240 → "1.2k", 2.3M → "2.3M".
// Returns null for nothing-to-show (0/negative/NaN) so callers can omit the chip.
export function fmtCount(n) {
	const v = Number(n);
	if (!Number.isFinite(v) || v <= 0) return null;
	if (v < 1000) return String(Math.round(v));
	if (v < 1_000_000) {
		const k = v / 1000;
		return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
	}
	const m = v / 1_000_000;
	return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')}M`;
}

// A rating only counts as social proof once at least one person has rated it.
export function makeRating(avg, count) {
	const a = Number(avg);
	const c = Number(count) || 0;
	if (!Number.isFinite(a) || a <= 0 || c <= 0) return null;
	return { avg: Math.round(a * 10) / 10, count: c };
}

function makeUses(label, count) {
	const c = Number(count);
	if (!Number.isFinite(c) || c <= 0) return null;
	return { label, count: c };
}

function cleanTags(tags) {
	if (!Array.isArray(tags)) return [];
	return tags
		.map((t) => String(t || '').trim())
		.filter(Boolean)
		.slice(0, 4);
}

export function normalizeAgent(a) {
	return {
		type: 'agent',
		id: a.id,
		name: a.name || 'Untitled agent',
		description: a.description || '',
		image: a.thumbnail_url || null,
		price: fmtTokenPrice(a.price),
		paid: isPaidToken(a.price),
		category: a.category || '',
		author: null,
		rating: makeRating(a.rating_avg, a.rating_count),
		uses: makeUses('owners', a.buyers_total),
		tags: cleanTags(a.tags),
		featured: false,
		href: `/agents/${encodeURIComponent(a.id)}`,
	};
}

export function normalizeAvatar(a) {
	return {
		type: 'avatar',
		id: a.avatarId,
		name: a.name || 'Untitled avatar',
		description: a.description || '',
		image: a.image || null,
		price: fmtTokenPrice(a.price),
		paid: isPaidToken(a.price),
		category: a.modelCategory || 'avatar',
		author: a.author?.displayName || a.author?.handle || null,
		rating: null,
		uses: makeUses('views', a.viewCount),
		tags: cleanTags(a.tags),
		featured: !!a.featured,
		href: `/marketplace/avatars/${encodeURIComponent(a.avatarId)}`,
	};
}

export function normalizeSkill(s) {
	const usd = Number(s.price_per_call_usd);
	const paid = Number.isFinite(usd) && usd > 0;
	return {
		type: 'skill',
		id: s.slug || s.id,
		name: s.name || 'Untitled skill',
		description: s.description || '',
		image: null,
		price: paid ? `$${usd}/call` : 'Free',
		paid,
		category: s.category || '',
		author: s.author?.display_name || null,
		rating: makeRating(s.avg_rating, s.rating_count),
		uses: makeUses('installs', s.install_count),
		tags: cleanTags(s.tags),
		featured: false,
		href: `/marketplace/skills/${encodeURIComponent(s.slug || s.id)}`,
	};
}

// Round-robin merge so an "All" hall reads as a varied mix of agents/avatars/
// skills rather than three solid blocks. Empty lanes are skipped.
export function interleave(lanes) {
	const arrs = (lanes || []).filter((l) => Array.isArray(l) && l.length);
	const merged = [];
	for (let i = 0; arrs.some((l) => i < l.length); i++) {
		for (const lane of arrs) if (i < lane.length) merged.push(lane[i]);
	}
	return merged;
}
