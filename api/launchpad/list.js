// GET /api/launchpad/list?limit=24&offset=0[&template=token-launchpad]
//
// Public showcase feed of published Launchpad Studio pages — powers the
// "Built on three.ws" gallery on /launchpad so the surface opens with real
// proof instead of an empty editor. Read-only, no auth: every row is already
// public (is_public = true) and served at /p/<slug>.
//
// Returns only the presentation-safe projection of each page's config (no
// owner secret, no gated scene URL) plus the live view_count, so the gallery
// can sort by "most viewed" without a second round trip. Cached briefly at the
// edge — the showcase shifts slowly and many tabs hit it on page load.

import { sql } from '../_lib/db.js';
import { cors, error, json, method, wrap } from '../_lib/http.js';

const TEMPLATES = ['token-launchpad', 'paid-concierge', 'gated-showroom'];

// Deepest page a caller may ask for. Postgres takes LIMIT/OFFSET as bigints, so
// a fractional value ("limit=1.5") or one past 2^63 ("offset=1e99") makes the
// driver reject the whole query and 500 the endpoint. Clamping to a whole
// number inside a sane window keeps junk query strings a 200 with an empty page
// instead of an error, which is what a crawler walking `?offset=` deserves.
const MAX_OFFSET = 100_000;

// Coerce a query-string integer. Missing, empty, non-numeric, and 0 all take the
// default (matching the previous `Number(x) || default`); anything else is
// floored and clamped into [min, max].
function pageInt(raw, fallback, { min, max }) {
	const n = Number(raw);
	if (!Number.isFinite(n) || n === 0) return fallback;
	return Math.min(Math.max(min, Math.floor(n)), max);
}

// Map a stored page row to the public card projection the gallery renders.
// Pulls a single representative image (token logo when present) and the brand
// color so a card is never a blank rectangle even before the 3D avatar loads.
function toCard(row) {
	const c = row.config || {};
	const identity = c.identity || {};
	const copy = c.copy || {};
	const token = c.token || {};
	const monetize = c.monetize || {};
	return {
		slug: row.slug,
		template: row.template,
		url: `/p/${row.slug}`,
		headline: copy.headline || token.name || row.slug,
		tagline: copy.tagline || '',
		brand: typeof identity.brand === 'string' ? identity.brand : '#ffffff',
		theme: identity.theme === 'dark' ? 'dark' : 'light',
		avatarSrc: c.avatar?.src || '',
		image: token.imageUrl || '',
		token: token.name || token.ticker
			? { name: token.name || '', ticker: token.ticker || '', mint: token.mint || '' }
			: null,
		price: Number(monetize.price) > 0
			? { amount: Number(monetize.price), currency: monetize.currency || '', chain: monetize.chain || '' }
			: null,
		viewCount: row.view_count || 0,
		updatedAt: row.updated_at,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const limit = pageInt(url.searchParams.get('limit'), 24, { min: 1, max: 60 });
	const offset = pageInt(url.searchParams.get('offset'), 0, { min: 0, max: MAX_OFFSET });
	const template = url.searchParams.get('template') || '';
	if (template && !TEMPLATES.includes(template)) {
		return error(res, 400, 'validation_error', 'unknown template filter');
	}

	// Over-fetch one row to derive has_more without a count(*). Newest-updated
	// first so freshly published pages lead the showcase. Token launchpads that
	// have actually minted (token_mint set) and busy pages bubble up via the
	// secondary view_count sort.
	const rows = template
		? await sql`
				SELECT slug, template, config, view_count, updated_at
				FROM launchpad_pages
				WHERE is_public = true AND template = ${template}
				ORDER BY (token_mint IS NOT NULL) DESC, updated_at DESC
				LIMIT ${limit + 1} OFFSET ${offset}
			`
		: await sql`
				SELECT slug, template, config, view_count, updated_at
				FROM launchpad_pages
				WHERE is_public = true
				ORDER BY (token_mint IS NOT NULL) DESC, updated_at DESC
				LIMIT ${limit + 1} OFFSET ${offset}
			`;

	const hasMore = rows.length > limit;
	const pages = rows.slice(0, limit).map(toCard);

	// Cheap aggregate so the hero can show a real "N pages live" stat. Counts the
	// same set the caller is paging through — an unfiltered count next to a
	// template-filtered list reads as "24 gated showrooms" when only one exists.
	// Harmless if it races slightly with the list above.
	let total = null;
	if (offset === 0) {
		const [agg] = template
			? await sql`
					SELECT count(*)::int AS n FROM launchpad_pages
					WHERE is_public = true AND template = ${template}
				`
			: await sql`SELECT count(*)::int AS n FROM launchpad_pages WHERE is_public = true`;
		total = agg?.n ?? null;
	}

	return json(
		res,
		200,
		{ pages, has_more: hasMore, offset, limit, template: template || null, total },
		{ 'cache-control': 'public, s-maxage=30, stale-while-revalidate=300' },
	);
});
