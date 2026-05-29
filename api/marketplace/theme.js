// GET /api/marketplace/theme — returns the currently active marketplace theme,
// or null if none. Themes are curated manually via the marketplace_themes table.

import { sql } from '../_lib/db.js';
import { cors, json, method, wrap } from '../_lib/http.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	let rows;
	try {
		rows = await sql`
			SELECT id, title, blurb, tag, starts_at, ends_at
			FROM marketplace_themes
			WHERE starts_at <= now() AND ends_at >= now()
			ORDER BY created_at DESC
			LIMIT 1
		`;
	} catch {
		rows = [];
	}

	const theme = rows[0]
		? {
				id: rows[0].id,
				title: rows[0].title,
				blurb: rows[0].blurb || '',
				tag: rows[0].tag || null,
				startsAt: rows[0].starts_at,
				endsAt: rows[0].ends_at,
			}
		: null;

	res.setHeader('cache-control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=900');
	return json(res, 200, { data: { theme } });
});
