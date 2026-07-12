// GET /api/users/:username/creations — a user's forged 3D models + saved
// worlds (dioramas), merged into one recency-ordered, cursor-paginated feed.
//
// The main /api/users/:username response (api/users/[username].js) already
// carries a user's avatars, agents, widgets, skills, plugins, coins, and
// memories — everything that lives on a row keyed by owner_id/user_id in
// its own first-class table. Forged 3D models (forge_creations) and worlds
// (dioramas) are different: both tables are deliberately anonymous-by-design
// (scoped to a hashed browser client_key so /forge and /diorama work with no
// account), and only carry a user_id when the creator happened to be signed
// in at generation/save time. This endpoint is the one place those two
// creation types get aggregated and paginated for the profile's "Creations"
// tab — split out of the main endpoint (like collectibles.js) so a prolific
// creator with hundreds of rows never slows down the profile's first paint.
//
//   GET /api/users/:username/creations                → first page (24)
//   GET /api/users/:username/creations?before=<iso>    → next page (cursor)
//   GET /api/users/:username/creations?type=model|world → one type only
//
// Public, no auth: the profile it backs is public. Anonymous creations
// (user_id null — the majority of forge_creations/dioramas rows) never
// appear here for anyone, by construction of the underlying queries.

import { sql } from '../../_lib/db.js';
import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { listCreationsByUser } from '../../_lib/forge-store.js';
import { listDioramasByUser } from '../../_lib/diorama-store.js';

const SITE = 'https://three.ws';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const usernameRaw =
		req.query?.username ||
		new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).slice(-2)[0] ||
		'';
	const username = String(usernameRaw).toLowerCase().replace(/^@/, '').trim();
	if (!username || !/^[a-z0-9_-]{3,30}$/.test(username)) {
		return error(res, 400, 'validation_error', 'invalid username');
	}

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const [user] = await sql`
		select id from users where lower(username) = ${username} and deleted_at is null limit 1
	`;
	if (!user) return error(res, 404, 'not_found', 'user not found');

	const url = new URL(req.url, 'http://x');
	const typeFilter = url.searchParams.get('type'); // 'model' | 'world' | null (both)
	const before = url.searchParams.get('before') || undefined;
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 24, 1), 48);
	// Over-fetch each source so merging two independently-paginated lists still
	// yields a full page of the true recency-merged feed, not an undercount.
	const fetchLimit = limit + 1;

	const [models, worlds] =
		typeFilter === 'world'
			? [[], await listDioramasByUser({ userId: user.id, limit: fetchLimit, before })]
			: typeFilter === 'model'
				? [await listCreationsByUser({ userId: user.id, limit: fetchLimit, before }), []]
				: await Promise.all([
						listCreationsByUser({ userId: user.id, limit: fetchLimit, before }),
						listDioramasByUser({ userId: user.id, limit: fetchLimit, before }),
					]);

	const items = [...models, ...worlds]
		.map((it) =>
			it.type === 'world'
				? {
						id: it.id,
						type: 'world',
						title: it.title,
						prompt: it.prompt,
						thumbnailUrl: it.thumbnailGlb,
						category: it.mood,
						viewerUrl: `${SITE}/diorama?id=${it.id}`,
						createdAt: it.createdAt,
					}
				: {
						id: it.id,
						type: 'model',
						title: it.prompt,
						prompt: it.prompt,
						thumbnailUrl: it.glbUrl,
						category: it.category,
						isRemix: it.isRemix,
						viewerUrl: `${SITE}/viewer?src=${encodeURIComponent(it.glbUrl)}`,
						createdAt: it.createdAt,
					},
		)
		.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
		.slice(0, limit);

	const next = items.length === limit ? items[items.length - 1].createdAt : null;

	res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
	return json(res, 200, { items, next });
});
