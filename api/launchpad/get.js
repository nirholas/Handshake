// GET /api/launchpad/get?slug=<slug>
//
// Returns the published Launchpad Studio config for /p/<slug> hydration.
// Public read — no auth required. Cached briefly at the edge to soak hot
// pages without going to Postgres on every visit.

import { sql } from '../_lib/db.js';
import { cors, error, json, method, wrap } from '../_lib/http.js';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export default wrap(async (req, res) => {
	// Same open policy as /api/launchpad/list: this is a public read of a page
	// that is already served to anyone at /p/<slug>, with no cookies involved, so
	// an embed hosted on the creator's own domain can hydrate it too.
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const slug = (url.searchParams.get('slug') || '').toLowerCase();
	if (!SLUG_RE.test(slug)) {
		return error(res, 400, 'validation_error', 'invalid slug');
	}

	const [row] = await sql`
		SELECT slug, template, owner_wallet, config, view_count, created_at, updated_at
		FROM launchpad_pages
		WHERE slug = ${slug} AND is_public = true
	`;
	if (!row) return error(res, 404, 'not_found', 'no launchpad at that slug');

	// Fire-and-forget view increment. Failure here must never block the read.
	sql`UPDATE launchpad_pages SET view_count = view_count + 1 WHERE slug = ${slug}`.catch(() => {});

	// gated-showroom is a pay-to-reveal page: withhold the private scene URL from
	// the public read so the only way to obtain it is settling the x402 unlock at
	// /api/launchpad/invoke. A `locked` flag lets the renderer show the lock
	// state without leaking the asset.
	const config = row.config || {};
	if (row.template === 'gated-showroom' && config.scene?.src) {
		config.scene = { ...config.scene, src: '', locked: true };
	}

	return json(
		res,
		200,
		{
			slug: row.slug,
			template: row.template,
			ownerWallet: row.owner_wallet,
			config,
			viewCount: row.view_count + 1,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		},
		{ 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' },
	);
});
