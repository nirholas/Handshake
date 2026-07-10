/**
 * GET /api/users/me/bookmarks
 * Returns the authenticated caller's bookmarked agent IDs and lightweight metadata.
 * Used by the marketplace client to render filled-in star buttons on grid cards.
 */

import { sql } from '../../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../../_lib/auth.js';
import { cors, error, json, method, wrap, rateLimited } from '../../_lib/http.js';
import { clientIp, limits } from '../../_lib/rate-limit.js';
import { thumbnailUrl } from '../../_lib/r2.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id || bearer?.userId;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const rows = await sql`
		SELECT
			ab.agent_id,
			ab.created_at,
			ai.name        AS agent_name,
			ai.description AS agent_description,
			ai.category    AS agent_category,
			av.thumbnail_key
		FROM agent_bookmarks ab
		JOIN agent_identities ai ON ai.id = ab.agent_id AND ai.deleted_at IS NULL
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE ab.user_id = ${userId}
		ORDER BY ab.created_at DESC
	`;

	const bookmarks = rows.map((r) => ({
		agent_id: r.agent_id,
		bookmarked_at: r.created_at,
		agent_name: r.agent_name,
		agent_description: r.agent_description,
		agent_category: r.agent_category,
		agent_thumbnail: thumbnailUrl(r.thumbnail_key),
	}));

	return json(
		res,
		200,
		{ data: { bookmarks, agent_ids: bookmarks.map((b) => b.agent_id) } },
		{ 'cache-control': 'no-store' },
	);
});
